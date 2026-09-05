/* ============================================================================
 * eis-planner/site — site-model loading and validation.
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
 * The GEOMETRY that reads this model lives in `geometry.ts` — one library used
 * by both the deterministic planner and the verifier. The helpers this module
 * has always exported are re-exported below so existing importers (the UI, the
 * Electron hosts, the tests) keep working unchanged.
 * ========================================================================== */

import * as fs from 'fs';
import * as path from 'path';

import { LatLon, pointInOrOnPolygon } from './geometry';

export {
  EARTH_RADIUS_M,
  M_PER_DEG_LAT,
  distancePointToPolygonMeters,
  distanceSegmentToPolygonMeters,
  haversineMeters,
  movePointAcrossBoundary,
  movePointAwayFromPolygon,
  movePointInsidePolygon,
  nearestPointOnPolygonBoundary,
  pointInOrOnPolygon,
  pointInPolygon,
  polygonCentroid,
  segmentEntersPolygon,
  segmentIntersectsPolygon,
  segmentStaysInsidePolygon,
} from './geometry';
export type { LatLon, XY } from './geometry';

/* ---------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------- */

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
  /** Repo-root-relative paired thermal still. */
  thermalImage: string;
  /** Provenance label such as scripted_placeholder. */
  imageKind: string;
  requiredSensors: Array<'rgb' | 'thermal' | 'lidar'>;
  truth: 'vehicle' | 'breach' | 'structure' | 'false_alarm';
}

export interface SiteClutter {
  name: string;
  polygon: LatLon[];
}

export interface SiteModel {
  home: { lat: number; lon: number; altM: number };
  /** Outer geofence — open ring, any winding. */
  perimeter: LatLon[];
  /** Operational containment polygon uploaded to ArduPilot. */
  geofence: LatLon[];
  /** Horizontal clearance applied around every NFZ, meters. */
  nfzBufferM: number;
  nfz: SiteNfz[];
  /** Permitted flight band, meters AGL relative to home. */
  altBandM: { min: number; max: number };
  /** Minimum safe altitude after LiDAR degradation, meters AGL. */
  clearAltitudeM: number;
  clutter: SiteClutter[];
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
  const geofence = parseRing(d.geofence, 'geofence');
  if (!isFiniteNumber(d.nfz_buffer_m) || d.nfz_buffer_m < 0) {
    throw new Error('invalid site JSON: nfz_buffer_m must be a finite number >= 0');
  }

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
  if (!isFiniteNumber(d.clear_altitude_m) ||
      d.clear_altitude_m < (band.min as number) || d.clear_altitude_m > (band.max as number)) {
    throw new Error(
      `invalid site JSON: clear_altitude_m must be inside alt_band_m ` +
      `[${band.min}, ${band.max}]`,
    );
  }

  const clutterRaw = d.clutter;
  if (!Array.isArray(clutterRaw)) {
    throw new Error('invalid site JSON: "clutter" must be an array (may be empty)');
  }
  const clutter: SiteClutter[] = clutterRaw.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`invalid site JSON: clutter[${i}] must be an object`);
    }
    const cc = entry as Record<string, unknown>;
    if (typeof cc.name !== 'string' || cc.name.length === 0) {
      throw new Error(`invalid site JSON: clutter[${i}].name must be a non-empty string`);
    }
    return { name: cc.name, polygon: parseRing(cc.polygon, `clutter[${i}].polygon`) };
  });

  const stagingRaw = d.staging;
  if (!Array.isArray(stagingRaw)) {
    throw new Error('invalid site JSON: "staging" must be an array (may be empty)');
  }
  const stagingIds = new Set<string>();
  const staging: SiteStagingPoint[] = stagingRaw.map((s, i) => {
    const ss = s as Record<string, unknown>;
    if (typeof ss !== 'object' || ss === null || typeof ss.id !== 'string' ||
        typeof ss.image !== 'string' || typeof ss.thermal_image !== 'string' ||
        typeof ss.image_kind !== 'string' || typeof ss.truth !== 'string' ||
        !TRUTH_VALUES.has(ss.truth)) {
      throw new Error(
        `invalid site JSON: staging[${i}] must have string id/image/thermal_image/image_kind and truth in ` +
        `vehicle|breach|structure|false_alarm`,
      );
    }
    if (stagingIds.has(ss.id)) {
      throw new Error(`invalid site JSON: duplicate staging id ${JSON.stringify(ss.id)}`);
    }
    stagingIds.add(ss.id);
    if (!Array.isArray(ss.required_sensors) || ss.required_sensors.some(
      (sensor) => sensor !== 'rgb' && sensor !== 'thermal' && sensor !== 'lidar'
    )) {
      throw new Error(
        `invalid site JSON: staging[${i}].required_sensors must contain only rgb|thermal|lidar`,
      );
    }
    return {
      id: ss.id,
      lat: assertLat(ss.lat, `staging[${i}].lat`),
      lon: assertLon(ss.lon, `staging[${i}].lon`),
      image: ss.image,
      thermalImage: ss.thermal_image,
      imageKind: ss.image_kind,
      requiredSensors: [...ss.required_sensors] as SiteStagingPoint['requiredSensors'],
      truth: ss.truth as SiteStagingPoint['truth'],
    };
  });

  const geofenceEscapes = geofence.some((point) => !pointInOrOnPolygon(point, perimeter));
  if (geofenceEscapes) {
    throw new Error('invalid site JSON: geofence must be wholly inside or equal to perimeter');
  }

  return {
    home: { lat: homeLat, lon: homeLon, altM: home.alt_m as number },
    perimeter,
    geofence,
    nfzBufferM: d.nfz_buffer_m,
    nfz,
    altBandM: { min: band.min as number, max: band.max as number },
    clearAltitudeM: d.clear_altitude_m,
    clutter,
    staging,
  };
}
