# Eye in the Sky — Ground Control Center (Linux shell)

The **Linux** packaging of the Electron ground station. It wraps the *same*
React renderer as the Windows shell (`../../ui`) — the renderer is
platform-agnostic and is **not** duplicated. This folder is the Windows→Linux
**port delta** described in `LINUX_PRD.md`; see `../../../PORT_AUDIT.md` for the
coupling audit (it came back clean — the port is packaging + OS integration, not
a renderer rewrite).

```
ground/app/
├─ windows/   # NSIS installer, .ico, code-sign skip
└─ linux/     # ← you are here: AppImage/.deb/.rpm, XDG, udev, power-inhibit
   ├─ src/                 # main/preload/ipc/settingsStore/recorder (shared logic + Linux power IPC)
   ├─ build-resources/     # icon.png, .desktop, udev rule, post(install|remove).sh
   ├─ electron-builder.yml # Linux targets + runtime deps
   └─ package.json
```

> `src/` mirrors `../windows/src/`; the only Linux-specific additions are the
> `power:inhibit`/`power:release` IPC handlers (`ipc.ts`) and the `power`
> namespace on the preload bridge. Keep the two `src/` trees in sync for any
> shared change.

---

## Develop (bare Linux box, no hardware)

```bash
cd ground/ui  && npm install      # shared renderer deps
cd ../app/linux && npm install    # Electron shell deps (fetches the Linux electron binary)
npm run dev                       # Vite dev server + Electron, on MockDataProvider
```

`npm run dev` runs the renderer on `MockDataProvider` — animated telemetry,
synthetic video, working controls — with no backend. Swap the one line in
`ground/ui/src/dataSource/index.ts` to `LiveDataProvider` to talk to a real/SITL
vehicle over serial (`/dev/ttyACM*`/`/dev/ttyUSB*`, user in `dialout`), UDP, or TCP.

## Package

```bash
npm run package:linux        # → dist-installer/  AppImage + .deb + .rpm
```

Before the first package build, generate the real icon (the committed
`build-resources/icon.png` is a placeholder):

```bash
./build-resources/make-icons.sh   # needs librsvg (rsvg-convert) or inkscape
```

ARM (Jetson-as-GCS / ARM laptop) is a flag flip: `electron-builder --linux --arm64`.

---

## What the Linux port adds

| Area | Mechanism |
|---|---|
| **Settings / recordings** | XDG dirs automatically — `app.getPath('userData')` → `~/.config/Eye in the Sky/`; recordings under there or `EIS_RECORDINGS_DIR` (e.g. `$XDG_DATA_HOME/eyeinthesky`). No code change vs. Windows. |
| **Game controllers** | udev rule (`99-eyeinthesky-input.rules`) installed by the `.deb`/`.rpm` postinstall; AppImage/Flatpak users install it manually or join group `input`. |
| **Controller-disconnect failsafe** | A pad unplug while `MANUAL` is active zeroes stick input and falls back to position-hold — wired in the shared renderer (`ground/ui`), benefits both OSes. |
| **Power management** | `powerSaveBlocker` inhibits screen-blank/suspend while armed or tracking/manual-active; the renderer drives it via `window.eis.power.inhibit()/release()`. |
| **Single instance** | `app.requestSingleInstanceLock()` (already cross-platform). |
| **Runtime deps** | `.deb`/`.rpm` declare GTK3, libnotify, libnss3, libxss1, libasound2. |

## Flatpak caveat (LINUX_PRD §6)
Flatpak sandboxing blocks raw serial/USB by default. For hardware use, prefer the
AppImage or `.deb`/`.rpm`; a Flatpak build would need explicit
`--device=all` / `--filesystem` finish-args to reach `/dev/tty*`.

## Not verifiable on the Windows dev box (needs a Linux host — see PORT_AUDIT.md)
AppImage launch on Ubuntu 22.04/24.04 under Wayland + X11 (fractional scaling),
`.deb`/`.rpm` install/uninstall + desktop entry, real gamepad enumeration and
hot-unplug failsafe, and GPU/`--disable-gpu` fallback smoothness.
