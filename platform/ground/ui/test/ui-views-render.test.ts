/* ============================================================================
 * Views (ui-views-stores): static renders + the pure helpers each view exports.
 *
 * No DOM is installed, so components are rendered with react-dom/server and
 * asserted on their markup — enough to pin what each modal shows for a given
 * settings snapshot, which props gate which controls, and that a closed modal
 * renders nothing. The behavioural logic (parsing, clamping, normalising,
 * frame lookup) is exported from the views and tested directly.
 * ========================================================================== */
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TrackingBanner } from '@/views/TrackingBanner';
import { ManualBanner } from '@/views/ManualBanner';
import { ChecklistModal, PREFLIGHT_ITEMS } from '@/views/ChecklistModal';
import { TakeoffModal, TAKEOFF_ALT_RANGE, clampTakeoffAltitude } from '@/views/TakeoffModal';
import { SettingsModal, parseControlPort } from '@/views/SettingsModal';
import { FailsafeModal, failsafeDraftWarnings } from '@/views/FailsafeModal';
import { PidTuningModal, parsePidDraft, pidToDraft } from '@/views/PidTuningModal';
import { LogBrowserModal, nearestFrameIndex, normaliseSession } from '@/views/LogBrowserModal';
import { DEFAULT_SETTINGS, settingsStore } from '@/store/settings';
import type { RecordingSession } from '@/store/recorder';

const h = React.createElement;
const html = (el: React.ReactElement): string => renderToStaticMarkup(el);
const noop = (): void => undefined;
const count = (markup: string, needle: string): number => markup.split(needle).length - 1;

afterEach(() => settingsStore.reset());

/* ------------------------------------------------------------------------- */
describe('banners', () => {
  it('TrackingBanner shows the envelope and a Disengage control', () => {
    const out = html(h(TrackingBanner, { standoff: 4, maxSpeed: 3.5, onDisengage: noop }));
    expect(out).toContain('role="status"');
    expect(out).toContain('Autonomous tracking active');
    expect(out).toContain('standoff 4.0 m');
    expect(out).toContain('max 3.5 m/s');
    expect(out).toContain('Disengage');
  });

  it('ManualBanner names the mode and offers Release', () => {
    const out = html(h(ManualBanner, { onRelease: noop }));
    expect(out).toContain('Manual control active');
    expect(out).toContain('operator has the sticks');
    expect(out).toContain('STABILIZE');
    expect(out).toContain('Release');
  });
});

/* ------------------------------------------------------------------------- */
describe('ChecklistModal', () => {
  it('renders nothing while closed', () => {
    expect(html(h(ChecklistModal, { open: false, onClose: noop, onComplete: noop }))).toBe('');
  });

  it('lists all six checks unconfirmed and keeps Arm confirmation disabled', () => {
    const out = html(h(ChecklistModal, { open: true, onClose: noop, onComplete: noop }));
    expect(PREFLIGHT_ITEMS).toHaveLength(6);
    for (const item of PREFLIGHT_ITEMS) expect(out).toContain(item.replace(/&/g, '&amp;'));
    expect(count(out, 'role="checkbox"')).toBe(6);
    expect(count(out, 'aria-checked="false"')).toBe(6);
    expect(out).toContain('0/6 confirmed');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*<span>Confirm &amp; enable Arm<\/span>/);
  });
});

/* ------------------------------------------------------------------------- */
describe('TakeoffModal', () => {
  it('renders nothing while closed and seeds the altitude from defaultAlt when open', () => {
    expect(html(h(TakeoffModal, { open: false, onClose: noop, onConfirm: noop }))).toBe('');
    const out = html(h(TakeoffModal, { open: true, onClose: noop, onConfirm: noop }));
    expect(out).toContain('Takeoff · 4 m');
    expect(out).toContain('Hold to take off');
    expect(html(h(TakeoffModal, { open: true, onClose: noop, onConfirm: noop, defaultAlt: 12 }))).toContain('Takeoff · 12 m');
    expect(html(h(TakeoffModal, { open: true, onClose: noop, onConfirm: noop, defaultAlt: 99 }))).toContain('Takeoff · 30 m');
  });

  it('clampTakeoffAltitude snaps onto the 2..30 m range', () => {
    expect(TAKEOFF_ALT_RANGE).toEqual({ min: 2, max: 30, step: 1 });
    expect(clampTakeoffAltitude(1)).toBe(2);
    expect(clampTakeoffAltitude(7.4)).toBe(7);
    expect(clampTakeoffAltitude(7.6)).toBe(8);
    expect(clampTakeoffAltitude(30.6)).toBe(30);
    expect(clampTakeoffAltitude(Number.NaN)).toBe(2);
    expect(clampTakeoffAltitude(-Infinity)).toBe(2);
  });
});

