import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectSarChanges, sarLogRatio } from '../src/sar.js';
import { loadBakedSar } from '../src/node/sar.js';

describe('SAR log-ratio change detection', () => {
  it('is symmetric and finite', () => {
    const a = new Float32Array([10, 20]); const b = new Float32Array([40, 20]);
    expect([...sarLogRatio(a, b)]).toEqual([...sarLogRatio(b, a)]);
  });
  it('emits a source=sar anomaly from the clearly labelled baked synthetic fallback', () => {
    const result = loadBakedSar(path.resolve(__dirname, '../../../data/tiles/komati'));
    expect(result.provenance.kind).toBe('synthetic');
    expect(result.provenance.claim).toContain('not Umbra imagery');
    expect(result.anomalies[0]).toMatchObject({ source: 'sar', type: 'sar_log_ratio_change' });
  });
  it('returns no anomaly for unchanged chips', () => {
    const chip = { width: 2, height: 2, fill: 10, patches: [] };
    expect(detectSarChanges(chip, chip, { widthPx:2, heightPx:2, boundsLatLon:{north:1,south:0,west:0,east:1} },
      { kind:'synthetic', claim:'test' }).anomalies).toEqual([]);
  });
});
