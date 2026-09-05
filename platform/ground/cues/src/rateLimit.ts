/* ============================================================================
 * eis-cues — sliding-window rate limiting and the shared cue budget.
 *
 * Order of application is load-bearing (docs/CUE_RAILS_SPEC.md): a rail's own
 * per-source limit (per camera, per rail) is applied FIRST, and only what
 * survives it is charged against the shared cue budget. A single noisy camera
 * therefore cannot consume the budget the other rails share.
 *
 * The budget follows the same "config may only tighten" rule as the companion's
 * safety floors: `resolveCueBudget` never returns a budget looser than
 * CUE_BUDGET_CEILING.
 * ========================================================================== */

import type { RateLimit } from './types.js';

/** Sliding-window limiter keyed by an arbitrary string (rail id, camera id…). */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly limit: RateLimit) {
    if (!Number.isFinite(limit.maxEvents) || limit.maxEvents < 0) {
      throw new Error('invalid rate limit: maxEvents must be a finite number >= 0');
    }
    if (!Number.isFinite(limit.windowMs) || limit.windowMs <= 0) {
      throw new Error('invalid rate limit: windowMs must be a finite number > 0');
    }
  }

  /** Admit and record, or refuse. Refusal never throws — it is a normal outcome. */
  tryAdmit(key: string, nowMs: number): boolean {
    const cutoff = nowMs - this.limit.windowMs;
    const kept = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length >= this.limit.maxEvents) {
      this.hits.set(key, kept);
      return false;
    }
    kept.push(nowMs);
    this.hits.set(key, kept);
    return true;
  }

  /** Events counted against `key` inside the current window. */
  count(key: string, nowMs: number): number {
    const cutoff = nowMs - this.limit.windowMs;
    return (this.hits.get(key) ?? []).filter((t) => t > cutoff).length;
  }

  reset(): void {
    this.hits.clear();
  }
}

/**
 * Hard ceiling on cues admitted to the dispatch channel, across ALL rails.
 * Bounds cue flooding (ADR D23's sortie-rate reasoning applied at the cue
 * seam). Configuration may lower these numbers; it may never raise them.
 */
export const CUE_BUDGET_CEILING: RateLimit = { maxEvents: 12, windowMs: 3_600_000 };

/** Default per-rail limit, applied before the shared budget. */
export const DEFAULT_RAIL_RATE_LIMIT: RateLimit = { maxEvents: 6, windowMs: 3_600_000 };

/** Default per-camera limit for the CCTV rail. */
export const DEFAULT_CAMERA_RATE_LIMIT: RateLimit = { maxEvents: 3, windowMs: 600_000 };

/**
 * Clamp a requested budget so it can only be TIGHTER than the ceiling.
 * A missing field takes the ceiling's value; a looser field is clamped and the
 * caller gets the tightened budget rather than an error, so a bad config
 * degrades toward safety instead of failing open.
 */
export function resolveCueBudget(requested?: Partial<RateLimit>): RateLimit {
  const maxEvents = requested?.maxEvents;
  const windowMs = requested?.windowMs;
  return {
    maxEvents: Number.isFinite(maxEvents) && (maxEvents as number) >= 0
      ? Math.min(maxEvents as number, CUE_BUDGET_CEILING.maxEvents)
      : CUE_BUDGET_CEILING.maxEvents,
    windowMs: Number.isFinite(windowMs) && (windowMs as number) > 0
      ? Math.max(windowMs as number, CUE_BUDGET_CEILING.windowMs)
      : CUE_BUDGET_CEILING.windowMs,
  };
}

/** Clamp a per-rail limit so it can never exceed the shared budget ceiling. */
export function resolveRailRateLimit(requested?: Partial<RateLimit>): RateLimit {
  const base = requested ?? DEFAULT_RAIL_RATE_LIMIT;
  const maxEvents = Number.isFinite(base.maxEvents) && (base.maxEvents as number) >= 0
    ? (base.maxEvents as number)
    : DEFAULT_RAIL_RATE_LIMIT.maxEvents;
  const windowMs = Number.isFinite(base.windowMs) && (base.windowMs as number) > 0
    ? (base.windowMs as number)
    : DEFAULT_RAIL_RATE_LIMIT.windowMs;
  return { maxEvents, windowMs };
}
