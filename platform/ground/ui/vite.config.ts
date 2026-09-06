/// <reference types="vitest" />
import { defineConfig, type Plugin, type Connect } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ServerResponse } from 'node:http';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The ground station's dev port. `EIS_UI_PORT` moves BOTH the Vite server and
 * the Electron shell's DEV_URL (which reads the same variable), so two stacks
 * on one machine can coexist without either guessing where the other went.
 * The port is STRICT: see `server.strictPort` below (FM-131).
 */
const DEV_PORT = Number(process.env.EIS_UI_PORT ?? 5173) || 5173;

/**
 * Serves GET /site.json from the repo root during `vite dev` / `vite preview`,
 * reading the file named by EIS_SITE_FILE (default site/site.stub.json).
 * The site model is consumed ONLY via this JSON (docs/SITE_CONTRACT.md) —
 * in the packaged Electron app the equivalent is window.eis.loadSiteFile().
 */
function siteFilePlugin(): Plugin {
  const handler: Connect.NextHandleFunction = (req, res: ServerResponse, next) => {
    const url = (req.url ?? '').split('?')[0];
    if (url !== '/site.json') return next();
    const rel = process.env.EIS_SITE_FILE?.trim() || 'site/site.stub.json';
    const file = path.isAbsolute(rel) ? rel : path.resolve(REPO_ROOT, rel);
    try {
      const text = fs.readFileSync(file, 'utf8');
      res.setHeader('Content-Type', 'application/json');
      res.end(text);
    } catch (err) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `site file not readable: ${file} (${(err as Error).message})` }));
    }
  };
  return {
    name: 'eis-site-file',
    configureServer(server) { server.middlewares.use(handler); },
    configurePreviewServer(server) { server.middlewares.use(handler); },
  };
}

/**
 * MapLibre 6 runs its GeoJSON and symbol work in a Web Worker. We hand it the worker as a hashed
 * `?url` asset, but the worker itself imports `./maplibre-gl-shared.mjs` by its plain name, so the
 * production bundle needs that exact file next to the hashed worker. Without it every vector layer
 * silently never renders (the style never finishes loading) while raster tiles still show.
 */
function maplibreSharedChunk(): Plugin {
  const shared = fileURLToPath(new URL('./node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs', import.meta.url));
  return {
    name: 'maplibre-shared-chunk',
    apply: 'build',
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'assets/maplibre-gl-shared.mjs', source: fs.readFileSync(shared) }); },
  };
}

// base: './' so the production bundle loads from file:// inside the Electron shell.
export default defineConfig({
  base: './',
  plugins: [react(), siteFilePlugin(), maplibreSharedChunk()],
  resolve: {
    dedupe: ['react', 'react-dom', 'react/jsx-runtime'],
    preserveSymlinks: true,
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Cross-package source imports (plain TS packages, zero Electron deps).
      '@planner': fileURLToPath(new URL('../planner/src', import.meta.url)),
      '@satellite': fileURLToPath(new URL('../satellite/src', import.meta.url)),
      '@satdata': fileURLToPath(new URL('../satellite/data', import.meta.url)),
      // eis-cues: the browser-safe core only (its ./node entry is never
      // imported here), plus the scripted fixtures the offline rails replay.
      '@cues': fileURLToPath(new URL('../cues/src', import.meta.url)),
      '@cuefixtures': fileURLToPath(new URL('../cues/fixtures', import.meta.url)),
      // eis-planner/site.ts imports Node builtins at module scope for its
      // Node-side loaders; the renderer only uses its pure exports. Point the
      // builtins at throwing stubs so dev/build stay warning-free.
      fs: fileURLToPath(new URL('./src/lib/nodeShims.ts', import.meta.url)),
      path: fileURLToPath(new URL('./src/lib/nodeShims.ts', import.meta.url)),
    },
  },
  server: {
    port: DEV_PORT,
    /**
     * STRICT (FM-131). With `strictPort: false` Vite silently moved to 5174
     * when 5173 was taken — by a teammate's Console dev server, a sibling
     * worktree, or a leftover Vite — `wait-on` was satisfied by whatever
     * answered 5173, and the Electron shell rendered someone else's page in
     * the ground-station window. Failing to start is recoverable in one
     * command; rendering a foreign app in a flight-control window is not.
     */
    strictPort: true,
    fs: {
      // Allow importing eis-planner/eis-satellite sources + baked data + the
      // site stub from outside the UI package root.
      allow: [REPO_ROOT],
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2021',
  },
});
