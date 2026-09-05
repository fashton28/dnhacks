/* ============================================================================
 * eis-planner/site — site-model loading, validation, and geometry helpers.
 *
 * The site model is consumed ONLY via the site JSON file described in
 * docs/SITE_CONTRACT.md. Nothing in this package hardcodes plant geometry —
 * every coordinate is derived from the loaded site data.
 *
 * Units and conventions (see docs/SITE_CONTRACT.md):
 *  - Coordinates are WGS84, ordered [lat, lon] in the JSON (lat first).
 *  - Polygons are OPEN rings (closing edge implicit); either winding is valid.
 *  - `alt_band_m` and NFZ `ceiling_m` are meters AGL relative to home.
 *  - `perimeter` is the outer geofence.
 *  - NFZ semantics: flight inside the polygon AT OR BELOW `ceiling_m` AGL is
 *    forbidden; overflight strictly above the ceiling is permitted.
 *
 * Geometry helpers all work on {lat, lon} degree pairs. Internally they use a
 * local equirectangular projection (meters east/north of a reference point) —
 * accurate to well under 0.1% at plant scale (< a few km), which is far inside
 * the safety margins used by the verifier.
 * ========================================================================== */

import * as fs from 'fs';
import * as path from 'path';

/* ---------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------- */

/** A WGS84 point in decimal degrees. */
export interface LatLon {
  lat: number;
  lon: number;
}

/** Wire form used by the site JSON: [lat, lon] (lat FIRST — never lon-first). */
export type LatLonPair = [number, number];

export interface SiteNfz {
  name: string;
  /** Open ring, any winding. */
  polygon: LatLon[];
  /** Forbidden at or below this altitude, meters AGL. */
  ceilingM: number;
}

export interface SiteStagingPoint {
  id: string;
  lat: number;
  lon: number;
  /** Repo-root-relative path to the still image. */
  image: string;
  truth: 'vehicle' | 'breach' | 'structure' | 'false_alarm';
}

export interface SiteModel {
  home: { lat: number; lon: number; altM: number };
  /** Outer geofence — open ring, any winding. */
  perimeter: LatLon[];
  nfz: SiteNfz[];
  /** Permitted flight band, meters AGL relative to home. */
  altBandM: { min: number; max: number };
  staging: SiteStagingPoint[];
}

/* ---------------------------------------------------------------------------
 * File selection + loading
 * ------------------------------------------------------------------------- */

/** Default site file, relative to the repo root (docs/SITE_CONTRACT.md). */
export const DEFAULT_SITE_FILE = 'site/site.json';

/**
 * Resolve the site JSON path: `EIS_SITE_FILE` env var (repo-root-relative or
 * absolute) falling back to `site/site.json`. `repoRoot` defaults to the
 * current working directory. Pure path math — does NOT check existence.
 */
export function resolveSiteFile(repoRoot: string = process.cwd()): string {
  const rel = process.env.EIS_SITE_FILE && process.env.EIS_SITE_FILE.trim() !== ''
    ? process.env.EIS_SITE_FILE
    : DEFAULT_SITE_FILE;
  return path.isAbsolute(rel) ? rel : path.resolve(repoRoot, rel);
}

/** Load + validate the site JSON at `filePath`. Throws on any invalid input. */
export function loadSite(filePath: string): SiteModel {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`site file not readable: ${filePath} (${(err as Error).message})`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`site file is not valid JSON: ${filePath} (${(err as Error).message})`);
  }
  return validateSite(data);
}

/** Convenience: load the EIS_SITE_FILE-selected site (default site/site.json). */
export function loadSiteFromEnv(repoRoot: string = process.cwd()): SiteModel {
  return loadSite(resolveSiteFile(repoRoot));
}

/* ---------------------------------------------------------------------------
 * Validation
 * ------------------------------------------------------------------------- */

const TRUTH_VALUES = new Set(['vehicle', 'breach', 'structure', 'false_alarm']);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function assertLat(v: unknown, ctx: string): number {
  if (!isFiniteNumber(v) || v < -90 || v > 90) {
    throw new Error(`invalid site JSON: ${ctx} must be a latitude in [-90, 90], got ${JSON.stringify(v)}`);
  }
  return v;
}

function assertLon(v: unknown, ctx: string): number {
  if (!isFiniteNumber(v) || v < -180 || v > 180) {
    throw new Error(`invalid site JSON: ${ctx} must be a longitude in [-180, 180], got ${JSON.stringify(v)}`);
  }
  return v;
}

function parseRing(v: unknown, ctx: string): LatLon[] {
  if (!Array.isArray(v) || v.length < 3) {
    throw new Error(`invalid site JSON: ${ctx} must be an array of >= 3 [lat, lon] pairs`);
  }
  return v.map((pair, i) => {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new Error(`invalid site JSON: ${ctx}[${i}] must be a [lat, lon] pair`);
    }
    return {
      lat: assertLat(pair[0], `${ctx}[${i}][0]`),
      lon: assertLon(pair[1], `${ctx}[${i}][1]`),
    };
  });
}

