/* Health and failure behaviour.
 *
 * The invariant under test everywhere here: a rail that is not working must not
 * look like a rail that is working. `failed` is reported, never `healthy` and
 * never a silent nominal — and a failing rail takes only itself out. */

import { describe, expect, it } from 'vitest';

import {
  BoundedIdSet, CctvRail, CueBus, DroneSurveyRail, FenceSensorRail, ManualScheduler,
  RfDroneRail, SarRail, SdrRail, Sentinel2Rail, railIsNominal,
} from '../src/index.js';
import type { AnomalyMessage } from '../src/contract.js';
import type { CueAdapter } from '../src/types.js';
import { loadFixture } from '../src/node/load.js';
import { FIXTURES_DIR, QUIET_START_MS, record, stubSite } from './helpers.js';

const site = stubSite();

describe('badge states', () => {
  it('starts stopped, never unknown-as-nominal', () => {
    const rail = new SdrRail({ scheduler: new ManualScheduler(QUIET_START_MS) });
    expect(rail.health().state).toBe('stopped');
    expect(railIsNominal(rail.health().state)).toBe(false);
    expect(rail.health().blindZones).toEqual([]);
  });

  it('walks stopped → starting → healthy → stopped across a lifecycle', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const rail = new SdrRail({ scheduler, fixture: loadFixture('sdr', FIXTURES_DIR) });
    const seen = record(rail);
    await rail.start();
    expect(rail.health().state).toBe('healthy');
    await rail.stop();
    expect(rail.health().state).toBe('stopped');
    expect(seen.health.map((h) => h.state)).toEqual(['starting', 'healthy', 'stopped']);
    for (const event of seen.health) {
      expect(event.type).toBe('healthEvent');
      expect(event.vehicleId).toBe('eis-1');
      expect(event.detail).toContain('cue rail sdr');
    }
  });

  it('reports failed, not healthy, when a rail has no source at all', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    for (const rail of [
      new DroneSurveyRail({ scheduler }),
      new FenceSensorRail({ scheduler, site }),
      new Sentinel2Rail({ scheduler }),
      new SarRail({ scheduler }),
    ] as CueAdapter[]) {
      await rail.start();
      expect(rail.health().state).toBe('failed');
      expect(railIsNominal(rail.health().state)).toBe(false);
    }
  });

  it('stops replaying once stopped', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const rail = new RfDroneRail({ scheduler, fixture: loadFixture('rf_drone', FIXTURES_DIR) });
    const seen = record(rail);
    await rail.start();
    await rail.stop();
    scheduler.advance(30_000);
    expect(seen.anomalies).toHaveLength(0);
  });
});

describe('camera offline makes its zones blind', () => {
  it('marks the zones blind, degrades the rail and refuses cues from them', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const rail = new CctvRail({ scheduler, site, fixture: loadFixture('cctv', FIXTURES_DIR) });
    const seen = record(rail);
    await rail.start();

    scheduler.advance(13_000);           // past the cameraOffline beat
    expect(rail.health().state).toBe('degraded');
    expect(rail.health().blindZones).toEqual([
      { cameraId: 'cam-east-north', zone: 'east-fence-north', reason: 'VMS reports the stream lost' },
    ]);

    const before = seen.anomalies.length;
    scheduler.advance(4_000);            // the cue from the blind camera
    expect(seen.anomalies).toHaveLength(before);
    expect(seen.health.some((h) => h.detail.includes('is blind'))).toBe(true);

    scheduler.advance(6_000);            // cameraOnline
    expect(rail.health().state).toBe('healthy');
    expect(rail.health().blindZones).toEqual([]);
  });

  it('leaves the other camera coverage untouched', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const rail = new CctvRail({ scheduler, site, fixture: loadFixture('cctv', FIXTURES_DIR) });
    const seen = record(rail);
    await rail.start();
    scheduler.advance(13_000);
    rail.ingest({
      id: 'still-watching',
      cameraId: 'cam-east-south',
      zone: 'switchyard-approach',
      class: 'person',
      ts: scheduler.now(),
    });
    expect(seen.anomalies.some((m) => m.anomaly.id === 'cctv-still-watching')).toBe(true);
  });
});

describe('VMS down', () => {
  it('fails the cctv rail and leaves every other rail producing cues', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const bus = new CueBus({ scheduler });
    const cctv = new CctvRail({ scheduler, site, fixture: loadFixture('cctv', FIXTURES_DIR) });
    const rf = new RfDroneRail({ scheduler, fixture: loadFixture('rf_drone', FIXTURES_DIR) });
    const sdr = new SdrRail({ scheduler, fixture: loadFixture('sdr', FIXTURES_DIR) });
    bus.registerAll([cctv, rf, sdr]);
    const seen = record(bus);
    await bus.start();
    scheduler.advance(120_000);

    expect(cctv.health().state).toBe('failed');
    expect(cctv.health().detail).toContain('VMS connection lost');
    // No cue is synthesised for the failed rail…
    const afterFailure = seen.anomalies.filter(
      (m) => m.anomaly.source === 'cctv' && m.ts >= QUIET_START_MS + 30_000,
    );
    expect(afterFailure).toHaveLength(0);
    // …and the other rails are unaffected.
    expect(seen.anomalies.some((m) => m.anomaly.source === 'rf_drone')).toBe(true);
    expect(seen.anomalies.some((m) => m.anomaly.source === 'sdr')).toBe(true);
    expect(bus.health().find((h) => h.rail === 'rf_drone')?.state).toBe('healthy');
  });
});

