/* ============================================================================
 * eis-cues — the rf_drone rail (Guardian-RF-shaped, passive, receive-only).
 *
 * RF is an AIRSPACE and ATTRIBUTION rail, not a targeting rail (ADR D25). It
 * informs dispatch refusal, hold-after-takeoff and correlation with GNSS
 * interference. It cannot transmit and cannot command a vehicle. A record here
 * is a detection of a radio, never a decision about it.
 *
 * Blue-force whitelisting
 * -----------------------
 * Our own aircraft are the loudest drone links on site, so an un-whitelisted
 * rail would flag itself continuously. A blue-force entry is established ONLY
 * from an AUTHENTICATED own-vehicle telemetry fingerprint — never from a model
 * assertion, an operator note or the RF record's own claim about itself
 * (docs/THREAT_MODEL.md A3: a whitelist that anyone can widen is the attack).
 *
 * Two independent matches suppress a cue:
 *   - Remote-ID / serial equality with a registered own vehicle, or
 *   - position within `blueForceRadiusM` of a registered own vehicle whose
 *     telemetry is no older than `blueForceFreshnessMs`.
 * A stale fingerprint whitelists nothing: an aircraft that stopped reporting
 * cannot vouch for a radio.
 * ========================================================================== */

import { BaseRail, type RailOptions } from '../base.js';
import { haversineMeters } from '../geo.js';
import type { DecodedCue, RailId, WhitelistRule } from '../types.js';

/** Guardian-shaped passive RF record (matches the shipped rf_events.json). */
export interface RfDroneRecord {
  ts: number;
  source: 'rf_drone' | 'sdr';
  kind: 'gnss_interference' | 'drone_link' | 'remote_id' | 'hostile_drone';
  band: string;
  confidence: number;
  power_delta_db?: number;
  lat?: number;
  lon?: number;
  pilot_lat?: number;
  pilot_lon?: number;
  /** Remote-ID serial / UAS id when the emitter broadcasts one. */
  remote_id?: string;
  vehicleId?: string;
}

/** An AUTHENTICATED own-vehicle fingerprint. Nothing else may create one. */
export interface BlueForceFingerprint {
  vehicleId: string;
  /** Remote-ID serial this airframe broadcasts, when it broadcasts one. */
  remoteId?: string;
  /** Last authenticated own-telemetry position. */
  lat?: number;
  lon?: number;
  /** Epoch ms of that telemetry. Staleness disables the whitelist entry. */
  ts: number;
  /**
   * Proof the fingerprint came from the authenticated telemetry path.
   * `registerOwnVehicle` refuses anything else — an unauthenticated claim can
   * never whitelist a radio.
   */
  authenticated: true;
}

export const RF_DRONE_DEFAULT_TTL_S = 120;
export const DEFAULT_BLUE_FORCE_RADIUS_M = 120;
export const DEFAULT_BLUE_FORCE_FRESHNESS_MS = 15_000;

export interface RfDroneRailOptions extends RailOptions {
  blueForceRadiusM?: number;
  blueForceFreshnessMs?: number;
}

const RF_KINDS = new Set(['gnss_interference', 'drone_link', 'remote_id', 'hostile_drone']);

export class RfDroneRail extends BaseRail {
  readonly id: RailId = 'rf_drone';
  protected readonly defaultTtlS = RF_DRONE_DEFAULT_TTL_S;

  private readonly blueForce = new Map<string, BlueForceFingerprint>();
  private readonly radiusM: number;
  private readonly freshnessMs: number;

  constructor(options: RfDroneRailOptions = {}) {
    super(options);
    this.radiusM = options.blueForceRadiusM ?? DEFAULT_BLUE_FORCE_RADIUS_M;
    this.freshnessMs = options.blueForceFreshnessMs ?? DEFAULT_BLUE_FORCE_FRESHNESS_MS;
  }

  /**
   * Register or refresh one own-vehicle fingerprint from AUTHENTICATED
   * telemetry. Throws on an unauthenticated entry: failing loudly is the point.
   */
  registerOwnVehicle(fingerprint: BlueForceFingerprint): void {
    if (fingerprint.authenticated !== true) {
      throw new Error('blue-force whitelisting requires an authenticated own-vehicle fingerprint');
    }
    if (typeof fingerprint.vehicleId !== 'string' || fingerprint.vehicleId === '') {
      throw new Error('blue-force fingerprint needs a vehicleId');
    }
    if (!Number.isFinite(fingerprint.ts)) {
      throw new Error('blue-force fingerprint needs a telemetry timestamp');
    }
    this.blueForce.set(fingerprint.vehicleId, { ...fingerprint });
  }

  /** Drop a fingerprint (vehicle powered down, telemetry no longer trusted). */
  forgetOwnVehicle(vehicleId: string): void {
    this.blueForce.delete(vehicleId);
  }

