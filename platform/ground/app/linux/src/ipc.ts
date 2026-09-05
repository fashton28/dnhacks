/**
 * ipc.ts — registers all ipcMain handlers that implement the ElectronBridge
 * contract on the main-process side.
 *
 * Channel naming matches what preload.ts calls via ipcRenderer.invoke / .send.
 *
 * Channels:
 *   settings:get       invoke → Promise<value | undefined>
 *   settings:set       invoke → Promise<void>
 *   settings:all       invoke → Promise<Record<string, unknown>>
 *
 *   recorder:start     invoke → Promise<{ sessionId }>
 *   recorder:stop      invoke → Promise<{ sessionId, path } | null>
 *   recorder:append    send   (one-way, fire-and-forget)
 *   recorder:list      invoke → Promise<SessionMeta[]>
 *   recorder:load      invoke → Promise<{ meta, frames } | null>
 *
 *   app:version        invoke → Promise<string>
 *   app:defaultConfig  invoke → Promise<Partial<ConnectionConfig>>
 *
 *   site:load            invoke → Promise<string>   (site JSON text, EIS_SITE_FILE)
 *   satellite:loadTiles  invoke → Promise<SatelliteTilesPayload | null>
 *
 *   power:inhibit      invoke → Promise<void>  (Linux: hold a powerSaveBlocker)
 *   power:release      invoke → Promise<void>  (Linux: drop the powerSaveBlocker)
 */

import * as fs from 'fs';
import * as path from 'path';
import { ipcMain, app, powerSaveBlocker } from 'electron';
import { settingsStore } from './settingsStore';
import { recorder } from './recorder';
import { registerPhase3Handlers } from './phase3Host';

/** Subset of ConnectionConfig — only what the main process provides as defaults */
interface DefaultConnectionConfig {
  host?: string;
  controlPort?: number;
  videoUrl?: string;
  sitl?: boolean;
}

/** Payload returned by satellite:loadTiles (baked change-detection assets). */
interface SatelliteTilesPayload {
  /** before.png, base64-encoded (no data: prefix) */
  beforePng: string;
  /** after.png, base64-encoded (no data: prefix) */
  afterPng: string;
  /** raw JSON text of tiles.json (bounds + pixel dims) */
  tilesJson: string;
  /** raw JSON text of anomalies.json (baked detections), null if absent */
  anomaliesJson: string | null;
}

/**
 * Root that repo-root-relative asset paths (docs/SITE_CONTRACT.md) resolve
 * against:
 *   • packaged        → process.resourcesPath (extraResources land there)
 *   • dev/unpackaged  → the repo root
 *     (dist-electron → ground/app/<os> → ground/app → ground → repo root)
 */
function assetRoot(): string {
  if (app.isPackaged) return process.resourcesPath;
  return path.join(__dirname, '..', '..', '..', '..');
}

/** Resolve a repo-root-relative (or absolute) path against assetRoot(). */
function resolveAsset(p: string): string {
  return path.isAbsolute(p) ? p : path.join(assetRoot(), p);
}

