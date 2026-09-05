import React from 'react';
import { CircleHelp, Hand } from 'lucide-react';
import { useArgus, STATUS_COLOR, STATUS_LABEL } from '../store';
import { ArgusMark } from '../Brand';

export function ArgusStatusBar({ hubLabel, onHelp }: { hubLabel: string; onHelp: () => void }): React.ReactElement {
  const conn = useArgus((s) => s.conn);
  const drone = useArgus((s) => (s.selected ? s.fleet[s.selected] : undefined));
  const manual = useArgus((s) => s.manualActive);
  const fleetSize = useArgus((s) => Object.keys(s.fleet).length);
  const [clock, setClock] = React.useState(() => fmtClock());
  React.useEffect(() => { const id = setInterval(() => setClock(fmtClock()), 1000); return () => clearInterval(id); }, []);
  const live = conn === 'connected';
  const connColor = live ? 'var(--a-mission)' : conn === 'error' ? 'var(--a-offline)' : 'var(--a-manual)';
  return (
    <div style={{ height: 44, flex: 'none', display: 'flex', alignItems: 'center', gap: 12, padding: '0 14px 0 12px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--surface-panel)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{ color: 'var(--green-bright)' }}><ArgusMark size={22} /></span>
        <span style={{ font: '700 13px/1 var(--font-sans)', letterSpacing: '0.18em', color: 'var(--text-primary)' }}>ARGUS</span>
        <span className="a-body" style={{ color: 'var(--text-tertiary)' }}>Meridian Station</span>
      </div>
      <span style={{ width: 1, height: 20, background: 'var(--border-subtle)' }} />
      <span className="a-chip" data-fill="true" style={{ color: connColor }}>
        <span className="a-dot" data-live={live} />{live ? 'Hub live' : conn}
      </span>
      {drone && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="a-id" style={{ fontSize: 13 }}>{drone.drone_id}</span>
          <span className="a-chip" style={{ color: STATUS_COLOR[drone.status] }}>
            <span className="a-dot" data-live={drone.status === 'on_mission' || drone.status === 'returning'} />{STATUS_LABEL[drone.status]}
          </span>
          <span className="a-num" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{drone.alt.toFixed(1)}<span className="a-unit">m</span></span>
          <span className="a-num" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{drone.battery_pct.toFixed(0)}<span className="a-unit">%</span></span>
          <span className="a-num" style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{drone.mode || '—'}</span>
        </div>
      )}
      {manual && (
        <span className="a-chip a-in" data-fill="true" style={{ color: 'var(--a-manual)' }}><Hand size={11} /> Manual control · H releases</span>
      )}
      <span style={{ flex: 1 }} />
      <span className="a-num" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{fleetSize} drones · {hubLabel}</span>
      <span className="a-num" style={{ fontSize: 12, color: 'var(--text-secondary)', minWidth: 62, textAlign: 'right' }}>{clock}</span>
      <button className="a-icobtn" onClick={onHelp} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts"><CircleHelp size={14} /></button>
    </div>
  );
}

function fmtClock(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
