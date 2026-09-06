/* Rate limiting and the shared cue budget.
 *
 * Order matters: a rail's own limit is charged first, and only what survives it
 * reaches the shared budget. The budget is a ceiling configuration can lower
 * and never raise — the same "may only tighten" rule the companion's safety
 * floors follow. */

import { describe, expect, it } from 'vitest';

import {
  CUE_BUDGET_CEILING, CctvRail, CueBus, ManualScheduler, RfDroneRail,
  SlidingWindowLimiter, resolveCueBudget, resolveRailRateLimit,
} from '../src/index.js';
import type { AnomalyMessage } from '../src/contract.js';
import type { CueRejection } from '../src/bus.js';
import { QUIET_START_MS, record, stubSite } from './helpers.js';

describe('sliding-window limiter', () => {
  it('admits up to the cap and then refuses until the window slides', () => {
    const limiter = new SlidingWindowLimiter({ maxEvents: 2, windowMs: 1_000 });
    expect(limiter.tryAdmit('a', 0)).toBe(true);
    expect(limiter.tryAdmit('a', 100)).toBe(true);
    expect(limiter.tryAdmit('a', 200)).toBe(false);
    // A different key has its own budget.
    expect(limiter.tryAdmit('b', 200)).toBe(true);
    // Past the window the earliest hits have aged out.
    expect(limiter.tryAdmit('a', 1_150)).toBe(true);
  });

  it('refuses a nonsensical limit rather than failing open', () => {
    expect(() => new SlidingWindowLimiter({ maxEvents: -1, windowMs: 1_000 })).toThrow();
    expect(() => new SlidingWindowLimiter({ maxEvents: 1, windowMs: 0 })).toThrow();
  });
});

describe('cue budget ceiling', () => {
  it('lets configuration tighten the budget', () => {
    expect(resolveCueBudget({ maxEvents: 3 }).maxEvents).toBe(3);
    expect(resolveCueBudget({ windowMs: CUE_BUDGET_CEILING.windowMs * 2 }).windowMs)
      .toBe(CUE_BUDGET_CEILING.windowMs * 2);
  });

  it('never lets configuration loosen it', () => {
    const loosened = resolveCueBudget({
      maxEvents: CUE_BUDGET_CEILING.maxEvents + 500,
      windowMs: 1_000,
    });
    expect(loosened).toEqual(CUE_BUDGET_CEILING);
  });

  it('falls back to the ceiling for missing or invalid fields', () => {
    expect(resolveCueBudget()).toEqual(CUE_BUDGET_CEILING);
    expect(resolveCueBudget({ maxEvents: Number.NaN })).toEqual(CUE_BUDGET_CEILING);
    expect(resolveRailRateLimit({ windowMs: -5 }).windowMs).toBeGreaterThan(0);
  });
});

describe('per-camera rate limit', () => {
  it('contains one noisy camera without silencing the rest of the site', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const rail = new CctvRail({
      scheduler,
      site: stubSite(),
      cameraRateLimit: { maxEvents: 2, windowMs: 600_000 },
    });
    const seen = record(rail);
    await rail.start();

    for (let i = 0; i < 5; i++) {
      rail.ingest({
        id: `noisy-${i}`,
        cameraId: 'cam-east-south',
        zone: 'switchyard-approach',
        class: 'person',
        ts: QUIET_START_MS + i,
      });
    }
    // The quiet camera still gets through after the noisy one is capped.
    rail.ingest({
      id: 'quiet-1',
      cameraId: 'cam-east-north',
      zone: 'east-fence-north',
      class: 'person',
      ts: QUIET_START_MS + 10,
    });

    expect(seen.anomalies.map((m) => m.anomaly.id))
      .toEqual(['cctv-noisy-0', 'cctv-noisy-1', 'cctv-quiet-1']);
    expect(rail.health().counts.rateLimited).toBe(3);
    expect(seen.health.some((h) => h.detail.includes('rate limit reached for cctv:cam-east-south')))
      .toBe(true);
  });

  it('charges the rail limit before the shared budget', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const rail = new CctvRail({
      scheduler, site: stubSite(), cameraRateLimit: { maxEvents: 1, windowMs: 600_000 },
    });
    const bus = new CueBus({ scheduler, budget: { maxEvents: 5 } });
    bus.register(rail);
    await bus.start();

    for (let i = 0; i < 4; i++) {
      rail.ingest({
        id: `n-${i}`,
        cameraId: 'cam-east-south',
        zone: 'switchyard-approach',
        class: 'person',
        ts: QUIET_START_MS + i,
      });
    }
    // Three were stopped at the camera, so only one was ever charged.
    expect(bus.budgetState().used).toBe(1);
    expect(bus.budgetState().dropped).toBe(0);
  });
});

describe('shared cue budget', () => {
  it('drops cues past the budget and says so through health', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const rail = new RfDroneRail({ scheduler, rateLimit: { maxEvents: 100, windowMs: 3_600_000 } });
    const bus = new CueBus({ scheduler, budget: { maxEvents: 2 } });
    bus.register(rail);
    const admitted: AnomalyMessage[] = [];
    const rejected: CueRejection[] = [];
    bus.onAnomaly((m) => admitted.push(m));
    bus.onRejection((reason) => rejected.push(reason));
    const health: string[] = [];
    bus.onHealth((h) => health.push(h.detail));
    await bus.start();

    for (let i = 0; i < 4; i++) {
      rail.ingest({
        ts: QUIET_START_MS + i,
        source: 'rf_drone',
        kind: 'drone_link',
        band: '2.4GHz',
        confidence: 0.5,
        lat: -26.09 - i / 10_000,
        lon: 29.472,
      });
    }
    expect(admitted).toHaveLength(2);
    expect(rejected).toEqual(['budget', 'budget']);
    expect(bus.budgetState().dropped).toBe(2);
    expect(health.some((d) => d.includes('cue budget exhausted'))).toBe(true);
  });
});
