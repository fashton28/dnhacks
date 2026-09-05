# Eye in the Sky — Simulator (SITL) & Acceptance Tests

This directory is the **primary acceptance gate** (PRD §6.3, §13). It runs the
complete tracking + guidance + manual-piloting loop against **ArduCopter SITL**
with **zero hardware**, driving everything through the shared WebSocket contract
exactly as the real ground station does.

```
sim/
├── run_sitl.sh           # launch ArduCopter SITL → MAVLink udp:127.0.0.1:14550
├── params/eis-sitl.parm  # SITL params (GUIDED, geofence, failsafes, EKF3)
├── headless_client.py    # async WS client speaking the contract (ground stand-in)
├── e2e_test.py           # ACCEPTANCE: arm→takeoff→track→hold@standoff→land
├── manual_test.py        # manual-piloting safety: take/release, watchdog, e-stop
└── README.md             # this file
```

Everything in `e2e_test.py` / `manual_test.py` talks **only** the WebSocket
contract (`shared/shared.py`, `ground/ui/src/contract/index.ts`). They never
import companion internals, so they verify the real seam.

---

## How to run (three terminals)

> Requires the one-time ArduPilot install — see the header of `run_sitl.sh`. On
> Windows, run SITL inside **WSL2** (Ubuntu); the companion + tests can run on
> the Windows side because WSL2 forwards `localhost`.

**Terminal 1 — SITL** (MAVLink out on `udp:127.0.0.1:14550`):

```bash
./sim/run_sitl.sh
```

**Terminal 2 — the companion**, configured for SITL + the synthetic target.
`config/sitl.yaml` selects `camera: sim`, so `SimTargetSource` drives a
synthetic moving person into the guidance stack (no camera needed):

```bash
EIS_CONFIG=companion/config/sitl.yaml python -m eis_companion.app
```

**Terminal 3 — the acceptance tests:**

```bash
python sim/e2e_test.py        # the primary acceptance gate
python sim/manual_test.py     # manual-piloting safety behaviours
```

Both also run under pytest:

```bash
pytest sim/e2e_test.py sim/manual_test.py -v
```

The tests need the `websockets` Python package (the packaging agent pins it).
They connect to `ws://127.0.0.1:8765` by default; override with `EIS_WS_URL`.

---

## What `e2e_test.py` proves (PRD §13 primary gate)

1. **connect → arm → takeoff(alt) → wait airborne**
2. **`setStandoff` + `setMaxSpeed` + `engageTracking`** — and `controlSource`
   becomes `tracking` (exactly one active control source); tracking **locks**
   onto the synthetic person.
3. **Yaws toward the target** — the locked bbox horizontal error shrinks toward
   image centre and/or the heading slews while the target is off-centre.
4. **Approaches then HOLDS at standoff, never breaching it** — `estimatedDistance`
   converges to the configured standoff and then stays
   `>= standoff − ε` for a sustained hold window (the **hard** standoff limit).
5. **Groundspeed within `maxSpeed`** (+ a small margin for FC overshoot).
6. **`disengageTracking` → `controlSource` back to `auto` → `rtl`/`land`.**

Failures print readable messages naming the exact violated invariant (e.g.
`STANDOFF BREACH during hold: estimatedDistance=4.21 m < standoff 5.0 m - eps`).

Tunables (env): `EIS_STANDOFF`, `EIS_MAXSPEED`, `EIS_TAKEOFF_ALT`,
`EIS_CONVERGE_S`, `EIS_WS_URL`.

---

## What `manual_test.py` proves (PRD §6.1, §11, §13)

1. **`engageManual` is rejected when not armed + airborne** (negative check up
   front, on the ground).
2. **arm → takeoff → `engageTracking`**, then **`engageManual`** →
   **tracking auto-releases** and **`controlSource == 'manual'`**.
3. **Streamed `manualInput` drives the vehicle** — attitude/heading/relAlt/
   position all respond — **and every axis stays within the clamped limits**
   (horizontal speed ≤ `maxSpeed`, climb ≤ `maxClimbRate`, yaw ≤ `maxYawRate`).
4. **Watchdog** — stop sending `manualInput`; within a few watchdog periods the
   setpoint is **zeroed and the vehicle holds** (it never coasts on the last
   commanded velocity).
