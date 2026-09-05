/* ============================================================================
 * eis-cues — the SDR rail. Wraps ground/sdr; the sidecar is not moved.
 *
 * The sidecar (`ground/sdr/sidecar.py`) is a receive-only process that writes
 * newline-delimited JSON on stdout. This rail consumes exactly that shape —
 * `spectrum`, `healthEvent` and `rfEvent` records — and adds no transmit path
 * and no new wire message.
 *
 * What each record becomes:
 *   healthEvent(component 'sdr')  → the rail's badge state, verbatim detail
 *   spectrum(state 'degraded')    → badge degraded; 'nominal' → healthy
 *   rfEvent WITHOUT lat/lon       → badge degraded, NO cue
 *   rfEvent WITH lat/lon          → a cue
 *
 * The unlocated case is the common one: the shipped sidecar only reports GNSS
 * interference, which has no position. Interference escalates WITHOUT flight —
 * there is nowhere to send anybody, and inventing a location for a jammer would
 * be a fabricated cue.
 * ========================================================================== */

import { BaseRail, type RailOptions } from '../base.js';
import type { DecodedCue, RailHealthState, RailId } from '../types.js';

export const SDR_DEFAULT_TTL_S = 300;

/** One NDJSON record from the sidecar. */
export type SdrRecord =
  | { type: 'spectrum'; ts: number; vehicleId: string; state: string; bands: unknown[] }
  | { type: 'healthEvent'; ts: number; vehicleId: string; component: string; state: string; detail: string }
  | {
    type: 'rfEvent'; ts: number; vehicleId: string; source: string; kind: string;
    band: string; confidence: number; power_delta_db?: number; lat?: number; lon?: number;
  };

/** Sidecar health states mapped onto the rail badge. `warming` is NOT healthy:
 *  a rail still building its baseline has not yet seen anything. */
const SIDECAR_HEALTH: Record<string, RailHealthState> = {
  warming: 'starting',
  nominal: 'healthy',
  degraded: 'degraded',
  saturated: 'degraded',
  no_device: 'failed',
};

export class SdrRail extends BaseRail {
  readonly id: RailId = 'sdr';
  protected readonly defaultTtlS = SDR_DEFAULT_TTL_S;

  constructor(options: RailOptions = {}) {
    super(options);
  }

  protected decode(payload: unknown, nowMs: number): DecodedCue | null {
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('invalid SDR record: must be an object');
    }
    const r = payload as Record<string, unknown>;
    const ts = typeof r.ts === 'number' && Number.isFinite(r.ts) ? r.ts : nowMs;

    if (r.type === 'healthEvent') {
      if (r.component !== 'sdr') return null;
      const state = SIDECAR_HEALTH[String(r.state)] ?? 'degraded';
      this.setHealth(state, `cue rail sdr: ${String(r.detail ?? r.state)}`);
      return null;
    }

    if (r.type === 'spectrum') {
      const state = SIDECAR_HEALTH[String(r.state)] ?? 'degraded';
      this.setHealth(state, `cue rail sdr: receive spectrum ${String(r.state)}`);
      return null;
    }

    if (r.type !== 'rfEvent') {
      throw new Error(`invalid SDR record: unsupported type ${JSON.stringify(r.type)}`);
    }
    if (typeof r.confidence !== 'number' || !Number.isFinite(r.confidence) ||
        r.confidence < 0 || r.confidence > 1) {
      throw new Error('invalid SDR rfEvent: confidence must be in [0, 1]');
    }
    const band = typeof r.band === 'string' && r.band !== '' ? r.band : 'unknown band';
    if (typeof r.lat !== 'number' || typeof r.lon !== 'number') {
      // No location → escalate as health, never as a dispatchable cue.
      this.setHealth(
        'degraded',
        `cue rail sdr: ${String(r.kind)} on ${band} ` +
        `(confidence ${r.confidence.toFixed(2)}); unlocated, no cue raised`,
      );
      return null;
    }
    return {
      id: `sdr-${Math.trunc(ts)}-${r.lat.toFixed(5)}-${r.lon.toFixed(5)}`,
      lat: r.lat,
      lon: r.lon,
      type: String(r.kind),
      confidence: r.confidence,
      observedAt: ts,
      meta: {
        band,
        ...(typeof r.power_delta_db === 'number' ? { power_delta_db: r.power_delta_db } : {}),
      },
    };
  }
}

/** Split a sidecar NDJSON chunk into records. Blank lines are skipped; a
 *  malformed line throws so a corrupt stream is never silently narrowed. */
export function parseSdrNdjson(text: string): SdrRecord[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line, i) => {
      try {
        return JSON.parse(line) as SdrRecord;
      } catch (err) {
        throw new Error(`invalid SDR NDJSON on line ${i + 1}: ${(err as Error).message}`);
      }
    });
}
