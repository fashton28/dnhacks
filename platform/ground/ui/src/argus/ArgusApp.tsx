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
import { LogConsole, MissionMap } from '@/panels';
import { ArgusVideo } from './panels/ArgusVideo';
import { useArgus, selectedDrone, activeMission } from './store';
import { FleetPanel } from './panels/FleetPanel';
import { OpsPanel, type OpsActions } from './panels/OpsPanel';
import { DetectionsPanel, SpecPanel, ValidatorPanel, ReportPanel } from './panels/MissionPanel';
import { ArgusTelemetry } from './panels/ArgusTelemetry';
import { ArgusStatusBar } from './panels/ArgusStatusBar';
import { ClampBanner } from './panels/ClampBanner';

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
            if (sel) { hub.setVehicle(sel); g.select(sel); }
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
            const r = ev.result as { verdict: 'accept' | 'reject'; violations: { rule: string; detail: string; severity: string }[]; attempt?: number; abandoned?: boolean; checks_passed?: number };
            g.setValidation({ ...r, mission_id: String(ev.mission_id) });
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
          case 'scene': g.setOpenFences(((ev.state as { open_fences?: string[] })?.open_fences) ?? []); break;
          case 'frame': if (String(ev.drone_id) === (g.selected ?? '')) lastFrame.current = Date.now(); break;
          default: break;
        }
      }),
    ];
    void s.setConn('connecting');
    hub.getJson('/detections').then((r) => { if (r.ok && Array.isArray(r.json)) for (const d of r.json as HubDetection[]) st.getState().addDetection(d); });
    hub.getJson('/missions').then((r) => { if (r.ok && Array.isArray(r.json)) for (const m of r.json as HubMission[]) st.getState().setMission(m); });
    const sampler = setInterval(() => st.getState().sampleHistory(), 1000);
    return () => { offs.forEach((f) => f()); clearInterval(sampler); hub.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.connection.host, settings.connection.controlPort]);

  /* ---- selection ---- */
  const select = useCallback((id: string) => { hub.setVehicle(id); st.getState().select(id); st.getState().setManualActive(false); }, [st]);

  /* ---- actions ---- */
  const post = useCallback(async (path: string, body: unknown, okMsg?: string): Promise<any> => {
    const r = await hub.postJson(path, body);
    if (!r.ok) { toast({ severity: 'error', title: 'Hub refused', message: r.text.slice(0, 160) }); log('error', `${path}: ${r.text.slice(0, 160)}`); throw new Error(r.text); }
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
  }), [post, toast, log, base, st]);

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
            <Tabs size="sm" value={center} onChange={(id) => setCenter(id as CenterView)} items={[{ id: 'flight', label: 'Flight ops' }, { id: 'mission', label: 'Mission' }, { id: 'world', label: 'World view' }]} />
            {detections.length > 0 && <Badge tone="caution" mono>{detections.length} DETECTION{detections.length === 1 ? '' : 'S'}</Badge>}
            {mission && <Badge tone="accent" mono>MISSION {mission.phase.toUpperCase()} · WP {mission.next_waypoint}</Badge>}
          </div>
          {/* The Console iframe is the Renderer for video, evidence and overhead captures, so it stays mounted;
              off the World tab it lives in an 8 px box (the Console scales its render to its container). */}
          <div style={center === 'world'
            ? { flex: 1, minHeight: 0, borderRadius: 'var(--radius-lg)', overflow: 'hidden', border: '1px solid var(--border-default)', background: '#000' }
            : { position: 'absolute', left: -100, top: -100, width: 8, height: 8, overflow: 'hidden', opacity: 0.01, pointerEvents: 'none' }}>
            <iframe title="ARGUS World view" src={consoleUrl(settings.connection)} style={{ width: '100%', height: '100%', border: 0, display: 'block' }} allow="fullscreen" />
          </div>
          {center === 'world' ? null : center === 'flight' ? (
            <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateRows: 'minmax(0, 1.45fr) minmax(0, 1fr)', gap: 8 }}>
              <div style={{ borderRadius: 'var(--radius-lg)', overflow: 'hidden', border: '1px solid var(--border-default)', minHeight: 0 }}>
                <ArgusVideo hubBase={base} lastFrameTs={lastFrame.current + frameTick * 0} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 1fr)', gap: 8, minHeight: 0 }}>
                <MissionMap site={site} tel={tel} trail={trail} anomalies={anomalies} plan={route} executing={!!mission} />
                <LogConsole logs={logs} recording={recording} onToggleRecord={() => setRecording((r) => !r)} />
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateRows: 'minmax(0, 1.15fr) minmax(0, 1fr)', gap: 8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.15fr) minmax(0, 1fr)', gap: 8, minHeight: 0 }}>
                <MissionMap site={site} tel={tel} trail={trail} anomalies={anomalies} plan={route} executing={!!mission} />
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
        <div onClick={() => setHelp(false)} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--surface-panel)', border: '1px solid var(--border-default)', borderRadius: 10, padding: 16, width: 380, fontSize: 12.5, lineHeight: 1.7 }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Keyboard</div>
            <div><b>1 2 3</b> select Drone · <b>R</b> return home</div>
            <div><b>W/S</b> forward/back · <b>A/D</b> strafe · <b>Q/E</b> down/up · <b>◄ ►</b> yaw (takes Manual Control)</div>
            <div><b>H</b> release Manual Control (paused Mission resumes) · <b>?</b> this help · <b>Esc</b> close</div>
          </div>
        </div>
      )}
    </div>
  );
}
