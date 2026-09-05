/**
 * preload.ts — Electron preload script.
 *
 * Runs in a privileged context that has access to both Node.js (via
 * contextBridge) and the renderer DOM.  Exposes the ElectronBridge contract
 * defined in ground/ui/src/vite-env.d.ts as window.eis.
 *
 * Security model:
 *   • contextIsolation: true  — this script lives in a separate V8 context
 *     from the renderer; it cannot be reached from renderer JS directly.
 *   • nodeIntegration: false  — the renderer has no Node.js access at all.
 *   • Every renderer call goes through ipcRenderer.invoke / .send which are
 *     validated (channel-allowlisted) by Electron before reaching ipcMain.
 *   • recorder.append uses ipcRenderer.send (fire-and-forget) because it is
 *     called at high telemetry rate and must not block on an ack.
 *
 * Type note: the ElectronBridge interface is re-declared inline here so that
 * this package (ground/app) compiles independently of ground/ui's source tree.
 * The authoritative shape lives in ground/ui/src/vite-env.d.ts — keep in sync.
 */

import { contextBridge, ipcRenderer } from 'electron';

// ── Inline bridge shape (mirrors ground/ui/src/vite-env.d.ts) ───────────────
// Re-declared here so ground/app compiles without a build-time path dependency
// on ground/ui/src.  Keep in sync with vite-env.d.ts and contract/index.ts.

interface ConnectionConfig {
  host: string;
  controlPort: number;
  videoUrl: string;
  sitl: boolean;
}

interface RecorderSessionMeta {
  id: string;
  path: string;
  startedAt: number;
  durationMs: number;
  size: number;
}

interface ElectronBridge {
  settings: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    all(): Promise<Record<string, unknown>>;
  };
  recorder: {
    start(meta?: Record<string, unknown>): Promise<{ sessionId: string }>;
    stop(): Promise<{ sessionId: string; path: string } | null>;
    append(record: unknown): void;
    list(): Promise<RecorderSessionMeta[]>;
    load(id: string): Promise<{ meta: Record<string, unknown>; frames: unknown[] } | null>;
  };
  app: {
    version(): Promise<string>;
    platform: string;
  };
  defaultConfig(): Promise<Partial<ConnectionConfig>>;
  /** Raw JSON text of the EIS_SITE_FILE-selected site model (docs/SITE_CONTRACT.md). */
  loadSiteFile(): Promise<string>;
  /** Baked satellite change-detection assets; null → fall back to dev-server fetch. */
  loadSatelliteTiles(): Promise<{
    beforePng: string;
    afterPng: string;
    tilesJson: string;
    anomaliesJson: string | null;
  } | null>;
}

// ── Bridge implementation ────────────────────────────────────────────────────

const bridge: ElectronBridge = {
  // ── Settings ──────────────────────────────────────────────────────────────
  settings: {
    get<T = unknown>(key: string): Promise<T | undefined> {
      return ipcRenderer.invoke('settings:get', key) as Promise<T | undefined>;
    },
    set(key: string, value: unknown): Promise<void> {
      return ipcRenderer.invoke('settings:set', key, value) as Promise<void>;
    },
    all(): Promise<Record<string, unknown>> {
      return ipcRenderer.invoke('settings:all') as Promise<Record<string, unknown>>;
    },
  },

  // ── Recorder ──────────────────────────────────────────────────────────────
  recorder: {
    start(meta?: Record<string, unknown>): Promise<{ sessionId: string }> {
      return ipcRenderer.invoke('recorder:start', meta) as Promise<{ sessionId: string }>;
    },
    stop(): Promise<{ sessionId: string; path: string } | null> {
      return ipcRenderer.invoke('recorder:stop') as Promise<{
        sessionId: string;
        path: string;
      } | null>;
    },
    /**
     * Fire-and-forget: uses ipcRenderer.send (not invoke) so the renderer
     * does NOT block waiting for a main-process ack on every telemetry frame.
     * Matched by ipcMain.on('recorder:append', ...) in ipc.ts.
     */
    append(record: unknown): void {
      ipcRenderer.send('recorder:append', record);
    },
    list(): Promise<RecorderSessionMeta[]> {
      return ipcRenderer.invoke('recorder:list') as Promise<RecorderSessionMeta[]>;
    },
    load(id: string): Promise<{ meta: Record<string, unknown>; frames: unknown[] } | null> {
      return ipcRenderer.invoke('recorder:load', id) as Promise<{
        meta: Record<string, unknown>;
        frames: unknown[];
      } | null>;
    },
  },

  // ── App metadata ──────────────────────────────────────────────────────────
  app: {
    version(): Promise<string> {
      return ipcRenderer.invoke('app:version') as Promise<string>;
    },
    // process.platform is available in preload without nodeIntegration
    platform: process.platform,
  },

  // ── Default connection config (env-baked) ─────────────────────────────────
  defaultConfig(): Promise<Partial<ConnectionConfig>> {
    return ipcRenderer.invoke('app:defaultConfig') as Promise<Partial<ConnectionConfig>>;
  },

  // ── Site model + baked satellite assets (hackathon retrofit) ──────────────
  loadSiteFile(): Promise<string> {
    return ipcRenderer.invoke('site:load') as Promise<string>;
  },
  loadSatelliteTiles(): Promise<{
    beforePng: string;
    afterPng: string;
    tilesJson: string;
    anomaliesJson: string | null;
  } | null> {
    return ipcRenderer.invoke('satellite:loadTiles') as Promise<{
      beforePng: string;
      afterPng: string;
      tilesJson: string;
      anomaliesJson: string | null;
    } | null>;
  },
};

contextBridge.exposeInMainWorld('eis', bridge);
