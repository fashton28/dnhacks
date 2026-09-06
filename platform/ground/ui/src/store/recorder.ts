/* ============================================================================
 * Drone Safety Platform — in-memory flight recorder
 * ----------------------------------------------------------------------------
 * The browser-side stand-in for the Electron shell's on-disk recorder
 * (window.eis.recorder). It keeps every session of this page's lifetime in
 * memory: `start` opens a session (closing any that is still open), `append`
 * adds one timestamped frame to the open session, `stop` seals it, and
 * `list`/`load` read sessions back newest-first. The surface mirrors the
 * bridge closely enough that the log browser can drive either one.
 *
 * Frames are `{ ts, telemetry?, tracking? }`. The shell's NDJSON files hold
 * the raw contract messages instead (the App appends telemetry/tracking
 * messages as they arrive), so `toRecordedFrame` folds either form into the
 * frame shape the log browser scrubs through.
 * ========================================================================== */
import type { Telemetry, TrackingStatus } from '@/contract';

export interface RecordedFrame {
  ts: number;
  telemetry?: Telemetry;
  tracking?: TrackingStatus;
}

export interface RecordingMeta {
  id: string;
  startedAt: number;
  durationMs: number;
  size: number; // frame count
}

export interface RecordingSession extends RecordingMeta {
  meta: Record<string, unknown>;
  frames: RecordedFrame[];
}

export interface Recorder {
  isRecording(): boolean;
  currentId(): string | null;
  start(meta?: Record<string, unknown>): string;
  stop(): RecordingMeta | null;
  append(frame: RecordedFrame): void;
  list(): RecordingMeta[];
  load(id: string): RecordingSession | null;
  clear(): void;
}

export interface RecorderOptions {
  /** Clock for session start/stop stamps (defaults to Date.now). */
  now?: () => number;
  /** Session id factory; the default yields `rec-<base36 start>-<seq><entropy>`. */
  makeId?: (startedAt: number, sequence: number) => string;
}

/** `rec-` + base36 start time + a per-recorder sequence + 4 chars of entropy. */
export function defaultRecordingId(startedAt: number, sequence: number): string {
  const entropy = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0');
  return `rec-${Math.max(0, Math.floor(startedAt)).toString(36)}-${sequence.toString(36)}${entropy}`;
}

/**
 * Fold one recorded record into a scrubbable frame. Accepts the recorder's
 * own `{ ts, telemetry?, tracking? }` frames and the raw contract messages
 * the shell writes to disk (`type: 'telemetry' | 'tracking'`). Records that
 * carry nothing the timeline can show (status text, malformed lines) yield
 * null.
 */
export function toRecordedFrame(record: unknown): RecordedFrame | null {
  if (record === null || typeof record !== 'object') return null;
  const r = record as Record<string, unknown>;
  const ts = typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : null;
  if (ts === null) return null;

  if (r.type === 'telemetry') return { ts, telemetry: r as unknown as Telemetry };
  if (r.type === 'tracking') return { ts, tracking: r as unknown as TrackingStatus };
  if (typeof r.type === 'string') return null; // some other wire message — nothing to scrub

  const frame: RecordedFrame = { ts };
  if (r.telemetry !== null && typeof r.telemetry === 'object') frame.telemetry = r.telemetry as Telemetry;
  if (r.tracking !== null && typeof r.tracking === 'object') frame.tracking = r.tracking as TrackingStatus;
  return frame;
}

export function createRecorder(options: RecorderOptions = {}): Recorder {
  const now = options.now ?? Date.now;
  const makeId = options.makeId ?? defaultRecordingId;
  /** Every session of this recorder, oldest first. */
  const archive: RecordingSession[] = [];
  let live: RecordingSession | null = null;
  let sequence = 0;

  const summarise = (s: RecordingSession): RecordingMeta => ({
    id: s.id,
    startedAt: s.startedAt,
    durationMs: s.durationMs,
    size: s.size,
  });

  /** Close the open session (wall-clock duration) and hand back its summary. */
  const seal = (): RecordingMeta | null => {
    if (!live) return null;
    const closing = live;
    live = null;
    closing.durationMs = Math.max(closing.durationMs, now() - closing.startedAt, 0);
    closing.size = closing.frames.length;
    return summarise(closing);
  };

  return {
    isRecording: () => live !== null,
    currentId: () => live?.id ?? null,

    start(meta = {}) {
      seal();
      const startedAt = now();
      sequence += 1;
      const session: RecordingSession = {
        id: makeId(startedAt, sequence),
        startedAt,
        durationMs: 0,
        size: 0,
        meta: { ...meta },
        frames: [],
      };
      archive.push(session);
      live = session;
      return session.id;
    },

    stop: seal,

    append(frame) {
      if (!live) return;
      live.frames.push(frame);
      live.size = live.frames.length;
      // Elapsed time tracks the newest frame but never runs backwards.
      live.durationMs = Math.max(live.durationMs, frame.ts - live.startedAt, 0);
    },

    list() {
      // Reverse before the (stable) sort so equal start stamps still come
      // out newest-recorded first.
      return archive.slice().reverse().map(summarise).sort((a, b) => b.startedAt - a.startedAt);
    },

    load(id) {
      return archive.find((s) => s.id === id) ?? null;
    },

    clear() {
      live = null;
      archive.length = 0;
    },
  };
}

export const recorder: Recorder = createRecorder();
