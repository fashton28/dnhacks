/* ManualControl — the operator's sticks for the MANUAL control source.
 *
 * What App.tsx relies on:
 *   · `onEngage` fires only from a hold-to-confirm gesture, and only while the
 *     vehicle is armed AND airborne. `onRelease` fires instantly — from the
 *     release button or the pad's B/Circle button — and from nowhere else.
 *   · `onInput` receives one ManualInput per animation frame while manual is
 *     active. That is the fire-and-forget `manualInput` rate; nothing here is
 *     acked per frame.
 *   · `onControllerChange` reports pad presence for the status bar.
 *   · Disarm always wins. The app owns Space (and T/D/R) on the same window,
 *     so this panel only ever claims its own stick keys and never stops
 *     propagation.
 *   · A pad that disappears mid-flight zeroes the sticks at once and drops any
 *     held keys with it — the companion's manual watchdog is the second line,
 *     not the first.
 */
import React from 'react';
import { Gamepad2, Joystick, Undo2 } from 'lucide-react';
import { Panel } from '@/components/Panel';
import { Button } from '@/components/Button';
import { HoldButton } from '@/components/HoldButton';
import { StatusPill, type StatusPillStatus } from '@/components/StatusPill';
import type { ManualInput } from '@/contract';

export interface ManualControlProps {
  armed: boolean;
  flying: boolean;
  manualActive: boolean;
  onEngage: () => void;
  onRelease: () => void;
  onInput: (v: ManualInput) => void;
  onControllerChange: (on: boolean) => void;
}

/* ------------------------------------------------------------------ */
/*  Stick mapping — pure, exported for tests                            */
/* ------------------------------------------------------------------ */

/** Stick travel inside ±MANUAL_DEADZONE reads as centred. */
export const MANUAL_DEADZONE = 0.09;

/** The all-zero frame: what the vehicle gets on release, on pad loss, and from idle keys. */
export const MANUAL_ZERO: Readonly<ManualInput> = Object.freeze({ throttle: 0, yaw: 0, pitch: 0, roll: 0 });

/** Gamepad button that releases manual control (B / Circle in the standard layout). */
export const MANUAL_RELEASE_BUTTON = 1;

/** Keyboard fallback: [positive, negative] key code per channel. */
export const MANUAL_KEY_MAP: Readonly<Record<keyof ManualInput, readonly [string, string]>> = {
  throttle: ['KeyW', 'KeyS'],
  yaw:      ['KeyD', 'KeyA'],
  pitch:    ['ArrowUp', 'ArrowDown'],
  roll:     ['ArrowRight', 'ArrowLeft'],
};

const STICK_KEYS: ReadonlySet<string> = new Set(
  (Object.values(MANUAL_KEY_MAP) as ReadonlyArray<readonly [string, string]>).flatMap((pair) => [...pair]),
);

/** True for the key codes this panel claims; every other key belongs to the app. */
export function isManualKey(code: string): boolean {
  return STICK_KEYS.has(code);
}

/** Centre small deflections, clamp to ±1, and read a non-finite sample as centred. */
export function applyDeadzone(v: number, deadzone: number = MANUAL_DEADZONE): number {
  if (!Number.isFinite(v) || Math.abs(v) < deadzone) return 0;
  return v > 1 ? 1 : v < -1 ? -1 : v;
}

/** Standard-mapping axes → ManualInput.
 *  Left stick:  X = yaw,  Y = throttle (pushing forward is +).
 *  Right stick: X = roll, Y = pitch    (pushing forward is +). */
export function manualInputFromAxes(axes: ArrayLike<number>): ManualInput {
  const axis = (i: number): number => (i < axes.length ? axes[i] : 0);
  return {
    throttle: applyDeadzone(-axis(1)),
    yaw:      applyDeadzone(axis(0)),
    pitch:    applyDeadzone(-axis(3)),
    roll:     applyDeadzone(axis(2)),
  };
}

/** Held key codes → ManualInput; each channel is +1, −1 or 0 from its key pair. */
export function manualInputFromKeys(held: ReadonlySet<string>): ManualInput {
  const channel = ([plus, minus]: readonly [string, string]): number =>
    (held.has(plus) ? 1 : 0) - (held.has(minus) ? 1 : 0);
  return {
    throttle: channel(MANUAL_KEY_MAP.throttle),
    yaw:      channel(MANUAL_KEY_MAP.yaw),
    pitch:    channel(MANUAL_KEY_MAP.pitch),
    roll:     channel(MANUAL_KEY_MAP.roll),
  };
}

export function sameInput(a: ManualInput, b: ManualInput): boolean {
  return a.throttle === b.throttle && a.yaw === b.yaw && a.pitch === b.pitch && a.roll === b.roll;
}

/** Short pad name for the source hint: the "(Vendor … Product …)" suffix goes, 28 chars max. */
export function padDisplayName(id: string): string {
  const bare = id.replace(/\s*\([^)]*\)\s*$/, '').trim();
  return (bare || 'Gamepad').slice(0, 28);
}

