/* ============================================================================
 * FM-109 — a cue outside the tile's bounds must be LABELLED off-tile, not
 * extrapolated onto the image and drawn as if it were a hit.
 * ========================================================================== */
import { describe, expect, it } from 'vitest';
import { inBounds, latLonToPixel, projectToTile } from '../src/georef.js';
import type { GeoRefTiles } from '../src/types.js';

const G: GeoRefTiles = {
  boundsLatLon: { north: -26.0875, south: -26.0925, east: 29.4747, west: 29.4691 },
  widthPx: 512,
  heightPx: 512,
};
const mid = {
  lat: (G.boundsLatLon.north + G.boundsLatLon.south) / 2,
  lon: (G.boundsLatLon.east + G.boundsLatLon.west) / 2,
};

describe('inBounds', () => {
  it('accepts a point inside and on every edge', () => {
    expect(inBounds(mid.lat, mid.lon, G)).toBe(true);
    expect(inBounds(G.boundsLatLon.north, mid.lon, G)).toBe(true);
    expect(inBounds(G.boundsLatLon.south, mid.lon, G)).toBe(true);
    expect(inBounds(mid.lat, G.boundsLatLon.west, G)).toBe(true);
    expect(inBounds(mid.lat, G.boundsLatLon.east, G)).toBe(true);
  });

  it.each([
    ['north of the tile', G.boundsLatLon.north + 0.001, mid.lon],
    ['south of the tile', G.boundsLatLon.south - 0.001, mid.lon],
    ['west of the tile', mid.lat, G.boundsLatLon.west - 0.001],
    ['east of the tile', mid.lat, G.boundsLatLon.east + 0.001],
    ['a long way away', 0, 0],
  ])('rejects a point %s', (_label, lat, lon) => {
    expect(inBounds(lat, lon, G)).toBe(false);
  });

  it('rejects a non-finite coordinate rather than projecting NaN', () => {
    expect(inBounds(Number.NaN, mid.lon, G)).toBe(false);
    expect(inBounds(mid.lat, Number.POSITIVE_INFINITY, G)).toBe(false);
  });
});

describe('projectToTile', () => {
  it('marks an on-tile point and leaves its projection untouched', () => {
    const p = projectToTile(mid.lat, mid.lon, G);
    const raw = latLonToPixel(mid.lat, mid.lon, G);
    expect(p.onTile).toBe(true);
    expect(p.x).toBeCloseTo(raw.x, 9);
    expect(p.clampedX).toBeCloseTo(raw.x, 9);
    expect(p.clampedY).toBeCloseTo(raw.y, 9);
  });

  it('marks an off-tile point and clamps it onto the nearest edge', () => {
    // A cue re-anchored well north of the tile: the raw projection is
    // NEGATIVE, which a percentage-based marker draws off the image.
    const p = projectToTile(G.boundsLatLon.north + 0.005, mid.lon, G);
    expect(p.onTile).toBe(false);
    expect(p.y).toBeLessThan(0);
    expect(p.clampedY).toBe(0);
    expect(p.clampedX).toBeGreaterThanOrEqual(0);
    expect(p.clampedX).toBeLessThanOrEqual(G.widthPx);
  });

  it('clamps a far-east cue to the right edge', () => {
    const p = projectToTile(mid.lat, G.boundsLatLon.east + 0.01, G);
    expect(p.onTile).toBe(false);
    expect(p.x).toBeGreaterThan(G.widthPx);
    expect(p.clampedX).toBe(G.widthPx);
  });

  it('keeps a non-finite coordinate on the tile rather than producing NaN CSS', () => {
    const p = projectToTile(Number.NaN, Number.NaN, G);
    expect(p.onTile).toBe(false);
    expect(Number.isFinite(p.clampedX)).toBe(true);
    expect(Number.isFinite(p.clampedY)).toBe(true);
  });
});