describe('failed is sticky', () => {
  it('does not let a camera coming back lift the rail out of failed', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const rail = new CctvRail({ scheduler, site, fixture: loadFixture('cctv', FIXTURES_DIR) });
    await rail.start();
    scheduler.advance(120_000);          // through the VMS-down beat
    expect(rail.health().state).toBe('failed');

    // A late camera transition is not evidence the VMS is back.
    rail.ingest({
      cameraId: 'cam-east-south', zone: 'switchyard-approach', ts: scheduler.now(),
    });
    expect(rail.health().state).toBe('failed');
  });
});

describe('id memory is bounded', () => {
  it('forgets the oldest id rather than growing without limit', () => {
    const seen = new BoundedIdSet(3);
    for (const id of ['a', 'b', 'c']) expect(seen.add(id)).toBe(true);
    expect(seen.add('a')).toBe(false);
    seen.add('d');                        // evicts 'a'
    expect(seen.size).toBe(3);
    expect(seen.has('a')).toBe(false);
    expect(seen.has('d')).toBe(true);
    expect(() => new BoundedIdSet(0)).toThrow();
  });
});

describe('bus isolation', () => {
  class ExplodingRail extends SdrRail {
    protected async onStart(): Promise<void> {
      throw new Error('boom');
    }
  }

  it('reports a rail whose start throws and still starts the others', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const bus = new CueBus({ scheduler });
    const exploding = new ExplodingRail({ scheduler });
    const rf = new RfDroneRail({ scheduler, fixture: loadFixture('rf_drone', FIXTURES_DIR) });
    bus.registerAll([exploding, rf]);
    const seen = record(bus);
    await bus.start();
    scheduler.advance(10_000);

    expect(exploding.health().state).toBe('failed');
    expect(exploding.health().detail).toContain('boom');
    expect(seen.anomalies.length).toBeGreaterThan(0);
  });

  it('a throwing subscriber never stops the rest of the fan-out', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const bus = new CueBus({ scheduler });
    bus.register(new RfDroneRail({ scheduler, fixture: loadFixture('rf_drone', FIXTURES_DIR) }));
    const survivors: AnomalyMessage[] = [];
    bus.onAnomaly(() => { throw new Error('subscriber exploded'); });
    bus.onAnomaly((m) => survivors.push(m));
    await bus.start();
    scheduler.advance(10_000);
    expect(survivors).toHaveLength(2);
  });

  it('refuses to register two rails with the same id', () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const bus = new CueBus({ scheduler });
    bus.register(new SdrRail({ scheduler }));
    expect(() => bus.register(new SdrRail({ scheduler }))).toThrow(/already registered/);
  });
});

describe('bus admission', () => {
  /** A rail that emits whatever a test hands it, so the bus's own gates —
   *  rather than a rail's — are what is under test. */
  class DirectRail implements CueAdapter {
    readonly id = 'sdr' as const;
    private readonly listeners = new Set<(m: AnomalyMessage) => void>();
    emit(m: AnomalyMessage): void {
      for (const cb of this.listeners) cb(m);
    }
    async start(): Promise<void> { /* nothing to open */ }
    async stop(): Promise<void> { /* nothing to close */ }
    onAnomaly(cb: (m: AnomalyMessage) => void) {
      this.listeners.add(cb);
      return () => this.listeners.delete(cb);
    }
    onHealth() { return () => undefined; }
    onSuppression() { return () => undefined; }
    health() {
      return {
        rail: this.id, state: 'healthy' as const, detail: 'test rail', since: 0,
        blindZones: [],
        counts: { observed: 0, emitted: 0, suppressed: 0, rateLimited: 0, expired: 0, rejected: 0 },
      };
    }
    whitelist() {
      return { rail: this.id, rules: [], suppressed: 0, recent: [] };
    }
  }

  function staleCue(observedAt: number, ttlS: number, id = 'stale-1'): AnomalyMessage {
    return {
      type: 'anomaly',
      ts: observedAt,
      vehicleId: 'eis-1',
      anomaly: {
        id, lat: -26.09, lon: 29.472, type: 'drone_link', confidence: 0.5,
        thumbnail: '', source: 'sdr', observedAt, ttl_s: ttlS,
      },
    };
  }

  it('drops an expired cue however it reached the bus', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const bus = new CueBus({ scheduler });
    const rail = new DirectRail();
    bus.register(rail);
    const rejected: string[] = [];
    bus.onRejection((reason) => rejected.push(reason));
    const seen = record(bus);
    await bus.start();

    rail.emit(staleCue(QUIET_START_MS - 400_000, 300));
    expect(seen.anomalies).toHaveLength(0);
    expect(rejected).toEqual(['expired']);

    rail.emit(staleCue(QUIET_START_MS, 300, 'fresh-1'));
    expect(seen.anomalies.map((m) => m.anomaly.id)).toEqual(['fresh-1']);
  });

  it('never emits the same cue id twice', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const bus = new CueBus({ scheduler });
    const rail = new SdrRail({ scheduler });
    bus.register(rail);
    const seen = record(bus);
    await bus.start();
    const payload = {
      type: 'rfEvent', ts: QUIET_START_MS, vehicleId: 'eis-1', source: 'sdr',
      kind: 'drone_link', band: '2.4GHz', confidence: 0.5, lat: -26.09, lon: 29.472,
    };
    rail.ingest(payload);
    rail.ingest(payload);
    expect(seen.anomalies).toHaveLength(1);
  });
});
