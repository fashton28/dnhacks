/* TelemetryPanel — the right-hand column: attitude + heading instruments, the
 * primary readouts, the GPS/battery/position minis and two sparklines fed by
 * App.tsx's 1 Hz history (altitude and battery, 60 samples). */
import React from 'react';
import { Panel } from '@/components/Panel';
import { GaugeReadout, type GaugeReadoutStatus } from '@/components/GaugeReadout';
import { AttitudeIndicator } from '@/instruments/AttitudeIndicator';
import { Compass } from '@/instruments/Compass';
import type { Telemetry, TrackingStatus } from '@/contract';

export interface TelemetryPanelProps {
  tel: Telemetry | null;
  tracking: TrackingStatus | null;
  history: {
    alt: number[];
    bat: number[];
  };
}

/* ------------------------------------------------------------------ */
/*  Pure helpers, exported for tests                                    */
/* ------------------------------------------------------------------ */

export type BatteryBand = 'nominal' | 'caution' | 'danger';

export const BATTERY_DANGER_PCT = 15;
export const BATTERY_CAUTION_PCT = 30;

export function batteryBand(remainingPct: number): BatteryBand {
  if (remainingPct <= BATTERY_DANGER_PCT) return 'danger';
  if (remainingPct <= BATTERY_CAUTION_PCT) return 'caution';
  return 'nominal';
}

/** Climb/descent arrow; ±0.1 m/s is treated as level. */
export function verticalTrend(verticalSpeed: number): 'up' | 'down' | null {
  if (verticalSpeed > 0.1) return 'up';
  if (verticalSpeed < -0.1) return 'down';
  return null;
}

/** SVG path for a sparkline: samples spread evenly across `w`, scaled to the
 *  sample range with `pad` px kept clear top and bottom. An empty series plots
 *  as a single zero. */
export function sparklinePath(data: readonly number[], w: number, h: number, pad = 2): string {
  const series = data.length ? data : [0];
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of series) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  const xStep = series.length > 1 ? w / (series.length - 1) : 0;
  const yScale = h - pad * 2;
  return series
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * xStep).toFixed(2)} ${(pad + (1 - (v - lo) / span) * yScale).toFixed(2)}`)
    .join(' ');
}

const BAND_COLOR: Record<BatteryBand, string> = {
  nominal: 'var(--green)',
  caution: 'var(--amber)',
  danger: 'var(--red)',
};

function fixed(v: number | undefined, digits: number): string {
  return (v ?? 0).toFixed(digits);
}

/* ------------------------------------------------------------------ */
/*  Pieces                                                              */
/* ------------------------------------------------------------------ */

const LABEL: React.CSSProperties = {
  fontSize: 9.5,
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-tertiary)',
};

function MiniReadout({ label, value, wide = false }: { label: string; value: React.ReactNode; wide?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, gridColumn: wide ? 'span 2' : 'auto' }}>
      <span style={LABEL}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
    </div>
  );
}

function Sparkline({ label, data, unit, color }: { label: string; data: number[]; unit: string; color: string }) {
  const w = 252;
  const h = 34;
  const d = React.useMemo(() => sparklinePath(data, w, h), [data]);
  const latest = data.length ? data[data.length - 1] : 0;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
        <span style={LABEL}>{label}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
          {latest.toFixed(1)} {unit}
        </span>
      </div>
      <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
        <path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

interface GaugeSpec {
  label: string;
  value: string;
  unit: string;
  status?: GaugeReadoutStatus;
  trend?: 'up' | 'down' | null;
}

/* ------------------------------------------------------------------ */
/*  Panel                                                               */
/* ------------------------------------------------------------------ */

export function TelemetryPanel({ tel, tracking, history }: TelemetryPanelProps) {
  const pos = tel?.position;
  const vel = tel?.velocity;
  const gps = tel?.gps;
  const bat = tel?.battery;

  const range = tracking?.state === 'locked' ? (tracking.estimatedDistance ?? null) : null;
  const batteryPct = bat?.remaining ?? 100;
  const band = batteryBand(batteryPct);

  const gauges: GaugeSpec[] = [
    { label: 'Rel Alt', value: fixed(pos?.relAlt, 1), unit: 'm' },
    { label: 'Ground Spd', value: fixed(vel?.groundspeed, 1), unit: 'm/s' },
    { label: 'Vert Spd', value: fixed(vel?.verticalSpeed, 1), unit: 'm/s', trend: verticalTrend(vel?.verticalSpeed ?? 0) },
    { label: 'To Home', value: fixed(tel?.home?.distance, 0), unit: 'm' },
    range != null
      ? { label: 'To Target', value: range.toFixed(1), unit: 'm', status: 'caution' }
      : { label: 'To Target', value: '—', unit: '', status: 'muted' },
    { label: 'Battery', value: fixed(batteryPct, 0), unit: '%', status: band },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0, overflow: 'auto' }}>
      <Panel title="Attitude & heading" pad>
        <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'center', gap: 8 }}>
          <AttitudeIndicator roll={tel?.attitude?.roll ?? 0} pitch={tel?.attitude?.pitch ?? 0} size={132} label={false} />
          <Compass heading={tel?.heading ?? 0} size={132} label={false} />
        </div>
      </Panel>

      <Panel title="Telemetry">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 10px' }}>
          {gauges.map((g) => (
            <GaugeReadout key={g.label} label={g.label} value={g.value} unit={g.unit} size="md" status={g.status} trend={g.trend} />
          ))}
        </div>

        <hr style={{ height: 1, border: 0, background: 'var(--border-subtle)', margin: '12px 0' }} />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px 8px' }}>
          <MiniReadout label="Sats" value={gps?.satellites ?? '—'} />
          <MiniReadout label="HDOP" value={fixed(gps?.hdop, 1)} />
          <MiniReadout label="Voltage" value={`${fixed(bat?.voltage, 1)}V`} />
          <MiniReadout label="Lat" value={fixed(pos?.lat, 4)} />
          <MiniReadout label="Lon" value={fixed(pos?.lon, 4)} wide />
        </div>
      </Panel>

      <Panel title="History">
        <Sparkline label="Altitude" data={history.alt} unit="m" color="var(--accent)" />
        <div style={{ height: 10 }} />
        <Sparkline label="Battery" data={history.bat} unit="%" color={BAND_COLOR[band]} />
      </Panel>
    </div>
  );
}
