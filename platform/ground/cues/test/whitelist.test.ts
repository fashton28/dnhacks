/* Whitelisting. Two independent surfaces:
 *  - blue-force RF, which may only be established from AUTHENTICATED own-vehicle
 *    telemetry, and
 *  - site normalcy, which explains ordinary activity as noise and never as
 *    authorisation. Both must be recorded, because suppression is what an
 *    insider attacks. */

import { describe, expect, it } from 'vitest';

import {
  CctvRail, ManualScheduler, RfDroneRail, normalcySuppression, windowContains,
} from '../src/index.js';
import { loadFixture, loadNormalcy } from '../src/node/load.js';
import type { SuppressionRecord } from '../src/types.js';
import {
  DELIVERY_START_MS, FIXTURES_DIR, QUIET_START_MS, STAFFED_START_MS, record, stubSite,
} from './helpers.js';

const OWN_REMOTE_ID = 'EIS-1-SN-0001';

function rfRail(startMs = QUIET_START_MS) {
  const scheduler = new ManualScheduler(startMs);
  const rail = new RfDroneRail({ scheduler, fixture: loadFixture('rf_drone', FIXTURES_DIR) });
  const suppressed: SuppressionRecord[] = [];
  rail.onSuppression((r) => suppressed.push(r));
  return { scheduler, rail, seen: record(rail), suppressed };
}

describe('blue-force RF whitelisting', () => {
  it('suppresses our own airframe by its authenticated Remote ID fingerprint', async () => {
    const { scheduler, rail, seen, suppressed } = rfRail();
    rail.registerOwnVehicle({
      vehicleId: 'eis-1', remoteId: OWN_REMOTE_ID, ts: QUIET_START_MS, authenticated: true,
    });
    await rail.start();
    scheduler.advance(10_000);

    // The hostile still gets through: whitelisting is narrow, not a mute button.
    expect(seen.anomalies.map((m) => m.anomaly.type)).toEqual(['hostile_drone']);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].rule.kind).toBe('blue_force_rf');
    expect(suppressed[0].rule.detail).toContain(OWN_REMOTE_ID);
    expect(rail.whitelist().suppressed).toBe(1);
    expect(rail.health().counts.suppressed).toBe(1);
  });

  it('suppresses an emitter sitting on top of an authenticated own position', async () => {
    const { scheduler, rail, seen } = rfRail();
    rail.registerOwnVehicle({
      vehicleId: 'eis-2', lat: 41.2001797, lon: -98.4007163, ts: QUIET_START_MS + 5_800, authenticated: true,
    });
    await rail.start();
    scheduler.advance(10_000);
    // The co-located record is ours; the other located record still stands.
    expect(seen.anomalies.map((m) => m.anomaly.type)).toEqual(['remote_id']);
  });

  it('lets a STALE fingerprint whitelist nothing', async () => {
    const { scheduler, rail, seen } = rfRail();
    rail.registerOwnVehicle({
      vehicleId: 'eis-2',
      lat: 41.2001797,
      lon: -98.4007163,
      ts: QUIET_START_MS - 600_000, // ten minutes old
      authenticated: true,
    });
    await rail.start();
    scheduler.advance(10_000);
    expect(seen.anomalies.map((m) => m.anomaly.type)).toEqual(['remote_id', 'hostile_drone']);
  });

  it('refuses to whitelist from an unauthenticated fingerprint', () => {
    const rail = new RfDroneRail({ scheduler: new ManualScheduler(QUIET_START_MS) });
    expect(() => rail.registerOwnVehicle(
      { vehicleId: 'eis-1', remoteId: OWN_REMOTE_ID, ts: QUIET_START_MS, authenticated: false as never },
    )).toThrow(/authenticated own-vehicle fingerprint/);
    expect(rail.whitelist().rules).toHaveLength(0);
  });

  it('stops whitelisting once the fingerprint is withdrawn', async () => {
    const { scheduler, rail, seen } = rfRail();
    rail.registerOwnVehicle({
      vehicleId: 'eis-1', remoteId: OWN_REMOTE_ID, ts: QUIET_START_MS, authenticated: true,
    });
    rail.forgetOwnVehicle('eis-1');
    await rail.start();
    scheduler.advance(10_000);
    expect(seen.anomalies).toHaveLength(2);
  });
});

