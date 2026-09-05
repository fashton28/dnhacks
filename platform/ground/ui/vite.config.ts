import { defineConfig, type Plugin, type Connect } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ServerResponse } from 'node:http';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

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

// base: './' so the production bundle loads from file:// inside the Electron shell.
export default defineConfig({
  base: './',
  plugins: [react(), siteFilePlugin()],
  resolve: {
    dedupe: ['react', 'react-dom', 'react/jsx-runtime'],
    preserveSymlinks: true,
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Cross-package source imports (plain TS packages, zero Electron deps).
      '@planner': fileURLToPath(new URL('../planner/src', import.meta.url)),
      '@satellite': fileURLToPath(new URL('../satellite/src', import.meta.url)),
      '@satdata': fileURLToPath(new URL('../satellite/data', import.meta.url)),
      // eis-planner/site.ts imports Node builtins at module scope for its
      // Node-side loaders; the renderer only uses its pure exports. Point the
      // builtins at throwing stubs so dev/build stay warning-free.
      fs: fileURLToPath(new URL('./src/lib/nodeShims.ts', import.meta.url)),
      path: fileURLToPath(new URL('./src/lib/nodeShims.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    fs: {
      // Allow importing eis-planner/eis-satellite sources + baked data + the
      // site stub from outside the UI package root.
      allow: [REPO_ROOT],
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2021',
  },
});
