import { describe, expect, it } from 'vitest';

import {
  distanceMeters,
  latLonToPixel,
  metersPerPixel,
  pixelToLatLon,
} from '../src/georef.js';
import type { GeoRefTiles } from '../src/types.js';

const G: GeoRefTiles = {
  boundsLatLon: { north: -35.359, south: -35.367, east: 149.170, west: 149.160 },
  widthPx: 512,
  heightPx: 512,
};

describe('georef', () => {
  it('roundtrips pixel -> latlon -> pixel exactly', () => {
    for (const [x, y] of [[0.5, 0.5], [255.5, 255.5], [511.5, 0.5], [37.25, 401.75]]) {
      const { lat, lon } = pixelToLatLon(x, y, G);
      const p = latLonToPixel(lat, lon, G);
      expect(p.x).toBeCloseTo(x, 6);
      expect(p.y).toBeCloseTo(y, 6);
    }
  });

  it('roundtrips latlon -> pixel -> latlon exactly', () => {
    const { x, y } = latLonToPixel(-35.3648, 149.1669, G);
    const back = pixelToLatLon(x, y, G);
    expect(back.lat).toBeCloseTo(-35.3648, 9);
    expect(back.lon).toBeCloseTo(149.1669, 9);
  });

  it('maps corners correctly (row 0 = north, col 0 = west)', () => {
    const nw = latLonToPixel(G.boundsLatLon.north, G.boundsLatLon.west, G);
    expect(nw.x).toBeCloseTo(0, 9);
    expect(nw.y).toBeCloseTo(0, 9);
    const se = latLonToPixel(G.boundsLatLon.south, G.boundsLatLon.east, G);
    expect(se.x).toBeCloseTo(G.widthPx, 9);
    expect(se.y).toBeCloseTo(G.heightPx, 9);
  });

  it('haversine distance is sane (1 deg latitude ~ 111.2 km)', () => {
    const d = distanceMeters(-35.0, 149.0, -36.0, 149.0);
    expect(d).toBeGreaterThan(110_500);
    expect(d).toBeLessThan(111_800);
    expect(distanceMeters(-35.36, 149.16, -35.36, 149.16)).toBe(0);
  });

  it('reports positive meters-per-pixel on both axes', () => {
    const mpp = metersPerPixel(G);
    expect(mpp.x).toBeGreaterThan(0);
    expect(mpp.y).toBeGreaterThan(0);
    // 0.008 deg lat over 512 px ~ 1.7 m/px.
    expect(mpp.y).toBeGreaterThan(1);
    expect(mpp.y).toBeLessThan(3);
  });
});
