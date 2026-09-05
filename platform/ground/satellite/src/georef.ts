/* ============================================================================
 * eis-satellite — georeferencing math (pure TS, Node + browser).
 *
 * Linear (equirectangular) mapping between tile pixel space and WGS84 within
 * the tile's bounds. Convention: row 0 = north edge, col 0 = west edge, and
 * coordinates are CONTINUOUS (pixel i spans [i, i+1), its center is i + 0.5).
 * latLonToPixel and pixelToLatLon are exact inverses.
 * ========================================================================== */

import type { GeoRefTiles } from './types.js';

const EARTH_RADIUS_M = 6371008.8;

/** Lat/lon (deg) -> continuous pixel coords in [0..widthPx] x [0..heightPx]. */
export function latLonToPixel(
  lat: number,
  lon: number,
  g: GeoRefTiles,
): { x: number; y: number } {
  const { north, south, east, west } = g.boundsLatLon;
  const x = ((lon - west) / (east - west)) * g.widthPx;
  const y = ((north - lat) / (north - south)) * g.heightPx;
  return { x, y };
}

/** Continuous pixel coords -> lat/lon (deg). Exact inverse of latLonToPixel. */
export function pixelToLatLon(
  x: number,
  y: number,
  g: GeoRefTiles,
): { lat: number; lon: number } {
  const { north, south, east, west } = g.boundsLatLon;
  const lon = west + (x / g.widthPx) * (east - west);
  const lat = north - (y / g.heightPx) * (north - south);
  return { lat, lon };
}

/** Approximate ground resolution of the tile, meters per pixel, per axis. */
export function metersPerPixel(g: GeoRefTiles): { x: number; y: number } {
  const { north, south, east, west } = g.boundsLatLon;
  const midLat = (north + south) / 2;
  const latSpanM = distanceMeters(north, west, south, west);
  const lonSpanM = distanceMeters(midLat, west, midLat, east);
  return { x: lonSpanM / g.widthPx, y: latSpanM / g.heightPx };
}

/** Great-circle (haversine) distance in meters between two WGS84 points. */
export function distanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Basic sanity validation of a tiles.json object. Throws on bad shape. */
export function validateGeoRef(g: GeoRefTiles): GeoRefTiles {
  const b = g?.boundsLatLon;
  if (
    !b ||
    !Number.isFinite(b.north) || !Number.isFinite(b.south) ||
    !Number.isFinite(b.east) || !Number.isFinite(b.west) ||
    !(b.north > b.south) || !(b.east > b.west) ||
    !Number.isInteger(g.widthPx) || !Number.isInteger(g.heightPx) ||
    g.widthPx <= 0 || g.heightPx <= 0
  ) {
    throw new Error('eis-satellite: invalid tiles.json georef sidecar');
  }
  return g;
}
