/* ============================================================================
 * eis-satellite — Node-only mode selection + baked-data access.
 *
 * EIS_SAT_MODE:
 *   'baked' (default) — anomalies come from the checked-in synthetic tiles in
 *                       ground/satellite/data/ (fully offline; nothing on this
 *                       path touches the network). anomalies.json (pre-baked
 *                       by scripts/make-tiles.mjs, which derives every
 *                       coordinate from the EIS_SITE_FILE site model) is used
 *                       when present; otherwise the detector runs on the
 *                       checked-in PNGs at call time.
 *   'live'            — run the detection core on caller-provided PNG bytes
 *                       (still offline; "live" means live INPUT, not network).
 *
 * Browser callers never import this module — they import data/anomalies.json
 * / data/tiles.json directly (or fetch them) and use the core from '../index'.
 * ========================================================================== */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Anomaly, DetectOptions, DetectResult, GeoRefTiles } from '../types.js';
import { validateGeoRef } from '../georef.js';
import { detectAnomalies } from '../detect.js';
import { decodePng } from './png.js';

export type SatMode = 'baked' | 'live';

/** Resolve the satellite mode from the environment; anything but 'live' is 'baked'. */
export function resolveSatMode(env: Record<string, string | undefined> = process.env): SatMode {
  return env.EIS_SAT_MODE === 'live' ? 'live' : 'baked';
}

/** Absolute path of ground/satellite/data (works from src/ under vitest and
 *  from dist/ after build — both sit two levels above data/'s parent). */
export function defaultDataDir(): string {
  return fileURLToPath(new URL('../../data/', import.meta.url));
}

export function loadTilesMeta(dataDir: string = defaultDataDir()): GeoRefTiles {
  const raw = JSON.parse(readFileSync(join(dataDir, 'tiles.json'), 'utf8')) as GeoRefTiles;
  return validateGeoRef(raw);
}

/** Decode a checked-in tile PNG. name: 'before' | 'after'. */
export function loadTileRgba(
  name: 'before' | 'after',
  dataDir: string = defaultDataDir(),
): { rgba: Uint8Array; width: number; height: number } {
  return decodePng(new Uint8Array(readFileSync(join(dataDir, `${name}.png`))));
}

/** Run the full detection core on the checked-in baked tiles (offline). */
export function computeBakedResult(
  dataDir: string = defaultDataDir(),
  opts?: DetectOptions,
): DetectResult {
  const georef = loadTilesMeta(dataDir);
  const before = loadTileRgba('before', dataDir);
  const after = loadTileRgba('after', dataDir);
  return detectAnomalies(before.rgba, after.rgba, after.width, after.height, georef, opts);
}

/** Baked anomalies: pre-baked data/anomalies.json when present, else computed
 *  from the checked-in tiles at call time. Either way: offline, site-derived. */
export function loadBakedAnomalies(dataDir: string = defaultDataDir()): Anomaly[] {
  const jsonPath = join(dataDir, 'anomalies.json');
  if (existsSync(jsonPath)) {
    const parsed: unknown = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed as { anomalies?: unknown }).anomalies;
    if (Array.isArray(list)) return list as Anomaly[];
    throw new Error(`eis-satellite: ${jsonPath} is neither Anomaly[] nor {anomalies: Anomaly[]}`);
  }
  return computeBakedResult(dataDir).anomalies;
}

/** Run detection on caller-provided PNG bytes ('live' mode input). Georef
 *  defaults to the baked tiles.json when the tiles cover the same footprint. */
export function detectFromPngBytes(
  beforePng: Uint8Array,
  afterPng: Uint8Array,
  georef?: GeoRefTiles,
  opts?: DetectOptions,
): DetectResult {
  const before = decodePng(beforePng);
  const after = decodePng(afterPng);
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(
      `eis-satellite: before (${before.width}x${before.height}) and after ` +
      `(${after.width}x${after.height}) tiles differ in size`,
    );
  }
  const g = georef ?? loadTilesMeta();
  return detectAnomalies(before.rgba, after.rgba, after.width, after.height, g, opts);
}

export interface GetAnomaliesOptions {
  /** Override EIS_SAT_MODE. */
  mode?: SatMode;
  /** Override the baked data directory (default ground/satellite/data). */
  dataDir?: string;
  /** live mode: raw PNG bytes of the two tiles. REQUIRED for 'live'. */
  beforePng?: Uint8Array;
  afterPng?: Uint8Array;
  /** live mode: georef for the provided tiles (default: baked tiles.json). */
  georef?: GeoRefTiles;
  detect?: DetectOptions;
}

let bakedCache: Anomaly[] | null = null;
let bakedCacheDir: string | null = null;

/** THE entry point for the demo/e2e path. Synchronous, never touches the
 *  network. Default mode is 'baked' per EIS_SAT_MODE. */
export function getAnomalies(opts: GetAnomaliesOptions = {}): Anomaly[] {
  const mode = opts.mode ?? resolveSatMode();
  if (mode === 'baked') {
    const dir = opts.dataDir ?? defaultDataDir();
    if (bakedCache && bakedCacheDir === dir) return bakedCache;
    bakedCache = loadBakedAnomalies(dir);
    bakedCacheDir = dir;
    return bakedCache;
  }
  if (!opts.beforePng || !opts.afterPng) {
    throw new Error(
      "eis-satellite: EIS_SAT_MODE=live requires tile bytes — pass { beforePng, afterPng } " +
      '(and optionally { georef }) to getAnomalies(), or use detectFromPngBytes().',
    );
  }
  return detectFromPngBytes(opts.beforePng, opts.afterPng, opts.georef, opts.detect).anomalies;
}

/** Test/reset hook. */
export function clearBakedCache(): void {
  bakedCache = null;
  bakedCacheDir = null;
}
