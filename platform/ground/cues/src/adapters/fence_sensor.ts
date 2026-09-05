/* ============================================================================
 * eis-cues — the fence_sensor rail. FIXTURE ONLY.
 *
 * No perimeter intrusion-detection system is connected in this run, so this
 * rail has no live source at all: constructing it without a fixture leaves it
 * `failed` rather than quietly nominal. A rail with nothing behind it must look
 * like a rail with nothing behind it (ADR D25).
 *
 * The record shape is the one a fence PIDS controller publishes: a zone id, a
 * hit type and a time. Zones are resolved through the site model's camera zones
 * so the fence and the cameras agree on names; a `lat`/`lon` may be given
 * directly for a sensor that reports its own position.
 * ========================================================================== */

import { BaseRail, type RailOptions } from '../base.js';
import { polygonCentroid } from '../geo.js';
import { EMPTY_NORMALCY, normalcyRules, normalcySuppression, type SiteNormalcy } from '../normalcy.js';
import { findCamera, findZone, type CueSite } from '../site.js';
import type { DecodedCue, RailId, WhitelistRule } from '../types.js';

export const FENCE_SENSOR_DEFAULT_TTL_S = 300;

/** A perimeter intrusion-detection record. */
export interface FenceSensorRecord {
  /** Sensor/segment id, for provenance. */
  sensorId: string;
  /** Epoch ms of the hit. */
  ts: number;
  /** e.g. 'cut', 'climb', 'impact', 'tamper'. */
  event: string;
  confidence: number;
  /** Zone name shared with the camera model, when the segment maps to one. */
  zone?: string;
  /** Camera whose zone list defines `zone`. */
  cameraId?: string;
  lat?: number;
  lon?: number;
}

export interface FenceSensorRailOptions extends RailOptions {
  site: CueSite;
  normalcy?: SiteNormalcy;
}

export class FenceSensorRail extends BaseRail {
  readonly id: RailId = 'fence_sensor';
  protected readonly defaultTtlS = FENCE_SENSOR_DEFAULT_TTL_S;

  private readonly site: CueSite;
  private readonly normalcy: SiteNormalcy;

  constructor(options: FenceSensorRailOptions) {
    super(options);
    this.site = options.site;
    this.normalcy = options.normalcy ?? EMPTY_NORMALCY;
  }

  protected async onStart(): Promise<void> {
    if (!this.fixture) {
      throw new Error('fixture-only rail: no perimeter sensor source is integrated');
    }
  }

  protected decode(payload: unknown): DecodedCue | null {
    const record = parseFenceSensorRecord(payload);
    let lat = record.lat;
    let lon = record.lon;
    if (lat === undefined || lon === undefined) {
      if (!record.cameraId || !record.zone) {
        throw new Error(
          `fence record ${record.sensorId} has neither a position nor a camera zone to resolve`,
        );
      }
      const camera = findCamera(this.site, record.cameraId);
      if (!camera) {
        throw new Error(`fence record names camera ${record.cameraId}, absent from the site model`);
      }
      const zone = findZone(camera, record.zone);
      if (!zone) {
        throw new Error(`fence record names zone ${record.zone}, absent from camera ${camera.id}`);
      }
      const centre = polygonCentroid(zone.polygon);
      lat = centre.lat;
      lon = centre.lon;
    }
    return {
      id: `fence_sensor-${record.sensorId}-${Math.trunc(record.ts)}`,
      lat,
      lon,
      type: `fence_${record.event}`,
      confidence: record.confidence,
      observedAt: record.ts,
      ...(record.cameraId === undefined ? {} : { cameraId: record.cameraId }),
      ...(record.zone === undefined ? {} : { zone: record.zone }),
      meta: { sensorId: record.sensorId, event: record.event },
    };
  }

  protected whitelistMatch(cue: DecodedCue, nowMs: number): WhitelistRule | null {
    return normalcySuppression(this.normalcy, {
      ...(cue.cameraId === undefined ? {} : { cameraId: cue.cameraId }),
      ...(cue.zone === undefined ? {} : { zone: cue.zone }),
      tsMs: cue.observedAt ?? nowMs,
    });
  }

  protected whitelistRules(): WhitelistRule[] {
    return normalcyRules(this.normalcy);
  }
}

export function parseFenceSensorRecord(input: unknown): FenceSensorRecord {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('invalid fence record: must be an object');
  }
  const r = input as Record<string, unknown>;
  if (typeof r.sensorId !== 'string' || r.sensorId === '') {
    throw new Error('invalid fence record: sensorId must be a non-empty string');
  }
  if (typeof r.event !== 'string' || r.event === '') {
    throw new Error('invalid fence record: event must be a non-empty string');
  }
  if (typeof r.ts !== 'number' || !Number.isFinite(r.ts) || r.ts < 0) {
    throw new Error('invalid fence record: ts must be a non-negative epoch-ms number');
  }
  if (typeof r.confidence !== 'number' || !Number.isFinite(r.confidence) ||
      r.confidence < 0 || r.confidence > 1) {
    throw new Error('invalid fence record: confidence must be in [0, 1]');
  }
  return {
    sensorId: r.sensorId,
    ts: r.ts,
    event: r.event,
    confidence: r.confidence,
    ...(typeof r.zone === 'string' ? { zone: r.zone } : {}),
    ...(typeof r.cameraId === 'string' ? { cameraId: r.cameraId } : {}),
    ...(typeof r.lat === 'number' ? { lat: r.lat } : {}),
    ...(typeof r.lon === 'number' ? { lon: r.lon } : {}),
  };
}
