import { findBlobs } from './detect.js';
import type { Anomaly, ChangeBlob, GeoRefTiles } from './types.js';

export interface SarPatch { x: number; y: number; width: number; height: number; value: number }
export interface SarChip { width: number; height: number; fill: number; patches: SarPatch[] }
export interface SarDetection {
  anomalies: Anomaly[];
  logRatioDb: Float32Array;
  provenance: { kind: 'synthetic' | 'real'; claim: string };
}

export function expandSarChip(chip: SarChip): Float32Array {
  if (!Number.isInteger(chip.width) || !Number.isInteger(chip.height) || chip.width <= 0 || chip.height <= 0 ||
      !Number.isFinite(chip.fill) || chip.fill < 0) throw new Error('invalid SAR chip');
  const out = new Float32Array(chip.width * chip.height).fill(chip.fill);
  for (const patch of chip.patches) {
    if (![patch.x, patch.y, patch.width, patch.height].every(Number.isInteger) || !Number.isFinite(patch.value) || patch.value < 0) {
      throw new Error('invalid SAR patch');
    }
    for (let y = patch.y; y < patch.y + patch.height; y++) for (let x = patch.x; x < patch.x + patch.width; x++) {
      if (x < 0 || y < 0 || x >= chip.width || y >= chip.height) throw new Error('SAR patch escapes chip');
      out[y * chip.width + x] = patch.value;
    }
  }
  return out;
}

/**
 * Symmetric intensity log-ratio, SIGNED. Input is linear SAR intensity, not
 * display pixels.
 *
 * Positive means the scene got BRIGHTER (something appeared: a vehicle, a
 * structure, disturbed ground); negative means it got darker (something left,
 * or the surface smoothed). The two are different events and a security cue
 * that cannot tell them apart is telling the operator less than it knows —
 * `sarMagnitudeDb` is the absolute value for callers that only want "how much
 * changed" (FM-123).
 */
export function sarLogRatio(before: Float32Array, after: Float32Array): Float32Array {
  if (before.length !== after.length) throw new Error('SAR chips differ in size');
  const out = new Float32Array(before.length);
  for (let i = 0; i < out.length; i++) {
    if (!Number.isFinite(before[i]) || !Number.isFinite(after[i]) || before[i] < 0 || after[i] < 0) {
      throw new Error('SAR intensity must be finite and non-negative');
    }
    out[i] = 10 * Math.log10((after[i] + 1e-6) / (before[i] + 1e-6));
  }
  return out;
}

/** |log-ratio| — the change magnitude, direction discarded. */
export function sarMagnitudeDb(ratio: Float32Array): Float32Array {
  const out = new Float32Array(ratio.length);
  for (let i = 0; i < ratio.length; i++) out[i] = Math.abs(ratio[i]);
  return out;
}

/** Change direction at a pixel, from the SIGNED log-ratio. */
export type SarChangeDirection = 'brighter' | 'darker';

/** Anomaly `type` emitted per direction. Both are cue KINDS, not conclusions. */
export const SAR_CHANGE_TYPE: Record<SarChangeDirection, string> = {
  brighter: 'sar_backscatter_increase',
  darker: 'sar_backscatter_decrease',
};

export interface SarDetectOptions {
  /** Magnitude, dB, at or above which a pixel counts as changed. */
  thresholdDb?: number;
  /** Smallest region worth reporting, pixels. */
  minBlobAreaPx?: number;
  /** Most anomalies to emit from one chip pair. */
  maxAnomalies?: number;
  /**
   * Evidence reference stamped on every anomaly's `thumbnail`. It is rendered
   * into the incident report for a human reviewer to follow, so it must name
   * an IMAGE, not a data file (FM-125). Omit it and the cue carries no
   * thumbnail at all, which the report writer already describes honestly.
   */
  thumbnail?: string;
}

export const SAR_DETECT_DEFAULTS = {
  thresholdDb: 4,
  minBlobAreaPx: 1,
  maxAnomalies: 8,
} as const;

