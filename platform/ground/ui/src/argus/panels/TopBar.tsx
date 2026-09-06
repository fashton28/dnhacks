import React from 'react';
import { CircleHelp, Hand, ChevronDown, BrainCircuit } from 'lucide-react';
import { useArgus, STATUS_COLOR, STATUS_LABEL, type AutonomyMode } from '../store';
import { ArgusMark } from '../Brand';
import type { HubDataProvider } from '@/dataSource/HubDataProvider';
import { policyText } from '../ArgusApp';

const Pill = ({ icon, title, sub, color, onClick, children }: { icon: React.ReactNode; title: React.ReactNode; sub: React.ReactNode; color?: string; onClick?: () => void; children?: React.ReactNode }) => (
  <div className="a-glass a-pill" onClick={onClick} style={onClick ? { cursor: 'pointer', position: 'relative' } : { position: 'relative' }} role={onClick ? 'button' : undefined}>
    {children}
    <span style={{ display: 'flex', color: color ?? 'var(--text-secondary)' }}>{icon}</span>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}><span className="a-title">{title}</span><span className="a-label">{sub}</span></div>
    <ChevronDown size={14} style={{ color: 'var(--text-tertiary)', marginLeft: 4 }} />
  </div>
);

/** Brand, three context pills (selected Drone, Fleet, autonomy mode) and link state. */
const MODES: { id: AutonomyMode; title: string; sub: string; short: string }[] = [
  { id: 'manual', title: 'Manual', sub: 'The Operator dispatches every Detection', short: 'Operator dispatches' },
  { id: 'supervised', title: 'Supervised', sub: 'The system dispatches after a veto window; Hold stops it', short: 'Auto-dispatch after a veto window' },
  { id: 'autonomous', title: 'Autonomous', sub: 'The system dispatches at once; the Operator watches', short: 'Dispatches without asking' },
];

export function TopBar({ hub, siteName, onHelp, onMode }: { hub: HubDataProvider; siteName: string; onHelp: () => void; onMode?: (m: AutonomyMode) => void }): React.ReactElement {
  const conn = useArgus((s) => s.conn);
  const drone = useArgus((s) => (s.selected ? s.fleet[s.selected] : undefined));
  const manual = useArgus((s) => s.manualActive);
  const phase = useArgus((s) => s.manualPhase);
  const fleet = useArgus((s) => s.fleet);
  const [clock, setClock] = React.useState(() => fmtClock());
  const [autonomy, setAutonomy] = React.useState<{ llm_mode?: string; model?: string | null; mode?: string; policy?: unknown } | null>(null);
  const policy = useArgus((s) => s.autonomyPolicy);
  const storeMode = useArgus((s) => s.autonomyMode);
  const setStoreAutonomy = useArgus((s) => s.setAutonomy);
  const [menu, setMenu] = React.useState(false);
  React.useEffect(() => { if (!menu) return; const close = () => setMenu(false); window.addEventListener('pointerdown', close); return () => window.removeEventListener('pointerdown', close); }, [menu]);
  React.useEffect(() => { const id = setInterval(() => setClock(fmtClock()), 1000); return () => clearInterval(id); }, []);
  React.useEffect(() => {
    let alive = true;
    const load = () => hub.getJson('/autonomy').then((r) => { if (alive && r.ok && r.json) { const a = r.json as { llm_mode?: string; model?: string | null; mode?: string; policy?: unknown }; setAutonomy(a); if (a.mode && ['manual', 'supervised', 'autonomous'].includes(a.mode)) setStoreAutonomy(a.mode as AutonomyMode, policyText(a.policy)); } }).catch(() => undefined);
    load(); const id = setInterval(load, 30000);
    return () => { alive = false; clearInterval(id); };
  }, [hub]);
  const all = Object.values(fleet);
  const active = all.filter((d) => d.status === 'on_mission' || d.status === 'returning' || d.status === 'manual_control').length;
  const live = conn === 'connected';
  const connColor = live ? 'var(--a-mission)' : conn === 'error' ? 'var(--a-offline)' : 'var(--a-manual)';
  const llm = autonomy?.llm_mode ?? null;
  const mode = storeMode ?? null;
  const modeRow = mode ? MODES.find((m) => m.id === mode) ?? null : null;
  const autonomyTitle = modeRow ? `${modeRow.title} autonomy` : llm === null ? 'Autonomy' : llm === 'off' || llm === 'rules' ? 'Rules-only autonomy' : 'Supervised autonomy';
  const autonomySub = modeRow ? modeRow.short : autonomy?.model ? String(autonomy.model) : 'Operator approves every dispatch';
  return (
    <div className="a-topbar">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none' }}>
        <span style={{ color: 'var(--green-bright)', display: 'flex' }}><ArgusMark size={22} /></span>
        <span style={{ font: '700 15px/1 var(--font-sans)', letterSpacing: '0.14em', color: '#ffffff' }}>ARGUS</span>
        <span className="a-label" style={{ color: 'var(--text-secondary)', marginLeft: 2 }}>{siteName}</span>
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', justifyContent: 'center', gap: 10 }}>
        <Pill icon={<span className="a-dot" style={{ width: 8, height: 8 }} />} color={drone ? STATUS_COLOR[drone.status] : 'var(--text-tertiary)'}
          title={drone ? <span className="a-id" style={{ fontSize: 12 }}>{drone.drone_id}</span> : 'No Drone selected'}
          sub={drone ? `${STATUS_LABEL[drone.status]} · ${drone.mode || '—'}${drone.armed ? ' · armed' : ''}` : 'Waiting for the Fleet'} />
        <Pill icon={<Radar4 />} title={<><span className="a-num">{active}</span> active · <span className="a-num">{all.length}</span> total</>} sub="Fleet" />
        <Pill icon={<BrainCircuit size={16} />} color={mode === 'autonomous' ? 'var(--amber-bright)' : 'var(--green-bright)'} title={autonomyTitle} sub={autonomySub} onClick={onMode && mode ? () => setMenu((m) => !m) : undefined}>
          {menu && (
            <div className="a-glass a-modes" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} role="menu">
              {MODES.map((m) => <button key={m.id} data-on={m.id === mode} onClick={() => { setMenu(false); onMode?.(m.id); }} role="menuitemradio" aria-checked={m.id === mode}><span className="a-title">{m.title}</span><span className="a-body" style={{ fontSize: 11 }}>{m.sub}</span></button>)}
              {(policy || autonomy?.model) && <span className="a-label" style={{ padding: '4px 10px 2px' }}>{[policy, autonomy?.model ? String(autonomy.model) : null].filter(Boolean).join(' · ')}</span>}
            </div>
          )}
        </Pill>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flex: 'none' }}>
        {manual && <span className="a-pillbtn a-in" style={{ color: 'var(--a-manual)', borderColor: 'var(--amber-line)' }}><Hand size={12} /> {phase && phase !== 'live' ? `Manual · ${phase}` : 'Manual · H releases'}</span>}
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
