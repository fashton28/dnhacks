import React from 'react';
import { Panel } from '@/components/Panel';
import { HoldButton } from '@/components/HoldButton';
import { StatusPill } from '@/components/StatusPill';
import type { ManualInput } from '@/contract';

/* ------------------------------------------------------------------ */
/*  Props                                                               */
/* ------------------------------------------------------------------ */

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
/*  Inline icon helper                                                  */
/* ------------------------------------------------------------------ */

function Ic({ d, s = 16 }: { d: React.ReactNode; s?: number }) {
  return (
    <svg
      width={s} height={s}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {d}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Stick visualizer sub-component                                      */
/* ------------------------------------------------------------------ */

interface StickProps {
  label: string;
  x: number;
  y: number;
  active: boolean;
  tl: string;
  bl: string;
}

function Stick({ label, x, y, active, tl, bl }: StickProps) {
  const size = 96;
  const r = size / 2 - 12;
  const dotColor = active ? 'var(--accent)' : 'var(--text-tertiary)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
      <div style={{
        position: 'relative',
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'var(--bg-sunken)',
        border: `1px solid ${active ? 'var(--accent-border)' : 'var(--border-input)'}`,
        boxShadow: active ? 'inset 0 0 12px rgba(47,129,247,0.18)' : 'none',
      }}>
        {/* crosshair */}
        <div style={{
          position: 'absolute',
          left: '50%',
          top: 8,
          bottom: 8,
          width: 1,
          background: 'var(--border-default)',
          transform: 'translateX(-0.5px)',
        }} />
        <div style={{
          position: 'absolute',
          top: '50%',
          left: 8,
          right: 8,
          height: 1,
          background: 'var(--border-default)',
          transform: 'translateY(-0.5px)',
        }} />
        {/* dot */}
        <div style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: dotColor,
          boxShadow: active ? '0 0 10px rgba(47,129,247,0.5)' : 'none',
          transform: `translate(calc(-50% + ${x * r}px), calc(-50% + ${y * r}px))`,
          transition: 'background var(--dur-base)',
        }} />
        <span style={{
          position: 'absolute',
          top: 4,
          left: 7,
          fontSize: 8,
          color: 'var(--text-disabled)',
          fontFamily: 'var(--font-mono)',
        }}>
          {tl}
        </span>
        <span style={{
          position: 'absolute',
          bottom: 4,
          right: 7,
          fontSize: 8,
          color: 'var(--text-disabled)',
          fontFamily: 'var(--font-mono)',
        }}>
          {bl}
        </span>
      </div>
      <span style={{
        fontSize: 9.5,
        fontWeight: 600,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: 'var(--text-tertiary)',
      }}>
        {label}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Channel bar sub-component                                           */
/* ------------------------------------------------------------------ */

interface ChanProps {
  label: string;
  value: number;
  active: boolean;
}

function Chan({ label, value, active }: ChanProps) {
  const pct = Math.abs(value) * 50;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <span style={{
        width: 34,
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: '0.05em',
        color: 'var(--text-tertiary)',
        flex: 'none',
      }}>
        {label}
      </span>
      <div style={{
        position: 'relative',
        flex: 1,
        height: 5,
        background: 'var(--bg-sunken)',
        borderRadius: 3,
        overflow: 'hidden',
      }}>
        <div style={{
          position: 'absolute',
          left: '50%',
          top: 0,
          bottom: 0,
          width: 1,
          background: 'var(--border-strong)',
        }} />
        <div style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          background: active ? 'var(--accent)' : 'var(--gray-6)',
          left: value >= 0 ? '50%' : `${50 - pct}%`,
          width: `${pct}%`,
          transition: 'all 60ms linear',
        }} />
      </div>
      <span style={{
        width: 30,
        textAlign: 'right',
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        color: active ? 'var(--text-secondary)' : 'var(--text-disabled)',
        fontVariantNumeric: 'tabular-nums',
      }}>
        {value >= 0 ? '+' : ''}{value.toFixed(1)}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Deadzone helper                                                     */
/* ------------------------------------------------------------------ */

const DEADZONE = 0.09;
function dz(v: number): number {
  return Math.abs(v) < DEADZONE ? 0 : v;
}

/* ------------------------------------------------------------------ */
/*  Main component                                                      */
/* ------------------------------------------------------------------ */

interface PadInfo {
  name: string;
}

