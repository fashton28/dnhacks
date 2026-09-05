/* ReportPanel — the record slot of the mission workspace. Three views in one
   panel so the Phase 3 rails do not spawn panels of their own:

     Report        — the incident report written after the observation pass,
                     plus the operator disposition (escalate / log / dismiss).
     Mission record— the durable per-mission audit record: attendance mode, the
                     task that drove it, the planner's rule trace, the corridor
                     it was cleared for, every envelope event raised while it
                     ran, and the vehicle it was handed off from.
     Outbox        — escalations raised for this site. The scripted channel
                     appends to the local outbox; an escalation that was never
                     confirmed is shown as UNDELIVERED, never as delivered. */
import React from 'react';
import { Siren, FileText, Trash2, Inbox, ClipboardList } from 'lucide-react';
import { Panel, Badge, Button, Tabs } from '@/components';
import type { EnvelopeMessage, EscalationMessage, IncidentReport, MissionRecord } from '@/contract';
import type { ReportResolution } from '@/store';
import { renderMarkdown } from '@/lib/markdown';

export type ReportTab = 'report' | 'record' | 'outbox';

export interface ReportPanelProps {
  report: IncidentReport | null;
  resolution: ReportResolution | null;
  onResolve: (r: ReportResolution) => void;
  records?: MissionRecord[];
  escalations?: EscalationMessage[];
  tab?: ReportTab;
  onTabChange?: (tab: ReportTab) => void;
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

export function ReportPanel({
  report,
  resolution,
  onResolve,
  records = [],
  escalations = [],
  tab,
  onTabChange,
}: ReportPanelProps): React.ReactElement {
  const [ownTab, setOwnTab] = React.useState<ReportTab>('report');
  const active = tab ?? ownTab;
  const setTab = (next: ReportTab): void => {
    setOwnTab(next);
    onTabChange?.(next);
  };
  const record = records[records.length - 1] ?? null;
  const undelivered = escalations.filter((e) => !e.deliveredAt).length;

  return (
    <Panel
      title="Mission record"
      pad={false}
      status={
        active === 'report'
          ? report ? <Badge tone={VERDICT_TONE[report.verdict]} mono>{report.verdict.toUpperCase()}</Badge> : undefined
          : active === 'record'
            ? record ? <Badge tone={record.mode === 'unattended' ? 'caution' : 'nominal'} mono>{record.mode.toUpperCase()}</Badge> : undefined
            : <Badge tone={undelivered > 0 ? 'danger' : escalations.length ? 'caution' : 'outline'} mono>
                {escalations.length} {undelivered > 0 ? `· ${undelivered} UNDELIVERED` : 'RAISED'}
              </Badge>
      }
      actions={
        <Tabs
          size="sm"
          value={active}
          onChange={(id) => setTab(id as ReportTab)}
          items={[
            { id: 'report', label: 'Report', icon: <FileText size={12} /> },
            { id: 'record', label: 'Record', icon: <ClipboardList size={12} /> },
            { id: 'outbox', label: 'Outbox', icon: <Inbox size={12} /> },
          ]}
        />
      }
      style={{ height: '100%' }}
      bodyStyle={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      {active === 'report' && (
        !report ? (
          <Empty>No incident report yet — one is written after the observation pass.</Empty>
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
                  <Button variant="danger" size="sm" icon={<Siren size={14} />} onClick={() => onResolve('escalated')}>
                    Escalate
                  </Button>
                  <Button variant="secondary" size="sm" icon={<FileText size={14} />} onClick={() => onResolve('logged')}>
                    Log
                  </Button>
                  <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => onResolve('dismissed')}>
                    Dismiss
                  </Button>
                </>
              )}
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-disabled)' }}>
                {report.missionId}
              </span>
            </div>
          </>
        )
      )}

      {active === 'record' && (
        !record ? (
          <Empty>No mission record yet — one opens when a plan is dispatched.</Empty>
        ) : (
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 12px 12px' }}>
            <RecordView record={record} />
            {records.length > 1 && (
              <div style={{ fontSize: 10, color: 'var(--text-disabled)', marginTop: 10 }}>
                {records.length - 1} earlier record{records.length === 2 ? '' : 's'} in this session.
              </div>
            )}
          </div>
        )
      )}

      {active === 'outbox' && (
        escalations.length === 0 ? (
          <Empty>
            No escalations raised. The system never contacts anyone outside the site
            automatically — escalations land in this local outbox and the audit trail.
          </Empty>
        ) : (
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[...escalations].reverse().map((e, i) => (
              <div
                key={`${e.missionId}-${e.ts}-${i}`}
                style={{
                  padding: '6px 8px',
                  background: e.deliveredAt ? 'var(--surface-input)' : 'var(--red-tint)',
                  border: `1px solid ${e.deliveredAt ? 'var(--border-subtle)' : 'var(--red-line)'}`,
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <Badge tone={e.deliveredAt ? 'nominal' : 'danger'} mono>
                    {e.deliveredAt ? 'DELIVERED' : 'UNDELIVERED'}
                  </Badge>
                  <Badge tone="outline" mono>{e.channel}</Badge>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-tertiary)' }}>
                    {new Date(e.ts).toLocaleTimeString()} · {e.vehicleId}
                  </span>
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-secondary)', marginTop: 4, overflowWrap: 'anywhere' }}>
                  {e.missionId}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)', marginTop: 3, lineHeight: 1.5, overflowWrap: 'anywhere' }}>
                  {formatPayload(e.payload)}
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

function RecordView({ record }: { record: MissionRecord }): React.ReactElement {
  return (
    <>
      <SectionLabel>Identity</SectionLabel>
      <Row label="mission" value={record.missionId} />
      <Row label="vehicle" value={record.vehicleId} />
      <Row label="cue" value={record.anomalyId} />
      <Row label="mode" value={record.mode} tone={record.mode === 'unattended' ? 'caution' : undefined} />
      {record.handoffFrom && <Row label="handoff" value={`from ${record.handoffFrom}`} tone="caution" />}
      <Row
        label="window"
        value={`${new Date(record.startedAt).toLocaleTimeString()} → ${record.endedAt ? new Date(record.endedAt).toLocaleTimeString() : 'open'}`}
      />

      <SectionLabel>Task</SectionLabel>
      {record.task ? (
        <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-text)', marginRight: 6 }}>
            {record.task.lookFor.replace('_', ' ')}
          </span>
          {record.task.question}
          <div style={{ color: 'var(--text-tertiary)', marginTop: 3 }}>{record.task.rationale}</div>
        </div>
      ) : (
        <Muted>No task drove this mission (operator-initiated or scripted).</Muted>
      )}

      <SectionLabel>Rule trace</SectionLabel>
      {record.planTrace.length === 0 ? (
        <Muted>The planner emitted no rule trace for this plan.</Muted>
      ) : (
        <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {record.planTrace.map((entry, i) => (
            <li key={`${entry.rule}-${i}`} style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-tertiary)' }}>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent-text)', marginRight: 6, textTransform: 'uppercase' }}>
                {entry.rule}
              </span>
              {entry.effect}
            </li>
          ))}
        </ol>
      )}

      <SectionLabel>Corridor</SectionLabel>
      {record.corridor ? (
        <>
          <Row label="legs" value={`${record.corridor.legs.length} · ±${record.corridor.legs[0]?.lateral_tol_m ?? '?'} m lateral`} />
          <Row label="orbits" value={`${record.corridor.orbits.length} · ±${record.corridor.orbits[0]?.radial_tol_m ?? '?'} m radial`} />
          <Row label="alt band" value={`${record.corridor.alt_band_m.min}–${record.corridor.alt_band_m.max} m AGL`} />
        </>
      ) : (
        <Muted>No corridor was generated for this plan.</Muted>
      )}

      <SectionLabel>Envelope events</SectionLabel>
      {record.envelopeEvents.length === 0 ? (
        <Muted>The monitor raised nothing — the vehicle stayed inside its envelope.</Muted>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {record.envelopeEvents.map((e, i) => <EnvelopeRow key={i} event={e} />)}
        </div>
      )}

      <SectionLabel>Verification</SectionLabel>
      <Row label="verdict" value={record.verification.verdict} tone={record.verification.verdict === 'rejected' ? 'danger' : undefined} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
        {record.verification.checks.map((c) => (
          <Badge key={c.name} tone={c.ok ? 'nominal' : 'danger'} mono>{c.name}</Badge>
        ))}
      </div>
    </>
  );
}

