import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import stubSite from '../../../site/site.stub.json';
import {
  DEFAULT_SITE_FILE,
  LatLon,
  haversineMeters,
  loadSite,
  movePointAcrossBoundary,
  pointInPolygon,
  polygonCentroid,
  resolveSiteFile,
  segmentEntersPolygon,
  segmentIntersectsPolygon,
  segmentStaysInsidePolygon,
  validateSite,
} from '../src/site';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('validateSite', () => {
  it('accepts the repo stub and maps fields', () => {
    const site = validateSite(clone(stubSite));
    expect(site.home.lat).toBe(stubSite.home.lat);
    expect(site.home.altM).toBe(stubSite.home.alt_m);
    expect(site.perimeter).toHaveLength(stubSite.perimeter.length);
    expect(site.nfz[0].name).toBe(stubSite.nfz[0].name);
    expect(site.nfz[0].ceilingM).toBe(stubSite.nfz[0].ceiling_m);
    expect(site.altBandM).toEqual({ min: stubSite.alt_band_m.min, max: stubSite.alt_band_m.max });
    expect(site.staging.map((s) => s.id)).toEqual(stubSite.staging.map((s) => s.id));
  });

  it('rejects a missing home', () => {
    const bad = clone<Record<string, unknown>>(stubSite);
    delete bad.home;
    expect(() => validateSite(bad)).toThrow(/home/);
  });

  it('rejects a degenerate perimeter (< 3 vertices)', () => {
    const bad = clone(stubSite) as { perimeter: number[][] };
    bad.perimeter = bad.perimeter.slice(0, 2);
    expect(() => validateSite(bad)).toThrow(/perimeter/);
  });

  it('rejects an out-of-range latitude', () => {
    const bad = clone(stubSite) as { perimeter: number[][] };
    bad.perimeter[0][0] = 123.4;
    expect(() => validateSite(bad)).toThrow(/latitude/);
  });

  it('rejects an inverted alt band', () => {
    const bad = clone(stubSite) as { alt_band_m: { min: number; max: number } };
    bad.alt_band_m = { min: 60, max: 20 };
    expect(() => validateSite(bad)).toThrow(/alt_band_m/);
  });

  it('rejects an unknown staging truth label', () => {
    const bad = clone(stubSite) as { staging: { truth: string }[] };
    bad.staging[0].truth = 'ufo';
    expect(() => validateSite(bad)).toThrow(/truth/);
  });
});

describe('loadSite', () => {
  it('loads a site JSON from disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eis-planner-'));
    const file = path.join(dir, 'site.json');
    fs.writeFileSync(file, JSON.stringify(stubSite));
    expect(loadSite(file)).toEqual(validateSite(clone(stubSite)));
  });

  it('throws on a missing file', () => {
    expect(() => loadSite(path.join(os.tmpdir(), 'eis-planner-does-not-exist.json')))
      .toThrow(/not readable/);
  });

  it('throws on invalid JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eis-planner-'));
    const file = path.join(dir, 'broken.json');
    fs.writeFileSync(file, '{ nope');
    expect(() => loadSite(file)).toThrow(/valid JSON/);
  });
});

describe('resolveSiteFile (EIS_SITE_FILE)', () => {
  const saved = process.env.EIS_SITE_FILE;
  afterEach(() => {
    if (saved === undefined) delete process.env.EIS_SITE_FILE;
    else process.env.EIS_SITE_FILE = saved;
  });

  it('defaults to site/site.json under the repo root', () => {
    delete process.env.EIS_SITE_FILE;
    const root = path.resolve('some', 'repo');
    expect(resolveSiteFile(root)).toBe(path.resolve(root, DEFAULT_SITE_FILE));
  });

  it('honours EIS_SITE_FILE relative to the repo root', () => {
    process.env.EIS_SITE_FILE = 'site/site.stub.json';
    const root = path.resolve('some', 'repo');
    expect(resolveSiteFile(root)).toBe(path.resolve(root, 'site', 'site.stub.json'));
  });
});