5. **`disengageManual` → auto-hold + `controlSource == 'auto'`.**
6. **`emergencyStop` overrides manual instantly** — even while sticks are still
   streaming, `controlSource` leaves `manual` and the vehicle enters a safe stop
   (LAND/BRAKE/RTL or disarm), with no confirmation gate.

Tunables (env): `EIS_TAKEOFF_ALT`, `EIS_MAX_SPEED`, `EIS_MAX_CLIMB`,
`EIS_MAX_YAW`, `EIS_WATCHDOG_MS`, `EIS_WS_URL`. Set these to match the limits in
`companion/config/sitl.yaml` if you change them there.

---

## Smoke-testing the client alone

`headless_client.py` is runnable on its own to confirm the companion is up and
streaming before running the full tests:

```bash
python sim/headless_client.py ws://127.0.0.1:8765
# prints telemetry/tracking frame counts + a one-line state dump
```

---

## The mock-target path is the required, reliable one

Per PRD §6.3, the **mock target** (`camera: sim` → `SimTargetSource`) is the
**required** path: it is deterministic, needs no camera or model, and makes the
acceptance tests reproducible. Use it for CI and for the acceptance gate.

### Optional: Gazebo / photorealistic path (bonus, not required)

You can instead exercise guidance against a photorealistic sim with a real
person model and a virtual camera:

- Launch ArduCopter SITL with the Gazebo plugin
  (`ardupilot_gazebo`), spawn a `person`/`actor` model that walks a path, and
  point the companion's capture at the Gazebo virtual camera (GStreamer/V4L2
  loopback) instead of `camera: sim`.
- The detector then runs on rendered frames, closing the full perception loop.
- This is heavier, GPU-dependent, and less deterministic, so it is a **bonus**
  demonstration only — the mock-target path above is the gate that must pass.

---

## Optional: Node harness using the real `LiveDataProvider`

For an end-to-end check through the **actual** ground-side TypeScript
`DataSource`, you can drive the same sequence from Node using
`ground/ui/src/dataSource/LiveDataProvider.ts` instead of `headless_client.py`.
This proves the TS client and the Python client agree on the wire format.

Sketch (run from `ground/ui`, with SITL + companion already up):

```ts
// sim-harness.ts  (compile with the UI's tsconfig, or ts-node)
import { LiveDataProvider } from '@/dataSource/LiveDataProvider';

const ds = new LiveDataProvider();
await ds.connect({ host: 'sitl', controlPort: 8765, videoUrl: '', sitl: true });
ds.onTelemetry((t) => { /* assert armed/airborne/controlSource */ });
ds.onTracking((tr) => { /* assert estimatedDistance >= standoff once converged */ });

await ds.sendCommand({ type: 'command', command: 'arm' });
await ds.sendCommand({ type: 'command', command: 'takeoff', params: { altitude: 10 } });
await ds.sendCommand({ type: 'command', command: 'setStandoff', params: { meters: 5 } });
await ds.sendCommand({ type: 'command', command: 'engageTracking' });
// ...stream manual sticks via ds.setManualInput({throttle,yaw,pitch,roll})...
```

Because both clients implement the identical contract, the Python tests are the
canonical gate and the Node harness is an optional cross-check.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `Could not connect to companion at ws://…` | Companion (terminal 2) not running, or wrong `EIS_WS_URL`. |
| `arm rejected` / won't arm | SITL still acquiring GPS/EKF. Wait, or temporarily set `ARMING_CHECK 0` in `params/eis-sitl.parm` during bring-up only. |
| `Could not find sim_vehicle.py OR an arducopter SITL binary` | Finish the one-time ArduPilot install in `run_sitl.sh`'s header; put `Tools/autotest` on `PATH` or set `EIS_SITL_BIN`. |
| `tracking locked` never satisfied | Confirm the companion launched with `camera: sim` so `SimTargetSource` feeds detections. |
| `STANDOFF BREACH …` | A real guidance failure — the vehicle closed inside standoff. This is the safety gate doing its job; fix guidance, don't loosen the test. |
| `WATCHDOG FAILURE …` | Manual setpoint kept applying after input stopped — fix the companion's manual watchdog. |
