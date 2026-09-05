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
 *   power:inhibit      invoke → Promise<void>  (Linux: hold a powerSaveBlocker)
 *   power:release      invoke → Promise<void>  (Linux: drop the powerSaveBlocker)
 */

import { ipcMain, app, powerSaveBlocker } from 'electron';
import { settingsStore } from './settingsStore';
import { recorder } from './recorder';

/** Subset of ConnectionConfig — only what the main process provides as defaults */
interface DefaultConnectionConfig {
  host?: string;
  controlPort?: number;
  videoUrl?: string;
  sitl?: boolean;
}

export function registerIpcHandlers(): void {
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
