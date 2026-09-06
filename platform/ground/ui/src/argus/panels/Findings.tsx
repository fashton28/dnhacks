import React from 'react';
import { X, Printer, ShieldCheck, ShieldAlert, OctagonX } from 'lucide-react';
import { Button } from '@/components';
import { renderMarkdown } from '@/lib/markdown';
import { useArgus, evidenceUrl, type DecisionEntry } from '../store';
import type { HubIncidentReport, HubObservation } from '@/dataSource/HubDataProvider';
import { TrailList, fmtClock } from './DecisionTrail';
import { ArgusMark } from '../Brand';

const VERDICT: Record<HubIncidentReport['verdict'], { label: string; color: string }> = {
  escalate: { label: 'Escalate', color: 'var(--red-bright)' }, log: { label: 'Log only', color: 'var(--amber-bright)' }, false_alarm: { label: 'False alarm', color: 'var(--text-secondary)' },
};
const SEVERITY_COLOR = (s: string) => (s === 'critical' || s === 'high' ? 'var(--red-bright)' : s === 'medium' ? 'var(--amber-bright)' : 'var(--green-bright)');
const THREAT_COLOR = (t: string) => (t === 'hostile' ? 'var(--red-bright)' : t === 'suspicious' ? 'var(--amber-bright)' : t === 'benign' ? 'var(--text-secondary)' : 'var(--green-bright)');
const firstHeading = (md: string): string | null => { const m = /^\*\*(.+?)\*\*/m.exec(md) ?? /^#+\s*(.+)$/m.exec(md); return m ? m[1].trim() : null; };
const Fact = ({ k, children }: { k: string; children: React.ReactNode }) => <div className="a-fact"><div className="a-label">{k}</div><div className="v">{children}</div></div>;

/**
 * The findings document: what the Drone was sent for, why it flew, what it found, the frames, the safety record,
 * and what the Operator should do. Rendered from the stored report plus whatever live state belongs to the same Mission,
 * so it is complete during the flight and still readable after a reload.
 */
export function Findings({ missionId, hubBase, onClose, onResolve }: { missionId: string; hubBase: string; onClose: () => void; onResolve: (r: 'escalated' | 'dismissed') => void }): React.ReactElement {
  const report = useArgus((s) => s.reports[missionId]);
  const incident = useArgus((s) => (s.incident?.mission_id === missionId ? s.incident : null));
  const triage = useArgus((s) => (s.triage?.mission_id === missionId ? s.triage : null));
  const inspection = useArgus((s) => (s.inspection?.mission_id === missionId ? s.inspection : null));
  const envelope = useArgus((s) => (s.envelope?.mission_id === missionId ? s.envelope : null));
  const spec = useArgus((s) => (s.missionSpec?.mission_id === missionId ? s.missionSpec : null));
  const pretriage = useArgus((s) => s.pretriage);
  const droneChoice = useArgus((s) => s.droneChoice);
  const decisions = useArgus((s) => s.decisions);
  const validations = useArgus((s) => s.validations);
  const hardStop = useArgus((s) => s.hardStop);
  const mission = useArgus((s) => s.missions[missionId]);
  const detections = useArgus((s) => s.detections);
  const sightingsByFrame = useArgus((s) => s.sightingsByFrame);
  const live = decisions.some((d) => d.mission_id === missionId) || (!!pretriage && pretriage.detection_id === (report?.detection_id ?? incident?.mission_id));
  const trail: DecisionEntry[] = live ? decisions : [];
  const detId = report?.detection_id ?? (live ? pretriage?.detection_id : undefined) ?? null;
  const detection = detId ? detections.find((d) => d.id === detId) ?? null : null;
  const droneId = report?.drone_id ?? mission?.drone_id ?? (live ? droneChoice?.drone_id : undefined) ?? null;
  const title = incident?.title ?? report?.title ?? (report ? firstHeading(report.narrative) : null) ?? `Mission ${missionId}`;
  const severity = incident?.severity ?? report?.severity ?? null;
  const action = incident?.recommended_action ?? report?.recommended_action ?? null;
  const threat = inspection?.threat_assessment ?? report?.threat_assessment ?? null;
  const summary = inspection?.summary ?? report?.summary ?? null;
  const verdict = report?.verdict ?? (triage ? (triage.decision === 'escalate' ? 'escalate' : triage.decision === 'false_alarm' ? 'false_alarm' : 'log') : null);
  const observations: HubObservation[] = report?.observations ?? [];
  const frames = React.useMemo(() => {
    const seen = new Set<string>(); const out: { ref: string; caption: string; salient: boolean }[] = [];
    for (const o of [...observations].sort((a, b) => Number(b.salient) - Number(a.salient))) if (o.frame_ref && !seen.has(o.frame_ref)) { seen.add(o.frame_ref); out.push({ ref: o.frame_ref, caption: o.description, salient: o.salient }); }
    for (const r of report?.evidence_refs ?? []) if (!seen.has(r)) { seen.add(r); out.push({ ref: r, caption: `Waypoint frame ${r.split('/').pop() ?? ''}`, salient: false }); }
    for (const r of mission?.evidence ?? []) if (!seen.has(r)) { seen.add(r); out.push({ ref: r, caption: `Waypoint frame ${r.split('/').pop() ?? ''}`, salient: false }); }
    return out;
  }, [observations, report?.evidence_refs, mission?.evidence]);
  const [zoom, setZoom] = React.useState<string | null>(null);
  const accepted = validations.filter((v) => v.verdict === 'accept').length, rejected = validations.filter((v) => v.verdict === 'reject').length;
  const clamps = trail.filter((d) => d.kind === 'clamp').length;
  const when = report?.created_at ? new Date(report.created_at) : incident ? new Date(incident.ts) : null;
  const resolution = incident?.resolution ?? null;
  React.useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (zoom) setZoom(null); else onClose(); } }; window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey); }, [onClose, zoom]);

  return (
    <div className="a-findings-scrim" onClick={onClose}>
      <article className="a-glass a-findings a-in" onClick={(e) => e.stopPropagation()} aria-label={`Findings for ${missionId}`}>
        <header style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: 'var(--green-bright)', display: 'flex' }}><ArgusMark size={18} /></span>
            <span className="a-label">Findings · <span className="a-num" style={{ color: 'var(--text-secondary)', textTransform: 'none', letterSpacing: 0 }}>{missionId}</span>{detId ? <> · <span className="a-num" style={{ color: 'var(--text-secondary)', textTransform: 'none', letterSpacing: 0 }}>{detId}</span></> : null}</span>
            <span style={{ flex: 1 }} />
            <div className="noprint" style={{ display: 'flex', gap: 6 }}>
              <Button size="sm" icon={<Printer size={13} />} onClick={() => window.print()} title="Print, or save as PDF">Print</Button>
              <button className="a-icobtn" onClick={onClose} aria-label="Close" title="Close (Esc)"><X size={13} /></button>
            </div>
          </div>
          <h1>{title}</h1>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {severity && <span className="a-chip" data-fill="true" style={{ color: SEVERITY_COLOR(severity) }}>{severity} severity</span>}
            {verdict && <span className="a-chip" data-fill="true" style={{ color: VERDICT[verdict].color }}>{VERDICT[verdict].label}</span>}
            {threat && <span className="a-chip" style={{ color: THREAT_COLOR(threat) }}>threat {threat}</span>}
            {resolution && <span className="a-chip" data-fill="true" style={{ color: resolution === 'escalated' ? 'var(--red-bright)' : 'var(--text-secondary)' }}>{resolution} by operator</span>}
            <span style={{ flex: 1 }} />
            <span className="a-num" style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{droneId ?? 'no flight'}{when ? ` · ${when.toLocaleDateString()} ${fmtClock(when.getTime())}` : ''}</span>
          </div>
        </header>

        <section>
          <h2>In brief</h2>
          <p className="lead">{triage?.rationale ?? action ?? (report ? 'See the report below.' : 'The agent has not reported yet.')}</p>
          <div className="a-facts" style={{ marginTop: 12 }}>
            <Fact k="Detection">{detection ? <>{detection.change_type.replace(/_/g, ' ')} · <span className="a-num">{Math.round(detection.area_m2 ?? 0)} m²</span> · confidence <span className="a-num">{detection.confidence.toFixed(2)}</span>{pretriage?.zone && live ? <><br /><span style={{ color: 'var(--text-secondary)' }}>{pretriage.zone.replace(/_/g, ' ')}</span></> : null}</> : detId ?? '—'}</Fact>
            <Fact k="Drone">{droneId ? <><span className="a-id">{droneId}</span>{live && droneChoice?.drone_id === droneId ? <><br /><span style={{ color: 'var(--text-secondary)' }}>{droneChoice.reason}</span></> : null}</> : 'No flight'}</Fact>
            <Fact k="Envelope">{envelope ? <><span className="a-num">{envelope.radius_m}</span> m around the Detection · ceiling <span className="a-num">{envelope.ceiling_m}</span> m · standoff <span className="a-num">{envelope.standoff_m}</span> m · <span className="a-num">{envelope.time_budget_s}</span> s</> : spec ? <>ceiling <span className="a-num">{spec.max_altitude_m}</span> m · standoff <span className="a-num">{spec.standoff_m}</span> m</> : '—'}</Fact>
            <Fact k="Safety record">
              {validations.length || hardStop || clamps ? (
                <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: rejected ? 'var(--amber-bright)' : 'var(--green-bright)' }}>{rejected ? <ShieldAlert size={12} /> : <ShieldCheck size={12} />}<span className="a-num">{accepted}</span> accepted · <span className="a-num">{rejected}</span> refused</span>
                  {clamps > 0 && <span style={{ color: 'var(--amber-bright)' }}><span className="a-num">{clamps}</span> manual clamp{clamps > 1 ? 's' : ''}</span>}
                  {hardStop && <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--red-bright)' }}><OctagonX size={12} /> hard stop: {hardStop}</span>}
                </span>
              ) : report ? 'Validated by the Safety Validator' : '—'}
            </Fact>
          </div>
        </section>

        {(summary || observations.length > 0) && (
          <section>
            <h2>What the Drone found</h2>
            {summary && <p style={{ marginBottom: observations.length ? 12 : 0 }}>{summary}</p>}
            {observations.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[...observations].sort((a, b) => Number(b.salient) - Number(a.salient)).map((o, i) => (
                  <div key={`${o.frame_ref}-${i}`} className="a-obs" data-salient={o.salient}>
                    {o.frame_ref ? <img src={evidenceUrl(hubBase, o.frame_ref)} alt="" onClick={() => setZoom(evidenceUrl(hubBase, o.frame_ref))} onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} /> : <div style={{ width: 148, height: 84, borderRadius: 5, background: 'rgba(255,255,255,0.04)' }} />}
                    <div style={{ minWidth: 0 }}>
                      <p>{o.description || 'No description.'}</p>
                      {(sightingsByFrame[o.frame_ref] ?? []).length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                          {(sightingsByFrame[o.frame_ref] ?? []).map((sg) => <span key={sg.id} className="a-chip" style={{ color: typeof sg.temp_max_c === 'number' && sg.temp_max_c >= 100 ? 'var(--red-bright)' : 'var(--amber-bright)' }}>{sg.label.replace(/_/g, ' ')} {Math.round(sg.confidence * 100)}%{typeof sg.temp_max_c === 'number' ? ` · ${sg.temp_max_c.toFixed(0)} °C` : ''}</span>)}
                        </div>
                      )}
                      <div className="a-num" style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 4 }}>
                        {o.salient ? 'salient · ' : ''}waypoint {o.waypoint_index + 1}{o.camera_mode ? ` · ${o.camera_mode.toUpperCase()}` : ''}{o.zoom ? ` · ${o.zoom.toFixed(1)}x` : ''}{typeof o.alt_m === 'number' ? ` · ${o.alt_m.toFixed(0)} m` : ''}{typeof o.thermal_max_c === 'number' ? <> · <span style={{ color: o.thermal_max_c >= 100 ? 'var(--red-bright)' : 'var(--text-secondary)' }}>peak {o.thermal_max_c.toFixed(0)} °C</span></> : null}{o.looking_for ? ` · looking for ${o.looking_for}` : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {frames.length > 0 && (
          <section>
            <h2>Evidence · {frames.length} frame{frames.length === 1 ? '' : 's'}</h2>
            <div className="a-gallery">
              {frames.map((f) => (
                <figure key={f.ref}>
                  <img src={evidenceUrl(hubBase, f.ref)} alt="" onClick={() => setZoom(evidenceUrl(hubBase, f.ref))} onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} style={f.salient ? { borderColor: 'var(--amber-line)' } : undefined} />
                  <figcaption title={f.caption}>{f.ref.split('/').pop()}</figcaption>
                </figure>
              ))}
            </div>
          </section>
        )}

        {trail.length > 0 && (
          <section>
            <h2>Decision trail</h2>
            <TrailList entries={trail} />
          </section>
        )}

        {(incident?.body_markdown || report?.narrative) && (
          <section>
            <h2>Report</h2>
            <div className="a-md a-body" style={{ color: 'var(--text-primary)' }}>{renderMarkdown(incident?.body_markdown ?? report?.narrative ?? '')}</div>
          </section>
        )}

        <section>
          <h2>Recommended action</h2>
          <p className="lead">{action ?? (verdict === 'escalate' ? 'Escalate to the security lead.' : 'No action beyond the log.')}</p>
          <div className="noprint" style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            {incident && !resolution ? (
              <>
                <Button size="sm" variant="danger" onClick={() => onResolve('escalated')}>Escalate</Button>
                <Button size="sm" onClick={() => onResolve('dismissed')}>Dismiss</Button>
              </>
            ) : null}
            <span style={{ flex: 1 }} />
            <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
          </div>
        </section>
      </article>
      {zoom && <div className="a-lightbox" onClick={(e) => { e.stopPropagation(); setZoom(null); }}><img src={zoom} alt="" /></div>}
    </div>
  );
}
