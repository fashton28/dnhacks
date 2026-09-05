import React from 'react';
import { Badge, Button } from '@/components';
import type { HealthEventMessage, ReadinessMessage, RfEventMessage, SensorHealth, SpectrumMessage, Telemetry } from '@/contract';

function fmtDuration(seconds: number): string {
  const clamped = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(clamped / 60)}:${String(clamped % 60).padStart(2, '0')}`;
}

function stateTone(state?: string): 'nominal' | 'caution' | 'danger' | 'outline' {
  if (!state) return 'outline';
  if (['nominal', 'ok', 'charged', 'gps'].includes(state)) return 'nominal';
  if (['degraded', 'warming', 'charging', 'optflow'].includes(state)) return 'caution';
  return 'danger';
}

export interface MissionStatusStripProps {
  telemetry: Telemetry | null;
  readiness: ReadinessMessage | null;
  health: Partial<Record<HealthEventMessage['component'], HealthEventMessage>>;
  sensors: Partial<Record<'rgb' | 'thermal' | 'lidar', SensorHealth>>;
  spectrum: SpectrumMessage | null;
  rfEvents: RfEventMessage[];
  onContinue: () => void;
  onRtl: () => void;
}

export function MissionStatusStrip({ telemetry, readiness, health, sensors, spectrum, rfEvents, onContinue, onRtl }: MissionStatusStripProps): React.ReactElement {
  const battery = telemetry?.battery;
  const sortie = telemetry?.sortie;
  const rtlLeft = sortie ? sortie.must_rtl_by_s - sortie.elapsed_s : null;
  const failure = telemetry?.failsafeState && telemetry.failsafeState !== 'none';
  const hostile = rfEvents.some((event) => event.kind === 'hostile_drone');
  return (
    <div style={{ flex: 'none', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {failure && (
        <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 10px', border: '1px solid var(--red-line)', background: 'var(--red-tint)', borderRadius: 'var(--radius-sm)', color: 'var(--danger-fg)', fontSize: 12, fontWeight: 600 }}>
          {telemetry?.failsafeState?.toUpperCase()}: {telemetry?.failsafeReason || 'safety rail active'}
          {hostile && <Button variant="secondary" onClick={onContinue} style={{ marginLeft: 'auto' }}>Operator continue</Button>}
          <Button variant="danger-soft" onClick={onRtl}>RTL</Button>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', padding: '6px 8px', background: 'var(--surface-raised)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)' }}>
        <Badge tone="caution" mono>OFFLINE SIMULATION</Badge>
        <Badge tone={readiness?.ready ? 'nominal' : 'danger'} mono>
          {readiness?.ready ? 'READY' : readiness ? 'NOT READY' : 'READINESS UNKNOWN'}
        </Badge>
        {battery && <Badge tone={stateTone(battery.charge_state)} mono>{battery.soc_pct.toFixed(0)}% · {battery.charge_state}{readiness?.eta_ready_s ? ` · ETA ${fmtDuration(readiness.eta_ready_s)}` : ''}</Badge>}
        {sortie && <Badge tone={rtlLeft !== null && rtlLeft <= 60 ? 'danger' : 'caution'} mono>MUST RTL {fmtDuration(rtlLeft ?? 0)}</Badge>}
        {(['rgb', 'thermal', 'lidar'] as const).map((sensor) => <Badge key={sensor} tone={stateTone(sensors[sensor])} mono>{sensor} {sensors[sensor] ?? '?'}</Badge>)}
        {(['gps', 'link', 'planner'] as const).map((component) => <Badge key={component} tone={stateTone(health[component]?.state ?? (component === 'gps' ? telemetry?.navSource : undefined))} mono>{component} {health[component]?.state ?? (component === 'gps' ? telemetry?.navSource : '?')}</Badge>)}
        <Badge tone={stateTone(spectrum?.state)} mono>RF {spectrum?.state ?? 'unknown'}</Badge>
        {spectrum?.bands.map((band) => (
          <span key={band.name} title={`${band.peak_mhz} MHz · ${band.occ_bw_mhz} MHz occupied`} style={{ width: 58, height: 8, borderRadius: 3, overflow: 'hidden', background: 'var(--surface-input)' }}>
            <span style={{ display: 'block', width: `${Math.min(100, Math.max(8, (band.p95_db + 120) * 2.5))}%`, height: '100%', background: spectrum.state === 'degraded' ? 'var(--danger-fg)' : 'var(--accent)' }} />
          </span>
        ))}
      </div>
      {readiness && !readiness.ready && readiness.reasons.length > 0 && (
        <div style={{ color: 'var(--danger-fg)', fontSize: 10, paddingLeft: 4 }}>{readiness.reasons.join(' · ')}</div>
      )}
    </div>
  );
}
