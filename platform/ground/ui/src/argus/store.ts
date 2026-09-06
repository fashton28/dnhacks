/* ============================================================================
 * ARGUS operator console state (zustand).
 * ----------------------------------------------------------------------------
 * Fed by HubDataProvider (telemetry / status / fleet / raw Hub events). Every
 * panel subscribes with a selector so a 10 Hz telemetry tick re-renders only
 * the components that read the changed value. Writes that arrive faster than
 * 10 Hz are coalesced by the provider (fleet) or by the loop tick (telemetry).
 * ========================================================================== */
import { create } from 'zustand';
import type { ConnectionState, StatusText, Telemetry } from '@/contract';
import type { HubDetection, HubDroneState, HubMission, HubIncidentReport, AgentPlan } from '@/dataSource/HubDataProvider';

export interface MissionSpecView { objective: string; rationale: string; max_altitude_m: number; standoff_m: number; attempt: number; mission_id: string }
export interface ValidationView { verdict: 'accept' | 'reject'; violations: { rule: string; detail: string; severity: string }[]; attempt?: number; abandoned?: boolean; checks_passed?: number; mission_id: string }
export interface TriageView { decision: string; confidence: number; rationale: string; mission_id: string }
export interface IncidentView { title: string; severity: string; body_markdown: string; recommended_action: string; mission_id: string; ts: number; resolution?: 'escalated' | 'dismissed' }
export interface OverheadView { ref: string; ts: string }
export interface ClampView { rule: string; ts: number }
export interface AgentPlanView { mission_id: string; attempt: number; plan: AgentPlan }
/** Pre-dispatch triage: the agent's decision, with the Site Zone it reasoned from, before any plan is requested. */
export interface PretriageView { detection_id: string; zone: string | null; action: 'dispatch' | 'log_only' | 'ignore'; rationale: string }
/** One tool call the agent made while on station (look_at, set_camera, capture, reposition, done). */
export interface AgentActionView { ts: number; mission_id: string | null; tool: string; args: Record<string, unknown>; result: string; ok: boolean }
/** The envelope the agent declared and the Safety Validator checked: the agent flies only inside it. */
export interface EnvelopeView { mission_id: string; attempt: number; verdict: 'accept' | 'reject'; center: { lat: number; lon: number }; radius_m: number; ceiling_m: number; standoff_m: number; time_budget_s: number; objective: string; rationale: string; polygon: { lat: number; lon: number }[] }
export interface InspectionView { mission_id: string; waypoint_index: number; summary: string; threat_assessment: string; actions: number }
/** One plain-language line of the agent's decision trail: what happened, in the order it happened, for the Operator. */
export interface DecisionEntry { ts: number; kind: 'detection' | 'triage' | 'drone' | 'envelope' | 'validation' | 'repair' | 'action' | 'note' | 'stop' | 'inspection' | 'verdict' | 'report' | 'outcome' | 'clamp'; text: string; tone: 'info' | 'good' | 'warn' | 'bad'; mission_id: string | null; detail?: string }
/** Why this Drone flew: the Hub's pick with the alternatives it passed over. */
export interface DroneChoiceView { mission_id: string | null; drone_id: string; reason: string; candidates: { drone_id: string; status: string; battery_pct: number; eligible: boolean; reason: string }[]; source: 'hub' | 'derived' }
/** One thing the vision model saw in a frame: a box in frame pixels, a label, and for thermal frames a temperature. */
export interface Sighting { id: string; label: string; confidence: number; bbox: [number, number, number, number]; camera_mode?: string; lat?: number; lon?: number; range_m?: number; temp_max_c?: number; frame_ref?: string }
export interface SightingsView { ts: number; drone_id: string; mission_id: string | null; frame_ref: string | null; width: number; height: number; sightings: Sighting[] }
/** A reading from the plant's own instrumentation, alongside what the Drones see. */
export interface PlantSignal { id: string; ts: number; sensor_id: string; kind: string; value: number | string; unit: string; threshold: number | string | null; asset: { name: string; lat?: number; lon?: number }; severity: 'info' | 'warning' | 'alarm'; note: string }
/** A dispatch the system will make by itself unless the Operator holds it within the veto window. */
export interface DecisionView { id: string; detection_id: string; action: 'dispatch' | 'held' | 'released'; rationale: string; deadline_ts: number | null; mode: string; ts: number }
export type AutonomyMode = 'manual' | 'supervised' | 'autonomous';
export interface SceneProp { id: string; kind: string; x: number; y: number; yaw_deg: number; z?: number }
export type CameraMode = 'rgb' | 'thermal' | 'lidar';
export interface CameraView { mode: CameraMode; fov_deg: number }
export const CAMERA_MODES: CameraMode[] = ['rgb', 'thermal', 'lidar'];
export const FOV_MIN = 20;   // narrowest field of view (5.5x zoom)
export const FOV_MAX = 110;  // widest (1x)
export const fovToZoom = (fov: number): number => FOV_MAX / Math.max(FOV_MIN, Math.min(FOV_MAX, fov));
export const zoomToFov = (zoom: number): number => Math.round(FOV_MAX / Math.max(1, Math.min(FOV_MAX / FOV_MIN, zoom)));

