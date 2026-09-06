import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useArgus, liveDetection } from '../store';

/** The newest Detection the Operator has not acted on: dispatch it to the Triage Agent, log it, or ignore it. */
export function DetectionCard({ hubBase, onDispatch, onLog }: { hubBase: string; onDispatch: (id: string) => void; onLog: (id: string, how: 'logged' | 'ignored') => void }): React.ReactElement | null {
  const d = useArgus(liveDetection);
  const dispatching = useArgus((s) => s.dispatching);
  if (!d) return null;
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
          {d.change_type === 'vehicle' ? 'Vehicle-sized change' : 'Change'} of <span className="a-num">{Math.round(d.area_m2 ?? 0)} m²</span>, confidence <span className="a-num">{d.confidence.toFixed(2)}</span>.
          {when ? <span style={{ color: 'var(--text-secondary)' }}> Seen {when}.</span> : null}
          <span style={{ color: 'var(--text-secondary)' }}> {d.metadata?.source ?? 'Wide-area layer'}.</span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="a-btn" data-primary="true" onClick={() => onDispatch(d.id)} disabled={!!dispatching} title="Hand this Detection to the Triage Agent">{dispatching === d.id ? 'Dispatching' : 'Dispatch'}</button>
        <button className="a-btn" onClick={() => onLog(d.id, 'logged')} title="Record it without flying">Log only</button>
        <button className="a-btn" onClick={() => onLog(d.id, 'ignored')} title="Discard this Detection">Ignore</button>
      </div>
    </div>
  );
}
