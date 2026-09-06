/* ============================================================================
 * eis-cues — CueBus: every rail, one anomaly channel.
 *
 * The bus is the thin seam the UI (and anything else that already listens to
 * `anomaly`) consumes. It adds no wire message: what comes out is exactly the
 * contract's `AnomalyMessage` and `HealthEventMessage`.
 *
 * Its four jobs, and nothing else:
 *  1. Multiplex — one subscription instead of seven.
 *  2. Isolate — a rail that throws, or a subscriber that throws, takes nothing
 *     else down. A live rail failing takes only itself out (ADR D25).
 *  3. Expire — a cue whose `observedAt + ttl_s` has passed never reaches a
 *     consumer, however it got here.
 *  4. Charge the shared CUE BUDGET, after each rail has applied its own limit.
 *
 * It does NOT plan, route, prioritise, or decide a dispatch. Turning a cue into
 * a task and a task into a plan happens downstream, in the deterministic
 * planner, behind the verifier.
 * ========================================================================== */

import type { AnomalyMessage, HealthEventMessage, Unsubscribe } from './contract.js';
import { DEFAULT_VEHICLE_ID } from './contract.js';
import { BoundedIdSet } from './dedupe.js';
import { SlidingWindowLimiter, resolveCueBudget } from './rateLimit.js';
import { RealScheduler, type Scheduler } from './scheduler.js';
import { RAIL_HEALTH_COMPONENT, type CueAdapter, type RailHealth, type RailId, type RateLimit, type SuppressionRecord } from './types.js';

export interface CueBusOptions {
  vehicleId?: string;
  scheduler?: Scheduler;
  /** Shared budget. Clamped so it can only be TIGHTER than CUE_BUDGET_CEILING. */
  budget?: Partial<RateLimit>;
}

export interface CueBudgetState {
  limit: RateLimit;
  /** Cues charged inside the current window. */
  used: number;
  /** Cues refused because the budget was exhausted, since construction. */
  dropped: number;
}

/** Why the bus refused a cue that a rail had already admitted. */
export type CueRejection = 'expired' | 'duplicate' | 'budget';

export class CueBus {
  private readonly vehicleId: string;
  private readonly scheduler: Scheduler;
  private readonly budget: SlidingWindowLimiter;
  private readonly budgetLimit: RateLimit;

  private readonly rails = new Map<RailId, CueAdapter>();
  private readonly unsubscribes: Unsubscribe[] = [];

  private readonly anomalyListeners = new Set<(m: AnomalyMessage) => void>();
  private readonly healthListeners = new Set<(m: HealthEventMessage) => void>();
  private readonly suppressionListeners = new Set<(r: SuppressionRecord) => void>();
  private readonly rejectionListeners = new Set<(r: CueRejection, m: AnomalyMessage) => void>();

  private readonly seen = new BoundedIdSet();
  private budgetDropped = 0;

  constructor(options: CueBusOptions = {}) {
    this.vehicleId = options.vehicleId ?? DEFAULT_VEHICLE_ID;
    this.scheduler = options.scheduler ?? new RealScheduler();
    this.budgetLimit = resolveCueBudget(options.budget);
    this.budget = new SlidingWindowLimiter(this.budgetLimit);
  }

  /** Attach a rail. One rail per id: a second registration is a wiring bug and
   *  throws rather than silently shadowing the first. */
  register(adapter: CueAdapter): void {
    if (this.rails.has(adapter.id)) {
      throw new Error(`cue bus: a ${adapter.id} rail is already registered`);
    }
    this.rails.set(adapter.id, adapter);
    this.unsubscribes.push(adapter.onAnomaly((m) => this.admit(m)));
    this.unsubscribes.push(adapter.onHealth((m) => this.fanOut(this.healthListeners, m)));
    this.unsubscribes.push(adapter.onSuppression((r) => this.fanOut(this.suppressionListeners, r)));
  }

  registerAll(adapters: CueAdapter[]): void {
    for (const adapter of adapters) this.register(adapter);
  }

  rail(id: RailId): CueAdapter | undefined {
    return this.rails.get(id);
  }

  /**
   * Start every rail. One rail failing to start never stops another: its own
   * failure is reported through health and the rest come up.
   */
  async start(): Promise<void> {
    await Promise.all([...this.rails.values()].map(async (adapter) => {
      try {
        await adapter.start();
      } catch (err) {
        this.fanOut(this.healthListeners, {
          type: 'healthEvent',
          ts: this.scheduler.now(),
          vehicleId: this.vehicleId,
          component: RAIL_HEALTH_COMPONENT[adapter.id],
          state: 'failed',
          detail: `cue rail ${adapter.id}: start threw — ${(err as Error).message}`,
        });
      }
    }));
  }

  async stop(): Promise<void> {
    await Promise.all([...this.rails.values()].map(async (adapter) => {
      try {
        await adapter.stop();
      } catch {
        /* a rail that will not stop cleanly must not block the others */
      }
    }));
  }

  /** Detach every rail subscription. The rails themselves are left running. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
    this.rails.clear();
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

  /** Cues the bus refused. Useful to the operator badge and the audit trail. */
  onRejection(cb: (reason: CueRejection, m: AnomalyMessage) => void): Unsubscribe {
    this.rejectionListeners.add(cb);
    return () => this.rejectionListeners.delete(cb);
  }

  /** Every rail's badge, in registration order. */
  health(): RailHealth[] {
    return [...this.rails.values()].map((adapter) => adapter.health());
  }

  budgetState(): CueBudgetState {
    return {
      limit: { ...this.budgetLimit },
      used: this.budget.count('cue', this.scheduler.now()),
      dropped: this.budgetDropped,
    };
  }

  /** True when a cue is past `observedAt + ttl_s`. Undated cues never expire. */
  static isExpired(m: AnomalyMessage, nowMs: number): boolean {
    const { observedAt, ttl_s: ttlS } = m.anomaly;
    if (observedAt === undefined || ttlS === undefined) return false;
    return observedAt + ttlS * 1000 <= nowMs;
  }

  private admit(message: AnomalyMessage): void {
    const now = this.scheduler.now();
    if (CueBus.isExpired(message, now)) {
      this.reject('expired', message);
      return;
    }
    if (this.seen.has(message.anomaly.id)) {
      this.reject('duplicate', message);
      return;
    }
    if (!this.budget.tryAdmit('cue', now)) {
      this.budgetDropped += 1;
      this.reject('budget', message);
      this.fanOut(this.healthListeners, {
        type: 'healthEvent',
        ts: now,
        vehicleId: message.vehicleId,
        component: RAIL_HEALTH_COMPONENT[message.anomaly.source],
        state: 'warning',
        detail:
          `cue budget exhausted (${this.budgetLimit.maxEvents} per ` +
          `${Math.round(this.budgetLimit.windowMs / 60_000)} min); ` +
          `cue ${message.anomaly.id} from ${message.anomaly.source} dropped`,
      });
      return;
    }
    this.seen.add(message.anomaly.id);
    this.fanOut(this.anomalyListeners, message);
  }

  private reject(reason: CueRejection, message: AnomalyMessage): void {
    for (const cb of [...this.rejectionListeners]) {
      try {
        cb(reason, message);
      } catch {
        /* a subscriber's failure is its own */
      }
    }
  }

  private fanOut<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const cb of [...listeners]) {
      try {
        cb(value);
      } catch {
        /* a subscriber's failure is its own */
      }
    }
  }
}
