/**
 * ipc.ts — main-process side of the `window.eis` bridge.
 *
 * One handler per channel preload.ts relays to. The channel names are the
 * contract; the table at the bottom of this file is the only place they are
 * bound to code, and `registerIpcHandlers()` walks it.
 *
 *   settings:get        invoke  (key)            → value | undefined
 *   settings:set        invoke  (key, value)     → void  (resolves after the write)
 *   settings:all        invoke  ()               → Record<string, unknown>
 *   recorder:start      invoke  (meta?)          → { sessionId }
 *   recorder:stop       invoke  ()               → { sessionId, path } | null
 *   recorder:append     send    (frame)          one-way, never acked
 *   recorder:list       invoke  ()               → SessionMeta[]
 *   recorder:load       invoke  (id)             → { meta, frames } | null
 *   app:version         invoke  ()               → string
 *   app:defaultConfig   invoke  ()               → Partial<ConnectionConfig> from env
 *   site:load           invoke  ()               → site JSON text (EIS_SITE_FILE)
 *   site:resolveAsset   invoke  (path)           → data: URL | null
 *
 * planner:* and sdr:* are registered by phase3Host.ts (not owned here).
 *
 * The env → config and path → asset rules are pure functions exported for the
 * shell self-check (scripts/selfcheck.cjs); the handlers only bind them to
 * process state.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ipcMain, app } from 'electron';
import { settingsStore } from './settingsStore';
import { recorder } from './recorder';
import { registerPhase3Handlers } from './phase3Host';

/* ── app:defaultConfig ──────────────────────────────────────────────────── */

/** Subset of ConnectionConfig — only what the main process provides as defaults */
export interface DefaultConnectionConfig {
  host?: string;
  controlPort?: number;
  videoUrl?: string;
  sitl?: boolean;
}

const DEFAULT_HOST = 'sitl';
const DEFAULT_CONTROL_PORT = 8765;
const SITL_FLAG_VALUES = new Set(['true', '1', 'yes']);

/**
 * Connection defaults baked from the environment (platform/.env via dotenv).
 *
 *   EIS_HOST          companion host, default "sitl"
 *   EIS_CONTROL_PORT  WebSocket port, default 8765 (a non-port value falls back)
 *   EIS_VIDEO_URL     default ""
 *   EIS_SITL          true/1/yes; also implied by EIS_HOST=sitl
 */
export function defaultConnectionConfig(env: NodeJS.ProcessEnv): DefaultConnectionConfig {
  const host = env['EIS_HOST'] ?? DEFAULT_HOST;

  const portText = env['EIS_CONTROL_PORT'];
  const parsedPort = portText === undefined ? NaN : Number.parseInt(portText, 10);
  const controlPort = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
    ? parsedPort
    : DEFAULT_CONTROL_PORT;

  const videoUrl = env['EIS_VIDEO_URL'] ?? '';
  const sitlFlag = (env['EIS_SITL'] ?? '').trim().toLowerCase();
  const sitl = host === DEFAULT_HOST || SITL_FLAG_VALUES.has(sitlFlag);

  return { host, controlPort, videoUrl, sitl };
}

/* ── Asset roots ────────────────────────────────────────────────────────── */

/**
 * Root that repo-root-relative asset paths (docs/SITE_CONTRACT.md) resolve
 * against:
 *   • packaged        → process.resourcesPath (extraResources land there)
 *   • dev/unpackaged  → the platform root
 *     (dist-electron → ground/app/<os> → ground/app → ground → platform)
 */
function assetRoot(): string {
  return app.isPackaged
    ? process.resourcesPath
    : path.resolve(__dirname, '..', '..', '..', '..');
}

/** A repo-root-relative (or absolute) path, anchored at `root`. */
function anchored(root: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(root, p);
}

/* ── site:load ──────────────────────────────────────────────────────────── */

/**
 * Which site file `site:load` reads (docs/SITE_CONTRACT.md):
 *   EIS_SITE_FILE set → exactly that file, repo-root-relative; a missing file
 *                       is an error, never a silent fallback
 *   otherwise         → site/site.json, or site/site.stub.json when the real
 *                       deliverable is absent
 */
export function selectSiteFile(env: NodeJS.ProcessEnv, root: string): string {
  const explicit = env['EIS_SITE_FILE'];
  if (explicit) return anchored(root, explicit);
  const primary = anchored(root, path.join('site', 'site.json'));
  return fs.existsSync(primary) ? primary : anchored(root, path.join('site', 'site.stub.json'));
}

/** The directory site-relative asset references resolve inside. */
export function siteDirectory(env: NodeJS.ProcessEnv, root: string): string {
  const explicit = env['EIS_SITE_FILE'];
  return explicit ? path.dirname(anchored(root, explicit)) : anchored(root, 'site');
}

/* ── site:resolveAsset ──────────────────────────────────────────────────── */

const IMAGE_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/**
 * Resolve a site-declared image reference to a data: URL, or null.
 *
 * Only an existing raster image that lives strictly INSIDE `siteDir` is ever
 * returned: a leading "site/" is tolerated (contract paths are repo-root-
 * relative), backslashes are normalised, and anything that escapes the
 * directory, is not png/jpeg/webp, or does not exist yields null.
 */
export function siteAssetDataUrl(requested: unknown, siteDir: string): string | null {
  if (typeof requested !== 'string' || requested.includes('\0')) return null;

  const relative = requested.replace(/\\/g, '/').replace(/^site\//, '');
  const base = path.resolve(siteDir);
  const target = path.resolve(base, relative);

  const inside = path.relative(base, target);
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) return null;

  const mime = IMAGE_MIME[path.extname(target).toLowerCase()];
  if (!mime) return null;

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(target);
  } catch {
    return null;
  }
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/* ── Registration ───────────────────────────────────────────────────────── */

type InvokeHandler = (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type MessageHandler = (event: Electron.IpcMainEvent, ...args: unknown[]) => void;

export function registerIpcHandlers(): void {
  const root = assetRoot();
  registerPhase3Handlers(root);

  const requests: Record<string, InvokeHandler> = {
    'settings:get': (_e, key) => settingsStore.get(key as string),
    'settings:set': (_e, key, value) => settingsStore.set(key as string, value),
    'settings:all': () => settingsStore.all(),

    'recorder:start': (_e, meta) => recorder.start(meta as Record<string, unknown> | undefined),
    'recorder:stop': () => recorder.stop(),
    'recorder:list': () => recorder.list(),
    'recorder:load': (_e, id) => recorder.load(id as string),

    'app:version': () => app.getVersion(),
    'app:defaultConfig': () => defaultConnectionConfig(process.env),

    'site:load': () => fs.readFileSync(selectSiteFile(process.env, root), 'utf8'),
    'site:resolveAsset': (_e, requested) => siteAssetDataUrl(requested, siteDirectory(process.env, root)),
  };

  // One-way channels (ipcRenderer.send ↔ ipcMain.on): no reply, no backpressure.
  const messages: Record<string, MessageHandler> = {
    'recorder:append': (_e, frame) => recorder.append(frame),
  };

  for (const [channel, handler] of Object.entries(requests)) ipcMain.handle(channel, handler);
  for (const [channel, handler] of Object.entries(messages)) ipcMain.on(channel, handler);

  // There is deliberately no `satellite:loadTiles` (FM-148): the baked tiles
  // reach the renderer through the `@satdata` Vite alias in every build, and
  // the handler that once shadowed that path was never invoked.
}
