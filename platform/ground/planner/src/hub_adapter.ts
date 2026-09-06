/* ============================================================================
 * eis-planner/hub_adapter — the ARGUS Hub `Detection` ⟷ our `Anomaly` mapping.
 *
 * The two stacks describe the same thing in incompatible shapes (FM-160):
 *
 *   Hub `Detection` (contracts/models.py, `extra="forbid"`)
 *     id · polygon (>= 3 LatLon) · confidence · change_type · before_ref ·
 *     after_ref · detected_at (ISO 8601) · area_m2? · metadata{str: str}
 *
 *   Our `Anomaly` (contract/index.ts)
 *     id · lat · lon · type · confidence · thumbnail · source · observedAt? ·
 *     ttl_s? · cameraId?
 *
 * A Detection is an AREA with two image references and a timestamp; an Anomaly
 * is a POINT with one evidence reference and a cue lifetime. Neither is a
 * superset of the other, so before this file existed a hand-rolled POST was
 * rejected `422` on three counts at once (missing `before_ref`, missing
 * `after_ref`, extra keys) and nothing could move a cue either way.
 *
 * What the mapping is allowed to do
 * ---------------------------------
 *   - Detection → Anomaly: the polygon collapses to its centroid, which is the
 *     only point the whole area agrees on. The area itself is NOT thrown away:
 *     it is returned alongside so a caller that wants it (an off-tile badge, a
 *     survey footprint) has it without inventing it a second time.
 *   - Anomaly → Detection: a point becomes the smallest honest polygon — a
 *     square of `POINT_FOOTPRINT_M` per side centred on the cue — and the
 *     required `before_ref`/`after_ref` come from the caller, because we do not
 *     have them and MUST NOT invent an image reference a human reviewer would
 *     read as evidence. No reference, no Detection: the conversion refuses.
 *
 * What it is NOT allowed to do
 * ----------------------------
 * It never plans, never re-times a cue, and never widens a confidence. Every
 * refusal below is an explicit `AdapterError`, so a mapping failure is a
 * readable reason rather than a 422 from someone else's validator.
 * ========================================================================== */

import { Anomaly, AnomalySource } from './contract';
import { LatLon, M_PER_DEG_LAT, polygonCentroid } from './geometry';

/** `contracts.models.ChangeType` — the Hub's closed vocabulary. */
export const HUB_CHANGE_TYPES = [
  'intruder_vehicle', 'fence_breach', 'unattended_object',
  'vehicle', 'object', 'structure', 'ground_disturbance', 'unknown',
] as const;
export type HubChangeType = (typeof HUB_CHANGE_TYPES)[number];

/** `contracts.models.Detection`, exactly — no more keys, no fewer. */
export interface HubDetection {
  id: string;
  polygon: LatLon[];
  confidence: number;
  change_type: HubChangeType;
  before_ref: string;
  after_ref: string;
  /** ISO 8601, the Hub's `datetime` serialisation. */
  detected_at: string;
  area_m2: number | null;
  metadata: Record<string, string>;
}

/** Raised when a record cannot be mapped without inventing something. */
export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterError';
  }
}

/**
 * Side of the square a point-shaped cue becomes, metres. Small enough that the
 * polygon is honestly "about here" rather than a claimed footprint, and large
 * enough to survive the Hub's `min_length=3` ring and any area gate keyed off
 * `area_m2`.
 */
export const POINT_FOOTPRINT_M = 10;

/** Cue lifetime stamped on an inbound Detection when the Hub declares none. */
export const HUB_CUE_TTL_S = 3600;

/**
 * `change_type` → our anomaly `type`. Both vocabularies are open strings on
 * our side (`Anomaly.type` is the anomaly KIND), and `triage.LOOK_FOR_BY_TYPE`
 * is what turns a kind into a task, so every value below is one that table
 * already knows how to read.
 */
export const CHANGE_TYPE_TO_ANOMALY_TYPE: Record<HubChangeType, string> = {
  intruder_vehicle: 'vehicle',
  fence_breach: 'fence_gap',
  unattended_object: 'change',
  vehicle: 'vehicle',
  object: 'change',
  structure: 'structure',
  ground_disturbance: 'change',
  unknown: 'change',
};

/** The inverse, for the values the round trip has to preserve. */
export const ANOMALY_TYPE_TO_CHANGE_TYPE: Record<string, HubChangeType> = {
  vehicle: 'vehicle',
  fence_gap: 'fence_breach',
  fence: 'fence_breach',
  breach: 'fence_breach',
  structure: 'structure',
  new_structure: 'structure',
  person: 'unknown',
  intrusion: 'unknown',
  motion: 'unknown',
  hostile_drone: 'unknown',
  change: 'ground_disturbance',
  patrol: 'unknown',
};

/** Where a Detection is treated as having come from, unless it says otherwise. */
export const DEFAULT_HUB_SOURCE: AnomalySource = 'sentinel2';

