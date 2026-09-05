# PRD — Autonomous Person-Following Drone, Full System (for Claude Code)

> **How to use this prompt:** Paste this whole document into Claude Code at the root of an empty repository. It is a one-shot brief: build the entire system — drone companion software, the Windows ground control center, the simulator, the reproducible setup, and the hardware assembly/deployment guide — with little to no further input from me. Assume unlimited time/tokens; favour completeness, correctness, and reproducibility over brevity. **Build and verify everything against the simulator (SITL) first — the whole system must work end-to-end with zero hardware before any hardware step.**

---

## 1. Project context

A student summer project: an autonomous **person-following drone**. A quadcopter running **ArduPilot** carries an **NVIDIA Jetson Orin Nano** companion computer with a camera. The Jetson detects a person (pretrained model, no training data), and commands the drone — via MAVLink in `GUIDED` mode — to turn toward and approach that person, **stopping and holding at a configurable standoff distance**. This is a follow-me / visual-tracking system: it maintains distance and never contacts the subject. I monitor and control it from a **Windows desktop control center**.

I am building everything **from scratch** (no existing drone). So this project must also produce a complete, low-cost **hardware bill of materials and assembly/deployment guide**.

### 1.1 System architecture

```
Camera ─► Jetson Orin Nano ──(MAVLink/UART)──► ArduPilot FC ─► motors
            │  capture → detect(person) → track → guidance        ▲
            │  + MAVLink bridge + video stream + control API    sensors / RC
            │
            └──(WiFi: control WebSocket + video + telemetry)──► Windows control center
```

- The Jetson runs the perception + guidance and relays MAVLink/telemetry + video to the ground.
- The flight controller does all stabilization; the Jetson only sends high-level `GUIDED` setpoints.
- The ground control center is a monitoring + commanding station. The pilot's RC transmitter always has override priority.

## 2. Your task (one-shot objective)

Build, document, and make reproducible the complete system:

1. **Companion software** (Jetson): camera → person detection → single-target tracking → visual-servoing guidance → MAVLink to the FC, plus a MAVLink/telemetry bridge, a video stream, and a control API — all to the shared contract in Section 5.
2. **Ground control center** (Windows): an Electron app that wraps the existing React UI (Section 6.2) and provides a `LiveDataProvider` implementing the shared contract over real MAVLink/video/WebSocket. Includes a **SITL mode** so it works with no drone.
3. **Simulator (SITL)**: ArduPilot SITL plus a way to exercise the full tracking+guidance loop in simulation (a simulated/mock target), and an end-to-end test.
4. **Reproducible setup**: Docker for the Jetson, one-command bootstrap scripts, pinned versions, idempotent setup — so anyone can rebuild this from zero.
5. **Hardware assembly/deployment guide**: complete low-cost BOM, wiring, assembly, firmware flashing, Jetson provisioning, network setup, and a commissioning/first-flight runbook.

Do not ask me questions. Make sensible, opinionated, **lowest-cost** choices and document them.

## 3. Constraints & priorities

- **Lowest cost**, throughout. Choose the cheapest reliable parts and free/open-source software. (The Jetson will dominate the BOM; minimise everything else.)
- **Windows** is the ground-station OS — produce a Windows installer.
- **Safety-first** (Section 11): standoff distance enforced (no collision), conservative speed/altitude caps, RC override primacy, geofence, layered failsafes, instant stop.
- **SITL-first**: nothing requires hardware to develop or test. The acceptance demo runs entirely in simulation.
- **Reproducible**: pinned versions, scripted setup, Docker, no undocumented manual steps.
- **Stack:** Jetson side Python (pymavlink/MAVSDK, GStreamer, TensorRT). Ground side Electron + React + TypeScript. Shared types in TS and Python.

## 4. Monorepo structure

