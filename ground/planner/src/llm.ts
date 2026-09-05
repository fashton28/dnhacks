/* ============================================================================
 * eis-planner/llm — live LLM planner + report writer (Node-side ONLY).
 *
 * THE LLM EMITS TOOL CALLS ONLY. It is forced (tool_choice {type:'tool'})
 * into a single strict tool per request:
 *   - submit_mission_plan   : input_schema mirrors the contract MissionPlan
 *   - submit_incident_report: input_schema mirrors the contract IncidentReport
 * The tool_use input is parsed and runtime-validated; free text is never
 * consumed. A deterministic MissionVerifier then validates every plan — the
 * LLM is advisory and NEVER flight-critical (PRD §12: no cloud dependency
 * for flight).
 *
 * Guard: nothing on the default demo/test path touches the network.
 * createLlmPlanner() returns null unless BOTH:
 *   EIS_PLANNER_MODE === 'live'  AND  ANTHROPIC_API_KEY is set.
 * Callers fall back to ScriptedPlanner / writeIncidentReport otherwise.
 *
 * Model: 'claude-opus-5', overridable via EIS_LLM_MODEL. temperature/top_p
 * are NOT sent (rejected on this model). Non-streaming, max_tokens 4096.
 * ========================================================================== */

import Anthropic from '@anthropic-ai/sdk';
import { Anomaly, IncidentReport, MissionPlan, PROFILE_SPEED_MPS } from './contract';
import { ObservationSummary } from './report';
import { SiteModel } from './site';
import { validateMissionPlan } from './validate';

export const DEFAULT_LLM_MODEL = 'claude-opus-5';

/* ---------------------------------------------------------------------------
 * Strict tool schemas (additionalProperties:false everywhere, all properties
 * required — optional contract fields are made required in the schema, which
 * is still assignable to the contract type).
 * ------------------------------------------------------------------------- */

const PROFILES = Object.keys(PROFILE_SPEED_MPS); // ['slow','standard','fast']

const GOTO_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  required: ['tool', 'lat', 'lon', 'alt', 'profile'],
  properties: {
    tool: { type: 'string', enum: ['goto_gps'] },
    lat: { type: 'number', description: 'target latitude, WGS84 decimal degrees' },
    lon: { type: 'number', description: 'target longitude, WGS84 decimal degrees' },
    alt: { type: 'number', description: 'target altitude, meters AGL relative to home' },
    profile: { type: 'string', enum: PROFILES, description: 'speed profile for this leg' },
  },
};

const ORBIT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  required: ['tool', 'lat', 'lon', 'radius'],
  properties: {
    tool: { type: 'string', enum: ['orbit_point'] },
    lat: { type: 'number', description: 'orbit center latitude, WGS84 decimal degrees' },
    lon: { type: 'number', description: 'orbit center longitude, WGS84 decimal degrees' },
    radius: { type: 'number', description: 'orbit radius, meters (>= 3)' },
  },
};

const HOLD_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  required: ['tool', 'durationS'],
  properties: {
    tool: { type: 'string', enum: ['hold'] },
    durationS: { type: 'number', description: 'hold duration, seconds' },
  },
};

const RTL_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  required: ['tool'],
  properties: {
    tool: { type: 'string', enum: ['rtl'] },
  },
};

/** input_schema mirroring the contract MissionPlan exactly. */
export const MISSION_PLAN_INPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  required: ['requestId', 'anomalyId', 'tools', 'profile', 'rationale'],
  properties: {
    requestId: { type: 'string', description: 'echo the requestId given in the prompt verbatim' },
    anomalyId: { type: 'string', description: 'id of the anomaly this plan responds to' },
    tools: {
      type: 'array',
      description: 'ordered mission steps; end with rtl',
      items: { anyOf: [GOTO_SCHEMA, ORBIT_SCHEMA, HOLD_SCHEMA, RTL_SCHEMA] },
    },
    profile: { type: 'string', enum: PROFILES, description: 'default speed profile for the mission' },
    rationale: { type: 'string', description: 'one short paragraph explaining the plan' },
  },
};

/** input_schema mirroring the contract IncidentReport exactly. */
export const INCIDENT_REPORT_INPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  required: ['missionId', 'verdict', 'markdown'],
  properties: {
    missionId: { type: 'string', description: 'echo the missionId given in the prompt verbatim' },
    verdict: { type: 'string', enum: ['false_alarm', 'log', 'escalate'] },
    markdown: {
      type: 'string',
      description:
        'the full report in Markdown with sections: What was flagged, What flew, ' +
        'What was seen, Recommendation',
    },
  },
};

/* ---------------------------------------------------------------------------
 * Guarded construction
 * ------------------------------------------------------------------------- */

/** True when the environment opts into the live LLM path. */
export function llmPlannerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EIS_PLANNER_MODE === 'live' &&
    typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY !== '';
}

/**
 * Construct the live planner ONLY when EIS_PLANNER_MODE=live and
 * ANTHROPIC_API_KEY is present; otherwise returns null and callers must use
 * ScriptedPlanner / writeIncidentReport (the no-network default).
 */
export function createLlmPlanner(env: NodeJS.ProcessEnv = process.env): LlmPlanner | null {
  if (!llmPlannerEnabled(env)) return null;
  return new LlmPlanner({ model: env.EIS_LLM_MODEL });
}

/* ---------------------------------------------------------------------------
 * Planner
 * ------------------------------------------------------------------------- */

