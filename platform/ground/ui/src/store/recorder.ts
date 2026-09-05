/* ============================================================================
 * Drone Safety Platform — in-memory recorder
 * ----------------------------------------------------------------------------
 * A tiny flight-recording buffer the App and LogBrowser use when the Electron
 * window.eis.recorder bridge is absent (browser dev server). Records timestamped
 * {ts, telemetry?, tracking?} frames into in-memory sessions and can list/load
 * them back. When the bridge IS present, callers should prefer it; this module
 * provides the same surface so the UI can be written once.
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

function makeId(): string {
  return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toMeta(session: RecordingSession): RecordingMeta {
  return {
    id: session.id,
    startedAt: session.startedAt,
    durationMs: session.durationMs,
    size: session.frames.length,
  };
}

function createRecorder(): Recorder {
  const sessions = new Map<string, RecordingSession>();
  let active: RecordingSession | null = null;

  return {
    isRecording() {
      return active !== null;
    },
    currentId() {
      return active?.id ?? null;
    },
    start(meta = {}) {
      if (active) this.stop();
      const id = makeId();
      const startedAt = Date.now();
      active = { id, meta, startedAt, durationMs: 0, size: 0, frames: [] };
      sessions.set(id, active);
      return id;
    },
    stop() {
      if (!active) return null;
      active.durationMs = Date.now() - active.startedAt;
      active.size = active.frames.length;
      const meta = toMeta(active);
      active = null;
      return meta;
    },
    append(frame) {
      if (!active) return;
      active.frames.push(frame);
      active.size = active.frames.length;
      active.durationMs = frame.ts - active.startedAt;
    },
    list() {
      return Array.from(sessions.values())
        .map(toMeta)
        .sort((a, b) => b.startedAt - a.startedAt);
    },
    load(id) {
      return sessions.get(id) ?? null;
    },
    clear() {
      active = null;
      sessions.clear();
    },
  };
}

export const recorder: Recorder = createRecorder();
