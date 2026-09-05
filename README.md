# Eye in the Sky

Autonomous person-following drone — companion computer software, Windows ground
control center, ArduPilot SITL simulator, and full hardware guide.

---

## Zero to flying in SITL — 5 commands

```bash
# 1. Clone the repo (if not already done)
git clone --recurse-submodules <repo-url> eyeinthesky && cd eyeinthesky

# 2. Install Python venv + companion deps + ArduPilot SITL  (Linux/WSL2/macOS)
bash scripts/setup-sim.sh

# 3. (Windows) Install Node deps and build the ground UI  (PowerShell)
.\scripts\setup-ground.ps1

# 4. Run the full acceptance e2e  (SITL + companion + tests)
bash scripts/run-sim-e2e.sh          # Linux/WSL2/macOS
.\scripts\run-sim-e2e.ps1            # Windows (runs SITL inside WSL2)

# 5. Start the ground control center  (second terminal, Windows)
cd ground/app/windows && npm run dev
#   (Linux ground station: bash scripts/setup-ground-linux.sh, then cd ground/app/linux && npm run dev)
```

> On Windows, steps 2 and 4 run inside WSL2 (Ubuntu). The SITL UDP port 14550
> is forwarded through WSL2 localhost automatically — no extra config needed.
> See [docs/network.md](docs/network.md) for details.

---

## Architecture

```
Camera ─► Jetson Orin Nano ──(MAVLink/UART)──► ArduPilot FC ─► motors
            │  capture → detect(person) → track → guidance        ▲
            │  + MAVLink bridge + video stream + control API    sensors / RC
            │
            └──(WiFi: control WebSocket :8765 + RTSP :8554)──► Windows GCS
                           │
               ground/app (Electron) wraps ground/ui (React)
               MockDataProvider ←──────┬──────→ LiveDataProvider
                    (SITL/dev)         │              (live drone)
                                       │
                              one-line swap in
                        ground/ui/src/dataSource/index.ts
```

- The **Jetson** runs all perception and guidance; it sends high-level
  body-frame velocity setpoints to the FC via MAVLink GUIDED mode.
- The **flight controller** does all stabilisation; the pilot's RC transmitter
  always has override priority (hardwired in ArduPilot parameters).
- The **ground control center** is a monitoring and commanding station. It runs
  identically against SITL and against a real drone — the only difference is
  which `DataSource` implementation is active (see below).

---

## Build / run order (PRD §10)

| Step | Command | Environment |
|------|---------|-------------|
| 1 | `bash scripts/setup-sim.sh` | Linux / WSL2 / macOS |
| 2 | `bash scripts/run-sim-e2e.sh` or `make e2e` | Linux / WSL2 |
| 3 | `.\scripts\setup-ground.ps1` | Windows PowerShell |
| 4 | `cd ground/app/windows && npm run dev` (or `ground/app/linux` on Linux) | Windows / Linux — connects to SITL |
| 5 | Follow `docs/` to build hardware, flash FC, provision Jetson | Hardware |
| 6 | Update `.env` (`EIS_HOST=<jetson-ip>`, `EIS_SITL=false`), restart GCS | Windows |

Run steps 1-2 before anything else — they prove the full guidance loop with
zero hardware. Steps 5-6 require physical hardware.

---

## DataSource seam — the one-line swap

The ground UI is fully decoupled from the backend via a `DataSource` interface.
In development and SITL mode it uses `MockDataProvider` (synthetic data, no
network). To connect to a real companion (or a local SITL companion), change
**exactly one line**:

**`ground/ui/src/dataSource/index.ts`**

```ts
// Before (mock / pure UI dev):
export const dataSource: DataSource = new MockDataProvider();

// After (live drone OR SITL companion over WebSocket):
export const dataSource: DataSource = new LiveDataProvider();
```

`LiveDataProvider` reads `ConnectionConfig` from the Electron settings store
(persisted to disk via the preload bridge), opens the control WebSocket to the
companion, streams telemetry/tracking/statusText, forwards commands including
high-rate `manualInput` (fire-and-forget, not acked per frame), and returns
the RTSP video URL. Everything else in the UI is unchanged.

---

## Ground station: Windows & Linux

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
├── .github/workflows/ci.yml    # CI: ui + companion + optional SITL e2e jobs
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

`.github/workflows/ci.yml` runs on every push / PR to `main`:

- **`ui` job** — `npm ci`, TypeScript typecheck, Vite production build.
- **`companion` job** — `pip install -e companion[dev]`, ruff lint, pytest.
- **`sitl-e2e` job** — optional; triggers on `workflow_dispatch` or commits
  containing `[e2e]`. Installs ArduPilot SITL (cached) and runs the full
  headless acceptance demo. `continue-on-error: true` — heavy build; not
  required to merge.

---

*Eye in the Sky is a student safety project. It maintains a standoff distance
and is built never to contact its subject. See PRD §12 for explicit non-goals.*

## Existing Argus work

This repository also retains the existing drone-observability implementation in `argus-core/`, `contracts/`, and ` mock-drone-agent/`. See [ARCHITECTURE.md](ARCHITECTURE.md) and [CONTEXT.md](CONTEXT.md) for that work.

