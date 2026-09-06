/* ControlsPanel — flight actions, mode chips and the person-tracking controls.
 *
 * Command semantics (all through `onCmd`, i.e. the acked command path):
 *   Arm       → the app's checklist-gated `onArm` flow, never `arm` directly
 *   Disarm    → `disarm`
 *   Takeoff   → the app's confirm flow, enabled only armed-and-on-the-ground
 *   Land/RTL  → `land` / `rtl`, enabled only while airborne
 *   Mode chip → `setMode { mode }`
 *   Engage    → hold-to-confirm `onEngage` (airborne only); Disengage is an
 *               instant plain button → `disengageTracking`
 * Standoff and max-speed sliders report through the app, which sends
 * `setStandoff` / `setMaxSpeed`; the companion clamps both to its safety
 * envelope, so the slider range is a UI convenience, not a limit.
 */
import React from 'react';
import {
  ArrowDown,
  ArrowUp,
  CornerDownLeft,
  Crosshair,
  LocateFixed,
  Lock,
  LockOpen,
  Plane,
  Square,
  TriangleAlert,
} from 'lucide-react';
import { Panel } from '@/components/Panel';
import { Button } from '@/components/Button';
import { HoldButton } from '@/components/HoldButton';
import { StatusPill, type StatusPillStatus } from '@/components/StatusPill';
import { Slider } from '@/components/Slider';
import type { Telemetry, TrackingStatus, TrackingState, ConnectionState, CommandName, Command, Mode } from '@/contract';
import { GIMBAL_PITCH_MAX_DEG, GIMBAL_PITCH_MIN_DEG } from '@/contract';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export type SendCmd = (command: CommandName, params?: Command['params']) => void;

export interface ControlsPanelProps {
  tel: Telemetry | null;
  tracking: TrackingStatus | null;
  connState: ConnectionState;
  standoff: number;
  maxSpeed: number;
  onCmd: SendCmd;
  onSetStandoff: (v: number) => void;
  onSetMaxSpeed: (v: number) => void;
  onArm: () => void;
  onTakeoff: () => void;
  onEngage: () => void;
  checklistDone: boolean;
  /** Commanded gimbal pitch, degrees (GIMBAL_PITCH_MIN_DEG..MAX). */
  gimbalPitch?: number;
  onSetGimbal?: (deg: number) => void;
}

/* ------------------------------------------------------------------ */
/*  Gating — pure, exported for tests                                   */
/* ------------------------------------------------------------------ */

/** Flight modes offered as one-tap chips. */
export const MODE_CHIPS: readonly Mode[] = ['LOITER', 'GUIDED', 'ALT_HOLD', 'POSHOLD', 'BRAKE'];

/** Above this relative altitude the vehicle counts as airborne. */
export const AIRBORNE_ALT_M = 0.5;

export function isAirborne(tel: Telemetry | null): boolean {
  return (tel?.position?.relAlt ?? 0) > AIRBORNE_ALT_M;
}

export interface FlightGates {
  canTakeoff: boolean;
  canLand: boolean;
  canRtl: boolean;
  canEngageTracking: boolean;
  checklistNag: boolean;
}

export function flightGates(s: { armed: boolean; flying: boolean; checklistDone: boolean }): FlightGates {
  return {
    canTakeoff: s.armed && !s.flying,
    canLand: s.flying,
    canRtl: s.flying,
    canEngageTracking: s.flying,
    checklistNag: !s.checklistDone && !s.armed,
  };
}

const TRACKING_PILL: Readonly<Record<TrackingState, { status: StatusPillStatus; pulse: boolean }>> = {
  idle:      { status: 'neutral', pulse: false },
  searching: { status: 'info',    pulse: false },
  locked:    { status: 'caution', pulse: true },
  lost:      { status: 'danger',  pulse: false },
};

export function trackingPill(state: TrackingState): { status: StatusPillStatus; pulse: boolean } {
  return TRACKING_PILL[state] ?? TRACKING_PILL.idle;
}

export const STANDOFF_SLIDER = { min: 2, max: 15, step: 0.5 } as const;
export const MAX_SPEED_SLIDER = { min: 0.5, max: 8, step: 0.5 } as const;

/* ------------------------------------------------------------------ */
/*  Pieces                                                              */
/* ------------------------------------------------------------------ */

function ModeChip({ mode, active, onSelect }: { mode: Mode; active: boolean; onSelect: (m: Mode) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(mode)}
      aria-pressed={active}
      style={{
        padding: '4px 8px',
        fontFamily: 'var(--font-mono)',
        fontSize: 10.5,
        fontWeight: 500,
        background: active ? 'var(--accent-subtle)' : 'var(--surface-input)',
        border: `1px solid ${active ? 'var(--accent-border)' : 'var(--border-input)'}`,
        color: active ? 'var(--accent-text)' : 'var(--text-secondary)',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
      }}
    >
      {mode}
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>
      {children}
    </span>
  );
}

interface FlightAction {
  key: string;
  label: string;
  icon: React.ReactNode;
  variant: 'primary' | 'secondary';
  disabled?: boolean;
  run: () => void;
}

/* ------------------------------------------------------------------ */
/*  Panel                                                               */
/* ------------------------------------------------------------------ */

