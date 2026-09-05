# eis-satellite — offline satellite change detection

Plain TypeScript package (ZERO Electron deps, zero runtime npm deps). Detects
"change" anomalies between two georeferenced RGB tiles and emits contract
`Anomaly[]` (`ground/ui/src/contract/index.ts` — the type here is a structural
copy, guarded by `test/contract-compat.test.ts` at typecheck time).

Nothing in this package ever touches the network. `EIS_SAT_MODE=baked`
(default) serves anomalies from the checked-in synthetic tiles in `data/`;
`EIS_SAT_MODE=live` runs the same detector on caller-provided tile bytes.

## Layout

```
src/
  types.ts    Anomaly (contract copy), GeoRefTiles, blob/option/result types
  georef.ts   pixel <-> lat/lon (linear within tiles.json bounds), haversine
  png.ts      browser-safe PNG ENCODER (stored zlib) + base64/data URLs
  detect.ts   THE CORE: diff -> threshold -> connected components -> blobs
              -> georeferenced Anomaly[] + RGBA diff overlay. Pure: operates
              on RGBA Uint8Array + width/height. No canvas/DOM/Node APIs.
  node/
    png.ts    Node-only codec (node:zlib): deflate encoder + full decoder
    baked.ts  EIS_SAT_MODE resolution, baked-data loading, getAnomalies()
scripts/make-tiles.mjs   tile generator (see below)
data/                    baked tiles: before.png, after.png, tiles.json,
                         anomalies.json (all generated, checked in)
```

## Consuming

Build once (`npm run build`) for Node consumers; Vite consumers can import the
TS sources directly.

```ts
// Node (planner e2e CLI, demo scripts) — after `npm run build`:
import { getAnomalies } from '../satellite/dist/node/index.js';
const anomalies = getAnomalies();          // contract Anomaly[]; EIS_SAT_MODE-aware

// Live mode (explicit tile bytes; still offline):
import { detectFromPngBytes } from '../satellite/dist/node/index.js';
const { anomalies, overlayRgba } = detectFromPngBytes(beforeBytes, afterBytes);

// Browser (ground/ui via Vite) — import sources or the baked JSON directly:
import { detectAnomalies, diffOverlayRgba } from '../../satellite/src/index';
import anomalies from '../../satellite/data/anomalies.json';
import tiles from '../../satellite/data/tiles.json';
```

`data/tiles.json` bounds (`{north,south,east,west}`) are ready-made for a
leaflet `ImageOverlay` of `before.png`/`after.png`/the diff overlay:
`[[south, west], [north, east]]`.

### Decoding PNGs

PNG decode is deliberately **not** in the core — the core takes raw RGBA.

- **Node**: `import { decodePng } from '.../dist/node/index.js'` (node:zlib).
- **Browser**: decode via Image/canvas, then hand the RGBA to the core:

```ts
async function rgbaFromUrl(url: string) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { rgba: new Uint8Array(d.data.buffer), width: c.width, height: c.height };
}
```

Thumbnails in `Anomaly.thumbnail` are self-contained `data:image/png;base64,`
URLs (encoded with the dependency-free stored-PNG encoder) — render them in an
`<img>` with no further work.

## Baked tiles + generator

`data/` holds two synthetic Sentinel-2-style 512x512 tiles covering the site
perimeter with 30% margin. Everything is derived from the site model (per
`docs/SITE_CONTRACT.md`): bounds from perimeter + staging points, industrial
texture rasterized from the site's NFZ polygons, and the after-tile's compact
bright change blob (truth vehicle) at the site's **first staging point**.
Nothing is hardcoded to the plant.

Regenerate whenever the site file changes:

```
npm run generate                       # uses $EIS_SITE_FILE, else site/site.stub.json
node scripts/make-tiles.mjs site/site.json   # explicit site file (repo-root relative)
```

The generator imports this package's own compiled core (no duplicated math),
runs the REAL detector on the tiles it just drew, refuses to write output if
the detected anomaly is not within 30 m of staging[0], and pre-bakes the
result into `data/anomalies.json`.

## Detection tuning

`DetectOptions` (all defaulted in `DETECT_DEFAULTS`): `threshold` 28 (per-pixel
max-channel abs diff), `minBlobAreaPx` 10, `maxBlobs` 16, `connectivity` 8,
`idPrefix` 'sat-change', `thumbnails` true. The baked tiles carry independent
per-acquisition sensor noise (pairwise diff <= 10) plus a +3 illumination
drift, so the diff is non-trivial but safely below threshold everywhere except
the seeded change.

## Commands

```
npm install        # dev deps only (typescript, vitest, @types/node)
npm run build      # tsc -> dist/ (ESM + .d.ts)
npm run typecheck  # includes the contract-compat assignability guard
npm test           # vitest: georef roundtrip, png codec roundtrip,
                   #   no-change => no anomalies, seeded blob within 30 m
                   #   of staging[0], baked json consistency, mode selection
npm run generate   # build + regenerate data/ from the site file
```
