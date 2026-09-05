/* ============================================================================
 * eis-cues — the one adapter every sensing rail implements (ADR D25).
 *
 * A rail observes, normalises and emits. It never commands: no rail here can
 * produce a plan, a route, an altitude, a setpoint, a mode change or any wire
 * message other than the contract's `anomaly` and `healthEvent`.
 * ========================================================================== */

import type {
  AnomalyMessage, AnomalySource, HealthComponent, HealthEventMessage, Unsubscribe,
} from './contract.js';

/** Rail identity. Deliberately identical to the contract's `AnomalySource`:
 *  one rail, one source value, no translation table. */
export type RailId = AnomalySource;

export const RAIL_IDS: RailId[] = [
  'sentinel2', 'sar', 'sdr', 'rf_drone', 'cctv', 'fence_sensor', 'drone_survey',
];

/**
 * Health badge state.
 *
 * There is deliberately no `unknown`: a rail that has not started is `stopped`
 * and a rail that has failed is `failed` (ADR D25 — a failed rail reports
 * `failed`, never `healthy` and never `unknown`-as-nominal).
 */
export type RailHealthState = 'stopped' | 'starting' | 'healthy' | 'degraded' | 'failed';

/** True only for the one state in which the rail's silence means "nothing seen". */
export function railIsNominal(state: RailHealthState): boolean {
  return state === 'healthy';
}

/** A camera zone that currently cannot be observed. No dispatch may originate
 *  from a blind zone. */
export interface BlindZone {
  cameraId: string;
  zone: string;
  reason: string;
}

export interface RailHealth {
  rail: RailId;
  state: RailHealthState;
  /** Human-readable, always naming the rail. */
  detail: string;
  /** Epoch ms this state began. */
  since: number;
  /** Epoch ms of the last cue this rail admitted, when any. */
  lastCueAt?: number;
  /** Zones this rail currently cannot see (cctv). Empty for every other rail. */
  blindZones: BlindZone[];
  /** Counters since `start()`, for the operator badge and the audit trail. */
  counts: {
    observed: number;   // raw records decoded
    emitted: number;    // anomalies handed to the bus
    suppressed: number; // dropped by a whitelist rule
    rateLimited: number;// dropped by the rail's own rate limit
    expired: number;    // dropped because observedAt + ttl_s had passed
    rejected: number;   // dropped as invalid (bad calibration, unknown camera…)
  };
}

/** Why a cue was suppressed. Named so the audit log can record the rule. */
export type WhitelistKind =
  | 'blue_force_rf' | 'staffed_hours' | 'active_gate' | 'delivery_window';

export interface WhitelistRule {
  id: string;
  kind: WhitelistKind;
  detail: string;
}

/** What `whitelist()` reports: the rules in force plus what they suppressed. */
export interface WhitelistView {
  rail: RailId;
  rules: WhitelistRule[];
  suppressed: number;
  /** The most recent suppressions, newest last. Bounded. */
  recent: SuppressionRecord[];
}

export interface SuppressionRecord {
  ts: number;
  rule: WhitelistRule;
  /** The cue id that was suppressed. */
  cueId: string;
}

/**
 * A decoded observation, before normalisation. Rails produce these; the base
 * rail stamps ids, `observedAt`, `ttl_s` and `vehicleId` and turns them into
 * contract anomalies.
 */
export interface DecodedCue {
  /** Stable id suffix. The rail prefixes it; a rail that has a natural id
   *  (a VMS event id, a satellite blob id) should pass it here. */
  id?: string;
  lat: number;
  lon: number;
  /** Anomaly KIND, e.g. 'change', 'motion', 'hostile_drone'. */
  type: string;
  confidence: number;
  thumbnail?: string;
  /** Epoch ms the cue was OBSERVED. Defaults to the scheduler's now. */
  observedAt?: number;
  /** Overrides the rail's default TTL. */
  ttl_s?: number;
  cameraId?: string;
  /** Rail-local zone, used for blind-zone and normalcy checks. Never emitted. */
  zone?: string;
  /** Coarse class label, used for confidence and normalcy. Never emitted. */
  class?: string;
  /** Rail-local extras used by whitelisting only. Never emitted. */
  meta?: Record<string, unknown>;
}

/** The one adapter (ADR D25). `stop()` is part of the seam so a rail can be
 *  torn down without tearing down the bus. */
export interface CueAdapter {
  readonly id: RailId;
  /** Idempotent. Resolves once the rail is running or has reported `failed`. */
  start(): Promise<void>;
  /** Idempotent. A stopped rail reports `stopped`, never `healthy`. */
  stop(): Promise<void>;
  /** Normalised cues. The ONLY dispatchable output of a rail. */
  onAnomaly(cb: (m: AnomalyMessage) => void): Unsubscribe;
  /** Health transitions, as contract `healthEvent` messages. */
  onHealth(cb: (m: HealthEventMessage) => void): Unsubscribe;
  /** Every whitelist suppression, for the audit log. */
  onSuppression(cb: (r: SuppressionRecord) => void): Unsubscribe;
  /** Current badge state. Never fabricates nominal. */
  health(): RailHealth;
  /** Rules in force and what they have suppressed. */
  whitelist(): WhitelistView;
}

/**
 * Contract `HealthComponent` per rail.
 *
 * GAP: the contract has no cue-rail health component. Rails may not add wire
 * messages or widen a published union, so each maps onto the closest existing
 * component and ALWAYS names itself in `detail` (`cue rail <id>: …`). The
 * rail-precise state stays available through `health()` / `CueBus.health()`.
 */
export const RAIL_HEALTH_COMPONENT: Record<RailId, HealthComponent> = {
  cctv: 'camera',
  sdr: 'sdr',
  rf_drone: 'sdr',
  sentinel2: 'site_model',
  sar: 'site_model',
  fence_sensor: 'site_model',
  drone_survey: 'site_model',
};

/** Sliding-window rate limit. Applied by the rail BEFORE the shared cue budget. */
export interface RateLimit {
  maxEvents: number;
  windowMs: number;
}
