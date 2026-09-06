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

/**
 * Is this point inside the tile's own bounds? (FM-109)
 *
 * `latLonToPixel` is a linear map with no clamp, so a point outside the bounds
 * extrapolates happily to a negative or over-width pixel coordinate. A panel
 * that converts that straight to a CSS percentage draws a marker off the image
 * with nothing to say it is off-frame, which reads as "the anomaly is at the
 * edge of the tile" rather than "the anomaly is not on this tile at all". The
 * caller asks first and labels the answer.
 *
 * Inclusive on every edge: a cue exactly on the north edge is on the tile.
 */
export function inBounds(lat: number, lon: number, g: GeoRefTiles): boolean {
  const { north, south, east, west } = g.boundsLatLon;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return lat >= south && lat <= north && lon >= west && lon <= east;
}

/** Projection plus the on-tile answer, so a caller cannot use one without the other. */
export interface TileProjection {
  x: number;
  y: number;
  /** True when the source point lies inside `boundsLatLon`. */
  onTile: boolean;
  /** `x`/`y` clamped to the tile, so an off-tile marker still has somewhere to sit. */
  clampedX: number;
  clampedY: number;
}

/**
 * Project a point onto the tile and say whether it actually belongs there.
 * The clamped coordinates put an off-tile marker on the nearest edge — visible,
 * and (with the `onTile` flag driving the badge) never mistaken for a hit.
 */
export function projectToTile(lat: number, lon: number, g: GeoRefTiles): TileProjection {
  const { x, y } = latLonToPixel(lat, lon, g);
  const clamp = (value: number, max: number): number =>
    Number.isFinite(value) ? Math.min(max, Math.max(0, value)) : max / 2;
  return {
    x, y,
    onTile: inBounds(lat, lon, g),
    clampedX: clamp(x, g.widthPx),
    clampedY: clamp(y, g.heightPx),
  };
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