  protected decode(payload: unknown): DecodedCue | null {
    const record = parseRfDroneRecord(payload);
    // Unlocated RF is airspace awareness, not a cue: there is nowhere to send
    // anybody. It is reported as health and never as a dispatchable anomaly.
    if (record.lat === undefined || record.lon === undefined) {
      if (record.kind === 'gnss_interference') {
        this.setHealth(
          'degraded',
          `cue rail rf_drone: GNSS interference on ${record.band} ` +
          `(confidence ${record.confidence.toFixed(2)}); no location, no cue`,
        );
      }
      return null;
    }
    return {
      id: `rf_drone-${Math.trunc(record.ts)}-${record.lat.toFixed(5)}-${record.lon.toFixed(5)}`,
      lat: record.lat,
      lon: record.lon,
      type: record.kind,
      confidence: record.confidence,
      observedAt: record.ts,
      meta: {
        band: record.band,
        ...(record.power_delta_db === undefined ? {} : { power_delta_db: record.power_delta_db }),
        ...(record.remote_id === undefined ? {} : { remote_id: record.remote_id }),
        ...(record.pilot_lat === undefined
          ? {}
          : { pilot_lat: record.pilot_lat, pilot_lon: record.pilot_lon }),
      },
    };
  }

  protected whitelistMatch(cue: DecodedCue, nowMs: number): WhitelistRule | null {
    const remoteId = cue.meta?.remote_id;
    for (const fp of this.blueForce.values()) {
      if (typeof remoteId === 'string' && fp.remoteId !== undefined && fp.remoteId === remoteId) {
        return {
          id: `blue_force_rf:${fp.vehicleId}`,
          kind: 'blue_force_rf',
          detail: `Remote ID ${remoteId} matches authenticated own vehicle ${fp.vehicleId}`,
        };
      }
      if (fp.lat === undefined || fp.lon === undefined) continue;
      const observedAt = cue.observedAt ?? nowMs;
      if (Math.abs(observedAt - fp.ts) > this.freshnessMs) continue;  // stale vouches for nothing
      const separation = haversineMeters({ lat: cue.lat, lon: cue.lon }, { lat: fp.lat, lon: fp.lon });
      if (separation <= this.radiusM) {
        return {
          id: `blue_force_rf:${fp.vehicleId}`,
          kind: 'blue_force_rf',
          detail:
            `emitter is ${separation.toFixed(0)} m from authenticated own vehicle ` +
            `${fp.vehicleId} (within ${this.radiusM} m)`,
        };
      }
    }
    return null;
  }

  protected whitelistRules(): WhitelistRule[] {
    return [...this.blueForce.values()].map((fp) => ({
      id: `blue_force_rf:${fp.vehicleId}`,
      kind: 'blue_force_rf' as const,
      detail:
        `authenticated own vehicle ${fp.vehicleId}` +
        (fp.remoteId ? ` (Remote ID ${fp.remoteId})` : '') +
        `, ${this.radiusM} m / ${Math.round(this.freshnessMs / 1000)} s`,
    }));
  }
}

/** Validate one untrusted RF record. Mirrors the planner's rf_adapter checks. */
export function parseRfDroneRecord(input: unknown): RfDroneRecord {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('invalid RF record: must be an object');
  }
  const raw = input as Record<string, unknown>;
  if (raw.source !== 'rf_drone' && raw.source !== 'sdr') {
    throw new Error('invalid RF record: source must be rf_drone|sdr');
  }
  if (typeof raw.kind !== 'string' || !RF_KINDS.has(raw.kind)) {
    throw new Error('invalid RF record: unsupported kind');
  }
  if (typeof raw.band !== 'string' || raw.band.trim() === '') {
    throw new Error('invalid RF record: band must be a non-empty string');
  }
  if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) ||
      raw.confidence < 0 || raw.confidence > 1) {
    throw new Error('invalid RF record: confidence must be in [0, 1]');
  }
  if (typeof raw.ts !== 'number' || !Number.isFinite(raw.ts) || raw.ts < 0) {
    throw new Error('invalid RF record: ts must be a non-negative epoch-ms number');
  }
  const coord = (name: 'lat' | 'lon' | 'pilot_lat' | 'pilot_lon'): number | undefined => {
    const value = raw[name];
    if (value === undefined) return undefined;
    const isLat = name === 'lat' || name === 'pilot_lat';
    const limit = isLat ? 90 : 180;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < -limit || value > limit) {
      throw new Error(`invalid RF record: ${name} is outside its coordinate range`);
    }
    return value;
  };
  const lat = coord('lat');
  const lon = coord('lon');
  if ((lat === undefined) !== (lon === undefined)) {
    throw new Error('invalid RF record: lat and lon must be supplied together');
  }
  const pilotLat = coord('pilot_lat');
  const pilotLon = coord('pilot_lon');
  if ((pilotLat === undefined) !== (pilotLon === undefined)) {
    throw new Error('invalid RF record: pilot_lat and pilot_lon must be supplied together');
  }
  if (raw.power_delta_db !== undefined &&
      (typeof raw.power_delta_db !== 'number' || !Number.isFinite(raw.power_delta_db))) {
    throw new Error('invalid RF record: power_delta_db must be finite when present');
  }
  if (raw.remote_id !== undefined && typeof raw.remote_id !== 'string') {
    throw new Error('invalid RF record: remote_id must be a string when present');
  }
  return {
    ts: raw.ts,
    source: raw.source,
    kind: raw.kind as RfDroneRecord['kind'],
    band: raw.band,
    confidence: raw.confidence,
    ...(raw.power_delta_db === undefined ? {} : { power_delta_db: raw.power_delta_db as number }),
    ...(lat === undefined ? {} : { lat, lon: lon as number }),
    ...(pilotLat === undefined ? {} : { pilot_lat: pilotLat, pilot_lon: pilotLon as number }),
    ...(raw.remote_id === undefined ? {} : { remote_id: raw.remote_id as string }),
    ...(typeof raw.vehicleId === 'string' ? { vehicleId: raw.vehicleId } : {}),
  };
}
