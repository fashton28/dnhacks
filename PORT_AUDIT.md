# PORT_AUDIT.md — Windows → Linux GCS port

Mandated by `LINUX_PRD.md` §0. Scope of the audit: the **Electron main process,
preload, and IPC** of the ground station shell (`ground/app/`), plus the
ground-side renderer seam (`ground/ui/src/dataSource/`). The React renderer
itself is platform-agnostic and out of scope per `LINUX_PRD.md` §1/§10.

**Verdict: the Electron source is already cross-platform-clean.** Every
Windows-coupling category in the §0 table comes back *already-portable*. The only
Windows-specific surface is **packaging + the bootstrap script** — i.e. config and
build resources, not code. Per §0 this means "most of §3–§7 is config, not code."

After this audit the repo is restructured (per the approved layout) so the OS
shells live side-by-side under a shared renderer:

```
ground/
├─ ui/                 # SHARED renderer — unchanged (LINUX_PRD §1/§10)
└─ app/
   ├─ windows/         # the original shell, moved verbatim (NSIS / .ico / PowerShell)
   └─ linux/           # new parallel shell (AppImage/.deb/.rpm, XDG, udev, power-inhibit)
```

`companion/`, `sim/`, `shared/`, and `docs/` are out of scope and already Linux-native.

---

## §0 coupling table — findings

