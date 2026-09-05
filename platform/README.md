# Drone Safety Platform
DNHacks is an autonomous ISR demonstration for critical-infrastructure sites.
A baked satellite cue becomes a schema-bound mission proposal, a deterministic
verifier checks the complete route, a companion process independently clamps
the approved commands, and real ArduCopter SITL enforces the final flight and
fence behavior. The demo site is selected through `site/site.json`, with the
included Komati model in `site/site.stub.json` as the offline fallback.

The normal demonstration is fully offline. Satellite imagery, SDR samples,
sensor observations, and planner decisions all have deterministic baked or
scripted sources. Live LLM planning is an explicit opt-in.

## Demo in 90 seconds
```bash
# 1. Clone the repo (if not already done)
git clone --recurse-submodules <repo-url> dnhacks-platform && cd dnhacks-platform
```

Prepare the pinned Python and Node dependencies and the official ArduCopter
runtime while a network is available. The launchers only inspect local caches;
they never install, pull, or download anything during the demonstration.
On Windows with Docker Desktop running:

```powershell
.\scripts\demo.ps1
```

On Linux or a prepared WSL2 distribution:

```bash
bash scripts/demo.sh
```

The command derives the SITL home from `EIS_SITE_FILE`, defaulting to
`site/site.json` and then `site/site.stub.json`. It starts the modern ArduCopter
runtime, verifies the required battery, EKF3, Vicon, frame, and accelerometer
parameters, starts the companion, waits for `readiness.ready`, and opens the
live Electron ground station. `Ctrl-C` stops only the processes and named SITL
container created by the launcher. Logs are written under `logs/demo/`.

The operator sequence is short:

1. Wait for **READY**, then select **Start live inspection** to load the baked
   Komati cue into the host planner.
2. Review the proposed route and the verifier's ordered checks. A corrected
   route shows every change and is rechecked as a complete path.
3. Approve the effective plan. The companion reclamps it before sending GUIDED
   commands, while ArduCopter retains its native fence and failsafes.
4. Watch the RGB, thermal, and LiDAR observation, incident decision, RTL, and
   landing. The simulated pad returns the pack to charged in 30 seconds by
   default.

Run a dependency-only check without starting the stack:

```powershell
.\scripts\demo.ps1 --preflight
```

```bash
bash scripts/demo.sh --preflight
```

If a dependency is missing, the launcher names the exact image, volume,
runtime, virtual environment, or Node install it expected. Windows prefers the
cached Docker runtime and falls back to a prepared native WSL2 SITL. Linux uses
the same Docker runtime when available and otherwise uses `sim/run_sitl.sh`.

### Failure beats

Flags schedule a guarded SITL `testFault` 20 seconds after launch so the normal
readiness and cue are visible first. Set `EIS_DEMO_FAULT_DELAY_S` to change that
delay.

| Command | Expected visible behavior |
|---|---|
| `--gps-loss` | The companion detects the GPS transition, selects the configured external-navigation EKF source, holds, refuses new missions, and reports the source change. |
| `--hostile-drone` | A mission on the pad is refused; an airborne mission holds for the operator's continue-or-RTL decision. |
| `--link-loss` | The companion zeroes commands and holds; ArduCopter's GCS failsafe remains the RTL backstop. |
| `--camera-fail` | The sortie still returns, but the recognizer escalates the missing RGB observation instead of inventing a detection. |
| `--battery-fault` | Dispatch is refused on the pad; an airborne pack fault commands RTL independently of the planner. |
| `--night --thermal-fail` | Night dispatch is refused because a healthy thermal rail is required. |
| `--lidar-fail` | Clutter routes are refused; an airborne mission climbs to the site's clear band and reports degraded sensing. |
| `--sortie-cap 45` | The verifier trims a plan to the tighter budget or rejects it, and the companion retains an independent sortie-expiry RTL. |

Flags may be combined. `--link-loss` is injected last so it cannot prevent the
other requested faults from being acknowledged. PowerShell aliases such as
`-GpsLoss`, `-HostileDrone`, `-SortieCap 45`, and `-Night` are also accepted.

Use `--live-llm` only when a network is intentionally available and
`OPENAI_API_KEY` is set. Without this flag, `EIS_PLANNER_MODE=scripted` and the
mission path makes no LLM network request.

## Architecture

```text
baked satellite / passive SDR / RF feed
                  |
                  v
        anomaly + site model
                  |
                  v
 schema-bound planner -> deterministic MissionVerifier -> operator approval
                                                     |
                                                     v
               Electron GCS <-> companion :8765 <-> ArduCopter SITL :5760
                                      |                 |
                         sensor fusion + report     native EKF/fence
```

- `ground/satellite/` turns baked optical and clearly labelled synthetic SAR
  fallback assets into anomaly cues.
