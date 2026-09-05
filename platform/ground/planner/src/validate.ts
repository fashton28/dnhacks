/* ============================================================================
 * eis-planner/validate — runtime validation of untyped wire/JSON input into
 * contract types. Used by the CLI (files from disk) and the LLM planner
 * (tool_use input). Throws descriptive Errors on invalid input.
 * ========================================================================== */

import {
  Anomaly, AnomalySource, MissionPlan, MissionProfile, PlanTool, PROFILE_SPEED_MPS,
} from './contract';
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
    case 'follow':
    case 'orbit': {
      const trackId = t.track_id ?? t.trackId;
      if (!isFiniteNumber(trackId) || !isProfile(t.profile)) {
        throw new Error(`${ctx} (${t.tool}) requires numeric track_id and a valid profile`);
      }
      return {
        tool: t.tool,
        track_id: trackId,
        profile: t.profile,
        ...(t.trackId !== undefined ? { trackId } : {}),
      };
    }
    case 'goto_relative': {
      if (!isFiniteNumber(t.dx) || !isFiniteNumber(t.dy) || !isFiniteNumber(t.dz)) {
        throw new Error(`${ctx} (goto_relative) requires numeric dx, dy, dz`);
      }
      return { tool: 'goto_relative', dx: t.dx, dy: t.dy, dz: t.dz };
    }
    case 'goto_gps': {
      const alt = t.alt_m ?? t.alt;
      if (!isFiniteNumber(t.lat) || !isFiniteNumber(t.lon) || !isFiniteNumber(alt)) {
        throw new Error(`${ctx} (goto_gps) requires numeric lat, lon, alt_m (or legacy alt)`);
      }
      if (t.profile !== undefined && !isProfile(t.profile)) {
        throw new Error(`${ctx} (goto_gps) has invalid profile ${JSON.stringify(t.profile)}`);
      }
      if (t.speed_mps !== undefined && !isFiniteNumber(t.speed_mps)) {
        throw new Error(`${ctx} (goto_gps) speed_mps must be numeric when present`);
      }
      const out: PlanTool = { tool: 'goto_gps', lat: t.lat, lon: t.lon, alt };
      if (t.alt_m !== undefined) out.alt_m = alt;
      if (t.profile !== undefined) out.profile = t.profile as MissionProfile;
      if (t.speed_mps !== undefined) out.speed_mps = t.speed_mps as number;
      return out;
    }
    case 'orbit_point': {
      const radius = t.radius_m ?? t.radius;
      if (!isFiniteNumber(t.lat) || !isFiniteNumber(t.lon) || !isFiniteNumber(radius)) {
        throw new Error(`${ctx} (orbit_point) requires numeric lat, lon, radius_m (or legacy radius)`);
      }
      if (t.laps !== undefined && !isFiniteNumber(t.laps)) {
        throw new Error(`${ctx} (orbit_point) laps must be numeric when present`);
      }
      return {
        tool: 'orbit_point', lat: t.lat, lon: t.lon, radius,
        ...(t.radius_m !== undefined ? { radius_m: radius } : {}),
        ...(t.laps !== undefined ? { laps: t.laps as number } : {}),
      };
    }
    case 'hold': {
      const duration = t.duration_s ?? t.durationS;
      if (duration !== undefined && !isFiniteNumber(duration)) {
        throw new Error(`${ctx} (hold) duration_s must be a number when present`);
      }
      return duration !== undefined
        ? {
            tool: 'hold', durationS: duration,
            ...(t.duration_s !== undefined ? { duration_s: duration } : {}),
          }
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
  const sources: AnomalySource[] = [
    'sentinel2', 'sar', 'sdr', 'rf_drone', 'drone_survey', 'cctv', 'fence_sensor',
  ];
  // Pre-Phase1 anomaly files are interpreted as optical satellite cues.
  const source = d.source === undefined ? 'sentinel2' : d.source;
  if (typeof source !== 'string' || !sources.includes(source as AnomalySource)) {
    throw new Error(`invalid Anomaly: source must be one of ${sources.join('|')}`);
  }
  // Cue-rail freshness fields are optional (undated satellite/SAR cues remain
  // valid); when present they must be sane, and they are passed through.
  if (d.observedAt !== undefined && !isFiniteNumber(d.observedAt)) {
    throw new Error('invalid Anomaly: observedAt must be a finite epoch-ms number');
  }
  if (d.ttl_s !== undefined && (!isFiniteNumber(d.ttl_s) || d.ttl_s < 0)) {
    throw new Error('invalid Anomaly: ttl_s must be a number >= 0 (seconds)');
  }
  if (d.cameraId !== undefined && typeof d.cameraId !== 'string') {
    throw new Error('invalid Anomaly: cameraId must be a string');
  }
  const anomaly: Anomaly = {
    id: d.id, lat: d.lat, lon: d.lon,
    type: d.type, confidence: d.confidence, thumbnail: d.thumbnail,
    source: source as AnomalySource,
  };
  if (d.observedAt !== undefined) anomaly.observedAt = d.observedAt;
  if (d.ttl_s !== undefined) anomaly.ttl_s = d.ttl_s;
  if (d.cameraId !== undefined) anomaly.cameraId = d.cameraId;
  return anomaly;
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