/** Image extensions a thumbnail reference may carry (FM-125). */
const IMAGE_REF = /\.(png|jpe?g|webp|tiff?)$/i;

/**
 * SAR change detection over a before/after chip pair.
 *
 * Two spatially separate changes are two anomalies. Averaging every changed
 * pixel into one arithmetic-mean centroid — which is what this did before —
 * puts the cue in the empty middle for the two-corner case, and there is no
 * worse place to send an aircraft than the one point where nothing happened
 * (FM-123). The connected-component pass is `detect.findBlobs`, the same one
 * the optical rail uses, so the two rails agree on what "a region" means.
 */
export function detectSarChanges(before: SarChip, after: SarChip, georef: GeoRefTiles,
  provenance: SarDetection['provenance'], options: SarDetectOptions | number = {}): SarDetection {
  // Back-compat: the previous signature took `thresholdDb` positionally.
  const opts: SarDetectOptions = typeof options === 'number' ? { thresholdDb: options } : options;
  if (before.width !== after.width || before.height !== after.height) throw new Error('SAR chip dimensions differ');
  if (opts.thumbnail !== undefined && opts.thumbnail !== '' && !IMAGE_REF.test(opts.thumbnail)) {
    throw new Error('SAR thumbnail must reference an image file');
  }
  const thresholdDb = opts.thresholdDb ?? SAR_DETECT_DEFAULTS.thresholdDb;
  const width = before.width;
  const height = before.height;
  const ratio = sarLogRatio(expandSarChip(before), expandSarChip(after));

  // findBlobs works in 0..255 magnitude space, like the optical diff. 12 dB is
  // the same full-scale the confidence heuristic below uses.
  const FULL_SCALE_DB = 12;
  const magnitude = new Uint8Array(ratio.length);
  const mask = new Uint8Array(ratio.length);
  for (let i = 0; i < ratio.length; i++) {
    const abs = Math.abs(ratio[i]);
    magnitude[i] = Math.min(255, Math.round((abs / FULL_SCALE_DB) * 255));
    mask[i] = abs >= thresholdDb ? 1 : 0;
  }
  const blobs = findBlobs(mask, width, height, magnitude, {
    minBlobAreaPx: opts.minBlobAreaPx ?? SAR_DETECT_DEFAULTS.minBlobAreaPx,
    connectivity: 8,
    maxBlobs: opts.maxAnomalies ?? SAR_DETECT_DEFAULTS.maxAnomalies,
  });
  if (!blobs.length) return { anomalies: [], logRatioDb: ratio, provenance };

  const bounds = georef.boundsLatLon;
  const anomalies = blobs.map((blob: ChangeBlob, index: number) => {
    const lat = bounds.north + (bounds.south - bounds.north) * (blob.centroidPx.y / height);
    const lon = bounds.west + (bounds.east - bounds.west) * (blob.centroidPx.x / width);
    // Direction is the sign of the strongest pixel in this region, not of the
    // region's mean: a bright new object next to a darkened shadow is an
    // appearance, and the operator is being told which it is.
    let peak = 0;
    for (let y = blob.bbox.y; y < blob.bbox.y + blob.bbox.h; y++) {
      for (let x = blob.bbox.x; x < blob.bbox.x + blob.bbox.w; x++) {
        const value = ratio[y * width + x];
        if (Math.abs(value) > Math.abs(peak)) peak = value;
      }
    }
    const direction: SarChangeDirection = peak >= 0 ? 'brighter' : 'darker';
    return {
      id: `sar-change-${index + 1}`,
      lat,
      lon,
      type: SAR_CHANGE_TYPE[direction],
      confidence: Math.min(0.99, Math.max(0.05, (blob.maxDiff / 255) * FULL_SCALE_DB / 12)),
      thumbnail: opts.thumbnail ?? '',
      source: 'sar' as const,
    };
  });
  return { anomalies, logRatioDb: ratio, provenance };
}