- `ground/planner/` contains the scripted/live planner, ordered verifier, route
  correction, and report decision.
- `ground/sdr/` is receive-only. Its default source is scripted; live mode uses
  SoapySDR or pyrtlsdr when installed. There is no transmit path.
- `ground/ui/` is the shared React renderer. `ground/app/windows/` and
  `ground/app/linux/` host it in matching Electron shells.
- `companion/` owns vehicle readiness, independent plan clamping, sensor fusion,
  navigation-source switching, battery/sortie policy, and failure responses.
- `sim/` contains real ArduCopter integration and the acceptance gauntlet.
- `site/` owns site geometry and staged observations. Runtime code consumes the
  selected JSON instead of embedding another location.
- `shared/` mirrors the wire contract whose TypeScript authority lives in
  `ground/ui/src/contract/index.ts`.

The trust chain is deliberately layered: the LLM can only propose a typed plan;
the ground verifier evaluates the full path; the companion validates the
approved effective plan again; and ArduCopter applies its native flight fence.
Manual control preempts automation, and failure outcomes resolve to hold, RTL,
escalate, or refuse.

Mission sequences currently admit `goto_gps`, `orbit_point`, `hold`, and `rtl`,
whose geometry and duration can be checked end to end and decoded by the
companion sequence executor. The shared wire enum still supports `follow`,
moving-target `orbit`, and `goto_relative` as individual `planCommand` tools;
the mission planner rejects them until track/relative geometry and matching
sequence execution can be proved.

## Offline prerequisites

The Windows demo expects:

- Docker Desktop with cached image `radarku/ardupilot-sitl:latest`;
- volume `dnhacks-phase4-sitl-runtime` containing executable
  `/runtime/arducopter-4.7.0` (the verified binary reports official
  ArduCopter 4.7.1);
- `companion/.venv/Scripts/python.exe` with the pinned companion dependencies;
- installed dependencies under `ground/ui/node_modules` and
  `ground/app/windows/node_modules`.

Linux uses `companion/.venv/bin/python` and `ground/app/linux/node_modules`.
When Docker is absent, it additionally requires a native `sim_vehicle.py` or
ArduCopter binary discoverable by `sim/run_sitl.sh`.

The launchers preserve SITL EEPROM in `dnhacks-phase4-sitl-state2` and omit
`--wipe` during normal starts. They use frame model `quad`, native Vicon on
serial 5, and bind MAVLink only to `127.0.0.1:5760`. The control WebSocket binds
on port `8765`; the ground Vite development server uses `5173`.

## Verification

Run the focused offline suites from the repository root:

```powershell
companion\.venv\Scripts\python.exe -m pytest companion\tests
Push-Location ground\planner; npm test; Pop-Location
Push-Location ground\satellite; npm test; Pop-Location
companion\.venv\Scripts\python.exe -m pytest ground\sdr\tests
Push-Location ground\ui; npm run lint; npm run typecheck; npm run build; Pop-Location
```

Use the matching shell syntax on Linux. The end-to-end acceptance scripts in
`sim/` and the two `scripts/run-sim-e2e.*` wrappers exercise the public
WebSocket contract against ArduCopter SITL.

## Documentation and history

- [Failure modes](docs/FAILURE_MODES.md) maps each detection to one authority
  and one of hold, RTL, escalate, or refuse.
- [Hackathon decisions](docs/ADR-hackathon.md) records the site, RF, sensor,
  planner, and battery decisions.
- [Site contract](docs/SITE_CONTRACT.md) defines the runtime geometry model.
- [Session summary](SESSION_SUMMARY.md) records implemented phases and verified
  boundaries.
- [Port audit](PORT_AUDIT.md) tracks the Windows/Linux shell parity.
The GCS ships for **both** Windows and Linux. The React renderer (`ground/ui`)
is platform-agnostic and **shared** — only the Electron shell + packaging differ:

| | Windows | Linux |
|---|---|---|
| Shell | `ground/app/windows` | `ground/app/linux` |
| Setup | `.\scripts\setup-ground.ps1` | `bash scripts/setup-ground-linux.sh` |
| Dev | `cd ground/app/windows && npm run dev` | `cd ground/app/linux && npm run dev` |
| Package | `npm run dist` → NSIS `.exe` | `npm run package:linux` → AppImage + `.deb` + `.rpm` |
| OS integration | code-sign skip | XDG dirs, gamepad udev rule, `powerSaveBlocker`, GTK deps |

The Linux build is a **port delta**, not a fork: see [`LINUX_PRD.md`](LINUX_PRD.md)
for the brief and [`PORT_AUDIT.md`](PORT_AUDIT.md) for the Windows-coupling audit
(it came back clean — the Electron source was already cross-platform).

---

## Monorepo map

