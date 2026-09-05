# Handoff: Drone Safety Platform — Drone Ground Control Center

## Overview
The desktop **ground control center (GCS)** for an autonomous person-following
drone (ArduPilot + NVIDIA Jetson vision). The operator arms, takes off, engages
person-tracking (the drone flies toward a person and holds a safe **standoff
distance**), pilots manually with a game controller when needed, and monitors
live video + telemetry — all with instant stop always one tap away.

This bundle is the **design half** of the project described in `PRD.md`. Per that
brief, **this side builds only the desktop UI**; a separate Claude Code prompt
builds the drone software, live backend, simulator, and hardware. The two halves
meet at the **`DataSource` contract** (PRD §4) — implement it exactly and swap the
mock for a live provider in one line.

## About the design files
The files in this bundle (and the parent design-system project) are **design
references built in HTML/JSX** — a runnable, high-fidelity prototype of the look
and behavior, **not** the production codebase. Your task is to **recreate them in
the target stack named by the PRD: React 18 + TypeScript + Vite + Tailwind +
`lucide-react`**, using its patterns. The HTML/JSX here is faithful to pixels and
interactions; treat it as the spec, not as code to paste.

The parent project is also a **design system**: `styles.css` + `tokens/*` are the
source of truth for every color/type/spacing value, and `components/*` +
`ui_kits/ground-control/*` show every component and the full assembled screen.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, instruments, and
interactions. Recreate pixel-faithfully, mapping the inline styles / CSS custom
properties to Tailwind theme tokens (PRD §3 requires centralized tokens — do not
scatter hex values).

## Source of truth — read these first
- **`PRD.md`** — authoritative product brief. §4 (the `DataSource` contract), §6
  (screens), §7 (component states), §8 (safety UX) are binding.
- **`../readme.md`** (design-system root) — content fundamentals, full **visual
  foundations**, and iconography. Every token rationale lives here.
- **`../ui_kits/ground-control/`** — the assembled interactive screen + `mock.js`
  (a `DataSource`-shaped mock you can port near-verbatim as `MockDataProvider`).
- **`../components/`** + **`../tokens/`** — primitives and tokens.

## Architecture (match the PRD)
```
src/
  contract/     # PRD §4 types + DataSource interface — single source of truth
  dataSource/   # MockDataProvider (port mock.js) + one-line selector
  theme/        # tokens → tailwind.config.ts + ts tokens (from tokens/*.css)
  components/   # primitives (port components/core/*)
  instruments/  # AttitudeIndicator, Compass, BatteryGauge, SignalGauge
  panels/       # video, controls, manual, telemetry, map, log
  views/        # checklist, takeoff, settings, failsafe, PID, log-browser modals
  store/        # app state (context/zustand) + SettingsStore
  App.tsx
```
All I/O flows through a single `DataSourceContext`; Mock vs Live is one line
(`export const dataSource = new MockDataProvider()`).

## Design tokens
Authoritative values are in `../tokens/*.css` (152 tokens). Headlines:

**Color** (dark-only)
- Neutral ramp: `--gray-0 #06070a` (sunken/letterbox) → `--gray-1 #0b0d11` (app bg)
  → `--gray-2 #111419` (panel) → `--gray-3 #171b22` (raised) → `--gray-4 #1e232b`
  (input) → `--gray-5 #272d37` (hover) → `--gray-6 #333a45` (strong border) →
  `--gray-8 #6b7686` (tertiary text) → `--gray-9 #98a3b3` (secondary) →
  `--gray-11 #e6eaf0` (primary text).
- Accent (blue): `#2f81f7`, hover `#5aa0ff`, active `#1f6fe0`, tint `rgba(47,129,247,.14)`.
- Status (reserved, consistent): nominal/green `#25c46d`, caution/amber `#f5a623`,
  danger/red `#f04438`, critical `#ff6b66`, inactive grey `#475160`. Each has a
  `.14` tint fill and a line color for borders. **Reserve red for genuine danger
  only** (disarm/kill, critical battery, link loss, active-tracking warning).

**Type**
- UI: **Geist** (`--font-sans`). Numerics: **JetBrains Mono** (`--font-mono`) with
  **tabular figures** (`font-variant-numeric: tabular-nums; 'tnum','zero'`) on
  *every* live readout so digits don't jitter. (Currently loaded from Google
  Fonts; self-host woff2 for Electron.)
- Sizes (px): micro-label 10–11 (uppercase, `0.06em`), body 13, md 14, panel
  title 20; readouts 15 / 22 / 32 / 44. Display tracking `-0.01em`.

**Spacing / radii / elevation**
- 4px base grid. Shell dims: status bar 46px, left panel 264px, right panel 300px.
- Radii: 3 / 5 / 7 / 10 / 14px; pills `999px` (status chips only).
- Elevation only for floating surfaces (popover/modal shadows). Panels = surface
  + 1px hairline border (`rgba(255,255,255,.10)`), no drop shadow. Glows mark
  active/critical states sparingly.
- Motion: instrument needles/horizon glide ~120ms (`cubic-bezier(.33,0,.2,1)`);
  UI states snap ~90ms. Live states use a slow opacity pulse. No decorative motion.

