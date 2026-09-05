#!/usr/bin/env node
/* ============================================================================
 * eis-satellite tile generator — run via `npm run generate` (builds dist first;
 * this script imports the package's own compiled core so georef/detection math
 * is never duplicated).
 *
 *   node scripts/make-tiles.mjs [siteFile]
 *
 * siteFile: path to the site JSON (docs/SITE_CONTRACT.md schema), resolved
 * against the repo root when relative. Default: $EIS_SITE_FILE, else
 * site/site.stub.json.
 *
 * Produces in ground/satellite/data/ :
 *   before.png / after.png  — 512x512 synthetic Sentinel-2-style RGB tiles
 *                             covering the site perimeter with margin
 *   tiles.json              — { boundsLatLon:{north,south,east,west},
 *                               widthPx, heightPx } georef sidecar
 *   anomalies.json          — contract Anomaly[] pre-baked by running the REAL
 *                             detection core on the generated tiles
 *
 * NOTHING is hardcoded to the plant: bounds come from the site perimeter +
 * staging points, the industrial texture is rasterized from the site's NFZ
 * polygons, and the seeded "change" blob (truth vehicle) sits at the site's
 * FIRST staging point. Re-run this script whenever the site file changes.
 * ========================================================================== */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  detectAnomalies,
  distanceMeters,
  encodePng,
  latLonToPixel,
  metersPerPixel,
} from '../dist/node/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(PKG_ROOT, '..', '..');
const DATA_DIR = join(PKG_ROOT, 'data');

const SIZE = 512;           // tile is SIZE x SIZE px
const MARGIN_FRAC = 0.3;    // bounds margin per side, fraction of the span
const SEED = 0x5eed2026;    // deterministic texture seed

/* ---- site loading --------------------------------------------------------- */

const siteArg = process.argv[2] ?? process.env.EIS_SITE_FILE ?? 'site/site.stub.json';
const sitePath = isAbsolute(siteArg) ? siteArg : resolve(REPO_ROOT, siteArg);
const site = JSON.parse(readFileSync(sitePath, 'utf8'));

if (!Array.isArray(site.perimeter) || site.perimeter.length < 3) {
  console.error(`make-tiles: ${sitePath} has no usable perimeter`);
  process.exit(1);
}
if (!Array.isArray(site.staging) || site.staging.length === 0) {
  console.error(`make-tiles: ${sitePath} has no staging points (need staging[0] for the truth blob)`);
  process.exit(1);
}

/* ---- bounds: perimeter + staging points, plus margin ---------------------- */

const pts = [
  ...site.perimeter.map(([lat, lon]) => ({ lat, lon })),
  ...site.staging.map((s) => ({ lat: s.lat, lon: s.lon })),
];
let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
for (const p of pts) {
  minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
  minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
}
const latMargin = (maxLat - minLat) * MARGIN_FRAC;
const lonMargin = (maxLon - minLon) * MARGIN_FRAC;
const georef = {
  boundsLatLon: {
    north: maxLat + latMargin,
    south: minLat - latMargin,
    east: maxLon + lonMargin,
    west: minLon - lonMargin,
  },
  widthPx: SIZE,
  heightPx: SIZE,
};

/* ---- deterministic PRNG + value noise ------------------------------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bilinear value noise field, cell size in px, values 0..1. */
function valueNoise(size, cell, rand) {
  const gw = Math.ceil(size / cell) + 2;
  const grid = new Float32Array(gw * gw);
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const gy = y / cell;
    const y0 = Math.floor(gy);
    const fy = gy - y0;
    const sy = fy * fy * (3 - 2 * fy);
    for (let x = 0; x < size; x++) {
      const gx = x / cell;
      const x0 = Math.floor(gx);
      const fx = gx - x0;
      const sx = fx * fx * (3 - 2 * fx);
      const i00 = grid[y0 * gw + x0];
      const i10 = grid[y0 * gw + x0 + 1];
      const i01 = grid[(y0 + 1) * gw + x0];
      const i11 = grid[(y0 + 1) * gw + x0 + 1];
      out[y * size + x] =
        i00 * (1 - sx) * (1 - sy) + i10 * sx * (1 - sy) +
        i01 * (1 - sx) * sy + i11 * sx * sy;
    }
  }
  return out;
}

/* ---- polygon rasterization helpers ---------------------------------------- */

