/* ============================================================================
 * eis-satellite — change-detection CORE (pure TS, Node + browser).
 *
 * Operates on raw RGBA Uint8Arrays + width/height ONLY — no canvas, no DOM,
 * no Node APIs. PNG decode stays OUT of this module: Node decodes via
 * src/node/png.ts, browsers via Image/canvas (README shows the snippet).
 *
 * Pipeline: per-pixel max-channel abs diff -> threshold -> connected
 * components -> min-area filter -> diff-weighted centroid per blob ->
 * georeference via the tiles.json bounds -> contract Anomaly[].
 * ========================================================================== */

import type {
  Anomaly,
  ChangeBlob,
  DetectOptions,
  DetectResult,
  GeoRefTiles,
} from './types.js';
import { pixelToLatLon, validateGeoRef } from './georef.js';
import { rgbaToPngDataUrl } from './png.js';

export const DETECT_DEFAULTS = {
  threshold: 28,
  minBlobAreaPx: 10,
  maxBlobs: 16,
  connectivity: 8 as 4 | 8,
  idPrefix: 'sat-change',
  thumbnails: true,
};

function assertRgba(name: string, rgba: Uint8Array, width: number, height: number): void {
  if (rgba.length !== width * height * 4) {
    throw new Error(
      `eis-satellite: ${name} has ${rgba.length} bytes, expected ${width * height * 4} (RGBA ${width}x${height})`,
    );
  }
}

/** Per-pixel change magnitude: max over R/G/B of |after - before| (alpha ignored). */
export function computeDiff(
  before: Uint8Array,
  after: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  assertRgba('before', before, width, height);
  assertRgba('after', after, width, height);
  const n = width * height;
  const diff = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const dr = Math.abs(after[o] - before[o]);
    const dg = Math.abs(after[o + 1] - before[o + 1]);
    const db = Math.abs(after[o + 2] - before[o + 2]);
    diff[i] = Math.max(dr, dg, db);
  }
  return diff;
}

/** Binary mask (0|1) from a diff image. */
export function thresholdMask(diff: Uint8Array, threshold: number): Uint8Array {
  const mask = new Uint8Array(diff.length);
  for (let i = 0; i < diff.length; i++) mask[i] = diff[i] >= threshold ? 1 : 0;
  return mask;
}

/** RGBA overlay for the UI: transparent where unchanged, red-orange with
 *  diff-proportional alpha where changed. */
export function diffOverlayRgba(
  diff: Uint8Array,
  width: number,
  height: number,
  threshold: number = DETECT_DEFAULTS.threshold,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < diff.length; i++) {
    const d = diff[i];
    if (d < threshold) continue;
    const o = i * 4;
    out[o] = 255;
    out[o + 1] = 96;
    out[o + 2] = 40;
    out[o + 3] = Math.min(235, 70 + d);
  }
  return out;
}

/** Connected components over the mask; centroids weighted by diff magnitude. */
export function findBlobs(
  mask: Uint8Array,
  width: number,
  height: number,
  diff: Uint8Array,
  opts: Pick<DetectOptions, 'minBlobAreaPx' | 'connectivity' | 'maxBlobs'> = {},
): ChangeBlob[] {
  const minArea = opts.minBlobAreaPx ?? DETECT_DEFAULTS.minBlobAreaPx;
  const connectivity = opts.connectivity ?? DETECT_DEFAULTS.connectivity;
  const maxBlobs = opts.maxBlobs ?? DETECT_DEFAULTS.maxBlobs;

  const visited = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const blobs: ChangeBlob[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;

    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;

    let area = 0;
    let sumW = 0;
    let sumX = 0;
    let sumY = 0;
    let sumDiff = 0;
    let maxDiff = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % width;
      const y = (idx / width) | 0;

      area++;
      const w = Math.max(1, diff[idx]);
      sumW += w;
      sumX += (x + 0.5) * w;
      sumY += (y + 0.5) * w;
      sumDiff += diff[idx];
      if (diff[idx] > maxDiff) maxDiff = diff[idx];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      // Neighbors.
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (connectivity === 4 && dx !== 0 && dy !== 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const nIdx = ny * width + nx;
          if (mask[nIdx] && !visited[nIdx]) {
            visited[nIdx] = 1;
            stack[sp++] = nIdx;
          }
        }
      }
    }

    if (area < minArea) continue;
    const meanDiff = sumDiff / area;
    blobs.push({
      areaPx: area,
      bbox: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      centroidPx: { x: sumX / sumW, y: sumY / sumW },
      meanDiff,
      maxDiff,
      score: area * meanDiff,
    });
  }

  blobs.sort((a, b) => b.score - a.score);
  return blobs.slice(0, maxBlobs);
}

