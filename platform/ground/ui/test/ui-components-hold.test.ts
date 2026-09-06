/* ============================================================================
 * HoldButton timing — the hold-to-confirm state machine behind Takeoff,
 * Engage Tracking and Approve plan, driven here with a fake clock and a
 * hand-cranked frame scheduler so every transition is deterministic.
 *
 * The contract under test:
 *   - onConfirm fires exactly once, and only once the full holdMs has elapsed;
 *   - releasing early cancels silently and drops the pending frame;
 *   - a completed hold needs a fresh press — it never auto-repeats;
 *   - the snapshot is referentially stable between changes (what
 *     useSyncExternalStore needs to avoid render loops).
 * ========================================================================== */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HOLD_MS, createHoldTimer, holdFraction } from '@/components/HoldButton';

function harness(holdMs = 1000) {
  let clock = 0;
  let seq = 0;
  const pending = new Map<number, () => void>();
  const onConfirm = vi.fn();
  const timer = createHoldTimer({
    holdMs,
    onConfirm,
    now: () => clock,
    requestFrame: (cb) => { pending.set(++seq, cb); return seq; },
    cancelFrame: (handle) => { pending.delete(handle as number); },
  });
  /** Advance the clock, then deliver the oldest pending frame (if any). */
  const frame = (ms: number): void => {
    clock += ms;
    const next = pending.entries().next();
    if (next.done) return;
    const [handle, cb] = next.value;
    pending.delete(handle);
    cb();
  };
  return { timer, onConfirm, frame, pending, clock: () => clock };
}

describe('holdFraction', () => {
  it.each([
    [0, 1000, 0],
    [250, 1000, 0.25],
    [999, 1000, 0.999],
    [1000, 1000, 1],
    [5000, 1000, 1],
    [-5, 1000, 0],
    [Number.NaN, 1000, 0],
  ])('elapsed %s of %s → %s', (elapsed, hold, expected) => {
    expect(holdFraction(elapsed, hold)).toBeCloseTo(expected, 6);
  });

  it('treats a non-positive hold as instant', () => {
    expect(holdFraction(0, 0)).toBe(1);
    expect(holdFraction(0, -10)).toBe(1);
    expect(holdFraction(0, Number.NaN)).toBe(1);
  });

  it('defaults the component hold to 1.1 s', () => {
    expect(DEFAULT_HOLD_MS).toBe(1100);
  });
});

describe('createHoldTimer', () => {
  it('starts idle and referentially stable', () => {
    const { timer } = harness();
    const a = timer.getSnapshot();
    expect(a).toEqual({ holding: false, fraction: 0 });
    expect(timer.getSnapshot()).toBe(a);
  });

  it('press → frames advance the fraction, confirm fires once at holdMs, then idle', () => {
    const { timer, onConfirm, frame, pending } = harness(1000);
    const seen: number[] = [];
    timer.subscribe(() => seen.push(timer.getSnapshot().fraction));

    expect(timer.press()).toBe(true);
    expect(timer.getSnapshot()).toEqual({ holding: true, fraction: 0 });
    expect(pending.size).toBe(1);

    frame(400);
    expect(timer.getSnapshot()).toEqual({ holding: true, fraction: 0.4 });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(pending.size).toBe(1); // the chain keeps itself alive

    frame(400);
    expect(timer.getSnapshot().fraction).toBeCloseTo(0.8);
    expect(onConfirm).not.toHaveBeenCalled();

    frame(400); // 1200 ms ≥ 1000 ms
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(timer.getSnapshot()).toEqual({ holding: false, fraction: 0 });
    expect(pending.size).toBe(0);
    expect(seen).toEqual([0, 0.4, 0.8, 0]);
  });

  it('goes idle BEFORE onConfirm runs, so a handler re-rendering sees a finished button', () => {
    const { timer, onConfirm, frame } = harness(100);
    onConfirm.mockImplementation(() => {
      expect(timer.getSnapshot()).toEqual({ holding: false, fraction: 0 });
    });
    timer.press();
    frame(100);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('release before holdMs cancels: no confirm, no pending frame, idle snapshot', () => {
    const { timer, onConfirm, frame, pending } = harness(1000);
    timer.press();
    frame(600);
    expect(timer.getSnapshot().holding).toBe(true);

    expect(timer.release()).toBe(true);
    expect(timer.getSnapshot()).toEqual({ holding: false, fraction: 0 });
    expect(pending.size).toBe(0);

    frame(1000); // nothing to deliver, and the clock passing holdMs changes nothing
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('a frame delivered after release is a no-op', () => {
    const { timer, onConfirm, frame, pending } = harness(100);
    timer.press();
    const [, stale] = pending.entries().next().value as [number, () => void];
    timer.release();
    frame(500); // clock passes holdMs
    stale();    // scheduler that ignored our cancel still fires the old callback
    expect(onConfirm).not.toHaveBeenCalled();
    expect(timer.getSnapshot().holding).toBe(false);
  });

  it('a second press while holding is ignored and keeps the original start', () => {
    const { timer, onConfirm, frame } = harness(1000);
    timer.press();
    frame(700);
    expect(timer.press()).toBe(false);
    frame(300);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('release while idle reports false and notifies nobody', () => {
    const { timer } = harness();
    const listener = vi.fn();
    timer.subscribe(listener);
    expect(timer.release()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('never auto-repeats: after confirming, more time does nothing until the next press', () => {
    const { timer, onConfirm, frame, pending } = harness(100);
    timer.press();
    frame(100);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    frame(1000);
    frame(1000);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(pending.size).toBe(0);

    timer.press();
    frame(100);
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('configure() re-times a running hold and swaps the confirm callback', () => {
    const { timer, onConfirm, frame } = harness(1000);
    const replacement = vi.fn();
    timer.press();
    frame(400);
    timer.configure({ holdMs: 300, onConfirm: replacement });
    frame(1); // 401 ms elapsed ≥ 300 ms
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('configure({ onConfirm: undefined }) detaches the callback without crashing the hold', () => {
    const { timer, onConfirm, frame } = harness(100);
    timer.configure({ onConfirm: undefined });
    timer.press();
    frame(100);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(timer.getSnapshot().holding).toBe(false);
  });

  it('unsubscribe stops notifications', () => {
    const { timer, frame } = harness(1000);
    const listener = vi.fn();
    const off = timer.subscribe(listener);
    timer.press();
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    frame(100);
    timer.release();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a zero holdMs confirms on the first frame', () => {
    const { timer, onConfirm, frame } = harness(0);
    timer.press();
    frame(0);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('createHoldTimer default scheduler', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('falls back to setTimeout frames where requestAnimationFrame is absent', () => {
    vi.useFakeTimers();
    let clock = 0;
    const onConfirm = vi.fn();
    const timer = createHoldTimer({ holdMs: 100, onConfirm, now: () => clock });

    timer.press();
    vi.advanceTimersByTime(16);
    expect(timer.getSnapshot()).toEqual({ holding: true, fraction: 0 });

    clock = 60;
    vi.advanceTimersByTime(16);
    expect(timer.getSnapshot().fraction).toBeCloseTo(0.6);

    clock = 100;
    vi.advanceTimersByTime(16);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(timer.getSnapshot().holding).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('release cancels the fallback timer too', () => {
    vi.useFakeTimers();
    let clock = 0;
    const onConfirm = vi.fn();
    const timer = createHoldTimer({ holdMs: 10, onConfirm, now: () => clock });
    timer.press();
    timer.release();
    clock = 1000;
    vi.advanceTimersByTime(1000);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