/** Channel readout: always signed, one decimal ("+0.5", "-1.0", "+0.0"). */
export function formatChannel(v: number): string {
  const n = Object.is(v, -0) ? 0 : v;
  return `${n < 0 ? '' : '+'}${n.toFixed(1)}`;
}

/* ------------------------------------------------------------------ */
/*  Input sampling                                                      */
/* ------------------------------------------------------------------ */

interface StickFrame {
  input: ManualInput;
  pad: string | null;
}

const IDLE_FRAME: StickFrame = { input: MANUAL_ZERO, pad: null };

/**
 * Owns both input sources. Samples once per animation frame from the pad if
 * one is present, else from the held keys, forwards every sample to `onInput`
 * while manual is active, and re-renders the panel only when the sampled
 * frame actually changed (an idle pad must not repaint sixty times a second).
 */
function useStickSampler(
  active: boolean,
  onInput: (v: ManualInput) => void,
  onRelease: () => void,
  onControllerChange: (on: boolean) => void,
): StickFrame {
  const [frame, setFrame] = React.useState<StickFrame>(IDLE_FRAME);
  const activeRef = React.useRef(active);
  activeRef.current = active;
  const heldRef = React.useRef<Set<string>>(new Set());
  const handlers = React.useRef({ onInput, onRelease, onControllerChange });
  handlers.current = { onInput, onRelease, onControllerChange };

  // Keyboard: claim stick keys only while manual is active. A key is released
  // on keyup or when the window loses focus (a keyup we would otherwise never see).
  React.useEffect(() => {
    const held = heldRef.current;
    const onDown = (e: KeyboardEvent): void => {
      if (!isManualKey(e.code) || !activeRef.current) return;
      held.add(e.code);
      e.preventDefault();
    };
    const onUp = (e: KeyboardEvent): void => {
      held.delete(e.code);
    };
    const onBlur = (): void => {
      held.clear();
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Leaving manual (release, disarm, tracking engage) forgets held keys so they
  // cannot carry into the next engagement.
  React.useEffect(() => {
    if (!active) heldRef.current.clear();
  }, [active]);

  React.useEffect(() => {
    let raf = 0;
    let padKey: string | null = null;
    let releaseHeld = false;
    let last: StickFrame = IDLE_FRAME;

    const firstPad = (): Gamepad | null => {
      const list = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
      for (const gp of list) if (gp && gp.connected) return gp;
      return null;
    };

    const publish = (next: StickFrame): void => {
      if (next.pad === last.pad && sameInput(next.input, last.input)) return;
      last = next;
      setFrame(next);
    };

    const sample = (): void => {
      const gp = firstPad();
      const key = gp ? `${gp.index}:${gp.id}` : null;
      if (key !== padKey) {
        const vanished = padKey !== null && gp === null;
        padKey = key;
        releaseHeld = false;
        handlers.current.onControllerChange(gp !== null);
        if (vanished && activeRef.current) {
          heldRef.current.clear();
          publish(IDLE_FRAME);
          handlers.current.onInput({ ...MANUAL_ZERO });
        }
      }

      let input: ManualInput;
      let pad: string | null = null;
      if (gp) {
        input = manualInputFromAxes(gp.axes);
        pad = padDisplayName(gp.id);
        // Rising edge only: holding B is one release, not one per frame.
        const pressed = gp.buttons[MANUAL_RELEASE_BUTTON]?.pressed === true;
        if (pressed && !releaseHeld && activeRef.current) handlers.current.onRelease();
        releaseHeld = pressed;
      } else {
        input = manualInputFromKeys(heldRef.current);
      }

      publish({ input, pad });
      if (activeRef.current) handlers.current.onInput(input);
      raf = window.requestAnimationFrame(sample);
    };

    raf = window.requestAnimationFrame(sample);
    return () => window.cancelAnimationFrame(raf);
  }, []);

  return frame;
}

/* ------------------------------------------------------------------ */
/*  Readouts                                                            */
/* ------------------------------------------------------------------ */

interface StickPadProps {
  label: string;
  x: number;
  y: number;
  active: boolean;
  corners: readonly [string, string];
}

/** One stick as an SVG dial: outer ring, dashed travel ring, crosshair, and a
 *  dot tethered to the centre so the deflection direction reads at a glance. */
function StickPad({ label, x, y, active, corners }: StickPadProps) {
  const size = 96;
  const half = size / 2;
  const travel = half - 12;
  const cx = half + x * travel;
  const cy = half + y * travel;
  const tint = active ? 'var(--accent)' : 'var(--text-tertiary)';
  const mono: React.CSSProperties = { fontFamily: 'var(--font-mono)' };

  return (
    <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`${label}: ${formatChannel(x)}, ${formatChannel(-y)}`}
      >
        <circle cx={half} cy={half} r={half - 0.5} fill="var(--bg-sunken)" stroke={active ? 'var(--accent-border)' : 'var(--border-input)'} />
        <circle cx={half} cy={half} r={travel} fill="none" stroke="var(--border-subtle)" strokeDasharray="2 3" />
        <path d={`M${half} 8 V${size - 8} M8 ${half} H${size - 8}`} stroke="var(--border-default)" />
        <line x1={half} y1={half} x2={cx} y2={cy} stroke={tint} strokeOpacity={0.45} />
        <circle
          cx={cx}
          cy={cy}
          r={8}
          fill={tint}
          style={{ filter: active ? 'drop-shadow(0 0 5px rgba(47,129,247,0.6))' : 'none', transition: 'fill var(--dur-base)' }}
        />
        <text x={7} y={11} fontSize={8} fill="var(--text-disabled)" style={mono}>{corners[0]}</text>
        <text x={size - 7} y={size - 5} fontSize={8} textAnchor="end" fill="var(--text-disabled)" style={mono}>{corners[1]}</text>
      </svg>
      <figcaption style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
        {label}
      </figcaption>
    </figure>
  );
}

/** A centre-zero bar: the fill grows from the midline and is mirrored for negative values. */
function ChannelBar({ label, value, active }: { label: string; value: number; active: boolean }) {
  const extent = Math.min(1, Math.abs(value)) * 50;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '34px 1fr 30px', alignItems: 'center', gap: 7 }}>
      <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.05em', color: 'var(--text-tertiary)' }}>{label}</span>
      <div style={{ position: 'relative', height: 5, background: 'var(--bg-sunken)', borderRadius: 3, overflow: 'hidden' }}>
        <span style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--border-strong)' }} />
        <span
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: '50%',
            width: `${extent}%`,
            transformOrigin: 'left center',
            transform: value < 0 ? 'scaleX(-1)' : 'none',
            background: active ? 'var(--accent)' : 'var(--gray-6)',
            transition: 'width 60ms linear',
          }}
        />
      </div>
      <span
        style={{
          textAlign: 'right',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: active ? 'var(--text-secondary)' : 'var(--text-disabled)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {formatChannel(value)}
      </span>
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return <b style={{ color: 'var(--text-secondary)' }}>{children}</b>;
}

function SourceHint({ pad }: { pad: string | null }) {
  return (
    <div style={{ marginTop: 9, display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: 'var(--text-tertiary)' }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', flex: 'none', background: pad ? 'var(--green)' : 'var(--gray-6)' }} />
      {pad ? (
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-secondary)' }}>{pad}</span>
      ) : (
        <span>
          No controller · keyboard <Key>WASD</Key> + <Key>arrows</Key>
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Panel                                                               */
/* ------------------------------------------------------------------ */

const CHANNELS: ReadonlyArray<readonly [keyof ManualInput, string]> = [
  ['throttle', 'THR'],
  ['yaw', 'YAW'],
  ['pitch', 'PITCH'],
  ['roll', 'ROLL'],
];

export function ManualControl({
  armed,
  flying,
  manualActive,
  onEngage,
  onRelease,
  onInput,
  onControllerChange,
}: ManualControlProps) {
  const { input, pad } = useStickSampler(manualActive, onInput, onRelease, onControllerChange);

  const pill: { status: StatusPillStatus; label: string } = manualActive
    ? { status: 'active', label: 'Active' }
    : pad
      ? { status: 'info', label: 'Ready' }
      : { status: 'neutral', label: 'No pad' };
  const engageHint = !armed ? 'Arm first' : !flying ? 'Take off first' : 'Hold to take control';

  return (
    <Panel
      title="Manual control"
      icon={<Gamepad2 size={14} />}
      status={
        <StatusPill size="sm" status={pill.status} pulse={manualActive}>
          {pill.label}
        </StatusPill>
      }
    >
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
        <StickPad label="Throttle / Yaw" x={input.yaw} y={-input.throttle} active={manualActive} corners={['↑ thr', 'yaw']} />
        <StickPad label="Pitch / Roll" x={input.roll} y={-input.pitch} active={manualActive} corners={['pitch', 'roll']} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '7px 14px', marginTop: 12 }}>
        {CHANNELS.map(([channel, label]) => (
          <ChannelBar key={channel} label={label} value={input[channel]} active={manualActive} />
        ))}
      </div>

      <div style={{ marginTop: 13 }}>
        {manualActive ? (
          <Button variant="secondary" size="lg" block icon={<Undo2 size={14} />} onClick={onRelease} style={{ fontWeight: 700 }}>
            Release to auto-hold
          </Button>
        ) : (
          <HoldButton
            variant="primary"
            disabled={!armed || !flying}
            hint={engageHint}
            icon={<Joystick size={16} />}
            onConfirm={onEngage}
          >
            Take manual control
          </HoldButton>
        )}
      </div>

      <SourceHint pad={pad} />
    </Panel>
  );
}
