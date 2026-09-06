import React from 'react';
import { FileText } from 'lucide-react';
import { useArgus } from '../store';
import { ArgusMark } from '../Brand';
import { fmtClock } from './DecisionTrail';

const VERDICT_COLOR = { escalate: 'var(--red-bright)', log: 'var(--amber-bright)', false_alarm: 'var(--text-secondary)' } as const;
const firstHeading = (md: string): string | null => { const m = /^\*\*(.+?)\*\*/m.exec(md) ?? /^#+\s*(.+)$/m.exec(md); return m ? m[1].trim() : null; };

/** Every findings document the Hub holds, newest first. */
export function ReportsList({ onOpen }: { onOpen: (missionId: string) => void }): React.ReactElement {
  const reports = useArgus((s) => s.reports);
  const list = React.useMemo(() => Object.values(reports).sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')), [reports]);
  if (list.length === 0) return <div className="a-empty"><ArgusMark size={24} /><div className="a-body"><b>No findings yet.</b><br />Each dispatch ends with a document: what the Drone found, the frames, and the decisions behind it.</div></div>;
  return (
    <div className="a-reports">
      {list.map((r) => {
        const title = r.title ?? firstHeading(r.narrative) ?? r.mission_id;
        const when = r.created_at ? new Date(r.created_at) : null;
        return (
          <button key={r.mission_id} className="a-card" onClick={() => onOpen(r.mission_id)} title={`Open findings for ${r.mission_id}`}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <FileText size={13} style={{ color: 'var(--text-tertiary)', flex: 'none' }} />
              <span className="a-title" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
              <span style={{ flex: 1 }} />
              <span className="a-chip" style={{ color: VERDICT_COLOR[r.verdict] ?? 'var(--text-secondary)' }}>{r.verdict.replace('_', ' ')}</span>
            </div>
            <div className="a-num" style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 4 }}>
              {r.mission_id}{r.drone_id ? ` · ${r.drone_id}` : ''} · {r.evidence_refs.length + r.observations.filter((o) => o.frame_ref).length} frames{when ? ` · ${fmtClock(when.getTime())}` : ''}
            </div>
          </button>
        );
      })}
    </div>
  );
}
