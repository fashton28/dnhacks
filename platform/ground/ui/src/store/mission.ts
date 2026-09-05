/* ============================================================================
 * Drone Safety Platform — MissionStore
 * ----------------------------------------------------------------------------
 * Singleton observable store (same pattern as SettingsStore: plain closure +
 * useSyncExternalStore hook) for the satellite→planner→verifier→report mission
 * flow. App.tsx feeds it from the MissionDataSource channels; panels read it
 * via useMission() and act through the exported action functions. It also
 * keeps the operator-facing audit trail of timestamped mission events.
 * ========================================================================== */
import { useSyncExternalStore } from 'react';
import type {
  Anomaly,
  ControlSource,
  IncidentReport,
  MissionPlan,
  Verification,
} from '@/contract';
import { DEFAULT_VEHICLE_ID } from '@/contract';
import type { SiteModel } from '@/site';

export type AuditKind =
  | 'anomaly' | 'plan' | 'verification' | 'approval' | 'denial'
  | 'execution' | 'observation' | 'report' | 'operator' | 'status' | 'abort';

export interface AuditEvent {
  ts: number;
  vehicleId: string;
  kind: AuditKind;
  text: string;
}

/** A proposed plan paired (by requestId) with its verifier outcome. */
export interface PlanProposal {
  plan: MissionPlan;
  verification?: Verification;
  approvedAt?: number;
  deniedAt?: number;
}

export type ReportResolution = 'escalated' | 'logged' | 'dismissed';

export interface MissionState {
  site: SiteModel | null;
  anomalies: Anomaly[];
  proposals: PlanProposal[];
  /** requestId the operator is inspecting in the verifier panel. */
  selectedRequestId: string | null;
  /** true while telemetry reports controlSource 'planner'. */
  executing: boolean;
  /** requestId of the approved (executing/executed) plan, if any. */
  executedRequestId: string | null;
  report: IncidentReport | null;
  reportResolution: ReportResolution | null;
  audit: AuditEvent[];
}

const EMPTY: MissionState = {
  site: null,
  anomalies: [],
  proposals: [],
  selectedRequestId: null,
  executing: false,
  executedRequestId: null,
  report: null,
  reportResolution: null,
  audit: [],
};

type Listener = () => void;

function shortId(id: string): string {
  return id.length > 26 ? `${id.slice(0, 24)}…` : id;
}

function createMissionStore() {
  let state: MissionState = { ...EMPTY };
  const listeners = new Set<Listener>();

  const emit = (): void => listeners.forEach((cb) => cb());
  const set = (patch: Partial<MissionState>): void => {
    state = { ...state, ...patch };
    emit();
  };
  const audit = (
    kind: AuditKind,
    text: string,
    vehicleId: string = DEFAULT_VEHICLE_ID,
  ): AuditEvent[] =>
    [...state.audit.slice(-300), { ts: Date.now(), vehicleId, kind, text }];

  return {
    get(): MissionState {
      return state;
    },
    subscribe(cb: Listener): () => void {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    setSite(site: SiteModel): void {
      if (state.site === site) return;
      set({ site });
    },

    addAudit(kind: AuditKind, text: string, vehicleId: string = DEFAULT_VEHICLE_ID): void {
      set({ audit: audit(kind, text, vehicleId) });
    },

    ingestAnomaly(a: Anomaly, vehicleId: string = DEFAULT_VEHICLE_ID): void {
      if (state.anomalies.some((x) => x.id === a.id)) return;
      set({
        anomalies: [...state.anomalies, a],
        audit: audit('anomaly',
          `Satellite anomaly ${a.id} (${a.type}, conf ${(a.confidence * 100).toFixed(0)}%) at ` +
          `${a.lat.toFixed(5)}, ${a.lon.toFixed(5)}`, vehicleId),
      });
    },

    ingestPlan(p: MissionPlan, vehicleId: string = DEFAULT_VEHICLE_ID): void {
      if (state.proposals.some((x) => x.plan.requestId === p.requestId)) return;
      set({
        proposals: [...state.proposals, { plan: p }],
        selectedRequestId: p.requestId,
        audit: audit('plan',
          `Plan ${shortId(p.requestId)} proposed — ${p.tools.length} step(s), profile ${p.profile}`, vehicleId),
      });
    },

    ingestVerification(v: Verification, vehicleId: string = DEFAULT_VEHICLE_ID): void {
      const idx = state.proposals.findIndex((x) => x.plan.requestId === v.requestId);
      if (idx === -1) return; // verification for an unknown plan — drop
      if (state.proposals[idx].verification) return;
      const proposals = state.proposals.slice();
      proposals[idx] = { ...proposals[idx], verification: v };
      const failed = v.checks.filter((c) => !c.ok).map((c) => c.name);
      set({
        proposals,
        selectedRequestId: v.requestId,
        audit: audit('verification',
          `Verifier: ${shortId(v.requestId)} → ${v.verdict.toUpperCase()}` +
          (failed.length ? ` (failed: ${failed.join(', ')})` : ''), vehicleId),
      });
    },

    select(requestId: string): void {
      set({ selectedRequestId: requestId });
    },

    noteApproval(requestId: string): void {
      const proposals = state.proposals.map((p) =>
        p.plan.requestId === requestId ? { ...p, approvedAt: Date.now() } : p);
      set({
        proposals,
        executedRequestId: requestId,
        audit: audit('approval', `Operator APPROVED plan ${shortId(requestId)} — executePlan sent`),
      });
    },

    noteDenial(requestId: string): void {
      const proposals = state.proposals.map((p) =>
        p.plan.requestId === requestId ? { ...p, deniedAt: Date.now() } : p);
      set({
        proposals,
        audit: audit('denial', `Operator DENIED plan ${shortId(requestId)}`),
      });
    },

    noteAbort(): void {
      set({ audit: audit('abort', 'Operator sent abortPlan — mission aborted') });
    },

    /** Track execution from the authoritative telemetry controlSource. */
    noteControlSource(
      src: ControlSource | undefined,
      vehicleId: string = DEFAULT_VEHICLE_ID,
    ): void {
      const executing = src === 'planner';
      if (executing === state.executing) return;
      set({
        executing,
        audit: audit('execution',
          executing ? 'Mission execution started (controlSource → planner)'
                    : 'Mission execution ended (planner released)', vehicleId),
      });
    },

    ingestReport(r: IncidentReport, vehicleId: string = DEFAULT_VEHICLE_ID): void {
      if (state.report && state.report.missionId === r.missionId) return;
      set({
        report: r,
        reportResolution: null,
        audit: audit('report', `Incident report for ${shortId(r.missionId)}: verdict ${r.verdict.toUpperCase()}`, vehicleId),
      });
    },

    resolveReport(resolution: ReportResolution): void {
      if (!state.report) return;
      set({
        reportResolution: resolution,
        audit: audit('operator', `Operator ${resolution.toUpperCase()} incident report ${shortId(state.report.missionId)}`),
      });
    },

    reset(): void {
      state = { ...EMPTY, site: state.site };
      emit();
    },
  };
}

export const missionStore = createMissionStore();

/** React hook — re-renders whenever mission state changes. */
export function useMission(): MissionState {
  return useSyncExternalStore(
    (cb) => missionStore.subscribe(cb),
    () => missionStore.get(),
    () => missionStore.get(),
  );
}

/** The plan that would actually fly for a proposal: the verifier's corrected
 *  copy when present, otherwise the original. */
export function effectivePlan(p: PlanProposal): MissionPlan {
  return p.verification?.correctedPlan ?? p.plan;
}
