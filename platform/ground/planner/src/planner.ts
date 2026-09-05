/* ============================================================================
 * eis-planner/planner — the orchestrator, and ONLY the orchestrator.
 *
 *   triage → deterministic plan → verify → approval gate → dispatch
 *
 * It owns no geometry, no rule table and no verdict. It composes the modules
 * that do, and it enforces the seams between them:
 *
 *   - The LLM plan path does not exist. Triage may come from the model
 *     (schema-bound JSON, two attempts, then scripted); the plan never does.
 *   - `ScriptedPlanner` survives for exactly one purpose: `EIS_TEST_BAD_PLAN`,
 *     the demo/test rail that feeds the verifier a plan it must refuse
 *     (docs/DEMO_RUNBOOK.md R1). It is never a fallback for a real dispatch.
 *   - Attended: a passing plan waits for the operator. Unattended: a plan
 *     inside UNATTENDED_ENVELOPE auto-approves; anything else is refused, and
 *     every unattended refusal escalates (ADR D23/D24).
 * ========================================================================== */

import {
  Anomaly, AttendanceMode, Corridor, MissionPlan, PlanTraceEntry, Task, Verification,
} from './contract';
import { DeterministicPlanResult, planMission } from './deterministic';
import { EscalationAdapter, EscalationDelivery } from './escalation';
import { Allocation, FleetCandidate, allocate } from './fleet';
import { LlmClient, createLlmClient } from './llm';
import { ScriptedPlanner } from './scripted';
import { SiteModel } from './site';
import { TriageInput, TriageResult, triage } from './triage';
import { VerificationContext, verifyMission } from './verifier';

export type ApprovalState = 'pending_operator' | 'auto_approved' | 'refused';

export interface PlannerRunInput extends Omit<TriageInput, 'fleet'> {
  /** Candidate vehicles, with the runtime context each would be judged in. */
  vehicles: FleetCandidate[];
  /** Fleet readiness for triage; derived from `vehicles` when omitted. */
  fleet?: TriageInput['fleet'];
  sortieCapPerVehicle?: number;
  assigned?: Record<string, string>;
}

export interface PlannerDecision {
  task: Task;
  vehicleId?: string;
  plan?: MissionPlan;
  effectivePlan?: MissionPlan;
  verification?: Verification;
  corridor?: Corridor;
  planTrace: PlanTraceEntry[];
  approval: ApprovalState;
  mode: AttendanceMode;
  /** Why this decision came out the way it did, in one line. */
  reason: string;
  allocation: Allocation;
  escalation?: EscalationDelivery;
  handoffFrom?: string;
}

export interface PlannerRunResult {
  triage: TriageResult;
  decisions: PlannerDecision[];
}

export interface MissionPlannerOptions {
  llm?: LlmClient | null;
  escalation?: EscalationAdapter;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/** The deliberately-bad demo plan rail (docs/DEMO_RUNBOOK.md R1). */
export function badPlanRailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EIS_TEST_BAD_PLAN === '1' || env.EIS_TEST_BAD_PLAN === 'true';
}

export class MissionPlanner {
  private readonly llm: LlmClient | null;
  private readonly escalation: EscalationAdapter;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;

  constructor(readonly site: SiteModel, options: MissionPlannerOptions = {}) {
    this.env = options.env ?? process.env;
    this.llm = options.llm === undefined ? createLlmClient(this.env) : options.llm;
    this.escalation = options.escalation ?? new EscalationAdapter();
    this.now = options.now ?? (() => Date.now());
  }

  /** Triage every open cue, then decide the top task for the ready fleet. */
  async run(input: PlannerRunInput, limit = 1): Promise<PlannerRunResult> {
    const fleet = input.fleet ?? input.vehicles.map((candidate) => ({
      vehicleId: candidate.vehicleId,
      ready: candidate.context.readiness?.ready ?? false,
      reasons: candidate.context.readiness?.reasons ?? [],
      socPct: (candidate.context.telemetry?.battery ?? candidate.context.battery)?.soc_pct,
    }));
    const triageResult = await triage({ ...input, fleet }, this.llm);
    const assigned = { ...(input.assigned ?? {}) };
    const decisions: PlannerDecision[] = [];
    for (const task of triageResult.tasks.slice(0, limit)) {
      const anomaly = input.anomalies.find((candidate) => candidate.id === task.anomalyId);
      if (!anomaly) continue;
      const decision = await this.decide({
        task, anomaly, triageResult, vehicles: input.vehicles, mode: input.mode,
        sortieCapPerVehicle: input.sortieCapPerVehicle, assigned,
      });
      if (decision.vehicleId && decision.approval !== 'refused') {
        assigned[task.anomalyId] = decision.vehicleId;
      }
      decisions.push(decision);
    }
    return { triage: triageResult, decisions };
  }

