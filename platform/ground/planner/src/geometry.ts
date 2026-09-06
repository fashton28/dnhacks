/* ============================================================================
 * eis-planner/geometry — THE one geometry library.
 *
 * Both the deterministic planner (`deterministic.ts`) and the trust layer
 * (`verifier.ts`) compute their geometry here, so a plan is drawn with exactly
 * the arithmetic that will later judge it. Two implementations of "does this
 * leg clear the buffered switchyard" is how a planner starts arguing with its
 * own verifier; there is only one, and it lives in this file.
 *
 * Contents, in order:
 *   1. Local frame        — equirectangular metres east/north of an origin.
 *   2. Polygon primitives — containment, segment intersection, distances,
 *                           and the "move a point clear" repairs.
 *   3. Site geometry      — buffered NFZs and geofence containment.
 *   4. Route search       — via-points around a buffered NFZ, shortest detour
 *                           first, northernmost via-point on a tie.
 *   5. Orbit geometry     — entry point and radius shrink that never goes
 *                           below the standoff floor.
 *   6. Mission model      — the plan walk, flight-time model, range/sortie
 *                           budget and the budget trim order.
 *
 * Units: DEGREES for coordinates ({lat, lon}), METRES for distances, SECONDS
 * for durations, m/s for speeds. Altitudes are metres AGL relative to home.
 *
 * The local projection is accurate to well under 0.1 % at plant scale (a few
 * km), far inside the margins the verifier applies.
 * ========================================================================== */

import { CapabilityProfile, MissionPlan, MissionProfile, PlanTool, PROFILE_SPEED_MPS } from './contract';
import { PROFILE_POLICY, VERIFIER_POLICY } from './policy';
import type { SiteModel, SiteNfz } from './site';

/* ---------------------------------------------------------------------------
 * 1. Local frame
 * ------------------------------------------------------------------------- */

/** A WGS84 point in decimal degrees. */
export interface LatLon {
  lat: number;
  lon: number;
}

/** Mean earth radius, meters (WGS84 mean radius). */
export const EARTH_RADIUS_M = 6371000;

/** Meters per degree of latitude (near-constant over the globe). */
export const M_PER_DEG_LAT = 111320;

const DEG = Math.PI / 180;

/** Metres east (x) / north (y) of a projection origin. */
export interface XY { x: number; y: number; }

/**
 * Great-circle distance between two WGS84 points, in METERS (haversine
 * formula on a sphere of radius EARTH_RADIUS_M).
 */
export function haversineMeters(a: LatLon, b: LatLon): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Project a point to local metres (equirectangular, anchored at `origin`). */
export function toLocal(p: LatLon, origin: LatLon): XY {
  return {
    x: (p.lon - origin.lon) * M_PER_DEG_LAT * Math.cos(origin.lat * DEG),
    y: (p.lat - origin.lat) * M_PER_DEG_LAT,
  };
}

/** Inverse of {@link toLocal}. */
export function fromLocal(p: XY, origin: LatLon): LatLon {
  return {
    lat: origin.lat + p.y / M_PER_DEG_LAT,
    lon: origin.lon + p.x / (M_PER_DEG_LAT * Math.cos(origin.lat * DEG)),
  };
}

/** Offset a point by metres east/north (the frame the site fixtures use). */
export function translateMeters(origin: LatLon, eastM: number, northM: number): LatLon {
  return {
    lat: origin.lat + northM / 111_320,
    lon: origin.lon + eastM / (111_320 * Math.cos(origin.lat * Math.PI / 180)),
  };
}

/** Round a coordinate to 6 decimal places (~0.1 m) so plans are byte-stable. */
export function round6(value: number): number { return Math.round(value * 1e6) / 1e6; }

/* ---------------------------------------------------------------------------
 * 2. Polygon primitives
 * ------------------------------------------------------------------------- */

/**
 * Point-in-polygon (ray casting) for an OPEN ring in degree space.
 * Winding-agnostic. Points exactly on an edge are implementation-defined
 * (treated as inside/outside depending on float rounding) — the verifier
 * always applies a margin, so exact-boundary points never matter in practice.
 */
export function pointInPolygon(p: LatLon, polygon: LatLon[]): boolean {
  const origin = polygon[0];
  const pt = toLocal(p, origin);
  const ring = polygon.map((v) => toLocal(v, origin));
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    const crosses = (a.y > pt.y) !== (b.y > pt.y);
    if (crosses) {
      const xAtY = a.x + ((pt.y - a.y) / (b.y - a.y)) * (b.x - a.x);
      if (pt.x < xAtY) inside = !inside;
    }
  }
  return inside;
}

function orient(a: XY, b: XY, c: XY): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: XY, b: XY, p: XY): boolean {
  return Math.min(a.x, b.x) - 1e-9 <= p.x && p.x <= Math.max(a.x, b.x) + 1e-9 &&
         Math.min(a.y, b.y) - 1e-9 <= p.y && p.y <= Math.max(a.y, b.y) + 1e-9;
}

