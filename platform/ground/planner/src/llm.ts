/* ============================================================================
 * eis-planner/llm — the model's ENTIRE surface: tasks and reports.
 *
 * The model emits schema-bound JSON only. There is no path from this file to a
 * plan, a coordinate, an altitude, a radius, a speed, a tool call, a setpoint
 * or a mode change (ADR D19/D20, docs/THREAT_MODEL.md § A6.3). Plan generation
 * moved to `deterministic.ts` and the LLM plan path was REMOVED — not made
 * optional — so there is nothing to re-enable by configuration.
 *
 * Provider: OpenAI (ADR D19), reached only when `EIS_PLANNER_MODE=live` and a
 * key is present. Every failure class — timeout, refusal, malformed output,
 * schema violation — is the caller's cue to fall back to the scripted path.
 * Loaded only in the Electron main process / a Node host, never the renderer.
 * ========================================================================== */
import * as fs from 'fs';
import * as path from 'path';
import OpenAI from 'openai';
import { zodTextFormat as zodOutputFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { Anomaly, IncidentReport, MissionPlan, Task, TASK_QUESTION_MAX_CHARS } from './contract';
import { ObservationSummary } from './report';

export const DEFAULT_LLM_MODEL = 'gpt-5.5';
export const LLM_TIMEOUT_MS = 20_000;
/** Attempts before the scripted triage takes over (ADR D19: two, then scripted). */
export const LLM_TRIAGE_ATTEMPTS = 2;

/** The reviewable prompt lives next to the code it drives. */
export const TRIAGE_PROMPT_FILE = path.resolve(__dirname, '../prompts/triage.md');

/**
 * The ONLY schema the model may emit for tasking. No lat, no lon, no alt, no
 * radius, no speed, no profile, no tool: a task says WHAT to look for and WHY,
 * and the deterministic planner decides everything about how to fly.
 */
export const TASK_LIST_SCHEMA = z.strictObject({
  tasks: z.array(z.strictObject({
    anomalyId: z.string(),
    lookFor: z.enum(['person', 'vehicle', 'fence_gap', 'structure', 'unknown']),
    question: z.string(),
    urgency: z.enum(['immediate', 'next_sortie', 'defer']),
    priority: z.number(),
    rationale: z.string(),
  })),
});
export type TaskListOutput = z.infer<typeof TASK_LIST_SCHEMA>;

export const INCIDENT_REPORT_INPUT_SCHEMA = z.object({
  missionId: z.string(), verdict: z.enum(['false_alarm', 'log', 'escalate']), markdown: z.string(),
});

interface ResponsesClient {
  responses: { parse(input: unknown, options?: { signal?: AbortSignal }): Promise<{ output_parsed: unknown }> };
}

/** Live mode is opt-in and never the default (ADR D4). */
export function llmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EIS_PLANNER_MODE === 'live' && Boolean(env.OPENAI_API_KEY);
}

export function createLlmClient(env: NodeJS.ProcessEnv = process.env): LlmClient | null {
  if (!llmEnabled(env)) return null;
  return new LlmClient({ apiKey: env.OPENAI_API_KEY, model: env.EIS_LLM_MODEL });
}

/** Fallback prompt text, used when `prompts/triage.md` cannot be read. */
const EMBEDDED_TRIAGE_PROMPT =
  'You triage security cues at a power station. Emit schema-bound JSON only: an ordered list of tasks. ' +
  'A task names WHAT to look for and WHY. You never choose a route, an altitude, a radius, a speed, a ' +
  'profile or a vehicle, and you never emit coordinates. Order the list most urgent first.';

/** Read the reviewable triage prompt; never throws, never blocks on a network. */
export function triagePrompt(file: string = TRIAGE_PROMPT_FILE): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return EMBEDDED_TRIAGE_PROMPT;
  }
}

/**
 * Longest evidence REFERENCE that is worth sending to the model. A path or an
 * id under this length is information; anything longer is a payload wearing a
 * string's clothes (FM-79).
 */
export const EVIDENCE_REF_MAX_CHARS = 160;