const KNOWN_SOURCES: readonly AnomalySource[] = [
  'sentinel2', 'sar', 'sdr', 'rf_drone', 'drone_survey', 'cctv', 'fence_sensor',
];

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function requireLatLon(point: unknown, where: string): LatLon {
  const candidate = point as LatLon | null;
  if (!candidate || !finite(candidate.lat) || !finite(candidate.lon) ||
      candidate.lat < -90 || candidate.lat > 90 || candidate.lon < -180 || candidate.lon > 180) {
    throw new AdapterError(`${where}: polygon vertex is not a valid lat/lon`);
  }
  return { lat: candidate.lat, lon: candidate.lon };
}

/**
 * Validate an untrusted Hub record into a `HubDetection`. Mirrors the Pydantic
 * model's own constraints (`extra="forbid"` is enforced as a REJECTION here,
 * not a silent strip, so drift between the stacks is loud).
 */
export function parseHubDetection(input: unknown): HubDetection {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new AdapterError('invalid Detection: record must be an object');
  }
  const raw = input as Record<string, unknown>;
  const allowed = new Set([
    'id', 'polygon', 'confidence', 'change_type', 'before_ref', 'after_ref',
    'detected_at', 'area_m2', 'metadata',
  ]);
  const extra = Object.keys(raw).filter((key) => !allowed.has(key));
  if (extra.length) throw new AdapterError(`invalid Detection: unexpected field(s) ${extra.join(', ')}`);

  if (typeof raw.id !== 'string' || raw.id === '') throw new AdapterError('invalid Detection: id must be a non-empty string');
  if (!Array.isArray(raw.polygon) || raw.polygon.length < 3) {
    throw new AdapterError('invalid Detection: polygon needs at least 3 vertices');
  }
  const polygon = raw.polygon.map((point) => requireLatLon(point, 'invalid Detection'));
  if (!finite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) {
    throw new AdapterError('invalid Detection: confidence must be in [0, 1]');
  }
  if (typeof raw.change_type !== 'string' ||
      !(HUB_CHANGE_TYPES as readonly string[]).includes(raw.change_type)) {
    throw new AdapterError(`invalid Detection: change_type must be one of ${HUB_CHANGE_TYPES.join('|')}`);
  }
  if (typeof raw.before_ref !== 'string' || typeof raw.after_ref !== 'string') {
    throw new AdapterError('invalid Detection: before_ref and after_ref are required strings');
  }
  if (typeof raw.detected_at !== 'string' || Number.isNaN(Date.parse(raw.detected_at))) {
    throw new AdapterError('invalid Detection: detected_at must be an ISO 8601 timestamp');
  }
  const area = raw.area_m2 === undefined || raw.area_m2 === null ? null : raw.area_m2;
  if (area !== null && (!finite(area) || area < 0)) {
    throw new AdapterError('invalid Detection: area_m2 must be a non-negative number or null');
  }
  const metadata = raw.metadata === undefined ? {} : raw.metadata;
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata) ||
      Object.values(metadata as Record<string, unknown>).some((value) => typeof value !== 'string')) {
    throw new AdapterError('invalid Detection: metadata must be a string→string map');
  }
  return {
    id: raw.id,
    polygon,
    confidence: raw.confidence,
    change_type: raw.change_type as HubChangeType,
    before_ref: raw.before_ref,
    after_ref: raw.after_ref,
    detected_at: raw.detected_at,
    area_m2: area,
    metadata: metadata as Record<string, string>,
  };
}

/**
 * What a Detection carries that an Anomaly has nowhere to put. Returned rather
 * than dropped so a consumer that needs the footprint (an off-tile badge, a
 * survey outline) or the baseline frame has it without inventing it, and so a
 * round trip can restore the fields the point form cannot hold.
 */
export interface DetectionExtras {
  /** The original ring, so a consumer that wants the footprint has it. */
  polygon: LatLon[];
  areaM2: number | null;
  beforeRef: string;
  afterRef: string;
  /**
   * The Hub's own `change_type`. The mapping into our vocabulary is LOSSY in
   * one direction — `intruder_vehicle` and `vehicle` are both `vehicle` to us,
   * because "intruder" is a conclusion and our cue kinds are observations — so
   * the original value travels here for anything publishing back.
   */
  changeType: HubChangeType;
  metadata: Record<string, string>;
}

export interface AnomalyFromDetection {
  anomaly: Anomaly;
  extras: DetectionExtras;
}

/**
 * Hub `Detection` → our `Anomaly`.
 *
 * `metadata.source` selects the cue rail when the Hub names one we know;
 * anything else falls back to `DEFAULT_HUB_SOURCE` rather than inventing a
 * rail. `after_ref` becomes the thumbnail because that is the frame the change
 * was seen in, and it is the reference the incident report cites.
 */
