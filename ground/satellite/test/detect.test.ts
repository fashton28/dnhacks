import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { detectAnomalies, diffOverlayRgba, computeDiff } from '../src/detect.js';
import { distanceMeters, latLonToPixel } from '../src/georef.js';
import type { GeoRefTiles } from '../src/types.js';
import {
  clearBakedCache,
  computeBakedResult,
  getAnomalies,
  loadBakedAnomalies,
  loadTileRgba,
  loadTilesMeta,
  resolveSatMode,
} from '../src/node/baked.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

/** Same site-file selection the generator uses (site data, never hardcoded). */
function loadSite(): { staging: { id: string; lat: number; lon: number }[] } {
  const sel = process.env.EIS_SITE_FILE ?? 'site/site.stub.json';
  const p = isAbsolute(sel) ? sel : resolve(REPO_ROOT, sel);
  return JSON.parse(readFileSync(p, 'utf8'));
}

function flatRgba(w: number, h: number, r: number, g: number, b: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }
  return out;
}

const SMALL_G: GeoRefTiles = {
  boundsLatLon: { north: 10.01, south: 10.0, east: 20.01, west: 20.0 },
  widthPx: 64,
  heightPx: 64,
};

describe('detection core (synthetic in-memory tiles)', () => {
  it('finds no anomalies when before === after', () => {
    const tile = flatRgba(64, 64, 90, 110, 70);
    const res = detectAnomalies(tile, tile, 64, 64, SMALL_G);
    expect(res.anomalies).toHaveLength(0);
    expect(res.blobs).toHaveLength(0);
    expect(res.overlayRgba.every((v) => v === 0)).toBe(true);
  });

  it('ignores sub-threshold noise and sub-minimum-area specks', () => {
    const before = flatRgba(64, 64, 90, 110, 70);
    const after = flatRgba(64, 64, 90, 110, 70);
    // Sub-threshold global wobble.
    for (let i = 0; i < 64 * 64; i++) after[i * 4] = 90 + (i % 3) * 8; // max diff 16 < 28
    // A 2x2 bright speck: above threshold but below minBlobAreaPx (10).
    for (const [x, y] of [[5, 5], [6, 5], [5, 6], [6, 6]]) {
      const o = (y * 64 + x) * 4;
      after[o] = after[o + 1] = after[o + 2] = 250;
    }
    const res = detectAnomalies(before, after, 64, 64, SMALL_G);
    expect(res.anomalies).toHaveLength(0);
  });

  it('finds a seeded blob, georeferences its centroid, and reports sane fields', () => {
    const before = flatRgba(64, 64, 80, 100, 60);
    const after = flatRgba(64, 64, 80, 100, 60);
    // 5x4 bright rectangle centered at pixel-center (32, 24).
    for (let y = 22; y < 26; y++) {
      for (let x = 30; x < 35; x++) {
        const o = (y * 64 + x) * 4;
        after[o] = after[o + 1] = after[o + 2] = 235;
      }
    }
    const res = detectAnomalies(before, after, 64, 64, SMALL_G);
    expect(res.anomalies).toHaveLength(1);
    const a = res.anomalies[0];
    expect(a.type).toBe('change');
    expect(a.id).toBe('sat-change-1');
    expect(a.confidence).toBeGreaterThan(0);
    expect(a.confidence).toBeLessThanOrEqual(1);
    expect(a.thumbnail.startsWith('data:image/png;base64,')).toBe(true);
    // Centroid georeferences back to the seeded pixel location.
    const px = latLonToPixel(a.lat, a.lon, SMALL_G);
    expect(px.x).toBeCloseTo(32.5, 1);
    expect(px.y).toBeCloseTo(24, 1);
  });

  it('renders a diff overlay only where change exceeds the threshold', () => {
    const before = flatRgba(8, 8, 10, 10, 10);
    const after = flatRgba(8, 8, 10, 10, 10);
    after[0] = 200; // pixel 0 changed
    const overlay = diffOverlayRgba(computeDiff(before, after, 8, 8), 8, 8);
    expect(overlay[3]).toBeGreaterThan(0);       // changed pixel visible
    expect(overlay[4 * 4 + 3]).toBe(0);          // untouched pixel transparent
  });
});

describe('baked tiles (checked-in data/, coordinates derived from site file)', () => {
  beforeEach(() => clearBakedCache());

  it('detects the seeded truth-vehicle blob within 30 m of staging[0]', () => {
    const site = loadSite();
    const stage0 = site.staging[0];
    const res = computeBakedResult();
    expect(res.anomalies.length).toBeGreaterThan(0);
    const dists = res.anomalies.map((a) => distanceMeters(a.lat, a.lon, stage0.lat, stage0.lon));
    expect(Math.min(...dists)).toBeLessThan(30);
  });

  it('finds no anomalies when a real tile is diffed against itself', () => {
    const georef = loadTilesMeta();
    const before = loadTileRgba('before');
    const res = detectAnomalies(before.rgba, before.rgba, before.width, before.height, georef);
    expect(res.anomalies).toHaveLength(0);
  });

  it('pre-baked anomalies.json agrees with detection run fresh on the tiles', () => {
    const baked = loadBakedAnomalies();
    const fresh = computeBakedResult().anomalies;
    expect(baked.length).toBe(fresh.length);
    expect(baked.length).toBeGreaterThan(0);
    for (let i = 0; i < baked.length; i++) {
      expect(distanceMeters(baked[i].lat, baked[i].lon, fresh[i].lat, fresh[i].lon)).toBeLessThan(1);
      expect(baked[i].id).toBe(fresh[i].id);
      expect(baked[i].type).toBe('change');
      expect(baked[i].confidence).toBeGreaterThan(0);
      expect(baked[i].confidence).toBeLessThanOrEqual(1);
      expect(baked[i].thumbnail.startsWith('data:image/png;base64,')).toBe(true);
    }
  });

  it('getAnomalies defaults to baked mode and never needs the network', () => {
    expect(resolveSatMode({})).toBe('baked');
    expect(resolveSatMode({ EIS_SAT_MODE: 'live' })).toBe('live');
    const anomalies = getAnomalies({ mode: 'baked' });
    expect(anomalies.length).toBeGreaterThan(0);
    expect(getAnomalies({ mode: 'baked' })).toBe(anomalies); // memoized
  });

  it('live mode without tile bytes throws a helpful error', () => {
    expect(() => getAnomalies({ mode: 'live' })).toThrow(/beforePng/);
  });

  it('live mode runs the core on provided PNG bytes', () => {
    const dataDir = fileURLToPath(new URL('../data/', import.meta.url));
    const beforePng = new Uint8Array(readFileSync(resolve(dataDir, 'before.png')));
    const afterPng = new Uint8Array(readFileSync(resolve(dataDir, 'after.png')));
    const anomalies = getAnomalies({ mode: 'live', beforePng, afterPng });
    expect(anomalies.length).toBeGreaterThan(0);
    const site = loadSite();
    const stage0 = site.staging[0];
    const dists = anomalies.map((a) => distanceMeters(a.lat, a.lon, stage0.lat, stage0.lon));
    expect(Math.min(...dists)).toBeLessThan(30);
  });
});