/** [lat,lon] site ring -> continuous px vertex list via the shared georef. */
function ringToPx(ring) {
  return ring.map(([lat, lon]) => latLonToPixel(lat, lon, georef));
}

function pointInPolygonPx(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/* ---- base texture ---------------------------------------------------------- */

const rand = mulberry32(SEED);
const octA = valueNoise(SIZE, 96, rand);  // patchwork fields
const octB = valueNoise(SIZE, 34, rand);  // medium relief
const octC = valueNoise(SIZE, 11, rand);  // fine texture
const patch = valueNoise(SIZE, 72, rand); // field-boundary quantization

const perimeterPx = ringToPx(site.perimeter);
const nfzPx = (site.nfz ?? []).map((z) => ringToPx(z.polygon));

// Seeded "buildings" inside each NFZ bbox (site-derived placement).
const buildings = [];
for (const poly of nfzPx) {
  let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;
  for (const v of poly) {
    bMinX = Math.min(bMinX, v.x); bMaxX = Math.max(bMaxX, v.x);
    bMinY = Math.min(bMinY, v.y); bMaxY = Math.max(bMaxY, v.y);
  }
  for (let i = 0; i < 4; i++) {
    const w = 4 + Math.floor(rand() * 8);
    const h = 4 + Math.floor(rand() * 8);
    const x = bMinX + rand() * Math.max(1, bMaxX - bMinX - w);
    const y = bMinY + rand() * Math.max(1, bMaxY - bMinY - h);
    buildings.push({ x, y, w, h, dark: rand() < 0.5 });
  }
}

/** Base scene color (RGB) for pixel (x, y) — same for both tiles. */
function baseColor(x, y) {
  const i = y * SIZE + x;
  const t = 0.5 * octA[i] + 0.32 * octB[i] + 0.18 * octC[i];
  const p = Math.floor(patch[i] * 5) / 5; // quantized patch tint

  // Vegetation/fields ramp: dark green -> olive -> tan.
  let r = 52 + 90 * t + 34 * p;
  let g = 74 + 72 * t + 22 * p;
  let b = 42 + 40 * t + 12 * p;

  // Industrial ground inside NFZ polygons (concrete/gravel).
  for (const poly of nfzPx) {
    if (pointInPolygonPx(x + 0.5, y + 0.5, poly)) {
      const c = 116 + 34 * octC[i] + 10 * octB[i];
      r = c + 6; g = c + 4; b = c;
      break;
    }
  }

  // Buildings (site-derived rects inside NFZs).
  for (const bl of buildings) {
    if (x + 0.5 >= bl.x && x + 0.5 <= bl.x + bl.w && y + 0.5 >= bl.y && y + 0.5 <= bl.y + bl.h) {
      const c = bl.dark ? 62 + 12 * octC[i] : 158 + 20 * octC[i];
      r = c + 4; g = c + 2; b = c;
      break;
    }
  }
  return [r, g, b];
}

/** Distance from point to segment (px). */
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function nearPerimeterFence(x, y) {
  for (let i = 0; i < perimeterPx.length; i++) {
    const a = perimeterPx[i];
    const b = perimeterPx[(i + 1) % perimeterPx.length];
    if (distToSeg(x + 0.5, y + 0.5, a.x, a.y, b.x, b.y) < 0.9) return true;
  }
  return false;
}

/* ---- render both tiles ----------------------------------------------------- */

const before = new Uint8Array(SIZE * SIZE * 4);
const after = new Uint8Array(SIZE * SIZE * 4);
const noiseBefore = mulberry32(SEED ^ 0x1111);
const noiseAfter = mulberry32(SEED ^ 0x2222);
const AFTER_BRIGHTNESS = 3; // mild global illumination drift, well below threshold

const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let [r, g, b] = baseColor(x, y);
    if (nearPerimeterFence(x, y)) { r = 70; g = 68; b = 64; } // fence line
    const o = (y * SIZE + x) * 4;
    // Independent per-pixel sensor noise on each acquisition (amplitude ±5:
    // worst-case pairwise diff 10, safely under the detection threshold 28).
    const nb = (noiseBefore() - 0.5) * 10;
    const na = (noiseAfter() - 0.5) * 10;
    before[o] = clamp8(r + nb);
    before[o + 1] = clamp8(g + nb);
    before[o + 2] = clamp8(b + nb);
    before[o + 3] = 255;
    after[o] = clamp8(r + na + AFTER_BRIGHTNESS);
    after[o + 1] = clamp8(g + na + AFTER_BRIGHTNESS);
    after[o + 2] = clamp8(b + na + AFTER_BRIGHTNESS);
    after[o + 3] = 255;
  }
}

