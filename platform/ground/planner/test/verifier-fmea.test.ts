/* ============================================================================
 * Regression suite for the verifier failure modes cleared in this wave.
 *
 * Every case here FAILS against the code as it stood before the fix, and each
 * one names the mode it pins down. `verifier.test.ts` keeps the general
 * behaviour; this file exists so a future edit that quietly re-opens one of
 * these modes has to delete a test that says why it must not.
 * ========================================================================== */
import { describe, expect, it } from 'vitest';
import { Anomaly, BatteryState, MissionPlan, RfEventMessage } from '../src/contract';
import { ScriptedPlanner } from '../src/scripted';
import { SiteModel, validateSite } from '../src/site';
import {
  ANOMALY_PROXIMITY_M, ORBIT_CENTRE_TOLERANCE_M, RF_EVENT_WINDOW_S, VerificationContext,
  currentRfEvents, verifyMission,
} from '../src/verifier';

const NOW = 1_757_116_800_000;

const anomaly: Anomaly = {
  id: 'anom-1', lat: -0.006, lon: 0, type: 'change', confidence: 0.9,
  thumbnail: 'synthetic.png', source: 'sentinel2',
};

function site(): SiteModel {
  return validateSite({
    home: { lat: 0, lon: 0, alt_m: 100 },
    perimeter: [[-0.01, -0.01], [-0.01, 0.01], [0.01, 0.01], [0.01, -0.01]],
    geofence: [[-0.009, -0.009], [-0.009, 0.009], [0.009, 0.009], [0.009, -0.009]],
    nfz_buffer_m: 10,
    nfz: [{ name: 'north block', polygon: [[0.003, -0.001], [0.003, 0.001], [0.006, 0.001], [0.006, -0.001]], ceiling_m: 40 }],
    alt_band_m: { min: 20, max: 60 }, clear_altitude_m: 45, clutter: [], staging: [],
  });
}

function battery(soc = 90): BatteryState {
  return {
    soc_pct: soc, voltage_v: 24, current_a: 1, cell_delta_v: 0.02, temp_c: 25,
    remaining_s: 1200, charge_state: 'charged', fault: '', voltage: 24, current: 1, remaining: soc,
  };
}

function ready(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    navSource: 'gps', readiness: { ready: true, reasons: [] }, battery: battery(),
    windMps: 0, anomaly, rfEvents: [], sdrState: 'nominal',
    sensors: { rgb: 'ok', thermal: 'ok', lidar: 'ok' }, isNight: false, now: NOW,
    ...overrides,
  };
}

const check = (plan: MissionPlan, model: SiteModel, context: VerificationContext, name: string) =>
  verifyMission(plan, model, context).checks.find((entry) => entry.name === name);

const hostile = (ts: number): RfEventMessage => ({
  type: 'rfEvent', ts, vehicleId: 'eis-1', source: 'rf_drone', kind: 'hostile_drone',
  band: '2.4GHz', confidence: 0.9, lat: -0.006, lon: 0,
});
const interference = (ts: number): RfEventMessage => ({
  type: 'rfEvent', ts, vehicleId: 'eis-1', source: 'sdr', kind: 'gnss_interference',
  band: 'GPS L1', confidence: 0.9,
});

/* ------------------------------------------------------------------------- */
describe('FM-50 an impaired SDR is not a clear RF environment', () => {
  const model = site();
  const plan = new ScriptedPlanner().passingPlan(model, anomaly);

  it.each(['saturated', 'degraded', 'warming'] as const)(
    'reports %s as unknown, never as "no blocking RF interference"', (sdrState) => {
      const result = check(plan, model, ready({ sdrState }), 'rf_environment');
      expect(result?.ok).toBe(true);
      expect(result?.reason).not.toContain('no blocking RF interference');
      expect(result?.reason).toContain(sdrState);
      expect(result?.reason).toContain('unknown');
    });

  it('still asserts a clear environment when the receiver is nominal', () => {
    expect(check(plan, model, ready(), 'rf_environment')?.reason).toBe('no blocking RF interference');
  });

  it('still reports a missing device as unknown without demanding an override', () => {
    const result = check(plan, model, ready({ sdrState: 'no_device' }), 'rf_environment');
    expect(result?.ok).toBe(true);
    expect(result?.reason).toContain('SDR unavailable');
  });

  it('an impaired receiver never masks an interference report that did arrive', () => {
    const result = check(plan, model,
      ready({ sdrState: 'saturated', rfEvents: [interference(NOW)] }), 'rf_environment');
    expect(result?.ok).toBe(false);
    expect(result?.reason).toContain('operator override required');
  });
});

