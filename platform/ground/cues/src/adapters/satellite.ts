/* ============================================================================
 * eis-cues — the sentinel2 and sar rails.
 *
 * These WRAP ground/satellite; they do not move or reimplement it (ADR D25).
 * The working detection core stays where it is and gains an adapter, reached
 * through the injectable `SatelliteCueSource` seam so this module stays
 * browser-safe and the satellite package stays an optional runtime dependency
 * (`src/node/satellite.ts` binds the real one).
 *
 * Cue age
 * -------
 * A satellite anomaly is undated: the detector compares two tiles and does not
 * know when either was acquired. TTL is measured from `observedAt`, so a rail
 * that stamped "now" would claim a months-old change was seen this second.
 * The acquisition time is therefore taken, in order, from the record's own
 * `observedAt`, then the rail's configured `acquiredAt`, and only then from the
 * clock — with a health warning that the cue's age is unknown, once per start.
 * ========================================================================== */

import { BaseRail, type RailOptions } from '../base.js';
import type { DecodedCue, RailId } from '../types.js';

/** Structural copy of the satellite package's `Anomaly` (its emitted shape). */
export interface SatelliteAnomaly {
  id: string;
  lat: number;
  lon: number;
  type: string;
  confidence: number;
  thumbnail: string;
  source: string;
  observedAt?: number;
  ttl_s?: number;
}

/** The seam onto ground/satellite. Offline and synchronous-friendly. */
export interface SatelliteCueSource {
  readonly name: string;
  anomalies(): SatelliteAnomaly[] | Promise<SatelliteAnomaly[]>;
}

/** One Sentinel-2 revisit. A change older than this is history, not a cue. */
export const SENTINEL2_DEFAULT_TTL_S = 86_400;
/** SAR revisits more often and its cues age faster. */
export const SAR_DEFAULT_TTL_S = 43_200;

export interface SatelliteRailOptions extends RailOptions {
  /** Live source. Omit to run purely from a scripted fixture. */
  source?: SatelliteCueSource;
  /** Epoch ms the imagery was acquired, when the caller knows it. */
  acquiredAt?: number;
}

abstract class SatelliteRailBase extends BaseRail {
  private readonly source?: SatelliteCueSource;
  private readonly acquiredAt?: number;
  private warnedUndated = false;

  constructor(options: SatelliteRailOptions = {}) {
    super(options);
    this.source = options.source;
    this.acquiredAt = options.acquiredAt;
  }

  protected async onStart(): Promise<void> {
    if (!this.source) {
      if (!this.fixture) {
        // No source and no fixture is a configuration failure, not quiet nominal.
        throw new Error('no satellite source and no scripted fixture configured');
      }
      return;
    }
    const anomalies = await this.source.anomalies();
    for (const anomaly of anomalies) this.ingest(anomaly);
    this.setHealth(
      'healthy',
      `cue rail ${this.id}: ${anomalies.length} cue(s) from ${this.source.name}`,
    );
  }

  protected decode(payload: unknown, nowMs: number): DecodedCue | null {
    const anomaly = parseSatelliteAnomaly(payload);
    // One source per rail: a sar record must not surface as a sentinel2 cue.
    if (anomaly.source !== this.id) return null;
    let observedAt = anomaly.observedAt ?? this.acquiredAt;
    if (observedAt === undefined) {
      observedAt = nowMs;
      if (!this.warnedUndated) {
        this.warnedUndated = true;
        this.warn(
          'imagery carries no acquisition time; cue age is unknown and TTL is ' +
          'measured from ingest. Configure acquiredAt for an honest cue age.',
        );
      }
    }
    return {
      id: `${this.id}-${anomaly.id}`,
      lat: anomaly.lat,
      lon: anomaly.lon,
      type: anomaly.type,
      confidence: anomaly.confidence,
      thumbnail: anomaly.thumbnail,
      observedAt,
      ...(anomaly.ttl_s === undefined ? {} : { ttl_s: anomaly.ttl_s }),
    };
  }
}

export class Sentinel2Rail extends SatelliteRailBase {
  readonly id: RailId = 'sentinel2';
  protected readonly defaultTtlS = SENTINEL2_DEFAULT_TTL_S;
}

export class SarRail extends SatelliteRailBase {
  readonly id: RailId = 'sar';
  protected readonly defaultTtlS = SAR_DEFAULT_TTL_S;
}

export function parseSatelliteAnomaly(input: unknown): SatelliteAnomaly {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('invalid satellite anomaly: must be an object');
  }
  const a = input as Record<string, unknown>;
  for (const key of ['id', 'type', 'source'] as const) {
    if (typeof a[key] !== 'string' || a[key] === '') {
      throw new Error(`invalid satellite anomaly: ${key} must be a non-empty string`);
    }
  }
  // A thumbnail may legitimately be empty (detection run with thumbnails off).
  if (typeof a.thumbnail !== 'string') {
    throw new Error('invalid satellite anomaly: thumbnail must be a string');
  }
  for (const key of ['lat', 'lon', 'confidence'] as const) {
    if (typeof a[key] !== 'number' || !Number.isFinite(a[key])) {
      throw new Error(`invalid satellite anomaly: ${key} must be a finite number`);
    }
  }
  return {
    id: a.id as string,
    lat: a.lat as number,
    lon: a.lon as number,
    type: a.type as string,
    confidence: a.confidence as number,
    thumbnail: a.thumbnail as string,
    source: a.source as string,
    ...(typeof a.observedAt === 'number' ? { observedAt: a.observedAt } : {}),
    ...(typeof a.ttl_s === 'number' ? { ttl_s: a.ttl_s } : {}),
  };
}
