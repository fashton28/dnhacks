# Eye in the Sky — Companion (Jetson)

The **vehicle-side** software for the autonomous person-following drone. It runs
on an NVIDIA Jetson Orin Nano and turns a camera + an ArduPilot flight
controller into a follow-me system:

```
camera ─► detect(person) ─► track(single lock) ─► visual-servoing guidance
        └─────────────────────────────────────────────► MAVLink GUIDED setpoints ─► FC
        + MAVLink/telemetry bridge + low-latency video + control WebSocket API ──► ground UI
```

The flight controller does all stabilization; the companion only sends clamped,
high-level **body-frame velocity setpoints**. **Safety is non-negotiable** (see
[Safety](#safety)): standoff is a hard limit, every output is clamped, the
manual and ground-link watchdogs zero-and-hold on loss, and `emergencyStop` /
`disarm` override everything. The whole stack is **SITL-first** — it runs end to
end in simulation with zero hardware and no camera.

---

## Package layout (`eis_companion`)

| Module | What it owns |
| --- | --- |
| `types` | in-process dataclasses: `VehicleState`, `VelocitySetpoint`, `Limits`, `TargetObservation` |
| `config` | layered YAML + `.env` + `EIS_*` env → typed `AppConfig` (incl. `Limits`, camera, ports, gains, FC link, safety) |
| `control/` | pure-logic core: `pid`, `distance`, `tracker`, `guidance`, `manual` (numpy + stdlib only) |
| `mavlink/` | `Vehicle` (pymavlink FC link) + `SafetyManager` (pure-logic deadman / arming / e-stop / geofence) |
| `vision/` | `Capture`, `PersonDetector`, `SimTargetSource`, TensorRT export |
| `api/` | `ApiServer` — the control WebSocket implementing the shared contract |
| `stream/` | `VideoStream` — mediamtx + GStreamer (RTSP `8554` + WebRTC/WHEP `8889`) |
| `app` | the asyncio **orchestrator** + CLI entry (`python -m eis_companion.app`) |

The control / mavlink / vision packages are pure-logic where it matters and
unit-test with **no hardware** (the orchestrator imports them by their public
module paths).

### How the orchestrator runs

`app.py` builds every component and runs four asyncio tasks:

1. **Telemetry pump @10 Hz** — read the FC state, stamp the authoritative
   `controlSource`, push `telemetry`.
2. **Perception + tracking @~10 Hz** — frames → detect → tracker → push
   `tracking` (normalised bboxes, lock state, estimated distance).
3. **Control loop @10–20 Hz** — pick the **one** active control source and emit a
   clamped body-velocity setpoint:
   - manual engaged → `ManualPilot` setpoint (watchdog-gated);
   - tracking engaged **and** armed **and** `GUIDED` → `Guidance` setpoint;
   - otherwise → hold (zero, `valid=False`);
   then hard-clamp to `Limits` and `Vehicle.send_body_velocity`.
4. **Command dispatch** — event-driven from the WebSocket (see below).

Exactly one `controlSource` (`auto` | `tracking` | `manual`) is ever active and
it is reported in every `telemetry` frame.

---

## Run it in SITL on a dev box

No drone, no camera, no GPU. Requires ArduPilot SITL reachable on
`udp:127.0.0.1:14550` (launched by `sim/`), and a Python ≥ 3.10 environment.

```bash
cd companion
pip install -e .[dev]                 # core + pytest (pinned)
EIS_CONFIG=config/sitl.yaml python -m eis_companion.app
```

`config/sitl.yaml` selects the **UDP** FC link and the synthetic `sim` camera
source (`SimTargetSource` feeds the tracking/guidance loop), and advertises an
empty video URL so the ground UI renders its mock canvas. The control WebSocket
comes up on `ws://0.0.0.0:8765`.

Point the ground control center's Settings at `host=sitl` (or `127.0.0.1`),
control port `8765`, and you have the full loop: arm → takeoff → engage tracking
→ the vehicle yaws toward and approaches the simulated person and **holds at
standoff** → disengage → RTL/land. The manual-control flow (`engageManual` →
sticks → watchdog hold → `disengageManual`, `emergencyStop` override) works the
same way against SITL.

For **real person detection** on a dev box (optional), add the heavy extra:

```bash
pip install -e .[detect]              # + opencv + ultralytics (YOLO11n)
```

> **Jetson / JetPack:** do **not** `pip install torch/torchvision/TensorRT` on
> the Orin Nano — they are JetPack-provided (a pip wheel is the wrong, non-CUDA
> build). The Docker image installs `ultralytics` with `--no-deps` so the
> system GPU stack satisfies it. See `pyproject.toml` `[jetson]`.

---

## Run it on the Jetson (Docker + systemd)

The container uses an L4T/JetPack-6 PyTorch base (CUDA + TensorRT + torch
prebuilt for the Orin's GPU) and bundles `mediamtx` + GStreamer for video.

```bash
# build on the Jetson (or buildx for linux/arm64)
docker build -t eis-companion:latest companion/

# one-shot run (host net for MAVLink UDP + WS + RTSP/WebRTC; FC on /dev/ttyTHS1)
docker run --rm -it --runtime nvidia --network host \
    --device /dev/ttyTHS1 \
    -v /opt/eis/weights:/app/weights \
    -e EIS_CONFIG=config/default.yaml \
    eis-companion:latest
```

Autostart on boot with the bundled unit (it always boots into the **safe held
state** and only moves on an explicit command):

```bash
sudo cp companion/systemd/eis-companion.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now eis-companion.service
journalctl -u eis-companion -f
```

`config/default.yaml` is the real-hardware profile: **serial** FC link on
`/dev/ttyTHS1`, the CSI camera, and the same conservative limits as SITL.

---

## Configuration

Three layers, later overrides earlier, with the **safe defaults as the floor**:

1. hard-coded conservative defaults (mirror shared `DEFAULTS` / PRD §9),
2. a YAML file — `EIS_CONFIG` or `config/default.yaml`,
3. `EIS_*` environment overrides (a nearby `.env` is loaded first).

After loading, the **hard safety envelope is re-asserted**: standoff can never go
below the 3 m floor, `max_speed` never above the 8 m/s cap, and the speed band /
watchdogs are kept sane — no YAML or env value can relax a safety limit. See
[`.env.example`](../.env.example) for every `EIS_*` key and `config/*.yaml` for
the full schema (`limits`, `guidance.gains.{yaw,altitude,forward}.{kp,ki,kd}`,
`camera`, `detector`, `tracking`, `network`, `fc`, `safety`).

---

## The control WebSocket contract (for the ground backend)

Default port **8765**, JSON. The companion **pushes** `telemetry` (~10 Hz),
`tracking` (~10 Hz), `statusText`, and `ack`. The ground **sends** `command`
(acked) and `manualInput` (high-rate, **fire-and-forget — never acked**).

Commands (`{ "type":"command", "command":..., "params":{...} }`): `arm`,
`disarm`, `takeoff` (`params.altitude`), `land`, `rtl`, `setMode`
(`params.mode`), `engageTracking`, `disengageTracking`, `selectTarget`
(`params.targetId`), `setStandoff` (`params.meters`), `setMaxSpeed`
(`params.mps`), `engageManual`, `disengageManual`, `emergencyStop`. Each yields
a `{ "type":"ack", command, success, message }`.

`engageManual` ≡ CODE_PRD `takeManualControl`, `disengageManual` ≡
`releaseManualControl` (both acked); high-rate sticks are the `manualInput`
message (never acked).

### Manual-control message shape (high-rate, fire-and-forget)

```json
{
  "type": "manualInput",
  "ts": 1718000000000,
  "throttle": 0.0,   // climb(+)/descend(-)   -1..1
  "yaw":      0.0,    // yaw rate (right +)    -1..1
  "pitch":    0.0,    // forward(+)/back(-)    -1..1
  "roll":     0.0     // right(+)/left(-)      -1..1
}
```

Send these at ~20–50 Hz while manual control is engaged. Each axis is bipolar
`-1..1`; the companion applies a deadzone, maps to a **clamped** body-velocity
setpoint (same limits as guidance), and **zeroes + holds** if no frame arrives
within `manual_watchdog_ms` (default 500 ms) or the ground link drops. Engaging
manual requires the vehicle **armed + airborne** and immediately releases
tracking; releasing reverts to auto-hold. `emergencyStop` / `disarm` always win.

---

## Safety

Implemented and verifiable in SITL (PRD §11):

- **Standoff is a hard limit** — guidance never commands forward motion that
  closes inside the configured standoff (enforced in `control.guidance`, and the
  orchestrator never overrides it).
- **Every output clamped** to `Limits` (speed / climb / yaw / altitude) — once in
  each component and again in the orchestrator before it reaches the FC.
- **Single active control source** — `auto` | `tracking` | `manual`, mutually
  exclusive, reported in `telemetry.controlSource`.
- **Watchdogs** — the manual-input watchdog and the ground-link **deadman** both
  zero the setpoint and hold (the deadman escalates to RTL while airborne).
- **Emergency stop / disarm** — no confirmation, override everything: release all
  control sources, zero setpoints, LAND (airborne) / disarm (on ground).
- **Arming preconditions** checked before arm; **RC override always wins** (the
  companion only ever sends GUIDED setpoints, never an RC override).
- **Safe by default** — the companion boots into a held state and defaults to
  hold on any exception.

---

## Testing

```bash
pip install -e .[dev]
pytest                  # pure-logic + config + API unit tests (no hardware)
```

The primary acceptance gate is the headless SITL end-to-end test in `sim/`
(arm → takeoff → track → approach → hold at standoff without breaching → release
→ RTL/land) plus the manual-piloting test.