  /** One task, end to end: allocate → plan → verify → approval gate. */
  async decide(input: {
    task: Task; anomaly: Anomaly; vehicles: FleetCandidate[]; mode: AttendanceMode;
    triageResult?: TriageResult; sortieCapPerVehicle?: number;
    assigned?: Record<string, string>; handoffFrom?: string;
  }): Promise<PlannerDecision> {
    const { task, anomaly, mode } = input;
    const flagged = input.triageResult?.requiresOperator[task.anomalyId];
    const escalateOnly = input.triageResult?.escalateWithoutFlying.includes(task.anomalyId) ?? false;

    // A cue the correlation rules marked escalate-without-flying never becomes
    // a sortie, in either mode: the answer is a human, not an aircraft.
    if (escalateOnly) {
      const escalation = await this.escalation.escalate({
        vehicleId: input.vehicles[0]?.vehicleId ?? 'eis-1',
        missionId: task.taskId, mode,
        reason: `task ${task.taskId} escalates without flying: RF activity correlates with GNSS interference`,
        payload: { anomalyId: anomaly.id, urgency: task.urgency },
      });
      return {
        task, planTrace: [{ rule: 'triage', effect: 'escalate without flying' }],
        approval: 'refused', mode, escalation,
        reason: 'RF activity correlated with GNSS interference: escalated without flying',
        allocation: { assigned: false, task, attempts: [], reason: 'escalate without flying' },
      };
    }

    const vehicles = input.vehicles.map((candidate) => ({
      ...candidate,
      context: {
        ...candidate.context,
        mode,
        ...(flagged ? { requiresOperator: true, requiresOperatorReason: flagged } : {}),
        vehicleId: candidate.vehicleId,
        now: candidate.context.now ?? this.now(),
      } as VerificationContext,
    }));

    const allocation = allocate({
      task, anomaly, site: this.site, vehicles,
      sortieCapPerVehicle: input.sortieCapPerVehicle,
      assigned: input.assigned,
      ...(input.handoffFrom ? { handoffFrom: input.handoffFrom } : {}),
    });

    if (!allocation.assigned || !allocation.plan || !allocation.vehicleId) {
      const reason = allocation.reason ?? 'no vehicle could take the task';
      const trace = allocation.attempts.flatMap((attempt): PlanTraceEntry[] =>
        attempt.result && attempt.result.infeasible
          ? [{ rule: 'infeasible', effect: `${attempt.vehicleId}: ${attempt.result.reason}` }]
          : attempt.skipped ? [{ rule: 'allocation', effect: `${attempt.vehicleId}: ${attempt.skipped}` }] : []);
      return {
        task, planTrace: trace, approval: 'refused', mode, reason, allocation,
        ...(mode === 'unattended' ? {
          escalation: await this.escalation.escalate({
            vehicleId: input.vehicles[0]?.vehicleId ?? 'eis-1', missionId: task.taskId,
            mode, reason: `unattended task ${task.taskId} refused: ${reason}`,
            payload: { anomalyId: anomaly.id },
          }),
        } : {}),
      };
    }

    const chosen = vehicles.find((candidate) => candidate.vehicleId === allocation.vehicleId) as FleetCandidate;
    const context = chosen.context;
    const plan = this.dispatchPlan(allocation.plan, anomaly);
    const verification = verifyMission(plan, this.site, context);
    const planTrace = plan.planTrace ?? [];
    const effectivePlan = verification.verdict === 'pass' ? plan : verification.correctedPlan;

    if (verification.verdict === 'rejected') {
      const reason = `verifier rejected the plan: ${verification.checks.filter((check) => !check.ok)
        .map((check) => check.name).join(', ')}`;
      return {
        task, vehicleId: allocation.vehicleId, plan, verification, planTrace,
        approval: 'refused', mode, reason, allocation,
        corridor: plan.corridor,
        ...(allocation.handoffFrom ? { handoffFrom: allocation.handoffFrom } : {}),
        escalation: await this.escalation.escalate({
          vehicleId: allocation.vehicleId, missionId: plan.requestId, mode, reason,
          payload: {
            anomalyId: anomaly.id,
            checks: verification.checks.filter((check) => !check.ok).map((check) => check.reason),
          },
        }),
      };
    }

    const auto = mode === 'unattended';
    const approval: ApprovalState = auto ? 'auto_approved' : 'pending_operator';
    return {
      task, vehicleId: allocation.vehicleId, plan, effectivePlan, verification, planTrace,
      corridor: plan.corridor, approval, mode, allocation,
      ...(allocation.handoffFrom ? { handoffFrom: allocation.handoffFrom } : {}),
      reason: auto
        ? 'plan verified inside UNATTENDED_ENVELOPE; auto-approved'
        : `plan verified (${verification.verdict}); awaiting operator approval`,
    };
  }

  /**
   * The plan that is actually dispatched. Normally the deterministic one; under
   * `EIS_TEST_BAD_PLAN` the scripted failing plan, so the demo can show the
   * verifier refusing something. That is the ONLY use of ScriptedPlanner here.
   */
  private dispatchPlan(plan: MissionPlan, anomaly: Anomaly): MissionPlan {
    if (!badPlanRailEnabled(this.env)) return plan;
    const bad = new ScriptedPlanner().failingPlan(this.site, anomaly);
    return { ...bad, planTrace: [{ rule: 'test_rail', effect: 'EIS_TEST_BAD_PLAN: deliberately invalid demo plan' }] };
  }
}

/** Plan one task for one vehicle, without the fleet or the approval gate. */
export function planForTask(task: Task, anomaly: Anomaly, site: SiteModel,
  context: VerificationContext, requestId?: string): DeterministicPlanResult {
  return planMission({ task, anomaly, site, context, ...(requestId ? { requestId } : {}) });
}
