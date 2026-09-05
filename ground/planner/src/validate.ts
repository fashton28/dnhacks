/* ============================================================================
 * eis-planner/validate — runtime validation of untyped wire/JSON input into
 * contract types. Used by the CLI (files from disk) and the LLM planner
 * (tool_use input). Throws descriptive Errors on invalid input.
 * ========================================================================== */

import { Anomaly, MissionPlan, MissionProfile, PlanTool, PROFILE_SPEED_MPS } from './contract';
import { ObservationSummary } from './report';

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isProfile(v: unknown): v is MissionProfile {
  return typeof v === 'string' && v in PROFILE_SPEED_MPS;
}

function validateTool(v: unknown, ctx: string): PlanTool {
  if (typeof v !== 'object' || v === null) {
    throw new Error(`${ctx} must be an object`);
  }
  const t = v as Record<string, unknown>;
  switch (t.tool) {
    case 'goto_gps': {
      if (!isFiniteNumber(t.lat) || !isFiniteNumber(t.lon) || !isFiniteNumber(t.alt)) {
        throw new Error(`${ctx} (goto_gps) requires numeric lat, lon, alt`);
      }
      if (t.profile !== undefined && !isProfile(t.profile)) {
        throw new Error(`${ctx} (goto_gps) has invalid profile ${JSON.stringify(t.profile)}`);
      }
      const out: PlanTool = { tool: 'goto_gps', lat: t.lat, lon: t.lon, alt: t.alt };
      if (t.profile !== undefined) out.profile = t.profile as MissionProfile;
      return out;
    }
    case 'orbit_point': {
      if (!isFiniteNumber(t.lat) || !isFiniteNumber(t.lon) || !isFiniteNumber(t.radius)) {
        throw new Error(`${ctx} (orbit_point) requires numeric lat, lon, radius`);
      }
      return { tool: 'orbit_point', lat: t.lat, lon: t.lon, radius: t.radius };
    }
    case 'hold': {
      if (t.durationS !== undefined && !isFiniteNumber(t.durationS)) {
        throw new Error(`${ctx} (hold) durationS must be a number when present`);
      }
      return t.durationS !== undefined
        ? { tool: 'hold', durationS: t.durationS as number }
        : { tool: 'hold' };
    }
    case 'rtl':
      return { tool: 'rtl' };
    default:
      throw new Error(`${ctx} has unknown tool ${JSON.stringify(t.tool)}`);
  }
}

/** Validate untyped data as a contract MissionPlan. Throws on bad input. */
export function validateMissionPlan(data: unknown): MissionPlan {
  if (typeof data !== 'object' || data === null) {
    throw new Error('invalid MissionPlan: must be an object');
  }
  const d = data as Record<string, unknown>;
  if (typeof d.requestId !== 'string' || d.requestId === '') {
    throw new Error('invalid MissionPlan: requestId must be a non-empty string');
  }
  if (typeof d.anomalyId !== 'string') {
    throw new Error('invalid MissionPlan: anomalyId must be a string');
  }
  if (!isProfile(d.profile)) {
    throw new Error(`invalid MissionPlan: profile must be one of ${Object.keys(PROFILE_SPEED_MPS).join('|')}`);
  }
  if (typeof d.rationale !== 'string') {
    throw new Error('invalid MissionPlan: rationale must be a string');
  }
  if (!Array.isArray(d.tools) || d.tools.length === 0) {
    throw new Error('invalid MissionPlan: tools must be a non-empty array');
  }
  const tools = d.tools.map((t, i) => validateTool(t, `invalid MissionPlan: tools[${i}]`));
  return {
    requestId: d.requestId,
    anomalyId: d.anomalyId,
    tools,
    profile: d.profile,
    rationale: d.rationale,
  };
}

/** Validate untyped data as a contract Anomaly. Throws on bad input. */
export function validateAnomaly(data: unknown): Anomaly {
  if (typeof data !== 'object' || data === null) {
    throw new Error('invalid Anomaly: must be an object');
  }
  const d = data as Record<string, unknown>;
  if (typeof d.id !== 'string' || d.id === '') {
    throw new Error('invalid Anomaly: id must be a non-empty string');
  }
  if (!isFiniteNumber(d.lat) || !isFiniteNumber(d.lon)) {
    throw new Error('invalid Anomaly: lat/lon must be finite numbers');
  }
  if (typeof d.type !== 'string') {
    throw new Error('invalid Anomaly: type must be a string');
  }
  if (!isFiniteNumber(d.confidence) || d.confidence < 0 || d.confidence > 1) {
    throw new Error('invalid Anomaly: confidence must be a number in [0, 1]');
  }
  if (typeof d.thumbnail !== 'string') {
    throw new Error('invalid Anomaly: thumbnail must be a string');
  }
  return {
    id: d.id, lat: d.lat, lon: d.lon,
    type: d.type, confidence: d.confidence, thumbnail: d.thumbnail,
  };
}

/** Validate untyped data as an ObservationSummary. Throws on bad input. */
export function validateObservation(data: unknown): ObservationSummary {
  if (typeof data !== 'object' || data === null) {
    throw new Error('invalid observation: must be an object');
  }
  const d = data as Record<string, unknown>;
  if (typeof d.detected !== 'boolean') {
    throw new Error('invalid observation: detected must be a boolean');
  }
  if (!isFiniteNumber(d.confidence) || d.confidence < 0 || d.confidence > 1) {
    throw new Error('invalid observation: confidence must be a number in [0, 1]');
  }
  if (d.stagingTruth !== undefined && typeof d.stagingTruth !== 'string') {
    throw new Error('invalid observation: stagingTruth must be a string when present');
  }
  const out: ObservationSummary = { detected: d.detected, confidence: d.confidence };
  if (d.stagingTruth !== undefined) out.stagingTruth = d.stagingTruth as string;
  return out;
}
