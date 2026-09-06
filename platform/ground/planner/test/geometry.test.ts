/**
 * geometry.ts is the ONE library. These tests pin the parts the planner and the
 * verifier both depend on being identical: buffered-NFZ clearance, the via-point
 * ordering and its tie-break, the orbit shrink that stops at standoff, and the
 * flight-time / range model.
 */
import { describe, expect, it } from 'vitest';

import {
  corridorGeometryFromWalk, distanceSegmentToSegmentMeters, findViaPoint, lateralSeparationM,
  nfzTransitViolations, orbitClearsBufferedNfzs, orbitEntryPoint, orbitInsideGeofence,
  pointInsideGeofence, rangeAvailableSeconds, routeVias, segmentClearsBufferedNfzs,
  shrinkOrbitRadius, timeBudgetSeconds, translateMeters, trimToBudget, verticalSeparationM,
  viaCandidates, walkPlan, windAdjustedSeconds,
} from '../src/geometry';
import { MissionPlan } from '../src/contract';
import { SiteModel, validateSite } from '../src/site';
import { VERIFIER_POLICY } from '../src/policy';

/** A square site with one 40 m-ceiling NFZ block due north of home. */
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

const home = { lat: 0, lon: 0 };
const north = { lat: 0.008, lon: 0 };

describe('buffered NFZ geometry', () => {
  it('applies a zone only at or below its ceiling', () => {
    const model = site();
    expect(segmentClearsBufferedNfzs(home, north, 30, model)).toBe(false);
    expect(segmentClearsBufferedNfzs(home, north, 41, model)).toBe(true);
    expect(nfzTransitViolations(home, north, 30, model)[0].zone.name).toBe('north block');
  });

  it('measures an orbit against the buffer plus its own radius', () => {
    const model = site();
    const near = { lat: 0.0062, lon: 0 };       // ~22 m north of the zone edge
    expect(orbitClearsBufferedNfzs(near, 5, 30, model)).toBe(true);
    expect(orbitClearsBufferedNfzs(near, 25, 30, model)).toBe(false);
    expect(orbitClearsBufferedNfzs(near, 25, 41, model)).toBe(true);   // above the ceiling
  });
});

describe('via-point search', () => {
  it('orders candidates by detour and breaks ties northernmost', () => {
    const model = site();
    const zone = model.nfz[0];
    const candidates = viaCandidates(home, north, zone, model, model.nfzBufferM * 2 + 5, false);
    expect(candidates.length).toBeGreaterThan(1);
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i].detourM).toBeGreaterThanOrEqual(candidates[i - 1].detourM - 1e-6);
    }
    const ties = candidates.filter((entry) =>
      Math.abs(entry.detourM - candidates[0].detourM) <= 1e-6);
    if (ties.length > 1) {
      expect(candidates[0].point.lat).toBe(Math.max(...ties.map((entry) => entry.point.lat)));
    }
  });

  it('routes around the buffered zone and clears it on every leg', () => {
    const model = site();
    const vias = routeVias(home, north, 30, model);
    expect(vias).not.toBeNull();
    expect((vias as Array<{ lat: number; lon: number }>).length).toBeGreaterThan(0);
    const points = [home, ...(vias as Array<{ lat: number; lon: number }>), north];
    for (let i = 1; i < points.length; i++) {
      expect(segmentClearsBufferedNfzs(points[i - 1], points[i], 30, model)).toBe(true);
    }
  });

  it('returns no route rather than a route through the buffer', () => {
    const model = site();
    const inside = { lat: 0.0045, lon: 0 };     // inside the polygon itself
    expect(findViaPoint(home, inside, 30, model)).not.toBeNull();
    expect(routeVias(home, inside, 30, model)).toBeNull();
  });

  it('needs no via-point above the ceiling', () => {
    expect(routeVias(home, north, 41, site())).toEqual([]);
  });
});