const SELECTION_KEY = 'argus.gcs.selected';

export interface ArgusState {
  conn: ConnectionState;
  fleet: Record<string, HubDroneState>;
  selected: string | null;
  tel: Telemetry | null;
  history: { alt: number[]; bat: number[] };
  trail: { lat: number; lon: number }[];
  logs: StatusText[];
  detections: HubDetection[];
  missions: Record<string, HubMission>;
  missionSpec: MissionSpecView | null;
  validation: ValidationView | null;
  triage: TriageView | null;
  incident: IncidentView | null;
  agentPlan: AgentPlanView | null;
  pretriage: PretriageView | null;
  agentActions: AgentActionView[];
  inspection: InspectionView | null;
  envelope: EnvelopeView | null;
  /** Points the agent has actually flown to this Mission (from fly_to results), drawn as the route. */
  flownRoute: { lat: number; lon: number; alt_m: number }[];
  hardStop: string | null;
  overheads: OverheadView[];
  baselineRef: string | null;
  clamp: ClampView | null;
  manualActive: boolean;
  dispatching: string | null;
  sceneOpenFences: string[];
  sceneProps: SceneProp[];
  /** Per-Drone Renderer camera settings (vision mode, field of view), brokered by the Hub. */
  camera: Record<string, CameraView>;
  /** Optimistic gimbal pitch while a command is in flight; null when telemetry is authoritative. */
  gimbalPending: number | null;
  /** Detections the Operator chose not to fly: logged for the record, or ignored. */
  dismissed: Record<string, 'logged' | 'ignored'>;
  /** Detections the system has already taken up: triaged, being dispatched, or reported. */
  handled: Record<string, true>;
  /** The current dispatch, narrated: every decision the autonomy stack made, in order. Reset by a new pretriage. */
  decisions: DecisionEntry[];
  /** Every Safety Validator verdict of the current dispatch, oldest first (the latest is `validation`). */
  validations: ValidationView[];
  droneChoice: DroneChoiceView | null;
  /** Stored findings by Mission id (GET /incidents plus live incident_report events). */
  reports: Record<string, HubIncidentReport>;
  /** Mission id of the Findings document open over the stage, or null. */
  findingsOpen: string | null;
  /** The autopilot's stage of the manual session (arming, taking off, live); null when no session. */
  manualPhase: string | null;
  /** The latest vision result for the selected Drone, drawn over the camera for a few seconds. */
  sightings: SightingsView | null;
  /** Every vision result of the current dispatch by frame ref, for the findings document. */
  sightingsByFrame: Record<string, Sighting[]>;
  /** Latest reading per plant sensor, newest first. */
  plantSignals: PlantSignal[];
  /** Pending and recent automatic dispatch decisions by id. */
  pendingDecisions: Record<string, DecisionView>;
  autonomyMode: AutonomyMode | null;
  autonomyPolicy: string | null;

