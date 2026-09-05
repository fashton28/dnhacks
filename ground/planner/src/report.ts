/* ============================================================================
 * eis-planner/report — scripted (deterministic, no-network) incident report
 * writer. The live LLM report writer lives in llm.ts; this is the default
 * demo/test path. Pure function of its inputs — no Date, no randomness.
 * ========================================================================== */

import { Anomaly, IncidentReport, MissionPlan, PlanTool } from './contract';

/** What the observation pass saw at the anomaly location. */
export interface ObservationSummary {
  /** Did the vision pass detect anything at the location? */
  detected: boolean;
  /** Best detection confidence, 0..1 (meaningful when detected). */
  confidence: number;
  /** Ground-truth label from the site staging data (demo/test paths only). */
  stagingTruth?: string;
}

/**
 * Detection confidence at/above which a detection is "confident" and the
 * incident escalates. Below it a detection is ambiguous and is logged.
 */
export const ESCALATE_CONFIDENCE = 0.6;

/** Verdict mapping: confident detection -> 'escalate'; nothing seen ->
 *  'false_alarm'; ambiguous (seen, low confidence) -> 'log'. */
export function reportVerdict(observation: ObservationSummary): IncidentReport['verdict'] {
  if (!observation.detected) return 'false_alarm';
  return observation.confidence >= ESCALATE_CONFIDENCE ? 'escalate' : 'log';
}

function describeTool(t: PlanTool): string {
  switch (t.tool) {
    case 'goto_gps':
      return `goto (${t.lat.toFixed(6)}, ${t.lon.toFixed(6)}) at ${t.alt} m AGL` +
        (t.profile ? ` [${t.profile}]` : '');
    case 'orbit_point':
      return `orbit (${t.lat.toFixed(6)}, ${t.lon.toFixed(6)}) radius ${t.radius} m`;
    case 'hold':
      return t.durationS !== undefined ? `hold ${t.durationS} s` : 'hold (indefinite)';
    case 'rtl':
      return 'return to launch';
  }
}

/**
 * Write the scripted incident report for a completed observation mission.
 * `missionId` is the plan's requestId (ground-side correlation only).
 */
export function writeIncidentReport(
  anomaly: Anomaly,
  plan: MissionPlan,
  observation: ObservationSummary,
): IncidentReport {
  const verdict = reportVerdict(observation);

  const seen = observation.detected
    ? `The onboard vision pass detected activity at the anomaly location with ` +
      `confidence ${(observation.confidence * 100).toFixed(0)}%.`
    : `The onboard vision pass detected nothing of note at the anomaly location.`;
  const truthNote = observation.stagingTruth !== undefined
    ? `\n\n> Staging ground truth (demo only): \`${observation.stagingTruth}\``
    : '';

  const recommendation = {
    escalate:
      'Escalate to on-site security immediately: a confident detection at a ' +
      'flagged location warrants human response. Preserve the mission video ' +
      'and this report for the incident record.',
    log:
      'Log for review: something was observed but below the confidence bar ' +
      'for escalation. Schedule a follow-up pass or manual review of the ' +
      'captured imagery.',
    false_alarm:
      'Close as a false alarm: the satellite change flag was not confirmed by ' +
      'the drone observation. No further action required; retain for audit.',
  }[verdict];

  const markdown = `# Incident report — anomaly ${anomaly.id}

**Verdict: ${verdict}**

## What was flagged

Satellite change detection flagged a \`${anomaly.type}\` anomaly at ` +
    `(${anomaly.lat.toFixed(6)}, ${anomaly.lon.toFixed(6)}) with confidence ` +
    `${(anomaly.confidence * 100).toFixed(0)}% (thumbnail: \`${anomaly.thumbnail}\`).

## What flew

Verified mission \`${plan.requestId}\` (profile \`${plan.profile}\`):

${plan.tools.map((t, i) => `${i + 1}. ${describeTool(t)}`).join('\n')}

Planner rationale: ${plan.rationale}

## What was seen

${seen}${truthNote}

## Recommendation

${recommendation}
`;

  return { missionId: plan.requestId, verdict, markdown };
}
