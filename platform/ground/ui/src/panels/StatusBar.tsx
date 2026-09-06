/* StatusBar — the one-line summary across the top of the ground station.
 *
 * Left to right: link state, (fleet selector), host + source badge, arm state,
 * flight mode, flight clock, battery, GPS fix, link gauge, the navigation /
 * RF / health badges, envelope monitor, attendance mode and the escalation
 * outbox. Right: controller indicator, tool buttons and the DISARM kill
 * switch, which is always reachable and never gated on anything. */
import React from 'react';
import {
  Settings,
  Power,
  Gamepad2,
  ShieldAlert,
  Sliders,
  ScrollText,
} from 'lucide-react';
import { StatusPill } from '@/components/StatusPill';
import { Badge } from '@/components/Badge';
import { IconButton } from '@/components/IconButton';
import { BatteryGauge } from '@/instruments/BatteryGauge';
import { SignalGauge } from '@/instruments/SignalGauge';
import logoMark from '@/assets/logo-mark.svg';
import type {
  ConnectionState,
  EnvelopeMessage,
  EnvelopeState,
  HealthEventMessage,
  ModeMessage,
  SpectrumMessage,
  Telemetry,
} from '@/contract';

/* ------------------------------------------------------------------ */
/*  Pure helpers, exported for tests                                    */
/* ------------------------------------------------------------------ */

/** Flight clock as MM:SS; minutes keep counting past 59. */
export function formatFlightTime(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(whole / 60);
  const seconds = whole - minutes * 60;
  return [minutes, seconds].map((n) => String(n).padStart(2, '0')).join(':');
}

/** MAVLink GPS_FIX_TYPE → short label. Anything past RTK (or nonsense) reads as 3D. */
export function gpsFixLabel(fixType: number): string {
  switch (fixType) {
    case 0: return 'NO GPS';
    case 1: return 'NO FIX';
    case 2: return '2D';
    case 4: return 'DGPS';
    case 5:
    case 6: return 'RTK';
    default: return '3D';
  }
}

export interface LinkPillSpec {
  status: 'nominal' | 'caution' | 'danger';
  label: string;
  pulse: boolean;
}

export function connectionPill(state: ConnectionState): LinkPillSpec {
  switch (state) {
    case 'connected':  return { status: 'nominal', label: 'Connected', pulse: false };
    case 'connecting': return { status: 'caution', label: 'Connecting', pulse: true };
    default:           return { status: 'danger', label: 'Disconnected', pulse: false };
  }
}

/** Host caption next to the source badge. Without an explicit host the SITL
 *  build says so; a live vehicle with no host configured shows the prototype's
 *  placeholder address; nothing at all shows an em dash. */
export function hostCaption(host: string | undefined, sitl: boolean, hasTelemetry: boolean): string {
  if (host !== undefined) return host;
  if (sitl) return 'sitl';
  return hasTelemetry ? '192.168.1.42' : '—';
}

export type PadIndicatorState = 'manual' | 'pad' | 'none';

export function padIndicatorState(manualActive: boolean, controllerOn: boolean): PadIndicatorState {
  return manualActive ? 'manual' : controllerOn ? 'pad' : 'none';
}

/* ------------------------------------------------------------------ */
/*  Pieces                                                              */
/* ------------------------------------------------------------------ */

function Divider() {
  return <div role="separator" aria-orientation="vertical" style={{ width: 1, height: 22, background: 'var(--border-subtle)', flex: 'none' }} />;
}

/** A tiny label over a monospace value — the flight clock and the GPS block. */
function Readout({ label, value }: { label: React.ReactNode; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1, gap: 2 }}>
      <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
    </div>
  );
}

const PAD_LOOK: Readonly<Record<PadIndicatorState, { label: string; title: string; fg: string; bg: string; border: string }>> = {
  manual: { label: 'MANUAL', title: 'Manual control active', fg: 'var(--accent-text)', bg: 'var(--accent-subtle)', border: 'var(--accent-border)' },
  pad:    { label: 'PAD',    title: 'Controller connected',  fg: 'var(--nominal-fg)',  bg: 'var(--surface-input)', border: 'var(--border-input)' },
  none:   { label: 'NO PAD', title: 'No controller',         fg: 'var(--text-tertiary)', bg: 'var(--surface-input)', border: 'var(--border-input)' },
};

