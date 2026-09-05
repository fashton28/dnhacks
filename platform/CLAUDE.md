# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Drone Safety Platform is an autonomous person-following drone system built one-shot from
two PRDs: `claude-code-prd(1).md` (full system) and
`design_handoff_ground_control/PRD.md` (UI). The root `README.md` is the canonical
human guide (quickstart, monorepo map, safety model) — read it for anything not
covered here. This file is the orientation + gotchas a fresh Claude needs.

## Three subsystems + one contract

```
companion/ (Jetson, Python)  ──WebSocket :8765 (control+telemetry)──►  ground/ (Win + Linux)
  vision → tracking → guidance ──MAVLink GUIDED──► ArduPilot FC          ui/  React+TS+Vite+Tailwind+Zustand (shared)
  + RTSP/WebRTC video :8554 ───────────────────────────────────────►   app/{windows,linux}/ Electron shells
```

- **`companion/`** (`src/eis_companion`, package `eis-companion`) — vehicle-side.
  `control/` is a pure-logic core (numpy + stdlib only: `pid`, `tracker`,
  `guidance`, `manual`) that unit-tests with no hardware. `mavlink/`, `vision/`,
  `api/`, `stream/` wrap I/O. `app.py` is the asyncio **orchestrator** — it owns no
  control math; it composes the components and enforces safety invariants between
  them (telemetry pump @10 Hz, perception @~10 Hz, control loop @20 Hz picking the
  one active control source, command dispatch).
- **`ground/ui/`** — React UI, **shared by both OS shells**. Consumes data ONLY
  through a `DataSource` interface.
- **`ground/app/windows/` + `ground/app/linux/`** — two Electron shells wrapping the
  one UI. Renderer has zero Node access; all OS access goes through `preload.ts` →
  `ipc.ts` → `main.ts` (`window.eis`). The two `src/` trees are near-identical (the
  audit was clean); the Linux shell adds `power:inhibit/release` IPC (`powerSaveBlocker`,
  LINUX_PRD §7) + Linux packaging. **Keep the two `src/` trees in sync for shared
  changes.** See `LINUX_PRD.md` + `PORT_AUDIT.md`.
- **`sim/`** — ArduCopter SITL launcher + the **acceptance gate** (`e2e_test.py`,
  `manual_test.py`). These talk only the WebSocket contract, never companion
  internals, so they verify the real seam.

## The shared contract (read before touching any wire type)

`ground/ui/src/contract/index.ts` is the **authoritative** copy. Two mirrors must
stay in sync byte-for-byte semantically: `shared/shared.ts` and `shared/shared.py`
(the latter is what the companion `api/server.py` implements). Change one → change
all three.

**Critical naming alias:** the UI/contract uses `engageManual` / `disengageManual`
commands + a fire-and-forget `manualInput` wire message. These ALIAS the original
PRD's `takeManualControl` / `releaseManualControl` / `manualInput`. `manualInput` is
high-rate (~20–50 Hz) and **never acked per frame** (per-frame acks build
backpressure); only engage/disengage are acked. Exactly one `controlSource`
(`auto` | `tracking` | `manual`) is ever active and is reported in every
`telemetry` frame.

**Mock vs Live is one line** in `ground/ui/src/dataSource/index.ts`:
`new MockDataProvider()` (synthetic, no network — the default) vs
`new LiveDataProvider()` (WebSocket to companion/SITL).

## Commands

This is a Windows box (PowerShell). The `Makefile`/`justfile` targets assume a bash
shell and a Linux `.venv/bin/` layout, so they only work under WSL2/Linux/macOS. On
Windows, run the underlying npm/pytest commands directly:

