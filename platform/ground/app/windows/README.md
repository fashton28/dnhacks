# Drone Safety Platform — Ground Control Center (Electron shell)

This package (`ground/app/windows`) is the **Windows** Electron desktop shell that
wraps the React UI (`ground/ui`, shared with the Linux shell at `ground/app/linux`)
and exposes a secure preload bridge to the renderer.

---

## Directory layout

```
ground/app/windows/
├── src/
│   ├── main.ts          Electron main process — window, menu, single-instance
│   ├── preload.ts       contextBridge bridge (window.eis)
│   ├── ipc.ts           ipcMain handler registration
│   ├── settingsStore.ts On-disk JSON settings (<userData>/settings.json)
│   └── recorder.ts      Flight recorder — NDJSON sessions in <userData>/recordings/
├── build-resources/
│   └── icon.ico         Windows icon (replace with your artwork)
├── dist-electron/       Compiled JS output (tsc → CommonJS)
├── dist-installer/      electron-builder output (.exe installer)
├── package.json
├── tsconfig.json
└── electron-builder.yml
```

---

## Development

```powershell
# 1. Install dependencies for the app shell
cd ground/app/windows
npm install

# 2. Install UI dependencies (if not already done)
cd ../../ui && npm install && cd ../app/windows

# 3. Start both the Vite dev server and Electron in watch mode
npm run dev
```

`npm run dev` uses `concurrently` to:
1. Start the Vite dev server at `http://localhost:5173` (in `ground/ui`).
2. Wait for it with `wait-on`, then launch Electron pointing at that URL.

DevTools open automatically in dev mode.  Hot-reload works because Electron
loads the live Vite server URL — edit any file in `ground/ui/src` and the
renderer refreshes instantly.

---

## Production build

```powershell
# Build the UI + compile Electron main/preload, then produce the NSIS installer
cd ground/app/windows
npm run dist
```

This runs three steps in order:
1. `npm run build:ui`    — `cd ../../ui && npm run build`  (outputs `../../ui/dist/`)
2. `npm run build:electron` — `tsc -p tsconfig.json`   (outputs `dist-electron/`)
3. `electron-builder --win nsis`                        (outputs `dist-installer/`)

The resulting Windows installer is:
```
ground/app/windows/dist-installer/Drone Safety Platform Setup <version>.exe
```

---

## Security model

The renderer process (React UI) has **zero Node.js access**.

```
Renderer (React)
    │  window.eis.settings.get(key)
    │  window.eis.recorder.append(frame)   ← fire-and-forget via ipcRenderer.send
    │  ...
    ▼
  preload.ts  (Electron contextBridge — isolated V8 context)
    │  ipcRenderer.invoke / ipcRenderer.send
    ▼
  main.ts  (Node.js — full OS access)
    ├── settingsStore.ts  → <userData>/settings.json
    └── recorder.ts       → <userData>/recordings/*.ndjson
```

Key hardening flags on BrowserWindow.webPreferences:

| Flag | Value | Effect |
|---|---|---|
| `contextIsolation` | `true` | Renderer JS cannot reach the preload context |
| `nodeIntegration` | `false` | Renderer has no `require` / Node globals |
| `sandbox` | `true` | Renderer is an OS-level sandboxed child process |
| `webSecurity` | `true` | Same-origin policy enforced |

External links (`<a target="_blank">`, `window.open`) are intercepted and
opened in the default OS browser — never inside Electron.

---

## Video note (RTSP / WebRTC / WHEP)

Live video from the companion is **not bridged through the main process**.
The companion runs [mediamtx](https://github.com/bluenviron/mediamtx) which
re-publishes the camera stream as WebRTC/WHEP.  The renderer connects directly
to the WHEP endpoint using the browser-native WebRTC APIs (no plugin needed).

The video URL is passed from `defaultConfig()` (env: `EIS_VIDEO_URL`) and
stored in Settings, then handed to the UI's video player component.  Because
the stream is WebRTC, latency is typically <200 ms — far lower than HLS or RTSP
piped through the main process would achieve.

For the full network topology see `docs/network.md`.

---

## Environment variables

Loaded from `<repo-root>/.env` at startup (via dotenv).  Copy `.env.example`
to `.env` and edit:

| Variable | Default | Description |
|---|---|---|
| `EIS_HOST` | `sitl` | Jetson IP or `sitl` |
| `EIS_CONTROL_PORT` | `8765` | WebSocket control port |
| `EIS_VIDEO_URL` | `` | RTSP/WebRTC URL; empty = mock canvas |
| `EIS_SITL` | `true` | Enable SITL mode |
| `EIS_RECORDINGS_DIR` | `<userData>/recordings` | Where flight recordings are saved |
| `EIS_DEV` | — | Set by `npm run dev` to load the Vite dev server |

---

## How the renderer reaches main (the only seam)

```typescript
// In any renderer component:
const version = await window.eis?.app.version();
const cfg     = await window.eis?.defaultConfig();
await window.eis?.settings.set('connection', cfg);
const { sessionId } = await window.eis?.recorder.start({ pilot: 'Alice' });
window.eis?.recorder.append({ type: 'telemetry', ts: Date.now(), ... });
```

`window.eis` is typed as `ElectronBridge` (from `ground/ui/src/vite-env.d.ts`).
It is `undefined` when the UI runs in a plain browser (dev without Electron).