function segmentsIntersect(p1: XY, p2: XY, p3: XY, p4: XY): boolean {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  if (d1 === 0 && onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && onSegment(p1, p2, p4)) return true;
  return false;
}

/**
 * True when the segment a→b intersects ANY edge of the (open-ring) polygon,
 * including the implicit closing edge. A segment lying entirely inside or
 * entirely outside the polygon does NOT intersect its boundary.
 */
export function segmentIntersectsPolygon(a: LatLon, b: LatLon, polygon: LatLon[]): boolean {
  const origin = polygon[0];
  const pa = toLocal(a, origin);
  const pb = toLocal(b, origin);
  const ring = polygon.map((v) => toLocal(v, origin));
  for (let i = 0; i < ring.length; i++) {
    const e1 = ring[i];
    const e2 = ring[(i + 1) % ring.length];
    if (segmentsIntersect(pa, pb, e1, e2)) return true;
  }
  return false;
}

/**
 * True when the whole segment a→b stays strictly inside a SIMPLE polygon:
 * both endpoints inside AND no boundary crossing. (For a simple polygon a
 * segment can only leave the interior by crossing the boundary.)
 */
export function segmentStaysInsidePolygon(a: LatLon, b: LatLon, polygon: LatLon[]): boolean {
  return pointInPolygon(a, polygon) &&
         pointInPolygon(b, polygon) &&
         !segmentIntersectsPolygon(a, b, polygon);
}

/**
 * True when the segment a→b enters the polygon at all: either endpoint
 * inside, or the segment crosses the boundary (pass-through counts).
 */
export function segmentEntersPolygon(a: LatLon, b: LatLon, polygon: LatLon[]): boolean {
  return pointInPolygon(a, polygon) ||
         pointInPolygon(b, polygon) ||
         segmentIntersectsPolygon(a, b, polygon);
}

function nearestPointOnSegmentXY(p: XY, a: XY, b: XY): XY {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * abx, y: a.y + t * aby };
}

/** Minimum horizontal distance from a point to a polygon boundary, meters. */
export function distancePointToPolygonMeters(p: LatLon, polygon: LatLon[]): number {
  return haversineMeters(p, nearestPointOnPolygonBoundary(p, polygon));
}

/** Point containment that treats the polygon edge as inside. */
export function pointInOrOnPolygon(p: LatLon, polygon: LatLon[]): boolean {
  return pointInPolygon(p, polygon) || distancePointToPolygonMeters(p, polygon) <= 0.02;
}

/** Minimum distance between a line segment and a polygon, meters. */
export function distanceSegmentToPolygonMeters(a: LatLon, b: LatLon, polygon: LatLon[]): number {
  if (segmentEntersPolygon(a, b, polygon)) return 0;
  const origin = polygon[0];
  const pa = toLocal(a, origin);
  const pb = toLocal(b, origin);
  const ring = polygon.map((v) => toLocal(v, origin));
  let best = Infinity;
  const distancePointToSegment = (p: XY, s1: XY, s2: XY): number => {
    const nearest = nearestPointOnSegmentXY(p, s1, s2);
    return Math.hypot(p.x - nearest.x, p.y - nearest.y);
  };
  for (let i = 0; i < ring.length; i++) {
    const e1 = ring[i];
    const e2 = ring[(i + 1) % ring.length];
    best = Math.min(
      best,
      distancePointToSegment(pa, e1, e2),
      distancePointToSegment(pb, e1, e2),
      distancePointToSegment(e1, pa, pb),
      distancePointToSegment(e2, pa, pb),
    );
  }
  return best;
}

/** Perpendicular distance from a point to a line SEGMENT, meters. */
export function distancePointToSegmentMeters(point: LatLon, a: LatLon, b: LatLon): number {
  const latScale = 111_320;
  const lonScale = latScale * Math.cos(a.lat * Math.PI / 180);
  const bx = (b.lon - a.lon) * lonScale;
  const by = (b.lat - a.lat) * latScale;
  const px = (point.lon - a.lon) * lonScale;
  const py = (point.lat - a.lat) * latScale;
  const denom = bx * bx + by * by;
  const t = denom === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / denom));
  return Math.hypot(px - t * bx, py - t * by);
}

/** Minimum distance between two line SEGMENTS, meters. */
export function distanceSegmentToSegmentMeters(a1: LatLon, a2: LatLon, b1: LatLon, b2: LatLon): number {
  return Math.min(
    distancePointToSegmentMeters(a1, b1, b2),
    distancePointToSegmentMeters(a2, b1, b2),
    distancePointToSegmentMeters(b1, a1, a2),
    distancePointToSegmentMeters(b2, a1, a2),
  );
}

