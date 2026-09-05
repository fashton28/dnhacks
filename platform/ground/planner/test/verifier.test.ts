import { describe, expect, it } from 'vitest';
import { Anomaly, BatteryState, FleetVehicle, MissionPlan } from '../src/contract';
import { ScriptedPlanner } from '../src/scripted';
import { SiteModel, pointInPolygon, validateSite } from '../src/site';
import { CHECK_ORDER, VerificationContext, verifyMission } from '../src/verifier';

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
    sensors: { rgb: 'ok', thermal: 'ok', lidar: 'ok' }, isNight: false,
    ...overrides,
  };
}

const basic = (tools: MissionPlan['tools']): MissionPlan => ({
  requestId: 'req-1', anomalyId: anomaly.id, profile: 'standard', rationale: 'test', tools,
});

describe('ordered fail-closed verifier', () => {
  it('runs every documented check in stable order', () => {
    const model = site();
    const plan = new ScriptedPlanner().passingPlan(model, anomaly);
    const result = verifyMission(plan, model, ready());
    expect(result.checks.map(({ name }) => name)).toEqual(CHECK_ORDER);
    expect(result.verdict).toBe('pass');
  });

  it('rejects an otherwise safe plan when runtime readiness is absent', () => {
    const model = site();
    const plan = new ScriptedPlanner().passingPlan(model, anomaly);
    const result = verifyMission(plan, model);
    expect(result.verdict).toBe('rejected');
    expect(result.checks.find(({ name }) => name === 'nav_source')?.ok).toBe(false);
    expect(result.checks.find(({ name }) => name === 'readiness')?.reason).toContain('required');
    expect(result.checks.find(({ name }) => name === 'rf_environment')?.ok).toBe(false);
    expect(result.checks.find(({ name }) => name === 'range')?.ok).toBe(false);
  });

  it.each([
    { tool:'follow', track_id:1, profile:'follow' } as const,
    { tool:'orbit', track_id:1, profile:'inspect' } as const,
    { tool:'goto_relative', dx:1, dy:2, dz:3 } as const,
  ])('fails closed at schema for unsupported $tool mission sequences', (tool) => {
    const result = verifyMission(basic([tool, { tool:'rtl' }]), site(), ready());
    expect(result.verdict).toBe('rejected');
    expect(result.correctedPlan).toBeUndefined();
    expect(result.checks[0]).toMatchObject({ name:'schema', ok:false });
    expect(result.checks[0].reason).toMatch(/not admitted.*sequence-executor support/);
  });

  it('requires explicit fault and sensor-health status', () => {
    const model = site();
    const plan = new ScriptedPlanner().passingPlan(model, anomaly);
    const incomplete = ready({ sensors: undefined, battery: { soc_pct: 90, charge_state: 'charged' } });
    const result = verifyMission(plan, model, incomplete);
    expect(result.checks.find(({ name }) => name === 'readiness')?.reason).toMatch(/fault status|sensor health/);
  });

  it('corrects finite altitude and NFZ target errors then fully rechecks', () => {
    const model = site();
    const plan = basic([
      { tool: 'goto_gps', lat: 0.004, lon: 0, alt: 100 }, { tool: 'rtl' },
    ]);
    const context = ready({ anomaly: { ...anomaly, lat: 0.004 } });
    const result = verifyMission(plan, model, context);
    expect(result.verdict).toBe('corrected');
    expect(result.checks.find(({ name }) => name === 'altitude')?.edit).toContain('clamped');
    const target = result.correctedPlan?.tools.find((tool) => tool.tool === 'goto_gps') as {lat:number;lon:number};
    expect(pointInPolygon(target, model.nfz[0].polygon)).toBe(false);
    expect(verifyMission(result.correctedPlan!, model, context).verdict).toBe('pass');
  });

  it('allows a route wholly above the NFZ ceiling', () => {
    const model = site();
    const plan = basic([{ tool: 'goto_gps', lat: 0.007, lon: 0, alt: 45 }, { tool: 'rtl' }]);
    const result = verifyMission(plan, model, ready({
      currentAltitudeM: 45, anomaly: { ...anomaly, lat: 0.007 },
    }));
    expect(result.checks.find(({ name }) => name === 'nfz_transit')?.ok).toBe(true);
  });

  it('does not use a high destination to hide a below-ceiling crossing', () => {
    const model = site();
    const plan = basic([{ tool: 'goto_gps', lat: 0.007, lon: 0, alt: 45 }, { tool: 'rtl' }]);
    const result = verifyMission(plan, model, ready({
      currentAltitudeM: 20, anomaly: { ...anomaly, lat: 0.007 },
    }));
    expect(result.checks.find(({ name }) => name === 'nfz_transit')?.ok).toBe(false);
  });

  it('preserves the 25 percent reserve using live SoC', () => {
    const model = site();
    const plan = basic([{ tool: 'goto_gps', lat: -0.008, lon: 0, alt: 40 }, { tool: 'rtl' }]);
    const result = verifyMission(plan, model, ready({ battery: battery(25) }));
    expect(result.checks.find(({ name }) => name === 'range')?.ok).toBe(false);
  });

  it('contains the full orbit circumference inside the geofence', () => {
    const model = { ...site(), geofence:[
      {lat:-.003,lon:-.009},{lat:-.003,lon:.009},{lat:.009,lon:.009},{lat:.009,lon:-.009},
    ] };
    const edge = { ...anomaly, lat: -0.0029 };
    const plan = basic([{tool:'goto_gps',lat:edge.lat,lon:0,alt:40},
      {tool:'orbit_point',lat:edge.lat,lon:0,radius:25,laps:1},{tool:'rtl'}]);
    const result = verifyMission(plan, model, ready({ anomaly: edge }));
    expect(result.checks.find(({name}) => name === 'geofence')?.ok).toBe(false);
    expect(result.verdict).toBe('corrected');
  });

  it('climbs outside clutter before a LiDAR-degraded transit', () => {
    const model = { ...site(), clutter: [{name:'yard',polygon:[
      {lat:-.004,lon:-.001},{lat:-.004,lon:.001},{lat:-.003,lon:.001},{lat:-.003,lon:-.001},
    ]}] };
    const plan = basic([{tool:'goto_gps',lat:-.006,lon:0,alt:20},{tool:'rtl'}]);
    const result = verifyMission(plan, model, ready({ sensors:{rgb:'ok',thermal:'ok',lidar:'failed'} }));
    expect(result.checks.find(({name}) => name === 'readiness')?.ok).toBe(false);
    expect(result.verdict).toBe('corrected');
    expect(result.correctedPlan?.tools[0]).toMatchObject({tool:'goto_gps',lat:0,lon:0,alt:45});
  });

  it('includes vertical flight and landing allowance in sortie time', () => {
    const model = site();
    const close = { ...anomaly, lat:-.0005 };
    const plan = basic([{tool:'goto_gps',lat:close.lat,lon:0,alt:45},{tool:'rtl'}]);
    const result = verifyMission(plan, model, ready({ anomaly:close, currentAltitudeM:20, maxSortieS:60 }));
    expect(result.checks.find(({name}) => name === 'sortie')?.ok).toBe(false);
  });

  it('uses companion-reported tightened profile speed for flight budgets', () => {
    const model = site();
    const plan = new ScriptedPlanner().passingPlan(model, anomaly);
    const tightened = verifyMission(plan, model, ready({ profileCapabilities:[{
      profile:'standard', min_standoff_m:5, max_standoff_m:100,
      max_speed_mps:2, max_altitude_m:45,
    }] }));
    expect(tightened.checks.find(({name}) => name === 'sortie')?.ok).toBe(false);
  });
});

