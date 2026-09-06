import React from 'react';
import { Thermometer, Gauge, Siren, Radiation, Activity } from 'lucide-react';
import { useArgus } from '../store';

const unit = (u: string): string => (u === 'C' ? '°C' : u);
const ICON: Record<string, React.ReactElement> = { temperature: <Thermometer size={14} />, valve: <Gauge size={14} />, fire_alarm: <Siren size={14} />, radiation: <Radiation size={14} /> };

/** The plant's own instrumentation, newest first: the second witness beside the Drone's camera. */
export function PlantSignals(): React.ReactElement | null {
  const signals = useArgus((s) => s.plantSignals);
  if (signals.length === 0) return null;
  const worst = signals.some((s) => s.severity === 'alarm') ? 'alarm' : signals.some((s) => s.severity === 'warning') ? 'warning' : 'info';
  return (
    <div className="a-glass a-plant a-in" aria-label="Plant signals">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="a-label">Plant signals</span><span style={{ flex: 1 }} />
        <span className="a-chip" style={{ color: worst === 'alarm' ? 'var(--red-bright)' : worst === 'warning' ? 'var(--amber-bright)' : 'var(--text-tertiary)' }}>{worst}</span>
      </div>
      {signals.slice(0, 3).map((s) => (
        <div key={s.sensor_id} className="row" data-sev={s.severity} title={`${s.sensor_id} · ${new Date(s.ts).toLocaleTimeString()}${s.note ? ` · ${s.note}` : ''}`}>
          <span className="k">{ICON[s.kind] ?? <Activity size={14} />}</span>
          <div style={{ minWidth: 0 }}><div className="name">{s.asset.name}</div><div className="note">{s.note || s.kind.replace(/_/g, ' ')}</div></div>
          <div className="val">{typeof s.value === 'number' ? `${s.value % 1 === 0 ? s.value : s.value.toFixed(1)} ${unit(s.unit)}`.trim() : s.value || '—'}{s.threshold !== null && s.threshold !== '' ? <small>limit {typeof s.threshold === 'number' ? `${s.threshold} ${unit(s.unit)}`.trim() : s.threshold}</small> : null}</div>
        </div>
      ))}
    </div>
  );
}