/** Closest point on the polygon's boundary (including the closing edge). */
export function nearestPointOnPolygonBoundary(p: LatLon, polygon: LatLon[]): LatLon {
  const origin = polygon[0];
  const pt = toLocal(p, origin);
  const ring = polygon.map((v) => toLocal(v, origin));
  let best: XY = ring[0];
  let bestD2 = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const cand = nearestPointOnSegmentXY(pt, ring[i], ring[(i + 1) % ring.length]);
    const dx = cand.x - pt.x;
    const dy = cand.y - pt.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = cand;
    }
  }
  return fromLocal(best, origin);
}

/**
 * Move `p` to the nearest polygon-boundary point and then continue `marginM`
 * meters FURTHER along the same direction (p → boundary → beyond).
 *
 *  - p INSIDE the polygon  → result is OUTSIDE it by ~marginM (NFZ push-out).
 *  - p OUTSIDE the polygon → result is INSIDE it by ~marginM (perimeter pull-in).
 *
 * Degenerate case (p exactly on the boundary / zero distance): the direction
 * is taken from the polygon's vertex centroid through p instead, which points
 * outward for convex polygons. This is best-effort for pathological input.
 */
export function movePointAcrossBoundary(p: LatLon, polygon: LatLon[], marginM: number): LatLon {
  const origin = polygon[0];
  const pt = toLocal(p, origin);
  const boundary = toLocal(nearestPointOnPolygonBoundary(p, polygon), origin);
  let dx = boundary.x - pt.x;
  let dy = boundary.y - pt.y;
  let len = Math.hypot(dx, dy);
  if (len < 1e-9) {
    // p is on the boundary: fall back to centroid→p direction.
    const ring = polygon.map((v) => toLocal(v, origin));
    const cx = ring.reduce((s, v) => s + v.x, 0) / ring.length;
    const cy = ring.reduce((s, v) => s + v.y, 0) / ring.length;
    dx = pt.x - cx;
    dy = pt.y - cy;
    len = Math.hypot(dx, dy);
    if (len < 1e-9) {
      dx = 1; dy = 0; len = 1; // fully degenerate: arbitrary but deterministic east
    }
  }
  const scale = marginM / len;
  return fromLocal({ x: boundary.x + dx * scale, y: boundary.y + dy * scale }, origin);
}

/** Move a point to a requested clearance OUTSIDE a polygon boundary. */
export function movePointAwayFromPolygon(
  p: LatLon,
  polygon: LatLon[],
  clearanceM: number,
): LatLon {
  const origin = polygon[0];
  const pt = toLocal(p, origin);
  const boundary = toLocal(nearestPointOnPolygonBoundary(p, polygon), origin);
  const ring = polygon.map((v) => toLocal(v, origin));
  const cx = ring.reduce((sum, v) => sum + v.x, 0) / ring.length;
  const cy = ring.reduce((sum, v) => sum + v.y, 0) / ring.length;
  let dx: number;
  let dy: number;
  if (pointInPolygon(p, polygon)) {
    dx = boundary.x - pt.x;
    dy = boundary.y - pt.y;
  } else {
    dx = pt.x - boundary.x;
    dy = pt.y - boundary.y;
  }
  let length = Math.hypot(dx, dy);
  if (length < 1e-9) {
    dx = boundary.x - cx;
    dy = boundary.y - cy;
    length = Math.hypot(dx, dy);
  }
  if (length < 1e-9) {
    dx = 1;
    dy = 0;
    length = 1;
  }
  return fromLocal({
    x: boundary.x + dx / length * clearanceM,
    y: boundary.y + dy / length * clearanceM,
  }, origin);
}

/** Vertex centroid of a polygon (adequate for target placement, not area math). */
export function polygonCentroid(polygon: LatLon[]): LatLon {
  const lat = polygon.reduce((s, v) => s + v.lat, 0) / polygon.length;
  const lon = polygon.reduce((s, v) => s + v.lon, 0) / polygon.length;
  return { lat, lon };
}

/** Move an inside point away from its nearest boundary while staying inward. */
export function movePointInsidePolygon(p: LatLon, polygon: LatLon[], clearanceM: number): LatLon {
  const origin = polygon[0];
  const pt = toLocal(p, origin);
  const boundary = toLocal(nearestPointOnPolygonBoundary(p, polygon), origin);
  let dx = pt.x - boundary.x;
  let dy = pt.y - boundary.y;
  let length = Math.hypot(dx, dy);
  if (length < 1e-9) {
    const ring = polygon.map((v) => toLocal(v, origin));
    dx = ring.reduce((sum, v) => sum + v.x, 0) / ring.length - boundary.x;
    dy = ring.reduce((sum, v) => sum + v.y, 0) / ring.length - boundary.y;
    length = Math.hypot(dx, dy);
  }
  if (length < 1e-9) throw new Error('cannot derive inward direction for degenerate polygon');
  return fromLocal({ x: boundary.x + dx / length * clearanceM, y: boundary.y + dy / length * clearanceM }, origin);
}

