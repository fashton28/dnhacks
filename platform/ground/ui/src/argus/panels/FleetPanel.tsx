import React from 'react';
import { Panel } from '@/components';
import { useArgus, STATUS_COLOR, STATUS_LABEL } from '../store';
import type { HubDroneState } from '@/dataSource/HubDataProvider';

const DroneCard = React.memo(function DroneCard({ s, index, selected, onSelect }: { s: HubDroneState; index: number; selected: boolean; onSelect: (id: string) => void }) {
  const col = STATUS_COLOR[s.status];
  const bat = Math.max(0, Math.min(100, s.battery_pct));
  const batCol = bat <= 15 ? 'var(--red)' : bat <= 30 ? 'var(--amber)' : 'var(--green)';
  return (
    <button
      onClick={() => onSelect(s.drone_id)}
      title={`Select ${s.drone_id} (key ${index + 1})`}
      style={{
        display: 'grid', gridTemplateColumns: '1fr auto', rowGap: 3, textAlign: 'left', width: '100%', cursor: 'pointer',
        padding: '7px 9px', borderRadius: 'var(--radius-md)', border: `1px solid ${selected ? 'var(--text-secondary)' : 'var(--border-default)'}`,
        background: selected ? 'var(--surface-raised)' : 'var(--surface-panel)', color: 'var(--text-primary)', font: 'inherit',
        boxShadow: selected ? '0 0 0 1px rgba(255,255,255,0.08) inset' : 'none', opacity: s.status === 'offline' ? 0.55 : 1,
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 600 }}>
        <span style={{ fontSize: 9.5, color: 'var(--text-tertiary)', border: '1px solid var(--border-default)', borderRadius: 3, padding: '0 4px' }}>{index + 1}</span>
        {s.drone_id}
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 9.5, letterSpacing: '0.08em', fontWeight: 700, color: col }}>
        <span style={{ width: 6, height: 6, borderRadius: 999, background: col }} />{STATUS_LABEL[s.status]}
      </span>
      <span className="eis-readout" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{s.alt.toFixed(1)} m · {s.mode || '—'}</span>
      <span className="eis-readout" style={{ fontSize: 11, color: batCol }}>{bat.toFixed(0)}%</span>
      <span style={{ gridColumn: '1 / -1', height: 3, borderRadius: 2, background: 'var(--gray-4)', overflow: 'hidden' }}>
        <span style={{ display: 'block', width: `${bat}%`, height: '100%', background: batCol }} />
      </span>
    </button>
  );
});

export function FleetPanel({ onSelect }: { onSelect: (id: string) => void }): React.ReactElement {
  const fleet = useArgus((s) => s.fleet);
  const selected = useArgus((s) => s.selected);
  const drones = React.useMemo(() => Object.values(fleet).sort((a, b) => a.drone_id.localeCompare(b.drone_id)), [fleet]);
  return (
    <Panel style={{ flex: '0 1 auto', minHeight: 110, maxHeight: '46%' }} scroll title="Fleet" status={<span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-tertiary)' }}>{drones.length} DRONES</span>} pad>
      {drones.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>No Drones connected. Start the fleet with <span style={{ fontFamily: 'var(--font-mono)' }}>make sim</span>.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {drones.map((s, i) => <DroneCard key={s.drone_id} s={s} index={i} selected={s.drone_id === selected} onSelect={onSelect} />)}
        </div>
      )}
    </Panel>
  );
}