/** Confidence heuristic from blob size + contrast, clamped to (0, 1]. */
export function blobConfidence(blob: ChangeBlob): number {
  const sizeTerm = Math.min(1, blob.areaPx / 60);
  const contrastTerm = Math.min(1, blob.meanDiff / 160);
  const c = 0.3 + 0.4 * sizeTerm + 0.3 * contrastTerm;
  return Math.min(1, Math.max(0.05, Math.round(c * 100) / 100));
}

/** Crop a rect out of an RGBA image (clamped to bounds). */
export function cropRgba(
  rgba: Uint8Array,
  width: number,
  height: number,
  rect: { x: number; y: number; w: number; h: number },
): { rgba: Uint8Array; width: number; height: number } {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.h));
  const cw = Math.max(0, x1 - x0);
  const ch = Math.max(0, y1 - y0);
  const out = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    const srcOff = ((y0 + y) * width + x0) * 4;
    out.set(rgba.subarray(srcOff, srcOff + cw * 4), y * cw * 4);
  }
  return { rgba: out, width: cw, height: ch };
}

const THUMB_PAD_PX = 16;
const THUMB_MIN_PX = 40;

function thumbnailFor(
  after: Uint8Array,
  width: number,
  height: number,
  blob: ChangeBlob,
): string {
  let { x, y, w, h } = blob.bbox;
  x -= THUMB_PAD_PX;
  y -= THUMB_PAD_PX;
  w += THUMB_PAD_PX * 2;
  h += THUMB_PAD_PX * 2;
  if (w < THUMB_MIN_PX) {
    x -= (THUMB_MIN_PX - w) / 2;
    w = THUMB_MIN_PX;
  }
  if (h < THUMB_MIN_PX) {
    y -= (THUMB_MIN_PX - h) / 2;
    h = THUMB_MIN_PX;
  }
  const crop = cropRgba(after, width, height, { x, y, w, h });
  if (crop.width === 0 || crop.height === 0) return '';
  return rgbaToPngDataUrl(crop.rgba, crop.width, crop.height);
}

/** Full pipeline: before/after RGBA -> georeferenced contract Anomaly[]. */
export function detectAnomalies(
  before: Uint8Array,
  after: Uint8Array,
  width: number,
  height: number,
  georef: GeoRefTiles,
  opts: DetectOptions = {},
): DetectResult {
  validateGeoRef(georef);
  if (georef.widthPx !== width || georef.heightPx !== height) {
    throw new Error(
      `eis-satellite: georef is ${georef.widthPx}x${georef.heightPx} but tiles are ${width}x${height}`,
    );
  }
  const threshold = opts.threshold ?? DETECT_DEFAULTS.threshold;
  const idPrefix = opts.idPrefix ?? DETECT_DEFAULTS.idPrefix;
  const wantThumbs = opts.thumbnails ?? DETECT_DEFAULTS.thumbnails;

  const diff = computeDiff(before, after, width, height);
  const mask = thresholdMask(diff, threshold);
  const blobs = findBlobs(mask, width, height, diff, opts);
  const overlayRgba = diffOverlayRgba(diff, width, height, threshold);

  const anomalies: Anomaly[] = blobs.map((blob, i) => {
    const { lat, lon } = pixelToLatLon(blob.centroidPx.x, blob.centroidPx.y, georef);
    return {
      id: `${idPrefix}-${i + 1}`,
      lat,
      lon,
      type: 'change',
      confidence: blobConfidence(blob),
      thumbnail: wantThumbs ? thumbnailFor(after, width, height, blob) : '',
    };
  });

  return { anomalies, blobs, diff, mask, overlayRgba };
}
