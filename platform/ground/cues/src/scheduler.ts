/* ============================================================================
 * eis-cues — clock + timer seam.
 *
 * Every rail reads time and schedules replay through a Scheduler so tests are
 * deterministic without fake timers, and so nothing on the test or demo path
 * depends on wall-clock drift.
 * ========================================================================== */

export interface Scheduler {
  now(): number;
  /** Returns a cancellation handle. */
  schedule(delayMs: number, fn: () => void): number;
  cancel(handle: number): void;
}

/** Wall-clock scheduler backed by setTimeout. */
export class RealScheduler implements Scheduler {
  private next = 1;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  now(): number {
    return Date.now();
  }

  schedule(delayMs: number, fn: () => void): number {
    const handle = this.next++;
    const timer = setTimeout(() => {
      this.timers.delete(handle);
      fn();
    }, Math.max(0, delayMs));
    // Never hold a Node process open for a cue replay.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.timers.set(handle, timer);
    return handle;
  }

  cancel(handle: number): void {
    const timer = this.timers.get(handle);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(handle);
    }
  }
}

/** Deterministic scheduler: time only moves when a test moves it. */
export class ManualScheduler implements Scheduler {
  private current: number;
  private next = 1;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();

  constructor(startMs = 1_700_000_000_000) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  schedule(delayMs: number, fn: () => void): number {
    const handle = this.next++;
    this.pending.set(handle, { at: this.current + Math.max(0, delayMs), fn });
    return handle;
  }

  cancel(handle: number): void {
    this.pending.delete(handle);
  }

  /** Advance `ms` milliseconds, firing due callbacks in time order. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      let dueHandle: number | undefined;
      let dueAt = Infinity;
      for (const [handle, entry] of this.pending) {
        if (entry.at <= target && (entry.at < dueAt || (entry.at === dueAt && handle < (dueHandle ?? Infinity)))) {
          dueAt = entry.at;
          dueHandle = handle;
        }
      }
      if (dueHandle === undefined) break;
      const entry = this.pending.get(dueHandle);
      this.pending.delete(dueHandle);
      this.current = Math.max(this.current, dueAt);
      entry?.fn();
    }
    this.current = target;
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
