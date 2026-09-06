/* ============================================================================
 * ARGUS operator console: the ground-control dashboard driven by the ARGUS Hub.
 * ----------------------------------------------------------------------------
 * Layout (1470x830 and up, 1280x720 fallback):
 *   status bar
 *   [ Fleet + Operations | Flight ops / Mission / World view | Instruments + Telemetry ]
 * All state lives in the zustand store (src/argus/store.ts); this shell wires
 * the HubDataProvider streams into it and turns Operator actions into Hub REST.
 * ========================================================================== */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ManualInput, StatusText } from '@/contract';
import { dataSource, consoleUrl } from '@/dataSource';
import { HubDataProvider } from '@/dataSource/HubDataProvider';
import type { HubDetection, HubDroneState, HubMission, HubIncidentReport, AgentPlan } from '@/dataSource/HubDataProvider';
import { useSettings } from '@/store';
import { getSiteModel } from '@/site';
import type { SiteModel } from '@/site';
import { Toast } from '@/components';
import { LogConsole } from '@/panels';
import { SiteMap } from './panels/SiteMap';
import { ArgusVideo, postToCameraFrame } from './panels/ArgusVideo';
import { useArgus, activeMission, liveDetection, deriveDroneChoice, CAMERA_MODES, type AutonomyMode, type Sighting, type PlantSignal, FOV_MAX, FOV_MIN, fovToZoom, zoomToFov, type CameraMode, type CameraView, type SceneProp } from './store';
import { FleetPanel } from './panels/FleetPanel';
import { OpsPanel, type OpsActions } from './panels/OpsPanel';
import { DetectionsPanel, ValidatorPanel, ReportPanel } from './panels/MissionPanel';
import { DecisionTrail } from './panels/DecisionTrail';
import { Findings } from './panels/Findings';
import { ReportsList } from './panels/ReportsList';
import { PlantSignals } from './panels/PlantSignals';
import { ArgusTelemetry } from './panels/ArgusTelemetry';
import { TopBar } from './panels/TopBar';
import { Rail, type View, type DrawerId } from './panels/Rail';
import { Drawer } from './panels/Drawer';
import { DetectionCard } from './panels/DetectionCard';
import { BottomStrip } from './panels/BottomStrip';
import { ClampBanner } from './panels/ClampBanner';
import { GIMBAL_MAX, GIMBAL_MIN } from './panels/OpsPanel';
import { useArgusDocument } from './Brand';
import { Keyboard, SlidersHorizontal, Radar, ScrollText, ShieldCheck, FileText } from 'lucide-react';
import './argus.css';

type CenterView = View;
interface ToastItem { id: number; severity: 'info' | 'success' | 'warning' | 'error' | 'critical'; title: string; message?: string }

const hub = dataSource as unknown as HubDataProvider;

/** The Hub's autonomy policy as one line: veto window, concurrent flights, asset cooldown. */
export function policyText(p: unknown): string | null {
  if (!p) return null;
  if (typeof p === 'string') return p;
  const o = p as { veto_window_s?: number; max_concurrent_flights?: number; asset_cooldown_s?: number };
  const parts = [typeof o.veto_window_s === 'number' ? `${o.veto_window_s} s veto` : null, typeof o.max_concurrent_flights === 'number' ? `${o.max_concurrent_flights} flight${o.max_concurrent_flights === 1 ? '' : 's'} at once` : null, typeof o.asset_cooldown_s === 'number' ? `${Math.round(o.asset_cooldown_s / 60)} min asset cooldown` : null].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** The first whole sentences of a caption that fit in `max` characters (a trail line, not the full description). */
function firstSentences(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max); const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return end > 40 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(' ')) + '…';
}

