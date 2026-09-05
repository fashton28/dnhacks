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
import type { Anomaly, ManualInput, MissionPlan, PlanTool, StatusText } from '@/contract';
import { dataSource, consoleUrl } from '@/dataSource';
import { HubDataProvider } from '@/dataSource/HubDataProvider';
import type { HubDetection, HubDroneState, HubMission, AgentPlan } from '@/dataSource/HubDataProvider';
import { useSettings } from '@/store';
import { getSiteModel } from '@/site';
import type { SiteModel } from '@/site';
import { Tabs, Badge, Toast } from '@/components';
import { LogConsole } from '@/panels';
import { SiteMap } from './panels/SiteMap';
import { ArgusVideo } from './panels/ArgusVideo';
import { useArgus, activeMission, CAMERA_MODES, FOV_MAX, FOV_MIN, fovToZoom, zoomToFov, type CameraMode, type CameraView, type SceneProp } from './store';
import { FleetPanel } from './panels/FleetPanel';
import { OpsPanel, type OpsActions } from './panels/OpsPanel';
import { DetectionsPanel, SpecPanel, ValidatorPanel, ReportPanel } from './panels/MissionPanel';
import { ArgusTelemetry } from './panels/ArgusTelemetry';
import { ArgusStatusBar } from './panels/ArgusStatusBar';
import { ClampBanner } from './panels/ClampBanner';
import { GIMBAL_MAX, GIMBAL_MIN } from './panels/OpsPanel';
import { useArgusDocument } from './Brand';
import { Video, Crosshair, Globe, Keyboard } from 'lucide-react';
import './argus.css';

type CenterView = 'flight' | 'mission' | 'world';
interface ToastItem { id: number; severity: 'info' | 'success' | 'warning' | 'error' | 'critical'; title: string; message?: string }

const hub = dataSource as unknown as HubDataProvider;

