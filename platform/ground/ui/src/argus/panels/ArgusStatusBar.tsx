import React from 'react';
import { StatusPill, Badge } from '@/components';
import { useArgus, STATUS_COLOR, STATUS_LABEL } from '../store';

export function ArgusStatusBar({ hubLabel, onHelp }: { hubLabel: string; onHelp: () => void }): React.ReactElement {
  const conn = useArgus((s) => s.conn);
  const drone = useArgus((s) => (s.selected ? s.fleet[s.selected] : undefined));
  const manual = useArgus((s) => s.manualActive);
  const [clock, setClock] = React.useState(() => new Date().toLocaleTimeString());
  React.useEffect(() => { const id = setInterval(() => setClock(new Date().toLocaleTimeString()), 1000); return () => clearInterval(id); }, []);
  const ok = conn === 'connected';
  return (
    <div style={{ height: 40, flex: 'none', display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', borderBottom: '1px solid var(--border-default)', background: 'var(--surface-panel)' }}>
      <span style={{ fontWeight: 700, letterSpacing: '0.14em', color: 'var(--green-bright)', fontSize: 13 }}>◈ ARGUS</span>
      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Meridian Station</span>
      <span style={{ width: 1, height: 18, background: 'var(--border-default)' }} />
      <StatusPill status={ok ? 'nominal' : conn === 'error' ? 'critical' : 'caution'} size="sm" dot>{ok ? 'HUB LIVE' : conn.toUpperCase()}</StatusPill>
      {drone && (
        <>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 600 }}>{drone.drone_id}</span>
          <Badge tone="outline" mono style={{ color: STATUS_COLOR[drone.status], borderColor: STATUS_COLOR[drone.status] }}>{STATUS_LABEL[drone.status]}</Badge>
          <span className="eis-readout" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{drone.alt.toFixed(1)} m · {drone.battery_pct.toFixed(0)}% · {drone.mode || '—'}</span>
        </>
      )}
      {manual && <Badge tone="caution" mono>MANUAL CONTROL · H releases</Badge>}
      <span style={{ flex: 1 }} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' }}>{hubLabel}</span>
      <span className="eis-readout" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{clock}</span>
      <button onClick={onHelp} title="Keyboard shortcuts" style={{ width: 24, height: 24, borderRadius: 999, border: '1px solid var(--border-default)', background: 'transparent', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12 }}>?</button>
    </div>
  );
}