export default function ArgusApp(): JSX.Element {
  const worldFrameRef = useRef<HTMLIFrameElement | null>(null);
  const selectedForWorld = useArgus((s) => s.selected);
  useEffect(() => {
    if (!selectedForWorld) return;
    const post = () => worldFrameRef.current?.contentWindow?.postMessage({ type: 'argus-select', drone_id: selectedForWorld }, '*');
    post(); const t = setTimeout(post, 1500); return () => clearTimeout(t);
  }, [selectedForWorld]);
  useArgusDocument();
  const settings = useSettings();
  const st = useArgus;
  const [center, setCenter] = useState<CenterView>('flight');
  const [site, setSite] = useState<SiteModel | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [help, setHelp] = useState(false);
  const [drawer, setDrawer] = useState<DrawerId | null>(null);
  const base = hub.httpBase();

  const toast = useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = Math.random();
    setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 3800);
  }, []);
  const log = useCallback((severity: StatusText['severity'], text: string) => {
    st.getState().addLog({ type: 'statusText', ts: Date.now(), vehicleId: st.getState().selected ?? 'console', severity, text });
  }, [st]);

  /* ---- site model ---- */
  useEffect(() => { getSiteModel().then(setSite).catch((e: Error) => toast({ severity: 'error', title: 'Site model failed', message: e.message })); }, [toast]);

  const refreshDetections = useCallback(async () => {
    const r = await hub.getJson('/detections');
    if (r.ok && Array.isArray(r.json)) st.getState().setDetections(r.json as HubDetection[]);
  }, [hub, st]);

  /* ---- Hub streams -> store ---- */
  useEffect(() => {
    hub.connect(settings.connection).catch(() => st.getState().setConn('error'));
    const s = st.getState();
    const offs = [
      hub.onConnectionChange((c) => {
        st.getState().setConn(c);
        // a Hub that restarted has a fresh Detection list; never keep ids it no longer knows
        if (c === 'connected') void refreshDetections();
      }),
      hub.onManualPhase((p) => st.getState().setManualPhase(p)),
      hub.onTelemetry((t) => { if (t.vehicleId === (st.getState().selected ?? hub.getVehicle())) st.getState().setTel(t); }),
      hub.onStatusText((x) => st.getState().addLog(x)),
      hub.onAck((a) => { if (!a.success) toast({ severity: 'error', title: `${a.command} failed`, message: a.message }); }),
      hub.onRawEvent(function handle(ev) {
        (window as unknown as { __argusInject?: (e: Record<string, unknown>) => void }).__argusInject = handle;  // debug hook: feed a Hub-shaped event without the Hub
        const g = st.getState();
        // when the Hub stamps an event (replayed trust_events do), the trail keeps that time rather than the time we saw it
        const at = typeof ev.ts === 'number' ? (ev.ts > 1e12 ? ev.ts : ev.ts * 1000) : typeof ev.ts === 'string' && !Number.isNaN(Date.parse(ev.ts)) ? Date.parse(ev.ts) : Date.now();
        const decide = (d: Parameters<typeof g.addDecision>[0]): void => { g.addDecision({ ts: at, ...d }); };
        switch (ev.type) {
          case 'snapshot': {
            const drones = (ev.drones as HubDroneState[]) ?? [];
            g.setFleet(drones);
            for (const m of (ev.missions as HubMission[]) ?? []) g.setMission(m);
            const sel = g.selected && drones.some((d) => d.drone_id === g.selected) ? g.selected : drones.sort((a, b) => a.drone_id.localeCompare(b.drone_id))[0]?.drone_id;
            if (sel) { hub.setVehicle(sel); g.select(sel); void loadCamera(sel); }
            // the current dispatch's story (pretriage, spec, validation, envelope, agent trace, report) replayed in order,
            // so a dashboard opened mid-flight shows the trust column filled in
            replaying.current = true;
            try { for (const e of (ev.trust_events as Record<string, unknown>[] | undefined) ?? []) handle(e); } finally { replaying.current = false; }
            break;
          }
          case 'drone_state': {
            // 10 Hz per Drone: coalesce into one store write per 100 ms
            const d = ev.state as HubDroneState;
            pendingStates.current.set(d.drone_id, d);
            if (!flushTimer.current) flushTimer.current = window.setTimeout(() => {
              flushTimer.current = null;
              const cur = st.getState();
              const fleet = { ...cur.fleet };
              for (const [id, sd] of pendingStates.current) fleet[id] = sd;
              pendingStates.current.clear();
              cur.setFleet(Object.values(fleet));
              if (!cur.selected) { const first = Object.keys(fleet).sort()[0]; if (first) { hub.setVehicle(first); cur.select(first); } }
            }, 100);
            break;
          }
          case 'mission': {
            const m = ev.mission as HubMission;
            const prev = g.missions[m.mission_id];
            g.setMission(m);
            // until the Hub says why it chose a Drone, reproduce its rule from the fleet at the moment the Mission appears
            if (!prev && m.plan?.pattern !== 'square' && (!g.droneChoice || g.droneChoice.mission_id !== m.mission_id) && g.pretriage) {
              const c = deriveDroneChoice(g.fleet, m.drone_id, m.mission_id);
              g.setDroneChoice(c);
              decide({ kind: 'drone', tone: 'info', mission_id: m.mission_id, text: `Chose ${c.drone_id}: ${c.reason}.` });
            }
            if (prev && prev.phase !== m.phase && ['complete', 'failed', 'aborted'].includes(m.phase)) decide({ kind: 'outcome', tone: m.phase === 'complete' ? 'good' : 'bad', mission_id: m.mission_id, text: m.phase === 'complete' ? `${m.drone_id} completed the flight and is returning to its pad.` : `Flight ${m.phase}${m.error ? `: ${m.error}` : ''}.` });
            // a Mission that just started flying takes the console with it, unless the Operator is watching another airborne Drone
            if (m.phase === 'flying' && prev?.phase !== 'flying') {
              const cur = g.selected ? g.fleet[g.selected] : undefined;
              if (!cur || cur.status === 'idle' || cur.drone_id === m.drone_id) { hub.setVehicle(m.drone_id); g.select(m.drone_id); }
            }
            break;
          }
          case 'detection': g.addDetection((ev.detection ?? ev) as HubDetection); break;
          case 'mission_spec': {
            const spec = ev.spec as { objective: string; rationale: string; max_altitude_m: number; standoff_m: number; attempt?: number };
            g.setMissionSpec({ ...spec, attempt: spec.attempt ?? 1, mission_id: String(ev.mission_id) });
            decide({ kind: 'envelope', tone: 'info', mission_id: String(ev.mission_id), text: `Attempt ${spec.attempt ?? 1}: the agent proposes to ${String(spec.objective).replace(/_/g, ' ')} under a ${spec.max_altitude_m} m ceiling${spec.standoff_m ? `, standing off ${spec.standoff_m} m` : ''}.`, detail: spec.rationale });
            if (!replaying.current) setCenter('mission');
            break;
          }
          case 'validation': {
            // two producers: the agent adapter wraps the result in `result`; the Hub's Safety Validator publishes it flat
            const r = (ev.result ?? ev) as { verdict: 'accept' | 'reject'; violations?: { rule: string; detail: string; severity: string }[]; attempt?: number; abandoned?: boolean; checks_passed?: number };
            g.setValidation({ ...r, violations: r.violations ?? [], mission_id: String(ev.mission_id) });
            if (ev.step) break;  // per-step checks while the agent flies are too many to narrate; refusals arrive as agent_action results
            decide(r.verdict === 'accept'
              ? { kind: 'validation', tone: 'good', mission_id: String(ev.mission_id), text: `Safety Validator accepted ${r.attempt ? `attempt ${r.attempt}` : 'the plan'}${r.checks_passed ? `: ${r.checks_passed} checks passed` : ''}.` }
              : { kind: 'validation', tone: r.abandoned ? 'bad' : 'warn', mission_id: String(ev.mission_id), text: r.abandoned ? `Safety Validator refused the last attempt; the agent gave up and handed the Detection to you.` : `Safety Validator refused ${r.attempt ? `attempt ${r.attempt}` : 'the plan'}: ${(r.violations ?? []).map((v) => v.rule.replace(/_/g, ' ')).join(', ') || 'rule'}. Sent back to the agent.`, detail: (r.violations ?? []).map((v) => v.detail).filter(Boolean).join(' ') });
            break;
          }
          case 'pretriage': {
            const action = String(ev.action) as 'dispatch' | 'log_only' | 'ignore';
            g.setPretriage({ detection_id: String(ev.detection_id), zone: (ev.zone as string | null) ?? null, action, rationale: String(ev.rationale ?? '') });
            {
              const d = g.detections.find((x) => x.id === String(ev.detection_id));
              if (d) decide({ kind: 'detection', tone: 'warn', mission_id: null, text: `Wide-area layer flagged ${d.id}: ${d.change_type.replace(/_/g, ' ')}, ${Math.round(d.area_m2 ?? 0)} m², confidence ${d.confidence.toFixed(2)}${ev.zone ? `, in the ${String(ev.zone).replace(/_/g, ' ')}` : ''}.` });
              decide({ kind: 'triage', tone: action === 'dispatch' ? 'good' : 'warn', mission_id: null, text: action === 'dispatch' ? 'Triage agent decided to dispatch.' : action === 'log_only' ? 'Triage agent decided to log it without flying.' : 'Triage agent decided to ignore it.', detail: String(ev.rationale ?? '') });
            }
            log(action === 'dispatch' ? 'info' : 'warning', `Triage agent: ${action.replace('_', ' ').toUpperCase()} for ${String(ev.detection_id)}${ev.zone ? ` (${String(ev.zone).replace(/_/g, ' ')})` : ''}`);
            if (!replaying.current) setCenter('mission');
            break;
          }
          case 'agent_action': {
            const result = String(ev.result ?? ev.detail ?? '');
            const ok = ev.ok !== false && !/^(refused|error)/i.test(result);
            g.addAgentAction({ ts: Date.now(), mission_id: (ev.mission_id as string | null) ?? null, tool: String(ev.tool ?? ev.action ?? '?'), args: (ev.args as Record<string, unknown>) ?? {}, result, ok });
            if (ev.tool === 'fly_to' && ok && g.envelope) {
              // the agent's fly_to is relative to the Detection; place it on the map from the envelope centre
              const a = ev.args as { east_m: number; north_m: number; alt_m: number };
              const lat = g.envelope.center.lat + a.north_m / 111320, lon = g.envelope.center.lon + a.east_m / (111320 * Math.cos((g.envelope.center.lat * Math.PI) / 180));
              g.addFlown({ lat, lon, alt_m: a.alt_m });
            }
            if (!ok) log('warning', `Agent ${String(ev.tool ?? ev.action)}: ${result}`);
            {
              const tool = String(ev.tool ?? ev.action ?? ''); const a = (ev.args ?? {}) as Record<string, unknown>; const why = a.why ? String(a.why) : '';
              const said = tool === 'look_at' ? `Tilted the camera to ${String(a.pitch_deg)}°` : tool === 'set_camera' ? `Switched to ${String(a.mode).toUpperCase()} at ${Number(a.zoom ?? 1).toFixed(1)}x` : tool === 'capture' ? `Captured a frame looking for ${String(a.looking_for ?? 'anything unusual')}` : tool === 'fly_to' ? `Flew to ${Number(a.east_m) >= 0 ? '+' : ''}${Number(a.east_m).toFixed(0)} m east, ${Number(a.north_m) >= 0 ? '+' : ''}${Number(a.north_m).toFixed(0)} m north at ${Number(a.alt_m).toFixed(0)} m` : tool === 'hold' ? `Held position for ${Number(a.seconds).toFixed(0)} s` : tool === 'reposition' ? `Repositioned by ${String(a.dx ?? a.direction ?? '')}, ${String(a.dy ?? a.distance_m ?? '')}, ${String(a.dz ?? '')} m` : tool === 'return_home' ? 'Sent the Drone home' : tool === 'done' ? `Closed the inspection: ${String(a.threat_assessment ?? '').toUpperCase()}` : tool === 'status' ? '' : tool ? `${tool.replace(/_/g, ' ')}` : '';
              if (said) decide({ kind: 'action', tone: ok ? 'info' : 'bad', mission_id: (ev.mission_id as string | null) ?? null, text: ok ? `${said}${why ? ` because ${why.replace(/\.$/, '')}` : ''}.` : `${said}: ${result}.`, detail: ok && tool === 'capture' ? firstSentences(result, 220) : undefined });
            }
            break;
          }
          case 'envelope': {
            g.setEnvelope({ mission_id: String(ev.mission_id), attempt: Number(ev.attempt ?? 1), verdict: ev.verdict as 'accept' | 'reject', center: ev.center as { lat: number; lon: number }, radius_m: Number(ev.radius_m), ceiling_m: Number(ev.ceiling_m), standoff_m: Number(ev.standoff_m), time_budget_s: Number(ev.time_budget_s), objective: String(ev.objective), rationale: String(ev.rationale ?? ''), polygon: (ev.polygon as { lat: number; lon: number }[]) ?? [] });
            log(ev.verdict === 'accept' ? 'info' : 'warning', `Envelope ${String(ev.verdict).toUpperCase()}: ${Number(ev.radius_m)} m around the Detection, ceiling ${Number(ev.ceiling_m)} m, ${Number(ev.time_budget_s)} s`);
            decide({ kind: 'envelope', tone: 'info', mission_id: String(ev.mission_id), text: `Envelope ${Number(ev.attempt ?? 1) > 1 ? `(attempt ${Number(ev.attempt)}) ` : ''}declared: ${String(ev.objective).replace(/_/g, ' ')} within ${Number(ev.radius_m)} m of the Detection, ceiling ${Number(ev.ceiling_m)} m, standoff ${Number(ev.standoff_m)} m, ${Number(ev.time_budget_s)} s of flight.`, detail: String(ev.rationale ?? '') });
            break;
          }
          case 'envelope_repaired': {
            log('warning', `Envelope shrunk after the Safety Validator refused it (${(ev.rules as string[] ?? []).join(', ').replace(/_/g, ' ')}): now ${Number(ev.radius_m)} m, ceiling ${Number(ev.ceiling_m)} m`);
            decide({ kind: 'repair', tone: 'warn', mission_id: String(ev.mission_id), text: `The agent repaired the envelope after the refusal (${(ev.rules as string[] ?? []).join(', ').replace(/_/g, ' ')}): now ${Number(ev.radius_m)} m around the Detection under a ${Number(ev.ceiling_m)} m ceiling.` });
            break;
          }
          case 'agent_note': g.addAgentAction({ ts: Date.now(), mission_id: (ev.mission_id as string | null) ?? null, tool: 'note', args: {}, result: String(ev.text ?? ''), ok: true }); decide({ kind: 'note', tone: 'info', mission_id: (ev.mission_id as string | null) ?? null, text: String(ev.text ?? '') }); break;
          case 'hard_stop': g.setHardStop(String(ev.reason)); log('critical', `Hard stop: ${String(ev.reason)}. The Drone is returning home.`); decide({ kind: 'stop', tone: 'bad', mission_id: (ev.mission_id as string | null) ?? null, text: `Hard stop: ${String(ev.reason)}. The Drone is returning home.` }); break;
          case 'drone_selected': {
            const cands = ((ev.candidates ?? []) as { drone_id: string; status: string; battery_pct: number; eligible: boolean; reason: string }[]);
            const chosen = (ev.drone_id as string | null) ?? null;
            g.setDroneChoice({ mission_id: (ev.mission_id as string | null) ?? null, drone_id: chosen ?? '', reason: String(ev.reason ?? ''), candidates: cands, source: 'hub' });
            const others = cands.filter((c) => c.drone_id !== chosen).map((c) => `${c.drone_id} ${c.reason}`).join('; ');
            decide(chosen
              ? { kind: 'drone', tone: 'info', mission_id: (ev.mission_id as string | null) ?? null, text: `Chose ${chosen}: ${String(ev.reason ?? '')}.`, detail: others ? `Passed over: ${others}.` : undefined }
              : { kind: 'drone', tone: 'bad', mission_id: (ev.mission_id as string | null) ?? null, text: `No Drone could fly: ${String(ev.reason ?? '')}.` });
            break;
          }
          case 'inspection': g.setInspection({ mission_id: String(ev.mission_id), waypoint_index: Number(ev.waypoint_index), summary: String(ev.summary ?? ''), threat_assessment: String(ev.threat_assessment ?? 'none'), actions: Number(ev.actions ?? 0) }); decide({ kind: 'inspection', tone: ['suspicious', 'hostile'].includes(String(ev.threat_assessment)) ? 'warn' : 'good', mission_id: String(ev.mission_id), text: `On station the agent assessed the threat as ${String(ev.threat_assessment ?? 'none').toUpperCase()} after ${Number(ev.actions ?? 0)} actions.`, detail: String(ev.summary ?? '') }); break;
          case 'triage': g.setTriage({ decision: String(ev.decision), confidence: Number(ev.confidence), rationale: String(ev.rationale ?? ''), mission_id: String(ev.mission_id) }); decide({ kind: 'verdict', tone: ev.decision === 'escalate' ? 'warn' : 'good', mission_id: String(ev.mission_id), text: `Triage verdict: ${String(ev.decision).replace(/_/g, ' ').toUpperCase()}, confidence ${Number(ev.confidence).toFixed(2)}.`, detail: String(ev.rationale ?? '') }); break;
          case 'incident': g.setIncident({ title: String(ev.title), severity: String(ev.severity), body_markdown: String(ev.body_markdown), recommended_action: String(ev.recommended_action), mission_id: String(ev.mission_id), ts: Date.now() }); decide({ kind: 'report', tone: ['high', 'critical'].includes(String(ev.severity)) ? 'bad' : 'info', mission_id: String(ev.mission_id), text: `Report written: ${String(ev.title)} (${String(ev.severity)} severity).`, detail: `Recommended: ${String(ev.recommended_action)}` }); break;
          case 'incident_report': {
            const r = ev.report as HubIncidentReport;
            if (r && r.mission_id) g.setReport({ ...r, detection_id: r.detection_id ?? (ev.detection_id as string | undefined) });
            break;
          }
          case 'autonomy': {
            const e = ev.event as { type: string; mission_id: string | null; payload: Record<string, unknown> };
            if (e.type === 'plan_proposed') g.setAgentPlan({ mission_id: e.mission_id ?? '', attempt: Number(e.payload.attempt ?? 1), plan: e.payload.plan as AgentPlan });
            break;
          }
          case 'sightings': {
            const list = ((ev.sightings ?? []) as Partial<Sighting>[]).filter((s) => Array.isArray(s.bbox) && s.bbox.length === 4).map((s, i) => ({ id: String(s.id ?? i), label: String(s.label ?? 'object'), confidence: Number(s.confidence ?? 0), bbox: (s.bbox as number[]).map(Number) as [number, number, number, number], camera_mode: s.camera_mode, lat: s.lat, lon: s.lon, range_m: s.range_m, temp_max_c: s.temp_max_c, frame_ref: s.frame_ref }));
            g.setSightings({ ts: replaying.current ? 0 : at, drone_id: String(ev.drone_id ?? ''), mission_id: (ev.mission_id as string | null) ?? null, frame_ref: (ev.frame_ref as string | null) ?? null, width: Number(ev.width ?? 1280), height: Number(ev.height ?? 720), sightings: list });
            if (list.length) {
              const hot = list.filter((s) => typeof s.temp_max_c === 'number');
              decide({ kind: 'inspection', tone: hot.some((s) => (s.temp_max_c ?? 0) >= 100) ? 'bad' : 'warn', mission_id: (ev.mission_id as string | null) ?? null, text: `Vision: ${list.map((s) => `${s.label.replace(/_/g, ' ')} ${Math.round(s.confidence * 100)}%${typeof s.temp_max_c === 'number' ? ` at ${s.temp_max_c.toFixed(0)} °C` : ''}`).join(', ')}.` });
            }
            break;
          }
          case 'plant_signal': {
            const asset = (ev.asset ?? {}) as { name?: string; lat?: number; lon?: number };
            const sev = (['info', 'warning', 'alarm'].includes(String(ev.severity)) ? String(ev.severity) : 'info') as PlantSignal['severity'];
            const numOr = (v: unknown): number | string => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : String(v ?? ''));
            const p: PlantSignal = { id: String(ev.id ?? `${String(ev.sensor_id)}-${at}`), ts: at, sensor_id: String(ev.sensor_id ?? ev.id ?? 'sensor'), kind: String(ev.kind ?? 'signal'), value: numOr(ev.value), unit: String(ev.unit ?? ''), threshold: ev.threshold === null || ev.threshold === undefined ? null : numOr(ev.threshold), asset: { name: String(asset.name ?? ev.sensor_id ?? 'asset'), lat: asset.lat, lon: asset.lon }, severity: sev, note: String(ev.note ?? '') };
            g.addPlantSignal(p);
            if (sev !== 'info') {
              const reading = typeof p.value === 'number' ? `${p.value} ${p.unit}`.trim() : p.value; const limit = p.threshold === null ? '' : typeof p.threshold === 'number' ? ` (limit ${p.threshold} ${p.unit})`.replace(/\s+\)/, ')') : ` (limit ${p.threshold})`;
              log(sev === 'alarm' ? 'critical' : 'warning', `Plant: ${p.asset.name} ${p.kind.replace(/_/g, ' ')} ${reading}${limit}`);
              decide({ kind: 'detection', tone: sev === 'alarm' ? 'bad' : 'warn', mission_id: null, text: `Plant instrumentation: ${p.asset.name} ${p.kind.replace(/_/g, ' ')} ${reading}${limit ? limit.replace(' (limit', ' against a limit of').replace(')', '') : ''} (${sev}).`, detail: p.note || undefined });
            }
            break;
          }
          case 'decision': {
            // one event per state change: the card shows a countdown only while the Hub still waits for a veto
            const rawAction = String(ev.action ?? 'dispatch'), status = String(ev.status ?? '');
            const action: 'dispatch' | 'held' | 'released' = rawAction === 'held' || status === 'held' ? 'held' : rawAction === 'dispatch' && (status === '' || status === 'pending') ? 'dispatch' : 'released';
            const dl = ev.deadline_ts; const deadline = typeof dl === 'number' ? (dl > 1e12 ? dl : dl * 1000) : typeof dl === 'string' && !Number.isNaN(Date.parse(dl)) ? Date.parse(dl) : null;
            const prev = g.pendingDecisions[String(ev.id ?? ev.detection_id)];
            g.setDecision({ id: String(ev.id ?? ev.detection_id), detection_id: String(ev.detection_id ?? ''), action, rationale: String(ev.rationale ?? ''), deadline_ts: deadline, mode: String(ev.mode ?? ''), ts: prev?.ts ?? at });
            const det = String(ev.detection_id ?? ''); const asset = ev.asset ? ` at ${String(ev.asset)}` : '';
            const line = rawAction === 'held' || status === 'held' ? `Operator held the dispatch of ${det}${asset}.`
              : rawAction === 'released' || status === 'released' ? `Dispatch of ${det} released by the Operator.`
              : rawAction === 'refused' || status === 'refused' ? `The system refused to dispatch ${det}${asset}.`
              : rawAction === 'no_dispatch' || status === 'no_dispatch' ? `No dispatch for ${det}${asset}.`
              : status === 'dispatching' || status === 'dispatched' ? `The system is dispatching ${det}${asset}${ev.mission_id ? ` as ${String(ev.mission_id)}` : ''}.`
              : status === 'failed' ? `Automatic dispatch of ${det} failed.`
              : `${String(ev.mode ?? 'supervised')} mode: the system will dispatch ${det}${asset}${deadline ? ` in ${Math.max(0, Math.round((deadline - at) / 1000))} s` : ''} unless held.`;
            const tone = ['held', 'failed', 'refused'].some((k) => rawAction === k || status === k) ? 'warn' : 'info';
            if (!prev || prev.action !== action || status === 'dispatching' || status === 'failed' || rawAction === 'refused') decide({ kind: 'triage', tone, mission_id: (ev.mission_id as string | null) ?? null, text: line, detail: String(ev.rationale ?? '') || undefined });
            break;
          }
          case 'autonomy_mode': if (['manual', 'supervised', 'autonomous'].includes(String(ev.mode))) g.setAutonomy(String(ev.mode) as AutonomyMode, policyText(ev.policy)); break;
          case 'clamp': g.setClamp({ rule: String(ev.rule), ts: Date.now() }); if (g.decisions.length) decide({ kind: 'clamp', tone: 'warn', mission_id: null, text: `Operator's manual command clamped at the ${String(ev.rule).replace(/[+_]/g, ' ')}.` }); break;
          case 'manual': if (String(ev.drone_id) === g.selected) g.setManualActive(Boolean(ev.active)); break;
          case 'dispatch_outcome': {
            g.setDispatching(null);
            const key = `${String(ev.detection_id)}:${String(ev.mission_id)}`;
            if (lastOutcome.current === key) break;  // StrictMode/dev double-subscription guard
            lastOutcome.current = key;
            if (!replaying.current) toast({ severity: ev.flown ? 'success' : 'warning', title: ev.flown ? `Flown by ${String(ev.drone_id)}` : 'Not flown', message: `${String(ev.detection_id)} · ${String(ev.attempts)} attempt(s)` });
            decide({ kind: 'outcome', tone: ev.flown ? 'good' : 'warn', mission_id: (ev.mission_id as string | null) ?? null, text: ev.flown ? `Dispatch complete: flown by ${String(ev.drone_id)} in ${String(ev.attempts)} attempt${Number(ev.attempts) === 1 ? '' : 's'}. Findings are ready.` : `Dispatch closed without a flight after ${String(ev.attempts)} attempt${Number(ev.attempts) === 1 ? '' : 's'}.` });
            // the payoff of the flight: the findings document opens itself once the report exists
            if (!replaying.current && ev.flown && ev.mission_id && (g.reports[String(ev.mission_id)] || g.incident?.mission_id === String(ev.mission_id))) g.openFindings(String(ev.mission_id));
            break;
          }
          case 'scene': { const sc = ev.state as { open_fences?: string[]; props?: SceneProp[] } | undefined; g.setOpenFences(sc?.open_fences ?? []); g.setSceneProps(sc?.props ?? []); break; }
          case 'camera': g.setCamera(String(ev.drone_id), { mode: ev.mode as CameraMode, fov_deg: Number(ev.fov_deg) }); break;
          case 'frame': if (String(ev.drone_id) === (g.selected ?? '')) lastFrame.current = Date.now(); break;
          default: break;
        }
      }),
    ];
    void s.setConn('connecting');
    void refreshDetections();
    hub.getJson('/missions').then((r) => { if (r.ok && Array.isArray(r.json)) for (const m of r.json as HubMission[]) st.getState().setMission(m); });
    hub.getJson('/incidents').then((r) => { if (r.ok && Array.isArray(r.json)) st.getState().setReports(r.json as HubIncidentReport[]); });
    hub.getJson('/scene').then((r) => { if (r.ok && r.json) { const sc = r.json as { open_fences?: string[]; props?: SceneProp[] }; st.getState().setOpenFences(sc.open_fences ?? []); st.getState().setSceneProps(sc.props ?? []); } });
    const sampler = setInterval(() => st.getState().sampleHistory(), 1000);
    return () => { offs.forEach((f) => f()); clearInterval(sampler); hub.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.connection.host, settings.connection.controlPort]);

  /* ---- selection ---- */
  const select = useCallback((id: string) => { hub.setVehicle(id); st.getState().select(id); st.getState().setManualActive(false); void loadCamera(id); }, [st]);
  const loadCamera = useCallback(async (id: string) => {
    const r = await hub.getJson(`/drones/${id}/camera`);
    if (r.ok && r.json) { const c = r.json as CameraView; st.getState().setCamera(id, { mode: c.mode, fov_deg: c.fov_deg }); }
  }, [st]);
  useEffect(() => { const id = st.getState().selected; if (id) void loadCamera(id); }, [loadCamera, st]);

  /* ---- actions ---- */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hub payloads are dynamically shaped
  const post = useCallback(async (path: string, body: unknown, okMsg?: string): Promise<any> => {
    const r = await hub.postJson(path, body);
    if (!r.ok) {
      const j = r.json as { detail?: unknown; verdict?: string; violations?: { rule: string; detail: string }[] } | null;
      const detail = j && typeof j === 'object' && Array.isArray(j.violations)
        ? `Safety Validator rejected the plan: ${j.violations.map((v) => `${v.rule.replace(/_/g, ' ')} (${v.detail})`).join('; ')}`
        : j && typeof j === 'object' && 'detail' in j ? (typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)) : (typeof r.text === 'string' ? r.text : JSON.stringify(r.text));
      const msg = String(detail).slice(0, 220);
      toast({ severity: 'error', title: 'Hub refused', message: msg }); log('error', `${path}: ${msg}`); throw new Error(msg);
    }
    if (okMsg) log('info', okMsg);
    return r.json;
  }, [toast, log]);

  const act: OpsActions = useMemo(() => ({
    async baseline() {
      const ref = `overhead/baseline-${Date.now()}.png`;
      await post('/overhead/capture', { ref }, `Baseline captured: ${ref}`);
      st.getState().setBaseline(ref);
    },
    async detect() {
      const before = st.getState().baselineRef; if (!before) { toast({ severity: 'warning', title: 'Capture a Baseline first' }); return; }
      const after = `overhead/after-${Date.now()}.png`;
      await post('/overhead/capture', { ref: after });
      const dets: HubDetection[] = await post('/widearea/detect', { before_ref: before, after_ref: after });
      if (dets.length === 0) { toast({ severity: 'info', title: 'No change above the minimum area' }); log('info', 'Change detection: nothing above the minimum area'); }
      else { toast({ severity: 'warning', title: `${dets.length} Detection${dets.length > 1 ? 's' : ''}`, message: dets.map((d) => d.id).join(', ') }); setCenter('mission'); }
    },
    async dispatch() {
      const d = st.getState().detections.slice(-1)[0]; if (!d) return;
      await dispatchId(d.id);
    },
    async returnHome() { const id = st.getState().selected; if (!id) return; await post(`/drones/${id}/command`, { type: 'return_home' }, `${id}: return home`); },
    async flySquare() {
      const id = st.getState().selected; if (!id) return;
      const plan = await (await fetch(`${base}/console/fixtures/flight_plan_square.json`)).json();
      plan.mission_id = `msn-${Date.now().toString(36)}`;
      await post('/missions/fly', { plan, drone_id: id }, `${id}: flying the square fixture (${plan.mission_id})`);
    },
    async pause() { const m = activeMission(st.getState(), st.getState().selected); if (m) await post(`/missions/${m.mission_id}/pause`, {}, `Mission ${m.mission_id} paused`); },
    async resume() { const m = activeMission(st.getState(), st.getState().selected); if (m) await post(`/missions/${m.mission_id}/resume`, {}, `Mission ${m.mission_id} resumed`); },
    async abort() { const m = activeMission(st.getState(), st.getState().selected); if (m) await post(`/missions/${m.mission_id}/abort`, {}, `Mission ${m.mission_id} aborted`); },
    async scenario(kind) { await post('/scenarios/run', { id: `scn-${Date.now().toString(36)}`, kind, params: {} }, `Scenario: ${kind.replace(/_/g, ' ')}`); },
    async resetScene() { await post('/scenarios/reset', {}, 'Site reset to baseline'); },
    async manualTake() {
      const id = st.getState().selected; if (!id) return;
      const a = await hub.sendCommand({ type: 'command', vehicleId: id, command: 'engageManual' });
      if (a.success) { st.getState().setManualActive(true); log('warning', a.message); }
    },
    async manualRelease() {
      const id = st.getState().selected; if (!id) return;
      const a = await hub.sendCommand({ type: 'command', vehicleId: id, command: 'disengageManual' });
      st.getState().setManualActive(false); log('info', a.message);
    },
    gimbal(pitchDeg: number) {
      const id = st.getState().selected; if (!id) return;
      const v = Math.round(Math.max(GIMBAL_MIN, Math.min(GIMBAL_MAX, pitchDeg)));
      st.getState().setGimbalPending(v);
      gimbalTarget.current = v;
      // the camera and World views aim at the target now; the Hub's look_at and the telemetry echo follow within a frame or two
      const optimistic = { type: 'argus-gimbal', drone_id: id, pitch_deg: v };
      postToCameraFrame(optimistic); worldFrameRef.current?.contentWindow?.postMessage(optimistic, '*');
      if (gimbalTimer.current === null) {
        gimbalTimer.current = window.setTimeout(async () => {
          gimbalTimer.current = null;
          const target = gimbalTarget.current;
          if (target === null) return;
          try { await hub.postJson(`/drones/${id}/command`, { type: 'look_at', pitch_deg: target }); }
          catch { /* the Hub logs refusals; telemetry stays authoritative */ }
          // telemetry takes over once it catches up; clear the optimistic value after a grace period either way
          window.setTimeout(() => { if (gimbalTarget.current === target) { st.getState().setGimbalPending(null); gimbalTarget.current = null; } }, 1200);
        }, 50);  // 20 Hz while a key is held: one look_at per camera tick
      }
    },
    cameraMode(mode: CameraMode) {
      const id = st.getState().selected; if (!id) return;
      const cur = st.getState().camera[id] ?? { mode: 'rgb' as CameraMode, fov_deg: 70 };
      st.getState().setCamera(id, { ...cur, mode });
      void post(`/drones/${id}/camera`, { mode }, `${id}: camera ${mode.toUpperCase()}`).catch(() => { /* toast shown by post */ });
    },
    cameraFov(fovDeg: number) {
      const id = st.getState().selected; if (!id) return;
      const v = Math.round(Math.max(FOV_MIN, Math.min(FOV_MAX, fovDeg)));
      const cur = st.getState().camera[id] ?? { mode: 'rgb' as CameraMode, fov_deg: 70 };
      st.getState().setCamera(id, { ...cur, fov_deg: v });
      fovTarget.current = v;
      postToCameraFrame({ type: 'argus-camera', drone_id: id, fov_deg: v });  // the picture zooms this frame; the Hub setting follows
      if (fovTimer.current === null) fovTimer.current = window.setTimeout(async () => {
        fovTimer.current = null; const t = fovTarget.current; if (t === null) return;
        try { await hub.postJson(`/drones/${id}/camera`, { fov_deg: t }); } catch { /* the live camera event stays authoritative */ }
      }, 50);
    },
  }), [post, toast, log, base, st]);
  const gimbalTimer = useRef<number | null>(null);
  const gimbalTarget = useRef<number | null>(null);
  const fovTimer = useRef<number | null>(null);
  const fovTarget = useRef<number | null>(null);

  const dispatchId = useCallback(async (id: string) => {
    st.getState().setDispatching(id); setCenter('mission');
    log('info', `Dispatching ${id} to the Triage Agent`);
    try { await post(`/detections/${id}/dispatch`, {}); } catch {
      st.getState().setDispatching(null);
      // the Hub may have restarted since this Detection was listed; resync so the Operator sees what it knows
      const before = st.getState().detections.length;
      await refreshDetections();
      if (st.getState().detections.length !== before) toast({ severity: 'warning', title: 'Detections refreshed', message: 'The Hub no longer knew that Detection. Run Detect again to create a new one.' });
    }
  }, [post, log, st, toast, refreshDetections]);

  /* ---- keyboard: 1-9 select, manual sticks, H release, R return home, ? help ---- */
  const keys = useRef(new Set<string>());
  const camKeys = useRef(new Set<string>());
  /** One camera step: 4° of tilt or 0.15x of zoom; held keys repeat it at 20 Hz (80°/s, 3x per second). */
  const camStep = useCallback((k: string) => {
    const g = st.getState(); const id = g.selected; if (!id) return;
    if (k === '[' || k === ']' || k === 'arrowup' || k === 'arrowdown') {
      const cur = g.gimbalPending ?? g.fleet[id]?.gimbal_pitch_deg ?? 8;
      act.gimbal(cur + (k === ']' || k === 'arrowdown' ? 4 : -4));
    } else {
      const fov = g.camera[id]?.fov_deg || 70;
      act.cameraFov(zoomToFov(fovToZoom(fov) + (k === 'arrowleft' ? -0.15 : 0.15)));
    }
  }, [act, st]);
  const pendingStates = useRef(new Map<string, HubDroneState>());
  const flushTimer = useRef<number | null>(null);
  const lastFrame = useRef(0);
  const lastOutcome = useRef('');
  /** True while the snapshot's trust_events replay: state fills in, but no view switches, toasts or auto-opened documents. */
  const replaying = useRef(false);
  const [frameTick, setFrameTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setFrameTick((n) => n + 1), 1000); return () => clearInterval(id); }, []);
  useEffect(() => {
    const push = () => {
      const k = keys.current;
      // full stick: W S along the nose, A D turn it, Q E descend and climb (scale in HubDataProvider, matched to the airframe)
      const input: ManualInput = {
        pitch: (k.has('w') ? 1 : 0) - (k.has('s') ? 1 : 0),
        roll: 0,
        throttle: (k.has('e') ? 1 : 0) - (k.has('q') ? 1 : 0),
        yaw: (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0),
      };
      hub.setManualInput(input);
    };
    const onDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const k = e.key.toLowerCase();
      if (/^[1-9]$/.test(k)) { const ids = Object.keys(st.getState().fleet).sort(); const id = ids[Number(k) - 1]; if (id) select(id); return; }
      if (k === '?') { setHelp((h) => !h); return; }
      if (k === 'escape') { setHelp(false); setDrawer(null); st.getState().openFindings(null); return; }
      if (k === 'h') { if (st.getState().manualActive) void act.manualRelease(); return; }
      if (k === 'r') { void act.returnHome(); return; }
      if (k === 'v') { const id = st.getState().selected; const cur = (id && st.getState().camera[id]?.mode) || 'rgb'; act.cameraMode(CAMERA_MODES[(CAMERA_MODES.indexOf(cur) + 1) % CAMERA_MODES.length]); return; }
      if (k === '-' || k === '=' || k === '+') { const id = st.getState().selected; const fov = (id && st.getState().camera[id]?.fov_deg) || 70; act.cameraFov(zoomToFov(fovToZoom(fov) + (k === '-' ? -0.5 : 0.5))); return; }
      // camera keys move continuously while held: one step now, then the 50 ms ticker below
      if (k === '[' || k === ']' || k === 'arrowup' || k === 'arrowdown' || k === 'arrowleft' || k === 'arrowright') {
        e.preventDefault();
        if (!e.repeat && !camKeys.current.has(k)) { camKeys.current.add(k); camStep(k); }
        return;
      }
      if (k === 'x') { if (st.getState().manualActive) { void act.abort(); void act.manualRelease(); } return; }
      // movement keys take Manual Control; the arrows never do
      if (['w', 'a', 's', 'd', 'q', 'e'].includes(k)) {
        e.preventDefault();
        keys.current.add(k);
        if (!st.getState().manualActive && st.getState().selected) void act.manualTake();
        push();
      }
    };
    const onUp = (e: KeyboardEvent) => { const k = e.key.toLowerCase(); if (camKeys.current.delete(k)) return; keys.current.delete(k); push(); };
    const camTicker = setInterval(() => { for (const k of camKeys.current) camStep(k); }, 50);
    window.addEventListener('keydown', onDown); window.addEventListener('keyup', onUp);
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp); clearInterval(camTicker); };
  }, [act, select, st, camStep]);

  /* ---- derived ---- */
  const logs = useArgus((s) => s.logs);
  const liveDet = useArgus(liveDetection);
  const findingsOpen = useArgus((s) => s.findingsOpen);
  const [recording, setRecording] = useState(false);
  const siteName = (site as { name?: string } | null)?.name ?? 'Meridian Station';
  const dismiss = useCallback((id: string, how: 'logged' | 'ignored') => {
    st.getState().dismissDetection(id, how);
    log(how === 'logged' ? 'info' : 'warning', `Operator ${how} Detection ${id}${how === 'logged' ? ' without flying' : ''}`);
  }, [st, log]);
  const hold = useCallback((id: string) => { void post(`/decisions/${id}/hold`, {}, `Held automatic dispatch ${id}`).catch(() => undefined); }, [post]);
  const release = useCallback((id: string) => { void post(`/decisions/${id}/release`, {}, `Released automatic dispatch ${id}`).catch(() => undefined); }, [post]);
  const setMode = useCallback((m: AutonomyMode) => { void post('/autonomy/mode', { mode: m }, `Autonomy mode: ${m}`).then(() => st.getState().setAutonomy(m, st.getState().autonomyPolicy)).catch(() => undefined); }, [post, st]);
  const detCard = useMemo(() => (liveDet ? <DetectionCard hubBase={base} onDispatch={(id) => void dispatchId(id)} onLog={dismiss} onHold={hold} onRelease={release} /> : null), [liveDet, base, dispatchId, dismiss, hold, release]);
  const detAnchor = useMemo(() => {
    if (!liveDet || liveDet.polygon.length === 0) return null;
    const n = liveDet.polygon.length;
    return { lat: liveDet.polygon.reduce((a, p) => a + p.lat, 0) / n, lon: liveDet.polygon.reduce((a, p) => a + p.lon, 0) / n, node: detCard };
  }, [liveDet, detCard]);

  return (
    <div className="argus-root a-shell">
      {/* The stage: one full-bleed surface per view. The Console iframe is the Renderer for video, evidence and overhead
          captures, so it stays mounted; off the World view it lives in an 8 px box (the Console scales its render to its container). */}
      <div className="a-stage">
        <div style={center === 'world'
          ? { position: 'absolute', inset: 0 }
          : { position: 'absolute', left: -100, top: -100, width: 8, height: 8, overflow: 'hidden', opacity: 0.01, pointerEvents: 'none' }}>
          <iframe ref={worldFrameRef} title="ARGUS World view" src={consoleUrl(settings.connection)} style={{ width: '100%', height: '100%', border: 0, display: 'block' }} allow="fullscreen" />
        </div>
        {center === 'flight' && <ArgusVideo hubBase={base} lastFrameTs={lastFrame.current + frameTick * 0} onGimbal={(p) => act.gimbal(p)} />}
        {center === 'mission' && <SiteMap hubBase={base} onSelect={select} bare anchor={detAnchor} />}
        {center !== 'flight' && <div className="a-shade" />}
      </div>

      <TopBar hub={hub} siteName={siteName} onHelp={() => setHelp((h) => !h)} onMode={setMode} />
      <ClampBanner />
      <Rail view={center} drawer={drawer} onView={setCenter} onDrawer={setDrawer} />

      {/* the newest Detection floats over the camera; on the Mission view it is anchored on its polygon */}
      {center !== 'mission' && detCard && <div style={{ position: 'absolute', left: 124, top: 84, zIndex: 12 }}>{detCard}</div>}
      <PlantSignals />

      {/* the trust story, in order: agent, then validator, then the report */}
      {center === 'mission' && !drawer && (
        <div className="a-glasswrap a-trust">
          <DecisionTrail />
          <ValidatorPanel />
          <ReportPanel onResolve={(r) => { st.getState().resolveIncident(r); log(r === 'escalated' ? 'critical' : 'info', `Operator ${r} the Incident Report`); }} />
        </div>
      )}

      <BottomStrip onSelect={select} onCameraMode={(m) => act.cameraMode(m)} />

      {drawer === 'ops' && (
        <Drawer title="Operations" icon={<SlidersHorizontal size={13} />} onClose={() => setDrawer(null)}>
          <OpsPanel act={act} />
          <div className="a-glasswrap" style={{ display: 'flex', flexDirection: 'column', flex: '0 0 40%', minHeight: 0, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
            <DetectionsPanel hubBase={base} onDispatch={(id) => void dispatchId(id)} />
          </div>
        </Drawer>
      )}
      {drawer === 'fleet' && (
        <Drawer title="Fleet and telemetry" icon={<Radar size={13} />} onClose={() => setDrawer(null)}>
          <FleetPanel onSelect={select} />
          <div className="a-glasswrap" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, padding: 8, overflow: 'auto' }}><ArgusTelemetry /></div>
        </Drawer>
      )}
      {drawer === 'log' && (
        <Drawer title="Event log" icon={<ScrollText size={13} />} onClose={() => setDrawer(null)}>
          <LogConsole logs={logs} recording={recording} onToggleRecord={() => setRecording((r) => !r)} />
        </Drawer>
      )}
      {drawer === 'reports' && (
        <Drawer title="Findings" icon={<FileText size={13} />} onClose={() => setDrawer(null)}>
          <ReportsList onOpen={(id) => { st.getState().openFindings(id); setDrawer(null); }} />
        </Drawer>
      )}
      {drawer === 'safety' && (
        <Drawer title="Safety" icon={<ShieldCheck size={13} />} onClose={() => setDrawer(null)}>
          <ValidatorPanel />
          <div style={{ padding: '10px 14px 14px', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span className="a-label">Enforced three times</span>
            <div className="a-body"><b style={{ color: 'var(--text-primary)' }}>At dispatch.</b> The Safety Validator checks every FlightPlan against the geofence, no-fly zones, ceiling and battery range. Rejections name the rule and go back to the agent.</div>
            <div className="a-body"><b style={{ color: 'var(--text-primary)' }}>Under manual control.</b> The same rules clamp every velocity command at the boundary and the clamp is reported with its rule.</div>
            <div className="a-body"><b style={{ color: 'var(--text-primary)' }}>Onboard.</b> ArduPilot's own geofence and failsafes are set from the same Site geometry. The agent cannot reach them.</div>
          </div>
        </Drawer>
      )}

      {findingsOpen && (
        <Findings missionId={findingsOpen} hubBase={base} onClose={() => st.getState().openFindings(null)}
          onResolve={(r) => { st.getState().resolveIncident(r); log(r === 'escalated' ? 'critical' : 'info', `Operator ${r} the Incident Report`); }} />
      )}

      {/* toasts */}
      <div style={{ position: 'fixed', top: 48, right: 12, display: 'flex', flexDirection: 'column', gap: 6, zIndex: 1200 }}>
        {toasts.map((t) => <Toast key={t.id} severity={t.severity} title={t.title} message={t.message} onDismiss={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))} />)}
      </div>

      {help && (
        <div onClick={() => setHelp(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(4,6,9,0.6)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(3px)' }}>
          <div className="a-in" onClick={(e) => e.stopPropagation()} style={{ background: 'var(--surface-panel)', border: '1px solid var(--border-default)', borderRadius: 10, padding: '14px 16px 16px', width: 400, boxShadow: 'var(--shadow-modal)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}><Keyboard size={14} style={{ color: 'var(--text-secondary)' }} /><span className="a-title">Keyboard</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', alignItems: 'center' }}>
              {([['1 2 3', 'Select a Drone'], ['R', 'Return the selected Drone to its pad'], ['W S', 'Forward · back along the nose (takes Manual Control)'], ['A D', 'Turn left · right'], ['Q E', 'Down · up'], ['▲ ▼', 'Camera tilt up · down; hold to sweep (also [ ])'], ['◄ ►', 'Zoom out · in; hold to sweep (also - =)'], ['V', 'Sensor: RGB · Thermal · LiDAR'], ['H', 'Release Manual Control; a paused Mission resumes'], ['X', 'Release and abort the Mission'], ['?  Esc', 'This help · close']] as const).map(([k, v]) => (
                <React.Fragment key={k}><span className="a-key" style={{ height: 18, fontSize: 10, padding: '0 6px', justifySelf: 'start' }}>{k}</span><span className="a-body">{v}</span></React.Fragment>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
