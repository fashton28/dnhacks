/**
 * main.ts — Electron main process for the Linux ground-control shell.
 *
 * Mirrors ../../windows/src/main.ts; the Linux delta lives in ipc.ts/preload.ts
 * (the power:inhibit / power:release channels, LINUX_PRD §7), not here.
 *
 * What this file guarantees (the shell contract):
 *   • platform/.env is loaded before anything reads process.env
 *   • exactly one instance runs; a second launch focuses the first
 *   • the renderer is fully isolated: contextIsolation + sandbox + webSecurity
 *     on, nodeIntegration off, only preload.js injected
 *   • dev (EIS_DEV=true / NODE_ENV=development) loads the Vite server on
 *     EIS_UI_PORT (default 5173) and checks that what answers is THIS app
 *     (FM-131); packaged builds load resources/ui/dist/index.html, unpackaged
 *     builds load ground/ui/dist/index.html
 *   • the renderer can never navigate away or open a window: any such URL is
 *     handed to the OS browser (documented as FM-151; there is no CSP)
 *
 * Structure: `describeRuntime()` decides dev-vs-packaged once; `probeDevServer()`
 * is the FM-131 identity check; `guardNavigation()` and `menuFor()` are the
 * per-window policies; `bootstrap()` wires the lifecycle.
 */

import * as path from 'path';
import { app, BrowserWindow, Menu, shell } from 'electron';
import { config as loadDotenv } from 'dotenv';

// dist-electron → ground/app/linux → ground/app → ground → platform
const PLATFORM_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
loadDotenv({ path: path.join(PLATFORM_ROOT, '.env') });

import { registerIpcHandlers } from './ipc';

/* ── Runtime description ────────────────────────────────────────────────── */

export interface ShellRuntime {
  /** Load the Vite dev server instead of the built UI. */
  readonly dev: boolean;
  /** Port the dev server is expected on — the same EIS_UI_PORT vite.config.ts reads. */
  readonly devPort: number;
  readonly devUrl: string;
}

const DEFAULT_DEV_PORT = 5173;

export function describeRuntime(env: NodeJS.ProcessEnv): ShellRuntime {
  const dev = env['EIS_DEV'] === 'true' || env['NODE_ENV'] === 'development';
  const requested = Number(env['EIS_UI_PORT'] ?? DEFAULT_DEV_PORT);
  const devPort = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_DEV_PORT;
  return { dev, devPort, devUrl: `http://localhost:${devPort}` };
}

/**
 * The built UI's index.html:
 *   packaged   → electron-builder's extraResources land in process.resourcesPath/ui/dist
 *   unpackaged → dist-electron → ground/app/linux → ground/app → ground → ui/dist
 */
function builtUiEntry(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'ui', 'dist', 'index.html')
    : path.join(__dirname, '..', '..', '..', 'ui', 'dist', 'index.html');
}

/* ── FM-131: is the thing on the dev port our UI? ───────────────────────── */

/** Strings ground/ui/index.html (or its Vite-served form) always contains. */
const UI_MARKERS = ['Drone Safety Platform', 'eis-root', '/src/main.tsx'] as const;

/** Pure classification of a dev-server response body. */
export function looksLikeGroundUi(html: string): boolean {
  return UI_MARKERS.some((marker) => html.includes(marker));
}

/**
 * Report (never block on) a foreign or missing dev server. `wait-on` only
 * proves that SOMETHING answers the port; this says whether it is this app.
 * The window loads regardless, so a false negative can never stop a demo.
 */
async function probeDevServer(runtime: ShellRuntime): Promise<string | null> {
  try {
    const response = await fetch(runtime.devUrl, { method: 'GET' });
    if (!response.ok) return `dev server at ${runtime.devUrl} responded ${response.status}`;
    if (!looksLikeGroundUi(await response.text())) {
      return `the server on port ${runtime.devPort} is NOT the ground-control UI — `
        + 'free the port (or set EIS_UI_PORT) and restart';
    }
    return null;
  } catch (err) {
    return `dev server at ${runtime.devUrl} is not reachable: ${(err as Error).message}`;
  }
}

/* ── Navigation policy ──────────────────────────────────────────────────── */

/** The renderer may stay on file:// content, or on the dev server in dev. */
export function isNavigationAllowed(url: string, runtime: ShellRuntime): boolean {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return false;
  }
  if (protocol === 'file:') return true;
  return runtime.dev && url.startsWith(runtime.devUrl);
}

function openExternally(url: string): void {
  shell.openExternal(url).catch(() => undefined);
}

function guardNavigation(window: BrowserWindow, runtime: ShellRuntime): void {
  window.webContents.on('will-navigate', (event, url) => {
    if (isNavigationAllowed(url, runtime)) return;
    event.preventDefault();
    openExternally(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });
}

/* ── Menu ───────────────────────────────────────────────────────────────── */

function menuFor(runtime: ShellRuntime): Menu {
  const item = (role: Electron.MenuItemConstructorOptions['role']): Electron.MenuItemConstructorOptions => ({ role });
  const separator: Electron.MenuItemConstructorOptions = { type: 'separator' };

  const view: Electron.MenuItemConstructorOptions[] = [
    item('resetZoom'), item('zoomIn'), item('zoomOut'), separator, item('togglefullscreen'),
  ];
  if (runtime.dev) view.push(separator, item('reload'), item('forceReload'), item('toggleDevTools'));

  return Menu.buildFromTemplate([
    {
      label: 'Drone Safety Platform',
      submenu: [item('about'), separator, item('hide'), item('hideOthers'), separator, item('quit')],
    },
    { label: 'View', submenu: view },
    { label: 'Window', submenu: [item('minimize'), item('zoom'), separator, item('close')] },
  ]);
}

/* ── Window ─────────────────────────────────────────────────────────────── */

const WINDOW_OPTIONS: Electron.BrowserWindowConstructorOptions = {
  width: 1440,
  height: 900,
  minWidth: 1024,
  minHeight: 640,
  title: 'Drone Safety Platform — Ground Control',
  backgroundColor: '#09090b', // the UI's dark ground; avoids a white flash
  show: false,                // shown on ready-to-show
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
  },
};

let mainWindow: BrowserWindow | null = null;

function openMainWindow(runtime: ShellRuntime): BrowserWindow {
  const window = new BrowserWindow(WINDOW_OPTIONS);
  mainWindow = window;

  window.once('ready-to-show', () => {
    window.show();
    if (runtime.dev) window.webContents.openDevTools({ mode: 'detach' });
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  guardNavigation(window, runtime);

  const loading = runtime.dev
    ? window.loadURL(runtime.devUrl)
    : window.loadFile(builtUiEntry());
  loading.catch((err: unknown) => {
    console.error(`[main] failed to load the ${runtime.dev ? 'dev server' : 'production UI'}:`, err);
  });
  if (runtime.dev) {
    void probeDevServer(runtime).then((problem) => {
      if (problem) console.error(`[main] ${problem}`);
    });
  }
  return window;
}

function focusMainWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/* ── Lifecycle ──────────────────────────────────────────────────────────── */

function bootstrap(): void {
  // Single instance: the loser exits immediately, the winner gets 'second-instance'.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    process.exit(0);
  }
  app.on('second-instance', focusMainWindow);

  const runtime = describeRuntime(process.env);

  app.whenReady().then(() => {
    registerIpcHandlers();
    Menu.setApplicationMenu(menuFor(runtime));
    openMainWindow(runtime);

    // macOS convention, harmless elsewhere: dock click re-creates the window.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openMainWindow(runtime);
    });
  });

  // Windows / Linux: closing the last window quits the app.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

bootstrap();
