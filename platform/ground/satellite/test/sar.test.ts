import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SAR_CHANGE_TYPE, detectSarChanges, sarLogRatio, sarMagnitudeDb,
} from '../src/sar.js';
import { loadBakedSar } from '../src/node/sar.js';

const georef = { widthPx: 16, heightPx: 16, boundsLatLon: { north: 1, south: 0, west: 0, east: 1 } };
const provenance = { kind: 'synthetic' as const, claim: 'test' };
const chip = (patches: Array<{ x: number; y: number; width: number; height: number; value: number }>) =>
  ({ width: 16, height: 16, fill: 20, patches });

describe('SAR log-ratio change detection', () => {
  it('is antisymmetric in the arguments and finite', () => {
    // Direction is now carried, so swapping before/after flips the sign
    // rather than producing the same number twice.
    const a = new Float32Array([10, 20]); const b = new Float32Array([40, 20]);
    const forward = [...sarLogRatio(a, b)];
    const reverse = [...sarLogRatio(b, a)];
    forward.forEach((value, i) => expect(value).toBeCloseTo(-reverse[i], 9));
    expect([...sarMagnitudeDb(sarLogRatio(a, b))]).toEqual([...sarMagnitudeDb(sarLogRatio(b, a))]);
    expect([...sarLogRatio(a, b)].every(Number.isFinite)).toBe(true);
  });

  it('emits a source=sar anomaly from the clearly labelled baked synthetic fallback', () => {
    const result = loadBakedSar(path.resolve(__dirname, '../../../data/tiles/komati'));
    expect(result.provenance.kind).toBe('synthetic');
    expect(result.provenance.claim).toContain('not Umbra imagery');
    // The baked chip brightens (fill 20 → patch 80), so the cue says so.
    expect(result.anomalies[0]).toMatchObject({ source: 'sar', type: SAR_CHANGE_TYPE.brighter });
  });

  it('returns no anomaly for unchanged chips', () => {
    const flat = { width: 2, height: 2, fill: 10, patches: [] };
    expect(detectSarChanges(flat, flat, { widthPx: 2, heightPx: 2, boundsLatLon: georef.boundsLatLon },
      provenance).anomalies).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- */
describe('FM-123 separate changes are separate anomalies', () => {
  it('does not collapse two corner changes to the empty middle', () => {
    const before = chip([]);
    const after = chip([
      { x: 0, y: 0, width: 2, height: 2, value: 200 },
      { x: 14, y: 14, width: 2, height: 2, value: 200 },
    ]);
    const { anomalies } = detectSarChanges(before, after, georef, provenance);
    expect(anomalies).toHaveLength(2);
    // The old arithmetic-mean centroid sat at pixel (8, 8) — the exact point
    // where nothing changed. Neither anomaly may land near it.
    const middleLat = georef.boundsLatLon.north +
      (georef.boundsLatLon.south - georef.boundsLatLon.north) * 0.5;
    for (const anomaly of anomalies) expect(Math.abs(anomaly.lat - middleLat)).toBeGreaterThan(0.2);
    expect(new Set(anomalies.map((a) => a.id)).size).toBe(2);
  });

  it('reports one region as one anomaly', () => {
    const { anomalies } = detectSarChanges(chip([]),
      chip([{ x: 6, y: 6, width: 4, height: 4, value: 200 }]), georef, provenance);
    expect(anomalies).toHaveLength(1);
  });

  it('distinguishes an increase from a decrease', () => {
    const bright = detectSarChanges(chip([]), chip([{ x: 7, y: 7, width: 2, height: 2, value: 200 }]),
      georef, provenance);
    const dark = detectSarChanges(chip([{ x: 7, y: 7, width: 2, height: 2, value: 200 }]), chip([]),
      georef, provenance);
    expect(bright.anomalies[0].type).toBe(SAR_CHANGE_TYPE.brighter);
    expect(dark.anomalies[0].type).toBe(SAR_CHANGE_TYPE.darker);
    expect(bright.anomalies[0].type).not.toBe(dark.anomalies[0].type);
  });

  it('caps the number of anomalies from one chip pair', () => {
    const patches = [];
    for (let i = 0; i < 8; i += 1) {
      patches.push({ x: (i % 4) * 4, y: Math.floor(i / 4) * 4, width: 1, height: 1, value: 200 });
    }
    const { anomalies } = detectSarChanges(chip([]), chip(patches), georef, provenance,
      { maxAnomalies: 3 });
    expect(anomalies).toHaveLength(3);
  });

  it('still honours a positional thresholdDb, as the previous signature did', () => {
    const after = chip([{ x: 7, y: 7, width: 2, height: 2, value: 22 }]);
    expect(detectSarChanges(chip([]), after, georef, provenance, 4).anomalies).toEqual([]);
    expect(detectSarChanges(chip([]), after, georef, provenance, 0.3).anomalies).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------- */
describe('FM-125 a thumbnail names an image or nothing at all', () => {
  it('never ships a JSON data path as image evidence', () => {
    const { anomalies } = detectSarChanges(chip([]),
      chip([{ x: 7, y: 7, width: 2, height: 2, value: 200 }]), georef, provenance);
    expect(anomalies[0].thumbnail).toBe('');
    expect(anomalies[0].thumbnail).not.toMatch(/\.json$/);
  });

  it('refuses a non-image reference instead of passing it to a human reviewer', () => {
    expect(() => detectSarChanges(chip([]), chip([{ x: 7, y: 7, width: 2, height: 2, value: 200 }]),
      georef, provenance, { thumbnail: 'data/tiles/komati/sar-after.json' }))
      .toThrow(/must reference an image file/);
  });

  it('accepts and passes through a real image reference', () => {
    const { anomalies } = detectSarChanges(chip([]),
      chip([{ x: 7, y: 7, width: 2, height: 2, value: 200 }]), georef, provenance,
      { thumbnail: 'evidence/sar-after.png' });
    expect(anomalies[0].thumbnail).toBe('evidence/sar-after.png');
  });

  it('leaves the baked dataset thumbnail-free rather than inventing a path', () => {
    const result = loadBakedSar(path.resolve(__dirname, '../../../data/tiles/komati'));
    expect(result.anomalies[0].thumbnail).toBe('');
  });
});