/* ---- the change blob: truth vehicle at the site's FIRST staging point ------ */

const stage0 = site.staging[0];
const blobCenter = latLonToPixel(stage0.lat, stage0.lon, georef);
const blobRand = mulberry32(SEED ^ 0x3333);
const RX = 5.5; // px semi-axes — compact bright vehicle-scale blob
const RY = 3.2;

for (let dy = -Math.ceil(RY) - 3; dy <= Math.ceil(RY) + 3; dy++) {
  for (let dx = -Math.ceil(RX) - 3; dx <= Math.ceil(RX) + 3; dx++) {
    const x = Math.floor(blobCenter.x) + dx;
    const y = Math.floor(blobCenter.y) + dy;
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
    const o = (y * SIZE + x) * 4;
    const e = (dx / RX) ** 2 + (dy / RY) ** 2;
    const es = ((dx - 2) / RX) ** 2 + ((dy - 2) / RY) ** 2; // shadow offset
    if (e <= 1) {
      const j = (blobRand() - 0.5) * 14;
      after[o] = clamp8(228 + j);
      after[o + 1] = clamp8(230 + j);
      after[o + 2] = clamp8(238 + j);
    } else if (es <= 1) {
      after[o] = clamp8(after[o] - 38);
      after[o + 1] = clamp8(after[o + 1] - 38);
      after[o + 2] = clamp8(after[o + 2] - 38);
    }
  }
}

/* ---- self-check with the REAL detector, then write outputs ----------------- */

const result = detectAnomalies(before, after, SIZE, SIZE, georef);
if (result.anomalies.length === 0) {
  console.error('make-tiles: SELF-CHECK FAILED — detector found no anomalies in generated tiles');
  process.exit(1);
}
const distances = result.anomalies.map((a) =>
  distanceMeters(a.lat, a.lon, stage0.lat, stage0.lon),
);
const bestDist = Math.min(...distances);
if (bestDist > 30) {
  console.error(
    `make-tiles: SELF-CHECK FAILED — nearest detected anomaly is ${bestDist.toFixed(1)} m ` +
    `from staging[0] '${stage0.id}' (must be within 30 m)`,
  );
  process.exit(1);
}

mkdirSync(DATA_DIR, { recursive: true });
writeFileSync(join(DATA_DIR, 'before.png'), encodePng(before, SIZE, SIZE));
writeFileSync(join(DATA_DIR, 'after.png'), encodePng(after, SIZE, SIZE));
writeFileSync(
  join(DATA_DIR, 'tiles.json'),
  JSON.stringify(
    {
      ...georef,
      // Additive provenance (consumers only rely on the three keys above).
      generated: {
        by: 'ground/satellite/scripts/make-tiles.mjs',
        siteFile: siteArg.replace(/\\/g, '/'),
        seed: SEED,
      },
    },
    null,
    2,
  ) + '\n',
);
writeFileSync(
  join(DATA_DIR, 'anomalies.json'),
  JSON.stringify(result.anomalies, null, 2) + '\n',
);

const mpp = metersPerPixel(georef);
console.log(`make-tiles: site         ${sitePath}`);
console.log(
  `make-tiles: bounds       N ${georef.boundsLatLon.north.toFixed(6)}  S ${georef.boundsLatLon.south.toFixed(6)}  ` +
  `E ${georef.boundsLatLon.east.toFixed(6)}  W ${georef.boundsLatLon.west.toFixed(6)}`,
);
console.log(`make-tiles: resolution   ${mpp.x.toFixed(2)} x ${mpp.y.toFixed(2)} m/px @ ${SIZE}px`);
console.log(`make-tiles: anomalies    ${result.anomalies.length} (best ${bestDist.toFixed(1)} m from staging[0] '${stage0.id}')`);
for (const a of result.anomalies) {
  console.log(
    `make-tiles:   ${a.id}  lat ${a.lat.toFixed(6)}  lon ${a.lon.toFixed(6)}  conf ${a.confidence}` +
    `  thumb ${a.thumbnail.length} chars`,
  );
}
console.log(`make-tiles: wrote before.png, after.png, tiles.json, anomalies.json -> ${DATA_DIR}`);