```
.
├── companion/            # runs on Jetson
│   ├── vision/           # capture, detection (YOLO→TensorRT), tracking
│   ├── guidance/         # visual servoing, PID, setpoint generation
│   ├── mavlink/          # FC connection, GUIDED setpoints, bridge to ground
│   ├── stream/           # video streaming to ground
│   ├── api/              # control WebSocket server (shared contract)
│   ├── config/           # yaml configs, default gains, limits
│   ├── Dockerfile
│   └── pyproject.toml / requirements.txt   # pinned
├── ground/
│   ├── ui/               # the React UI from the Claude Design prompt (drop-in)
│   ├── app/              # Electron main + preload + LiveDataProvider + MAVLink/video clients
│   └── package.json      # pinned; electron-builder config
├── sim/                  # ArduPilot SITL launch, scenarios, simulated target, e2e tests
├── shared/               # the contract: shared.ts + shared.py (kept in sync) + schema docs
├── docs/                 # hardware.md (BOM), assembly.md, flashing.md, network.md, runbook.md, operator-manual.md
├── scripts/              # bootstrap/setup/run scripts for each environment
├── Makefile  (or justfile)
├── .env.example
└── README.md
```

The `ground/ui` folder is produced by the companion **Claude Design** prompt. If it is already present, integrate it. **If it is absent, generate a minimal functional UI that satisfies the same contract** so the system still builds and the acceptance demo still runs — then leave clear instructions for dropping in the polished UI later.

## 5. THE SHARED CONTRACT — authoritative, do not change

Identical to the UI's contract. Implement it on the companion (Python) and on the ground `LiveDataProvider` (TypeScript). Keep `shared/shared.ts` and `shared/shared.py` byte-for-byte semantically in sync.

> **Source of truth:** the contract has been extended with manual-piloting messages (added when the UI was built in Claude Design). The integrated UI's `ground/ui/src/contract/` is now the **authoritative** copy — implement the backend to match it exactly, and mirror it into `shared/`. The manual-control additions below reflect that extension; if any field name or shape differs from the UI's actual generated types, conform to the UI's types.

### 5.1 Transport
- **Control + telemetry:** a WebSocket between Jetson and ground, default port **8765**, JSON messages of the types below. The companion pushes `telemetry` (~10 Hz), `tracking` (~10 Hz), `statusText`, and `ack`; the ground sends `command`.
- **Manual stick input** is a high-rate command (`manualInput`, ~20–50 Hz) sent over the same WebSocket. It must be **fire-and-forget — not individually acked** (do not block on an ack per stick frame, or backpressure will build). Only `takeManualControl` and `releaseManualControl` are acked.
- **Video:** RTSP or WebRTC from the Jetson (default `rtsp://<jetson-ip>:8554/stream`), tuned for low latency. The companion may draw a light overlay, but **must still send `tracking` bbox data** (normalised coords) over the WebSocket so the UI can render interactive, click-to-select overlays.

### 5.2 Types (mirror exactly in TS and Python)

```ts
type Mode = 'STABILIZE'|'ALT_HOLD'|'LOITER'|'GUIDED'|'AUTO'|'RTL'|'LAND'|'POSHOLD'|'BRAKE';

interface Telemetry {
  type:'telemetry'; ts:number; armed:boolean; mode:Mode;
  controlSource?:'auto'|'tracking'|'manual';                      // additive: authoritative active control source (UI may also track manual state locally)
  attitude:{roll:number;pitch:number;yaw:number};                 // deg
  position:{lat:number;lon:number;relAlt:number;absAlt:number};   // m
  velocity:{groundspeed:number;verticalSpeed:number};             // m/s
  heading:number; battery:{voltage:number;current:number;remaining:number};
  gps:{fixType:number;satellites:number;hdop:number};
  home:{lat:number;lon:number;distance:number}; link:{rssi:number;latencyMs:number};
}
type TrackingState='idle'|'searching'|'locked'|'lost';
interface DetectedTarget{ id:number; bbox:[number,number,number,number]; confidence:number; isLocked:boolean } // bbox normalised 0..1
interface TrackingStatus{ type:'tracking'; ts:number; state:TrackingState; targets:DetectedTarget[];
  lockedTargetId:number|null; standoffDistance:number; estimatedDistance:number|null; maxSpeed:number }
interface StatusText{ type:'statusText'; ts:number; severity:'info'|'warning'|'error'|'critical'; text:string }
type CommandName='arm'|'disarm'|'takeoff'|'land'|'rtl'|'setMode'|'engageTracking'|'disengageTracking'|'selectTarget'|'setStandoff'|'setMaxSpeed'|'emergencyStop'|'takeManualControl'|'releaseManualControl'|'manualInput';
interface Command{ type:'command'; command:CommandName; params?:{ altitude?:number; mode?:Mode; targetId?:number; meters?:number; mps?:number;
  // manualInput axes, each normalised -1..1 (bipolar): throttle=climb/descend, yaw=yaw rate, pitch=forward/back, roll=left/right
  throttle?:number; yaw?:number; pitch?:number; roll?:number } }
interface CommandAck{ type:'ack'; ts:number; command:CommandName; success:boolean; message:string }
type ConnectionState='disconnected'|'connecting'|'connected'|'error';
interface ConnectionConfig{ host:string; controlPort:number; videoUrl:string; sitl:boolean }
```

