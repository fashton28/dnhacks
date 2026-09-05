/** DNHacks live planner. This module is loaded only in the Electron main process. */
import OpenAI from 'openai';
import { zodTextFormat as zodOutputFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { Anomaly, CapabilitiesMessage, IncidentReport, MissionPlan, PROFILE_SPEED_MPS } from './contract';
import { ObservationSummary } from './report';
import { SiteModel } from './site';
import { validateMissionPlan } from './validate';
import { VerificationContext } from './verifier';

export const DEFAULT_LLM_MODEL = 'gpt-5.5';
export const LLM_TIMEOUT_MS = 20_000;

const Profile = z.enum(['follow', 'inspect', 'survey', 'slow', 'standard', 'fast']);
const PlanTool = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('goto_gps'), lat: z.number(), lon: z.number(), alt: z.number(), profile: Profile.nullable(), speed_mps: z.number().nullable() }),
  z.object({ tool: z.literal('orbit_point'), lat: z.number(), lon: z.number(), radius: z.number(), laps: z.number().nullable() }),
  z.object({ tool: z.literal('hold'), durationS: z.number().nullable() }),
  z.object({ tool: z.literal('rtl') }),
]);

export const MISSION_PLAN_INPUT_SCHEMA = z.object({
  requestId: z.string(), anomalyId: z.string(), tools: z.array(PlanTool).min(1),
  profile: Profile, rationale: z.string(),
});
export const INCIDENT_REPORT_INPUT_SCHEMA = z.object({
  missionId: z.string(), verdict: z.enum(['false_alarm', 'log', 'escalate']), markdown: z.string(),
});

interface ResponsesClient {
  responses: { parse(input: unknown, options?: { signal?: AbortSignal }): Promise<{ output_parsed: unknown }> };
}

export function llmPlannerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EIS_PLANNER_MODE === 'live' && Boolean(env.OPENAI_API_KEY);
}

export function createLlmPlanner(env: NodeJS.ProcessEnv = process.env): LlmPlanner | null {
  if (!llmPlannerEnabled(env)) return null;
  return new LlmPlanner({ apiKey: env.OPENAI_API_KEY, model: env.EIS_LLM_MODEL });
}

function constraints(site: SiteModel): string {
  return JSON.stringify({
    home: site.home, geofence: site.geofence, nfz_buffer_m: site.nfzBufferM,
    nfz: site.nfz, alt_band_m: site.altBandM, clear_altitude_m: site.clearAltitudeM,
    clutter: site.clutter, speed_profiles_mps: PROFILE_SPEED_MPS,
  });
}

export class LlmPlanner {
  private readonly client: ResponsesClient;
  readonly model: string;
  readonly timeoutMs: number;

  constructor(opts: { apiKey?: string; model?: string; timeoutMs?: number; client?: ResponsesClient } = {}) {
    this.client = opts.client ?? new OpenAI(opts.apiKey ? { apiKey: opts.apiKey } : {}) as unknown as ResponsesClient;
    this.model = opts.model || DEFAULT_LLM_MODEL;
    this.timeoutMs = opts.timeoutMs ?? LLM_TIMEOUT_MS;
  }

  async plan(site: SiteModel, anomaly: Anomaly, requestId: string, options: {
    feedback?: string; capabilities?: CapabilitiesMessage; context?: VerificationContext;
  } = {}): Promise<MissionPlan> {
    const cap = options.capabilities;
    const liveSoc = options.context?.telemetry?.battery.soc_pct ?? options.context?.battery?.soc_pct;
    const budget = {
      max_sortie_s: cap?.max_sortie_s ?? options.context?.maxSortieS,
      dispatch_min_soc_pct: cap?.dispatch_min_soc_pct ?? options.context?.dispatchMinSocPct,
      live_soc_pct: liveSoc,
      rule: 'Propose the shortest mission that answers the anomaly. Never exceed min(range budget, sortie cap); split into two sorties if needed.',
    };
    const response = await this.parse({
      model: this.model,
      instructions: 'Return exactly one schema-bound mission plan using only goto_gps, orbit_point, hold, and rtl. End with rtl. Never add prose outside the object.',
      input: `Anomaly:\n${JSON.stringify(anomaly)}\nConstraints:\n${constraints(site)}\n` +
        `Dispatch capabilities:\n${JSON.stringify(cap ?? {})}\nFlight budget:\n${JSON.stringify(budget)}\n` +
        `requestId=${requestId}\n${options.feedback ? `Verifier feedback from the one allowed retry:\n${options.feedback}` : ''}`,
      text: { format: zodOutputFormat(MISSION_PLAN_INPUT_SCHEMA, 'mission_plan') },
    });
    if (!response.output_parsed) throw new Error('LLM returned no parsed mission plan');
    const parsed = response.output_parsed as { tools?: Array<Record<string, unknown>> };
    const normalized = { ...parsed, tools: parsed.tools?.map((tool) => Object.fromEntries(
      Object.entries(tool).filter(([, value]) => value !== null),
    )) };
    const plan = validateMissionPlan(normalized);
    return { ...plan, requestId, anomalyId: anomaly.id };
  }

  async report(anomaly: Anomaly, plan: MissionPlan, observation: ObservationSummary): Promise<IncidentReport> {
    const response = await this.parse({
      model: this.model,
      instructions: 'Return exactly one schema-bound incident report. Low confidence or missing observation must escalate for human review.',
      input: JSON.stringify({ anomaly, plan, observation }),
      text: { format: zodOutputFormat(INCIDENT_REPORT_INPUT_SCHEMA, 'incident_report') },
    });
    const parsed = INCIDENT_REPORT_INPUT_SCHEMA.parse(response.output_parsed);
    return { ...parsed, missionId: plan.requestId };
  }

  private async parse(input: unknown): Promise<{ output_parsed: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.client.responses.parse(input, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
