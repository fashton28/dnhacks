import { Anomaly, CapabilitiesMessage, MissionPlan, Telemetry, Verification } from './contract';
import { createLlmPlanner, LlmPlanner } from './llm';
import { ObservationSummary, reportVerdict, writeIncidentReport } from './report';
import { ScriptedPlanner } from './scripted';
import { SiteModel } from './site';
import { VerificationContext, verifyMission } from './verifier';
import { validateObservation } from './validate';

export interface PlannerProposeInput {
  vehicleId: string;
  anomaly: Anomaly;
  telemetry?: Telemetry;
  capabilities?: CapabilitiesMessage;
  context: VerificationContext;
}
export interface PlannerProposeResult {
  vehicleId: string;
  plan: MissionPlan;
  effectivePlan?: MissionPlan;
  verification: Verification;
  source: 'scripted' | 'live';
  attempts: 1 | 2;
  fallbackReason?: string;
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

export class PlannerService {
  private readonly scripted = new ScriptedPlanner();
  private readonly live: LlmPlanner | null;
  private readonly listeners = new Set<(event: PlannerEvent) => void>();

  constructor(readonly site: SiteModel, live: LlmPlanner | null = createLlmPlanner()) {
    this.live = live;
  }

  subscribe(listener: (event: PlannerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async propose(input: PlannerProposeInput): Promise<PlannerProposeResult> {
    const runtime = this.runtimeContext(input);
    let result: PlannerProposeResult;
    if (!this.live) {
      result = this.scriptedResult(input);
    } else {
      try {
        const requestId = `live-${input.anomaly.id}-${Date.now()}`;
        const first = await this.live.plan(this.site, input.anomaly, requestId,
          { capabilities: input.capabilities, context: runtime });
        const firstVerification = verifyMission(first, this.site, runtime);
        if (firstVerification.verdict !== 'rejected') {
          result = this.result(input.vehicleId, first, firstVerification, 'live', 1);
        } else {
          const feedback = firstVerification.checks.filter((check) => !check.ok)
            .map((check) => `${check.name}: ${check.reason}`).join('\n');
          const second = await this.live.plan(this.site, input.anomaly, requestId,
            { feedback, capabilities: input.capabilities, context: runtime });
          const secondVerification = verifyMission(second, this.site, runtime);
          result = this.result(input.vehicleId, second, secondVerification, 'live', 2,
            secondVerification.verdict === 'rejected' ? 'verifier rejected the one allowed retry' : undefined);
        }
      } catch (error) {
        result = this.scriptedResult(input, (error as Error).message);
      }
    }
    this.emit({ type: 'proposal', payload: result });
    return result;
  }

  async report(input: PlannerReportInput): Promise<ReturnType<typeof writeIncidentReport>> {
    const observation = validateObservation(input.observation);
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

  private scriptedResult(input: PlannerProposeInput, fallbackReason?: string): PlannerProposeResult {
    const plan = this.scripted.passingPlan(this.site, input.anomaly);
    const verification = verifyMission(plan, this.site, this.runtimeContext(input));
    return this.result(input.vehicleId, plan, verification, 'scripted', 1,
      verification.verdict === 'rejected' ? 'scripted fallback failed verification' : undefined, fallbackReason);
  }

  private result(vehicleId: string, plan: MissionPlan, verification: Verification,
    source: 'scripted' | 'live', attempts: 1 | 2, escalationReason?: string,
    fallbackReason?: string): PlannerProposeResult {
    return {
      vehicleId, plan, effectivePlan: verification.correctedPlan ?? (verification.verdict === 'pass' ? plan : undefined),
      verification, source, attempts, ...(fallbackReason ? { fallbackReason } : {}),
      ...(escalationReason ? { escalationReason } : {}),
    };
  }

  private emit(event: PlannerEvent): void { this.listeners.forEach((listener) => listener(event)); }

  private runtimeContext(input: PlannerProposeInput): VerificationContext {
    const telemetry = input.telemetry;
    const capabilities = input.capabilities;
    return {
      ...input.context,
      anomaly: input.anomaly,
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