export function registerIpcHandlers(): void {
  registerPhase3Handlers(assetRoot());
  // ── Settings ──────────────────────────────────────────────────────────────
  ipcMain.handle('settings:get', (_event, key: string) => {
    return settingsStore.get(key);
  });

  ipcMain.handle('settings:set', (_event, key: string, value: unknown) => {
    return settingsStore.set(key, value);
  });

  ipcMain.handle('settings:all', () => {
    return settingsStore.all();
  });

  // ── Recorder ──────────────────────────────────────────────────────────────
  ipcMain.handle('recorder:start', (_event, meta?: Record<string, unknown>) => {
    return recorder.start(meta);
  });

  ipcMain.handle('recorder:stop', () => {
    return recorder.stop();
  });

  // Fire-and-forget — use ipcMain.on (not handle) to match ipcRenderer.send
  ipcMain.on('recorder:append', (_event, frame: unknown) => {
    recorder.append(frame);
  });

  ipcMain.handle('recorder:list', () => {
    return recorder.list();
  });

  ipcMain.handle('recorder:load', (_event, id: string) => {
    return recorder.load(id);
  });

  // ── App metadata ──────────────────────────────────────────────────────────
  ipcMain.handle('app:version', () => {
    return Promise.resolve(app.getVersion());
  });

  ipcMain.handle('app:defaultConfig', (): DefaultConnectionConfig => {
    const host = process.env['EIS_HOST'] ?? 'sitl';
    const portStr = process.env['EIS_CONTROL_PORT'];
    const controlPort = portStr ? parseInt(portStr, 10) : 8765;
    const videoUrl = process.env['EIS_VIDEO_URL'] ?? '';
    const sitlStr = process.env['EIS_SITL'];
    // Default to sitl=true if host is "sitl" or EIS_SITL is truthy
    const sitl =
      host === 'sitl' ||
      sitlStr === 'true' ||
      sitlStr === '1' ||
      sitlStr === 'yes';

    return { host, controlPort, videoUrl, sitl };
  });

  // ── Site model + baked satellite assets (hackathon retrofit) ──────────────
  // Site JSON selection per docs/SITE_CONTRACT.md: EIS_SITE_FILE (repo-root-
  // relative), default site/site.json; the default falls back to
  // site/site.stub.json when the real deliverable is absent. An explicitly set
  // EIS_SITE_FILE never silently falls back — a missing file rejects loudly.
  ipcMain.handle('site:load', (): string => {
    const envFile = process.env['EIS_SITE_FILE'];
    if (envFile) {
      return fs.readFileSync(resolveAsset(envFile), 'utf8');
    }
    const primary = resolveAsset('site/site.json');
    if (fs.existsSync(primary)) {
      return fs.readFileSync(primary, 'utf8');
    }
    return fs.readFileSync(resolveAsset('site/site.stub.json'), 'utf8');
  });
  ipcMain.handle('site:resolveAsset', (_event, requested: string): string | null => {
    if (typeof requested !== 'string' || requested.includes('\0')) return null;
    const envFile = process.env['EIS_SITE_FILE'];
    const siteDir = envFile ? path.dirname(resolveAsset(envFile)) : resolveAsset('site');
    const relative = requested.replace(/\\/g, '/').replace(/^site\//, '');
    const resolved = path.resolve(siteDir, relative);
    if (!resolved.startsWith(path.resolve(siteDir) + path.sep) || !/\.(png|jpe?g|webp)$/i.test(resolved) || !fs.existsSync(resolved)) return null;
    const ext = path.extname(resolved).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,${fs.readFileSync(resolved).toString('base64')}`;
  });

  // Baked before/after change-detection PNGs + metadata from
  // ground/satellite/data (identical relative path when packaged, via
  // extraResources). Returns null when the assets are absent so the renderer
  // can fall back to a dev-server fetch.
  ipcMain.handle('satellite:loadTiles', (): SatelliteTilesPayload | null => {
    const dir = resolveAsset(path.join('ground', 'satellite', 'data'));
    const beforePath = path.join(dir, 'before.png');
    const afterPath = path.join(dir, 'after.png');
    const tilesPath = path.join(dir, 'tiles.json');
    if (
      !fs.existsSync(beforePath) ||
      !fs.existsSync(afterPath) ||
      !fs.existsSync(tilesPath)
    ) {
      return null;
    }
    const anomaliesPath = path.join(dir, 'anomalies.json');
    return {
      beforePng: fs.readFileSync(beforePath).toString('base64'),
      afterPng: fs.readFileSync(afterPath).toString('base64'),
      tilesJson: fs.readFileSync(tilesPath, 'utf8'),
      anomaliesJson: fs.existsSync(anomaliesPath)
        ? fs.readFileSync(anomaliesPath, 'utf8')
        : null,
    };
  });

  // ── Power management (LINUX_PRD §7) ─────────────────────────────────────────
  // Inhibit screen-blank / suspend while the vehicle is armed or
  // tracking/manual-active; release on disarm. The renderer drives this from
  // telemetry via window.eis.power.inhibit()/release(). powerSaveBlocker is a
  // freedesktop/systemd-inhibit shim on Linux (and a no-cost no-op elsewhere).
  let powerBlockerId: number | null = null;

  ipcMain.handle('power:inhibit', () => {
    if (powerBlockerId === null || !powerSaveBlocker.isStarted(powerBlockerId)) {
      powerBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    }
    return Promise.resolve();
  });

  ipcMain.handle('power:release', () => {
    if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) {
      powerSaveBlocker.stop(powerBlockerId);
    }
    powerBlockerId = null;
    return Promise.resolve();
  });
}
