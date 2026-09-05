import { describe, expect, it } from 'vitest';

import stubSite from '../../../site/site.stub.json';
import { Anomaly, MissionPlan } from '../src/contract';
import { ScriptedPlanner } from '../src/scripted';
import { SiteModel, haversineMeters, pointInPolygon, validateSite } from '../src/site';
import {
  DEFAULT_BATTERY_PCT,
  DRAIN_PCT_PER_S,
  RESERVE_PCT,
  verifyMission,
} from '../src/verifier';
import { PROFILE_SPEED_MPS } from '../src/contract';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Stub-derived site, MUTATED (shifted north-east) so nothing can pass by
 *  accident of hardcoded coordinates. */
function shiftedStubSite(): SiteModel {
  const raw = clone(stubSite) as {
    home: { lat: number; lon: number };
    perimeter: number[][];
    nfz: { polygon: number[][] }[];
    staging: { lat: number; lon: number }[];
  };
  const dLat = 0.01;
  const dLon = 0.005;
  raw.home.lat += dLat; raw.home.lon += dLon;
  raw.perimeter.forEach((p) => { p[0] += dLat; p[1] += dLon; });
  raw.nfz.forEach((z) => z.polygon.forEach((p) => { p[0] += dLat; p[1] += dLon; }));
  raw.staging.forEach((s) => { s.lat += dLat; s.lon += dLon; });
  return validateSite(raw);
}

/** Hand-built site around (0,0) where correction geometry is easy to reason
 *  about: 2.2 km square perimeter, NFZ block due north of home. */
function syntheticSite(): SiteModel {
  return validateSite({
    home: { lat: 0, lon: 0, alt_m: 100 },
    perimeter: [[-0.01, -0.01], [-0.01, 0.01], [0.01, 0.01], [0.01, -0.01]],
    nfz: [{
      name: 'block-north',
      polygon: [[0.004, -0.001], [0.004, 0.001], [0.006, 0.001], [0.006, -0.001]],
      ceiling_m: 120,
    }],
    alt_band_m: { min: 20, max: 60 },
    staging: [],
  });
}

function anomalyAt(lat: number, lon: number, id = 'anom-1'): Anomaly {
  return {
    id, lat, lon, type: 'change', confidence: 0.9, thumbnail: 'thumb.png', source: 'sentinel2',
  };
}

const planner = new ScriptedPlanner();