export function ManualControl({
  armed,
  flying,
  manualActive,
  onEngage,
  onRelease,
  onInput,
  onControllerChange,
}: ManualControlProps) {
  const [axes, setAxes] = React.useState<ManualInput>({ throttle: 0, yaw: 0, pitch: 0, roll: 0 });
  const [pad, setPad] = React.useState<PadInfo | null>(null);

  // Keep a stable ref to avoid poll-loop closure staleness
  const activeRef = React.useRef(manualActive);
  activeRef.current = manualActive;

  const keysRef = React.useRef<Record<string, boolean>>({});

  // Keyboard fallback (active only when manual mode engaged)
  React.useEffect(() => {
    const codes = ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    const down = (e: KeyboardEvent) => {
      if (activeRef.current && codes.includes(e.code)) {
        keysRef.current[e.code] = true;
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (codes.includes(e.code)) keysRef.current[e.code] = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // Gamepad poll loop
  React.useEffect(() => {
    let raf = 0;
    let lastPadId: string | null = null;

    const tick = () => {
      const gps = navigator.getGamepads ? navigator.getGamepads() : [];
      let gp: Gamepad | null = null;
      for (const g of gps) {
        if (g && g.connected) { gp = g; break; }
      }

      const id = gp ? gp.id : null;
      if (id !== lastPadId) {
        const wasConnected = lastPadId !== null;
        lastPadId = id;
        setPad(gp ? { name: gp.id.replace(/\(.*\)/, '').trim().slice(0, 28) || 'Gamepad' } : null);
        onControllerChange(!!gp);
        // Failsafe (LINUX_PRD §5): a controller unplug while MANUAL is active must
        // IMMEDIATELY zero the stick input and fall back to position-hold — never
        // freeze the last command. Clear any held keyboard keys too so a stuck key
        // can't carry the vehicle. (Implemented here because this poll loop is the
        // gamepad owner; the companion's manual watchdog is the second line.)
        if (wasConnected && !gp && activeRef.current) {
          keysRef.current = {};
          const zero: ManualInput = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
          setAxes(zero);
          onInput(zero);
        }
      }

      let v: ManualInput = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };

      if (gp) {
        const a = gp.axes;
        v = {
          yaw:      dz(a[0] ?? 0),
          throttle: dz(-(a[1] ?? 0)),
          roll:     dz(a[2] ?? 0),
          pitch:    dz(-(a[3] ?? 0)),
        };
        // B / Circle (button index 1) releases manual
        if (gp.buttons[1] && gp.buttons[1].pressed && activeRef.current) {
          onRelease();
        }
      } else {
        const k = keysRef.current;
        v = {
          throttle: (k['KeyW'] ? 1 : 0) - (k['KeyS'] ? 1 : 0),
          yaw:      (k['KeyD'] ? 1 : 0) - (k['KeyA'] ? 1 : 0),
          pitch:    (k['ArrowUp'] ? 1 : 0) - (k['ArrowDown'] ? 1 : 0),
          roll:     (k['ArrowRight'] ? 1 : 0) - (k['ArrowLeft'] ? 1 : 0),
        };
      }

      setAxes(v);
      if (activeRef.current) onInput(v);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [onInput, onRelease, onControllerChange]);

  const statusPillStatus = manualActive ? 'active' : pad ? 'info' : 'neutral';
  const statusPillLabel = manualActive ? 'Active' : pad ? 'Ready' : 'No pad';

  return (
    <Panel
      title="Manual control"
      icon={
        <Ic
          d={<>
            <path d="M6 11h4M8 9v4" />
            <circle cx="16" cy="10" r="1.2" fill="currentColor" stroke="none" />
            <circle cx="18" cy="13" r="1.2" fill="currentColor" stroke="none" />
            <rect x="2" y="6" width="20" height="12" rx="6" />
          </>}
          s={14}
        />
      }
      status={
        <StatusPill size="sm" status={statusPillStatus} pulse={manualActive}>
          {statusPillLabel}
        </StatusPill>
      }
    >
      {/* Stick visualizers */}
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
        <Stick
          label="Throttle / Yaw"
          x={axes.yaw}
          y={-axes.throttle}
          active={manualActive}
          tl="↑ thr"
          bl="yaw"
        />
        <Stick
          label="Pitch / Roll"
          x={axes.roll}
          y={-axes.pitch}
          active={manualActive}
          tl="pitch"
          bl="roll"
        />
      </div>

      {/* Channel bars */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '7px 14px', marginTop: 12 }}>
        <Chan label="THR"   value={axes.throttle} active={manualActive} />
        <Chan label="YAW"   value={axes.yaw}      active={manualActive} />
        <Chan label="PITCH" value={axes.pitch}    active={manualActive} />
        <Chan label="ROLL"  value={axes.roll}     active={manualActive} />
      </div>

      {/* Engage / Release */}
      <div style={{ marginTop: 13 }}>
        {!manualActive ? (
          <HoldButton
            variant="primary"
            disabled={!armed || !flying}
            hint={!armed ? 'Arm first' : !flying ? 'Take off first' : 'Hold to take control'}
            icon={
              <Ic
                d={<>
                  <rect x="2" y="6" width="20" height="12" rx="6" />
                  <path d="M7 11h3M8.5 9.5v3" />
                </>}
                s={16}
              />
            }
            onConfirm={onEngage}
          >
            Take manual control
          </HoldButton>
        ) : (
          <button
            onClick={onRelease}
            style={{
              display: 'flex',
              width: '100%',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              height: 'var(--control-h-lg)',
              background: 'var(--surface-input)',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-sans)',
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            <Ic
              d={<>
                <path d="M9 10l-5 5 5 5" />
                <path d="M4 15h11a5 5 0 0 0 5-5V4" />
              </>}
              s={14}
            />
            Release to auto-hold
          </button>
        )}
      </div>

      {/* Source hint */}
      <div style={{ marginTop: 9, display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: 'var(--text-tertiary)' }}>
        <span style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: pad ? 'var(--green)' : 'var(--gray-6)',
          flex: 'none',
        }} />
        {pad ? (
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-secondary)' }}>
            {pad.name}
          </span>
        ) : (
          <span>
            No controller · keyboard{' '}
            <b style={{ color: 'var(--text-secondary)' }}>WASD</b>
            {' '}+{' '}
            <b style={{ color: 'var(--text-secondary)' }}>arrows</b>
          </span>
        )}
      </div>
    </Panel>
  );
}