function EnvelopeRow({ event }: { event: EnvelopeMessage }): React.ReactElement {
  const tone = event.state === 'breach' ? 'var(--danger-fg)' : 'var(--caution-fg)';
  return (
    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-tertiary)', display: 'flex', gap: 8 }}>
      <span style={{ color: 'var(--text-disabled)' }}>{new Date(event.ts).toLocaleTimeString()}</span>
      <span style={{ color: tone, fontWeight: 600 }}>{event.state.replace('_', ' ').toUpperCase()}</span>
      <span>
        {event.constraint ?? '—'}
        {event.margin_m !== undefined ? ` ${event.margin_m >= 0 ? '+' : ''}${event.margin_m.toFixed(1)} m` : ''}
        {event.action && event.action !== 'none' ? ` → ${event.action}` : ''}
      </span>
    </div>
  );
}

function formatPayload(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
    .join(' · ');
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }): React.ReactElement {
  return (
    <div style={{ display: 'flex', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.7 }}>
      <span style={{ color: 'var(--text-tertiary)', minWidth: 62, flex: 'none' }}>{label}</span>
      <span style={{ color: tone ?? 'var(--text-secondary)', overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div style={{ fontSize: 11, color: 'var(--text-disabled)', lineHeight: 1.5 }}>{children}</div>;
}

function Empty({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{ padding: 14, color: 'var(--text-disabled)', fontSize: 'var(--text-sm)', lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{
      fontSize: 'var(--text-2xs)', fontWeight: 600, color: 'var(--text-tertiary)',
      textTransform: 'uppercase', letterSpacing: '0.07em', margin: '10px 0 5px',
    }}>
      {children}
    </div>
  );
}
