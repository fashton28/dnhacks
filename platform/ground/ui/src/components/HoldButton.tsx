import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, MouseEvent as ReactMouseEvent } from 'react';

/**
 * HoldButton — hold-to-confirm control for deliberate, gated actions
 * (Takeoff, Engage Tracking, Approve plan).
 *
 * Semantics, in order of precedence:
 *   - the pointer must stay down on the button for `holdMs`; only then does
 *     `onConfirm` fire, exactly once per press;
 *   - lifting, leaving or losing the pointer before that cancels silently;
 *   - a button that becomes `disabled` mid-hold cancels the hold, and the
 *     `disabled` flag is re-checked at the instant of confirmation, so a
 *     control that was gated off while the operator was still holding can
 *     never fire late;
 *   - the keyboard does not drive a hold. Space is the global DISARM key and
 *     stopping always wins over starting — a hold that could be armed from
 *     the same key the operator hits to kill the motors would invert that.
 *
 * Never use this to STOP something: stopping must be instant (plain Button).
 *
 * The timing itself is `createHoldTimer`, a framework-free state machine the
 * tests drive with a fake clock. The component subscribes to it with
 * useSyncExternalStore and paints the fill through a `--hold-pct` custom
 * property that `.eis-hold-fill` reads.
 */

export type HoldButtonVariant = 'primary' | 'caution' | 'danger';

export interface HoldButtonProps {
  children?: ReactNode;
  onConfirm?: () => void;
  holdMs?: number;
  variant?: HoldButtonVariant;
  icon?: ReactNode;
  disabled?: boolean;
  block?: boolean;
  hint?: string;
  style?: CSSProperties;
}

/** Press length a caller gets when it does not ask for one. */
export const DEFAULT_HOLD_MS = 1100;

/**
 * Fraction of a hold completed after `elapsedMs`, clamped to [0, 1].
 * A non-positive `holdMs` means "no hold required": the first frame confirms.
 */
export function holdFraction(elapsedMs: number, holdMs: number): number {
  if (!(holdMs > 0)) return 1;
  if (!(elapsedMs > 0)) return 0;
  return elapsedMs >= holdMs ? 1 : elapsedMs / holdMs;
}

export interface HoldSnapshot {
  readonly holding: boolean;
  /** 0 while idle, otherwise the fraction of `holdMs` elapsed so far. */
  readonly fraction: number;
}

export interface HoldTimerOptions {
  holdMs?: number;
  onConfirm?: () => void;
  /** Monotonic clock in ms (default performance.now). */
  now?: () => number;
  /** Frame scheduler (default requestAnimationFrame). Must call back at most once. */
  requestFrame?: (cb: () => void) => unknown;
  cancelFrame?: (handle: unknown) => void;
}

export interface HoldTimer {
  /** Start a hold. Returns false (and does nothing) if one is already running. */
  press(): boolean;
  /** Cancel the running hold without confirming. Returns false if idle. */
  release(): boolean;
  /** Re-point the timer at a new duration / callback; a running hold keeps its start time. */
  configure(next: Pick<HoldTimerOptions, 'holdMs' | 'onConfirm'>): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): HoldSnapshot;
}

const IDLE: HoldSnapshot = Object.freeze({ holding: false, fraction: 0 });

const defaultNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const defaultRequestFrame = (cb: () => void): unknown =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(cb, 16);
const defaultCancelFrame = (handle: unknown): void => {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle as number);
  else clearTimeout(handle as ReturnType<typeof setTimeout>);
};

export function createHoldTimer(options: HoldTimerOptions = {}): HoldTimer {
  const now = options.now ?? defaultNow;
  const requestFrame = options.requestFrame ?? defaultRequestFrame;
  const cancelFrame = options.cancelFrame ?? defaultCancelFrame;

  let holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
  let onConfirm = options.onConfirm;
  let snapshot: HoldSnapshot = IDLE;
  let startedAt = 0;
  let pendingFrame: unknown = null;
  const listeners = new Set<() => void>();

  const publish = (next: HoldSnapshot): void => {
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  const dropFrame = (): void => {
    if (pendingFrame !== null) {
      cancelFrame(pendingFrame);
      pendingFrame = null;
    }
  };
  const nextFrame = (): void => {
    pendingFrame = requestFrame(step);
  };

  function step(): void {
    pendingFrame = null;
    if (!snapshot.holding) return; // released between scheduling and delivery
    const fraction = holdFraction(now() - startedAt, holdMs);
    if (fraction < 1) {
      publish({ holding: true, fraction });
      nextFrame();
      return;
    }
    // Go idle BEFORE confirming: whatever onConfirm re-renders sees a
    // finished button, and a confirm handler that unmounts us is harmless.
    publish(IDLE);
    onConfirm?.();
  }

  return {
    press() {
      if (snapshot.holding) return false;
      startedAt = now();
      publish({ holding: true, fraction: 0 });
      nextFrame();
      return true;
    },
    release() {
      if (!snapshot.holding) return false;
      dropFrame();
      publish(IDLE);
      return true;
    },
    configure(next) {
      if (next.holdMs !== undefined) holdMs = next.holdMs;
      if ('onConfirm' in next) onConfirm = next.onConfirm;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => snapshot,
  };
}

type StyleWithVars = CSSProperties & { [name: `--${string}`]: string | number };

export function HoldButton({
  children,
  onConfirm,
  holdMs = DEFAULT_HOLD_MS,
  variant = 'primary',
  icon = null,
  disabled = false,
  block = true,
  hint = 'Hold to confirm',
  style,
}: HoldButtonProps) {
  // Latest props, read at confirmation time rather than captured at press time.
  const live = useRef({ onConfirm, disabled });
  useEffect(() => { live.current = { onConfirm, disabled }; });

  const timerRef = useRef<HoldTimer | null>(null);
  if (timerRef.current === null) {
    timerRef.current = createHoldTimer({
      holdMs,
      onConfirm: () => {
        const { onConfirm: confirm, disabled: gated } = live.current;
        if (!gated) confirm?.();
      },
    });
  }
  const timer = timerRef.current;

  useEffect(() => { timer.configure({ holdMs }); }, [timer, holdMs]);
  // Gated off while holding → the hold dies with it.
  useEffect(() => { if (disabled) timer.release(); }, [timer, disabled]);
  // Unmount (or a StrictMode remount) must never leave a frame in flight.
  useEffect(() => () => { timer.release(); }, [timer]);

  const { holding, fraction } = useSyncExternalStore(timer.subscribe, timer.getSnapshot, timer.getSnapshot);

  const press = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (disabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return; // primary button only
    e.preventDefault();
    timer.press();
  };
  const release = (): void => { timer.release(); };
  const swallowMenu = (e: ReactMouseEvent<HTMLButtonElement>): void => {
    // A long touch-press would otherwise open the context menu mid-hold.
    if (holding) e.preventDefault();
  };

  const percent = Math.round(fraction * 100);
  const inline: StyleWithVars = { ...style, '--hold-pct': `${percent}%` };

  return (
    <button
      type="button"
      className="eis-hold"
      disabled={disabled}
      data-variant={variant}
      data-block={block || undefined}
      data-holding={holding || undefined}
      style={inline}
      onPointerDown={press}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      onContextMenu={swallowMenu}
    >
      <span className="eis-hold-fill" aria-hidden="true" />
      <span className="eis-hold-content">
        {icon}
        <span className="eis-hold-text">
          <span>{children}</span>
          <span className="eis-hold-hint">{holding ? `${percent}%` : hint}</span>
        </span>
      </span>
    </button>
  );
}