/* ------------------------------------------------------------------------- */
describe('FM-51 RF events describe a moment, not the whole session', () => {
  const model = site();
  const plan = new ScriptedPlanner().passingPlan(model, anomaly);

  it('refuses airspace while a hostile-drone report is current', () => {
    expect(check(plan, model, ready({ rfEvents: [hostile(NOW - 5_000)] }), 'airspace')?.ok).toBe(false);
  });

  it('releases airspace once that report has aged past the window', () => {
    const stale = hostile(NOW - (RF_EVENT_WINDOW_S + 1) * 1000);
    expect(check(plan, model, ready({ rfEvents: [stale] }), 'airspace')?.ok).toBe(true);
  });

  it('releases rf_environment once an interference report has aged out', () => {
    const stale = interference(NOW - (RF_EVENT_WINDOW_S + 1) * 1000);
    expect(check(plan, model, ready({ rfEvents: [stale] }), 'rf_environment')?.ok).toBe(true);
  });

  it('a caller that cannot say what time it is gets every event as current', () => {
    // Not knowing the time must never LOOSEN airspace. This is what keeps the
    // reviewable V19/V21/V22 fixtures, which carry no `now`, meaningful.
    const context = ready({ rfEvents: [hostile(0)] });
    delete context.now;
    expect(check(plan, model, context, 'airspace')?.ok).toBe(false);
  });

  it('an event dated in the future is current, not filtered', () => {
    expect(currentRfEvents({ rfEvents: [hostile(NOW + 60_000)], now: NOW })).toHaveLength(1);
  });

  it('keeps the unattended envelope refusing on a CURRENT hostile drone only', () => {
    const base = { mode: 'unattended' as const, windMps: 2, windSource: 'measured' as const };
    const current = verifyMission(plan, model, ready({ ...base, rfEvents: [hostile(NOW)] }));
    expect(current.checks.find((c) => c.name === 'attended')?.reason).toContain('hostile drone');
    const aged = verifyMission(plan, model,
      ready({ ...base, rfEvents: [hostile(NOW - (RF_EVENT_WINDOW_S + 1) * 1000)] }));
    expect(aged.checks.find((c) => c.name === 'attended')?.reason).not.toContain('hostile drone');
  });
});

/* ------------------------------------------------------------------------- */
describe('FM-60 a rejected plan carries no correction annotations', () => {
  it('drops every `edit` when the repair attempt was abandoned', () => {
    const model = site();
    // Correctable (altitude above the band) AND uncorrectable (the mission
    // never returns) in one plan: the old code annotated the altitude check on
    // a plan that was never corrected.
    const plan: MissionPlan = {
      requestId: 'req-mixed', anomalyId: anomaly.id, profile: 'standard',
      rationale: 'altitude is clampable; a missing terminal rtl is not the only failure',
      tools: [
        { tool: 'goto_gps', lat: anomaly.lat, lon: anomaly.lon, alt: 500, profile: 'standard' },
        { tool: 'orbit_point', lat: anomaly.lat, lon: anomaly.lon, radius: 1 },
        { tool: 'rtl' },
      ],
    };
    const result = verifyMission(plan, model, ready({ battery: battery(26) }));
    expect(result.verdict).toBe('rejected');
    expect(result.checks.filter((entry) => entry.edit)).toEqual([]);
  });

  it('still annotates the checks a CORRECTED verdict actually repaired', () => {
    const model = site();
    const plan: MissionPlan = {
      requestId: 'req-clamp', anomalyId: anomaly.id, profile: 'standard',
      rationale: 'altitude above the band is clamped and the plan is released',
      tools: [
        { tool: 'goto_gps', lat: anomaly.lat, lon: anomaly.lon, alt: 500, profile: 'standard' },
        { tool: 'rtl' },
      ],
    };
    const result = verifyMission(plan, model, ready());
    expect(result.verdict).toBe('corrected');
    expect(result.checks.find((entry) => entry.name === 'altitude')?.edit).toContain('clamped');
  });
});