  setConn(c: ConnectionState): void;
  setFleet(states: HubDroneState[]): void;
  select(id: string): void;
  setTel(t: Telemetry): void;
  sampleHistory(): void;
  addLog(s: StatusText): void;
  addDetection(d: HubDetection): void;
  /** Replace the list with what the Hub currently knows (after a reconnect or a refused dispatch). */
  setDetections(ds: HubDetection[]): void;
  setMission(m: HubMission): void;
  setMissionSpec(v: MissionSpecView): void;
  setValidation(v: ValidationView): void;
  setTriage(v: TriageView): void;
  setIncident(v: IncidentView): void;
  resolveIncident(r: 'escalated' | 'dismissed'): void;
  setAgentPlan(v: AgentPlanView): void;
  setPretriage(v: PretriageView): void;
  addAgentAction(a: AgentActionView): void;
  setInspection(v: InspectionView): void;
  setEnvelope(v: EnvelopeView): void;
  addFlown(p: { lat: number; lon: number; alt_m: number }): void;
  setHardStop(reason: string | null): void;
  setOverheads(o: OverheadView[]): void;
  setBaseline(ref: string | null): void;
  setClamp(c: ClampView | null): void;
  setManualActive(b: boolean): void;
  setDispatching(id: string | null): void;
  setOpenFences(ids: string[]): void;
  setSceneProps(props: SceneProp[]): void;
  setCamera(droneId: string, c: CameraView): void;
  setGimbalPending(v: number | null): void;
  dismissDetection(id: string, how: 'logged' | 'ignored'): void;
  markHandled(id: string): void;
  addDecision(d: Omit<DecisionEntry, 'ts'> & { ts?: number }): void;
  setDroneChoice(c: DroneChoiceView | null): void;
  setReport(r: HubIncidentReport): void;
  setReports(rs: HubIncidentReport[]): void;
  openFindings(missionId: string | null): void;
  setManualPhase(p: string | null): void;
  setSightings(v: SightingsView | null): void;
  addPlantSignal(p: PlantSignal): void;
  /** A Site reset: instrumentation returns to normal and pending automatic decisions are void. */
  clearSignals(): void;
  setDecision(d: DecisionView): void;
  setAutonomy(mode: AutonomyMode | null, policy: string | null): void;
}