function PadIndicator({ state }: { state: PadIndicatorState }) {
  const look = PAD_LOOK[state];
  return (
    <span
      title={look.title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height: 26,
        padding: '0 9px',
        background: look.bg,
        border: `1px solid ${look.border}`,
        borderRadius: 'var(--radius-sm)',
        color: look.fg,
        fontFamily: 'var(--font-sans)',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.04em',
      }}
    >
      <Gamepad2 size={15} />
      {look.label}
    </span>
  );
}

/** DISARM / KILL. Lit red while armed; still clickable when not, because the
 *  app treats it as emergencyStop and that must never depend on UI state. */
function KillSwitch({ armed, onDisarm }: { armed: boolean; onDisarm: () => void }) {
  return (
    <button
      type="button"
      onClick={onDisarm}
      title="Disarm / Kill (Space)"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        height: 34,
        padding: '0 16px',
        background: armed ? 'var(--red-deep)' : 'var(--surface-input)',
        border: `1px solid ${armed ? 'var(--red)' : 'var(--border-input)'}`,
        borderRadius: 'var(--radius-md)',
        color: armed ? '#fff' : 'var(--text-secondary)',
        fontFamily: 'var(--font-sans)',
        fontSize: 13,
        fontWeight: 700,
        letterSpacing: '0.04em',
        cursor: 'pointer',
        boxShadow: armed ? 'var(--glow-critical)' : 'none',
        transition: 'all var(--dur-base) var(--ease-out)',
      }}
    >
      <Power size={15} />
      DISARM
    </button>
  );
}

/** Compact status-bar control, sized to sit alongside the badges. */
function miniButton(bg: string, border: string, fg: string): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    height: 18,
    padding: '0 7px',
    background: bg,
    border: `1px solid ${border}`,
    borderRadius: 'var(--radius-xs)',
    color: fg,
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-2xs)',
    fontWeight: 600,
    lineHeight: 1,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  };
}

/* ------------------------------------------------------------------ */
/*  Props                                                               */
/* ------------------------------------------------------------------ */

export interface StatusBarProps {
  tel: Telemetry | null;
  connState: ConnectionState;
  sitl: boolean;
  sourceKind?: 'mock' | 'live' | 'hub';
  host?: string;
  elapsed: number;
  controllerOn: boolean;
  manualActive: boolean;
  health?: Partial<Record<HealthEventMessage['component'], HealthEventMessage>>;
  spectrum?: SpectrumMessage | null;
  onDisarm: () => void;
  onOpenSettings: () => void;
  onOpenFailsafe?: () => void;
  onOpenPid?: () => void;
  onOpenLogs?: () => void;
  /** ARGUS fleet: when present, a selector picks which Drone the dashboard follows. */
  fleet?: { vehicleId: string; status: string; batteryPct: number }[];
  selectedVehicle?: string;
  onSelectVehicle?: (id: string) => void;
  /** Envelope monitor report for the followed vehicle. */
  envelope?: EnvelopeMessage | null;
  /** Attendance mode + the operator-presence liveness signal behind it. */
  attendance?: ModeMessage | null;
  /** Escalations raised this session, and how many are still undelivered. */
  escalationCount?: number;
  undeliveredCount?: number;
  onOpenOutbox?: () => void;
  /** Opens the signed-confirmation flow for entering unattended mode. */
  onEnterUnattended?: () => void;
  onExitUnattended?: () => void;
}

const ENVELOPE_TONE: Record<EnvelopeState, 'nominal' | 'caution' | 'danger'> = {
  in_envelope: 'nominal',
  warning: 'caution',
  breach: 'danger',
};

const ENVELOPE_LABEL: Record<EnvelopeState, string> = {
  in_envelope: 'IN ENVELOPE',
  warning: 'WARNING',
  breach: 'BREACH',
};

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

