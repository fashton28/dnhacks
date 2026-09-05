import type { Anomaly, GeoRefTiles } from './types.js';

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

/** Symmetric intensity log-ratio. Input is linear SAR intensity, not display pixels. */
export function sarLogRatio(before: Float32Array, after: Float32Array): Float32Array {
  if (before.length !== after.length) throw new Error('SAR chips differ in size');
  const out = new Float32Array(before.length);
  for (let i = 0; i < out.length; i++) {
    if (!Number.isFinite(before[i]) || !Number.isFinite(after[i]) || before[i] < 0 || after[i] < 0) {
      throw new Error('SAR intensity must be finite and non-negative');
    }
    out[i] = 10 * Math.abs(Math.log10((after[i] + 1e-6) / (before[i] + 1e-6)));
  }
  return out;
}

export function detectSarChanges(before: SarChip, after: SarChip, georef: GeoRefTiles,
  provenance: SarDetection['provenance'], thresholdDb = 4): SarDetection {
  if (before.width !== after.width || before.height !== after.height) throw new Error('SAR chip dimensions differ');
  const ratio = sarLogRatio(expandSarChip(before), expandSarChip(after));
  const hits: number[] = [];
  ratio.forEach((value, index) => { if (value >= thresholdDb) hits.push(index); });
  if (!hits.length) return { anomalies: [], logRatioDb: ratio, provenance };
  const col = hits.reduce((sum, index) => sum + index % before.width, 0) / hits.length;
  const row = hits.reduce((sum, index) => sum + Math.floor(index / before.width), 0) / hits.length;
  const bounds = georef.boundsLatLon;
  const lat = bounds.north + (bounds.south - bounds.north) * ((row + 0.5) / before.height);
  const lon = bounds.west + (bounds.east - bounds.west) * ((col + 0.5) / before.width);
  const confidence = Math.min(0.99, Math.max(...hits.map((index) => ratio[index])) / 12);
  return { anomalies: [{
    id: 'sar-change-1', lat, lon, type: 'sar_log_ratio_change', confidence,
    thumbnail: 'data/tiles/komati/sar-after.json', source: 'sar',
  }], logRatioDb: ratio, provenance };
}