describe('verifyMission — scripted plans against the (mutated) stub site', () => {
  const site = shiftedStubSite();
  // stage-a shifted along with the site: inside the perimeter, clear of the NFZ.
  const anomaly = anomalyAt(site.staging[0].lat, site.staging[0].lon);

  it('passes the scripted passing plan', () => {
    const plan = planner.passingPlan(site, anomaly);
    const v = verifyMission(plan, site);
    expect(v.requestId).toBe(plan.requestId);
    expect(v.verdict).toBe('pass');
    expect(v.checks.map((c) => c.name)).toEqual(['geofence', 'nfz', 'altitude', 'battery']);
    expect(v.checks.every((c) => c.ok)).toBe(true);
    expect(v.correctedPlan).toBeUndefined();
  });

  it('fails the scripted failing plan on BOTH nfz and altitude', () => {
    const plan = planner.failingPlan(site, anomaly);
    const v = verifyMission(plan, site);
    expect(['rejected', 'corrected']).toContain(v.verdict);
    const byName = Object.fromEntries(v.checks.map((c) => [c.name, c]));
    expect(byName.nfz.ok).toBe(false);
    expect(byName.altitude.ok).toBe(false);
  });

  it('is deterministic: identical inputs produce byte-identical verifications', () => {
    for (const plan of [planner.passingPlan(site, anomaly), planner.failingPlan(site, anomaly)]) {
      const a = verifyMission(plan, site, { battery: { remaining: 80 } });
      const b = verifyMission(plan, site, { battery: { remaining: 80 } });
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
  });
});

describe('verifyMission — corrections', () => {
  const site = syntheticSite();
  const midAlt = (site.altBandM.min + site.altBandM.max) / 2; // 40

  it('clamps an out-of-band altitude into the band and re-verifies to pass', () => {
    const plan: MissionPlan = {
      requestId: 'req-alt',
      anomalyId: 'anom-1',
      profile: 'standard',
      rationale: 'test',
      tools: [
        // safe location due south of home, but 100 m AGL (band is 20..60)
        { tool: 'goto_gps', lat: -0.005, lon: 0, alt: 100 },
        { tool: 'rtl' },
      ],
    };
    const v = verifyMission(plan, site);
    expect(v.verdict).toBe('corrected');
    const alt = v.checks.find((c) => c.name === 'altitude')!;
    expect(alt.ok).toBe(false);
    expect(alt.edit).toMatch(/clamped/);
    expect(v.correctedPlan).toBeDefined();
    const corrected = v.correctedPlan!;
    expect((corrected.tools[0] as { alt: number }).alt).toBe(site.altBandM.max);
    // the corrected plan verifies clean
    expect(verifyMission(corrected, site).verdict).toBe('pass');
    // original plan object untouched
    expect((plan.tools[0] as { alt: number }).alt).toBe(100);
  });

  it('pushes a target out of an NFZ (with margin) and re-verifies to pass', () => {
    const plan: MissionPlan = {
      requestId: 'req-nfz',
      anomalyId: 'anom-1',
      profile: 'standard',
      rationale: 'test',
      tools: [
        // inside the NFZ, near its southern (home-facing) edge, below ceiling
        { tool: 'goto_gps', lat: 0.0045, lon: 0, alt: midAlt },
        { tool: 'rtl' },
      ],
    };
    const v = verifyMission(plan, site);
    expect(v.verdict).toBe('corrected');
    const nfz = v.checks.find((c) => c.name === 'nfz')!;
    expect(nfz.ok).toBe(false);
    expect(nfz.edit).toMatch(/moved tool 0 target out of NFZ/);
    const target = v.correctedPlan!.tools[0] as { lat: number; lon: number };
    expect(pointInPolygon(target, site.nfz[0].polygon)).toBe(false);
    expect(verifyMission(v.correctedPlan!, site).verdict).toBe('pass');
  });

  it('pulls a target outside the perimeter back inside and re-verifies to pass', () => {
    const plan: MissionPlan = {
      requestId: 'req-fence',
      anomalyId: 'anom-1',
      profile: 'standard',
      rationale: 'test',
      tools: [
        // due south, ~200 m beyond the perimeter
        { tool: 'goto_gps', lat: -0.012, lon: 0, alt: midAlt },
        { tool: 'rtl' },
      ],
    };
    // ~1.1 km out-and-back: give it a healthy battery so only geofence fails.
    const telemetry = { battery: { remaining: 100 } };
    const v = verifyMission(plan, site, telemetry);
    expect(v.verdict).toBe('corrected');
    const fence = v.checks.find((c) => c.name === 'geofence')!;
    expect(fence.ok).toBe(false);
    expect(fence.edit).toMatch(/inside the perimeter/);
    const target = v.correctedPlan!.tools[0] as { lat: number; lon: number };
    expect(pointInPolygon(target, site.perimeter)).toBe(true);
    expect(verifyMission(v.correctedPlan!, site, telemetry).verdict).toBe('pass');
  });
});

describe('verifyMission — battery', () => {
  const site = syntheticSite();
  const midAlt = 40;

  // Short out-and-back plan whose exact energy need we can compute.
  const target = { lat: -0.0005, lon: 0 };
  const plan: MissionPlan = {
    requestId: 'req-batt',
    anomalyId: 'anom-1',
    profile: 'standard',
    rationale: 'test',
    tools: [
      { tool: 'goto_gps', lat: target.lat, lon: target.lon, alt: midAlt },
      { tool: 'rtl' },
    ],
  };
  const home = { lat: site.home.lat, lon: site.home.lon };
  const pathM = haversineMeters(home, target) * 2;
  const flightS = pathM / PROFILE_SPEED_MPS.standard;
  const requiredPct = flightS * DRAIN_PCT_PER_S + RESERVE_PCT;

  it('fails just below the boundary and passes just above it (not correctable)', () => {
    const below = verifyMission(plan, site, { battery: { remaining: requiredPct - 0.1 } });
    expect(below.verdict).toBe('rejected');
    const batt = below.checks.find((c) => c.name === 'battery')!;
    expect(batt.ok).toBe(false);
    expect(below.correctedPlan).toBeUndefined();

    const above = verifyMission(plan, site, { battery: { remaining: requiredPct + 0.1 } });
    expect(above.verdict).toBe('pass');
  });

  it('uses the documented conservative default when no telemetry is given', () => {
    const v = verifyMission(plan, site);
    const batt = v.checks.find((c) => c.name === 'battery')!;
    expect(batt.reason).toContain(`${DEFAULT_BATTERY_PCT}%`);
    expect(batt.ok).toBe(requiredPct <= DEFAULT_BATTERY_PCT);
  });
});
