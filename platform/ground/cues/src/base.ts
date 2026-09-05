/* ============================================================================
 * eis-cues — BaseRail: everything every rail does identically.
 *
 * Pipeline for one observation, in this order:
 *
 *   decode  →  validate  →  TTL expiry  →  blind-zone  →  whitelist
 *           →  per-source rate limit  →  emit `anomaly`
 *
 * The order matters. Expiry precedes everything because a stale cue is not a
 * cue. The whitelist runs before the rate limit so a suppressed cue never
 * consumes a limiter slot. The rail's own limit runs before the shared cue
 * budget (applied by CueBus), so one noisy source cannot starve the others.
 *
 * A rail never throws at its subscribers, and a throwing subscriber never
 * stops the rail or its siblings.
 * ========================================================================== */

import type {
  AnomalyMessage, HealthEventMessage, Unsubscribe,
} from './contract.js';
import { DEFAULT_VEHICLE_ID } from './contract.js';
import { BoundedIdSet } from './dedupe.js';
import {
  isCueEvent, rebasePayload, type CueFixture, type FixtureEvent,
} from './fixture.js';
import {
  DEFAULT_RAIL_RATE_LIMIT, SlidingWindowLimiter, resolveRailRateLimit,
} from './rateLimit.js';
import { RealScheduler, type Scheduler } from './scheduler.js';
import {
  RAIL_HEALTH_COMPONENT,
  type BlindZone, type CueAdapter, type DecodedCue, type RailHealth,
  type RailHealthState, type RailId, type RateLimit, type SuppressionRecord,
  type WhitelistRule, type WhitelistView,
} from './types.js';

/** Shared construction options. Every rail accepts these. */
export interface RailOptions {
  vehicleId?: string;
  scheduler?: Scheduler;
  /** Scripted fixture to replay. Scripted mode is selected explicitly. */
  fixture?: CueFixture;
  /** Overrides the rail's default cue lifetime, seconds. */
  ttlS?: number;
  /** Per-rail limit, applied before the shared cue budget. */
  rateLimit?: Partial<RateLimit>;
  /** Bound on the suppression ring buffer surfaced by `whitelist()`. */
  suppressionHistory?: number;
}

const DEFAULT_SUPPRESSION_HISTORY = 32;

type Listener<T> = (value: T) => void;

function emitAll<T>(listeners: Set<Listener<T>>, value: T): void {
  for (const cb of [...listeners]) {
    try {
      cb(value);
    } catch {
      // A subscriber's failure is its own. It never stops the rail.
    }
  }
}

export abstract class BaseRail implements CueAdapter {
  abstract readonly id: RailId;
  /** Cue lifetime this rail stamps when a record does not carry one. */
  protected abstract readonly defaultTtlS: number;

  protected readonly vehicleId: string;
  protected readonly scheduler: Scheduler;
  protected readonly fixture?: CueFixture;

  private readonly anomalyListeners = new Set<Listener<AnomalyMessage>>();
  private readonly healthListeners = new Set<Listener<HealthEventMessage>>();
  private readonly suppressionListeners = new Set<Listener<SuppressionRecord>>();

  private readonly rateLimitOption?: Partial<RateLimit>;
  private limiterInstance?: SlidingWindowLimiter;
  private readonly ttlOverrideS?: number;
  private readonly suppressionHistory: number;
  private readonly timers: number[] = [];
  private readonly recentSuppressions: SuppressionRecord[] = [];
  private readonly emittedIds = new BoundedIdSet();
  private readonly offlineCameras = new Map<string, string>();

  private state: RailHealthState = 'stopped';
  private stateDetail = 'not started';
  private stateSince = 0;
  private lastCueAt?: number;
  private started = false;
  private seq = 0;
  /** Offset added to a relative fixture's payload timestamps; 0 for absolute. */
  private replayEpoch = 0;

  private counts: RailHealth['counts'] = {
    observed: 0, emitted: 0, suppressed: 0, rateLimited: 0, expired: 0, rejected: 0,
  };

  constructor(options: RailOptions = {}) {
    this.vehicleId = options.vehicleId ?? DEFAULT_VEHICLE_ID;
    this.scheduler = options.scheduler ?? new RealScheduler();
    this.fixture = options.fixture;
    this.ttlOverrideS = options.ttlS;
    this.rateLimitOption = options.rateLimit;
    this.suppressionHistory = options.suppressionHistory ?? DEFAULT_SUPPRESSION_HISTORY;
    this.stateSince = this.scheduler.now();
  }

  /* ---- rail hooks -------------------------------------------------------- */

  /** Turn one rail-native record into a cue, or null to ignore it silently.
   *  Throwing marks the record rejected; it never stops the rail. */
  protected abstract decode(payload: unknown, nowMs: number): DecodedCue | null;

  /** Per-rail default limit. Overridden by cctv, which limits per camera. */
  protected defaultRateLimit(): RateLimit {
    return DEFAULT_RAIL_RATE_LIMIT;
  }