/* ---------------------------------------------------------------------------
 * 3. Site geometry — buffered NFZs and geofence containment
 *
 * NFZ semantics (docs/SITE_CONTRACT.md, ADR D3): flight inside the polygon AT
 * OR BELOW `ceiling_m` AGL is forbidden; strictly-above overflight is allowed.
 * Every horizontal test is against the polygon buffered by `nfz_buffer_m`.
 *
 * The tolerance below (5 cm) is the same one the verifier has always used: it
 * absorbs 6-dp coordinate rounding so a plan that clears a buffer by exactly
 * the buffer distance is not failed by float noise.
 * ------------------------------------------------------------------------- */

/** Slack applied to buffer comparisons, metres (6-dp rounding noise). */
export const BUFFER_EPSILON_M = 0.05;

/** True when a zone constrains flight whose LOWEST altitude on a leg is `minAltM`. */
export function nfzAppliesAtAltitude(zone: SiteNfz, minAltM: number): boolean {
  return minAltM <= zone.ceilingM;
}

/** Horizontal clearance from a point to an NFZ polygon; 0 when inside it. */
export function pointNfzClearanceM(p: LatLon, zone: SiteNfz): number {
  return pointInPolygon(p, zone.polygon) ? 0 : distancePointToPolygonMeters(p, zone.polygon);
}

/** Horizontal clearance from a segment to an NFZ polygon; 0 when it enters. */
export function segmentNfzClearanceM(a: LatLon, b: LatLon, zone: SiteNfz): number {
  return distanceSegmentToPolygonMeters(a, b, zone.polygon);
}

/** The NFZs a leg at `minAltM` fails to clear by `nfz_buffer_m`. */
export function nfzTransitViolations(a: LatLon, b: LatLon, minAltM: number, site: SiteModel):
Array<{ zone: SiteNfz; clearanceM: number }> {
  return site.nfz.flatMap((zone) => {
    if (!nfzAppliesAtAltitude(zone, minAltM)) return [];
    const clearanceM = segmentNfzClearanceM(a, b, zone);
    return clearanceM < site.nfzBufferM - BUFFER_EPSILON_M ? [{ zone, clearanceM }] : [];
  });
}

/** True when a leg at `minAltM` clears every buffered NFZ. */
export function segmentClearsBufferedNfzs(a: LatLon, b: LatLon, minAltM: number, site: SiteModel): boolean {
  return nfzTransitViolations(a, b, minAltM, site).length === 0;
}

/** The NFZs an orbit at `altM` fails to clear by `nfz_buffer_m` + its radius. */
export function nfzOrbitViolations(center: LatLon, radiusM: number, altM: number, site: SiteModel):
Array<{ zone: SiteNfz; clearanceM: number }> {
  return site.nfz.flatMap((zone) => {
    if (!nfzAppliesAtAltitude(zone, altM)) return [];
    const clearanceM = pointNfzClearanceM(center, zone);
    return clearanceM < site.nfzBufferM + radiusM - BUFFER_EPSILON_M ? [{ zone, clearanceM }] : [];
  });
}

/** True when a whole orbit circumference clears every buffered NFZ. */
export function orbitClearsBufferedNfzs(center: LatLon, radiusM: number, altM: number, site: SiteModel): boolean {
  return nfzOrbitViolations(center, radiusM, altM, site).length === 0;
}

/** True when a point is inside the operational geofence (edge counts). */
export function pointInsideGeofence(p: LatLon, site: SiteModel): boolean {
  return pointInOrOnPolygon(p, site.geofence);
}

/** True when a point is inside the site perimeter (edge counts). */
export function pointInsidePerimeter(p: LatLon, site: SiteModel): boolean {
  return pointInOrOnPolygon(p, site.perimeter);
}

/** True when a complete leg stays inside the operational geofence. */
export function segmentInsideGeofence(a: LatLon, b: LatLon, site: SiteModel): boolean {
  return haversineMeters(a, b) === 0 ? pointInsideGeofence(a, site)
    : segmentStaysInsidePolygon(a, b, site.geofence);
}

/** True when a whole orbit circumference stays inside the geofence. */
export function orbitInsideGeofence(center: LatLon, radiusM: number, site: SiteModel): boolean {
  return pointInsideGeofence(center, site) &&
    distancePointToPolygonMeters(center, site.geofence) >= radiusM - BUFFER_EPSILON_M;
}

/** True when a leg passes through clutter below the LiDAR-degraded clear altitude. */
export function legNeedsLidar(a: LatLon, b: LatLon, minAltM: number, site: SiteModel): boolean {
  return site.clutter.some((area) =>
    distanceSegmentToPolygonMeters(a, b, area.polygon) === 0 && minAltM < site.clearAltitudeM);
}