/* ------------------------------------------------------------------------- */
describe('SettingsModal', () => {
  it('shows a disabled "sitl" host while SITL is on and the persisted port', () => {
    const out = html(h(SettingsModal, { open: true, onClose: noop }));
    expect(out).toMatch(/<input[^>]*aria-label="host"[^>]*value="sitl"/);
    expect(out).toMatch(/<input[^>]*aria-label="host"[^>]*disabled=""/);
    expect(out).toMatch(/<input[^>]*aria-label="controlPort"[^>]*value="8765"/);
    expect(out).toContain('SITL simulator');
    expect(out).not.toContain('Failsafe settings');
    expect(out).not.toContain('PID tuning');
  });

  it('reflects the settings store: a real host once SITL is off, plus units and tiles', () => {
    settingsStore.set({
      connection: { host: 'jetson.local', controlPort: 8790, videoUrl: 'rtsp://jetson.local:8554/cam', sitl: false },
      units: 'imperial',
      mapTiles: 'osm',
    });
    const out = html(h(SettingsModal, { open: true, onClose: noop, onOpenFailsafe: noop, onOpenPid: noop }));
    expect(out).toMatch(/<input[^>]*aria-label="host"[^>]*value="jetson.local"/);
    expect(out).not.toMatch(/<input[^>]*aria-label="host"[^>]*disabled=""/);
    expect(out).toMatch(/<input[^>]*aria-label="controlPort"[^>]*value="8790"/);
    expect(out).toMatch(/<input[^>]*aria-label="videoUrl"[^>]*value="rtsp:\/\/jetson.local:8554\/cam"/);
    expect(out).toMatch(/<button[^>]*aria-checked="true"[^>]*>Imperial<\/button>/);
    expect(out).toMatch(/<button[^>]*aria-checked="true"[^>]*>OSM<\/button>/);
    expect(out).toContain('Failsafe settings');
    expect(out).toContain('PID tuning');
  });

  it('parseControlPort accepts 1..65535 and falls back to 8765 otherwise', () => {
    expect(parseControlPort('8765')).toBe(8765);
    expect(parseControlPort(' 9000 ')).toBe(9000);
    expect(parseControlPort('65535')).toBe(65535);
    expect(parseControlPort('0')).toBe(8765);
    expect(parseControlPort('65536')).toBe(8765);
    expect(parseControlPort('')).toBe(8765);
    expect(parseControlPort('80a')).toBe(8765);
    expect(parseControlPort('-5')).toBe(8765);
    expect(parseControlPort('junk', 1234)).toBe(1234);
  });
});

