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
import type { HubDetection, HubDroneState, HubMission, AgentPlan } from '@/dataSource/HubDataProvider';

export interface MissionSpecView { objective: string; rationale: string; max_altitude_m: number; standoff_m: number; attempt: number; mission_id: string }
export interface ValidationView { verdict: 'accept' | 'reject'; violations: { rule: string; detail: string; severity: string }[]; attempt?: number; abandoned?: boolean; checks_passed?: number; mission_id: string }
export interface TriageView { decision: string; confidence: number; rationale: string; mission_id: string }
export interface IncidentView { title: string; severity: string; body_markdown: string; recommended_action: string; mission_id: string; ts: number; resolution?: 'escalated' | 'dismissed' }
export interface OverheadView { ref: string; ts: string }
export interface ClampView { rule: string; ts: number }
export interface AgentPlanView { mission_id: string; attempt: number; plan: AgentPlan }

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
  overheads: OverheadView[];
  baselineRef: string | null;
  clamp: ClampView | null;
  manualActive: boolean;
  dispatching: string | null;
  sceneOpenFences: string[];

  setConn(c: ConnectionState): void;
  setFleet(states: HubDroneState[]): void;
  select(id: string): void;
  setTel(t: Telemetry): void;
  sampleHistory(): void;
  addLog(s: StatusText): void;
  addDetection(d: HubDetection): void;
  setMission(m: HubMission): void;
  setMissionSpec(v: MissionSpecView): void;
  setValidation(v: ValidationView): void;
  setTriage(v: TriageView): void;
  setIncident(v: IncidentView): void;
  resolveIncident(r: 'escalated' | 'dismissed'): void;
  setAgentPlan(v: AgentPlanView): void;
  setOverheads(o: OverheadView[]): void;
  setBaseline(ref: string | null): void;
  setClamp(c: ClampView | null): void;
  setManualActive(b: boolean): void;
  setDispatching(id: string | null): void;
  setOpenFences(ids: string[]): void;
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
  overheads: [],
  baselineRef: null,
  clamp: null,
  manualActive: false,
  dispatching: null,
  sceneOpenFences: [],

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
  setMission: (m) => set((st) => ({ missions: { ...st.missions, [m.mission_id]: m } })),
  setMissionSpec: (missionSpec) => set({ missionSpec }),
  setValidation: (validation) => set({ validation }),
  setTriage: (triage) => set({ triage }),
  setIncident: (incident) => set({ incident }),
  resolveIncident: (resolution) => set((st) => ({ incident: st.incident ? { ...st.incident, resolution } : null })),
  setAgentPlan: (agentPlan) => set({ agentPlan }),
  setOverheads: (overheads) => set({ overheads }),
  setBaseline: (baselineRef) => set({ baselineRef }),
  setClamp: (clamp) => set({ clamp }),
  setManualActive: (manualActive) => set({ manualActive }),
  setDispatching: (dispatching) => set({ dispatching }),
  setOpenFences: (sceneOpenFences) => set({ sceneOpenFences }),
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