## Screens, components & states
Build everything in PRD §6–§7. Notable pieces realized in this prototype:

- **Top status bar** — connection + host + SITL/LIVE badge, armed/disarmed, mode,
  flight timer, battery (V/% + bar, amber ≤30 / red ≤15), GPS fix + sats, link
  RSSI+latency, **controller indicator** (NO PAD / PAD / MANUAL), and a persistent
  **DISARM/KILL** (red, glows when armed, instant — no confirm to stop).
- **Center — live video + tracking overlay** — `getVideoUrl()` when live, else the
  mock canvas scene. Overlay draws each `tracking.targets` bbox (normalized→px),
  confidence label, locked highlight w/ corner ticks, center crosshair, and a
  distance HUD (`estimatedDistance` vs `standoffDistance`). **Click a bbox →
  `selectTarget`.** Border treatment per state: searching=blue, locked=amber
  (pulsing), lost=red; disconnected="NO VIDEO SIGNAL".
- **Left — flight + tracking + manual** controls:
  - Flight: Arm (gated by pre-flight checklist), Takeoff (hold-to-confirm w/
    altitude), Land, RTL, mode selector.
  - Tracking: prominent **Engage** (hold-to-confirm; confirm shows standoff +
    max speed) / instant **Disengage**; standoff (2–15 m) & max-speed (0.5–8 m/s)
    sliders → `setStandoff` / `setMaxSpeed`.
  - **Manual control** (game controller): dual-stick visualizers + channel bars,
    **Gamepad API** (left=throttle/yaw, right=pitch/roll; B/Circle releases),
    keyboard fallback (WASD + arrows). "Take manual control" is hold-to-confirm
    and requires armed+airborne; engaging releases active tracking; "Release to
    auto-hold" is instant. See `manual control` notes below.
- **Right — telemetry**: artificial horizon + compass (custom SVG), numeric
  readouts (rel alt, ground/vert speed, dist-home, dist-target, lat/lon, sats,
  HDOP, V/A/%), altitude + battery sparklines.
- **Map** — drone (heading marker), home, locked-target marker, breadcrumb trail,
  geofence ring, lat/lon. Prototype uses a procedural satellite-look canvas;
  **production = `react-leaflet` over Google/OSM satellite tiles**, offline-tolerant
  (last position + grid if tiles fail).
- **Bottom — log console** — colored `statusText` stream, severity filter,
  timestamps, start/stop recording (no-op in UI).
- **Modals** — Settings (host/port/video URL, **SITL toggle**, units, map tiles),
  Pre-flight checklist (gates Arm), Takeoff confirm. **Still to build per PRD §6.7:**
  Failsafe & geofence config, PID/gain tuning, Flight-log browser + replay.

Every component must visibly handle: connected/connecting/disconnected/error;
armed/disarmed; tracking idle/searching/locked/lost; low + critical battery;
link degraded/lost; SITL vs LIVE; command pending/acked/failed.

## Manual control (game controller) — contract extension
The prototype adds manual piloting beyond the PRD's command list. Implement as a
small extension to the contract:
- New commands: `engageManual`, `disengageManual`; high-rate stick input via a
  direct `setManualInput({ throttle, yaw, pitch, roll })` (each −1…1) that
  **bypasses the ack path** (don't ack at stick rate).
- Gamepad mapping (standard pad): `axes[0]`=yaw, `−axes[1]`=throttle, `axes[2]`=roll,
  `−axes[3]`=pitch; deadzone 0.09; button[1] (B/Circle) = release. Keyboard
  fallback: W/S, A/D, ↑/↓, ←/→.
- Safety: engage requires armed+airborne and is deliberate (hold-to-confirm);
  engaging switches mode to STABILIZE and releases active tracking; release is
  instant; **disarm always wins**. See `../ui_kits/ground-control/ManualControl.jsx`
  and the manual physics block in `mock.js`.

## Safety UX (mandatory — PRD §8)
- Arm requires the pre-flight checklist acknowledged.
- Takeoff & Engage Tracking & Take-manual-control require a deliberate
  hold-to-confirm; Engage's confirm surfaces active standoff + max speed.
- Persistent banner while tracking **or** manual is active.
- Disarm/Kill and Disengage/Release are always one instant action — never gated.
- Surface every `critical` statusText as a prominent alert (toast), not just a log line.
- Keyboard: **Space** = emergency disarm; `T` engage, `D` disengage, `R` RTL.

## Assets
- `../assets/logo-mark.svg`, `../assets/logo-wordmark.svg` — **bespoke** brand mark
  (camera-aperture + target reticle), created for this system since none was
  supplied. Replace if official identity exists.
- Icons: **Lucide** (`lucide-react` in production); drawn inline here to stay
  dependency-free. No emoji.
- Fonts: Geist + JetBrains Mono (Google Fonts now; self-host woff2 for Electron).

## Files in this bundle
- `PRD.md` — the authoritative brief (read first).
- `README.md` — this guide.
- The full reference lives in the parent design-system project: `readme.md`,
  `styles.css`, `tokens/*`, `components/*`, `instruments` under `components/`,
  and `ui_kits/ground-control/*` (port `mock.js` → `MockDataProvider`).