/* ---------------------------------------------------------------------------
 * 4. Route search — via-points around a buffered NFZ
 *
 * Deterministic by construction (ADR D20): candidates are the zone's own
 * vertices pushed out to a clearance that leaves BOTH adjacent legs outside
 * the buffered polygon; they are ordered by total detour distance, and ties —
 * a symmetric obstacle produces them constantly — are broken by taking the
 * NORTHERNMOST candidate. Two runs of the same task therefore produce the same
 * plan byte-for-byte, which is what makes a plan hash a mission identity.
 * ------------------------------------------------------------------------- */

/** Detour ordering slack, metres: below this two detours are a tie. */
export const DETOUR_TIE_EPSILON_M = 1e-6;

/** One candidate detour point around a buffered NFZ. */
export interface ViaCandidate {
  point: LatLon;
  /** |from→via| + |via→to|, metres. */
  detourM: number;
}

/**
 * Candidate via-points that route `from → via → to` around `zone`, ordered by
 * lowest total detour then northernmost. Every candidate is inside the
 * geofence and clears every buffered NFZ on both of its legs.
 */
export function viaCandidates(from: LatLon, to: LatLon, zone: SiteNfz, site: SiteModel,
  clearanceM = site.nfzBufferM * 2 + 5, requireExitLeg = true): ViaCandidate[] {
  return zone.polygon
    .map((vertex) => movePointAwayFromPolygon(vertex, zone.polygon, clearanceM))
    .filter((point) => pointInOrOnPolygon(point, site.geofence))
    .filter((point) => site.nfz.every((other) =>
      distanceSegmentToPolygonMeters(from, point, other.polygon) >= site.nfzBufferM - BUFFER_EPSILON_M &&
      (!requireExitLeg ||
        distanceSegmentToPolygonMeters(point, to, other.polygon) >= site.nfzBufferM - BUFFER_EPSILON_M)))
    .map((point) => ({ point, detourM: haversineMeters(from, point) + haversineMeters(point, to) }))
    .sort((a, b) => {
      const delta = a.detourM - b.detourM;
      if (Math.abs(delta) > DETOUR_TIE_EPSILON_M) return delta;
      return b.point.lat - a.point.lat;   // tie-break: northernmost first
    });
}

/**
 * Shortest legal via-point for the first blocking NFZ on `from → to`, or null
 * when no candidate clears. `minAltM` is the LOWEST altitude flown on the leg:
 * a zone whose ceiling is below it does not constrain the route at all.
 */
export function findViaPoint(from: LatLon, to: LatLon, minAltM: number, site: SiteModel):
{ point: LatLon; zone: SiteNfz; detourM: number } | null {
  for (const zone of site.nfz) {
    if (!nfzAppliesAtAltitude(zone, minAltM)) continue;
    if (segmentNfzClearanceM(from, to, zone) >= site.nfzBufferM - BUFFER_EPSILON_M) continue;
    const clearance = site.nfzBufferM * 2 + 5;
    const entryOnly = viaCandidates(from, to, zone, site, clearance, false)
      .filter(({ point }) => segmentInsideGeofence(from, point, site));
    // Prefer a via that also clears the exit leg; otherwise take the shortest
    // one that clears the entry leg and let the caller route the remainder.
    const complete = entryOnly.filter(({ point }) =>
      segmentClearsBufferedNfzs(point, to, minAltM, site) && segmentInsideGeofence(point, to, site));
    const candidates = complete.length ? complete : entryOnly;
    if (!candidates.length) return null;
    return { point: candidates[0].point, zone, detourM: candidates[0].detourM };
  }
  return null;
}

/**
 * A complete route from `from` to `to` at `altM`: the straight leg when it is
 * legal, otherwise the shortest via-point detour, otherwise null (infeasible).
 * Returns the intermediate points only — `to` is never included.
 */