describe('orbit geometry', () => {
  it('shrinks to clear the buffer but never below the standoff floor', () => {
    const model = site();
    const near = { lat: 0.0062, lon: 0 };       // ~22 m north of the zone edge
    const shrunk = shrinkOrbitRadius(near, 40, 30, model, 5);
    expect(shrunk).not.toBeNull();
    expect(shrunk as number).toBeLessThan(40);
    expect(shrunk as number).toBeGreaterThanOrEqual(5);
    expect(orbitClearsBufferedNfzs(near, shrunk as number, 30, model)).toBe(true);
    expect(orbitInsideGeofence(near, shrunk as number, model)).toBe(true);
  });

  it('refuses rather than shrinking below standoff', () => {
    const model = site();
    const hard = { lat: 0.00611, lon: 0 };      // ~12 m from the zone: the buffer alone eats it
    expect(shrinkOrbitRadius(hard, 25, 30, model, 5)).toBeNull();
    expect(shrinkOrbitRadius({ lat: 0.02, lon: 0 }, 25, 30, model, 5)).toBeNull(); // outside the fence
    expect(pointInsideGeofence({ lat: 0.02, lon: 0 }, model)).toBe(false);
  });

  it('enters the ring on the side the vehicle comes from', () => {
    const entry = orbitEntryPoint(north, home, 25);
    expect(entry.lat).toBeLessThan(north.lat);
    expect(Math.abs(entry.lon - north.lon)).toBeLessThan(1e-9);
  });
});

describe('mission time and range model', () => {
  const plan: MissionPlan = {
    requestId: 'geo-1', anomalyId: 'a-1', profile: 'inspect', rationale: 'test',
    tools: [
      { tool: 'goto_gps', lat: 0.004, lon: 0, alt: 40 },
      { tool: 'orbit_point', lat: 0.004, lon: 0, radius: 25, laps: 2 },
      { tool: 'hold', durationS: 15 },
      { tool: 'rtl' },
    ],
  };

  it('charges climb, cruise, orbit, hold and the landing tail', () => {
    const walk = walkPlan(plan, site(), { start: home, startAltM: null });
    expect(walk.legs.length).toBeGreaterThan(0);
    expect(walk.totalFlightS).toBeGreaterThan(15);
    expect(walk.targets.filter((target) => target.kind === 'orbit_point')).toHaveLength(1);
  });

  it('inflates flight time with wind and keeps the 25 percent reserve', () => {
    expect(windAdjustedSeconds(100, 0)).toBe(100);
    expect(windAdjustedSeconds(100, 10)).toBeCloseTo(150, 6);
    expect(rangeAvailableSeconds(VERIFIER_POLICY.reservePct)).toBe(0);
    expect(rangeAvailableSeconds(100)).toBeCloseTo(VERIFIER_POLICY.nominalEnduranceS * 0.75, 6);
  });

  it('budgets min(range, sortie cap)', () => {
    expect(timeBudgetSeconds({ socPct: 100 })).toBe(VERIFIER_POLICY.maxSortieS);
    expect(timeBudgetSeconds({ socPct: 30 })).toBeCloseTo(75, 6);
    expect(timeBudgetSeconds({ socPct: 100, maxSortieS: 120 })).toBe(120);
  });

  it('trims holds and extra laps, and never the route', () => {
    const trimmed = trimToBudget(plan.tools);
    expect(trimmed.tools.some((tool) => tool.tool === 'hold')).toBe(false);
    expect(trimmed.tools.filter((tool) => tool.tool === 'goto_gps')).toHaveLength(1);
    expect(trimmed.notes.join(' | ')).toContain('dropped hold');
    expect(trimmed.notes.join(' | ')).toContain('one lap');
    const orbit = trimmed.tools.find((tool) => tool.tool === 'orbit_point');
    expect(orbit && orbit.tool === 'orbit_point' ? orbit.laps : 0).toBe(1);
  });
});

describe('separation geometry', () => {
  it('measures corridor to corridor, ring to ring and band to band', () => {
    const a = { lat: 0, lon: 0 };
    const b = translateMeters(a, 0, 100);
    const c = translateMeters(a, 50, 0);
    const d = translateMeters(a, 50, 100);
    expect(distanceSegmentToSegmentMeters(a, b, c, d)).toBeCloseTo(50, 0);
    const ours = corridorGeometryFromWalk(walkPlan({
      requestId: 'r', anomalyId: 'a', profile: 'inspect', rationale: '',
      tools: [{ tool: 'goto_gps', lat: b.lat, lon: b.lon, alt: 40 }, { tool: 'rtl' }],
    }, site(), { start: a, startAltM: 40 }));
    expect(lateralSeparationM(ours, { points: [d], legs: [], orbits: [], altBandM: { min: 40, max: 40 } }))
      .toBeGreaterThan(45);
    expect(verticalSeparationM({ min: 30, max: 34 }, { min: 44, max: 46 })).toBe(10);
    expect(verticalSeparationM({ min: 30, max: 45 }, { min: 44, max: 46 })).toBe(0);
    expect(verticalSeparationM({ min: 30, max: 45 }, null)).toBe(0);
  });
});
