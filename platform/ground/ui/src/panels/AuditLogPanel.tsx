/* AuditLogPanel — the timestamped mission audit trail: anomaly arrival, plan
   proposals, verifier verdicts, operator approval/denial, execution start/end,
   observation + report events, and report dispositions. Fed by the mission
   store (which App.tsx wires to the MissionDataSource channels + statusText
   while a mission is executing). */
import React from 'react';
import { Panel, Badge } from '@/components';
import type { AuditEvent, AuditKind } from '@/store';

export interface AuditLogPanelProps {
  events: AuditEvent[];
}

const KIND_COLOR: Record<AuditKind, string> = {
  anomaly: 'var(--caution-fg)',
  plan: 'var(--accent-text)',
  verification: 'var(--accent-text)',
  approval: 'var(--nominal-fg)',
  denial: 'var(--danger-fg)',
  execution: 'var(--accent-text)',
  observation: 'var(--caution-fg)',
  report: 'var(--caution-fg)',
  operator: 'var(--text-primary)',
  status: 'var(--text-tertiary)',
  abort: 'var(--danger-fg)',
};

const KIND_TAG: Record<AuditKind, string> = {
  anomaly: 'SAT ',
  plan: 'PLAN',
  verification: 'VRFY',
  approval: 'APRV',
  denial: 'DENY',
  execution: 'EXEC',
  observation: 'OBSV',
  report: 'RPRT',
  operator: 'OPER',
  status: 'STAT',
  abort: 'ABRT',
};

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function AuditLogPanel({ events }: AuditLogPanelProps): React.ReactElement {
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  return (
    <Panel
      title="Mission audit"
      pad={false}
      status={<Badge tone="neutral" mono>{events.length}</Badge>}
      style={{ height: '100%' }}
    >
      <div
        ref={scrollRef}
        style={{
          height: '100%',
          overflow: 'auto',
          padding: '6px 0',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          lineHeight: 1.65,
        }}
      >
        {events.map((e, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              gap: 9,
              padding: '1px 12px',
              alignItems: 'baseline',
            }}
          >
            <span style={{ color: 'var(--text-disabled)', flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
              {fmtClock(e.ts)}
            </span>
            <span style={{ color: KIND_COLOR[e.kind], fontWeight: 600, flex: 'none', letterSpacing: '0.04em' }}>
              {KIND_TAG[e.kind]}
            </span>
            <span style={{ color: e.kind === 'status' ? 'var(--text-tertiary)' : 'var(--text-secondary)', overflowWrap: 'anywhere' }}>
              {e.text}
            </span>
          </div>
        ))}
        {events.length === 0 && (
          <div style={{ padding: '8px 12px', color: 'var(--text-disabled)' }}>
            No mission events yet.
          </div>
        )}
      </div>
    </Panel>
  );
}
