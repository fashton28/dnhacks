import React from 'react';
import { Radar } from 'lucide-react';
import { Panel } from '@/components';
import { useArgus, STATUS_COLOR, STATUS_LABEL } from '../store';
import { ArgusMark } from '../Brand';
import type { HubDroneState } from '@/dataSource/HubDataProvider';

const DroneCard = React.memo(function DroneCard({ s, index, selected, onSelect }: { s: HubDroneState; index: number; selected: boolean; onSelect: (id: string) => void }) {
  const col = STATUS_COLOR[s.status];
  const bat = Math.max(0, Math.min(100, s.battery_pct));
  const batCol = bat <= 15 ? 'var(--a-offline)' : bat <= 30 ? 'var(--a-manual)' : 'var(--a-mission)';
  const live = s.status === 'on_mission' || s.status === 'returning' || s.status === 'manual_control';
  return (
    <button className="a-card" data-selected={selected} onClick={() => onSelect(s.drone_id)} title={`Select ${s.drone_id} (key ${index + 1})`}
      style={{ opacity: s.status === 'offline' ? 0.55 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span className="a-key">{index + 1}</span>
        <span className="a-id">{s.drone_id}</span>
        <span style={{ flex: 1 }} />
        <span className="a-chip" style={{ color: col, borderColor: 'transparent', padding: 0, height: 'auto' }}>
          <span className="a-dot" data-live={live} />{STATUS_LABEL[s.status]}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 5 }}>
        <span className="a-num" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{s.alt.toFixed(1)}<span className="a-unit">m</span></span>
        <span className="a-num" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{s.mode || '—'}</span>
        <span style={{ flex: 1 }} />
        <span className="a-num" style={{ fontSize: 12, color: batCol }}>{bat.toFixed(0)}<span className="a-unit" style={{ color: batCol, opacity: 0.8 }}>%</span></span>
      </div>
      <div className="a-bar" style={{ marginTop: 6 }}><span style={{ width: `${bat}%`, background: batCol }} /></div>
    </button>
  );
});

export function FleetPanel({ onSelect }: { onSelect: (id: string) => void }): React.ReactElement {
  const fleet = useArgus((s) => s.fleet);
  const selected = useArgus((s) => s.selected);
  const drones = React.useMemo(() => Object.values(fleet).sort((a, b) => a.drone_id.localeCompare(b.drone_id)), [fleet]);
  const airborne = drones.filter((d) => d.alt > 0.5).length;
  return (
    <Panel style={{ flex: '0 1 auto', minHeight: 110, maxHeight: '46%' }} scroll title="Fleet" icon={<Radar size={13} />}
      status={<span className="a-num" style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>{drones.length} · {airborne} airborne</span>} pad>
      {drones.length === 0 ? (
        <div className="a-empty"><ArgusMark size={28} /><div className="a-body"><b>No Drones on the Hub.</b><br />Start the fleet with <span className="a-num">make sim</span>.</div></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {drones.map((s, i) => <DroneCard key={s.drone_id} s={s} index={i} selected={s.drone_id === selected} onSelect={onSelect} />)}
        </div>
      )}
    </Panel>
  );
}
