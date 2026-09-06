# Build Summary — Drone Safety Platform

A record of the session that built the full system from the two PRDs, including
how it was built, what was verified, the integration fixes made, and the known
limitations. This documents the work captured in commit
`070c1b0` ("Build full Drone Safety Platform drone system").

> Note: a later session reorganised the Electron shell into per-OS folders
> (`ground/app/windows/` + `ground/app/linux/`). This summary describes the
> layout as built in this session, where the single Electron shell lived at
> `ground/app/`. See `LINUX_PRD.md` / `PORT_AUDIT.md` for the port.

---

## 1. Objective

Build the **complete monorepo** described by the two briefs — not just the UI:

- `claude-code-prd(1).md` — the full-system brief (Jetson companion, ground
  control center, simulator, reproducible setup, hardware docs).
- `design_handoff_ground_control/PRD.md` — the UI product brief.
- `prompt.txt` — the operative instruction to build the GCS frontend (removed with the
  design handoff material; see `docs/DISCREPANCY_REWRITE.md` at the repo root).

The whole system meets at one `DataSource` contract so the UI runs identically on
a mock or a live drone, and the companion implements the same contract over
MAVLink / video / WebSocket. Target: deployment-ready, ready to integrate with a
real Jetson stream and ArduPilot.

---

## 2. What was built

```
shared/        DataSource contract in TS + Python (kept in sync)
ground/ui/     React 18 + TS + Vite + Tailwind GCS (pixel-faithful port of the prototype)
ground/app/    Electron shell + preload bridge + recorder + settings + Windows installer
companion/     Jetson Python: vision · tracking · guidance · manual · MAVLink · API · stream
sim/           ArduPilot SITL launch + headless e2e + manual-piloting acceptance tests
docs/          hardware (BOM) · assembly · flashing · network · runbook · operator-manual
scripts/       setup-ground/sim/jetson · run-sim-e2e · Makefile · justfile · CI · .env.example
```

Scope at commit `070c1b0`: **231 files, ~42,778 insertions** — ~7,000 lines
TS/TSX (47 files), ~7,500 lines Python (28 files), 6 hardware/ops docs (~2,762
lines), plus the original design-system reference files.

### Highlights
- **Contract** (`ground/ui/src/contract/index.ts` authoritative, mirrored to
  `shared/shared.ts` + `shared/shared.py`). The manual-control extension was
  reconciled: the UI uses `engageManual`/`disengageManual` commands plus a
  fire-and-forget `manualInput` wire message and `DataSource.setManualInput()`,
  which alias CODE_PRD's `takeManualControl`/`releaseManualControl`/`manualInput`.
- **UI**: status bar, video panel (synthetic canvas scene + tracking overlay +
  WHEP live-video player), left flight/tracking/manual controls, right telemetry
  (custom SVG artificial horizon + compass + gauges + sparklines), `react-leaflet`
  satellite map with offline grid fallback, log console, all modals including the
  three new ones (failsafe & geofence, PID tuning, flight-log browser + replay),
  full safety UX (checklist→arm, hold-to-confirm takeoff/engage/take-manual,
  instant disarm/disengage, persistent banners, critical-status toasts, keyboard
  shortcuts), gamepad + WASD manual control, Mock + Live providers, one-line swap.
  Fonts self-hosted via `@fontsource-variable` (offline-ready for Electron).
- **Electron**: secure main/preload split (`contextIsolation`, no
  `nodeIntegration`), on-disk settings store, NDJSON flight recorder + replay,
  `electron-builder` → NSIS Windows installer.
- **Companion** (`eis_companion`): GStreamer/V4L2 capture + YOLO→TensorRT person
  detector + synthetic sim-target source; single-target tracker (IoU + per-track
  Kalman, stable IDs, coast-through-occlusion, lost timeout); visual-servoing
  guidance (PID on yaw/climb/forward, distance from bbox height, **hard standoff
  clamp** that never commands approach inside the standoff); manual piloting with
  deadzone/smoothing and an input watchdog; MAVLink `Vehicle` (pymavlink, body-NED
  `SET_POSITION_TARGET_LOCAL_NED` setpoints) + `SafetyManager` (ground-link
  deadman, arming preconditions, emergency-stop plan, ArduCopter failsafe/geofence
  param map); asyncio WebSocket control API; mediamtx/GStreamer RTSP/WebRTC stream;
  layered YAML+env config; Dockerfile (L4T/JetPack base) + systemd unit.
- **Sim**: `run_sitl.sh` + params, a Python `headless_client` (the ground
  stand-in), `e2e_test.py` (the primary acceptance gate — arm → takeoff → engage
  tracking → assert approach + hold at standoff **without breaching** → disengage
  → RTL/land) and `manual_test.py` (manual engage → watchdog → release → estop).

---

## 3. How it was built (process)

A **hybrid multi-agent workflow** under the ultracode effort setting:

1. **Foundation (written directly):** the shared contract (TS + Python), the UI
   build config (Vite/TS/Tailwind/PostCSS), the design tokens (CSS variables +
   Tailwind mirror + JS literals for canvas), and the brand assets — the
   integration-critical seam everything else depends on.