export const useArgus = create<ArgusState>((set, get) => ({
  conn: 'connecting',
  fleet: {},
  selected: typeof localStorage !== 'undefined' ? localStorage.getItem(SELECTION_KEY) : null,
  tel: null,
  history: { alt: [], bat: [] },
  trail: [],
  logs: [],
  detections: [],
  missions: {},
  missionSpec: null,
  validation: null,
  triage: null,
  incident: null,
  agentPlan: null,
  pretriage: null,
  agentActions: [],
  inspection: null,
  envelope: null,
  flownRoute: [],
  hardStop: null,
  overheads: [],
  baselineRef: null,
  clamp: null,
  manualActive: false,
  dispatching: null,
  sceneOpenFences: [],
  sceneProps: [],
  camera: {},
  gimbalPending: null,
  dismissed: {},
  handled: {},
  decisions: [],
  validations: [],
  droneChoice: null,
  reports: {},
  findingsOpen: null,
  manualPhase: null,
  sightings: null,
  sightingsByFrame: {},
  plantSignals: [],
  pendingDecisions: {},
  autonomyMode: null,
  autonomyPolicy: null,

  setConn: (conn) => set({ conn }),
  setFleet: (states) => {
    const fleet: Record<string, HubDroneState> = {};
    for (const s of states) fleet[s.drone_id] = s;
    set({ fleet });
  },
  select: (id) => {
    if (get().selected === id) return;
    try { localStorage.setItem(SELECTION_KEY, id); } catch { /* private mode */ }
    set({ selected: id, trail: [], history: { alt: [], bat: [] }, tel: null });
  },
  setTel: (tel) => set({ tel }),
  sampleHistory: () => {
    const { tel, history, trail } = get();
    if (!tel) return;
    const next: Partial<ArgusState> = {
      history: { alt: [...history.alt.slice(-59), tel.position.relAlt], bat: [...history.bat.slice(-59), tel.battery.soc_pct] },
    };
    if (tel.position.relAlt > 0.4) next.trail = [...trail.slice(-240), { lat: tel.position.lat, lon: tel.position.lon }];
    set(next);
  },
  addLog: (s) => set((st) => ({ logs: [...st.logs.slice(-299), s] })),
  addDetection: (d) => set((st) => ({ detections: [...st.detections.filter((x) => x.id !== d.id), d] })),
  setDetections: (detections) => set({ detections }),
  setMission: (m) => set((st) => ({ missions: { ...st.missions, [m.mission_id]: m } })),
  setMissionSpec: (missionSpec) => set({ missionSpec }),
  setValidation: (validation) => set((st) => ({ validation, validations: [...st.validations.slice(-19), validation] })),
  setTriage: (triage) => set({ triage }),
  setIncident: (incident) => set({ incident }),
  resolveIncident: (resolution) => set((st) => ({ incident: st.incident ? { ...st.incident, resolution } : null })),
  setAgentPlan: (agentPlan) => set({ agentPlan }),
  // a new dispatch starts here: the previous flight's agent trace, plan and verdicts are cleared
  setPretriage: (pretriage) => set({ pretriage, agentActions: [], inspection: null, missionSpec: null, validation: null, agentPlan: null, incident: null, triage: null, envelope: null, flownRoute: [], hardStop: null, decisions: [], validations: [], droneChoice: null, sightingsByFrame: {} }),
  addAgentAction: (a) => set((st) => ({ agentActions: [...st.agentActions.slice(-39), a] })),
  setInspection: (inspection) => set({ inspection }),
  setEnvelope: (envelope) => set({ envelope }),
  addFlown: (p) => set((st) => ({ flownRoute: [...st.flownRoute, p] })),
  setHardStop: (hardStop) => set({ hardStop }),
  setOverheads: (overheads) => set({ overheads }),
  setBaseline: (baselineRef) => set({ baselineRef }),
  setClamp: (clamp) => set({ clamp }),
  setManualActive: (manualActive) => set({ manualActive }),
  setDispatching: (dispatching) => set({ dispatching }),
  setOpenFences: (sceneOpenFences) => set({ sceneOpenFences }),
  setSceneProps: (sceneProps) => set({ sceneProps }),
  setCamera: (droneId, c) => set((st) => ({ camera: { ...st.camera, [droneId]: c } })),
  setGimbalPending: (gimbalPending) => set({ gimbalPending }),
  dismissDetection: (id, how) => set((st) => ({ dismissed: { ...st.dismissed, [id]: how } })),
  markHandled: (id) => set((st) => (st.handled[id] ? {} : { handled: { ...st.handled, [id]: true } })),
  addDecision: (d) => set((st) => ({ decisions: [...st.decisions.slice(-199), { ts: d.ts ?? Date.now(), ...d }] })),
  setDroneChoice: (droneChoice) => set({ droneChoice }),
  setReport: (r) => set((st) => ({ reports: { ...st.reports, [r.mission_id]: r } })),
  setReports: (rs) => set((st) => { const reports = { ...st.reports }; for (const r of rs) reports[r.mission_id] = r; return { reports }; }),
  openFindings: (findingsOpen) => set({ findingsOpen }),
  setManualPhase: (manualPhase) => set({ manualPhase }),
  setSightings: (v) => set((st) => ({ sightings: v, sightingsByFrame: v && v.frame_ref ? { ...st.sightingsByFrame, [v.frame_ref]: v.sightings } : st.sightingsByFrame })),
  addPlantSignal: (p) => set((st) => ({ plantSignals: [p, ...st.plantSignals.filter((x) => x.sensor_id !== p.sensor_id)].slice(0, 20) })),
  clearSignals: () => set({ plantSignals: [], pendingDecisions: {}, sightings: null }),
  setDecision: (d) => set((st) => ({ pendingDecisions: { ...st.pendingDecisions, [d.id]: d } })),
  setAutonomy: (autonomyMode, autonomyPolicy) => set({ autonomyMode, autonomyPolicy }),
}));

