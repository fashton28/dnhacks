import React from 'react';
import { Panel, Badge, Button } from '@/components';
import { renderMarkdown } from '@/lib/markdown';
import { useArgus } from '../store';

const Field = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '84px 1fr', gap: 8, fontSize: 11.5, lineHeight: 1.45 }}>
    <span style={{ color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 9.5, paddingTop: 2 }}>{k}</span>
    <span style={{ color: 'var(--text-primary)' }}>{v}</span>
  </div>
);

export function DetectionsPanel({ hubBase, onDispatch }: { hubBase: string; onDispatch: (id: string) => void }): React.ReactElement {
  const detections = useArgus((s) => s.detections);
  const dispatching = useArgus((s) => s.dispatching);
  return (
    <Panel title="Detections" status={<Badge tone={detections.length ? 'caution' : 'neutral'} mono>{detections.length}</Badge>} pad scroll>
      {detections.length === 0 ? (
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>No Detections yet. Capture a Baseline, run a Scenario, then Detect change.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {[...detections].reverse().map((d) => (
            <div key={d.id} style={{ display: 'grid', gridTemplateColumns: '64px 1fr auto', gap: 8, alignItems: 'center', padding: 6, borderRadius: 6, border: '1px solid var(--border-default)', background: 'var(--surface-raised)' }}>
              <img src={`${hubBase}/evidence/${d.after_ref}`} alt="" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 4, background: '#000' }} onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, fontWeight: 600 }}>{d.id}</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{d.change_type.replace('_', ' ')} · {Math.round(d.area_m2 ?? 0)} m² · confidence {d.confidence.toFixed(2)}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-tertiary)' }}>{d.metadata?.source ?? ''}</div>
              </div>
              <Button size="sm" variant="primary" onClick={() => onDispatch(d.id)} disabled={!!dispatching} title="Dispatch to the Triage Agent">Dispatch</Button>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

export function SpecPanel(): React.ReactElement {
  const spec = useArgus((s) => s.missionSpec);
  const plan = useArgus((s) => s.agentPlan);
  return (
    <Panel title="Triage Agent · MissionSpec" status={spec ? <Badge tone="accent" mono>attempt {spec.attempt}</Badge> : undefined} pad scroll>
      {!spec ? <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>Waiting for a dispatch. The agent states intent; the Coverage Planner derives waypoints.</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <Field k="mission" v={<span style={{ fontFamily: 'var(--font-mono)' }}>{spec.mission_id}</span>} />
          <Field k="objective" v={spec.objective} />
          <Field k="ceiling" v={`${spec.max_altitude_m} m`} />
          {plan && <Field k="waypoints" v={plan.plan.waypoints.map((w, i) => `${i + 1}: ${w.action} @ ${w.alt_m} m${w.duration_s ? ` · ${w.duration_s}s` : ''}`).join(' · ')} />}
          <Field k="rationale" v={spec.rationale} />
        </div>
      )}
    </Panel>
  );
}

export function ValidatorPanel(): React.ReactElement {
  const v = useArgus((s) => s.validation);
  const tone = !v ? 'neutral' : v.verdict === 'accept' ? 'nominal' : 'danger';
  return (
    <Panel title="Safety Validator" status={v ? <Badge tone={tone} mono>{v.abandoned ? 'ABANDONED' : v.verdict.toUpperCase()}</Badge> : undefined} pad scroll>
      {!v ? <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>No FlightPlan verified yet.</div> : v.verdict === 'accept' ? (
        <div style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid var(--green-line)', background: 'var(--green-tint)', fontSize: 12 }}>
          <b style={{ color: 'var(--green-bright)' }}>✓ ACCEPTED</b> · {v.checks_passed ?? ''} checks passed. Geofence, no-fly, altitude, range, hover and anomaly proximity verified.
        </div>
      ) : (
        <div style={{ padding: '8px 10px', borderRadius: 6, border: '1px solid var(--red-line)', background: 'var(--red-tint)', fontSize: 12 }}>
          <b style={{ color: 'var(--red-bright)' }}>✗ REJECTED{v.attempt ? ` (attempt ${v.attempt})` : ''}</b>{v.abandoned ? ' · plan abandoned, escalated to the Operator' : ' · repairing'}
          <ul style={{ margin: '6px 0 0', paddingLeft: 16, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
            {v.violations.map((x, i) => <li key={i}><b>{x.rule}</b> {x.detail}</li>)}
          </ul>
        </div>
      )}
    </Panel>
  );
}

export function ReportPanel({ onResolve }: { onResolve: (r: 'escalated' | 'dismissed') => void }): React.ReactElement {
  const inc = useArgus((s) => s.incident);
  const triage = useArgus((s) => s.triage);
  const tone = !inc ? 'neutral' : inc.severity === 'high' || inc.severity === 'critical' ? 'danger' : inc.severity === 'medium' ? 'caution' : 'nominal';
  return (
    <Panel title="Incident Report" status={inc ? <Badge tone={tone} mono>{inc.severity.toUpperCase()}</Badge> : undefined} pad scroll>
      {!inc ? <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>No report yet. Observations from the flight feed the triage and the report.</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
          <div style={{ fontWeight: 600 }}>{inc.title}</div>
          {triage && <Field k="triage" v={`${triage.decision.toUpperCase()} · confidence ${triage.confidence}`} />}
          <Field k="action" v={inc.recommended_action} />
          <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{renderMarkdown(inc.body_markdown)}</div>
          {inc.resolution ? (
            <Badge tone={inc.resolution === 'escalated' ? 'danger' : 'neutral'} mono>{inc.resolution.toUpperCase()} BY OPERATOR</Badge>
          ) : (
            <div style={{ display: 'flex', gap: 6 }}>
              <Button size="sm" variant="danger" onClick={() => onResolve('escalated')}>Escalate</Button>
              <Button size="sm" onClick={() => onResolve('dismissed')}>Dismiss</Button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