export function StatusBar({
  tel,
  connState,
  sitl,
  sourceKind = 'live',
  host,
  elapsed,
  controllerOn,
  manualActive,
  health = {},
  spectrum = null,
  onDisarm,
  onOpenSettings,
  onOpenFailsafe,
  onOpenPid,
  onOpenLogs,
  fleet,
  selectedVehicle,
  onSelectVehicle,
  envelope = null,
  attendance = null,
  escalationCount = 0,
  undeliveredCount = 0,
  onOpenOutbox,
  onEnterUnattended,
  onExitUnattended,
}: StatusBarProps) {
  const connected = connState === 'connected';
  const armed = tel?.armed === true;
  const link = connectionPill(connState);

  const tools: { open: (() => void) | undefined; icon: React.ReactNode; title: string }[] = [
    { open: onOpenFailsafe, icon: <ShieldAlert size={16} />, title: 'Failsafe settings' },
    { open: onOpenPid, icon: <Sliders size={16} />, title: 'PID tuning' },
    { open: onOpenLogs, icon: <ScrollText size={16} />, title: 'Log browser' },
    { open: onOpenSettings, icon: <Settings size={16} />, title: 'Settings' },
  ];

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        height: 'var(--statusbar-h)',
        flex: 'none',
        padding: '0 12px',
        background: 'var(--surface-raised)',
        borderBottom: '1px solid var(--border-default)',
      }}
    >
      <img src={logoMark} width={24} height={24} alt="" style={{ flex: 'none' }} />

      <StatusPill status={link.status} dot pulse={link.pulse}>
        {link.label}
      </StatusPill>

      {/* ARGUS fleet selector */}
      {fleet && fleet.length > 0 && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>DRONE</span>
          <select
            aria-label="Select Drone"
            value={selectedVehicle ?? fleet[0].vehicleId}
            onChange={(e) => onSelectVehicle?.(e.target.value)}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 12, padding: '3px 6px', background: 'var(--surface-sunken, #0b0e12)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', borderRadius: 6 }}
          >
            {fleet.map((v) => (
              <option key={v.vehicleId} value={v.vehicleId}>
                {v.vehicleId} · {v.status.replace('_', ' ')} · {Math.round(v.batteryPct)}%
              </option>
            ))}
          </select>
        </span>
      )}

      {/* Host caption + data-source badge */}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: -6 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' }}>
          {hostCaption(host, sitl, tel !== null)}
        </span>
        <Badge tone={sourceKind === 'mock' || sitl ? 'caution' : 'nominal'}>
          {sourceKind === 'mock' ? 'MOCK' : sitl ? 'SITL' : 'LIVE'}
        </Badge>
      </span>

      <Divider />

      <StatusPill status={armed ? 'danger' : 'neutral'} solid={armed}>
        {armed ? 'Armed' : 'Disarmed'}
      </StatusPill>

      <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--accent-text)' }}>
        {tel?.mode ?? 'LOITER'}
      </span>

      <Divider />

      <Readout label="FLIGHT" value={formatFlightTime(elapsed)} />

      <Divider />

      <div style={{ width: 116 }}>
        <BatteryGauge remaining={tel?.battery?.remaining ?? 100} voltage={tel?.battery?.voltage} compact />
      </div>

      <Divider />

      <Readout label={<>GPS · {gpsFixLabel(tel?.gps?.fixType ?? 0)}</>} value={<>{tel?.gps?.satellites ?? '—'} sats</>} />

      <Divider />

      <SignalGauge rssi={tel?.link?.rssi ?? -60} latencyMs={tel?.link?.latencyMs} lost={!connected} />

      <span style={{ display: 'inline-flex', gap: 4 }}>
        <Badge tone={tel?.navSource === 'gps' ? 'nominal' : tel?.navSource ? 'caution' : 'outline'}>{(tel?.navSource ?? 'NAV ?').toUpperCase()}</Badge>
        <Badge tone={spectrum?.state === 'nominal' ? 'nominal' : spectrum ? 'danger' : 'outline'}>RF {spectrum?.state ?? '?'}</Badge>
        <Badge tone={health.link?.state === 'nominal' ? 'nominal' : health.link ? 'danger' : 'outline'}>LINK {health.link?.state ?? '?'}</Badge>
        <Badge tone={health.planner?.state === 'nominal' ? 'nominal' : health.planner ? 'danger' : 'outline'}>PLAN {health.planner?.state ?? '?'}</Badge>
      </span>

      <Divider />

      {/* Envelope monitor: state, the binding constraint, and the margin to it.
          A missing report reads as unknown — never as "fine". */}
      <span
        title={
          envelope
            ? `Envelope ${envelope.state}` +
              (envelope.constraint ? ` · binding constraint: ${envelope.constraint}` : '') +
              (envelope.margin_m !== undefined ? ` · margin ${envelope.margin_m.toFixed(1)} m` : '') +
              (envelope.action && envelope.action !== 'none' ? ` · action ${envelope.action}` : '')
            : 'No envelope report for this vehicle'
        }
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
      >
        <Badge tone={envelope ? ENVELOPE_TONE[envelope.state] : 'outline'} mono>
          {envelope ? ENVELOPE_LABEL[envelope.state] : 'ENVELOPE ?'}
        </Badge>
        {envelope?.constraint && (
          <Badge tone="outline" mono>
            {envelope.constraint}
            {envelope.margin_m !== undefined
              ? ` ${envelope.margin_m >= 0 ? '+' : ''}${envelope.margin_m.toFixed(1)} m`
              : ''}
          </Badge>
        )}
        {envelope?.action && envelope.action !== 'none' && (
          <Badge tone="danger" mono>{envelope.action.toUpperCase()}</Badge>
        )}
      </span>

      {/* Attendance mode + the signed entry control. */}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <Badge
          tone={attendance?.mode === 'unattended' ? 'caution' : 'nominal'}
          mono
          style={attendance ? undefined : { opacity: 0.6 }}
        >
          {(attendance?.mode ?? 'attended').toUpperCase()}
        </Badge>
        {attendance && !attendance.operatorPresent && (
          <Badge tone="danger" mono>OPERATOR ABSENT</Badge>
        )}
        {attendance?.mode === 'unattended'
          ? onExitUnattended && (
              <button
                type="button"
                onClick={onExitUnattended}
                title="Return to attended operation"
                style={miniButton('var(--amber-tint)', 'var(--amber-line)', 'var(--caution-fg)')}
              >
                Exit unattended
              </button>
            )
          : onEnterUnattended && (
              <button
                type="button"
                onClick={onEnterUnattended}
                title="Enter unattended mode — requires a typed confirmation and an operator id"
                style={miniButton('var(--surface-input)', 'var(--border-input)', 'var(--text-secondary)')}
              >
                Enter unattended mode
              </button>
            )}
      </span>

      {/* Escalation outbox */}
      <button
        type="button"
        onClick={onOpenOutbox}
        title={
          escalationCount === 0
            ? 'No escalations raised'
            : `${escalationCount} escalation(s), ${undeliveredCount} undelivered`
        }
        style={{
          ...miniButton(
            undeliveredCount > 0 ? 'var(--red-tint)' : 'var(--surface-input)',
            undeliveredCount > 0 ? 'var(--red-line)' : 'var(--border-input)',
            undeliveredCount > 0 ? 'var(--danger-fg)' : 'var(--text-secondary)',
          ),
          cursor: onOpenOutbox ? 'pointer' : 'default',
        }}
      >
        OUTBOX {escalationCount}
        {undeliveredCount > 0 ? ` · ${undeliveredCount}!` : ''}
      </button>

      {/* Right side: controller indicator, tools, kill switch */}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        <PadIndicator state={padIndicatorState(manualActive, controllerOn)} />

        {tools.map((tool) =>
          tool.open ? <IconButton key={tool.title} icon={tool.icon} title={tool.title} onClick={tool.open} variant="solid" /> : null,
        )}

        <KillSwitch armed={armed} onDisarm={onDisarm} />
      </div>
    </header>
  );
}
