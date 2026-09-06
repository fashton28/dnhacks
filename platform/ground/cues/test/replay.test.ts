/* Scripted replay: every shipped fixture, through its rail's real decoder,
 * producing contract anomalies with the right fields and a live TTL. */

import { describe, expect, it } from 'vitest';

import {
  CctvRail, DroneSurveyRail, FenceSensorRail, ManualScheduler, RfDroneRail,
  SarRail, SdrRail, Sentinel2Rail, CueBus, RAIL_IDS,
} from '../src/index.js';
import { loadFixture, loadNormalcy } from '../src/node/load.js';
import { parseCueFixture } from '../src/fixture.js';
import { FIXTURES_DIR, QUIET_START_MS, record, stubSite } from './helpers.js';

describe('scripted fixtures', () => {
  it('ships one valid fixture per rail, each with honest provenance', () => {
    for (const rail of RAIL_IDS) {
      const fixture = loadFixture(rail, FIXTURES_DIR);
      expect(fixture.rail).toBe(rail);
      expect(fixture.provenance.length).toBeGreaterThan(20);
      expect(fixture.events.length).toBeGreaterThan(0);
    }
  });

  it('refuses a fixture whose rail does not match the one asked for', () => {
    expect(() => loadFixture('cctv', FIXTURES_DIR)).not.toThrow();
    const raw = { rail: 'sdr', provenance: 'x'.repeat(30), events: [] };
    expect(() => parseCueFixture(raw, 'cctv')).toThrow(/does not match cctv/);
  });

  it('refuses a fixture with no provenance', () => {
    expect(() => parseCueFixture({ rail: 'cctv', events: [] })).toThrow(/provenance/);
  });
});

describe('cctv replay', () => {
  function railAt(startMs: number) {
    const scheduler = new ManualScheduler(startMs);
    const rail = new CctvRail({
      scheduler,
      site: stubSite(),
      normalcy: loadNormalcy(FIXTURES_DIR),
      fixture: loadFixture('cctv', FIXTURES_DIR),
    });
    return { scheduler, rail, seen: record(rail) };
  }

  it('turns VMS events into anomalies with zone centroids, class confidence and TTL', async () => {
    const { scheduler, rail, seen } = railAt(QUIET_START_MS);
    await rail.start();
    scheduler.advance(10_000);

    expect(seen.anomalies).toHaveLength(2);
    const [first, second] = seen.anomalies;

    expect(first.anomaly).toMatchObject({
      id: 'cctv-vms-1001',
      source: 'cctv',
      cameraId: 'cam-east-south',
      type: 'person_in_zone',
      confidence: 0.72,
      ttl_s: 180,
    });
    expect(first.anomaly.lat).toBeCloseTo(41.2, 6);
    expect(first.anomaly.lon).toBeCloseTo(-98.3985673, 6);
    expect(first.anomaly.observedAt).toBe(QUIET_START_MS);
    expect(first.vehicleId).toBe('eis-1');

    expect(second.anomaly).toMatchObject({
      id: 'cctv-vms-1002',
      cameraId: 'cam-east-north',
      type: 'vehicle_in_zone',
      confidence: 0.66,
    });
    expect(second.anomaly.lat).toBeCloseTo(41.2006289, 6);
    expect(second.anomaly.lon).toBeCloseTo(-98.3983285, 6);
    // observedAt is when the CAMERA saw it, earlier than the message ts.
    expect(second.anomaly.observedAt).toBe(QUIET_START_MS + 3500);
    expect(second.ts).toBeGreaterThan(second.anomaly.observedAt as number);
  });

  it('emits cctvEvent provenance for every VMS record', async () => {
    const { scheduler, rail } = railAt(QUIET_START_MS);
    const provenance: string[] = [];
    rail.onCctvEvent((m) => provenance.push(`${m.cameraId}/${m.zone}`));
    await rail.start();
    scheduler.advance(10_000);
    expect(provenance).toEqual([
      'cam-east-south/switchyard-approach',
      'cam-east-north/east-fence-north',
    ]);
  });

  it('does not emit a cue whose TTL has already run out', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const rail = new CctvRail({ scheduler, site: stubSite(), ttlS: 60 });
    const seen = record(rail);
    await rail.start();
    rail.ingest({
      cameraId: 'cam-east-south',
      zone: 'switchyard-approach',
      class: 'person',
      ts: QUIET_START_MS - 61_000,
    });
    expect(seen.anomalies).toHaveLength(0);
    expect(rail.health().counts.expired).toBe(1);
  });
});

describe('rf_drone replay', () => {
  it('emits located records only; unlocated RF is health, not a cue', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const rail = new RfDroneRail({ scheduler, fixture: loadFixture('rf_drone', FIXTURES_DIR) });
    const seen = record(rail);
    await rail.start();
    scheduler.advance(10_000);

    expect(seen.anomalies.map((m) => m.anomaly.type)).toEqual(['remote_id', 'hostile_drone']);
    for (const m of seen.anomalies) {
      expect(m.anomaly.source).toBe('rf_drone');
      expect(m.anomaly.ttl_s).toBe(120);
      expect(m.anomaly.observedAt).toBeLessThanOrEqual(m.ts);
    }
    expect(seen.anomalies[1].anomaly.confidence).toBe(0.9);
  });
});