export function ControlsPanel({
  tel,
  tracking,
  connState: _connState,
  standoff,
  maxSpeed,
  onCmd,
  onSetStandoff,
  onSetMaxSpeed,
  onArm,
  onTakeoff,
  onEngage,
  checklistDone,
  gimbalPitch,
  onSetGimbal,
}: ControlsPanelProps) {
  const armed = tel?.armed === true;
  const flying = isAirborne(tel);
  const gates = flightGates({ armed, flying, checklistDone });
  const tState: TrackingState = tracking?.state ?? 'idle';
  const pill = trackingPill(tState);
  const reportedPitch = tel?.gimbal?.pitchDeg;
  const commandedPitch = gimbalPitch ?? reportedPitch ?? 0;

  const actions: FlightAction[] = [
    armed
      ? { key: 'disarm', label: 'Disarm', icon: <LockOpen size={14} />, variant: 'secondary', run: () => onCmd('disarm') }
      : { key: 'arm', label: 'Arm', icon: <Lock size={14} />, variant: 'primary', run: onArm },
    { key: 'takeoff', label: 'Takeoff', icon: <ArrowUp size={14} />, variant: 'secondary', disabled: !gates.canTakeoff, run: onTakeoff },
    { key: 'land', label: 'Land', icon: <ArrowDown size={14} />, variant: 'secondary', disabled: !gates.canLand, run: () => onCmd('land') },
    { key: 'rtl', label: 'RTL', icon: <CornerDownLeft size={14} />, variant: 'secondary', disabled: !gates.canRtl, run: () => onCmd('rtl') },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <Panel title="Flight" icon={<Plane size={13} />}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7 }}>
          {actions.map((a) => (
            <Button key={a.key} variant={a.variant} block disabled={a.disabled} onClick={a.run} icon={a.icon}>
              {a.label}
            </Button>
          ))}
        </div>

        {gates.checklistNag && (
          <div role="status" style={{ marginTop: 8, fontSize: 11, color: 'var(--caution-fg)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <TriangleAlert size={13} />
            Pre-flight checklist required
          </div>
        )}

        <div style={{ marginTop: 9 }}>
          <SectionLabel>Mode</SectionLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
            {MODE_CHIPS.map((m) => (
              <ModeChip key={m} mode={m} active={tel?.mode === m} onSelect={(mode) => onCmd('setMode', { mode })} />
            ))}
          </div>
        </div>
      </Panel>

      <Panel
        title="Person tracking"
        icon={<LocateFixed size={13} />}
        status={
          <StatusPill size="sm" status={pill.status} pulse={pill.pulse}>
            {tState}
          </StatusPill>
        }
      >
        {tState === 'idle' ? (
          <HoldButton
            variant="primary"
            disabled={!gates.canEngageTracking}
            hint={gates.canEngageTracking ? 'Hold to engage' : 'Take off first'}
            icon={<Crosshair size={17} />}
            onConfirm={onEngage}
          >
            Engage Tracking
          </HoldButton>
        ) : (
          <Button
            variant="danger"
            block
            size="lg"
            icon={<Square size={15} fill="currentColor" stroke="none" />}
            onClick={() => onCmd('disengageTracking')}
            style={{ height: 'var(--control-h-xl)', fontSize: 14, fontWeight: 700, letterSpacing: '0.02em' }}
          >
            Disengage Tracking
          </Button>
        )}

        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 13 }}>
          <Slider
            label="Standoff distance"
            value={standoff}
            min={STANDOFF_SLIDER.min}
            max={STANDOFF_SLIDER.max}
            step={STANDOFF_SLIDER.step}
            unit="m"
            ticks={[`${STANDOFF_SLIDER.min} m`, `${STANDOFF_SLIDER.max} m`]}
            onChange={onSetStandoff}
          />
          <Slider
            label="Max speed"
            value={maxSpeed}
            min={MAX_SPEED_SLIDER.min}
            max={MAX_SPEED_SLIDER.max}
            step={MAX_SPEED_SLIDER.step}
            unit="m/s"
            ticks={[`${MAX_SPEED_SLIDER.min}`, `${MAX_SPEED_SLIDER.max}`]}
            accent="var(--green)"
            onChange={onSetMaxSpeed}
          />

          {/* Gimbal pitch: -30 looks UP, 0 is level, 90 is straight DOWN —
              the same convention the vehicle reports back. */}
          <div>
            <Slider
              label="Gimbal pitch"
              value={commandedPitch}
              min={GIMBAL_PITCH_MIN_DEG}
              max={GIMBAL_PITCH_MAX_DEG}
              step={1}
              unit="°"
              ticks={[`${GIMBAL_PITCH_MIN_DEG}° up`, 'level', `${GIMBAL_PITCH_MAX_DEG}° down`]}
              accent="var(--amber)"
              disabled={!onSetGimbal}
              onChange={(v) => onSetGimbal?.(v)}
            />
            <div style={{
              display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 5,
              fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-tertiary)',
              fontVariantNumeric: 'tabular-nums',
            }}>
              <span>REPORTED</span>
              <span style={{ color: reportedPitch === undefined ? 'var(--text-disabled)' : 'var(--text-primary)' }}>
                {reportedPitch === undefined ? 'no gimbal' : `${reportedPitch.toFixed(0)}°`}
              </span>
              <span style={{ marginLeft: 'auto' }}>
                {commandedPitch <= 0 ? 'looking up / level' : commandedPitch >= 80 ? 'straight down' : 'oblique down'}
              </span>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}
