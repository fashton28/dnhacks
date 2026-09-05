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
  AttendanceMode,
  ControlSource,
  EnvelopeMessage,
  EscalationMessage,
  FleetMessage,
  FleetVehicle,
  IncidentReport,
  MissionPlan,
  MissionRecord,
  ModeMessage,
  Task,
  Verification,
} from '@/contract';
import { DEFAULT_VEHICLE_ID } from '@/contract';
import type { SiteModel } from '@/site';

export type AuditKind =
  | 'anomaly' | 'plan' | 'verification' | 'approval' | 'denial'
  | 'execution' | 'observation' | 'report' | 'operator' | 'status' | 'abort' | 'health' | 'rf'
  | 'task' | 'envelope' | 'mode' | 'escalation' | 'handoff';

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

  /* ---- Phase 3 rails ---------------------------------------------------- */
  /** Triage tasks in OPERATOR order (the operator may reorder them). */
  tasks: Task[];
  /** Free text the operator wants carried into the next triage run. */
  operatorNote: string;
  /** vehicleId the operator is currently following. */
  vehicleId: string;
  /** Latest envelope report per vehicle (the monitor's own view). */
  envelopeByVehicle: Record<string, EnvelopeMessage>;
  /** Latest attendance mode report. */
  attendance: ModeMessage | null;
  /** Escalation outbox, newest last. */
  escalations: EscalationMessage[];
  /** Latest fleet rows + the epoch ms they arrived (separation staleness). */
  fleet: FleetVehicle[];
  fleetTs: number;
  /** Durable per-mission audit records, newest last. */
  records: MissionRecord[];
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
  tasks: [],
  operatorNote: '',
  vehicleId: DEFAULT_VEHICLE_ID,
  envelopeByVehicle: {},
  attendance: null,
  escalations: [],
  fleet: [],
  fleetTs: 0,
  records: [],
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

  /** The record still being written, if any (the last one with no endedAt). */
  const openRecordFor = (requestId: string): MissionRecord | undefined =>
    state.records.find((r) => r.missionId === requestId);
  const liveRecord = (): MissionRecord | undefined =>
    [...state.records].reverse().find((r) => r.endedAt === undefined);

  const patchRecord = (
    missionId: string,
    patch: (r: MissionRecord) => MissionRecord,
    extraAudit?: AuditEvent[],
  ): void => {
    const records = state.records.map((r) => (r.missionId === missionId ? patch(r) : r));
    set(extraAudit ? { records, audit: extraAudit } : { records });
  };

  /**
   * Open the durable mission record for an approved (or auto-dispatched) plan.
   * Everything needed to reconstruct WHY the mission flew is snapshotted here:
   * the attendance mode in force, the task that drove it, the planner's rule
   * trace, the corridor it was cleared for, and (as they arrive) every envelope
   * report raised while it ran.
   */
  const openRecord = (requestId: string, vehicleId: string): void => {
    if (openRecordFor(requestId)) return;
    const proposal = state.proposals.find((p) => p.plan.requestId === requestId);
    if (!proposal || !proposal.verification) return;
    const plan = proposal.verification.correctedPlan ?? proposal.plan;
    const task = state.tasks.find((t) => t.anomalyId === plan.anomalyId);
    const record: MissionRecord = {
      missionId: requestId,
      vehicleId,
      anomalyId: plan.anomalyId,
      plan,
      verification: proposal.verification,
      startedAt: Date.now(),
      mode: state.attendance?.mode ?? 'attended',
      ...(task ? { task } : {}),
      planTrace: plan.planTrace ?? [],
      ...(plan.corridor ? { corridor: plan.corridor } : {}),
      envelopeEvents: [],
    };
    set({
      records: [...state.records.slice(-40), record],
      audit: audit('execution',
        `Mission record ${shortId(requestId)} opened — mode ${record.mode}` +
        (task ? `, task ${task.taskId}` : ''), vehicleId),
    });
  };

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
      const known = state.anomalies.find((x) => x.id === a.id);
      if (known) {
        // A re-emitted cue that MOVED is the operator relocating the target on
        // the map; anything else is a duplicate and is dropped.
        if (known.lat === a.lat && known.lon === a.lon) return;
        set({
          anomalies: state.anomalies.map((x) => (x.id === a.id ? a : x)),
          audit: audit('operator',
            `Cue ${a.id} relocated to ${a.lat.toFixed(5)}, ${a.lon.toFixed(5)} — re-planning`, vehicleId),
        });
        return;
      }
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

    noteApproval(requestId: string, vehicleId: string = state.vehicleId): void {
      const proposals = state.proposals.map((p) =>
        p.plan.requestId === requestId ? { ...p, approvedAt: Date.now() } : p);
      set({
        proposals,
        executedRequestId: requestId,
        audit: audit('approval', `Operator APPROVED plan ${shortId(requestId)} — executePlan sent`, vehicleId),
      });
      openRecord(requestId, vehicleId);
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
      const live = liveRecord();
      if (live) patchRecord(live.missionId, (rec) => ({ ...rec, endedAt: Date.now() }));
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
      // Unattended auto-dispatch never passes through noteApproval, so the
      // record is opened here from the newest verified, non-rejected proposal.
      if (!executing || liveRecord()) return;
      for (let i = state.proposals.length - 1; i >= 0; i -= 1) {
        const candidate = state.proposals[i];
        if (candidate.verification && candidate.verification.verdict !== 'rejected') {
          set({ executedRequestId: candidate.plan.requestId });
          openRecord(candidate.plan.requestId, vehicleId);
          return;
        }
      }
    },

    ingestReport(r: IncidentReport, vehicleId: string = DEFAULT_VEHICLE_ID): void {
      if (state.report && state.report.missionId === r.missionId) return;
      set({
        report: r,
        reportResolution: null,
        audit: audit('report', `Incident report for ${shortId(r.missionId)}: verdict ${r.verdict.toUpperCase()}`, vehicleId),
      });
      // Closing the durable record: the report is the last thing written to it.
      if (openRecordFor(r.missionId)) {
        patchRecord(r.missionId, (rec) => ({ ...rec, report: r, endedAt: Date.now() }));
      }
    },

    /* ---- Phase 3 rails -------------------------------------------------- */

    /** Which vehicle the operator is following (drives the envelope badge). */
    setVehicle(vehicleId: string): void {
      if (state.vehicleId === vehicleId) return;
      set({ vehicleId, audit: audit('operator', `Operator now following ${vehicleId}`, vehicleId) });
    },

    /**
     * A triage task. Re-emitting a known taskId updates it in place and keeps
     * the operator's ordering; a change of `assignedTo` is a HANDOFF and is
     * recorded on the live mission record (ADR D26 — explicit and audited).
     */
    ingestTask(task: Task, vehicleId: string = DEFAULT_VEHICLE_ID): void {
      const existing = state.tasks.find((t) => t.taskId === task.taskId);
      if (!existing) {
        set({
          tasks: [...state.tasks, task],
          audit: audit('task',
            `Task ${task.taskId} (${task.source}, ${task.urgency}, p=${task.priority.toFixed(2)}): ` +
            `look for ${task.lookFor.replace('_', ' ')} — ${task.question}`, vehicleId),
        });
        return;
      }
      const handedOff = !!existing.assignedTo && !!task.assignedTo &&
        existing.assignedTo !== task.assignedTo;
      const tasks = state.tasks.map((t) => (t.taskId === task.taskId ? task : t));
      set({
        tasks,
        audit: audit(handedOff ? 'handoff' : 'task',
          handedOff
            ? `Task ${task.taskId} handed off: ${existing.assignedTo} → ${task.assignedTo}`
            : `Task ${task.taskId} updated (${task.source}, ${task.urgency})`,
          vehicleId),
      });
      if (handedOff) {
        const live = liveRecord();
        if (live) patchRecord(live.missionId, (rec) => ({ ...rec, handoffFrom: existing.assignedTo }));
      }
    },

    /** Operator reordering. `delta` is -1 (up) or +1 (down). */
    reorderTask(taskId: string, delta: number): void {
      const index = state.tasks.findIndex((t) => t.taskId === taskId);
      const target = index + delta;
      if (index === -1 || target < 0 || target >= state.tasks.length) return;
      const tasks = state.tasks.slice();
      const [moved] = tasks.splice(index, 1);
      tasks.splice(target, 0, moved);
      set({
        tasks,
        audit: audit('operator', `Operator moved task ${taskId} to position ${target + 1}`),
      });
    },

    /** Free text carried into the NEXT triage run (never into a plan). */
    setOperatorNote(note: string): void {
      if (state.operatorNote === note) return;
      set({ operatorNote: note });
    },

    noteTriageRun(note: string, vehicleId: string = DEFAULT_VEHICLE_ID): void {
      set({
        audit: audit('operator',
          note ? `Operator re-ran triage with note: "${note}"` : 'Operator re-ran triage', vehicleId),
      });
    },

    /**
     * Envelope reports. Only a state CHANGE is audited (5 Hz nominal reports
     * would drown the trail), and every non-nominal report is appended to the
     * live mission record so the record shows what the monitor saw.
     */
    ingestEnvelope(m: EnvelopeMessage): void {
      const previous = state.envelopeByVehicle[m.vehicleId];
      const changed = !previous || previous.state !== m.state || previous.constraint !== m.constraint;
      const envelopeByVehicle = { ...state.envelopeByVehicle, [m.vehicleId]: m };
      const margin = m.margin_m === undefined ? '' : ` (${m.margin_m >= 0 ? '+' : ''}${m.margin_m.toFixed(1)} m)`;
      set(changed
        ? {
            envelopeByVehicle,
            audit: audit('envelope',
              `Envelope ${m.state.replace('_', ' ')}${m.constraint ? ` · ${m.constraint}` : ''}${margin}` +
              `${m.action && m.action !== 'none' ? ` → ${m.action}` : ''}`, m.vehicleId),
          }
        : { envelopeByVehicle });
      if (m.state === 'in_envelope') return;
      const live = liveRecord();
      if (!live || live.vehicleId !== m.vehicleId) return;
      const last = live.envelopeEvents[live.envelopeEvents.length - 1];
      if (last && last.state === m.state && last.constraint === m.constraint) return;
      patchRecord(live.missionId, (rec) => ({
        ...rec, envelopeEvents: [...rec.envelopeEvents.slice(-40), m],
      }));
    },

    ingestMode(m: ModeMessage): void {
      const previous = state.attendance;
      const changed = !previous || previous.mode !== m.mode ||
        previous.operatorPresent !== m.operatorPresent;
      set(changed
        ? {
            attendance: m,
            audit: audit('mode',
              `Attendance ${m.mode.toUpperCase()} · operator ${m.operatorPresent ? 'present' : 'ABSENT'}`,
              m.vehicleId),
          }
        : { attendance: m });
    },

    ingestEscalation(m: EscalationMessage): void {
      if (state.escalations.some((e) => e.missionId === m.missionId && e.ts === m.ts)) return;
      set({
        escalations: [...state.escalations.slice(-40), m],
        audit: audit('escalation',
          `Escalation for ${shortId(m.missionId)} on ${m.channel} — ` +
          `${m.deliveredAt ? 'delivered' : 'UNDELIVERED (held in the outbox)'}`, m.vehicleId),
      });
    },

    ingestFleet(m: FleetMessage): void {
      set({ fleet: m.vehicles, fleetTs: m.ts });
    },

    /** Auto-dispatch (unattended): the record opens without an operator gate. */
    openMissionRecord(requestId: string, vehicleId: string = DEFAULT_VEHICLE_ID): void {
      openRecord(requestId, vehicleId);
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

/** Attendance mode in force; 'attended' until the vehicle says otherwise —
 *  the safe direction is always toward supervision (ADR D23). */
export function attendanceOf(state: MissionState): AttendanceMode {
  return state.attendance?.mode ?? 'attended';
}

/** Envelope report for the vehicle the operator is following, if any. */
export function envelopeOf(state: MissionState): EnvelopeMessage | null {
  return state.envelopeByVehicle[state.vehicleId] ?? null;
}

/** The mission record still being written, if any. */
export function liveMissionRecord(state: MissionState): MissionRecord | null {
  for (let i = state.records.length - 1; i >= 0; i -= 1) {
    if (state.records[i].endedAt === undefined) return state.records[i];
  }
  return state.records[state.records.length - 1] ?? null;
}
