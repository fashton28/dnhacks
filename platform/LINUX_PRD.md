# PRD — Drone Safety Platform GCS: Windows → Linux port

> **How to use this prompt:** This brief assumes the **Windows desktop GCS is
> already fully built** (Electron + React/TS, per `PRD.md`, consuming live data via
> `CODE_PRD.md`). This is **not a from-scratch build** — it is a *port delta*. The
> renderer/UI is platform-agnostic and carries over unchanged; the work is (a)
> auditing the Electron **main process** for Windows-specific coupling, (b)
> abstracting what you find, and (c) Linux packaging + OS integration. Do not
> redesign UI or touch the renderer except where §1 audit findings force it.
> Make opinionated decisions, document them, favor completeness.

---

## 0. Windows-coupling audit (DO THIS FIRST)
Grep the existing codebase — **main process, preload, and any sidecar/native
modules only** (the renderer should come back clean; if it doesn't, that's a bug to
fix, not port). For each item: confirm it's already cross-platform, or list it as a
refactor task.

| Area | What to grep for | Linux replacement |
|---|---|---|
| **Config/data paths** | `%APPDATA%`, `process.env.APPDATA`, `LOCALAPPDATA`, hard-coded `C:\`, backslash paths, `path` joins with `\\` | Electron `app.getPath('userData'\|'documents'\|'logs')` → resolves to XDG dirs; never assume separators |
| **Registry** | `winreg`, `reg add`, registry reads for settings/autostart | XDG config files; `.desktop` autostart entry / systemd user unit |
| **Serial / MAVLink** | `COM3`, `\\.\COM`, Windows COM enumeration | `/dev/ttyACM*`, `/dev/ttyUSB*`; user in `dialout`; enumerate via udev |
| **Video decode** | DirectShow, Media Foundation, `dshow`, Windows-only gst plugins | GStreamer (`v4l2`, `vaapi`, `rtspsrc`) or WebRTC straight into Chromium |
| **Power / sleep** | `SetThreadExecutionState`, Windows power APIs | freedesktop `org.freedesktop.ScreenSaver` inhibit / `systemd-inhibit` |
| **Notifications/tray** | Windows toast APIs, tray ICO assets | Electron `Notification` (libnotify), PNG/SVG tray icons |
| **File dialogs / shell** | `shell.openPath` with Windows paths, `.exe` helpers, `explorer` calls | `xdg-open` semantics (Electron `shell` handles this if paths are clean) |
| **Fonts** | reliance on system-installed fonts | bundled self-hosted woff2 in the asar |
| **Native deps** | `.node` binaries built for win32, `node-gyp` win flags | rebuild for `linux-x64`/`arm64` in CI; declare build toolchain |
| **Auto-update** | Squirrel.Windows, `.exe`/NSIS update feed | electron-updater with AppImage/deb/rpm feed, or document manual updates |

**Output of this step:** a short `PORT_AUDIT.md` listing every hit, classified
*already-portable* vs *needs-refactor*, before writing port code. If the audit comes
back clean (well-built cross-platform Electron app), most of §3–§7 below is config,
not code.

---

## 1. Goal & guardrails
Ship the **same** GCS — same UI, same safety guarantees, same one-line Mock↔Live
`DataSource` swap — as a first-class Linux desktop app. All OS-specific work stays
in the main process / `LiveDataProvider`, behind the existing `DataSource` seam. **If
any requirement here would force a renderer/UX change, stop and surface it** rather
than diverging from the shipped Windows UI.

## 2. Target platforms
- **Primary:** Ubuntu 22.04 LTS & 24.04 LTS (x86_64), GNOME on **Wayland and X11**.
- **Secondary (best-effort):** Debian 12, Fedora 40, Arch. Pop!_OS inherits Ubuntu.
- **Arch:** `x86_64` required; keep the build matrix arch-parameterized so `aarch64`
  (ARM laptop / Jetson-as-GCS) is a config flip, not a rewrite.
- Verify the video canvas, map tiles, and modals under Wayland fractional scaling
  (the usual breakage point) and under X11.

## 3. Packaging & distribution (net-new — none of this exists from a Windows build)
- Build with **electron-builder**. Per release, produce:
  - **AppImage** (primary — portable, no install).
  - **.deb** + **.rpm** with correct dependency declarations and a desktop entry.
  - Optional **Flatpak** (sandboxed — see device caveat in §6).
- Ship a `.desktop` file (icon from `assets/logo-mark.svg` rasterized to standard
  sizes), categories `Utility;Science;`, stable app-id `com.dnhacks.platform.gcs`.
- **Pin** Electron + every dependency; reproducible builds.
- **Signing/integrity:** GPG-sign apt/dnf metadata; checksum + detached signature
  for the AppImage. Document the update channel (electron-updater) or state updates
  are manual.

## 4. Runtime dependencies
- Declare standard Electron libs in .deb/.rpm: GTK3, `libnotify`, `libnss3`,
  `libxss1`, `libasound2`.
- **Fonts:** confirm Geist + JetBrains Mono ship as bundled woff2 (per the audit). A
  stock Linux box has neither — verify tabular numerals don't fall back.
- **GPU:** enable acceleration where present; document a `--disable-gpu` /
  `LIBGL_ALWAYS_SOFTWARE=1` fallback. Horizon, map, and video overlay must stay
  smooth on integrated graphics; degrade gracefully.

## 5. Game-controller support on Linux
The Manual Control panel uses the Gamepad API (Chromium-level — already works). The
Linux delta is **device access + a failsafe**:
- Confirm Xbox (xpad), PS4/5 (`hid-playstation`/hid-sony), and generic HID pads
  enumerate. Ship a **udev rule** (`/etc/udev/rules.d/99-dnhacks-platform-input.rules`,
  `TAG+="uaccess"` / appropriate `MODE`) in the .deb/.rpm postinstall; document the
  manual install + group `input` step for AppImage/Flatpak users.
- Handle hot-plug without crashing; the status-bar indicator (`NO PAD`/`PAD`/
  `MANUAL`) must track it.
- **Failsafe:** a controller disconnect while `MANUAL` is active must immediately
  zero stick input and fall back to position-hold — never freeze the last command.
  Wire this in `LiveDataProvider`.
- Keep the keyboard fallback fully functional when no pad/permission is present.

## 6. Live backend OS touch-points (LiveDataProvider — usually the biggest port cost)
Keep all of this in the main process / sidecar, never the renderer:
- **MAVLink link:** serial (`/dev/ttyACM*`/`/dev/ttyUSB*`, user in `dialout`), UDP
  (SITL/network radio), or TCP — configurable from the Settings host/port fields.
  Replace any `COM`-port assumptions found in the audit.
- **Video:** decode RTSP/WebRTC/HTTP from the Jetson via WebRTC-into-Chromium or a
  GStreamer pipeline in the main process; replace DirectShow/Media-Foundation paths.
  Fall back to "NO VIDEO SIGNAL" cleanly.
- **Networking:** document required ports (control 8765, video, MAVLink UDP) and
  ufw/firewalld implications; optional mDNS discovery of the Jetson.
- **Flatpak caveat:** sandboxing blocks raw serial/USB by default — enumerate
  required `--device`/`--socket`/`--filesystem` finish-args, or recommend AppImage/
  .deb for hardware use.

## 7. Paths, persistence, system integration (audit → refactor)
- `SettingsStore` + flight recordings use **XDG base dirs** (`$XDG_CONFIG_HOME`,
  `$XDG_DATA_HOME`, `$XDG_STATE_HOME`; fall back to `~/.config`, `~/.local/share`,
  `~/.local/state`). Replace any `%APPDATA%`/registry/Windows-path code found in §0.
  Recordings default under `$XDG_DATA_HOME/dnhacks-platform/`.
- **Settings migration:** if operators may carry settings from the Windows build,
  provide a one-time import (read the old JSON if present) — otherwise document that
  settings reset on first Linux launch.
- **Power management:** while armed/flying or tracking/manual-active, inhibit screen
  blanking & suspend (freedesktop/systemd-inhibit); release on disarm.
- **Single-instance** lock (Electron `requestSingleInstanceLock` — cross-platform,
  just verify it's enabled).
- Optional **kiosk/fullscreen** launch flag + autostart (systemd user unit or
  `.desktop` autostart) for a dedicated ground-station machine.

## 8. Build, CI & dev ergonomics
- `npm install && npm run dev` runs the renderer on `MockDataProvider` on a bare
  Linux dev box, no hardware.
- `npm run package:linux` → AppImage + .deb + .rpm. Rebuild any native `.node`
  modules for Linux in CI.
- CI matrix builds Linux artifacts on tagged releases; headless smoke-test (Xvfb):
  app launches, renders the mock screen, zero console errors.
- Document the build toolchain (Node version, electron-builder, system libs to build).

## 9. Acceptance criteria
- `PORT_AUDIT.md` exists and every Windows-coupling hit is resolved or justified.
- AppImage runs on clean Ubuntu 22.04 **and** 24.04 (Wayland + X11), no manual deps:
  launches to the live-feeling mock control center, fonts correct, instruments/map/
  video smooth.
- Plugged-in Xbox/PS pad drives Manual Control after the documented udev/group step;
  hot-unplug during MANUAL safely falls back to position-hold; keyboard works without
  a pad.
- Settings persist across restarts via XDG dirs; recordings land under `$XDG_DATA_HOME`.
- Screen does not blank/suspend while armed or tracking/manual-active.
- `.deb`/`.rpm` install & uninstall cleanly, register desktop entry + icon, install
  the input udev rule (with a documented replug/`udevadm` prompt).
- Swapping the one `dataSource` line to `LiveDataProvider` connects to a real/SITL
  vehicle over serial or UDP on Linux with **zero renderer changes** vs. the Windows
  build.

## 10. Out of scope
The drone software, MAVLink protocol, simulator, and hardware (CODE_PRD.md).
Windows/macOS packaging. **Any UI/UX change** — the shipped Windows screens and the
design system are fixed; this is a port, not a redesign.
