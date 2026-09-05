/* ============================================================================
 * eis-cues — geometry helpers. Pure math, no I/O, browser-safe.
 *
 * Conventions match docs/SITE_CONTRACT.md: WGS84 decimal degrees, polygons are
 * OPEN rings (closing edge implicit, either winding), distances in metres,
 * bearings in true degrees (0 = north, clockwise).
 *
 * Internally a local equirectangular projection anchored at a reference point
 * is used — accurate to well under 0.1% at plant scale (a few km), far inside
 * the margins any consumer of a cue applies.
 * ========================================================================== */

export interface LatLon {
  lat: number;
  lon: number;
}

/** Wire form used by the site JSON: [lat, lon] — lat FIRST, never lon-first. */
export type LatLonPair = [number, number];

export const EARTH_RADIUS_M = 6371000;
export const M_PER_DEG_LAT = 111320;

const DEG = Math.PI / 180;

interface XY { x: number; y: number } // metres east (x) / north (y) of origin

function toLocal(p: LatLon, origin: LatLon): XY {
  return {
    x: (p.lon - origin.lon) * M_PER_DEG_LAT * Math.cos(origin.lat * DEG),
    y: (p.lat - origin.lat) * M_PER_DEG_LAT,
  };
}

function fromLocal(p: XY, origin: LatLon): LatLon {
  return {
    lat: origin.lat + p.y / M_PER_DEG_LAT,
    lon: origin.lon + p.x / (M_PER_DEG_LAT * Math.cos(origin.lat * DEG)),
  };
}

/** Great-circle distance between two WGS84 points, metres (haversine). */
export function haversineMeters(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Normalise a bearing into [0, 360). */
export function normalizeBearing(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Point `rangeM` metres from `origin` along true bearing `bearingDeg`. */
export function destination(origin: LatLon, bearingDeg: number, rangeM: number): LatLon {
  const theta = normalizeBearing(bearingDeg) * DEG;
  return fromLocal(
    { x: Math.sin(theta) * rangeM, y: Math.cos(theta) * rangeM },
    origin,
  );
}

/** Point-in-polygon (ray casting) over an OPEN ring. Winding-agnostic. */
export function pointInPolygon(p: LatLon, polygon: LatLon[]): boolean {
  if (polygon.length < 3) return false;
  const origin = polygon[0];
  const pt = toLocal(p, origin);
  const ring = polygon.map((v) => toLocal(v, origin));
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if ((a.y > pt.y) !== (b.y > pt.y)) {
      const xAtY = a.x + ((pt.y - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (pt.x < xAtY) inside = !inside;
    }
  }
  return inside;
}

function nearestPointOnSegmentXY(p: XY, a: XY, b: XY): XY {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return { x: a.x, y: a.y };
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
  return { x: a.x + t * abx, y: a.y + t * aby };
}

/** Closest point on the polygon boundary (including the implicit closing edge). */
export function nearestPointOnPolygonBoundary(p: LatLon, polygon: LatLon[]): LatLon {
  const origin = polygon[0];
  const pt = toLocal(p, origin);
  const ring = polygon.map((v) => toLocal(v, origin));
  let best: XY = ring[0];
  let bestD2 = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const cand = nearestPointOnSegmentXY(pt, ring[i], ring[(i + 1) % ring.length]);
    const d2 = (cand.x - pt.x) ** 2 + (cand.y - pt.y) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = cand;
    }
  }
  return fromLocal(best, origin);
}

/** Minimum horizontal distance from a point to a polygon boundary, metres. */
export function distanceToPolygonBoundaryMeters(p: LatLon, polygon: LatLon[]): number {
  return haversineMeters(p, nearestPointOnPolygonBoundary(p, polygon));
}

/**
 * Clamp a point into a polygon: unchanged when already inside, otherwise the
 * nearest boundary point pulled `inwardMarginM` metres toward the polygon's
 * vertex centroid so the result is inside rather than exactly on the edge.
 *
 * Used for the pixel-mode FOV clamp: a projected cue may never claim ground
 * the camera cannot see.
 */
export function clampIntoPolygon(p: LatLon, polygon: LatLon[], inwardMarginM = 1): LatLon {
  if (pointInPolygon(p, polygon)) return p;
  const origin = polygon[0];
  const boundary = toLocal(nearestPointOnPolygonBoundary(p, polygon), origin);
  const ring = polygon.map((v) => toLocal(v, origin));
  const cx = ring.reduce((s, v) => s + v.x, 0) / ring.length;
  const cy = ring.reduce((s, v) => s + v.y, 0) / ring.length;
  let dx = cx - boundary.x;
  let dy = cy - boundary.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return fromLocal(boundary, origin);
  dx /= len;
  dy /= len;
  const step = Math.min(inwardMarginM, len);
  return fromLocal({ x: boundary.x + dx * step, y: boundary.y + dy * step }, origin);
}

/** Vertex centroid of a polygon. Adequate for cue placement, not area maths. */
export function polygonCentroid(polygon: LatLon[]): LatLon {
  return {
    lat: polygon.reduce((s, v) => s + v.lat, 0) / polygon.length,
    lon: polygon.reduce((s, v) => s + v.lon, 0) / polygon.length,
  };
}