describe('site normalcy', () => {
  const normalcy = loadNormalcy(FIXTURES_DIR)!;

  it('suppresses a staffed zone during staffed hours only', async () => {
    for (const [startMs, expected] of [[STAFFED_START_MS, 0], [QUIET_START_MS, 1]] as const) {
      const scheduler = new ManualScheduler(startMs);
      const rail = new CctvRail({ scheduler, site: stubSite(), normalcy });
      const seen = record(rail);
      await rail.start();
      rail.ingest({
        cameraId: 'cam-east-north', zone: 'east-fence-north', class: 'person', ts: startMs,
      });
      expect(seen.anomalies).toHaveLength(expected);
    }
  });

  it('suppresses an active gate inside its declared window', async () => {
    const scheduler = new ManualScheduler(STAFFED_START_MS);
    const rail = new CctvRail({ scheduler, site: stubSite(), normalcy });
    const suppressed: SuppressionRecord[] = [];
    rail.onSuppression((r) => suppressed.push(r));
    await rail.start();
    rail.ingest({
      cameraId: 'cam-east-south', zone: 'east-fence-south', class: 'person', ts: STAFFED_START_MS,
    });
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].rule.id).toBe('active_gate:east-service-gate');
  });

  it('applies a delivery window only to the classes it names', async () => {
    const scheduler = new ManualScheduler(DELIVERY_START_MS);
    const rail = new CctvRail({ scheduler, site: stubSite(), normalcy });
    const seen = record(rail);
    await rail.start();
    rail.ingest({
      cameraId: 'cam-east-south', zone: 'switchyard-approach', class: 'vehicle', ts: DELIVERY_START_MS,
    });
    rail.ingest({
      cameraId: 'cam-east-south', zone: 'switchyard-approach', class: 'person', ts: DELIVERY_START_MS,
    });
    // The truck is expected; the person in the same window is not.
    expect(seen.anomalies).toHaveLength(1);
    expect(seen.anomalies[0].anomaly.type).toBe('person_in_zone');
  });

  it('never suppresses a cue that names no camera zone', () => {
    expect(normalcySuppression(normalcy, { tsMs: STAFFED_START_MS })).toBeNull();
    expect(normalcySuppression(normalcy, { cameraId: 'cam-east-north', tsMs: STAFFED_START_MS }))
      .toBeNull();
  });

  it('handles a window that wraps past midnight', () => {
    const nightShift = { days: [3 as const], startMinute: 1_320, endMinute: 360 };
    // Wednesday 23:00 at UTC+120 — inside, on the starting day.
    expect(windowContains(nightShift, Date.UTC(2024, 0, 10, 21, 0, 0), 120)).toBe(true);
    // Thursday 02:00 at UTC+120 — still inside, carried over from Wednesday.
    expect(windowContains(nightShift, Date.UTC(2024, 0, 11, 0, 0, 0), 120)).toBe(true);
    // Thursday 08:00 at UTC+120 — outside.
    expect(windowContains(nightShift, Date.UTC(2024, 0, 11, 6, 0, 0), 120)).toBe(false);
  });

  it('reports every rule in force so the audit can see what can suppress', () => {
    const rail = new CctvRail({
      scheduler: new ManualScheduler(QUIET_START_MS), site: stubSite(), normalcy,
    });
    const kinds = rail.whitelist().rules.map((r) => r.kind).sort();
    expect(kinds).toEqual(['active_gate', 'delivery_window', 'staffed_hours']);
  });
});