```
.
├── companion/                  # Jetson companion software (Python)
│   ├── src/eis_companion/      # package: eis_companion
│   │   ├── api/                # WebSocket server — shared contract
│   │   ├── control/            # visual-servoing guidance + manual-piloting
│   │   ├── mavlink/            # FC connection, GUIDED setpoints, bridge
│   │   ├── stream/             # RTSP / mediamtx video stream
│   │   ├── vision/             # capture, YOLOv11n detection, ByteTrack
│   │   ├── config.py           # layered config loader (YAML + env)
│   │   └── types.py            # internal dataclasses (VelocitySetpoint…)
│   ├── tests/                  # pytest unit tests (guidance, manual, tracking)
│   ├── config/                 # default.yaml, sitl.yaml, gains
│   ├── systemd/                # eis-companion.service (autostart on Jetson)
│   ├── Dockerfile              # L4T 36.2 / JetPack 6.0 base image
│   └── pyproject.toml          # pinned deps (pymavlink, ultralytics…)
│
├── ground/
│   ├── ui/                     # React + TypeScript UI (Vite, Tailwind, Zustand)
│   │   └── src/
│   │       ├── contract/       # AUTHORITATIVE shared contract types (TS)
│   │       ├── dataSource/
│   │       │   ├── index.ts    # ← THE ONE-LINE SWAP LIVES HERE
│   │       │   ├── MockDataProvider.ts
│   │       │   └── LiveDataProvider.ts
│   │       ├── components/     # HUD, map, video panel, manual control…
│   │       └── …
│   └── app/                    # Electron shell — one renderer, two OS packagings
│       ├── windows/            # Windows shell: NSIS installer, .ico
│       │   └── src/            # main.ts, preload.ts, ipc.ts, settingsStore.ts, recorder.ts
│       └── linux/              # Linux shell: AppImage/.deb/.rpm, XDG, udev, power-inhibit
│           ├── src/            # same logic + power IPC (LINUX_PRD §7)
│           └── build-resources/ # icon.png, .desktop, udev rule, post(install|remove).sh
│
├── sim/                        # Simulator
│   ├── run_sitl.sh             # ArduCopter SITL launcher
│   ├── e2e_test.py             # PRIMARY acceptance gate
│   ├── manual_test.py          # Manual-piloting acceptance gate
│   ├── headless_client.py      # Python WebSocket client (ground stand-in)
│   └── params/eis-sitl.parm   # ArduPilot SITL parameters
│
├── shared/                     # Contract mirror
│   ├── shared.ts               # mirrors ground/ui/src/contract/
│   └── shared.py               # mirrors companion wire shapes
│
├── docs/
│   ├── hardware.md             # BOM — lowest-cost build, Philippines sourcing
│   ├── assembly.md             # Frame, wiring, Jetson↔FC UART, camera mount
│   ├── flashing.md             # ArduCopter firmware + params; JetPack setup
│   ├── network.md              # WiFi, static IPs, ports, firewall
│   ├── runbook.md              # Commissioning checklist + first-flight sequence
│   └── operator-manual.md     # Day-to-day GCS use, indicators, interlocks
│
├── scripts/
│   ├── setup-ground.ps1        # Windows: Node ≥20 check, npm install, UI build
│   ├── setup-sim.sh            # Linux/WSL2/macOS: venv + companion + ArduPilot
│   ├── setup-jetson.sh         # Jetson: Docker build + systemd install
│   ├── run-sim-e2e.sh          # Acceptance demo (bash)
│   └── run-sim-e2e.ps1         # Acceptance demo (PowerShell / WSL2)
│
├── ../.github/workflows/ci.yml # Repository CI: ui + companion + optional SITL e2e jobs
├── Makefile                    # Delegates to scripts/npm/pytest
├── justfile                    # just alternative (same targets)
├── .env.example                # Every env variable documented
├── DESIGN_SYSTEM.md            # Design-system reference (was readme.md)
└── README.md                   # This file
```

---

## What is verifiable where

| Claim | How to verify |
|-------|--------------|
| UI builds and runs | `make build-ground` or `cd ground/ui && npm run dev` — no backend needed |
| UI mock (all screens and data) | `cd ground/app/windows && npm run dev` (or `ground/app/linux`) with `EIS_SITL=true`; `MockDataProvider` feeds synthetic telemetry/tracking |
| Companion unit tests pass | `make test` → pytest in `companion/tests/` |
| Full guidance + standoff loop | `make e2e` — no hardware needed |
| Manual-piloting safety | `make e2e` runs `sim/manual_test.py` (arm→takeoff→manual→watchdog→release) |
| Hardware + real drone | Follow `docs/runbook.md` commissioning sequence |

> `make e2e` is the **primary acceptance gate**. It runs arm → takeoff →
> engage tracking → assert vehicle approaches simulated person and holds at
> standoff without breaching it → disengage → RTL/land — with zero hardware.

