/* ReportPanel — the incident report produced after the observation pass.
   Renders the report markdown (tiny built-in renderer), a verdict badge, and
   the operator disposition: Escalate / Log / Dismiss (updates local mission
   state + the audit trail — no wire command; the report is ground-side). */
import React from 'react';
import { Siren, FileText, Trash2 } from 'lucide-react';
import { Panel, Badge, Button } from '@/components';
import type { IncidentReport } from '@/contract';
import type { ReportResolution } from '@/store';
import { renderMarkdown } from '@/lib/markdown';

export interface ReportPanelProps {
  report: IncidentReport | null;
  resolution: ReportResolution | null;
  onResolve: (r: ReportResolution) => void;
}

const VERDICT_TONE: Record<IncidentReport['verdict'], 'danger' | 'caution' | 'nominal'> = {
  escalate: 'danger',
  log: 'caution',
  false_alarm: 'nominal',
};

const RESOLUTION_LABEL: Record<ReportResolution, string> = {
  escalated: 'ESCALATED TO SECURITY',
  logged: 'LOGGED FOR REVIEW',
  dismissed: 'DISMISSED',
};

export function ReportPanel({ report, resolution, onResolve }: ReportPanelProps): React.ReactElement {
  return (
    <Panel
      title="Incident report"
      pad={false}
      status={
        report
          ? <Badge tone={VERDICT_TONE[report.verdict]} mono>{report.verdict.toUpperCase()}</Badge>
          : undefined
      }
      style={{ height: '100%' }}
      bodyStyle={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      {!report ? (
        <div style={{ padding: 14, color: 'var(--text-disabled)', fontSize: 'var(--text-sm)' }}>
          No incident report yet — one is written after the observation pass.
        </div>
      ) : (
        <>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '10px 12px' }}>
            {renderMarkdown(report.markdown)}
          </div>
          <div
            style={{
              flex: 'none',
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              padding: '8px 12px',
              borderTop: '1px solid var(--border-subtle)',
              background: 'rgba(255,255,255,0.015)',
            }}
          >
            {resolution ? (
              <Badge tone={resolution === 'escalated' ? 'danger' : resolution === 'logged' ? 'caution' : 'neutral'} mono>
                {RESOLUTION_LABEL[resolution]}
              </Badge>
            ) : (
              <>
                <Button
                  variant="danger"
                  size="sm"
                  icon={<Siren size={14} />}
                  onClick={() => onResolve('escalated')}
                >
                  Escalate
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<FileText size={14} />}
                  onClick={() => onResolve('logged')}
                >
                  Log
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<Trash2 size={14} />}
                  onClick={() => onResolve('dismissed')}
                >
                  Dismiss
                </Button>
              </>
            )}
            <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-disabled)' }}>
              {report.missionId}
            </span>
          </div>
        </>
      )}
    </Panel>
  );
}
