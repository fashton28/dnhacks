/**
 * main.ts — Electron main process entry point.
 *
 * Responsibilities:
 *   1. Load .env (dotenv) early so all process.env vars are available.
 *   2. Enforce single-instance lock.
 *   3. Create the BrowserWindow with the security hardening the PRD requires:
 *        • contextIsolation: true
 *        • nodeIntegration: false
 *        • sandbox: true   (renderer process is a sandboxed OS child)
 *        • webSecurity: true
 *        • Only the preload script is injected into the renderer context.
 *   4. Load the UI: in dev mode load the Vite dev server; in production load
 *      the built ../ui/dist/index.html (extraResources path at runtime).
 *   5. Build the app menu (minimal; includes Reload and DevTools in dev).
 *   6. Intercept navigation / new-window events — open external URLs in the
 *      OS browser, never in Electron (defence-in-depth against XSS).
 *   7. Register all IPC handlers.
 */

import * as path from 'path';
import { app, BrowserWindow, Menu, shell, ipcMain } from 'electron';
import { config as dotenvConfig } from 'dotenv';

// ── 0. Load .env from the repo root (dist-electron → ground/app/linux → repo root) ─
dotenvConfig({ path: path.join(__dirname, '..', '..', '..', '..', '.env') });

// ── 1. Import IPC handler registration ───────────────────────────────────────
import { registerIpcHandlers } from './ipc';

// ── 2. Constants ─────────────────────────────────────────────────────────────
const IS_DEV =
  process.env['EIS_DEV'] === 'true' ||
  process.env['NODE_ENV'] === 'development';

const DEV_URL = 'http://localhost:5173';

/**
 * Resolve the path to the built UI's index.html.
 * In a packaged app, electron-builder copies ../ui/dist → resources/ui/dist.
 * In an unpackaged dev build the dist folder is a sibling of ground/app.
 */
function getUIPath(): string {
  if (app.isPackaged) {
    // electron-builder extraResources lands in process.resourcesPath/ui/dist
    return path.join(process.resourcesPath, 'ui', 'dist', 'index.html');
  }
  // Unpackaged: dist-electron → ground/app/linux → ground/app → ground → ui/dist
  return path.join(__dirname, '..', '..', '..', 'ui', 'dist', 'index.html');
}

// ── 3. Single-instance lock ───────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ── 4. Window creation ────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'Eye in the Sky — Ground Control',
    backgroundColor: '#09090b', // match UI dark background
    show: false, // shown after content is ready (avoids white flash)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
  });

  // Show the window once the initial paint is done
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (IS_DEV) mainWindow?.webContents.openDevTools({ mode: 'detach' });
  });

  // ── Navigation / new-window safety guard ─────────────────────────────────
  // Prevent the renderer from navigating away (e.g. a rogue <a href> or XSS).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const parsed = new URL(url);
    const isLocalFile = parsed.protocol === 'file:';
    const isDevServer = IS_DEV && url.startsWith(DEV_URL);
    if (!isLocalFile && !isDevServer) {
      event.preventDefault();
      shell.openExternal(url).catch(() => undefined);
    }
  });

  // Open any window.open() / target="_blank" link in the OS browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => undefined);
    return { action: 'deny' };
  });

  // ── Load the UI ────────────────────────────────────────────────────────────
  if (IS_DEV) {
    mainWindow.loadURL(DEV_URL).catch(err => {
      console.error('[main] Failed to load dev server:', err);
    });
  } else {
    mainWindow.loadFile(getUIPath()).catch(err => {
      console.error('[main] Failed to load production UI:', err);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── 5. App menu ───────────────────────────────────────────────────────────────
function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Eye in the Sky',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(IS_DEV
          ? ([
              { type: 'separator' } as Electron.MenuItemConstructorOptions,
              { role: 'reload' } as Electron.MenuItemConstructorOptions,
              { role: 'forceReload' } as Electron.MenuItemConstructorOptions,
              { role: 'toggleDevTools' } as Electron.MenuItemConstructorOptions,
            ])
          : []),
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── 6. Electron lifecycle ─────────────────────────────────────────────────────
app.whenReady().then(() => {
  registerIpcHandlers();
  buildMenu();
  createWindow();

  // macOS: re-create the window when the dock icon is clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Second-instance: focus the existing window
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// Windows / Linux: quit when all windows are closed
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Prevent unused ipcMain import warning — handlers are registered above
void ipcMain;