---

## Safety model summary

- **Standoff is a hard limit.** Guidance never commands motion that would close
  inside the configured minimum standoff distance (`EIS_STANDOFF_M`, enforced
  floor 3 m). The system approaches and holds; it never contacts the subject.
- **RC override always wins.** The FC is configured so the pilot's RC
  transmitter retakes control instantly, regardless of companion state.
- **Single active control source.** `auto`, `tracking`, and `manual` are
  mutually exclusive. The authoritative `controlSource` field in telemetry
  reflects the vehicle state; engaging manual immediately disengages tracking.
- **Input watchdog.** If `manualInput` frames stop arriving (link drop or
  operator pause), the companion zeroes all setpoints and holds within 500 ms.
  Same on GCS heartbeat loss during tracking.
- **Layered failsafes.** Low battery → RTL. RC loss → RTL. GCS heartbeat loss
  while tracking → hold/RTL. All configurable in `companion/config/default.yaml`
  and reflected in `sim/params/eis-sitl.parm`.
- **Instant stop.** `emergencyStop` / `disarm` takes effect immediately,
  releases tracking and manual control, zeroes setpoints, commands LAND/BRAKE.
- **Conservative defaults** (PRD §9): standoff 5 m, max speed 2 m/s, altitude
  cap 30 m, geofence radius 60 m.

---

## Documentation

| File | Contents |
|------|----------|
| [docs/hardware.md](docs/hardware.md) | Full BOM, lowest-cost build, Philippines sourcing notes |
| [docs/assembly.md](docs/assembly.md) | Frame, motors, FC, Jetson wiring, camera mount |
| [docs/flashing.md](docs/flashing.md) | ArduCopter firmware, ArduPilot parameters, JetPack setup |
| [docs/network.md](docs/network.md) | WiFi, static IPs, ports (8765 / 8554), firewall |
| [docs/runbook.md](docs/runbook.md) | Commissioning checklist, first-flight sequence, emergencies |
| [docs/operator-manual.md](docs/operator-manual.md) | Day-to-day GCS use, every indicator explained |
| [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) | Design-system reference (tokens, components, UI kit) |

---

## Configuration quick-reference

Copy `.env.example` to `.env` and edit. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `EIS_HOST` | `sitl` | Jetson IP (e.g. `192.168.1.42`) or `sitl` |
| `EIS_CONTROL_PORT` | `8765` | WebSocket port |
| `EIS_VIDEO_URL` | (auto) | RTSP/WebRTC URL; blank = mock canvas in GCS |
| `EIS_SITL` | `true` | Set `false` when connecting to a real drone |
| `EIS_FC_CONNECTION` | `udp:127.0.0.1:14550` | SITL; real HW: `/dev/ttyTHS1` |
| `EIS_STANDOFF_M` | `5` | Standoff distance (enforced floor: 3 m) |
| `EIS_MAX_SPEED_MPS` | `2` | Max guidance + manual speed |
| `EIS_MAX_ALT_M` | `30` | Altitude cap |
| `EIS_CONFIG` | `config/default.yaml` | Use `config/sitl.yaml` for SITL |

---

## make / just targets

Both `Makefile` and `justfile` provide identical targets:

| Target | Action |
|--------|--------|
| `setup` | Full setup (calls `setup-sim`) |
| `setup-sim` | Python venv + ArduPilot SITL |
| `setup-ground` | Windows ground station (needs PowerShell) |
| `setup-ground-linux` | Linux ground station (Node deps + UI build) |
| `setup-jetson` | Jetson Docker image + systemd (run on Jetson) |
| `sim` | Launch SITL + companion (Ctrl-C to stop) |
| `e2e` | Full acceptance demo |
| `build-ground` | Build shared UI + typecheck the Windows shell |
| `build-ground-linux` | Build shared UI + typecheck the Linux shell |
| `build-companion` | Validate companion package install |
| `lint` | ruff (companion) + eslint (ground/ui) |
| `test` | pytest + npm typecheck |
| `clean` | Remove build artefacts |

---

## CI

`../.github/workflows/ci.yml` runs on every push / PR to `main`:

- **`ui` job** — `npm ci`, TypeScript typecheck, Vite production build.
- **`companion` job** — `pip install -e platform/companion[dev]`, ruff lint, pytest.
- **`sitl-e2e` job** — optional; triggers on `workflow_dispatch` or commits
  containing `[e2e]`. Installs ArduPilot SITL (cached) and runs the full
  headless acceptance demo. `continue-on-error: true` — heavy build; not
  required to merge.

---

*Drone Safety Platform is a student safety project. It maintains a standoff distance
and is built never to contact its subject. See PRD §12 for explicit non-goals.*