/* ------------------------------------------------------------------------- */
describe('FailsafeModal', () => {
  it('renders every envelope control from the persisted failsafe block', () => {
    settingsStore.set({ failsafe: { ...DEFAULT_SETTINGS.failsafe, linkLossAction: 'LAND', batteryWarnPct: 42 } });
    const out = html(h(FailsafeModal, { open: true, onClose: noop }));
    expect(out).toContain('Geofence radius');
    expect(out).toContain('Max altitude');
    expect(out).toContain('Battery warn');
    expect(out).toContain('Battery failsafe');
    expect(out).toContain('Link-loss action');
    expect(out).toContain('GCS heartbeat-loss action');
    expect(count(out, 'role="radio"')).toBe(6);
    expect(out).toMatch(/<button[^>]*role="radio"[^>]*aria-checked="true"[^>]*>Land<\/button>/);
    expect(out).toMatch(/<input[^>]*type="number"[^>]*value="42"/);
    expect(html(h(FailsafeModal, { open: false, onClose: noop }))).toBe('');
  });

  it('failsafeDraftWarnings flags an inverted battery pair and HOLD on link loss', () => {
    expect(failsafeDraftWarnings(DEFAULT_SETTINGS.failsafe)).toEqual([]);
    expect(failsafeDraftWarnings({ ...DEFAULT_SETTINGS.failsafe, batteryFailsafePct: 30 })).toHaveLength(1);
    expect(failsafeDraftWarnings({ ...DEFAULT_SETTINGS.failsafe, linkLossAction: 'HOLD' })).toHaveLength(1);
    expect(failsafeDraftWarnings({ ...DEFAULT_SETTINGS.failsafe, batteryFailsafePct: 40, linkLossAction: 'HOLD' })).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------------- */
describe('PidTuningModal', () => {
  it('renders a nine-cell gain table keyed to the companion config path', () => {
    const out = html(h(PidTuningModal, { open: true, onClose: noop }));
    for (const axis of ['yaw', 'altitude', 'forward']) expect(out).toContain(`guidance.gains.${axis}`);
    // React's server renderer emits `inputMode` verbatim; HTML attribute names are case-insensitive.
    expect(count(out.toLowerCase(), 'inputmode="decimal"')).toBe(9);
    expect(out).toMatch(/aria-label="Yaw Kp"[^>]*value="0.4"/);
    expect(out).toMatch(/aria-label="Altitude Kd"[^>]*value="0.04"/);
    expect(out).toContain('guidance.gains.{axis}.{kp|ki|kd}');
    expect(html(h(PidTuningModal, { open: false, onClose: noop }))).toBe('');
  });

  it('pidToDraft / parsePidDraft round-trip and reject bad cells', () => {
    const draft = pidToDraft(DEFAULT_SETTINGS.pid);
    expect(parsePidDraft(draft)).toEqual({ gains: DEFAULT_SETTINGS.pid, errors: {} });

    const edited = { ...draft, yaw: { ...draft.yaw, kp: ' 0.55 ' } };
    expect(parsePidDraft(edited).gains?.yaw.kp).toBe(0.55);

    const bad = { ...draft, yaw: { kp: 'abc', ki: '-1', kd: '' } };
    const parsed = parsePidDraft(bad);
    expect(parsed.gains).toBeNull();
    expect(Object.keys(parsed.errors).sort()).toEqual(['yaw.kd', 'yaw.ki', 'yaw.kp']);
  });
});

/* ------------------------------------------------------------------------- */
describe('LogBrowserModal', () => {
  it('renders the empty state when there is nothing to browse', () => {
    expect(html(h(LogBrowserModal, { open: false, onClose: noop }))).toBe('');
    const out = html(h(LogBrowserModal, { open: true, onClose: noop }));
    expect(out).toContain('Recorded sessions');
    expect(out).toContain('No sessions recorded yet');
    expect(out).toContain('Select a session to scrub its timeline.');
  });

  it("normaliseSession folds the shell's { meta, frames } envelope of raw wire messages", () => {
    const envelope = {
      meta: { id: '20240622-143012-001', startedAt: 1_000, pilot: 'ops-1' },
      frames: [
        { type: 'tracking', ts: 1_500, vehicleId: 'v1', state: 'locked' },
        { type: 'statusText', ts: 1_200, vehicleId: 'v1', text: 'armed' },
        { type: 'telemetry', ts: 1_000, vehicleId: 'v1', armed: true },
        'garbage',
      ],
    };
    const session = normaliseSession(envelope, { id: '20240622-143012-001', startedAt: 1_000, durationMs: 2_000, size: 4096 });
    expect(session).not.toBeNull();
    expect(session?.id).toBe('20240622-143012-001');
    expect(session?.startedAt).toBe(1_000);
    expect(session?.durationMs).toBe(2_000); // the list hint wins over the last frame (500 ms)
    expect(session?.size).toBe(2);
    expect(session?.frames.map((f) => f.ts)).toEqual([1_000, 1_500]);
    expect(session?.frames[0].telemetry).toBeDefined();
    expect(session?.frames[1].tracking).toBeDefined();
    expect(session?.meta).toMatchObject({ pilot: 'ops-1' });
  });

  it('normaliseSession accepts an in-memory session and the onLoad prop shape', () => {
    const inMemory: RecordingSession = {
      id: 'rec-abc-1', startedAt: 10, durationMs: 0, size: 0, meta: {},
      frames: [{ ts: 40 }, { ts: 10 }],
    };
    const fromMemory = normaliseSession(inMemory);
    expect(fromMemory).toMatchObject({ id: 'rec-abc-1', startedAt: 10, durationMs: 30, size: 2 });
    expect(fromMemory?.frames.map((f) => f.ts)).toEqual([10, 40]);

    const fromProp = normaliseSession({ id: 'p1', startedAt: 5, durationMs: 100, size: 1, frames: [{ ts: 7 }] });
    expect(fromProp).toMatchObject({ id: 'p1', startedAt: 5, durationMs: 100, size: 1 });

    expect(normaliseSession(null)).toBeNull();
    expect(normaliseSession({ frames: [] })).toBeNull(); // no id anywhere
    expect(normaliseSession({ frames: [{ ts: 3 }] }, { id: 'hinted' })).toMatchObject({ id: 'hinted', startedAt: 3 });
  });

  it('nearestFrameIndex picks the closest frame, earlier on a tie', () => {
    const frames = [{ ts: 0 }, { ts: 100 }, { ts: 200 }, { ts: 400 }];
    expect(nearestFrameIndex([], 50)).toBe(-1);
    expect(nearestFrameIndex(frames, -10)).toBe(0);
    expect(nearestFrameIndex(frames, 0)).toBe(0);
    expect(nearestFrameIndex(frames, 149)).toBe(1);
    expect(nearestFrameIndex(frames, 150)).toBe(1);
    expect(nearestFrameIndex(frames, 151)).toBe(2);
    expect(nearestFrameIndex(frames, 300)).toBe(2);
    expect(nearestFrameIndex(frames, 301)).toBe(3);
    expect(nearestFrameIndex(frames, 9_999)).toBe(3);
  });
});
