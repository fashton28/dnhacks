import React from 'react';
import { Route, Crosshair, BrainCircuit, Radar, Hexagon, ShieldCheck, ShieldAlert, Wrench, Eye, MessageSquare, OctagonX, ScanSearch, Gavel, FileText, Flag } from 'lucide-react';
import { Panel, Badge } from '@/components';
import { useArgus, type DecisionEntry } from '../store';
import { ArgusMark } from '../Brand';

const ICON: Record<DecisionEntry['kind'], React.ReactElement> = {
  detection: <Crosshair size={13} />, triage: <BrainCircuit size={13} />, drone: <Radar size={13} />, envelope: <Hexagon size={13} />,
  validation: <ShieldCheck size={13} />, repair: <Wrench size={13} />, action: <Eye size={13} />, note: <MessageSquare size={13} />,
  stop: <OctagonX size={13} />, inspection: <ScanSearch size={13} />, verdict: <Gavel size={13} />, report: <FileText size={13} />, outcome: <Flag size={13} />, clamp: <ShieldAlert size={13} />,
};
export const fmtClock = (ts: number): string => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; };

/** The list itself, shared by the trust column and the Findings document. */
export function TrailList({ entries, compact = false }: { entries: DecisionEntry[]; compact?: boolean }): React.ReactElement {
  const end = React.useRef<HTMLLIElement | null>(null);
  React.useEffect(() => { if (compact) end.current?.scrollIntoView({ block: 'nearest' }); }, [entries.length, compact]);
  return (
    <ol className="a-trail" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {entries.map((e, i) => (
        <li key={`${e.ts}-${i}`} data-tone={e.tone} ref={i === entries.length - 1 ? end : undefined}>
          <span className="t">{fmtClock(e.ts).slice(3)}</span>
          <span className="i" title={e.kind}>{ICON[e.kind]}</span>
          <span className="x">{e.text}{e.detail && !compact ? <small>{e.detail}</small> : null}</span>
        </li>
      ))}
    </ol>
  );
}

/** The last few decisions as a glass card over the camera, so the narration continues while the flight is on screen. */
export function TrailCard(): React.ReactElement | null {
  const decisions = useArgus((s) => s.decisions);
  if (decisions.length === 0) return null;
  return (
    <div className="a-glass a-trailcard a-in" aria-label="Decision trail">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}><Route size={12} style={{ color: 'var(--text-tertiary)' }} /><span className="a-label">Decision trail</span><span style={{ flex: 1 }} /><span className="a-num" style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{decisions.length}</span></div>
      <TrailList entries={decisions.slice(-5)} compact />
    </div>
  );
}

/** The agent explained: one sentence per decision, in order, for the Operator to follow along and to defend later. */
export function DecisionTrail(): React.ReactElement {
  const decisions = useArgus((s) => s.decisions);
  const envelope = useArgus((s) => s.envelope);
  const mission = useArgus((s) => (s.envelope ? s.missions[s.envelope.mission_id] : undefined));
  const inControl = !!envelope && !!mission && ['flying', 'paused'].includes(mission.phase);
  const status = inControl ? <Badge tone="nominal" mono>AGENT IN CONTROL</Badge> : decisions.length ? <Badge tone="neutral" mono>{decisions.length}</Badge> : undefined;
  return (
    <Panel title="Decision trail" icon={<Route size={13} />} status={status} pad scroll>
      {decisions.length === 0 ? (
        <div className="a-empty"><ArgusMark size={24} /><div className="a-body"><b>Nothing decided yet.</b><br />Dispatch a Detection. Every step the agent takes is written here as it happens: why it flew, which Drone, what the Safety Validator said, what it saw.</div></div>
      ) : <TrailList entries={decisions} compact />}
    </Panel>
  );
}