/**
 * Validate an already-parsed site object into a typed SiteModel.
 * Throws a descriptive Error on any schema/semantic violation.
 */
export function validateSite(data: unknown): SiteModel {
  if (typeof data !== 'object' || data === null) {
    throw new Error('invalid site JSON: root must be an object');
  }
  const d = data as Record<string, unknown>;

  const home = d.home as Record<string, unknown> | undefined;
  if (typeof home !== 'object' || home === null) {
    throw new Error('invalid site JSON: missing "home" object');
  }
  const homeLat = assertLat(home.lat, 'home.lat');
  const homeLon = assertLon(home.lon, 'home.lon');
  if (!isFiniteNumber(home.alt_m)) {
    throw new Error('invalid site JSON: home.alt_m must be a finite number (meters AMSL)');
  }

  const perimeter = parseRing(d.perimeter, 'perimeter');

  const nfzRaw = d.nfz;
  if (!Array.isArray(nfzRaw)) {
    throw new Error('invalid site JSON: "nfz" must be an array (may be empty)');
  }
  const nfz: SiteNfz[] = nfzRaw.map((z, i) => {
    const zz = z as Record<string, unknown>;
    if (typeof zz !== 'object' || zz === null || typeof zz.name !== 'string') {
      throw new Error(`invalid site JSON: nfz[${i}] must be an object with a string "name"`);
    }
    if (!isFiniteNumber(zz.ceiling_m) || (zz.ceiling_m as number) < 0) {
      throw new Error(`invalid site JSON: nfz[${i}].ceiling_m must be a number >= 0 (meters AGL)`);
    }
    return {
      name: zz.name,
      polygon: parseRing(zz.polygon, `nfz[${i}].polygon`),
      ceilingM: zz.ceiling_m as number,
    };
  });

  const band = d.alt_band_m as Record<string, unknown> | undefined;
  if (typeof band !== 'object' || band === null ||
      !isFiniteNumber(band.min) || !isFiniteNumber(band.max)) {
    throw new Error('invalid site JSON: "alt_band_m" must be { min, max } in meters AGL');
  }
  if ((band.min as number) < 0 || (band.min as number) >= (band.max as number)) {
    throw new Error(`invalid site JSON: alt_band_m requires 0 <= min < max, got min=${band.min} max=${band.max}`);
  }

  const stagingRaw = d.staging;
  if (!Array.isArray(stagingRaw)) {
    throw new Error('invalid site JSON: "staging" must be an array (may be empty)');
  }
  const staging: SiteStagingPoint[] = stagingRaw.map((s, i) => {
    const ss = s as Record<string, unknown>;
    if (typeof ss !== 'object' || ss === null || typeof ss.id !== 'string' ||
        typeof ss.image !== 'string' || typeof ss.truth !== 'string' ||
        !TRUTH_VALUES.has(ss.truth)) {
      throw new Error(
        `invalid site JSON: staging[${i}] must have string id/image and truth in ` +
        `vehicle|breach|structure|false_alarm`,
      );
    }
    return {
      id: ss.id,
      lat: assertLat(ss.lat, `staging[${i}].lat`),
      lon: assertLon(ss.lon, `staging[${i}].lon`),
      image: ss.image,
      truth: ss.truth as SiteStagingPoint['truth'],
    };
  });

  return {
    home: { lat: homeLat, lon: homeLon, altM: home.alt_m as number },
    perimeter,
    nfz,
    altBandM: { min: band.min as number, max: band.max as number },
    staging,
  };
}

/* ---------------------------------------------------------------------------
 * Geometry helpers
 *
 * All distances are METERS; all coordinates are DEGREES ({lat, lon}).
 * ------------------------------------------------------------------------- */

/** Mean earth radius, meters (WGS84 mean radius). */
export const EARTH_RADIUS_M = 6371000;

/** Meters per degree of latitude (near-constant over the globe). */
export const M_PER_DEG_LAT = 111320;

const DEG = Math.PI / 180;

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

interface XY { x: number; y: number; } // meters east (x) / north (y) of origin

/** Project a point to local meters (equirectangular, anchored at `origin`). */
function toLocal(p: LatLon, origin: LatLon): XY {
  return {
    x: (p.lon - origin.lon) * M_PER_DEG_LAT * Math.cos(origin.lat * DEG),
    y: (p.lat - origin.lat) * M_PER_DEG_LAT,
  };
}

/** Inverse of toLocal. */
function fromLocal(p: XY, origin: LatLon): LatLon {
  return {
    lat: origin.lat + p.y / M_PER_DEG_LAT,
    lon: origin.lon + p.x / (M_PER_DEG_LAT * Math.cos(origin.lat * DEG)),
  };
}

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

/** Vertex centroid of a polygon (adequate for target placement, not area math). */
export function polygonCentroid(polygon: LatLon[]): LatLon {
  const lat = polygon.reduce((s, v) => s + v.lat, 0) / polygon.length;
  const lon = polygon.reduce((s, v) => s + v.lon, 0) / polygon.length;
  return { lat, lon };
}
