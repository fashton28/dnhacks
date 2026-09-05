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
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PROFILE_SPEED_MPS, v);
}

function safeFrameRef(value: unknown): value is string {
  return typeof value === 'string' && (value.startsWith('data:image/') ||
    (!/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.includes('..') && !value.startsWith('/') && !value.startsWith('\\')));
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
      if (!isFiniteNumber(trackId) || !Number.isInteger(trackId) || trackId < 0 || !isProfile(t.profile)) {
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
      if (t.alt_m !== undefined && t.alt !== undefined && t.alt_m !== t.alt) {
        throw new Error(`${ctx} (goto_gps) has conflicting alt and alt_m values`);
      }
      const alt = t.alt_m ?? t.alt;
      if (!isFiniteNumber(t.lat) || t.lat < -90 || t.lat > 90 ||
          !isFiniteNumber(t.lon) || t.lon < -180 || t.lon > 180 || !isFiniteNumber(alt)) {
        throw new Error(`${ctx} (goto_gps) requires numeric lat, lon, alt_m (or legacy alt)`);
      }
      if (t.profile !== undefined && !isProfile(t.profile)) {
        throw new Error(`${ctx} (goto_gps) has invalid profile ${JSON.stringify(t.profile)}`);
      }
      if (t.speed_mps !== undefined && (!isFiniteNumber(t.speed_mps) || t.speed_mps <= 0)) {
        throw new Error(`${ctx} (goto_gps) speed_mps must be positive and finite when present`);
      }
      const out: PlanTool = { tool: 'goto_gps', lat: t.lat, lon: t.lon, alt };
      if (t.alt_m !== undefined) out.alt_m = alt;
      if (t.profile !== undefined) out.profile = t.profile as MissionProfile;
      if (t.speed_mps !== undefined) out.speed_mps = t.speed_mps as number;
      return out;
    }
    case 'orbit_point': {
      if (t.radius_m !== undefined && t.radius !== undefined && t.radius_m !== t.radius) {
        throw new Error(`${ctx} (orbit_point) has conflicting radius and radius_m values`);
      }
      const radius = t.radius_m ?? t.radius;
      if (!isFiniteNumber(t.lat) || t.lat < -90 || t.lat > 90 ||
          !isFiniteNumber(t.lon) || t.lon < -180 || t.lon > 180 ||
          !isFiniteNumber(radius) || radius <= 0) {
        throw new Error(`${ctx} (orbit_point) requires numeric lat, lon, radius_m (or legacy radius)`);
      }
      if (t.laps !== undefined && (!isFiniteNumber(t.laps) || !Number.isInteger(t.laps) || t.laps <= 0)) {
        throw new Error(`${ctx} (orbit_point) laps must be a positive integer when present`);
      }
      return {
        tool: 'orbit_point', lat: t.lat, lon: t.lon, radius,
        ...(t.radius_m !== undefined ? { radius_m: radius } : {}),
        ...(t.laps !== undefined ? { laps: t.laps as number } : {}),
      };
    }
    case 'hold': {
      if (t.duration_s !== undefined && t.durationS !== undefined && t.duration_s !== t.durationS) {
        throw new Error(`${ctx} (hold) has conflicting durationS and duration_s values`);
      }
      const duration = t.duration_s ?? t.durationS;
      if (duration !== undefined && (!isFiniteNumber(duration) || duration < 0)) {
        throw new Error(`${ctx} (hold) duration_s must be finite and non-negative when present`);
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
  if (!isFiniteNumber(d.lat) || d.lat < -90 || d.lat > 90 ||
      !isFiniteNumber(d.lon) || d.lon < -180 || d.lon > 180) {
    throw new Error('invalid Anomaly: lat/lon must be finite coordinates');
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
    'sentinel2', 'sar', 'sdr', 'rf_drone', 'drone_survey', 'cctv',
  ];
  // Pre-Phase1 anomaly files are interpreted as optical satellite cues.
  const source = d.source === undefined ? 'sentinel2' : d.source;
  if (typeof source !== 'string' || !sources.includes(source as AnomalySource)) {
    throw new Error(`invalid Anomaly: source must be one of ${sources.join('|')}`);
  }
  return {
    id: d.id, lat: d.lat, lon: d.lon,
    type: d.type, confidence: d.confidence, thumbnail: d.thumbnail,
    source: source as AnomalySource,
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
  if (d.observationAvailable !== undefined && typeof d.observationAvailable !== 'boolean') {
    throw new Error('invalid observation: observationAvailable must be boolean when present');
  }
  if (d.observationAvailable !== undefined) out.observationAvailable = d.observationAvailable;
  if (d.stagingTruth !== undefined) out.stagingTruth = d.stagingTruth as string;
  if (d.classification !== undefined) {
    if (d.classification !== 'confirmed' && d.classification !== 'false_alarm' && d.classification !== 'inconclusive') {
      throw new Error('invalid observation: classification must be confirmed|false_alarm|inconclusive');
    }
    out.classification = d.classification;
  }
  if (d.modalities !== undefined) {
    if (!Array.isArray(d.modalities) || d.modalities.some((m) => !['rgb', 'thermal', 'lidar', 'fused'].includes(String(m)))) {
      throw new Error('invalid observation: modalities must contain rgb|thermal|lidar|fused');
    }
    out.modalities = d.modalities as ObservationSummary['modalities'];
  }
  if (d.frames !== undefined) {
    if (typeof d.frames !== 'object' || d.frames === null) throw new Error('invalid observation: frames must be an object');
    const frames = d.frames as Record<string, unknown>;
    if ((frames.rgb !== undefined && !safeFrameRef(frames.rgb)) ||
        (frames.thermal !== undefined && !safeFrameRef(frames.thermal))) {
      throw new Error('invalid observation: frame references must be local paths or image data URLs');
    }
    out.frames = { ...(frames.rgb === undefined ? {} : { rgb: frames.rgb as string }),
      ...(frames.thermal === undefined ? {} : { thermal: frames.thermal as string }) };
  }
  if (d.geometry !== undefined) {
    if (typeof d.geometry !== 'object' || d.geometry === null) throw new Error('invalid observation: geometry must be an object');
    const geometry = d.geometry as Record<string, unknown>;
    const fenceGaps = geometry.fenceGaps ?? [];
    const newStructures = geometry.newStructures ?? [];
    if (!Array.isArray(fenceGaps) || !Array.isArray(newStructures)) throw new Error('invalid observation: geometry arrays are required');
    const gaps = fenceGaps.map((entry, index) => {
      const gap = entry as Record<string, unknown>;
      if (!gap || !isFiniteNumber(gap.lat) || !isFiniteNumber(gap.lon) || !isFiniteNumber(gap.widthM) || gap.widthM < 0) {
        throw new Error(`invalid observation: fenceGaps[${index}] has invalid geometry`);
      }
      return { lat: gap.lat, lon: gap.lon, widthM: gap.widthM };
    });
    const structures = newStructures.map((entry, index) => {
      const structure = entry as Record<string, unknown>;
      if (!structure || !isFiniteNumber(structure.lat) || !isFiniteNumber(structure.lon) ||
          !isFiniteNumber(structure.footprintM2) || structure.footprintM2 < 0 ||
          !isFiniteNumber(structure.heightM) || structure.heightM < 0) {
        throw new Error(`invalid observation: newStructures[${index}] has invalid geometry`);
      }
      return { lat: structure.lat, lon: structure.lon, footprintM2: structure.footprintM2, heightM: structure.heightM };
    });
    out.geometry = { fenceGaps: gaps, newStructures: structures };
  }
  return out;
}
