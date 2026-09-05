/* ============================================================================
 * eis-cues — the scripted fixture format every rail replays.
 *
 * One shape for all seven rails: `fixtures/<railId>_events.json`. The payload
 * of a `cue` event is RAIL-NATIVE (a VMS event for cctv, a sidecar NDJSON
 * record for sdr, a Guardian-shaped record for rf_drone…), so a fixture stays
 * an honest sample of what the real source produces and the rail's decoder is
 * exercised rather than bypassed.
 *
 * Scripted mode is selected explicitly (docs/CUE_RAILS_SPEC.md). Nothing on the
 * demo or test path touches the network.
 * ========================================================================== */

import type { RailHealthState, RailId } from './types.js';

export interface FixtureCueEvent {
  /** Milliseconds after `start()` at which the source produced this record. */
  atMs: number;
  kind?: 'cue';
  /** Rail-native record, handed to the rail's decoder unmodified. */
  payload: unknown;
}

export interface FixtureHealthEvent {
  atMs: number;
  kind: 'health';
  state: RailHealthState;
  detail: string;
}

/** Scripted camera outage — the "camera offline" failure mode. */
export interface FixtureCameraEvent {
  atMs: number;
  kind: 'cameraOffline' | 'cameraOnline';
  cameraId: string;
  detail?: string;
}

export type FixtureEvent = FixtureCueEvent | FixtureHealthEvent | FixtureCameraEvent;

/**
 * How the timestamps INSIDE a payload are expressed.
 *
 *  'relative' (the default) — `ts` / `observedAt` are offsets in ms from the
 *    moment `start()` was called, and the rail rebases them onto the clock. A
 *    relative fixture stays replayable at any wall-clock time, so a demo run
 *    next month does not produce cues that expired last year.
 *  'absolute' — the payload carries real epoch ms and is used verbatim. Use it
 *    to replay a captured incident, TTL expiry included.
 */
export type FixtureTimebase = 'relative' | 'absolute';

export interface CueFixture {
  schema_version: number;
  rail: RailId;
  /** Honest provenance. A scripted fixture never claims live observation. */
  provenance: string;
  timebase: FixtureTimebase;
  events: FixtureEvent[];
}

/** Payload timestamp fields rebased for a 'relative' fixture. */
export const REBASED_TS_FIELDS = ['ts', 'observedAt'] as const;

/**
 * Shift a payload's timestamps onto the clock. Non-objects and payloads with no
 * timestamp are returned untouched; nothing else about the record is altered,
 * so the rail's own decoder still validates the real shape.
 */
export function rebasePayload(payload: unknown, offsetMs: number): unknown {
  if (offsetMs === 0) return payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return payload;
  const source = payload as Record<string, unknown>;
  let changed = false;
  const out: Record<string, unknown> = { ...source };
  for (const field of REBASED_TS_FIELDS) {
    const value = source[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[field] = value + offsetMs;
      changed = true;
    }
  }
  return changed ? out : payload;
}

const HEALTH_STATES = new Set<RailHealthState>([
  'stopped', 'starting', 'healthy', 'degraded', 'failed',
]);

function assertAtMs(v: unknown, ctx: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new Error(`invalid cue fixture: ${ctx}.atMs must be a finite number >= 0`);
  }
  return v;
}

/** Validate already-parsed fixture JSON. Browser-safe (no file I/O). */
export function parseCueFixture(data: unknown, expectedRail?: RailId): CueFixture {
  if (typeof data !== 'object' || data === null) {
    throw new Error('invalid cue fixture: root must be an object');
  }
  const d = data as Record<string, unknown>;
  if (typeof d.rail !== 'string') throw new Error('invalid cue fixture: "rail" must be a string');
  if (expectedRail !== undefined && d.rail !== expectedRail) {
    throw new Error(`invalid cue fixture: rail ${JSON.stringify(d.rail)} does not match ${expectedRail}`);
  }
  if (typeof d.provenance !== 'string' || d.provenance === '') {
    throw new Error('invalid cue fixture: "provenance" must be a non-empty string');
  }
  if (!Array.isArray(d.events)) throw new Error('invalid cue fixture: "events" must be an array');

  const events: FixtureEvent[] = d.events.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`invalid cue fixture: events[${i}] must be an object`);
    }
    const e = raw as Record<string, unknown>;
    const atMs = assertAtMs(e.atMs, `events[${i}]`);
    const kind = e.kind ?? 'cue';
    if (kind === 'cue') {
      if (!('payload' in e)) {
        throw new Error(`invalid cue fixture: events[${i}] of kind "cue" needs a payload`);
      }
      return { atMs, kind: 'cue', payload: e.payload };
    }
    if (kind === 'health') {
      if (typeof e.state !== 'string' || !HEALTH_STATES.has(e.state as RailHealthState)) {
        throw new Error(`invalid cue fixture: events[${i}].state must be a rail health state`);
      }
      if (typeof e.detail !== 'string' || e.detail === '') {
        throw new Error(`invalid cue fixture: events[${i}].detail must be a non-empty string`);
      }
      return { atMs, kind: 'health', state: e.state as RailHealthState, detail: e.detail };
    }
    if (kind === 'cameraOffline' || kind === 'cameraOnline') {
      if (typeof e.cameraId !== 'string' || e.cameraId === '') {
        throw new Error(`invalid cue fixture: events[${i}].cameraId must be a non-empty string`);
      }
      return {
        atMs,
        kind,
        cameraId: e.cameraId,
        ...(typeof e.detail === 'string' ? { detail: e.detail } : {}),
      };
    }
    throw new Error(`invalid cue fixture: events[${i}].kind ${JSON.stringify(kind)} is not supported`);
  });

  if (d.timebase !== undefined && d.timebase !== 'relative' && d.timebase !== 'absolute') {
    throw new Error('invalid cue fixture: "timebase" must be "relative" or "absolute"');
  }

  return {
    schema_version: typeof d.schema_version === 'number' ? d.schema_version : 1,
    rail: d.rail as RailId,
    provenance: d.provenance,
    timebase: (d.timebase as FixtureTimebase | undefined) ?? 'relative',
    events,
  };
}

export function isCueEvent(e: FixtureEvent): e is FixtureCueEvent {
  return (e as FixtureCueEvent).kind === undefined || e.kind === 'cue';
}