  /**
   * The limiter is built on FIRST USE, not in the constructor: a subclass's
   * own fields are not initialised until after `super()` returns, so a
   * constructor-time `defaultRateLimit()` would read them as undefined and
   * silently fall back to a looser cap.
   */
  private get limiter(): SlidingWindowLimiter {
    if (!this.limiterInstance) {
      this.limiterInstance = new SlidingWindowLimiter(
        resolveRailRateLimit(this.rateLimitOption ?? this.defaultRateLimit()),
      );
    }
    return this.limiterInstance;
  }

  /** Limiter key. cctv keys per camera so one noisy camera is contained. */
  protected limiterKey(cue: DecodedCue): string {
    return cue.cameraId ? `${this.id}:${cue.cameraId}` : this.id;
  }

  /** A whitelist rule that explains this cue, or null. */
  protected whitelistMatch(_cue: DecodedCue, _nowMs: number): WhitelistRule | null {
    return null;
  }

  /** Rules currently in force, for `whitelist()`. */
  protected whitelistRules(): WhitelistRule[] {
    return [];
  }

  /** Rail-specific start work (opening a live source). Scripted rails do none. */
  protected async onStart(): Promise<void> {
    /* no live source by default */
  }

  protected async onStop(): Promise<void> {
    /* no live source by default */
  }

