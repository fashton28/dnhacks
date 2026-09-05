import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  adaptRfEvent,
  CORRELATION_WINDOW_MS,
  InterferenceCorrelator,
  loadRfFixture,
} from '../src/rf_adapter';


const gnss = (ts: number, vehicleId = 'eis-1') => adaptRfEvent({
  ts, vehicleId, source: 'sdr', kind: 'gnss_interference', band: 'GPS L1',
  confidence: 0.9, power_delta_db: 8,
}).event;

describe('RF feed adapter', () => {
  it('attaches the default vehicle and derives a located hostile anomaly', () => {
    const emission = adaptRfEvent({
      source: 'rf_drone', kind: 'hostile_drone', band: '2.4GHz', confidence: 0.91,
      lat: -26.09, lon: 29.4719, pilot_lat: -26.091, pilot_lon: 29.469,
    }, { nowMs: 1234 });
    expect(emission.event).toMatchObject({ type: 'rfEvent', ts: 1234, vehicleId: 'eis-1' });
    expect(emission.anomaly?.anomaly).toMatchObject({
      source: 'rf_drone', type: 'hostile_drone', lat: -26.09, lon: 29.4719,
    });
  });

  it('rejects non-finite and partial coordinates', () => {
    expect(() => adaptRfEvent({
      source: 'rf_drone', kind: 'hostile_drone', band: '2.4GHz', confidence: 0.8,
      lat: Number.NaN, lon: 29,
    })).toThrow(/coordinate/);
    expect(() => adaptRfEvent({
      source: 'rf_drone', kind: 'hostile_drone', band: '2.4GHz', confidence: 0.8,
      lat: -26,
    })).toThrow(/together/);
  });

  it('loads the offline root fixture', () => {
    const fixture = path.resolve(__dirname, '../../../rf_events.json');
    const events = loadRfFixture(fixture);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.every(({ event }) => event.vehicleId === 'eis-1')).toBe(true);
  });
});

describe('GPS/RF correlation', () => {
  it('correlates GPS loss followed by interference', () => {
    const c = new InterferenceCorrelator();
    expect(c.recordNavSource('eis-1', 'optflow', 10_000)).toBeNull();
    const event = c.recordRfEvent(gnss(60_000));
    expect(event).toMatchObject({ component: 'gps', state: 'escalate', vehicleId: 'eis-1' });
    expect(event?.detail).toContain('probable interference');
  });

  it('correlates symmetrically and only within sixty seconds', () => {
    const c = new InterferenceCorrelator();
    expect(c.recordRfEvent(gnss(100_000))).toBeNull();
    expect(c.recordNavSource('eis-1', 'extnav', 100_000 + CORRELATION_WINDOW_MS)).not.toBeNull();
    expect(c.recordNavSource('eis-1', 'extnav', 100_000 + CORRELATION_WINDOW_MS)).toBeNull();

    const stale = new InterferenceCorrelator();
    stale.recordRfEvent(gnss(100_000));
    expect(stale.recordNavSource('eis-1', 'optflow', 160_001)).toBeNull();
  });

  it('never correlates different vehicles', () => {
    const c = new InterferenceCorrelator();
    c.recordRfEvent(gnss(1_000, 'eis-2'));
    expect(c.recordNavSource('eis-1', 'optflow', 2_000)).toBeNull();
  });

  it('does not refresh a GPS-loss edge on repeated denied telemetry', () => {
    const c = new InterferenceCorrelator();
    c.recordNavSource('eis-1', 'gps', 1_000);
    c.recordNavSource('eis-1', 'optflow', 2_000);
    for (let ts = 3_000; ts <= 120_000; ts += 1_000) {
      expect(c.recordNavSource('eis-1', 'optflow', ts)).toBeNull();
    }
    expect(c.recordRfEvent(gnss(120_000))).toBeNull();
  });
});