describe('sdr replay', () => {
  it('walks the sidecar states and raises a cue only for a located event', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const rail = new SdrRail({ scheduler, fixture: loadFixture('sdr', FIXTURES_DIR) });
    const seen = record(rail);
    await rail.start();
    scheduler.advance(120_000);

    expect(seen.anomalies).toHaveLength(1);
    expect(seen.anomalies[0].anomaly).toMatchObject({ source: 'sdr', type: 'drone_link', ttl_s: 300 });

    const states = seen.health.map((h) => h.state);
    expect(states).toContain('starting');
    expect(states).toContain('healthy');
    // The unlocated GNSS interference degrades the rail without a cue.
    expect(states).toContain('degraded');
    expect(seen.health.some((h) => h.detail.includes('unlocated, no cue raised'))).toBe(true);
  });
});

describe('satellite, fence and survey replay', () => {
  it('replays the baked optical cue with an acquisition time in the past', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const rail = new Sentinel2Rail({ scheduler, fixture: loadFixture('sentinel2', FIXTURES_DIR) });
    const seen = record(rail);
    await rail.start();
    scheduler.advance(2_000);
    expect(seen.anomalies).toHaveLength(1);
    expect(seen.anomalies[0].anomaly).toMatchObject({
      id: 'sentinel2-sat-change-1', source: 'sentinel2', type: 'change', ttl_s: 86_400,
    });
    expect(seen.anomalies[0].anomaly.observedAt).toBe(QUIET_START_MS - 3_600_000);
  });

  it('replays the baked SAR cue', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const rail = new SarRail({ scheduler, fixture: loadFixture('sar', FIXTURES_DIR) });
    const seen = record(rail);
    await rail.start();
    scheduler.advance(2_000);
    expect(seen.anomalies).toHaveLength(1);
    expect(seen.anomalies[0].anomaly).toMatchObject({
      // The cue kind names the direction of the backscatter change; the baked
      // chips brighten. It never carries the intensity chip's JSON path as a
      // thumbnail, which the incident report would render as image evidence.
      id: 'sar-sar-change-1', source: 'sar', type: 'sar_backscatter_increase', ttl_s: 43_200,
      thumbnail: '',
    });
  });

  it('resolves a fence segment through the camera zone it names', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const rail = new FenceSensorRail({
      scheduler, site: stubSite(), fixture: loadFixture('fence_sensor', FIXTURES_DIR),
    });
    const seen = record(rail);
    await rail.start();
    scheduler.advance(10_000);
    expect(seen.anomalies.map((m) => m.anomaly.type)).toEqual(['fence_cut', 'fence_climb']);
    expect(seen.anomalies[0].anomaly.lat).toBeCloseTo(41.1993712, 6);
    expect(seen.anomalies[0].anomaly.lon).toBeCloseTo(-98.3983285, 6);
    expect(seen.anomalies[0].anomaly.cameraId).toBe('cam-east-south');
  });

  it('replays the survey stub fixture', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const rail = new DroneSurveyRail({
      scheduler, fixture: loadFixture('drone_survey', FIXTURES_DIR),
    });
    const seen = record(rail);
    await rail.start();
    scheduler.advance(5_000);
    expect(seen.anomalies).toHaveLength(1);
    expect(seen.anomalies[0].anomaly).toMatchObject({
      source: 'drone_survey', type: 'fence_gap', ttl_s: 3_600,
    });
  });
});

describe('every rail, one bus', () => {
  it('multiplexes all seven scripted rails onto the one anomaly channel', async () => {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const site = stubSite();
    const normalcy = loadNormalcy(FIXTURES_DIR);
    const bus = new CueBus({ scheduler });
    bus.registerAll([
      new Sentinel2Rail({ scheduler, fixture: loadFixture('sentinel2', FIXTURES_DIR) }),
      new SarRail({ scheduler, fixture: loadFixture('sar', FIXTURES_DIR) }),
      new SdrRail({ scheduler, fixture: loadFixture('sdr', FIXTURES_DIR) }),
      new RfDroneRail({ scheduler, fixture: loadFixture('rf_drone', FIXTURES_DIR) }),
      new CctvRail({ scheduler, site, normalcy, fixture: loadFixture('cctv', FIXTURES_DIR) }),
      new FenceSensorRail({ scheduler, site, fixture: loadFixture('fence_sensor', FIXTURES_DIR) }),
      new DroneSurveyRail({ scheduler, fixture: loadFixture('drone_survey', FIXTURES_DIR) }),
    ]);
    const seen = record(bus);
    await bus.start();
    scheduler.advance(120_000);

    const sources = new Set(seen.anomalies.map((m) => m.anomaly.source));
    expect([...sources].sort()).toEqual(
      ['cctv', 'drone_survey', 'fence_sensor', 'rf_drone', 'sar', 'sdr', 'sentinel2'],
    );
    for (const m of seen.anomalies) {
      expect(m.type).toBe('anomaly');
      expect(m.vehicleId).toBe('eis-1');
      expect(m.anomaly.observedAt).toBeTypeOf('number');
      expect(m.anomaly.ttl_s).toBeGreaterThan(0);
    }
    expect(bus.health()).toHaveLength(7);
  });
});