  /* ---- CueAdapter -------------------------------------------------------- */

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.setHealth('starting', `cue rail ${this.id}: starting`);
    try {
      await this.onStart();
    } catch (err) {
      this.fail(`start failed: ${(err as Error).message}`);
      return;
    }
    if (this.fixture) this.scheduleFixture(this.fixture);
    if (this.state === 'starting') {
      this.setHealth(
        'healthy',
        this.fixture
          ? `cue rail ${this.id}: replaying scripted fixture (${this.fixture.provenance})`
          : `cue rail ${this.id}: running`,
      );
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const handle of this.timers.splice(0)) this.scheduler.cancel(handle);
    try {
      await this.onStop();
    } catch {
      // Teardown failure must not leave the rail claiming to be running.
    }
    this.setHealth('stopped', `cue rail ${this.id}: stopped`);
  }

  onAnomaly(cb: (m: AnomalyMessage) => void): Unsubscribe {
    this.anomalyListeners.add(cb);
    return () => this.anomalyListeners.delete(cb);
  }

  onHealth(cb: (m: HealthEventMessage) => void): Unsubscribe {
    this.healthListeners.add(cb);
    return () => this.healthListeners.delete(cb);
  }

  onSuppression(cb: (r: SuppressionRecord) => void): Unsubscribe {
    this.suppressionListeners.add(cb);
    return () => this.suppressionListeners.delete(cb);
  }

  health(): RailHealth {
    return {
      rail: this.id,
      state: this.state,
      detail: this.stateDetail,
      since: this.stateSince,
      ...(this.lastCueAt === undefined ? {} : { lastCueAt: this.lastCueAt }),
      blindZones: this.blindZones(),
      counts: { ...this.counts },
    };
  }

  whitelist(): WhitelistView {
    return {
      rail: this.id,
      rules: this.whitelistRules(),
      suppressed: this.counts.suppressed,
      recent: [...this.recentSuppressions],
    };
  }

  /* ---- health ------------------------------------------------------------ */

  /** Zones this rail cannot currently observe. Only cctv has any. */
  protected blindZones(): BlindZone[] {
    return [];
  }

  protected cameraIsOffline(cameraId: string): boolean {
    return this.offlineCameras.has(cameraId);
  }

  protected offlineCameraReason(cameraId: string): string | undefined {
    return this.offlineCameras.get(cameraId);
  }

  protected markCameraOffline(cameraId: string, detail: string): void {
    this.offlineCameras.set(cameraId, detail);
    // A camera transition must never lift a rail out of `failed`: losing one
    // camera is not evidence that the source that failed has come back.
    if (this.state === 'failed') return;
    // The rail is still up; its coverage is not. Degraded, never healthy.
    this.setHealth('degraded', `cue rail ${this.id}: camera ${cameraId} offline — ${detail}`);
  }

  protected markCameraOnline(cameraId: string): void {
    if (!this.offlineCameras.delete(cameraId)) return;
    if (this.state === 'failed') return;
    if (this.offlineCameras.size === 0 && this.state === 'degraded') {
      this.setHealth('healthy', `cue rail ${this.id}: all cameras reporting`);
    } else if (this.offlineCameras.size > 0) {
      this.setHealth(
        'degraded',
        `cue rail ${this.id}: ${this.offlineCameras.size} camera(s) offline`,
      );
    }
  }

  /** Take this rail out of service. Siblings are unaffected. */
  protected fail(reason: string): void {
    this.setHealth('failed', `cue rail ${this.id}: ${reason}`);
  }

  protected setHealth(state: RailHealthState, detail: string): void {
    const now = this.scheduler.now();
    if (this.state === state && this.stateDetail === detail) return;
    this.state = state;
    this.stateDetail = detail;
    this.stateSince = now;
    emitAll(this.healthListeners, {
      type: 'healthEvent',
      ts: now,
      vehicleId: this.vehicleId,
      component: RAIL_HEALTH_COMPONENT[this.id],
      state,
      detail,
    });
  }

  /** Raise a health event without changing the badge (calibration warnings). */
  protected warn(detail: string): void {
    emitAll(this.healthListeners, {
      type: 'healthEvent',
      ts: this.scheduler.now(),
      vehicleId: this.vehicleId,
      component: RAIL_HEALTH_COMPONENT[this.id],
      state: 'warning',
      detail: `cue rail ${this.id}: ${detail}`,
    });
  }

  /* ---- ingest ------------------------------------------------------------ */

  /** Feed one rail-native record through the pipeline. Live sources call this. */
  ingest(payload: unknown): AnomalyMessage | null {
    const now = this.scheduler.now();
    this.counts.observed += 1;
    let decoded: DecodedCue | null;
    try {
      decoded = this.decode(payload, now);
    } catch (err) {
      this.counts.rejected += 1;
      this.warn(`rejected a record: ${(err as Error).message}`);
      return null;
    }
    if (decoded === null) return null;
    return this.publish(decoded, now);
  }

  /** Normalise, gate and emit one decoded cue. */
  protected publish(cue: DecodedCue, nowMs: number): AnomalyMessage | null {
    if (!Number.isFinite(cue.lat) || cue.lat < -90 || cue.lat > 90 ||
        !Number.isFinite(cue.lon) || cue.lon < -180 || cue.lon > 180) {
      this.counts.rejected += 1;
      this.warn('rejected a cue with an out-of-range coordinate');
      return null;
    }
    if (!Number.isFinite(cue.confidence) || cue.confidence < 0 || cue.confidence > 1) {
      this.counts.rejected += 1;
      this.warn('rejected a cue whose confidence is outside [0, 1]');
      return null;
    }

    const observedAt = cue.observedAt ?? nowMs;
    const ttlS = cue.ttl_s ?? this.ttlOverrideS ?? this.defaultTtlS;
    if (!Number.isFinite(ttlS) || ttlS <= 0) {
      this.counts.rejected += 1;
      this.warn('rejected a cue with a non-positive ttl_s');
      return null;
    }
    if (observedAt + ttlS * 1000 <= nowMs) {
      this.counts.expired += 1;
      return null;
    }

    if (cue.cameraId && this.cameraIsOffline(cue.cameraId)) {
      this.counts.rejected += 1;
      this.warn(
        `refused a cue from offline camera ${cue.cameraId} — ` +
        `${this.offlineCameraReason(cue.cameraId) ?? 'camera offline'}`,
      );
      return null;
    }

    const rule = this.whitelistMatch(cue, nowMs);
    const id = cue.id ?? `${this.id}-${observedAt}-${this.seq++}`;
    if (rule) {
      this.counts.suppressed += 1;
      const record: SuppressionRecord = { ts: nowMs, rule, cueId: id };
      this.recentSuppressions.push(record);
      while (this.recentSuppressions.length > this.suppressionHistory) {
        this.recentSuppressions.shift();
      }
      emitAll(this.suppressionListeners, record);
      return null;
    }

    if (this.emittedIds.has(id)) return null;

    if (!this.limiter.tryAdmit(this.limiterKey(cue), nowMs)) {
      this.counts.rateLimited += 1;
      this.warn(`rate limit reached for ${this.limiterKey(cue)}; cue ${id} dropped`);
      return null;
    }
    this.emittedIds.add(id);
    this.counts.emitted += 1;
    this.lastCueAt = nowMs;
    const message: AnomalyMessage = {
      type: 'anomaly',
      ts: nowMs,
      vehicleId: this.vehicleId,
      anomaly: {
        id,
        lat: cue.lat,
        lon: cue.lon,
        type: cue.type,
        confidence: cue.confidence,
        thumbnail: cue.thumbnail ?? '',
        source: this.id,
        observedAt,
        ttl_s: ttlS,
        ...(cue.cameraId ? { cameraId: cue.cameraId } : {}),
      },
    };
    emitAll(this.anomalyListeners, message);
    return message;
  }

  /* ---- scripted replay --------------------------------------------------- */

  private scheduleFixture(fixture: CueFixture): void {
    // A relative fixture's payload timestamps are offsets from THIS start.
    this.replayEpoch = fixture.timebase === 'relative' ? this.scheduler.now() : 0;
    for (const event of fixture.events) {
      this.timers.push(this.scheduler.schedule(event.atMs, () => this.replay(event)));
    }
  }

  private replay(event: FixtureEvent): void {
    if (!this.started) return;
    if (isCueEvent(event)) {
      this.ingest(rebasePayload(event.payload, this.replayEpoch));
      return;
    }
    if (event.kind === 'health') {
      this.setHealth(event.state, `cue rail ${this.id}: ${event.detail}`);
      return;
    }
    if (event.kind === 'cameraOffline') {
      this.markCameraOffline(event.cameraId, event.detail ?? 'source reported the camera offline');
      return;
    }
    this.markCameraOnline(event.cameraId);
  }
}
