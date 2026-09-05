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
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function Sep() {
  return (
    <div style={{ width: 1, height: 22, background: 'var(--border-subtle)', flex: 'none' }} />
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
  const b = tel?.battery?.remaining ?? 100;
  const armed = tel?.armed ?? false;
  const connected = connState === 'connected';
  const fixType = tel?.gps?.fixType ?? 0;
  const fixLabel = (['NO GPS', 'NO FIX', '2D', '3D', 'DGPS', 'RTK', 'RTK'][fixType]) ?? '3D';
  const displayHost = host ?? (sitl ? 'sitl' : tel ? '192.168.1.42' : '—');

  const connStatus = connected
    ? 'nominal'
    : connState === 'connecting'
    ? 'caution'
    : 'danger';

  const connLabel = connected
    ? 'Connected'
    : connState === 'connecting'
    ? 'Connecting'
    : 'Disconnected';

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
      {/* Logo */}
      <img src={logoMark} width={24} height={24} alt="" style={{ flex: 'none' }} />

      {/* Connection state */}
      <StatusPill
        status={connStatus}
        dot
        pulse={connState === 'connecting'}
      >
        {connLabel}
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

      {/* Host / SITL badge */}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: -6 }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' }}>
          {displayHost}
        </span>
        <Badge tone={sourceKind === 'mock' || sitl ? 'caution' : 'nominal'}>
          {sourceKind === 'mock' ? 'MOCK' : sitl ? 'SITL' : 'LIVE'}
        </Badge>
      </span>

      <Sep />

      {/* Armed / Disarmed */}
      <StatusPill status={armed ? 'danger' : 'neutral'} solid={armed}>
        {armed ? 'Armed' : 'Disarmed'}
      </StatusPill>

      {/* Mode */}
      <span style={{
        fontFamily: 'var(--font-sans)',
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: '0.04em',
        color: 'var(--accent-text)',
      }}>
        {tel?.mode ?? 'LOITER'}
      </span>

      <Sep />

      {/* Flight timer */}
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1, gap: 2 }}>
        <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>FLIGHT</span>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          color: 'var(--text-primary)',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {fmtTime(elapsed)}
        </span>
      </div>

      <Sep />

      {/* Battery gauge */}
      <div style={{ width: 116 }}>
        <BatteryGauge remaining={b} voltage={tel?.battery?.voltage} compact />
      </div>

      <Sep />

      {/* GPS */}
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1, gap: 2 }}>
        <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--text-tertiary)' }}>
          GPS · {fixLabel}
        </span>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          color: 'var(--text-primary)',
          fontVariantNumeric: 'tabular-nums',
        }}>
          {tel?.gps?.satellites ?? '—'} sats
        </span>
      </div>

      <Sep />

      {/* Signal gauge */}
      <SignalGauge
        rssi={tel?.link?.rssi ?? -60}
        latencyMs={tel?.link?.latencyMs}
        lost={!connected}
      />

      <span style={{ display: 'inline-flex', gap: 4 }}>
        <Badge tone={tel?.navSource === 'gps' ? 'nominal' : tel?.navSource ? 'caution' : 'outline'}>{(tel?.navSource ?? 'NAV ?').toUpperCase()}</Badge>
        <Badge tone={spectrum?.state === 'nominal' ? 'nominal' : spectrum ? 'danger' : 'outline'}>RF {spectrum?.state ?? '?'}</Badge>
        <Badge tone={health.link?.state === 'nominal' ? 'nominal' : health.link ? 'danger' : 'outline'}>LINK {health.link?.state ?? '?'}</Badge>
        <Badge tone={health.planner?.state === 'nominal' ? 'nominal' : health.planner ? 'danger' : 'outline'}>PLAN {health.planner?.state ?? '?'}</Badge>
      </span>

      <Sep />

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

      {/* Right side: controller indicator + actions + DISARM */}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>

        {/* Controller / Manual indicator */}
        <span
          title={manualActive ? 'Manual control active' : controllerOn ? 'Controller connected' : 'No controller'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 26,
            padding: '0 9px',
            background: manualActive ? 'var(--accent-subtle)' : 'var(--surface-input)',
            border: `1px solid ${manualActive ? 'var(--accent-border)' : 'var(--border-input)'}`,
            borderRadius: 'var(--radius-sm)',
            color: manualActive
              ? 'var(--accent-text)'
              : controllerOn
              ? 'var(--nominal-fg)'
              : 'var(--text-tertiary)',
            fontFamily: 'var(--font-sans)',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.04em',
          }}
        >
          <Gamepad2 size={15} />
          {manualActive ? 'MANUAL' : controllerOn ? 'PAD' : 'NO PAD'}
        </span>

        {/* Optional action buttons */}
        {onOpenFailsafe && (
          <IconButton
            icon={<ShieldAlert size={16} />}
            title="Failsafe settings"
            onClick={onOpenFailsafe}
            variant="solid"
          />
        )}
        {onOpenPid && (
          <IconButton
            icon={<Sliders size={16} />}
            title="PID tuning"
            onClick={onOpenPid}
            variant="solid"
          />
        )}
        {onOpenLogs && (
          <IconButton
            icon={<ScrollText size={16} />}
            title="Log browser"
            onClick={onOpenLogs}
            variant="solid"
          />
        )}

        {/* Settings */}
        <IconButton
          icon={<Settings size={16} />}
          title="Settings"
          onClick={onOpenSettings}
          variant="solid"
        />

        {/* DISARM / KILL */}
        <button
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
      </div>
    </header>
  );
}
