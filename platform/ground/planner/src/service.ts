/* ============================================================================
 * eis-planner/service — the Electron host's façade over the planner.
 *
 * `propose` is now DETERMINISTIC end to end: task → rule table → verifier.
 * The LLM plan path is gone (ADR D20); the model's only remaining jobs are
 * triage (`triage.ts`) and the incident report below, both schema-bound.
 *
 * The IPC shape the shells and the UI already speak is unchanged, so this stays
 * a drop-in: `{ plan, effectivePlan, verification, source, attempts }`.
 * ========================================================================== */

import {
  Anomaly, CapabilitiesMessage, MissionPlan, Task, Telemetry, Verification,
} from './contract';
import { planMission } from './deterministic';
import { LlmClient, createLlmClient } from './llm';
import { ObservationSummary, reportVerdict, writeIncidentReport } from './report';
import { SiteModel } from './site';
import { lookForOf } from './triage';
import { VerificationContext, verifyMission } from './verifier';

export interface PlannerProposeInput {
  vehicleId: string;
  anomaly: Anomaly;
  telemetry?: Telemetry;
  capabilities?: CapabilitiesMessage;
  context: VerificationContext;
  /** The task this proposal answers; derived from the anomaly when absent. */
  task?: Task;
}
export interface PlannerProposeResult {
  vehicleId: string;
  plan?: MissionPlan;
  effectivePlan?: MissionPlan;
  verification?: Verification;
  source: 'deterministic';
  attempts: 1;
  /** Present when the rule table refused the task outright. */
  infeasibleReason?: string;
  escalationReason?: string;
}
export interface PlannerReportInput {
  vehicleId: string;
  anomaly: Anomaly;
  plan: MissionPlan;
  observation: ObservationSummary;
}

export type PlannerEvent =
  | { type: 'proposal'; payload: PlannerProposeResult }
  | { type: 'report'; vehicleId: string; payload: ReturnType<typeof writeIncidentReport> };

/** A minimal task for a single-anomaly proposal from the UI. */
export function taskForAnomaly(anomaly: Anomaly): Task {
  const lookFor = lookForOf(anomaly);
  return {
    taskId: `task-${anomaly.id}`,
    anomalyId: anomaly.id,
    lookFor,
    question: `What is at the ${anomaly.source} cue ${anomaly.id}?`,
    urgency: anomaly.confidence >= 0.8 ? 'immediate' : 'next_sortie',
    priority: Math.min(1, Math.max(0, anomaly.confidence)),
    rationale: `Operator-selected ${anomaly.type} cue from ${anomaly.source}.`,
    source: 'operator',
  };
}

export class PlannerService {
  private readonly live: LlmClient | null;
  private readonly listeners = new Set<(event: PlannerEvent) => void>();

  constructor(readonly site: SiteModel, live: LlmClient | null = createLlmClient()) {
    this.live = live;
  }

  subscribe(listener: (event: PlannerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async propose(input: PlannerProposeInput): Promise<PlannerProposeResult> {
    const context = this.runtimeContext(input);
    const task = input.task ?? taskForAnomaly(input.anomaly);
    const outcome = planMission({ task, anomaly: input.anomaly, site: this.site, context });
    let result: PlannerProposeResult;
    if (outcome.infeasible) {
      result = {
        vehicleId: input.vehicleId, source: 'deterministic', attempts: 1,
        infeasibleReason: outcome.reason,
        escalationReason: `the deterministic planner refused this task: ${outcome.reason}`,
      };
    } else {
      const verification = verifyMission(outcome.plan, this.site, context);
      result = {
        vehicleId: input.vehicleId, plan: outcome.plan,
        effectivePlan: verification.verdict === 'pass' ? outcome.plan : verification.correctedPlan,
        verification, source: 'deterministic', attempts: 1,
        ...(verification.verdict === 'rejected'
          ? { escalationReason: 'the verifier rejected the deterministic plan' } : {}),
      };
    }
    this.emit({ type: 'proposal', payload: result });
    return result;
  }

  async report(input: PlannerReportInput): Promise<ReturnType<typeof writeIncidentReport>> {
    const observation = input.observation;
    let report: ReturnType<typeof writeIncidentReport>;
    if (this.live) {
      try {
        report = await this.live.report(input.anomaly, input.plan, observation);
        if (report.verdict !== reportVerdict(observation)) {
          report = writeIncidentReport(input.anomaly, input.plan, observation);
        }
      }
      catch { report = writeIncidentReport(input.anomaly, input.plan, observation); }
    } else report = writeIncidentReport(input.anomaly, input.plan, observation);
    this.emit({ type: 'report', vehicleId: input.vehicleId, payload: report });
    return report;
  }

  private emit(event: PlannerEvent): void { this.listeners.forEach((listener) => listener(event)); }

  private runtimeContext(input: PlannerProposeInput): VerificationContext {
    const telemetry = input.telemetry;
    const capabilities = input.capabilities;
    return {
      ...input.context,
      anomaly: input.anomaly,
      vehicleId: input.context.vehicleId ?? input.vehicleId,
      ...(telemetry ? {
        telemetry: {
          battery: telemetry.battery, navSource: telemetry.navSource,
          position: { ...telemetry.position, relAlt: telemetry.position.relAlt },
        },
        battery: telemetry.battery,
        navSource: telemetry.navSource,
        currentPosition: telemetry.position,
        currentAltitudeM: telemetry.position.relAlt,
      } : {}),
      ...(capabilities ? {
        maxSortieS: capabilities.max_sortie_s,
        dispatchMinSocPct: capabilities.dispatch_min_soc_pct,
        profileCapabilities: capabilities.profiles,
      } : {}),
    };
  }
}