The ground `LiveDataProvider` must implement the same `DataSource` interface the UI consumes (connect/disconnect, the `on*` subscriptions, `sendCommand`, `getVideoUrl`). Swapping it in is the **one-line change** in `ground/ui/src/dataSource/index.ts`.

## 6. Component specs

### 6.1 Companion software (Jetson)

**Capture.** GStreamer pipeline using `nvarguscamerasrc` for a CSI camera (fallback to a USB/V4L2 source, configurable). Configurable resolution/FPS; default a low-latency 720p.

**Detection.** Pretrained **person** detector (COCO `person` class only) — use a small YOLO model (e.g. YOLOv8n / YOLO11n). Provide a script that downloads the pretrained weights and **exports them to a TensorRT engine** for the Jetson. Run inference on GPU; target ≥15 FPS on Orin Nano; degrade gracefully if slower. No training data required.

**Tracking.** Single-target lock. Detect persons each frame, associate across frames (ByteTrack, or IoU + Kalman filter), assign stable IDs. The ground selects which ID to lock (`selectTarget`); default to the highest-confidence / most-central person if none chosen. Maintain lock through brief occlusion via the Kalman estimate; declare `lost` after a configurable timeout, then `searching`.

**Guidance (visual servoing).** Only active when tracking is engaged, the vehicle is armed, and mode is `GUIDED`. From the locked target's bbox compute three errors and run a PID on each:
- horizontal centroid error → **yaw rate** (turn to face the target);
- vertical centroid error → **altitude / climb rate**;
- bbox-size error vs the size implied by `standoffDistance` → **forward velocity** (approach when far, hold at standoff, back off when too close).
Estimate distance from known average person height + bbox height + camera intrinsics (document the geometry); a single camera is sufficient for size-based standoff. Send commands as **body-frame velocity setpoints** via `SET_POSITION_TARGET_LOCAL_NED` (frame `MAV_FRAME_BODY_NED`) at ~10–20 Hz. **Clamp all outputs to the configured max speed and never command forward motion that would close inside the standoff distance** — this is a hard limit, not a soft preference. Smooth outputs; zero them and hold position on `lost`.

