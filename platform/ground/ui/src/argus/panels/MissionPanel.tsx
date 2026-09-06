import React from 'react';
import { Crosshair, BrainCircuit, ShieldCheck, FileText, Send, CheckCircle2, XCircle, Eye, Camera, Aperture, Move3d, Flag, AlertTriangle, Navigation, PauseCircle, Home, Activity, MessageSquare, OctagonX } from 'lucide-react';
import { Panel, Badge, Button } from '@/components';
import { renderMarkdown } from '@/lib/markdown';
import { useArgus } from '../store';
import { ArgusMark } from '../Brand';

const Field = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '78px 1fr', gap: 8, alignItems: 'baseline' }}>
    <span className="a-label" style={{ paddingTop: 2 }}>{k}</span>
    <span className="a-body" style={{ color: 'var(--text-primary)' }}>{v}</span>
  </div>
);

const Empty = ({ title, hint }: { title: string; hint: string }) => (
  <div className="a-empty"><ArgusMark size={24} /><div className="a-body"><b>{title}</b><br />{hint}</div></div>
);

export function DetectionsPanel({ hubBase, onDispatch }: { hubBase: string; onDispatch: (id: string) => void }): React.ReactElement {
  const detections = useArgus((s) => s.detections);
  const dispatching = useArgus((s) => s.dispatching);
  return (
    <Panel title="Detections" icon={<Crosshair size={13} />} status={<Badge tone={detections.length ? 'caution' : 'neutral'} mono>{detections.length}</Badge>} pad scroll>
      {detections.length === 0 ? (
        <Empty title="Nothing flagged." hint="Capture a Baseline, change the Site with a Scenario, then Detect." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {[...detections].reverse().map((d) => (
            <div key={d.id} className="a-card" style={{ display: 'grid', gridTemplateColumns: '56px 1fr auto', gap: 10, alignItems: 'center', padding: 7, cursor: 'default' }}>
              <img src={`${hubBase}/evidence/${d.after_ref}`} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 4, background: '#000' }} onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
              <div style={{ minWidth: 0 }}>
                <div className="a-id">{d.id}</div>
                <div className="a-body" style={{ fontSize: 11 }}>{d.change_type.replace(/_/g, ' ')} · <span className="a-num" style={{ fontSize: 11, color: 'inherit' }}>{Math.round(d.area_m2 ?? 0)}</span> m² · confidence <span className="a-num" style={{ fontSize: 11, color: 'inherit' }}>{d.confidence.toFixed(2)}</span></div>
                <div className="a-label" style={{ letterSpacing: '0.06em', marginTop: 2 }}>{d.metadata?.source ?? 'wide-area layer'}</div>
              </div>
              <Button size="sm" variant="primary" icon={<Send size={12} />} onClick={() => onDispatch(d.id)} disabled={!!dispatching} title="Hand this Detection to the Triage Agent">Dispatch</Button>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

const TOOL_ICON: Record<string, React.ReactElement> = {
  look_at: <Eye size={12} />, set_camera: <Aperture size={12} />, capture: <Camera size={12} />, reposition: <Move3d size={12} />, done: <Flag size={12} />,
  fly_to: <Navigation size={12} />, hold: <PauseCircle size={12} />, return_home: <Home size={12} />, status: <Activity size={12} />, note: <MessageSquare size={12} />, hard_stop: <OctagonX size={12} />,
};

function describeArgs(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'look_at': return `gimbal ${String(args.pitch_deg)}°`;
    case 'set_camera': return `${String(args.mode)} · ${Number(args.zoom ?? 1).toFixed(1)}×`;
    case 'capture': return String(args.looking_for ?? '');
    case 'reposition': return `${String(args.direction ?? '')} ${String(args.distance_m ?? '')} m${args.alt_m ? ` at ${String(args.alt_m)} m` : ''}`;
    case 'fly_to': return `${Number(args.east_m) >= 0 ? '+' : ''}${Number(args.east_m).toFixed(0)} E ${Number(args.north_m) >= 0 ? '+' : ''}${Number(args.north_m).toFixed(0)} N at ${Number(args.alt_m).toFixed(0)} m`;
    case 'hold': return `${Number(args.seconds).toFixed(0)} s`;
    case 'done': return String(args.threat_assessment ?? '').toUpperCase();
    default: return '';
  }
}

export function SpecPanel(): React.ReactElement {
  const spec = useArgus((s) => s.missionSpec);
  const plan = useArgus((s) => s.agentPlan);
  const pre = useArgus((s) => s.pretriage);
  const actions = useArgus((s) => s.agentActions);
  const insp = useArgus((s) => s.inspection);
  const env = useArgus((s) => s.envelope);
  const hardStop = useArgus((s) => s.hardStop);
  const mission = useArgus((s) => (s.missionSpec ? s.missions[s.missionSpec.mission_id] : undefined));
  const inControl = !!env && !!mission && ['flying', 'paused'].includes(mission.phase);
  const route = plan ? plan.plan.waypoints.map((w, i) => `${i + 1} ${w.action} ${w.alt_m}m` + (w.duration_s ? ` ${w.duration_s}s` : '')).join(' · ') : '';
  const preTone = !pre ? 'neutral' : pre.action === 'dispatch' ? 'accent' : 'caution';
  const status = inControl ? <Badge tone="nominal" mono>AGENT IN CONTROL</Badge> : spec ? <Badge tone="accent" mono>attempt {spec.attempt}</Badge> : pre ? <Badge tone={preTone} mono>{pre.action.replace('_', ' ').toUpperCase()}</Badge> : undefined;
  return (
    <Panel title="Triage Agent" icon={<BrainCircuit size={13} />} status={status} pad scroll>
      {!spec && !pre ? <Empty title="No intent yet." hint="Dispatch a Detection. The agent states what to look at; the planner derives the route." /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {pre && (
            <div title={pre.rationale} style={{ display: 'flex', gap: 8, padding: spec ? '5px 9px' : '7px 9px', borderRadius: 6, border: `1px solid ${pre.action === 'dispatch' ? 'var(--border-strong)' : 'var(--amber-line)'}`, background: pre.action === 'dispatch' ? 'transparent' : 'var(--amber-tint)' }}>
              {pre.action === 'dispatch' ? <Send size={13} style={{ flex: 'none', marginTop: 2, color: 'var(--accent)' }} /> : <AlertTriangle size={13} style={{ flex: 'none', marginTop: 2, color: 'var(--amber-bright)' }} />}
              <div className="a-body" style={{ color: 'var(--text-primary)', minWidth: 0 }}>
                <b>{pre.action === 'dispatch' ? 'Dispatch' : pre.action === 'log_only' ? 'Logged, no flight' : 'Ignored'}</b>
                {pre.zone && <span style={{ color: 'var(--text-secondary)' }}> · {pre.zone.replace(/_/g, ' ')}</span>}
                {/* once a Mission exists the decision is history: one clamped line, full text on hover */}
                <span style={{ color: 'var(--text-secondary)', display: spec ? '-webkit-box' : 'block', WebkitLineClamp: spec ? 1 : undefined, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{spec ? ' ' : ''}{pre.rationale}</span>
              </div>
            </div>
          )}
          {actions.length > 0 && (
            <div style={{ marginTop: 2 }}>
              <div className="a-label" style={{ marginBottom: 4 }}>{env ? 'Agent in control' : 'On station'}{env ? ` · ${actions.filter((a) => a.tool !== 'note').length} actions` : insp ? ` · waypoint ${insp.waypoint_index + 1}` : ''}</div>
              {hardStop && <div className="a-body" style={{ color: 'var(--red-bright)', marginBottom: 4, display: 'flex', gap: 6, alignItems: 'center' }}><OctagonX size={12} /> Hard stop: {hardStop}. Returning home.</div>}
              <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {actions.map((a, i) => (
                  <li key={i} style={{ display: 'grid', gridTemplateColumns: '14px 78px 1fr', gap: 8, alignItems: 'baseline', fontSize: 11 }}>
                    <span style={{ color: a.ok ? 'var(--accent)' : 'var(--red-bright)', position: 'relative', top: 2 }}>{TOOL_ICON[a.tool] ?? <Eye size={12} />}</span>
                    <span className="a-id" style={{ fontSize: 11 }}>{a.tool.replace('_', ' ')}</span>
                    <span className="a-body" style={{ fontSize: 11, color: a.ok ? 'var(--text-secondary)' : 'var(--red-bright)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontStyle: a.tool === 'note' ? 'italic' : 'normal' }} title={`${String(a.args.why ?? '')} ${a.result}`.trim()}>
                      {a.tool === 'note' ? a.result : <>{describeArgs(a.tool, a.args)}{a.args.why ? <span style={{ color: 'var(--text-tertiary, var(--text-secondary))' }}> · {String(a.args.why)}</span> : a.result && a.tool !== 'set_camera' && a.tool !== 'look_at' ? ` · ${a.result}` : ''}</>}
                    </span>
                  </li>
                ))}
              </ol>
              {insp && <Field k="Assessment" v={<><span className="a-id" style={{ fontSize: 11, color: insp.threat_assessment === 'none' ? 'var(--green-bright)' : 'var(--amber-bright)' }}>{insp.threat_assessment.toUpperCase()}</span> <span style={{ color: 'var(--text-secondary)' }}>{insp.summary}</span></>} />}
            </div>
          )}
          {spec && <>
            <Field k="Mission" v={<span className="a-id">{spec.mission_id}</span>} />
            <Field k="Priority" v={spec.objective} />
            {env ? (
              <Field k="Envelope" v={<span className="a-num" style={{ fontSize: 12 }}>{env.radius_m}<span className="a-unit">m</span> <span style={{ color: 'var(--text-secondary)' }}>around the Detection ·</span> {env.ceiling_m}<span className="a-unit">m</span> <span style={{ color: 'var(--text-secondary)' }}>ceiling ·</span> {env.time_budget_s}<span className="a-unit">s</span></span>} />
            ) : (
              <Field k="Ceiling" v={<span className="a-num" style={{ fontSize: 12 }}>{spec.max_altitude_m}<span className="a-unit">m</span></span>} />
            )}
            {plan && <Field k="Route" v={<span className="a-num" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{route}</span>} />}
            <Field k="Rationale" v={<span title={spec.rationale} style={{ color: 'var(--text-secondary)', display: '-webkit-box', WebkitLineClamp: actions.length ? 2 : 6, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{spec.rationale}</span>} />
          </>}
        </div>
      )}
    </Panel>
  );
}

export function ValidatorPanel(): React.ReactElement {
  const v = useArgus((s) => s.validation);
  const tone = !v ? 'neutral' : v.verdict === 'accept' ? 'nominal' : 'danger';
  return (
    <Panel title="Safety Validator" icon={<ShieldCheck size={13} />} status={v ? <Badge tone={tone} mono>{v.abandoned ? 'ABANDONED' : v.verdict.toUpperCase()}</Badge> : undefined} pad scroll>
      {!v ? <Empty title="No plan checked yet." hint="Every FlightPlan passes here before a motor spins." /> : v.verdict === 'accept' ? (
        <div style={{ display: 'flex', gap: 10, padding: '9px 11px', borderRadius: 6, border: '1px solid var(--green-line)', background: 'var(--green-tint)' }}>
          <CheckCircle2 size={16} style={{ color: 'var(--green-bright)', flex: 'none', marginTop: 1 }} />
          <div className="a-body" style={{ color: 'var(--text-primary)' }}>
            <b style={{ color: 'var(--green-bright)' }}>Accepted</b>{v.checks_passed ? ` · ${v.checks_passed} checks passed` : ''}<br />
            <span style={{ color: 'var(--text-secondary)' }}>Geofence, no-fly zone, altitude, range, hover time and target proximity verified.</span>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 10, padding: '9px 11px', borderRadius: 6, border: '1px solid var(--red-line)', background: 'var(--red-tint)' }}>
          <XCircle size={16} style={{ color: 'var(--red-bright)', flex: 'none', marginTop: 1 }} />
          <div className="a-body" style={{ color: 'var(--text-primary)' }}>
            <b style={{ color: 'var(--red-bright)' }}>Rejected{v.attempt ? ` · attempt ${v.attempt}` : ''}</b>
            <span style={{ color: 'var(--text-secondary)' }}>{v.abandoned ? ' · abandoned, handed to the Operator' : ' · the agent is repairing the plan'}</span>
            <ul style={{ margin: '6px 0 0', paddingLeft: 14 }}>
              {v.violations.map((x, i) => <li key={i} style={{ marginBottom: 2 }}><span className="a-id" style={{ fontSize: 11 }}>{x.rule}</span> <span style={{ color: 'var(--text-secondary)' }}>{x.detail}</span></li>)}
            </ul>
          </div>
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
    <Panel title="Incident Report" icon={<FileText size={13} />} status={inc ? <Badge tone={tone} mono>{inc.severity.toUpperCase()}</Badge> : undefined} pad scroll>
      {!inc ? <Empty title="No report yet." hint="Observations from the flight feed the triage decision and the report." /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <div className="a-title">{inc.title}</div>
          {triage && <Field k="Triage" v={<><span className="a-id" style={{ fontSize: 11 }}>{triage.decision.toUpperCase()}</span> <span style={{ color: 'var(--text-secondary)' }}>· confidence <span className="a-num" style={{ fontSize: 11, color: 'inherit' }}>{triage.confidence}</span></span></>} />}
          <Field k="Action" v={inc.recommended_action} />
          <div className="a-body" style={{ lineHeight: 1.55 }}>{renderMarkdown(inc.body_markdown)}</div>
          {inc.resolution ? (
            <Badge tone={inc.resolution === 'escalated' ? 'danger' : 'neutral'} mono style={{ alignSelf: 'flex-start' }}>{inc.resolution.toUpperCase()} BY OPERATOR</Badge>
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
