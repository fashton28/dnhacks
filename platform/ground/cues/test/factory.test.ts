/* The Node factory: one call wires every rail for offline operation, selecting
 * the stub site EXPLICITLY the way docs/SITE_CONTRACT.md requires. */

import { describe, expect, it } from 'vitest';

import { ManualScheduler } from '../src/index.js';
import { createCueBus, resolveCctvMode } from '../src/node/index.js';
import { resolveSiteFile } from '../src/node/paths.js';
import { loadCueSiteFrom } from '../src/node/load.js';
import { QUIET_START_MS, STUB_SITE_PATH, record } from './helpers.js';

describe('createCueBus', () => {
  it('wires all seven rails from the shipped fixtures', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const bus = createCueBus({ scheduler, site: loadCueSiteFrom(STUB_SITE_PATH) });
    const seen = record(bus);
    await bus.start();
    scheduler.advance(120_000);

    expect(bus.health().map((h) => h.rail).sort()).toEqual(
      ['cctv', 'drone_survey', 'fence_sensor', 'rf_drone', 'sar', 'sdr', 'sentinel2'],
    );
    expect(new Set(seen.anomalies.map((m) => m.anomaly.source)).size).toBe(7);
    // Nothing exceeded the shared budget in a normal replay.
    expect(bus.budgetState().dropped).toBe(0);
    await bus.stop();
    expect(bus.health().every((h) => h.state === 'stopped')).toBe(true);
  });

  it('honours an explicit rail subset', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const bus = createCueBus({
      scheduler, site: loadCueSiteFrom(STUB_SITE_PATH), rails: ['cctv', 'sdr'],
    });
    expect(bus.health().map((h) => h.rail)).toEqual(['sdr', 'cctv']);
  });
});

describe('environment selection', () => {
  it('keeps event mode unless pixel mode is asked for explicitly', () => {
    expect(resolveCctvMode({} as NodeJS.ProcessEnv)).toBe('event');
    expect(resolveCctvMode({ EIS_CCTV_MODE: 'PIXEL' } as NodeJS.ProcessEnv)).toBe('event');
    expect(resolveCctvMode({ EIS_CCTV_MODE: 'pixel' } as NodeJS.ProcessEnv)).toBe('pixel');
  });

  it('defaults the site file to site/site.json and honours EIS_SITE_FILE', () => {
    expect(resolveSiteFile('/repo', {} as NodeJS.ProcessEnv).replace(/\\/g, '/'))
      .toMatch(/\/repo\/site\/site\.json$/);
    expect(resolveSiteFile('/repo', { EIS_SITE_FILE: 'site/site.stub.json' } as NodeJS.ProcessEnv)
      .replace(/\\/g, '/')).toMatch(/\/repo\/site\/site\.stub\.json$/);
  });
});