export function routeVias(from: LatLon, to: LatLon, minAltM: number, site: SiteModel,
  maxVias = 4): LatLon[] | null {
  const vias: LatLon[] = [];
  let cursor = from;
  for (let attempt = 0; attempt <= maxVias; attempt++) {
    const legal = segmentInsideGeofence(cursor, to, site) &&
      segmentClearsBufferedNfzs(cursor, to, minAltM, site);
    if (legal) return vias;
    const via = findViaPoint(cursor, to, minAltM, site);
    if (!via) return null;
    vias.push(via.point);
    cursor = via.point;
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * 5. Orbit geometry
 * ------------------------------------------------------------------------- */

/** Point on the observation ring facing `from`, so the approach never breaches standoff. */
export function orbitEntryPoint(center: LatLon, from: LatLon, radiusM: number): LatLon {
  const distance = haversineMeters(center, from);
  if (distance < 0.01) return translateMeters(center, 0, radiusM);
  const scale = radiusM / distance;
  return {
    lat: center.lat + (from.lat - center.lat) * scale,
    lon: center.lon + (from.lon - center.lon) * scale,
  };
}

/**
 * Shrink an orbit radius until the circumference clears every buffered NFZ and
 * stays inside the geofence — but NEVER below `floorM` (the standoff floor).
 * Returns null when clearing would require going below it: that is an
 * infeasible task, not a plan flown closer than standoff.
 */
export function shrinkOrbitRadius(center: LatLon, requestedM: number, altM: number,
  site: SiteModel, floorM: number): number | null {
  if (!pointInsideGeofence(center, site)) return null;
  const geofenceRoom = distancePointToPolygonMeters(center, site.geofence);
  const nfzRoom = site.nfz
    .filter((zone) => nfzAppliesAtAltitude(zone, altM))
    .map((zone) => pointNfzClearanceM(center, zone) - site.nfzBufferM);
  const room = Math.min(requestedM, geofenceRoom, ...nfzRoom);
  if (!Number.isFinite(room) || room < floorM) return null;
  // Round DOWN to 0.1 m so the emitted radius is stable and still clears.
  const radius = Math.max(floorM, Math.floor(room * 10) / 10);
  return radius >= floorM && orbitClearsBufferedNfzs(center, radius, altM, site) &&
    orbitInsideGeofence(center, radius, site) ? radius : null;
}

/* ---------------------------------------------------------------------------
 * 6. Mission model — the walk, the flight-time model and the budget
 * ------------------------------------------------------------------------- */

/** Climb/descent rate used for conservative flight-time estimates, m/s. */
export const CONSERVATIVE_VERTICAL_SPEED_MPS = 2;
/** Seconds allowed for the descent-and-land tail of an `rtl`. */
export const RTL_LANDING_ALLOWANCE_S = 15;
/** Flight seconds charged to a hold with no declared duration. */
export const INDEFINITE_HOLD_S = 30;

/** Effective per-profile limits: policy tightened by companion capabilities. */
export interface ProfileLimits {
  maxSpeedMps: number;
  maxAltitudeM: number;
  standoffM: number;
  maxSortieS: number;
}

/** Profile policy, tightened (never relaxed) by reported vehicle capabilities. */
export function policyFor(profile: MissionProfile, capabilities?: CapabilityProfile[]): ProfileLimits {
  const base = PROFILE_POLICY[profile];
  const effective = capabilities?.find((entry) => entry.profile === profile);
  return effective ? {
    maxSpeedMps: Math.min(base.maxSpeedMps, effective.max_speed_mps),
    maxAltitudeM: Math.min(base.maxAltitudeM, effective.max_altitude_m),
    standoffM: Math.max(base.standoffM, effective.min_standoff_m),
    maxSortieS: base.maxSortieS,
  } : base;
}

/** The profile that governs one tool: its own override, else the plan's. */
export function profileForTool(tool: PlanTool, plan: MissionPlan): MissionProfile {
  if (tool.tool === 'goto_gps' && tool.profile) return tool.profile;
  if (tool.tool === 'follow' || tool.tool === 'orbit') return tool.profile;
  return plan.profile;
}

export interface WalkTarget {
  toolIndex: number;
  kind: 'goto_gps' | 'goto_relative' | 'orbit_point';
  pos: LatLon;
  altM: number;
  radiusM?: number;
}

export interface WalkLeg {
  toolIndex: number;
  from: LatLon;
  to: LatLon;
  fromAltM: number;
  toAltM: number;
  minAltM: number;
  maxAltM: number;
  lengthM: number;
  speedMps: number;
}

export interface Walk {
  targets: WalkTarget[];
  legs: WalkLeg[];
  totalPathM: number;
  totalFlightS: number;
}

export interface WalkOptions {
  /** Where the vehicle is when the plan starts (defaults to home). */
  start?: LatLon;
  /** Current altitude AGL, or null when unknown (the site band floor is assumed). */
  startAltM?: number | null;
  capabilities?: CapabilityProfile[];
}

/**
 * Walk a plan into targets, legs, path length and flight seconds. This is the
 * single source of mission geometry: the verifier checks these legs and the
 * planner sizes its budget from this walk.
 */
export function walkPlan(plan: MissionPlan, site: SiteModel, options: WalkOptions = {}): Walk {
  const targets: WalkTarget[] = [];
  const legs: WalkLeg[] = [];
  let totalPathM = 0;
  let totalFlightS = 0;
  const home = { lat: site.home.lat, lon: site.home.lon };
  let current = options.start ?? home;
  let currentAlt = options.startAltM ?? null;
  const addLeg = (toolIndex: number, to: LatLon, altitudeM: number, speedMps: number) => {
    const lengthM = haversineMeters(current, to);
    const fromAltM = currentAlt ?? site.altBandM.min;
    const maxAltM = Math.max(fromAltM, altitudeM);
    const minAltM = Math.min(fromAltM, altitudeM);
    legs.push({ toolIndex, from: current, to, fromAltM, toAltM: altitudeM, minAltM, maxAltM, lengthM, speedMps });
    totalPathM += lengthM;
    totalFlightS += speedMps > 0 ? lengthM / speedMps : Infinity;
    totalFlightS += Math.abs(altitudeM - fromAltM) / CONSERVATIVE_VERTICAL_SPEED_MPS;
    current = to;
    currentAlt = altitudeM;
  };
  plan.tools.forEach((tool, index) => {
    const profile = profileForTool(tool, plan);
    const speed = Math.min(PROFILE_SPEED_MPS[profile], policyFor(profile, options.capabilities).maxSpeedMps);
    switch (tool.tool) {
      case 'goto_gps': {
        const to = { lat: tool.lat, lon: tool.lon };
        addLeg(index, to, tool.alt, tool.speed_mps ?? speed);
        targets.push({ toolIndex: index, kind: 'goto_gps', pos: to, altM: tool.alt });
        break;
      }
      case 'goto_relative': {
        const to = translateMeters(current, tool.dx, tool.dy);
        const altitude = (currentAlt ?? site.altBandM.min) + tool.dz;
        addLeg(index, to, altitude, speed);
        targets.push({ toolIndex: index, kind: 'goto_relative', pos: to, altM: altitude });
        break;
      }
      case 'orbit_point': {
        const altitude = currentAlt ?? site.altBandM.min;
        const center = { lat: tool.lat, lon: tool.lon };
        const entry = orbitEntryPoint(center, current, tool.radius);
        addLeg(index, entry, altitude, speed);
        const orbitLength = 2 * Math.PI * tool.radius * (tool.laps ?? 1);
        totalPathM += orbitLength;
        totalFlightS += speed > 0 ? orbitLength / speed : Infinity;
        targets.push({ toolIndex: index, kind: 'orbit_point', pos: center, altM: altitude, radiusM: tool.radius });
        break;
      }
      case 'hold': totalFlightS += tool.durationS ?? INDEFINITE_HOLD_S; break;
      case 'follow': totalFlightS += INDEFINITE_HOLD_S; break;
      case 'orbit': totalFlightS += 2 * Math.PI * policyFor(profile, options.capabilities).standoffM / speed; break;
      case 'rtl': {
        const altitude = currentAlt ?? site.altBandM.min;
        addLeg(index, home, altitude, speed);
        totalFlightS += altitude / CONSERVATIVE_VERTICAL_SPEED_MPS + RTL_LANDING_ALLOWANCE_S;
        currentAlt = null;
        break;
      }
    }
  });
  return { targets, legs, totalPathM, totalFlightS };
}

/** Flight seconds inflated for wind: `t × (1 + 0.05 × wind)` (ADR D16). */
export function windAdjustedSeconds(flightS: number, windMps = 0): number {
  return flightS * (1 + VERIFIER_POLICY.windTimeFactorPerMps * windMps);
}

/**
 * Flight seconds available from the live pack, honouring the 25 % reserve.
 * `remainingS` (the vehicle's own estimate) tightens the model, never relaxes it.
 */
export function rangeAvailableSeconds(socPct: number, remainingS?: number): number {
  if (!Number.isFinite(socPct)) return 0;
  const usable = Math.max(0, (socPct - VERIFIER_POLICY.reservePct) / 100);
  const modelAvailable = VERIFIER_POLICY.nominalEnduranceS * usable;
  const liveAvailable = Number.isFinite(remainingS as number)
    ? (remainingS as number) * Math.max(0, (socPct - VERIFIER_POLICY.reservePct) / Math.max(socPct, 1))
    : Infinity;
  return Math.min(modelAvailable, liveAvailable);
}

/** The planner's time budget: `min(range time, sortie cap)` (ADR D16/D20). */
export function timeBudgetSeconds(input: {
  socPct: number; remainingS?: number; maxSortieS?: number;
  profile?: MissionProfile; capabilities?: CapabilityProfile[];
}): number {
  const profileCap = input.profile
    ? policyFor(input.profile, input.capabilities).maxSortieS : Infinity;
  return Math.min(
    rangeAvailableSeconds(input.socPct, input.remainingS),
    VERIFIER_POLICY.maxSortieS,
    profileCap,
    input.maxSortieS ?? Infinity,
  );
}

/* ---------------------------------------------------------------------------
 * 7. Separation — corridor-to-corridor geometry (ADR D21)
 *
 * The corridor, not the waypoint list, is what separation is measured between:
 * a leg is a swept segment, an orbit is a ring, and a peer with no published
 * corridor is a single point. Shared by the verifier's `deconfliction` check
 * and the planner's altitude choice, so a plan is drawn already separated.
 * ------------------------------------------------------------------------- */

export interface CorridorGeometry {
  /** Discrete positions (a peer's live position, say). */
  points: LatLon[];
  legs: Array<{ from: LatLon; to: LatLon }>;
  orbits: Array<{ center: LatLon; radiusM: number }>;
  /** Metres AGL; null when the altitude is unknown (never treated as clear). */
  altBandM: { min: number; max: number } | null;
}

/** The corridor geometry a walked plan occupies. */
export function corridorGeometryFromWalk(walk: Walk): CorridorGeometry {
  const altitudes = [
    ...walk.targets.map((target) => target.altM),
    ...walk.legs.flatMap((leg) => [leg.minAltM, leg.maxAltM]),
  ].filter((value) => Number.isFinite(value));
  return {
    points: [],
    legs: walk.legs.filter((leg) => leg.lengthM > 0).map((leg) => ({ from: leg.from, to: leg.to })),
    orbits: walk.targets.filter((target) => target.kind === 'orbit_point')
      .map((target) => ({ center: target.pos, radiusM: target.radiusM ?? 0 })),
    altBandM: altitudes.length ? { min: Math.min(...altitudes), max: Math.max(...altitudes) } : null,
  };
}

function ringToPointM(ring: { center: LatLon; radiusM: number }, point: LatLon): number {
  return Math.abs(haversineMeters(ring.center, point) - ring.radiusM);
}
function ringToRingM(a: { center: LatLon; radiusM: number }, b: { center: LatLon; radiusM: number }): number {
  const d = haversineMeters(a.center, b.center);
  if (d >= a.radiusM + b.radiusM) return d - (a.radiusM + b.radiusM);
  const inner = Math.max(a.radiusM, b.radiusM) - (d + Math.min(a.radiusM, b.radiusM));
  return inner > 0 ? inner : 0;
}
function ringToSegmentM(ring: { center: LatLon; radiusM: number }, from: LatLon, to: LatLon): number {
  return Math.max(0, distancePointToSegmentMeters(ring.center, from, to) - ring.radiusM);
}

/** Minimum lateral distance between two corridors, metres (Infinity when disjoint data). */
export function lateralSeparationM(ours: CorridorGeometry, peer: CorridorGeometry): number {
  const distances: number[] = [];
  const pairPointWith = (point: LatLon) => {
    ours.legs.forEach((leg) => distances.push(distancePointToSegmentMeters(point, leg.from, leg.to)));
    ours.orbits.forEach((orbit) => distances.push(ringToPointM(orbit, point)));
    if (!ours.legs.length && !ours.orbits.length) {
      ours.points.forEach((ourPoint) => distances.push(haversineMeters(ourPoint, point)));
    }
  };
  peer.points.forEach(pairPointWith);
  peer.legs.forEach((peerLeg) => {
    ours.legs.forEach((leg) => distances.push(
      distanceSegmentToSegmentMeters(leg.from, leg.to, peerLeg.from, peerLeg.to)));
    ours.orbits.forEach((orbit) => distances.push(ringToSegmentM(orbit, peerLeg.from, peerLeg.to)));
    ours.points.forEach((point) => distances.push(distancePointToSegmentMeters(point, peerLeg.from, peerLeg.to)));
  });
  peer.orbits.forEach((peerOrbit) => {
    ours.legs.forEach((leg) => distances.push(ringToSegmentM(peerOrbit, leg.from, leg.to)));
    ours.orbits.forEach((orbit) => distances.push(ringToRingM(orbit, peerOrbit)));
    ours.points.forEach((point) => distances.push(ringToPointM(peerOrbit, point)));
  });
  return distances.length ? Math.min(...distances) : Infinity;
}

/** Vertical gap between two altitude bands, metres; 0 when either is unknown. */
export function verticalSeparationM(ours: { min: number; max: number } | null,
  peer: { min: number; max: number } | null): number {
  if (!ours || !peer) return 0;
  return Math.max(0, ours.min - peer.max, peer.min - ours.max);
}

/**
 * The budget trim, in the verifier's order: drop holds first, then trim orbits
 * to a single lap. Nothing here ever shortens a route or lowers an altitude —
 * a mission that still does not fit is infeasible, not squeezed.
 */
export function trimToBudget(tools: PlanTool[]): { tools: PlanTool[]; notes: string[] } {
  const notes: string[] = [];
  const trimmed = tools.flatMap((tool, index): PlanTool[] => {
    if (tool.tool === 'hold') {
      notes.push(`dropped hold tool ${index} to fit budget`);
      return [];
    }
    if (tool.tool === 'orbit_point' && (tool.laps ?? 1) > 1) {
      notes.push(`trimmed orbit tool ${index} to one lap`);
      return [{ ...tool, laps: 1 }];
    }
    return [tool];
  });
  return { tools: trimmed, notes };
}