| Area | What we grepped for | Found in `ground/app` source? | Classification |
|---|---|---|---|
| **Config/data paths** | `%APPDATA%`, `process.env.APPDATA`, `LOCALAPPDATA`, `C:\`, backslash paths, `path` joins with `\\` | **No.** `settingsStore.ts` and `recorder.ts` use `app.getPath('userData')` and `path.join`; `recorder` also honours `EIS_RECORDINGS_DIR`. | ✅ already-portable — `getPath('userData')` resolves to `~/.config/<appId>` (XDG) on Linux. |
| **Registry** | `winreg`, `reg add`, registry settings/autostart | **No.** Settings are a JSON file under `userData`. | ✅ already-portable. |
| **Serial / MAVLink** | `COM3`, `\\.\COM`, Windows COM enumeration | **No.** The ground side never opens a serial port — `LiveDataProvider.ts` is a pure browser `WebSocket` to the companion. Serial lives on the companion (Jetson/Linux). | ✅ already-portable. The Settings host/port already accept `/dev/tty*`, UDP, or TCP at the companion. |
| **Video decode** | DirectShow, Media Foundation, `dshow`, win-only gst | **No.** Video is WebRTC/WHEP straight into Chromium (see `ground/app/README.md`); not bridged through main. | ✅ already-portable. |
| **Power / sleep** | `SetThreadExecutionState`, Windows power APIs | **No** existing code — and **no inhibit at all**. | ⚠️ needs-add (not a refactor): `LINUX_PRD §7` requires inhibiting screen-blank/suspend while armed or tracking/manual-active. Added in `linux/` main via Electron `powerSaveBlocker`. |
| **Notifications/tray** | Windows toast APIs, tray ICO | **No.** No tray, no native notifications. | ✅ n/a. |
| **File dialogs / shell** | `shell.openPath` win paths, `.exe` helpers, `explorer` | `main.ts` uses `shell.openExternal(url)` for external links only — cross-platform. | ✅ already-portable. |
| **Fonts** | reliance on system-installed fonts | Geist + JetBrains Mono are self-hosted woff2 via `@fontsource-variable/*` in `ground/ui` (bundled into the asar). | ✅ already-portable — verify tabular numerals on a stock box at QA. |
| **Native deps** | `.node` binaries for win32, `node-gyp` win flags | **None.** Dependencies are pure-JS (`dotenv` only in app; React/leaflet/zustand in ui). | ✅ already-portable — no native rebuild needed. |
| **Auto-update** | Squirrel.Windows, NSIS update feed | **None** configured. | ⓘ deferred — updates are manual for now; electron-updater feed documented as future work. |
| **Single-instance** | — | `app.requestSingleInstanceLock()` present in `main.ts`; cross-platform. | ✅ already-portable (LINUX_PRD §7 satisfied). |
| **`window-all-closed`** | macOS/darwin guard | `process.platform !== 'darwin'` guard present. | ✅ already-portable. |

### The only Windows-specific surface (config/resources, not code)
- `ground/app/electron-builder.yml` — `win: { target: nsis }`, `.ico`, NSIS block. → Linux gets its own builder config (AppImage/.deb/.rpm).
- `ground/app/build-resources/icon.ico` (+ `make_icon.py`). → Linux needs PNG/SVG icons + a `.desktop` entry.
- `scripts/setup-ground.ps1` — PowerShell bootstrap. → mirrored by `scripts/setup-ground-linux.sh`.
- `package.json` `dist` script: `electron-builder --win nsis`. → Linux `package:linux`.

---

## Items the port ADDS on Linux (net-new, per §3–§7)

| Item | Where | Status in this change |
|---|---|---|
| AppImage (primary) + `.deb` + `.rpm` targets | `linux/electron-builder.yml` | ✅ added |
| `.desktop` entry, app-id `com.eyeinthesky.gcs`, categories `Utility;Science;` | `linux/build-resources/eye-in-the-sky.desktop` | ✅ added |
| PNG/SVG icons (rasterized from `assets/logo-mark.svg`) | `linux/build-resources/` | ⚠️ placeholder + generator note (no rasterizer on this box) |
| Runtime deps in `.deb`/`.rpm` (GTK3, libnotify, libnss3, libxss1, libasound2) | `linux/electron-builder.yml` | ✅ declared |
| XDG settings + recordings | `settingsStore.ts` / `recorder.ts` (unchanged) | ✅ already correct via `getPath('userData')`; recordings honour `EIS_RECORDINGS_DIR` |
| Screen-blank/suspend inhibit while armed/tracking/manual | `linux/src/main.ts` (`powerSaveBlocker`) + IPC `power:inhibit/release` | ✅ added (renderer wiring noted below) |
| udev rule for gamepads + replug prompt | `linux/build-resources/99-eyeinthesky-input.rules` + `postinstall.sh` | ✅ added |
| Controller-disconnect → position-hold failsafe (§5) | `ground/ui` renderer (SHARED) | ⚠️ **renderer-touch — surfaced per §1.** See below. |

### Surfaced renderer-touch (LINUX_PRD §1)
`LINUX_PRD §5` requires: *"a controller disconnect while MANUAL is active must
immediately zero stick input and fall back to position-hold."* Gamepad reading
lives in the **renderer** (`ground/ui/src/panels/ManualControl.tsx`), so this is
the one item that touches shared renderer code. It is **safety logic, not a
UX/layout change**, and it benefits the Windows build identically — so it is
implemented **once in the shared renderer**, not duplicated per OS. This is the
correct reading of §1 ("stop and surface" before diverging): we surface it here and
keep it shared rather than forking the UI.

### Power-management renderer wiring
`powerSaveBlocker` lives in main; the renderer must call
`window.eis.power.inhibit()` when `armed || controlSource==='tracking' ||
controlSource==='manual'` and `release()` otherwise. The `ElectronBridge` type
(`ground/ui/src/vite-env.d.ts`) and `preload.ts` gain a `power` namespace. This is
a bridge/IPC addition (no UI change).

---

## Residual QA (cannot be verified on this Windows dev box — needs a Linux host)
- AppImage launch on clean Ubuntu 22.04 **and** 24.04, Wayland **and** X11; fractional-scaling check of video canvas / map tiles / modals.
- `.deb`/`.rpm` install/uninstall, desktop-entry + icon registration, udev rule install + `udevadm` replug.
- Xbox/PS pad drives Manual Control after the udev/group step; hot-unplug → position-hold; keyboard fallback with no pad.
- GPU accel + `--disable-gpu` / `LIBGL_ALWAYS_SOFTWARE=1` fallback smoothness.
- Native `.node` rebuild step in CI (none expected — no native deps today).