/**
 * Replace an image payload with a description of it. A data URL is inert to a
 * text model — the baked anomaly's thumbnail alone is a 10,010-character
 * base64 blob, ~2.9k tokens of nothing, on the demo's critical path — and a
 * long opaque string is untrusted input the model should not be reading either
 * way. `report.ts` has done this for the operator-facing markdown since it was
 * written; this is its counterpart on the prompt side.
 */
export function describeEvidenceRef(value?: string): string | null {
  if (!value) return null;
  if (/^data:[a-z0-9.+/-]+;base64,/i.test(value)) {
    const kind = /^data:(image\/[a-z0-9.+-]+)/i.exec(value)?.[1] ?? 'binary';
    return `embedded ${kind} attachment (${value.length} chars, omitted)`;
  }
  const normalized = value.replaceAll('\\', '/');
  if (normalized.length <= EVIDENCE_REF_MAX_CHARS && !normalized.includes('..') &&
      /^[a-zA-Z0-9._/-]+$/.test(normalized)) return normalized;
  return 'evidence reference supplied and omitted';
}

/**
 * What the model is shown for an incident report: the plan and the observation
 * verbatim (they are all numbers and enums), and every image payload reduced to
 * a description of itself. No behaviour depends on the omitted bytes — the
 * report writer cites the reference, never the pixels.
 */
export function reportPayload(anomaly: Anomaly, plan: MissionPlan,
  observation: ObservationSummary): Record<string, unknown> {
  const frames = observation.frames;
  return {
    anomaly: { ...anomaly, thumbnail: describeEvidenceRef(anomaly.thumbnail) },
    plan,
    observation: {
      ...observation,
      ...(frames ? {
        frames: {
          ...(frames.rgb === undefined ? {} : { rgb: describeEvidenceRef(frames.rgb) }),
          ...(frames.thermal === undefined ? {} : { thermal: describeEvidenceRef(frames.thermal) }),
        },
      } : {}),
    },
  };
}

export class LlmClient {
  private readonly client: ResponsesClient;
  readonly model: string;
  readonly timeoutMs: number;

  constructor(opts: { apiKey?: string; model?: string; timeoutMs?: number; client?: ResponsesClient } = {}) {
    this.client = opts.client ?? new OpenAI(opts.apiKey ? { apiKey: opts.apiKey } : {}) as unknown as ResponsesClient;
    this.model = opts.model || DEFAULT_LLM_MODEL;
    this.timeoutMs = opts.timeoutMs ?? LLM_TIMEOUT_MS;
  }

  /**
   * Order open anomalies into tasks. `input` is already-summarised state (no
   * imagery, no site geometry): the model is judging urgency, not geometry.
   * Returns tasks with `source: 'llm'`; anything not matching a known anomaly
   * id, or exceeding the question length, is dropped by the caller.
   */
  async triage(input: Record<string, unknown>): Promise<TaskListOutput> {
    const response = await this.parse({
      model: this.model,
      instructions: triagePrompt(),
      input: JSON.stringify(input),
      text: { format: zodOutputFormat(TASK_LIST_SCHEMA, 'task_list') },
    });
    if (!response.output_parsed) throw new Error('LLM returned no parsed task list');
    return TASK_LIST_SCHEMA.parse(response.output_parsed);
  }

  async report(anomaly: Anomaly, plan: MissionPlan, observation: ObservationSummary): Promise<IncidentReport> {
    const response = await this.parse({
      model: this.model,
      instructions: 'Return exactly one schema-bound incident report. Low confidence or missing observation must escalate for human review.',
      input: JSON.stringify(reportPayload(anomaly, plan, observation)),
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

/** Model output is untrusted text: this is where it stops being a wire type. */
export function taskFromModel(entry: TaskListOutput['tasks'][number], index: number,
  knownAnomalyIds: Set<string>): Task | null {
  if (!knownAnomalyIds.has(entry.anomalyId)) return null;
  const priority = Number.isFinite(entry.priority) ? Math.min(1, Math.max(0, entry.priority)) : 0;
  return {
    taskId: `task-${entry.anomalyId}-${index}`,
    anomalyId: entry.anomalyId,
    lookFor: entry.lookFor,
    question: entry.question.slice(0, TASK_QUESTION_MAX_CHARS),
    urgency: entry.urgency,
    priority,
    rationale: entry.rationale,
    source: 'llm',
  };
}
