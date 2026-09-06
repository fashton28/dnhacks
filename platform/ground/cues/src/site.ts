/* ============================================================================
 * eis-cues — the slice of the site model the cue rails need.
 *
 * Nothing here hardcodes plant geometry: every coordinate comes from the site
 * JSON selected by EIS_SITE_FILE (docs/SITE_CONTRACT.md). This parser is
 * deliberately PARTIAL — the rails need `geofence`, `perimeter` and `cameras`
 * and nothing else — and it is browser-safe: it takes already-parsed JSON.
 * `src/node/site.ts` adds the file selection.
 *
 * Camera geometry is NEVER a flight constraint (SITE_CONTRACT §"Camera
 * semantics"). It exists here for cue provenance and for projecting a pixel
 * observation onto the ground; no route, orbit or altitude is derived from it.
 * ========================================================================== */

import type { LatLon, LatLonPair } from './geo.js';

export interface CameraZone {
  name: string;
  /** Open ring, any winding. */
  polygon: LatLon[];
}

export interface SiteCamera {
  id: string;
  lat: number;
  lon: number;
  /** True bearing of the optical axis, 0 = north, clockwise, [0, 360). */
  headingDeg: number;
  /** Total horizontal field of view in degrees, (0, 360]. */
  fovDeg: number;
  /** Useful detection range along the axis, metres, > 0. */
  rangeM: number;
  /** Ground footprint of the cone; first vertex at the camera. */
  fovPolygon: LatLon[];
  zones: CameraZone[];
}

/** The site slice the cue rails consume. */
export interface CueSite {
  perimeter: LatLon[];
  /** Operational containment polygon. A pixel cue outside it is refused. */
  geofence: LatLon[];
  cameras: SiteCamera[];
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function assertLat(v: unknown, ctx: string): number {
  if (!isFiniteNumber(v) || v < -90 || v > 90) {
    throw new Error(`invalid site JSON: ${ctx} must be a latitude in [-90, 90]`);
  }
  return v;
}

function assertLon(v: unknown, ctx: string): number {
  if (!isFiniteNumber(v) || v < -180 || v > 180) {
    throw new Error(`invalid site JSON: ${ctx} must be a longitude in [-180, 180]`);
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
    const [lat, lon] = pair as LatLonPair;
    return { lat: assertLat(lat, `${ctx}[${i}][0]`), lon: assertLon(lon, `${ctx}[${i}][1]`) };
  });
}

function parseCamera(entry: unknown, i: number, seenIds: Set<string>): SiteCamera {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`invalid site JSON: cameras[${i}] must be an object`);
  }
  const c = entry as Record<string, unknown>;
  if (typeof c.id !== 'string' || c.id.length === 0) {
    throw new Error(`invalid site JSON: cameras[${i}].id must be a non-empty string`);
  }
  if (seenIds.has(c.id)) {
    throw new Error(`invalid site JSON: duplicate camera id ${JSON.stringify(c.id)}`);
  }
  seenIds.add(c.id);
  if (!isFiniteNumber(c.heading_deg) || c.heading_deg < 0 || c.heading_deg >= 360) {
    throw new Error(`invalid site JSON: cameras[${i}].heading_deg must be in [0, 360)`);
  }
  if (!isFiniteNumber(c.fov_deg) || c.fov_deg <= 0 || c.fov_deg > 360) {
    throw new Error(`invalid site JSON: cameras[${i}].fov_deg must be in (0, 360]`);
  }
  if (!isFiniteNumber(c.range_m) || c.range_m <= 0) {
    throw new Error(`invalid site JSON: cameras[${i}].range_m must be > 0`);
  }
  if (!Array.isArray(c.zones)) {
    throw new Error(`invalid site JSON: cameras[${i}].zones must be an array`);
  }
  const seenZones = new Set<string>();
  const zones: CameraZone[] = c.zones.map((z, zi) => {
    if (typeof z !== 'object' || z === null) {
      throw new Error(`invalid site JSON: cameras[${i}].zones[${zi}] must be an object`);
    }
    const zz = z as Record<string, unknown>;
    if (typeof zz.name !== 'string' || zz.name.length === 0) {
      throw new Error(`invalid site JSON: cameras[${i}].zones[${zi}].name must be a non-empty string`);
    }
    if (seenZones.has(zz.name)) {
      throw new Error(
        `invalid site JSON: duplicate zone ${JSON.stringify(zz.name)} on camera ${JSON.stringify(c.id)}`,
      );
    }
    seenZones.add(zz.name);
    return { name: zz.name, polygon: parseRing(zz.polygon, `cameras[${i}].zones[${zi}].polygon`) };
  });
  return {
    id: c.id,
    lat: assertLat(c.lat, `cameras[${i}].lat`),
    lon: assertLon(c.lon, `cameras[${i}].lon`),
    headingDeg: c.heading_deg,
    fovDeg: c.fov_deg,
    rangeM: c.range_m,
    fovPolygon: parseRing(c.fov_polygon, `cameras[${i}].fov_polygon`),
    zones,
  };
}

/**
 * Validate already-parsed site JSON into the cue-rail slice.
 * `cameras` is OPTIONAL per the site contract: an absent array is empty, and a
 * site with no cameras simply has no CCTV rail geometry.
 */
export function parseCueSite(data: unknown): CueSite {
  if (typeof data !== 'object' || data === null) {
    throw new Error('invalid site JSON: root must be an object');
  }
  const d = data as Record<string, unknown>;
  const perimeter = parseRing(d.perimeter, 'perimeter');
  const geofence = parseRing(d.geofence, 'geofence');
  const rawCameras = d.cameras;
  if (rawCameras !== undefined && !Array.isArray(rawCameras)) {
    throw new Error('invalid site JSON: "cameras" must be an array when present');
  }
  const seenIds = new Set<string>();
  const cameras = (rawCameras ?? []).map((c, i) => parseCamera(c, i, seenIds));
  return { perimeter, geofence, cameras };
}

export function findCamera(site: CueSite, cameraId: string): SiteCamera | undefined {
  return site.cameras.find((c) => c.id === cameraId);
}

export function findZone(camera: SiteCamera, zone: string): CameraZone | undefined {
  return camera.zones.find((z) => z.name === zone);
}
