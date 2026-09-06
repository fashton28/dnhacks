import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useArgus, liveDetection, decisionFor } from '../store';

/** What the wide-area layer saw, in words an Operator uses. */
const CHANGE: Record<string, string> = { vehicle: 'Vehicle-sized change', intruder_vehicle: 'Unscheduled vehicle', person: 'Person-sized change', unattended_object: 'Unattended object', fence_breach: 'Fence breach', perimeter_opening: 'Perimeter opening', smoke_plume: 'Rising column of smoke', thermal_anomaly: 'Hot spot' };
export const describeChange = (t: string): string => CHANGE[t] ?? t.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** The newest Detection the Operator has not acted on: dispatch it to the Triage Agent, log it, or ignore it. */
export function DetectionCard({ hubBase, onDispatch, onLog, onHold, onRelease }: { hubBase: string; onDispatch: (id: string) => void; onLog: (id: string, how: 'logged' | 'ignored') => void; onHold?: (decisionId: string) => void; onRelease?: (decisionId: string) => void }): React.ReactElement | null {
  const d = useArgus(liveDetection);
  const dispatching = useArgus((s) => s.dispatching);
  const decision = useArgus((s) => (d ? decisionFor(s, d.id) : null));
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => { if (!decision || decision.action !== 'dispatch' || !decision.deadline_ts) return; const id = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(id); }, [decision]);
  if (!d) return null;
  const left = decision?.deadline_ts ? Math.max(0, decision.deadline_ts - now) : 0;
  const window_ = decision?.deadline_ts ? Math.max(1000, decision.deadline_ts - decision.ts) : 15000;
  const when = d.metadata?.after_ts ?? null;
  return (
    <div className="a-glass a-detcard a-in" role="group" aria-label={`Detection ${d.id}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--red-bright)' }}>
        <AlertTriangle size={15} />
        <span className="a-id" style={{ color: 'var(--red-bright)' }} title={d.id}>{d.id}</span>
        <span style={{ flex: 1 }} />
        <span className="a-chip" style={{ color: 'var(--red-bright)', borderColor: 'rgba(255,107,102,0.5)' }}>{d.change_type.replace(/_/g, ' ')}</span>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <img src={`${hubBase}/evidence/${d.after_ref}`} alt="" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 4, background: '#000', flex: 'none' }} onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        <div className="a-body" style={{ color: 'var(--text-primary)' }}>
          {describeChange(d.change_type)} of <span className="a-num">{Math.round(d.area_m2 ?? 0)} m²</span>, confidence <span className="a-num">{d.confidence.toFixed(2)}</span>.
          {when ? <span style={{ color: 'var(--text-secondary)' }}> Seen {when}.</span> : null}
          <span style={{ color: 'var(--text-secondary)' }}> {d.metadata?.source ?? 'Wide-area layer'}.</span>
        </div>
      </div>
      {decision && decision.action === 'dispatch' && (
        <div className="a-veto" role="status">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="a-label" style={{ color: 'var(--amber-bright)' }}>Auto-dispatch in <span className="a-num" style={{ color: 'inherit', fontSize: 12 }}>{Math.ceil(left / 1000)} s</span></span>
            <span style={{ flex: 1 }} />
            <span className="a-label" style={{ textTransform: 'none', letterSpacing: '0.02em' }}>{decision.mode} mode</span>
          </div>
          <div className="bar"><span style={{ width: `${Math.max(0, Math.min(100, (left / window_) * 100))}%` }} /></div>
          {decision.rationale && <div className="a-body" style={{ fontSize: 11 }}>{decision.rationale}</div>}
        </div>
      )}
      {decision && decision.action === 'held' && (
        <div className="a-veto" data-held="true" role="status">
          <span className="a-label" style={{ color: 'var(--text-secondary)' }}>Held by the Operator. The system will not dispatch until released.</span>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        {decision && decision.action === 'dispatch' && onHold ? (
          <button className="a-btn" data-primary="true" style={{ background: 'var(--amber)', borderColor: 'var(--amber)', color: '#1a1200' }} onClick={() => onHold(decision.id)} title="Veto the automatic dispatch">Hold</button>
        ) : decision && decision.action === 'held' && onRelease ? (
          <button className="a-btn" data-primary="true" onClick={() => onRelease(decision.id)} title="Let the system dispatch now">Release</button>
        ) : (
          <button className="a-btn" data-primary="true" onClick={() => onDispatch(d.id)} disabled={!!dispatching} title="Hand this Detection to the Triage Agent">{dispatching === d.id ? 'Dispatching' : 'Dispatch'}</button>
        )}
        <button className="a-btn" onClick={() => onLog(d.id, 'logged')} title="Record it without flying">Log only</button>
        <button className="a-btn" onClick={() => onLog(d.id, 'ignored')} title="Discard this Detection">Ignore</button>
      </div>
    </div>
  );
}
