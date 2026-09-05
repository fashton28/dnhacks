/**
 * ScriptedPlanner geometry must be DERIVED from the site + anomaly. Every
 * assertion here runs against a MUTATED copy of the stub site (different
 * coordinates, band, and ceiling than the checked-in stub), proving nothing
 * is hardcoded to the stub's values.
 */
import { describe, expect, it } from 'vitest';

import stubSite from '../../../site/site.stub.json';
import { Anomaly, GotoGpsTool, OrbitPointTool } from '../src/contract';
import { ORBIT_RADIUS_M, ScriptedPlanner } from '../src/scripted';
import { SiteModel, haversineMeters, polygonCentroid, validateSite } from '../src/site';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

interface RawSite {
  home: { lat: number; lon: number };
  perimeter: number[][];
  geofence: number[][];
  nfz: { polygon: number[][]; ceiling_m: number }[];
  clutter: { polygon: number[][] }[];
  alt_band_m: { min: number; max: number };
  staging: { lat: number; lon: number }[];
}

function mutatedSite(overrides: Partial<{ band: { min: number; max: number }; ceiling: number }> = {}): SiteModel {
  const raw = clone(stubSite) as unknown as RawSite;
  const dLat = 0.013;
  const dLon = -0.02;
  raw.home.lat += dLat; raw.home.lon += dLon;
  raw.perimeter.forEach((p) => { p[0] += dLat; p[1] += dLon; });
  raw.geofence.forEach((p) => { p[0] += dLat; p[1] += dLon; });
  raw.nfz.forEach((z) => z.polygon.forEach((p) => { p[0] += dLat; p[1] += dLon; }));
  raw.clutter.forEach((z) => z.polygon.forEach((p) => { p[0] += dLat; p[1] += dLon; }));
  raw.staging.forEach((s) => { s.lat += dLat; s.lon += dLon; });
  raw.alt_band_m = overrides.band ?? { min: 28, max: 76 };
  raw.nfz[0].ceiling_m = overrides.ceiling ?? 150;
  return validateSite(raw);
}

const anomaly: Anomaly = {
  id: 'anom-x', lat: 0, lon: 0, type: 'change', confidence: 0.8,
  thumbnail: 't.png', source: 'sentinel2',
};

const planner = new ScriptedPlanner();

describe('ScriptedPlanner.passingPlan (derived, not hardcoded)', () => {
  it('flies to the anomaly at mid-band, orbits, then RTLs', () => {
    const site = mutatedSite();
    const a: Anomaly = { ...anomaly, lat: site.staging[0].lat, lon: site.staging[0].lon };
    const plan = planner.passingPlan(site, a);

    expect(plan.anomalyId).toBe(a.id);
    expect(plan.requestId).toContain(a.id);
    expect(plan.profile).toBe('standard');
    expect(plan.tools).toHaveLength(3);

    const goto = plan.tools[0] as GotoGpsTool;
    expect(goto.tool).toBe('goto_gps');
    expect(haversineMeters(goto, a)).toBeCloseTo(ORBIT_RADIUS_M, 0);
    expect(goto.alt).toBe(45); // site midpoint is capped by the standard profile
    expect(goto.profile).toBe('standard');

    const orbit = plan.tools[1] as OrbitPointTool;
    expect(orbit.tool).toBe('orbit_point');
    expect(orbit.lat).toBe(a.lat);
    expect(orbit.lon).toBe(a.lon);
    expect(orbit.radius).toBe(ORBIT_RADIUS_M);
    expect(orbit.radius).toBeGreaterThanOrEqual(3); // standoff floor

    expect(plan.tools[2].tool).toBe('rtl');
  });
});

describe('ScriptedPlanner.failingPlan (derived, not hardcoded)', () => {
  it('targets the centroid of the site\'s first NFZ above the band, under the ceiling', () => {
    const site = mutatedSite(); // band 28..76, ceiling 150
    const plan = planner.failingPlan(site, anomaly);
    const goto = plan.tools[0] as GotoGpsTool;
    const centroid = polygonCentroid(site.nfz[0].polygon);

    expect(goto.tool).toBe('goto_gps');
    expect(goto.lat).toBeCloseTo(centroid.lat, 10);
    expect(goto.lon).toBeCloseTo(centroid.lon, 10);
    // violates the (mutated) alt band AND stays inside the NFZ ceiling
    expect(goto.alt).toBeGreaterThan(site.altBandM.max);
    expect(goto.alt).toBeLessThanOrEqual(site.nfz[0].ceilingM);
    expect(plan.tools[plan.tools.length - 1].tool).toBe('rtl');
  });

  it('flies below the band when the NFZ ceiling sits inside the band', () => {
    const site = mutatedSite({ band: { min: 20, max: 60 }, ceiling: 40 });
    const plan = planner.failingPlan(site, anomaly);
    const goto = plan.tools[0] as GotoGpsTool;
    expect(goto.alt).toBeLessThan(site.altBandM.min);
    expect(goto.alt).toBeLessThanOrEqual(site.nfz[0].ceilingM);
    expect(goto.alt).toBeGreaterThan(0);
  });

  it('throws when the site has no NFZ to violate', () => {
    const raw = clone(stubSite) as unknown as RawSite;
    raw.nfz = [];
    const site = validateSite(raw);
    expect(() => planner.failingPlan(site, anomaly)).toThrow(/no NFZs/);
  });
});