/* ------------------------------------------------------------------------- */
describe('FM-72 wind provenance', () => {
  const model = site();
  const plan = new ScriptedPlanner().passingPlan(model, anomaly);

  it('passes an attended mission on an assumed wind, and says so', () => {
    const result = check(plan, model, ready({ windMps: 6, windSource: 'assumed' }), 'wind');
    expect(result?.ok).toBe(true);
    expect(result?.reason).toContain('assumed');
  });

  it('refuses an UNATTENDED dispatch on an assumed wind inside the envelope', () => {
    const context = ready({ mode: 'unattended', windMps: 4, windSource: 'assumed' });
    const attended = check(plan, model, context, 'attended');
    expect(attended?.ok).toBe(false);
    expect(attended?.reason).toContain('assumed, not measured');
  });

  it('accepts the same wind unattended once it is measured', () => {
    const context = ready({ mode: 'unattended', windMps: 4, windSource: 'measured' });
    expect(check(plan, model, context, 'attended')?.reason).not.toContain('assumed');
  });

  it('still rejects a context with no wind at all', () => {
    const context = ready();
    delete context.windMps;
    expect(check(plan, model, context, 'wind')?.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
describe('FM-73 an observation point must observe the cue it answers', () => {
  const model = site();
  const displaced = (metres: number): MissionPlan => {
    const lat = anomaly.lat + metres / 111_320;
    return {
      requestId: `req-off-${metres}`, anomalyId: anomaly.id, profile: 'standard',
      rationale: 'orbit centre displaced from the cue',
      tools: [
        { tool: 'goto_gps', lat, lon: anomaly.lon, alt: 40, profile: 'standard' },
        { tool: 'orbit_point', lat, lon: anomaly.lon, radius: 25 },
        { tool: 'rtl' },
      ],
    };
  };

  it('rejects an orbit centre 150 m from the cue that used to pass every check', () => {
    const result = verifyMission(displaced(150), model, ready());
    const proximity = result.checks.find((entry) => entry.name === 'anomaly_proximity');
    expect(proximity?.ok).toBe(false);
    expect(proximity?.reason).toContain('orbit centre');
    // The operator reads the measured displacement, not just a verdict.
    expect(proximity?.reason).toMatch(/149\.\d m from the anomaly/);
    expect(result.verdict).toBe('rejected');
  });

  it('accepts the deterministic planner\'s own centre, which sits on the cue', () => {
    const plan = new ScriptedPlanner().passingPlan(model, anomaly);
    const proximity = check(plan, model, ready(), 'anomaly_proximity');
    expect(proximity?.ok).toBe(true);
    expect(proximity?.reason).toContain('observation centre');
  });

  it('accepts a displacement inside the tolerance a legal correction can apply', () => {
    expect(check(displaced(ORBIT_CENTRE_TOLERANCE_M - 5), model, ready(), 'anomaly_proximity')?.ok)
      .toBe(true);
  });

  it('keeps the outer bound for non-observation targets and reports the distance', () => {
    const plan: MissionPlan = {
      requestId: 'req-far', anomalyId: anomaly.id, profile: 'standard',
      rationale: 'no target anywhere near the cue',
      tools: [
        { tool: 'goto_gps', lat: 0.008, lon: 0.008, alt: 40, profile: 'standard' },
        { tool: 'rtl' },
      ],
    };
    const proximity = check(plan, model, ready(), 'anomaly_proximity');
    expect(proximity?.ok).toBe(false);
    expect(proximity?.reason).toContain(`within ${ANOMALY_PROXIMITY_M} m`);
    expect(proximity?.reason).toMatch(/nearest \d/);
  });
});