function detectionToAnomaly(d: HubDetection, base: string): Anomaly {
  const n = d.polygon.length || 1;
  return {
    id: d.id, type: d.change_type, confidence: d.confidence, source: 'sentinel2',
    lat: d.polygon.reduce((a, p) => a + p.lat, 0) / n, lon: d.polygon.reduce((a, p) => a + p.lon, 0) / n,
    thumbnail: `${base}/evidence/${d.after_ref}`,
  };
}
function agentPlanToRoute(mission_id: string, plan: AgentPlan): MissionPlan {
  const tools: PlanTool[] = [];
  for (const w of plan.waypoints ?? []) {
    tools.push({ tool: 'goto_gps', lat: w.lat, lon: w.lon, alt: w.alt_m, alt_m: w.alt_m, profile: 'inspect' });
    if (w.action === 'hover') tools.push({ tool: 'hold', durationS: w.duration_s ?? 10, duration_s: w.duration_s ?? 10 });
  }
  tools.push({ tool: 'rtl' });
  return { requestId: mission_id, anomalyId: plan.anomaly_id, tools, profile: 'inspect', rationale: plan.reasoning ?? '' };
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

  /* ---- Hub streams -> store ---- */
  useEffect(() => {
    hub.connect(settings.connection).catch(() => st.getState().setConn('error'));
    const s = st.getState();
    const offs = [
      hub.onConnectionChange((c) => st.getState().setConn(c)),
      hub.onTelemetry((t) => { if (t.vehicleId === (st.getState().selected ?? hub.getVehicle())) st.getState().setTel(t); }),
      hub.onStatusText((x) => st.getState().addLog(x)),
      hub.onAck((a) => { if (!a.success) toast({ severity: 'error', title: `${a.command} failed`, message: a.message }); }),
      hub.onRawEvent((ev) => {
        const g = st.getState();
        switch (ev.type) {
          case 'snapshot': {
            const drones = (ev.drones as HubDroneState[]) ?? [];
            g.setFleet(drones);
            for (const m of (ev.missions as HubMission[]) ?? []) g.setMission(m);
            const sel = g.selected && drones.some((d) => d.drone_id === g.selected) ? g.selected : drones.sort((a, b) => a.drone_id.localeCompare(b.drone_id))[0]?.drone_id;
            if (sel) { hub.setVehicle(sel); g.select(sel); void loadCamera(sel); }
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
          case 'mission': g.setMission(ev.mission as HubMission); break;
          case 'detection': g.addDetection((ev.detection ?? ev) as HubDetection); break;
          case 'mission_spec': {
            const spec = ev.spec as { objective: string; rationale: string; max_altitude_m: number; standoff_m: number; attempt?: number };
            g.setMissionSpec({ ...spec, attempt: spec.attempt ?? 1, mission_id: String(ev.mission_id) });
            setCenter('mission');
            break;
          }
          case 'validation': {
            // two producers: the agent adapter wraps the result in `result`; the Hub's Safety Validator publishes it flat
            const r = (ev.result ?? ev) as { verdict: 'accept' | 'reject'; violations?: { rule: string; detail: string; severity: string }[]; attempt?: number; abandoned?: boolean; checks_passed?: number };
            g.setValidation({ ...r, violations: r.violations ?? [], mission_id: String(ev.mission_id) });
            break;
          }
          case 'triage': g.setTriage({ decision: String(ev.decision), confidence: Number(ev.confidence), rationale: String(ev.rationale ?? ''), mission_id: String(ev.mission_id) }); break;
          case 'incident': g.setIncident({ title: String(ev.title), severity: String(ev.severity), body_markdown: String(ev.body_markdown), recommended_action: String(ev.recommended_action), mission_id: String(ev.mission_id), ts: Date.now() }); break;
          case 'autonomy': {
            const e = ev.event as { type: string; mission_id: string | null; payload: Record<string, unknown> };
            if (e.type === 'plan_proposed') g.setAgentPlan({ mission_id: e.mission_id ?? '', attempt: Number(e.payload.attempt ?? 1), plan: e.payload.plan as AgentPlan });
            break;
          }
          case 'clamp': g.setClamp({ rule: String(ev.rule), ts: Date.now() }); break;
          case 'manual': if (String(ev.drone_id) === g.selected) g.setManualActive(Boolean(ev.active)); break;
          case 'dispatch_outcome': {
            g.setDispatching(null);
            const key = `${String(ev.detection_id)}:${String(ev.mission_id)}`;
            if (lastOutcome.current === key) break;  // StrictMode/dev double-subscription guard
            lastOutcome.current = key;
            toast({ severity: ev.flown ? 'success' : 'warning', title: ev.flown ? `Flown by ${String(ev.drone_id)}` : 'Not flown', message: `${String(ev.detection_id)} · ${String(ev.attempts)} attempt(s)` });
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
    hub.getJson('/detections').then((r) => { if (r.ok && Array.isArray(r.json)) for (const d of r.json as HubDetection[]) st.getState().addDetection(d); });
    hub.getJson('/missions').then((r) => { if (r.ok && Array.isArray(r.json)) for (const m of r.json as HubMission[]) st.getState().setMission(m); });
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
      if (gimbalTimer.current === null) {
        gimbalTimer.current = window.setTimeout(async () => {
          gimbalTimer.current = null;
          const target = gimbalTarget.current;
          if (target === null) return;
          try { await hub.postJson(`/drones/${id}/command`, { type: 'look_at', pitch_deg: target }); }
          catch { /* the Hub logs refusals; telemetry stays authoritative */ }
          // telemetry takes over once it catches up; clear the optimistic value after a grace period either way
          window.setTimeout(() => { if (gimbalTarget.current === target) { st.getState().setGimbalPending(null); gimbalTarget.current = null; } }, 1200);
        }, 100);
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
      if (fovTimer.current === null) fovTimer.current = window.setTimeout(async () => {
        fovTimer.current = null; const t = fovTarget.current; if (t === null) return;
        try { await hub.postJson(`/drones/${id}/camera`, { fov_deg: t }); } catch { /* the live camera event stays authoritative */ }
      }, 100);
    },
  }), [post, toast, log, base, st]);
  const gimbalTimer = useRef<number | null>(null);
  const gimbalTarget = useRef<number | null>(null);
  const fovTimer = useRef<number | null>(null);
  const fovTarget = useRef<number | null>(null);

  const dispatchId = useCallback(async (id: string) => {
    st.getState().setDispatching(id); setCenter('mission');
    log('info', `Dispatching ${id} to the Triage Agent`);
    try { await post(`/detections/${id}/dispatch`, {}); } catch { st.getState().setDispatching(null); }
  }, [post, log, st]);

  /* ---- keyboard: 1-9 select, manual sticks, H release, R return home, ? help ---- */
  const keys = useRef(new Set<string>());
  const pendingStates = useRef(new Map<string, HubDroneState>());
  const flushTimer = useRef<number | null>(null);
  const lastFrame = useRef(0);
  const lastOutcome = useRef('');
  const [frameTick, setFrameTick] = useState(0);
  useEffect(() => { const id = setInterval(() => setFrameTick((n) => n + 1), 1000); return () => clearInterval(id); }, []);
  useEffect(() => {
    const push = () => {
      const k = keys.current;
      const input: ManualInput = {
        pitch: (k.has('w') ? 1 : 0) - (k.has('s') ? 1 : 0),
        roll: (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0),
        throttle: (k.has('e') ? 1 : 0) - (k.has('q') ? 1 : 0),
        yaw: (k.has('arrowright') ? 1 : 0) - (k.has('arrowleft') ? 1 : 0),
      };
      hub.setManualInput(input);
    };
    const onDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const k = e.key.toLowerCase();
      if (/^[1-9]$/.test(k)) { const ids = Object.keys(st.getState().fleet).sort(); const id = ids[Number(k) - 1]; if (id) select(id); return; }
      if (k === '?') { setHelp((h) => !h); return; }
      if (k === 'escape') { setHelp(false); return; }
      if (k === 'h') { if (st.getState().manualActive) void act.manualRelease(); return; }
      if (k === 'r') { void act.returnHome(); return; }
      if (k === 'v') { const id = st.getState().selected; const cur = (id && st.getState().camera[id]?.mode) || 'rgb'; act.cameraMode(CAMERA_MODES[(CAMERA_MODES.indexOf(cur) + 1) % CAMERA_MODES.length]); return; }
      if (k === '-' || k === '=' || k === '+') { const id = st.getState().selected; const fov = (id && st.getState().camera[id]?.fov_deg) || 70; act.cameraFov(zoomToFov(fovToZoom(fov) + (k === '-' ? -0.5 : 0.5))); return; }
      if (k === '[' || k === ']') { const cur = st.getState().gimbalPending ?? (st.getState().selected ? st.getState().fleet[st.getState().selected!]?.gimbal_pitch_deg : undefined) ?? 45; act.gimbal(cur + (k === ']' ? 5 : -5)); return; }
      if (['w', 'a', 's', 'd', 'q', 'e', 'arrowleft', 'arrowright'].includes(k)) {
        e.preventDefault();
        keys.current.add(k);
        if (!st.getState().manualActive && st.getState().selected) void act.manualTake();
        push();
      }
    };
    const onUp = (e: KeyboardEvent) => { keys.current.delete(e.key.toLowerCase()); push(); };
    window.addEventListener('keydown', onDown); window.addEventListener('keyup', onUp);
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp); };
  }, [act, select, st]);

  /* ---- derived for legacy panels (selectors keep re-renders scoped) ---- */
  const tel = useArgus((s) => s.tel);
  const trail = useArgus((s) => s.trail);
  const logs = useArgus((s) => s.logs);
  const detections = useArgus((s) => s.detections);
  const agentPlan = useArgus((s) => s.agentPlan);
  const selected = useArgus((s) => s.selected);
  const mission = useArgus((s) => activeMission(s, s.selected));
  const anomalies = useMemo(() => detections.map((d) => detectionToAnomaly(d, base)), [detections, base]);
  const route = useMemo(() => (agentPlan ? agentPlanToRoute(agentPlan.mission_id, agentPlan.plan) : null), [agentPlan]);
  const [recording, setRecording] = useState(false);
  const hubLabel = base.replace(/^https?:\/\//, '');

  return (
    <div className="argus-root" style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--bg-app)', overflow: 'hidden', position: 'relative' }}>
      <ArgusStatusBar hubLabel={hubLabel} onHelp={() => setHelp((h) => !h)} />
      <ClampBanner />
      <div className="argus-grid" style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: '250px 1fr 262px', gridTemplateRows: 'minmax(0, 1fr)', gap: 8, padding: 8 }}>
        {/* LEFT */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
          <FleetPanel onSelect={select} />
          <OpsPanel act={act} />
        </div>

        {/* CENTER */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 'none' }}>
            <Tabs size="sm" value={center} onChange={(id) => setCenter(id as CenterView)} items={[{ id: 'flight', label: 'Flight', icon: <Video size={13} /> }, { id: 'mission', label: 'Mission', icon: <Crosshair size={13} /> }, { id: 'world', label: 'World', icon: <Globe size={13} /> }]} />
            {detections.length > 0 && <Badge tone="caution" mono>{detections.length} DETECTION{detections.length === 1 ? '' : 'S'}</Badge>}
            {mission && <Badge tone="accent" mono>MISSION {mission.phase.toUpperCase()} · WP {mission.next_waypoint}</Badge>}
          </div>
          {/* The Console iframe is the Renderer for video, evidence and overhead captures, so it stays mounted;
              off the World tab it lives in an 8 px box (the Console scales its render to its container). */}
          <div style={center === 'world'
            ? { flex: 1, minHeight: 0, borderRadius: 'var(--radius-lg)', overflow: 'hidden', border: '1px solid var(--border-default)', background: '#000' }
            : { position: 'absolute', left: -100, top: -100, width: 8, height: 8, overflow: 'hidden', opacity: 0.01, pointerEvents: 'none' }}>
            <iframe ref={worldFrameRef} title="ARGUS World view" src={consoleUrl(settings.connection)} style={{ width: '100%', height: '100%', border: 0, display: 'block' }} allow="fullscreen" />
          </div>
          {center === 'world' ? null : center === 'flight' ? (
            <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateRows: 'minmax(0, 1.45fr) minmax(0, 1fr)', gap: 8 }}>
              <div style={{ borderRadius: 'var(--radius-lg)', overflow: 'hidden', border: '1px solid var(--border-default)', minHeight: 0 }}>
                <ArgusVideo hubBase={base} lastFrameTs={lastFrame.current + frameTick * 0} onGimbal={(p) => act.gimbal(p)} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1fr)', gap: 8, minHeight: 0 }}>
                <SiteMap hubBase={base} onSelect={select} compact />
                <LogConsole logs={logs} recording={recording} onToggleRecord={() => setRecording((r) => !r)} />
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateRows: 'minmax(0, 1.15fr) minmax(0, 1fr)', gap: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 1fr)', gap: 8, minHeight: 0 }}>
                <SiteMap hubBase={base} onSelect={select} />
                <DetectionsPanel hubBase={base} onDispatch={(id) => void dispatchId(id)} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 1fr)', gap: 8, minHeight: 0 }}>
                <SpecPanel />
                <ValidatorPanel />
                <ReportPanel onResolve={(r) => { st.getState().resolveIncident(r); log(r === 'escalated' ? 'critical' : 'info', `Operator ${r} the Incident Report`); }} />
              </div>
            </div>
          )}
        </div>

        {/* RIGHT */}
        <ArgusTelemetry />
      </div>

      {/* toasts */}
      <div style={{ position: 'fixed', top: 48, right: 12, display: 'flex', flexDirection: 'column', gap: 6, zIndex: 1200 }}>
        {toasts.map((t) => <Toast key={t.id} severity={t.severity} title={t.title} message={t.message} onDismiss={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))} />)}
      </div>

      {help && (
        <div onClick={() => setHelp(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(4,6,9,0.6)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(3px)' }}>
          <div className="a-in" onClick={(e) => e.stopPropagation()} style={{ background: 'var(--surface-panel)', border: '1px solid var(--border-default)', borderRadius: 10, padding: '14px 16px 16px', width: 400, boxShadow: 'var(--shadow-modal)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}><Keyboard size={14} style={{ color: 'var(--text-secondary)' }} /><span className="a-title">Keyboard</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', alignItems: 'center' }}>
              {([['1 2 3', 'Select a Drone'], ['R', 'Return the selected Drone to its pad'], ['W S · A D', 'Forward and back · strafe (takes Manual Control)'], ['Q E', 'Down · up'], ['◄ ►', 'Yaw'], ['[ ]', 'Camera up · down, 5° steps'], ['V', 'Sensor: RGB · Thermal · LiDAR'], ['- =', 'Zoom out · in'], ['H', 'Release Manual Control; a paused Mission resumes'], ['?  Esc', 'This help · close']] as const).map(([k, v]) => (
                <React.Fragment key={k}><span className="a-key" style={{ height: 18, fontSize: 10, padding: '0 6px', justifySelf: 'start' }}>{k}</span><span className="a-body">{v}</span></React.Fragment>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
