/* The sentinel2 / sar rails WRAP ground/satellite. This test pins both halves:
 * the local SatelliteModule interface against the real module's types (a
 * compile-time check under `npm run typecheck`), and the runtime bridge against
 * the real detector (offline, baked data). */

import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type * as RealSatellite from '../../satellite/src/node/index.ts';
import type { SatelliteModule } from '../src/node/satellite.js';
import {
  clearSatelliteCache, defaultSarDataDir, loadSatelliteModule, sarSource,
  satelliteEntryCandidates, sentinel2Source,
} from '../src/node/satellite.js';
import { SarRail, Sentinel2Rail } from '../src/index.js';
import { ManualScheduler } from '../src/scheduler.js';
import type { AnomalyMessage } from '../src/contract.js';

// Compile-time: the real module satisfies the slice the bridge calls. This
// line fails `tsc --noEmit` if ground/satellite changes those signatures.
const _realSatisfiesBridge: SatelliteModule = {} as typeof RealSatellite;

/** platform/ repo root, four levels above test/. */
const REPO_ROOT = new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

describe('ground/satellite bridge', () => {
  it('pins the module slice the rails call', () => {
    expect(_realSatisfiesBridge).toBeDefined();
  });

  it('lists a resolution order that prefers the built package over sources', () => {
    const candidates = satelliteEntryCandidates({ EIS_SATELLITE_ENTRY: '' } as NodeJS.ProcessEnv);
    expect(candidates.some((c) => c.includes('dist'))).toBe(true);
    expect(candidates.some((c) => c.endsWith('.ts'))).toBe(true);
    expect(candidates.findIndex((c) => c.includes('dist')))
      .toBeLessThan(candidates.findIndex((c) => c.endsWith('.ts')));
  });

  it('honours an explicit EIS_SATELLITE_ENTRY override first', () => {
    const candidates = satelliteEntryCandidates(
      { EIS_SATELLITE_ENTRY: '/tmp/custom-satellite.js' } as NodeJS.ProcessEnv,
    );
    expect(candidates[0]).toBe('/tmp/custom-satellite.js');
  });

  it('resolves and runs the real optical detector, offline', async () => {
    clearSatelliteCache();
    const mod = await loadSatelliteModule();
    const anomalies = mod.getAnomalies();
    expect(anomalies.length).toBeGreaterThan(0);
    expect(anomalies[0].source).toBe('sentinel2');
  });

  it('feeds the real detector through the sentinel2 rail', async () => {
    const scheduler = new ManualScheduler(Date.UTC(2024, 0, 10, 22, 0, 0));
    const rail = new Sentinel2Rail({ scheduler, source: sentinel2Source() });
    const seen: AnomalyMessage[] = [];
    rail.onAnomaly((m) => seen.push(m));
    await rail.start();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].anomaly.source).toBe('sentinel2');
    expect(seen[0].anomaly.ttl_s).toBe(86_400);
    expect(rail.health().state).toBe('healthy');
  });

  it('feeds the real SAR detector through the sar rail', async () => {
    const dataDir = defaultSarDataDir(REPO_ROOT);
    if (!existsSync(dataDir)) return; // baked SAR chips are optional
    const scheduler = new ManualScheduler(Date.UTC(2024, 0, 10, 22, 0, 0));
    const rail = new SarRail({ scheduler, source: sarSource({ dataDir }) });
    const seen: AnomalyMessage[] = [];
    rail.onAnomaly((m) => seen.push(m));
    await rail.start();
    expect(seen).toHaveLength(1);
    expect(seen[0].anomaly.source).toBe('sar');
    expect(seen[0].anomaly.type).toBe('sar_log_ratio_change');
  });
});