function serializeSiteConstraints(site: SiteModel): string {
  const ring = (poly: { lat: number; lon: number }[]) =>
    JSON.stringify(poly.map((p) => [p.lat, p.lon]));
  const lines = [
    `home (launch/land): lat ${site.home.lat}, lon ${site.home.lon}`,
    `perimeter (outer geofence — NEVER leave it), [lat,lon] open ring: ${ring(site.perimeter)}`,
    `permitted altitude band: ${site.altBandM.min}..${site.altBandM.max} m AGL`,
    ...site.nfz.map((z) =>
      `no-fly zone "${z.name}" — forbidden AT OR BELOW ${z.ceilingM} m AGL inside ` +
      `[lat,lon] ring ${ring(z.polygon)}`),
    `speed profiles (m/s): ${JSON.stringify(PROFILE_SPEED_MPS)}`,
  ];
  return lines.join('\n');
}

export class LlmPlanner {
  private readonly client: Anthropic;
  readonly model: string;

  constructor(opts: { apiKey?: string; model?: string } = {}) {
    // The SDK reads ANTHROPIC_API_KEY from the environment when not given.
    this.client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.model = opts.model && opts.model !== '' ? opts.model : DEFAULT_LLM_MODEL;
  }

  /**
   * Ask the LLM for a MissionPlan via a forced strict tool call.
   * The returned plan has requestId/anomalyId pinned to the caller's values
   * regardless of what the model echoed, so ground-side correlation can
   * never be broken by the model.
   */
  async plan(site: SiteModel, anomaly: Anomaly, requestId: string): Promise<MissionPlan> {
    const prompt =
      `You plan a short observation mission for a security drone at a power plant.\n\n` +
      `A satellite change-detection pass flagged this anomaly:\n` +
      `${JSON.stringify(anomaly, null, 2)}\n\n` +
      `Site constraints (hard rules — a deterministic MissionVerifier will check ` +
      `your plan against every one of them and will correct or reject it):\n` +
      `${serializeSiteConstraints(site)}\n\n` +
      `Plan: fly to the anomaly, observe it (an orbit of ~25 m radius works well), ` +
      `then return to launch. Keep every waypoint inside the perimeter, outside ` +
      `every no-fly zone at your altitude, and inside the altitude band.\n\n` +
      `Use requestId "${requestId}" and anomalyId "${anomaly.id}" verbatim.\n` +
      `Submit the plan ONLY by calling the submit_mission_plan tool.`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      tools: [{
        name: 'submit_mission_plan',
        description:
          'Submit the drone mission plan. The only way to answer — never reply in prose.',
        strict: true,
        input_schema: MISSION_PLAN_INPUT_SCHEMA,
      }],
      tool_choice: { type: 'tool', name: 'submit_mission_plan' },
      messages: [{ role: 'user', content: prompt }],
    });

    const input = extractToolInput(response, 'submit_mission_plan');
    const plan = validateMissionPlan(input);
    // Pin correlation ids to the caller's values.
    return { ...plan, requestId, anomalyId: anomaly.id };
  }

  /**
   * Ask the LLM to write the IncidentReport via a forced strict tool call.
   * `missionId` is pinned to plan.requestId regardless of the model's echo.
   */
  async report(
    anomaly: Anomaly,
    plan: MissionPlan,
    observation: ObservationSummary,
  ): Promise<IncidentReport> {
    const prompt =
      `Write the incident report for a completed drone observation mission at a ` +
      `power plant.\n\n` +
      `Flagged anomaly:\n${JSON.stringify(anomaly, null, 2)}\n\n` +
      `Executed (verifier-approved) plan:\n${JSON.stringify(plan, null, 2)}\n\n` +
      `Observation result:\n${JSON.stringify(observation, null, 2)}\n\n` +
      `Verdict rules: confident detection (confidence >= 0.6) -> "escalate"; ` +
      `nothing detected -> "false_alarm"; detected but ambiguous -> "log".\n` +
      `The markdown must contain these sections: "What was flagged", "What flew", ` +
      `"What was seen", "Recommendation".\n` +
      `Use missionId "${plan.requestId}" verbatim.\n` +
      `Submit ONLY by calling the submit_incident_report tool.`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      tools: [{
        name: 'submit_incident_report',
        description:
          'Submit the incident report. The only way to answer — never reply in prose.',
        strict: true,
        input_schema: INCIDENT_REPORT_INPUT_SCHEMA,
      }],
      tool_choice: { type: 'tool', name: 'submit_incident_report' },
      messages: [{ role: 'user', content: prompt }],
    });

    const input = extractToolInput(response, 'submit_incident_report') as Record<string, unknown>;
    const verdict = input.verdict;
    if (verdict !== 'false_alarm' && verdict !== 'log' && verdict !== 'escalate') {
      throw new Error(`LLM report has invalid verdict ${JSON.stringify(verdict)}`);
    }
    if (typeof input.markdown !== 'string' || input.markdown === '') {
      throw new Error('LLM report has no markdown body');
    }
    return { missionId: plan.requestId, verdict, markdown: input.markdown };
  }
}

/** Pull the (typed) input off the forced tool_use block; never read free text. */
function extractToolInput(response: Anthropic.Message, toolName: string): unknown {
  if (response.stop_reason === 'refusal') {
    throw new Error(`LLM refused the ${toolName} request (stop_reason: refusal)`);
  }
  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === toolName) {
      return block.input;
    }
  }
  throw new Error(`LLM response contains no ${toolName} tool_use block`);
}