/** The Drone the console follows, or the first known one. */
export function selectedDrone(st: ArgusState): HubDroneState | null {
  if (st.selected && st.fleet[st.selected]) return st.fleet[st.selected];
  const first = Object.values(st.fleet).sort((a, b) => a.drone_id.localeCompare(b.drone_id))[0];
  return first ?? null;
}

/** Active Mission (pending / flying / paused / returning) of a Drone. */
export function activeMission(st: ArgusState, droneId: string | null): HubMission | null {
  if (!droneId) return null;
  return Object.values(st.missions).find((m) => m.drone_id === droneId && ['pending', 'flying', 'paused', 'returning'].includes(m.phase)) ?? null;
}

export const STATUS_COLOR: Record<HubDroneState['status'], string> = {
  idle: 'var(--gray-8)',
  on_mission: 'var(--green)',
  manual_control: 'var(--amber)',
  returning: 'var(--blue-bright)',
  offline: 'var(--red)',
};
export const STATUS_LABEL: Record<HubDroneState['status'], string> = {
  idle: 'IDLE', on_mission: 'ON MISSION', manual_control: 'MANUAL', returning: 'RETURNING', offline: 'OFFLINE',
};

/** The pending automatic decision for a Detection, if the system announced one and it has not been released. */
export function decisionFor(st: ArgusState, detectionId: string): DecisionView | null {
  return Object.values(st.pendingDecisions).filter((d) => d.detection_id === detectionId && d.action !== 'released').sort((a, b) => b.ts - a.ts)[0] ?? null;
}

/** The newest Detection the Operator has not acted on yet: not dismissed, not being dispatched, not already triaged. */
export function liveDetection(st: ArgusState): HubDetection | null {
  for (let i = st.detections.length - 1; i >= 0; i--) {
    const d = st.detections[i];
    if (st.dismissed[d.id] || st.handled[d.id]) continue;
    if (st.pretriage?.detection_id === d.id) continue;
    if (st.dispatching && st.dispatching !== d.id) continue;
    return d;
  }
  return null;
}

/** Where an evidence ref is served: refs already under `evidence/` sit at the root, everything else under /evidence/. */
export function evidenceUrl(base: string, ref: string): string {
  return ref.startsWith('evidence/') ? `${base}/${ref}` : `${base}/evidence/${ref}`;
}

/** The Hub's Drone choice, reproduced from a fleet snapshot: the idle Drone with the most battery. Used until the Hub reports its own pick. */
export function deriveDroneChoice(fleet: Record<string, HubDroneState>, chosen: string, missionId: string | null): DroneChoiceView {
  const all = Object.values(fleet).sort((a, b) => a.drone_id.localeCompare(b.drone_id));
  const candidates = all.map((d) => {
    const eligible = d.drone_id === chosen || d.status === 'idle';
    const reason = d.drone_id === chosen ? 'chosen' : d.status === 'offline' ? 'offline' : d.status === 'on_mission' ? 'already on a Mission' : d.status === 'returning' ? 'returning to its pad' : d.status === 'manual_control' ? 'under manual control' : `idle, ${d.battery_pct.toFixed(0)}% battery`;
    return { drone_id: d.drone_id, status: d.status, battery_pct: d.battery_pct, eligible, reason };
  });
  const me = fleet[chosen];
  const others = candidates.filter((c) => c.drone_id !== chosen && c.eligible);
  const reason = !me ? 'the Hub chose it' : others.length === 0 ? `the only idle Drone (${me.battery_pct.toFixed(0)}% battery)` : `idle with the most battery (${me.battery_pct.toFixed(0)}%; ${others.map((o) => `${o.drone_id} ${o.battery_pct.toFixed(0)}%`).join(', ')})`;
  return { mission_id: missionId, drone_id: chosen, reason, candidates, source: 'derived' };
}