describe('geometry', () => {
  // 0.01 deg ~ 1.1 km square on the equator, both windings.
  const squareCcw: LatLon[] = [
    { lat: -0.01, lon: -0.01 }, { lat: -0.01, lon: 0.01 },
    { lat: 0.01, lon: 0.01 }, { lat: 0.01, lon: -0.01 },
  ];
  const squareCw = [...squareCcw].reverse();

  it('haversineMeters: 0.001 deg of latitude is ~111.2 m', () => {
    const d = haversineMeters({ lat: 0, lon: 0 }, { lat: 0.001, lon: 0 });
    expect(d).toBeGreaterThan(110.5);
    expect(d).toBeLessThan(112);
  });

  it('pointInPolygon handles both windings', () => {
    const inside = { lat: 0.002, lon: -0.003 };
    const outside = { lat: 0.02, lon: 0 };
    for (const ring of [squareCcw, squareCw]) {
      expect(pointInPolygon(inside, ring)).toBe(true);
      expect(pointInPolygon(outside, ring)).toBe(false);
    }
  });

  it('segmentIntersectsPolygon detects boundary crossings (incl. closing edge)', () => {
    const inside = { lat: 0, lon: 0 };
    const outside = { lat: 0.02, lon: 0 };
    expect(segmentIntersectsPolygon(inside, outside, squareCcw)).toBe(true);
    // fully inside: no boundary intersection
    expect(segmentIntersectsPolygon(inside, { lat: 0.005, lon: 0.005 }, squareCcw)).toBe(false);
    // fully outside, passing nowhere near
    expect(segmentIntersectsPolygon({ lat: 0.02, lon: 0.02 }, { lat: 0.03, lon: 0.02 }, squareCcw)).toBe(false);
    // pass-through: both endpoints outside, line crosses the square
    expect(segmentIntersectsPolygon({ lat: -0.02, lon: 0 }, { lat: 0.02, lon: 0 }, squareCcw)).toBe(true);
  });

  it('segmentStaysInsidePolygon / segmentEntersPolygon', () => {
    const a = { lat: -0.005, lon: -0.005 };
    const b = { lat: 0.005, lon: 0.005 };
    expect(segmentStaysInsidePolygon(a, b, squareCcw)).toBe(true);
    expect(segmentStaysInsidePolygon(a, { lat: 0.02, lon: 0 }, squareCcw)).toBe(false);
    expect(segmentEntersPolygon({ lat: -0.02, lon: 0 }, { lat: 0.02, lon: 0 }, squareCcw)).toBe(true);
    expect(segmentEntersPolygon({ lat: 0.02, lon: 0.02 }, { lat: 0.03, lon: 0.02 }, squareCcw)).toBe(false);
  });

  it('movePointAcrossBoundary pushes an inside point out (and vice versa) by ~margin', () => {
    const inside = { lat: 0.008, lon: 0 }; // 222 m from the north edge
    const pushedOut = movePointAcrossBoundary(inside, squareCcw, 5);
    expect(pointInPolygon(pushedOut, squareCcw)).toBe(false);
    // it crossed the north edge and sits ~5 m beyond it
    const northEdgePoint = { lat: 0.01, lon: 0 };
    expect(haversineMeters(pushedOut, northEdgePoint)).toBeGreaterThan(4);
    expect(haversineMeters(pushedOut, northEdgePoint)).toBeLessThan(6.5);

    const outside = { lat: 0.02, lon: 0 };
    const pulledIn = movePointAcrossBoundary(outside, squareCcw, 5);
    expect(pointInPolygon(pulledIn, squareCcw)).toBe(true);
  });

  it('polygonCentroid is the vertex mean', () => {
    const c = polygonCentroid(squareCcw);
    expect(c.lat).toBeCloseTo(0, 10);
    expect(c.lon).toBeCloseTo(0, 10);
  });
});
