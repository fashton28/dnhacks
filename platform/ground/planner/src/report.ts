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
  /** True only when a healthy observation pass produced reviewable evidence. */
  observationAvailable?: boolean;
  /** Best detection confidence, 0..1 (meaningful when detected). */
  confidence: number;
  /** Ground-truth label from the site staging data (demo/test paths only). */
  stagingTruth?: string;
  /** Operator/recognizer conclusion after reviewing all available modalities. */
  classification?: 'confirmed' | 'false_alarm' | 'inconclusive';
  modalities?: Array<'rgb' | 'thermal' | 'lidar' | 'fused'>;
  frames?: { rgb?: string; thermal?: string };
  geometry?: {
    fenceGaps?: Array<{ lat: number; lon: number; widthM: number }>;
    newStructures?: Array<{ lat: number; lon: number; footprintM2: number; heightM: number }>;
  };
}

/**
 * Detection confidence at/above which a detection is "confident" and the
 * incident escalates. Below it a detection is ambiguous and is logged.
 */
export const ESCALATE_CONFIDENCE = 0.6;

/** Missing evidence and low-confidence outcomes always escalate for review. */
export function reportVerdict(observation: ObservationSummary): IncidentReport['verdict'] {
  if (observation.observationAvailable !== true || observation.confidence < ESCALATE_CONFIDENCE ||
      observation.classification === 'inconclusive') return 'escalate';
  if (!observation.detected && observation.classification === 'false_alarm') return 'false_alarm';
  return observation.classification === 'confirmed' ? 'escalate' : 'log';
}

function describeTool(t: PlanTool): string {
  switch (t.tool) {
    case 'follow':
      return `follow track ${t.track_id} [${t.profile}]`;
    case 'orbit':
      return `orbit track ${t.track_id} [${t.profile}]`;
    case 'goto_relative':
      return `goto relative (${t.dx}, ${t.dy}, ${t.dz}) m`;
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

  const seen = observation.observationAvailable !== true
    ? `No reviewable observation was returned; sensor evidence is missing or unavailable.`
    : observation.detected
    ? `The onboard vision pass detected activity at the anomaly location with ` +
      `confidence ${(observation.confidence * 100).toFixed(0)}%.`
    : `A healthy observation pass found no matching activity with confidence ` +
      `${(observation.confidence * 100).toFixed(0)}%.`;
  const truthNote = observation.stagingTruth !== undefined
    ? `\n\n> Staging ground truth (demo only): \`${observation.stagingTruth}\``
    : '';

  const recommendation = {
    escalate: observation.observationAvailable !== true
      ? 'Escalate for human review because the mission returned no reviewable observation. Preserve available telemetry and retry only after sensor health is restored.'
      : observation.confidence < ESCALATE_CONFIDENCE
        ? 'Escalate for human review because the observation confidence is below the decision threshold. Preserve all modality evidence.'
        : 'Escalate to on-site security: the reviewed evidence confirms activity at the flagged location. Preserve the mission evidence.',
    log:
      'Log for review: something was observed but below the confidence bar ' +
      'for escalation. Schedule a follow-up pass or manual review of the ' +
      'captured imagery.',
    false_alarm:
      'Close as a reviewed false alarm: the high-confidence multimodal observation ' +
      'supports that classification. Retain the evidence for audit.',
  }[verdict];

  const modalities = observation.modalities?.length ? observation.modalities.join(', ') : 'not supplied';
  const frameCitations = [
    observation.frames?.rgb ? `- RGB frame: [evidence](${observation.frames.rgb})` : '- RGB frame: unavailable',
    observation.frames?.thermal ? `- Thermal frame: [evidence](${observation.frames.thermal})` : '- Thermal frame: unavailable',
  ].join('\n');
  const geometry = [
    ...(observation.geometry?.fenceGaps ?? []).map((gap) =>
      `- Fence gap at (${gap.lat.toFixed(6)}, ${gap.lon.toFixed(6)}), width ${gap.widthM} m`),
    ...(observation.geometry?.newStructures ?? []).map((structure) =>
      `- Structure at (${structure.lat.toFixed(6)}, ${structure.lon.toFixed(6)}), ` +
      `${structure.footprintM2} m² footprint, ${structure.heightM} m high`),
  ].join('\n') || '- No geometry claims supplied';

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

Modalities used: ${modalities}

${frameCitations}

### Geometry citations

${geometry}

## Recommendation

${recommendation}
`;

  return { missionId: plan.requestId, verdict, markdown };
}
