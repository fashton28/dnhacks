/* ============================================================================
 * eis-cues — the drone_survey rail. STUB.
 *
 * A survey cue would come from a completed survey sortie's own imagery, which
 * this run does not produce: the observation path exists (companion
 * `observation` messages) but nothing turns a finished survey into a NEW cue
 * yet. So this rail is a stub with a real decoder and no source.
 *
 * It is deliberately honest about that: without a fixture it reports `failed`
 * with "stub rail: no survey source", never `healthy` with silence. A stub that
 * looked nominal would let an operator believe the site had been surveyed.
 * ========================================================================== */

import { BaseRail, type RailOptions } from '../base.js';
import type { DecodedCue, RailId } from '../types.js';

export const DRONE_SURVEY_DEFAULT_TTL_S = 3_600;

/** What a completed survey reports about one finding. */
export interface DroneSurveyRecord {
  /** Mission that produced the finding, for provenance. */
  missionId: string;
  ts: number;
  lat: number;
  lon: number;
  /** e.g. 'fence_gap', 'new_structure'. */
  finding: string;
  confidence: number;
  thumbnail?: string;
}

export class DroneSurveyRail extends BaseRail {
  readonly id: RailId = 'drone_survey';
  protected readonly defaultTtlS = DRONE_SURVEY_DEFAULT_TTL_S;

  constructor(options: RailOptions = {}) {
    super(options);
  }

  protected async onStart(): Promise<void> {
    if (!this.fixture) {
      throw new Error('stub rail: no survey source is wired, and no fixture was selected');
    }
  }

  protected decode(payload: unknown): DecodedCue | null {
    const record = parseDroneSurveyRecord(payload);
    return {
      id: `drone_survey-${record.missionId}-${Math.trunc(record.ts)}`,
      lat: record.lat,
      lon: record.lon,
      type: record.finding,
      confidence: record.confidence,
      observedAt: record.ts,
      ...(record.thumbnail === undefined ? {} : { thumbnail: record.thumbnail }),
      meta: { missionId: record.missionId },
    };
  }
}

export function parseDroneSurveyRecord(input: unknown): DroneSurveyRecord {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('invalid survey record: must be an object');
  }
  const r = input as Record<string, unknown>;
  if (typeof r.missionId !== 'string' || r.missionId === '') {
    throw new Error('invalid survey record: missionId must be a non-empty string');
  }
  if (typeof r.finding !== 'string' || r.finding === '') {
    throw new Error('invalid survey record: finding must be a non-empty string');
  }
  for (const key of ['ts', 'lat', 'lon', 'confidence'] as const) {
    if (typeof r[key] !== 'number' || !Number.isFinite(r[key])) {
      throw new Error(`invalid survey record: ${key} must be a finite number`);
    }
  }
  return {
    missionId: r.missionId,
    ts: r.ts as number,
    lat: r.lat as number,
    lon: r.lon as number,
    finding: r.finding,
    confidence: r.confidence as number,
    ...(typeof r.thumbnail === 'string' ? { thumbnail: r.thumbnail } : {}),
  };
}