**Manual piloting.** The GCS now has a manual control panel (gamepad + keyboard); the companion is the vehicle-side counterpart. Reading the gamepad/keyboard happens entirely in the UI renderer — the companion just receives normalised stick values. Behaviour:
- `takeManualControl` (acked) is permitted **only when armed and airborne**, and **immediately disengages any active tracking** (manual and tracking are mutually exclusive — exactly one control source is ever active; set `controlSource` accordingly and report it in `telemetry`). It puts/keeps the vehicle in `GUIDED`.
- While engaged, map each incoming `manualInput` frame (axes -1..1) to a **body-frame velocity setpoint** reusing the same setpoint path as guidance: `throttle`→vertical velocity (climb/descend), `yaw`→yaw rate, `pitch`→forward/back velocity, `roll`→left/right velocity. **Clamp every axis to the same configured max speed / climb-rate / yaw-rate limits** as autonomous guidance. Apply a small deadzone and output smoothing.
- **Input watchdog:** `manualInput` is expected at high rate. If no input frame arrives for a short timeout (default ~500 ms), **zero the setpoint and hold position** — never continue the last commanded velocity. The same applies if the ground link drops (deadman).
- `releaseManualControl` (acked, and triggered instantly by the UI's one-tap release) → **zero setpoints and auto-hold** (hold position in `GUIDED`, or switch to `LOITER`/`POSHOLD`); set `controlSource` back to `auto`.
- `emergencyStop`/`disarm` always take precedence over manual control and need no confirmation.
- A more direct "manual feel" via `SET_ATTITUDE_TARGET` is an acceptable alternative, but **default to clamped velocity setpoints** for safety and consistency with guidance; document whichever you choose.

**MAVLink to FC + bridge to ground.** Connect to the FC over serial/UART (configurable, e.g. `/dev/ttyTHS1`), and in SITL over UDP. Relay telemetry/command MAVLink between the FC and the ground station (use `mavlink-router`/`mavproxy` or an equivalent relay) so both the companion and the ground GCS can speak to the FC simultaneously. Translate FC MAVLink into the contract's `telemetry` messages.

**Video stream.** Serve RTSP (e.g. via `mediamtx`/GStreamer) or WebRTC, low-latency, configurable bitrate/resolution, default `rtsp://0.0.0.0:8554/stream`.

**Control API.** A WebSocket server (default 8765) implementing the contract: push `telemetry`/`tracking`/`statusText`/`ack`, handle every `command`. Map commands to actions (`arm`/`disarm`/`takeoff`/`land`/`rtl`/`setMode` via MAVLink; `engageTracking`/`disengageTracking`/`selectTarget`/`setStandoff`/`setMaxSpeed` to the guidance module; `takeManualControl`/`releaseManualControl`/`manualInput` to the manual-piloting handler above; `emergencyStop` → immediately disengage tracking **and** release manual control, zero setpoints, and `LAND`/`BRAKE`). Ack `takeManualControl`/`releaseManualControl`; consume `manualInput` at high rate **without** per-frame acks.

**Safety (companion).** Maintain a **ground-link heartbeat (deadman)**: if the control link drops while tracking is engaged, stop guidance and hold/RTL. Respect ArduPilot geofence. Never override RC — ensure the FC is configured so the pilot can always retake control. Enforce arming preconditions. Hard-clamp speed/altitude/standoff.

**Packaging.** A `Dockerfile` (correct L4T/JetPack base for Orin Nano), a `systemd` service for autostart, all config in `config/*.yaml` + env, pinned dependencies.

### 6.2 Ground control center (Windows)

- **Integrate the UI** at `ground/ui` (from the Design prompt). Wrap it in **Electron** with a secure main/renderer split and a `preload` bridge — no `nodeIntegration` in the renderer.
- **`LiveDataProvider`** (TS) implements `DataSource`: opens the control WebSocket to the companion, subscribes/streams telemetry/tracking/statusText/ack, sends commands, and returns the live video URL from config. Reads `ConnectionConfig` from the UI's Settings.
- **Manual control transport:** the UI already reads the gamepad (Gamepad API) and keyboard and emits `manualInput` plus `takeManualControl`/`releaseManualControl` through `sendCommand`. The `LiveDataProvider` must forward `manualInput` as a high-rate, **fire-and-forget** message (do not await an ack per frame) while awaiting acks for take/release. Surface the companion's authoritative `controlSource` from `telemetry` so the status bar's `MANUAL` state and the "Manual control active" banner reflect the vehicle, including any failsafe-triggered auto-release.
- **Video rendering:** decode/display RTSP/WebRTC in the renderer (e.g. WebRTC directly, or an `rtsp`→WebRTC/MSE bridge in the Electron main process — pick the lowest-latency option that builds cleanly on Windows and document it).
- **MAVLink:** if any direct MAVLink is needed ground-side beyond the companion bridge, use a small client (node library or a bundled Python/MAVSDK sidecar) — but prefer routing everything through the companion's contract API to keep one seam.
- **SITL mode:** when `ConnectionConfig.sitl` is true (or host = `sitl`), connect to a locally running SITL + companion stack instead of a real drone. The UI must behave identically.
- **Recording + replay:** implement actual telemetry+tracking recording to disk and the replay the UI exposes; optionally record video.
- **Settings persistence:** back the UI's `SettingsStore` with a real on-disk config file via the preload bridge.
- **Packaging:** `electron-builder` → a Windows installer (NSIS `.exe` and/or MSI). One command to produce it. Pin all versions.

### 6.3 Simulator (SITL)

- Scripts to launch **ArduPilot SITL (ArduCopter)** with sensible default params (GUIDED enabled, failsafes, a default geofence).
- A way to exercise the full loop in simulation. At minimum provide a **mock target source** that feeds synthetic `tracking` detections (a person moving in the frame) into the guidance + companion stack, so guidance can be validated against SITL with no camera. As a bonus, document a Gazebo/photorealistic-sim path with a real person model + virtual camera, but the mock-target path is the required, reliable one.
- An **end-to-end automated test**: launch SITL + companion (mock target) + connect the ground `LiveDataProvider` (headless), then: arm → takeoff → engage tracking → assert the vehicle yaws toward and approaches the target and **holds at standoff without breaching it** → disengage → RTL/land. This test is the primary acceptance gate.
- A **manual-piloting test** (also headless against SITL): arm → takeoff → engage tracking, then `takeManualControl` and assert tracking auto-releases and `controlSource` becomes `manual`; stream synthetic `manualInput` and assert attitude/heading/altitude/position respond and stay within the clamped limits; stop sending input and assert the **watchdog zeroes the setpoint and holds** within the timeout; `releaseManualControl` and assert auto-hold with `controlSource` back to `auto`; confirm `emergencyStop` overrides manual instantly.

## 7. Reproducibility requirements

- **Pin every version**: `requirements.txt`/`pyproject` with exact pins, `package-lock.json`, exact Docker base image tags, and a documented target JetPack version for the Orin Nano.
- **One-command bootstrap per environment**, idempotent:
  - `scripts/setup-ground.ps1` (Windows dev: Node, deps, build),
  - `scripts/setup-sim.sh` (install + launch SITL),
  - `scripts/setup-jetson.sh` (Docker + service install on the Jetson),
  - `scripts/run-sim-e2e.*` (the acceptance demo).
- A top-level `Makefile`/`justfile` with `setup`, `sim`, `e2e`, `build-ground`, `build-companion`, `lint`, `test`.
- `.env.example` documenting every variable; no secrets in the repo.
- Optional GitHub Actions CI: lint + typecheck + build + the headless SITL e2e.
- A **"zero to flying in SITL in 5 commands"** quickstart at the top of the README.

## 8. Hardware assembly/deployment guide (required deliverable in `docs/`)

Produce complete, beginner-followable documentation. Optimise the BOM for **lowest cost** with reliable, widely-available parts; clearly mark prices as **estimates to verify** (and note that I'm in the Philippines, so flag local availability / import considerations and that prices vary). Cover at minimum:

### 8.1 `docs/hardware.md` — Bill of materials
A table with category, specific recommended low-cost part(s), quantity, approximate unit price (estimate), and notes. Cover every category needed for a full build:
- Frame (5"–7" quadcopter), motors ×4, ESC (4-in-1), propellers (+ spares)
- **Flight controller: ArduPilot-compatible**, lowest-cost reliable option (e.g. a SpeedyBee F405-class board or budget Pixhawk-class board) — verify ArduCopter support
- GPS + compass module
- **NVIDIA Jetson Orin Nano** dev kit (note this dominates the budget) + microSD/NVMe
- CSI camera (IMX219-class) + ribbon/mount
- Power: 4S LiPo + charger, power module/BEC, wiring/connectors
- RC: budget transmitter + receiver (verify protocol support)
- Comms: WiFi for the Jetson↔ground link (USB WiFi or small router as needed) + **optional** SiK 433/915 MHz telemetry radio pair (backup link)
- Misc: vibration dampers, standoffs, cables (UART, USB), cooling for the Jetson, mounting, SD card
- Provide an **estimated total** and call out the cheapest viable configuration vs. nice-to-haves.

### 8.2 `docs/assembly.md` — Build & wiring
Frame/motor/ESC assembly; FC mounting (orientation, vibration isolation); GPS placement; power distribution; **Jetson↔FC UART wiring** (TX/RX/GND, voltage levels, which FC serial port); camera mounting + field of view; RC receiver binding; optional telemetry radio. Include clear wiring diagrams/pinouts (ASCII or generated diagrams) for each connection.

### 8.3 `docs/flashing.md` — Firmware & software
- Flash **ArduPilot/ArduCopter** to the FC; configure: enable `GUIDED`, set the companion serial port + baud, configure **RC override** so the pilot always wins, **battery / link-loss / GCS-heartbeat failsafes**, and a **geofence**. List the exact parameters to set.
- Flash **JetPack** to the Jetson; install Docker; deploy the companion container + `systemd` autostart; export the TensorRT engine on-device.

### 8.4 `docs/network.md` — Connectivity
WiFi link setup (Jetson as AP or both on one network), static IPs, the control port (8765) and video port (8554), firewall notes, and how to point the ground station's Settings at the drone.

### 8.5 `docs/runbook.md` — Commissioning & first flight
A staged checklist: validate everything in **SITL first**; bench-test detection/FPS; props-off arm test; tethered low hover; first open-area follow at conservative standoff/speed; then normal ops. Include pre-flight checklist, emergency procedures (instant disarm/kill, RTL), and post-flight log review.

### 8.6 `docs/operator-manual.md`
How to actually use the control center day-to-day, including the meaning of every indicator and the safety interlocks.

## 9. Default tuning & limits (start conservative)
Ship safe defaults in `companion/config`: standoff distance default ~5 m (min enforced ~3 m), max speed default ~2 m/s (hard cap configurable but modest), max altitude cap, gentle PID gains, target-lost hold timeout, and a low-battery action. Document how to tune them and expose them through the UI's tuning panels.

## 10. Build/run order (document this in the README)
1. `scripts/setup-sim.sh` then `scripts/run-sim-e2e` → prove the full loop in SITL.
2. `scripts/setup-ground.ps1` → run the control center against SITL.
3. (Hardware) follow `docs/` to build the drone, flash, and provision the Jetson.
4. Point the control center at the real drone and run the `runbook.md` commissioning sequence.

## 11. Safety engineering requirements (mandatory)
- **Standoff is a hard limit:** guidance must never command motion that closes inside the configured standoff distance. The system approaches and holds; it does not contact the subject.
- Conservative default speed and altitude caps; all guidance outputs clamped.
- **RC override always wins** — configure the FC so a human pilot can instantly retake control.
- Geofence enforced; arming preconditions checked.
- **Layered failsafes:** low battery, RC loss, and ground-link/GCS-heartbeat loss each trigger a safe action (hold → RTL → land). Ground-link loss while tracking must stop guidance immediately.
- **Instant stop:** `emergencyStop`/disarm must take effect immediately with no confirmation gate on *stopping*.
- **Manual control safety:** only permitted when armed and airborne; engaging it releases any active tracking (single active control source); all manual axes clamped to the same limits as guidance; an input watchdog zeroes the setpoint and holds if stick frames or the link stop; release is instant and reverts to auto-hold; `emergencyStop`/disarm and physical RC override both supersede it.
- Default everything to the safe state on startup and on any error.

## 12. Out of scope / explicit non-goals
- **No weaponization of any kind.** This is a tracking/follow system that maintains a standoff distance; it must not be built to carry, release, or deliver any payload, to collide with or strike a person or object, or to cause harm. Do not add such capabilities.
- No beyond-visual-line-of-sight operation beyond what local regulations permit.
- No cloud dependency for flight; the system must operate fully on the local link.

## 13. Deliverables & acceptance criteria
- The full monorepo (Section 4), all versions pinned, one-command setup per environment.
- **Primary gate:** `run-sim-e2e` passes — arm, takeoff, engage tracking, approach a simulated person, hold at standoff **without breaching it**, disengage, RTL/land — with **zero hardware**.
- **Manual-piloting test passes** in SITL: take manual control (tracking auto-releases, `controlSource`=`manual`), sticks drive attitude/heading/altitude/position within clamped limits, the input watchdog holds on input/link loss, release reverts to auto-hold, and `emergencyStop` overrides manual instantly.
- The control center builds to a **Windows installer** and runs against SITL identically to live.
- The companion builds via Docker and autostarts on the Jetson.
- Complete `docs/` (BOM, assembly, flashing, network, runbook, operator manual).
- README with the "zero to flying in SITL" quickstart and the build/run order.
- Every safety requirement in Section 11 implemented and verifiable in SITL.