/* The stale-peer rule is the one part of DECONFLICTION_POLICY the fixtures
 * cannot pin, because it is a function of WHEN the fleet message arrived rather
 * than of any geometry in the plan. Same corridors, same peer, same 55 m gap:
 * only the age of the peer data changes, and 55 m is legal at 40 m and illegal
 * at the doubled 80 m. */
describe('peer-data age doubles the required separation', () => {
  const NOW = 1757116800000;
  const close: Anomaly = { ...anomaly, lat: -0.0005 };
  /** 55 m east of the mission corridor, level with it, airborne, no sortie cap. */
  const peer: FleetVehicle = {
    vehicleId: 'eis-2', battery: battery(88), controlSource: 'planner',
    failsafe: { state: 'none', reason: '' },
    readiness: { ready: true, reasons: [], eta_ready_s: 0 },
    position: { lat: -0.00025, lon: 0.000494, relAlt: 45 },
    sortie: null,
  };
  const withFleet = (fleetTs: number): VerificationContext => ready({
    anomaly: close, vehicleId: 'eis-1', fleet: [peer], fleetTs, now: NOW, dispatchAt: NOW,
  });
  const plan = basic([{ tool: 'goto_gps', lat: close.lat, lon: 0, alt: 45 }, { tool: 'rtl' }]);
  const deconfliction = (fleetTs: number) =>
    verifyMission(plan, site(), withFleet(fleetTs)).checks
      .find(({ name }) => name === 'deconfliction');

  it('clears a 55 m gap while the peer view is fresh', () => {
    const check = deconfliction(NOW);
    expect(check?.ok).toBe(true);
    expect(check?.reason).toContain('eis-2');
  });

  it('refuses the same 55 m gap once the peer view is stale', () => {
    const check = deconfliction(NOW - 5_000);
    expect(check?.ok).toBe(false);
    expect(check?.reason).toContain('80 m lateral');
  });
});
