/* ============================================================================
 * In-memory recorder semantics (ui-views-stores).
 *
 * The recorder is the browser stand-in for window.eis.recorder: start opens a
 * session (sealing any open one), append grows the open session, stop seals
 * it, list/load read back newest-first. `toRecordedFrame` is the adapter that
 * lets the log browser read the shell's NDJSON sessions — raw telemetry and
 * tracking wire messages — as the same frames the in-memory recorder keeps.
 * ========================================================================== */
import { describe, expect, it } from 'vitest';
import { createRecorder, defaultRecordingId, recorder, toRecordedFrame } from '@/store/recorder';
import type { RecordedFrame } from '@/store/recorder';
import type { Telemetry, TrackingStatus } from '@/contract';

function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const telemetryAt = (ts: number): Telemetry =>
  ({ type: 'telemetry', ts, vehicleId: 'v1', armed: true } as unknown as Telemetry);
const trackingAt = (ts: number): TrackingStatus =>
  ({ type: 'tracking', ts, vehicleId: 'v1', state: 'locked' } as unknown as TrackingStatus);
const frameAt = (ts: number): RecordedFrame => ({ ts, telemetry: telemetryAt(ts) });

/* ------------------------------------------------------------------------- */
describe('sessions', () => {
  it('is idle until started; start returns a rec- id that becomes current', () => {
    const c = clock();
    const rec = createRecorder({ now: c.now });
    expect(rec.isRecording()).toBe(false);
    expect(rec.currentId()).toBeNull();
    expect(rec.list()).toEqual([]);

    const id = rec.start({ pilot: 'ops-1' });
    expect(id).toMatch(/^rec-[0-9a-z]+-[0-9a-z]+$/);
    expect(rec.isRecording()).toBe(true);
    expect(rec.currentId()).toBe(id);
    expect(rec.list()).toEqual([{ id, startedAt: c.now(), durationMs: 0, size: 0 }]);
  });

  it('append is a no-op while idle and grows the open session', () => {
    const c = clock();
    const rec = createRecorder({ now: c.now });
    rec.append(frameAt(c.now()));
    expect(rec.list()).toEqual([]);

    const id = rec.start();
    rec.append(frameAt(c.now() + 100));
    rec.append(frameAt(c.now() + 250));
    const session = rec.load(id);
    expect(session?.size).toBe(2);
    expect(session?.frames).toHaveLength(2);
    expect(session?.durationMs).toBe(250);
    expect(rec.list()[0]).toMatchObject({ id, size: 2, durationMs: 250 });
  });

  it('elapsed time never runs backwards when a frame arrives out of order', () => {
    const c = clock();
    const rec = createRecorder({ now: c.now });
    const id = rec.start();
    rec.append(frameAt(c.now() + 500));
    rec.append(frameAt(c.now() + 200));
    rec.append(frameAt(c.now() - 50));
    expect(rec.load(id)?.durationMs).toBe(500);
    expect(rec.load(id)?.size).toBe(3);
  });

  it('stop seals with the wall-clock duration and returns the summary; a second stop is null', () => {
    const c = clock();
    const rec = createRecorder({ now: c.now });
    const id = rec.start({ note: 'x' });
    rec.append(frameAt(c.now() + 100));
    c.advance(4_000);

    expect(rec.stop()).toEqual({ id, startedAt: c.now() - 4_000, durationMs: 4_000, size: 1 });
    expect(rec.isRecording()).toBe(false);
    expect(rec.currentId()).toBeNull();
    expect(rec.stop()).toBeNull();

    rec.append(frameAt(c.now())); // sealed sessions do not grow
    expect(rec.load(id)?.size).toBe(1);
  });

  it('start while recording seals the previous session and keeps it listed', () => {
    const c = clock();
    const rec = createRecorder({ now: c.now });
    const first = rec.start();
    rec.append(frameAt(c.now() + 10));
    c.advance(1_000);
    const second = rec.start();

    expect(first).not.toBe(second);
    expect(rec.currentId()).toBe(second);
    expect(rec.load(first)).toMatchObject({ id: first, durationMs: 1_000, size: 1 });
    expect(rec.list().map((m) => m.id)).toEqual([second, first]);
  });

  it('lists newest-first, ties broken newest-recorded-first; load of an unknown id is null', () => {
    const c = clock();
    const rec = createRecorder({ now: c.now });
    const a = rec.start();
    const b = rec.start(); // same clock reading as a
    c.advance(10);
    const d = rec.start();
    rec.stop();
    expect(rec.list().map((m) => m.id)).toEqual([d, b, a]);
    expect(rec.load('rec-nope')).toBeNull();
  });

  it('load returns the session with its meta and frames', () => {
    const c = clock();
    const rec = createRecorder({ now: c.now });
    const meta = { pilot: 'ops-1' };
    const id = rec.start(meta);
    rec.append({ ts: c.now() + 5, tracking: trackingAt(c.now() + 5) });
    const session = rec.load(id);
    expect(session?.meta).toEqual(meta);
    expect(session?.meta).not.toBe(meta); // copied, not aliased
    expect(session?.frames[0].tracking?.state).toBe('locked');
  });

  it('clear drops every session including the open one', () => {
    const rec = createRecorder();
    rec.start();
    rec.append(frameAt(Date.now()));
    rec.start();
    rec.clear();
    expect(rec.isRecording()).toBe(false);
    expect(rec.currentId()).toBeNull();
    expect(rec.list()).toEqual([]);
  });

  it('honours an injected id factory', () => {
    const rec = createRecorder({ makeId: (startedAt, seq) => `flight-${seq}-${startedAt}` });
    const c = Date.now();
    const id = rec.start();
    expect(id).toMatch(/^flight-1-\d+$/);
    expect(Number(id.split('-')[2])).toBeGreaterThanOrEqual(c);
  });

  it('defaultRecordingId keeps the rec-<base36 time>- prefix and is unique per call', () => {
    const at = 1_700_000_000_000;
    const a = defaultRecordingId(at, 1);
    const b = defaultRecordingId(at, 1);
    expect(a.startsWith(`rec-${at.toString(36)}-`)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('the exported singleton exposes the same surface', () => {
    recorder.clear();
    const id = recorder.start();
    expect(recorder.currentId()).toBe(id);
    expect(recorder.stop()?.id).toBe(id);
    recorder.clear();
  });
});

/* ------------------------------------------------------------------------- */
describe('toRecordedFrame', () => {
  it('wraps a raw telemetry wire message', () => {
    const t = telemetryAt(1_000);
    expect(toRecordedFrame(t)).toEqual({ ts: 1_000, telemetry: t });
  });

  it('wraps a raw tracking wire message', () => {
    const k = trackingAt(2_000);
    expect(toRecordedFrame(k)).toEqual({ ts: 2_000, tracking: k });
  });

  it('passes a recorder frame through, keeping only the timeline parts', () => {
    const t = telemetryAt(3_000);
    expect(toRecordedFrame({ ts: 3_000, telemetry: t })).toEqual({ ts: 3_000, telemetry: t });
    expect(toRecordedFrame({ ts: 3_000 })).toEqual({ ts: 3_000 });
    expect(toRecordedFrame({ ts: 3_000, telemetry: 'junk' })).toEqual({ ts: 3_000 });
  });

  it('rejects what the timeline cannot show', () => {
    expect(toRecordedFrame({ type: 'statusText', ts: 1, text: 'hi' })).toBeNull();
    expect(toRecordedFrame({ type: 'telemetry' })).toBeNull(); // no ts
    expect(toRecordedFrame({ ts: Number.NaN, type: 'telemetry' })).toBeNull();
    expect(toRecordedFrame('garbage')).toBeNull();
    expect(toRecordedFrame(null)).toBeNull();
    expect(toRecordedFrame(undefined)).toBeNull();
  });
});
