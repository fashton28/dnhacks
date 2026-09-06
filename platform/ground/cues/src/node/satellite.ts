/* ============================================================================
 * eis-cues/node — the bridge onto ground/satellite.
 *
 * The satellite package is WRAPPED, not moved and not reimplemented: this file
 * resolves it at runtime and calls its real entry points (`getAnomalies` for
 * the optical change detector, `loadBakedSar` for the SAR log-ratio detector).
 *
 * It is resolved dynamically rather than imported statically for two reasons:
 * the cues build must not pull another package into its rootDir, and a missing
 * or unbuilt satellite package must degrade the rail to `failed` rather than
 * break the whole bus at import time. `test/satellite-bridge.test.ts` pins the
 * call shapes against the real module's types, so drift still fails typecheck.
 *
 * Resolution order (first hit wins):
 *   1. EIS_SATELLITE_ENTRY  — explicit override
 *   2. ../satellite/dist/node/index.js  — the built package
 *   3. ../satellite/src/node/index.ts   — the sources (vitest / ts runners)
 * ========================================================================== */

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import type { SatelliteAnomaly, SatelliteCueSource } from '../adapters/satellite.js';
import { packageDir } from './paths.js';

/** The slice of eis-satellite/node this bridge uses. */
export interface SatelliteModule {
  getAnomalies(opts?: { dataDir?: string }): SatelliteAnomaly[];
  loadBakedSar(dataDir: string): { anomalies: SatelliteAnomaly[]; provenance: { kind: string; claim: string } };
}

export function satelliteEntryCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const root = packageDir();
  const candidates: string[] = [];
  if (env.EIS_SATELLITE_ENTRY && env.EIS_SATELLITE_ENTRY.trim() !== '') {
    candidates.push(env.EIS_SATELLITE_ENTRY);
  }
  candidates.push(join(root, '..', 'satellite', 'dist', 'node', 'index.js'));
  candidates.push(join(root, '..', 'satellite', 'src', 'node', 'index.ts'));
  return candidates;
}

let cached: SatelliteModule | null = null;

/** Resolve and import eis-satellite/node. Throws with every path it tried. */
export async function loadSatelliteModule(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SatelliteModule> {
  if (cached) return cached;
  const tried = satelliteEntryCandidates(env);
  for (const candidate of tried) {
    if (!existsSync(candidate)) continue;
    const mod = (await import(pathToFileURL(candidate).href)) as unknown as SatelliteModule;
    if (typeof mod.getAnomalies !== 'function' || typeof mod.loadBakedSar !== 'function') {
      throw new Error(`eis-satellite at ${candidate} does not export getAnomalies/loadBakedSar`);
    }
    cached = mod;
    return mod;
  }
  throw new Error(
    `eis-satellite could not be resolved. Tried:\n  ${tried.join('\n  ')}\n` +
    'Build it (npm --prefix ground/satellite run build) or set EIS_SATELLITE_ENTRY.',
  );
}

/** Test/reset hook. */
export function clearSatelliteCache(): void {
  cached = null;
}

/** Optical change detection (baked Sentinel-2-style tiles), offline. */
export function sentinel2Source(
  options: { dataDir?: string; env?: NodeJS.ProcessEnv } = {},
): SatelliteCueSource {
  return {
    name: 'eis-satellite getAnomalies (baked Sentinel-2 tiles, offline)',
    async anomalies(): Promise<SatelliteAnomaly[]> {
      const mod = await loadSatelliteModule(options.env);
      return mod.getAnomalies(options.dataDir === undefined ? {} : { dataDir: options.dataDir });
    },
  };
}

/** Default SAR chip directory: platform/data/tiles/komati (repo-root relative). */
export function defaultSarDataDir(repoRoot: string = process.cwd()): string {
  return join(repoRoot, 'data', 'tiles', 'komati');
}

/** SAR log-ratio change detection over the baked chips, offline. */
export function sarSource(
  options: { dataDir?: string; env?: NodeJS.ProcessEnv; repoRoot?: string } = {},
): SatelliteCueSource {
  const dataDir = options.dataDir ?? defaultSarDataDir(options.repoRoot);
  return {
    name: `eis-satellite loadBakedSar (${dataDir})`,
    async anomalies(): Promise<SatelliteAnomaly[]> {
      const mod = await loadSatelliteModule(options.env);
      return mod.loadBakedSar(dataDir).anomalies;
    },
  };
}
