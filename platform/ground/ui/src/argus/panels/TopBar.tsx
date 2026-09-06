import React from 'react';
import { CircleHelp, Hand, ChevronDown, BrainCircuit } from 'lucide-react';
import { useArgus, STATUS_COLOR, STATUS_LABEL } from '../store';
import { ArgusMark } from '../Brand';
import type { HubDataProvider } from '@/dataSource/HubDataProvider';

const Pill = ({ icon, title, sub, color }: { icon: React.ReactNode; title: React.ReactNode; sub: React.ReactNode; color?: string }) => (
  <div className="a-glass a-pill">
    <span style={{ display: 'flex', color: color ?? 'var(--text-secondary)' }}>{icon}</span>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}><span className="a-title">{title}</span><span className="a-label">{sub}</span></div>
    <ChevronDown size={14} style={{ color: 'var(--text-tertiary)', marginLeft: 4 }} />
  </div>
);

/** Brand, three context pills (selected Drone, Fleet, autonomy mode) and link state. */
export function TopBar({ hub, siteName, onHelp }: { hub: HubDataProvider; siteName: string; onHelp: () => void }): React.ReactElement {
  const conn = useArgus((s) => s.conn);
  const drone = useArgus((s) => (s.selected ? s.fleet[s.selected] : undefined));
  const manual = useArgus((s) => s.manualActive);
  const fleet = useArgus((s) => s.fleet);
  const [clock, setClock] = React.useState(() => fmtClock());
  const [autonomy, setAutonomy] = React.useState<{ llm_mode?: string; model?: string | null } | null>(null);
  React.useEffect(() => { const id = setInterval(() => setClock(fmtClock()), 1000); return () => clearInterval(id); }, []);
  React.useEffect(() => {
    let alive = true;
    const load = () => hub.getJson('/autonomy').then((r) => { if (alive && r.ok && r.json) setAutonomy(r.json as { llm_mode?: string; model?: string | null }); }).catch(() => undefined);
    load(); const id = setInterval(load, 30000);
    return () => { alive = false; clearInterval(id); };
  }, [hub]);
  const all = Object.values(fleet);
  const active = all.filter((d) => d.status === 'on_mission' || d.status === 'returning' || d.status === 'manual_control').length;
  const live = conn === 'connected';
  const connColor = live ? 'var(--a-mission)' : conn === 'error' ? 'var(--a-offline)' : 'var(--a-manual)';
  const llm = autonomy?.llm_mode ?? null;
  const autonomyTitle = llm === null ? 'Autonomy' : llm === 'off' || llm === 'rules' ? 'Rules-only autonomy' : 'Supervised autonomy';
  const autonomySub = autonomy?.model ? String(autonomy.model) : 'Operator approves every dispatch';
  return (
    <div className="a-topbar">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, width: 260 }}>
        <span style={{ color: 'var(--green-bright)', display: 'flex' }}><ArgusMark size={22} /></span>
        <span style={{ font: '700 15px/1 var(--font-sans)', letterSpacing: '0.14em', color: '#ffffff' }}>ARGUS</span>
        <span className="a-label" style={{ color: 'var(--text-secondary)', marginLeft: 2 }}>{siteName}</span>
      </div>
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', gap: 10 }}>
        <Pill icon={<span className="a-dot" style={{ width: 8, height: 8 }} />} color={drone ? STATUS_COLOR[drone.status] : 'var(--text-tertiary)'}
          title={drone ? <span className="a-id" style={{ fontSize: 12 }}>{drone.drone_id}</span> : 'No Drone selected'}
          sub={drone ? `${STATUS_LABEL[drone.status]} · ${drone.mode || '—'}${drone.armed ? ' · armed' : ''}` : 'Waiting for the Fleet'} />
        <Pill icon={<Radar4 />} title={<><span className="a-num">{active}</span> active · <span className="a-num">{all.length}</span> total</>} sub="Fleet" />
        <Pill icon={<BrainCircuit size={16} />} color="var(--green-bright)" title={autonomyTitle} sub={autonomySub} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, width: 260 }}>
        {manual && <span className="a-pillbtn a-in" style={{ color: 'var(--a-manual)', borderColor: 'var(--amber-line)' }}><Hand size={12} /> Manual · H releases</span>}
        <span className="a-pillbtn" style={{ color: connColor }}><span className="a-dot" data-live={live} />{live ? 'Hub live' : conn}</span>
        <span className="a-pillbtn a-num" style={{ letterSpacing: 0, textTransform: 'none', fontSize: 12, fontWeight: 500 }}>{clock}</span>
        <button className="a-pillbtn" data-icon="true" onClick={onHelp} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts"><CircleHelp size={15} /></button>
      </div>
    </div>
  );
}

const Radar4 = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="5" cy="5" r="2" /><circle cx="19" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" /><rect x="9" y="9" width="6" height="6" rx="1.5" /><path d="M7 7l2 2M17 7l-2 2M7 17l2-2M17 17l-2-2" /></svg>
);

function fmtClock(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