export function anomalyFromHubDetection(
  input: unknown,
  options: { ttlS?: number; source?: AnomalySource } = {},
): AnomalyFromDetection {
  const detection = parseHubDetection(input);
  const centroid = polygonCentroid(detection.polygon);
  const declared = detection.metadata.source;
  const source = options.source
    ?? (KNOWN_SOURCES.includes(declared as AnomalySource) ? declared as AnomalySource : DEFAULT_HUB_SOURCE);
  const ttlS = options.ttlS ?? HUB_CUE_TTL_S;
  return {
    anomaly: {
      id: detection.id,
      lat: centroid.lat,
      lon: centroid.lon,
      type: CHANGE_TYPE_TO_ANOMALY_TYPE[detection.change_type],
      confidence: detection.confidence,
      thumbnail: detection.after_ref,
      source,
      observedAt: Date.parse(detection.detected_at),
      ttl_s: ttlS,
      ...(detection.metadata.camera_id ? { cameraId: detection.metadata.camera_id } : {}),
    },
    extras: {
      polygon: detection.polygon,
      areaM2: detection.area_m2,
      beforeRef: detection.before_ref,
      afterRef: detection.after_ref,
      changeType: detection.change_type,
      metadata: detection.metadata,
    },
  };
}

/** A square of `sideM` metres centred on `centre`, counter-clockwise, unclosed. */
export function squareAround(centre: LatLon, sideM: number): LatLon[] {
  const half = sideM / 2;
  const dLat = half / M_PER_DEG_LAT;
  const dLon = half / (M_PER_DEG_LAT * Math.cos((centre.lat * Math.PI) / 180));
  return [
    { lat: centre.lat - dLat, lon: centre.lon - dLon },
    { lat: centre.lat - dLat, lon: centre.lon + dLon },
    { lat: centre.lat + dLat, lon: centre.lon + dLon },
    { lat: centre.lat + dLat, lon: centre.lon - dLon },
  ];
}

export interface HubDetectionOptions {
  /** REQUIRED by the Hub. We have no baseline frame, so the caller supplies it. */
  beforeRef?: string;
  /** Defaults to the anomaly's own thumbnail when that is a usable reference. */
  afterRef?: string;
  /** Footprint side for a point-shaped cue, metres. */
  footprintM?: number;
  /** Ring to publish instead of a synthesised square (a real footprint). */
  polygon?: LatLon[];
  /**
   * The Hub `change_type` to publish. Supply `DetectionExtras.changeType` to
   * round-trip a Detection without flattening `intruder_vehicle` to `vehicle`;
   * omit it and the value is derived from the cue's own kind.
   */
  changeType?: HubChangeType;
  metadata?: Record<string, string>;
  /** Epoch ms for `detected_at` when the cue carries no `observedAt`. */
  now?: number;
}

/**
 * Our `Anomaly` → Hub `Detection`.
 *
 * Refuses rather than fabricates: `before_ref`/`after_ref` are required by the
 * Hub and are evidence references a human reviewer will follow, so a cue with
 * no usable reference and no caller-supplied one produces an `AdapterError`,
 * not a placeholder. A base64 data URL is not a reference either — it is a
 * payload, and the Hub's `str` field is not where a 10 kB blob belongs.
 */
export function hubDetectionFromAnomaly(
  anomaly: Anomaly,
  options: HubDetectionOptions = {},
): HubDetection {
  if (!finite(anomaly.lat) || !finite(anomaly.lon)) {
    throw new AdapterError('cannot publish a Detection: the cue has no finite position');
  }
  if (!finite(anomaly.confidence) || anomaly.confidence < 0 || anomaly.confidence > 1) {
    throw new AdapterError('cannot publish a Detection: confidence must be in [0, 1]');
  }
  const usable = (value?: string): string | undefined =>
    value && !/^data:/i.test(value) && value.length <= 512 ? value : undefined;
  const afterRef = usable(options.afterRef) ?? usable(anomaly.thumbnail);
  const beforeRef = usable(options.beforeRef);
  if (!afterRef) {
    throw new AdapterError(
      `cannot publish Detection ${anomaly.id}: the Hub requires an after_ref and the cue carries no usable image reference`);
  }
  if (!beforeRef) {
    throw new AdapterError(
      `cannot publish Detection ${anomaly.id}: the Hub requires a before_ref and this stack holds no baseline frame for it`);
  }
  const polygon = options.polygon?.length
    ? options.polygon.map((point) => requireLatLon(point, 'cannot publish a Detection'))
    : squareAround(anomaly, options.footprintM ?? POINT_FOOTPRINT_M);
  if (polygon.length < 3) throw new AdapterError('cannot publish a Detection: polygon needs at least 3 vertices');
  const side = options.footprintM ?? POINT_FOOTPRINT_M;
  const observedAt = anomaly.observedAt ?? options.now ?? Date.now();
  return {
    id: anomaly.id,
    polygon,
    confidence: anomaly.confidence,
    change_type: options.changeType ?? ANOMALY_TYPE_TO_CHANGE_TYPE[anomaly.type] ?? 'unknown',
    before_ref: beforeRef,
    after_ref: afterRef,
    detected_at: new Date(observedAt).toISOString(),
    area_m2: options.polygon?.length ? null : side * side,
    metadata: {
      source: anomaly.source,
      ...(anomaly.cameraId ? { camera_id: anomaly.cameraId } : {}),
      ...(options.metadata ?? {}),
    },
  };
}