```powershell
# Ground UI (node_modules already installed)
cd ground/ui;  npm run dev          # Vite dev server :5173 (uses MockDataProvider, no backend)
cd ground/ui;  npm run typecheck    # tsc --noEmit
cd ground/ui;  npm run build        # tsc && vite build
cd ground/ui;  npm run lint         # eslint

# Electron shell — one shared UI, two OS packagings under ground/app/{windows,linux}
cd ground/app/windows; npm run dev        # concurrently: Vite + Electron pointed at :5173
cd ground/app/windows; npm run typecheck
cd ground/app/windows; npm run dist       # build UI + electron, then NSIS Windows installer
cd ground/app/linux;   npm run package:linux  # AppImage + .deb + .rpm (run on a Linux host)

# Companion (Python ≥3.10). No venv exists yet — create one first.
cd companion;  pip install -e .[dev]            # core (SITL) + pytest, all pinned
cd companion;  pip install -e .[detect]         # + opencv + ultralytics (real YOLO)
cd companion;  python -m pytest                 # all unit tests (no hardware)
cd companion;  python -m pytest tests/test_guidance.py::test_name -v   # single test
```

Run the companion against SITL: `EIS_CONFIG=config/sitl.yaml python -m eis_companion.app`
(needs ArduPilot SITL reachable on `udp:127.0.0.1:14550`).

Acceptance gate: `make e2e` (or `bash scripts/run-sim-e2e.sh`) — arm → takeoff →
engage tracking → approach simulated person → **hold at standoff without breaching
it** → disengage → RTL/land. Requires SITL, which **cannot run natively on
Windows** — use WSL2 (it forwards localhost so the companion/tests can run on the
Windows side).

## Environment gotchas (learned the hard way)

- **Python 3.14 here, but `numpy==1.26.4` is pinned** — that wheel may not exist for
  3.14, so a venv install can try to build from source. If `pip install -e .[dev]`
  fails on numpy, that's why; use a 3.10–3.12 interpreter for the venv.
- **electron-builder on Windows without admin/Developer Mode**: the installer build
  needs `win.signAndEditExecutable: false` (already in `ground/app/windows/electron-builder.yml`)
  and `CSC_IDENTITY_AUTO_DISCOVERY=false`, or winCodeSign symlink extraction fails.
  (The Linux shell has its own `ground/app/linux/electron-builder.yml` — AppImage/deb/rpm.)
- **Each OS shell has its own `node_modules`** (Electron ships per-platform binaries).
  The Windows shell's came with the move; the Linux shell installs on a Linux host via
  `scripts/setup-ground-linux.sh`. To typecheck the Linux shell on Windows, junction
  its `node_modules` to the Windows shell's (types are platform-agnostic).
- **UI tsconfig** uses plain `tsc` (no project references), `strict: true` but
  `noUnusedLocals`/`noUnusedParameters` are `false`. Path alias `@/*` → `src/*`.
- **Config safety floor**: `config.py` re-asserts a hard safety envelope AFTER
  loading YAML/env — standoff can't go below 3 m, max_speed can't exceed 8 m/s. No
  config value can relax a safety limit. Don't try to "fix" a clamp by editing YAML.
- **Safety is load-bearing, not advisory.** Standoff is a hard limit enforced in
  `control/guidance.py` and never overridden by the orchestrator; every setpoint is
  clamped to `Limits` twice (in-component and again before reaching the FC); manual +
  ground-link watchdogs zero-and-hold on loss. When changing guidance/manual/app,
  preserve these. The e2e tests fail loudly on a breach — fix the code, don't loosen
  the test.

## Root files that are NOT the product

The design-system root dirs/files — `components/`, `instruments/`, `tokens/`,
`ui_kits/`, `guidelines/`, `templates/`, `slides/`, `_ds_*`, `SKILL.md`,
`DESIGN_SYSTEM.md` — are **reference only** from the design handoff. The production
UI is `ground/ui/`. Note: `DESIGN_SYSTEM.md` is the original `readme.md`; on
Windows's case-insensitive FS a new `README.md` clobbers it, so don't recreate the
lowercase one.