2. **Parallel fan-out (one workflow, 15 agents):** each agent owned a disjoint
   directory and shared the contract/tokens, so they cohered without file
   conflicts — UI primitives, instruments, panels, media panels, views, data
   layer, and app shell; companion control-core, MAVLink, vision, and
   API/orchestrator/packaging; the simulator; the Electron shell; the six docs;
   and the scripts/Makefile/CI/README. ~1.06M agent tokens, 534 tool calls.
3. **Integration + verification pass (written directly):** reconciled the API
   drift between agents (below), fixed the UI build config, and ran every check
   that could run in this environment.

---

## 4. Verification performed

| Check | Result |
|---|---|
| UI `tsc --noEmit` | clean (exit 0) |
| UI `npm run build` (tsc + Vite) | clean; self-hosted Geist + JetBrains woff2 bundled; ~122 kB gzip JS |
| Companion unit tests (`pytest companion/tests`) | **42 passed** (guidance / tracking / manual) |
| In-process orchestrator smoke | full pipeline OK: `SimTargetSource → Tracker → Guidance` locked and **converged to ~5.68 m → 5 m standoff**; manual sticks drove a correct setpoint (`vx=+0.45` forward, `vz=−0.75` climb); **watchdog zeroed+held** on stale input; control-source exclusivity (tracking→manual→auto); emergencyStop→land |
| `pip install -e companion` | OK (`eis_companion 0.1.0` imports) |
| Electron `tsc -p tsconfig.json` | clean (exit 0) |
| **Windows NSIS installer** (`electron-builder --win nsis`) | **built** — `Drone Safety Platform Setup 1.0.0.exe` (~79 MB) |

---

## 5. Integration fixes (agent API drift reconciled)

The 15 parallel agents independently guessed some internal interfaces; these
would otherwise have broken the SITL e2e. Fixed during the integration pass:

- **`ManualPilot`** — added `set_input()` / `update()` / `reset()` adapters over
  the existing `feed()/engage()/release()` so the orchestrator's high-rate +
  per-tick split works.
- **`Vehicle`** — added constructor args (`connection=…`, `baud=…`,
  `source_system=…`, `target_system=…`), `get_state()` / `get_telemetry()` (poll +
  translate in one call), and a component-arg `send_body_velocity(vx,vy,vz,
  yaw_rate, valid=…)` that still accepts a `VelocitySetpoint`.
- **`SimTargetSource.observe()`** — alias of `get_observations()` (the perception
  loop's expected interface).
- **`_CameraSource`** — unpack `Capture.read()`'s `(ok, frame)` tuple.
- **UI** — `PidModal` export alias (file is `PidTuningModal`), `LogBrowserModal`
  now awaits the recorder's Promise-returning `list()/load()`, tsconfig switched
  to plain `tsc` (dropped project references; `noUnusedLocals/Parameters` off,
  `strict` kept), and the `@fontsource-variable` versions were pinned to existing
  releases.
- **Packaging** — generated a branded multi-size `icon.ico`; set
  `win.signAndEditExecutable: false` + `CSC_IDENTITY_AUTO_DISCOVERY=false` so the
  installer builds on a Windows account without admin / Developer Mode (the
  `winCodeSign` bundle's macOS `.dylib` symlinks otherwise fail to extract).

---

## 6. Key decisions

- Pixel-faithful **port** of the HTML/JSX prototype into the real stack
  (inline styles referencing CSS-variable tokens), not a redesign.
- Design tokens live as CSS custom properties (`index.css`) mirrored into the
  Tailwind theme and a JS-literal module for canvas/SVG — no scattered hex.
- The companion's pure-logic control core (guidance/tracking/manual/pid/distance)
  imports only numpy + stdlib, so it unit-tests with zero hardware.
- Conservative safety defaults (PRD §9): standoff 5 m (hard floor 3 m), max speed
  2 m/s (cap 8), altitude cap 30 m, geofence 60 m, manual watchdog 500 ms,
  ground-link deadman 2 s. Standoff is enforced as a hard limit in guidance and
  re-asserted by the orchestrator.

---

## 7. Known limitations (not executed here)

- **ArduPilot SITL** cannot run in the Windows sandbox used for this build, so
  `sim/e2e_test.py` and `sim/manual_test.py` are delivered and smoke-validated
  against the real companion modules but **not executed against a live SITL**.
  Run them per `sim/README.md` (or `make e2e`) on a Linux/WSL2 host — that is the
  documented acceptance gate.
- The Windows installer is **unsigned** (no code-signing certificate available).
  Provide a cert + `CSC_LINK` for a signed release.
- Hardware steps (BOM build, FC flashing, Jetson provisioning) are documented in
  `docs/` but require the physical drone.

---

## 8. How to run / build

```bash
# UI on the mock provider — no backend, no hardware:
cd ground/ui && npm install && npm run dev

# Companion against SITL (Linux/WSL2): start SITL, then:
EIS_CONFIG=companion/config/sitl.yaml python -m eis_companion.app
# then the acceptance gate:
python sim/e2e_test.py && python sim/manual_test.py    # or: make e2e

# Go live: swap one line in ground/ui/src/dataSource/index.ts
#   new MockDataProvider()  ->  new LiveDataProvider()
```

See the top-level `README.md` for the full quickstart, architecture, and the
build/run order, and `docs/` for hardware, flashing, network, runbook, and the
operator manual.
