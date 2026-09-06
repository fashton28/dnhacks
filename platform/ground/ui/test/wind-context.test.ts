/* ============================================================================
 * FM-72 — the live path never supplied `windMps`, so `checkWind` failed closed
 * on a non-finite wind, wind has no correction rule, and EVERY plan came back
 * rejected with Approve permanently disabled.
 *
 * Two halves, both pinned here:
 *   1. the UI can read a wind out of the vehicle's `wind` health event, and
 *   2. the context shape `App.tsx` actually builds verifies clean — including
 *      the assumed-wind fallback, which must fly attended and refuse
 *      unattended.
 * ========================================================================== */
import { describe, expect, it } from 'vitest';
import type { HealthEventMessage } from '@/contract';
import { ASSUMED_WIND_MPS, windContext, windFromHealth } from '@/lib/wind';
import { ScriptedPlanner } from '@planner/scripted';
import { validateSite } from '@planner/site';
import type { VerificationContext } from '@planner/verifier';
import { verifyMission } from '@planner/verifier';
import stubSite from '../../../site/site.stub.json';

const health = (detail: string): HealthEventMessage => ({
  type: 'healthEvent', ts: Date.now(), vehicleId: 'eis-1',
  component: 'wind', state: 'nominal', detail,
});

describe('windFromHealth', () => {
  it.each([
    ['wind 4.2 m/s from 210 deg', 4.2],
    ['Wind 11 M/S gusting', 11],
    ['0 m/s — calm', 0],
    ['estimate: 7.25m/s', 7.25],
  ])('reads %s', (detail, expected) => {
    expect(windFromHealth(health(detail))).toBe(expected);
  });

  it.each([
    ['nominal'],
    ['wind sensor unavailable'],
    ['gusting to 30 kt'],
  ])('returns undefined for %s rather than guessing', (detail) => {
    expect(windFromHealth(health(detail))).toBeUndefined();
  });

  it('returns undefined when no wind report has arrived at all', () => {
    expect(windFromHealth(undefined)).toBeUndefined();
  });

  it('rejects a negative wind rather than passing it to the verifier', () => {
    expect(windFromHealth(health('-3 m/s'))).toBeUndefined();
  });
});

describe('windContext', () => {
  it('tags a real report as measured', () => {
    expect(windContext(health('wind 4.2 m/s'))).toEqual({ windMps: 4.2, windSource: 'measured' });
  });

  it('falls back to the documented assumption and says so', () => {
    expect(windContext(undefined)).toEqual({ windMps: ASSUMED_WIND_MPS, windSource: 'assumed' });
  });
});

/* ------------------------------------------------------------------------- */
describe('the VerificationContext App.tsx builds', () => {
  const site = validateSite(stubSite);
  const anomaly = {
    id: 'sat-change-1', lat: site.staging[0].lat, lon: site.staging[0].lon,
    type: 'change', confidence: 0.94, thumbnail: '', source: 'sentinel2' as const,
  };
  const plan = new ScriptedPlanner().passingPlan(site, anomaly);

  /** Exactly the shape `startLiveInspection` assembles. */
  const appContext = (windMps: number, windSource: 'measured' | 'assumed'): VerificationContext => ({
    telemetry: {
      battery: {
        soc_pct: 92, voltage_v: 24.6, current_a: 12, cell_delta_v: 0.02, temp_c: 28,
        remaining_s: 1200, charge_state: 'charged', fault: '',
      },
      navSource: 'gps',
      position: { lat: site.home.lat, lon: site.home.lon, relAlt: 35 },
    },
    battery: {
      soc_pct: 92, voltage_v: 24.6, current_a: 12, cell_delta_v: 0.02, temp_c: 28,
      remaining_s: 1200, charge_state: 'charged', fault: '',
    },
    navSource: 'gps',
    currentPosition: { lat: site.home.lat, lon: site.home.lon },
    currentAltitudeM: 35,
    readiness: { ready: true, reasons: [] },
    windMps, windSource,
    anomaly,
    rfEvents: [],
    now: Date.now(),
    sdrState: 'nominal',
    sensors: { rgb: 'ok', thermal: 'ok', lidar: 'ok' },
    isNight: false,
    maxSortieS: 480,
    dispatchMinSocPct: 80,
  });

  it('no longer fails the wind check on the assumed default', () => {
    const result = verifyMission(plan, site, appContext(6, 'assumed'));
    const wind = result.checks.find((c) => c.name === 'wind');
    expect(wind?.ok).toBe(true);
    expect(wind?.reason).toContain('assumed');
  });

  it('produces an approvable verdict for the live path', () => {
    // The mode this closes: EVERY plan came back `rejected` on wind alone.
    expect(verifyMission(plan, site, appContext(6, 'assumed')).verdict).not.toBe('rejected');
    expect(verifyMission(plan, site, appContext(4.2, 'measured')).verdict).not.toBe('rejected');
  });

  it('still refuses when the wind that arrives is genuinely too high', () => {
    const result = verifyMission(plan, site, appContext(15, 'measured'));
    expect(result.checks.find((c) => c.name === 'wind')?.ok).toBe(false);
    expect(result.verdict).toBe('rejected');
  });

  it('refuses an UNATTENDED dispatch while the wind is only assumed', () => {
    const context = { ...appContext(4, 'assumed'), mode: 'unattended' as const };
    const attended = verifyMission(plan, site, context).checks.find((c) => c.name === 'attended');
    expect(attended?.ok).toBe(false);
    expect(attended?.reason).toContain('assumed, not measured');
  });

  it('still fails closed when the context supplies no wind at all', () => {
    const context = appContext(6, 'measured');
    delete context.windMps;
    delete context.windSource;
    expect(verifyMission(plan, site, context).checks.find((c) => c.name === 'wind')?.ok).toBe(false);
  });
});
