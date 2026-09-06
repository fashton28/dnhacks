# Drone Safety Platform — Commissioning & First-Flight Runbook

> **Read this entire document before touching the drone.**
> Every step must be completed in order. Do not skip stages.
> Always carry out SITL validation first — never fly hardware before the simulation passes.
>
> Cross-references: [hardware.md](hardware.md), [assembly.md](assembly.md),
> [flashing.md](flashing.md), [network.md](network.md), [operator-manual.md](operator-manual.md).

---

## Emergency Reference Card (Read First)

Keep these procedures memorised before any flight:

| Emergency | Action |
|-----------|--------|
| **Drone behaving unexpectedly** | Flip RC mode switch to STABILIZE, take manual control |
| **Drone approaching you / person** | SPACEBAR on ground PC or DISARM button immediately |
| **Loss of RC link** | ArduPilot triggers RC failsafe (Land) automatically |
| **Loss of WiFi / ground app** | ArduPilot triggers GCS failsafe (RTL) after 5 s |
| **Low battery warning** | Land immediately; do not wait for RTL |
| **Critical battery** | Drone lands automatically (BATT_FS_CRT_ACT = Land) |
| **Runaway / out of control** | DISARM via RC switch (STABILIZE + throttle zero) |
| **Fire / smoke from battery** | Disconnect immediately; use LiPo safe bag; do not inhale fumes |

---

## Stage 0: Prerequisites Checklist

Before attempting any of the stages below, verify:

- [ ] All hardware assembled per [assembly.md](assembly.md)
- [ ] ArduCopter flashed, all parameters set per [flashing.md](flashing.md)
- [ ] Props NOT installed (will be installed only for Stage 4)
- [ ] Jetson powered, companion container running, ttyTHS1 active
- [ ] Ground control center built and running (SITL mode first)
- [ ] LiPo batteries charged and cell-balanced (use cell checker; all cells 3.8–4.2 V)
- [ ] Flying area identified: open, flat, clear of people and obstacles, ≥60 m radius
- [ ] You have read and understood the emergency procedures above
- [ ] Weather: wind < 5 m/s, no rain, good visibility

---

## Stage 0.5: Bring-up caveats (read before an offline or unfamiliar venue)

These are the things that have actually stopped a bring-up. Each names the
failure mode it comes from in [FAILURE_MODES.md](FAILURE_MODES.md).

### Build the artefacts the ground station loads at RUNTIME (FM-83, FM-132)

`ground/planner/dist/` and `ground/app/<os>/dist-electron/` are **gitignored**.
A fresh clone has neither, and the Electron shell loads both by path:
`package.json`'s `main` is `dist-electron/main.js`, and the main process
`require`s `ground/planner/dist/index.js` on the first plan.

`scripts/setup-ground.ps1` (Windows) and `scripts/setup-ground-linux.sh` build
them, in load order, and then assert that all four artefacts exist. `make
build-ground` / `make build-ground-linux` do the same. **Re-run one of them
after any edit to `ground/planner` or the shell's TypeScript** — the shell
loads the built copy, so an unbuilt edit silently runs the previous build.

Symptoms if you skip it:
- `Cannot find module .../dist-electron/main.js`, Electron exits immediately.
- A "Planning failed" toast the moment the inspection button is pressed. (The
  main process now names the missing artefact and the command that builds it.)

### Free the UI port, or move it (FM-131)

`ground/ui` binds port **5173 strictly**: if the port is taken, Vite refuses to
start rather than sliding to 5174 and leaving the Electron shell rendering
whatever else answered 5173 (a teammate's Console dev server pins the same
port). Two stacks on one machine: set `EIS_UI_PORT` — the UI and the shell read
the same variable — e.g. `EIS_UI_PORT=5273 npm run dev`.

### The acceptance gate runs on Windows PowerShell 5.1 (FM-142)

`scripts/run-sim-e2e.ps1` is 5.1-compatible; it does not need PowerShell 7. If
you edit it, keep it free of 7-only syntax (`??`, `?.`, `?:`, `&&`/`||`
chains) — a parse error there means the acceptance gate cannot run at all, and
it happens before any `#Requires` directive would be honoured.

### The acceptance gate and the demo path are not the same run (FM-157)

`scripts/run-sim-e2e.sh` starts SITL natively via `sim/run_sitl.sh` over
`udp:14550` with `sim/eis-sitl.parm`. A Docker-backed demo launcher takes
`tcp:5760` with its own bootstrap parameters and a vicon serial. Transport,
EKF source configuration and parameter provenance all differ, so **a green e2e
gate is not evidence that the demo path works, and vice versa.** Run whichever
one you are about to show, and run it on the machine you are about to show it
on.

### Verify the SITL parameter bootstrap on the backend you are actually using (FM-135)

The battery, GPS-failover and external-navigation demos need
`BATT_MONITOR`, `SIM_BATT_*`, `VISO_TYPE`/`SERIAL5_PROTOCOL`, `EK3_SRC2/3_*`,
`SIM_VICON_*` and `SIM_GPS1_ENABLE`. A launcher that sets these only on its
Docker branch leaves the WSL/native branch with **no simulated backing** for
those demos while still printing "preflight OK". Before demonstrating any of
them, read the parameters back from the running SITL (MAVProxy `param show
BATT_MONITOR`, `param show SIM_GPS1_ENABLE`) rather than trusting the
launcher's own message.

### Console 3D assets are fetched from the internet (FM-171)

**This is the teammates' `console/` stack, not `platform/ground/`, and nothing
in this repository's ground station depends on it.** It is recorded here
because it fires at exactly the venue where nobody can fix it.

`console/public/assets/` is gitignored and populated at setup time by
`scripts/fetch_assets.py` from a remote CDN. On a fresh clone at an **offline
venue** the Three.js console renders with no ground texture, no sky and no
models — bare, or throwing. There is no offline bundle and no fallback
material, and no preflight check verifies the assets are present.

Mitigation, in order of preference:
1. **Fetch the assets before you lose connectivity** (`python
   scripts/fetch_assets.py`), and verify `console/public/assets/` is non-empty
   on the machine you will present from — not on the machine you built on.
2. Copy a populated `console/public/assets/` directory onto the demo machine by
   hand (USB stick); the path is all that matters.
3. **Present the 2D mission map instead.** The ground station's own map,
   satellite panel and cue rails are fully offline: the tiles are baked into
   the renderer bundle and the cue rails replay bundled fixtures. The ARGUS
   World view is an `<iframe>` onto the console and is the only view affected.

---

## Stage 1: SITL Validation (Required Before Any Hardware Flight)

**Goal:** Prove the entire software stack works end-to-end with zero hardware.

### 1.1 Launch SITL

On the ground PC (Windows, with WSL2 or Ubuntu VM):

```bash
# Install ArduPilot SITL (if not done)
bash scripts/setup-sim.sh

# Launch SITL + companion + mock target
make sim
# or:
bash scripts/run-sim-e2e.sh
```

Expected output:
- ArduCopter SITL starts at lat=37.7699, lon=-122.4666 (default)
- Companion container starts, connects to SITL via UDP
- WebSocket server listening on 8765
- RTSP mock stream on 8554

### 1.2 Connect Ground App to SITL

1. Open the Drone Safety Platform ground control center.
2. Go to **Settings** → set Host to `localhost`, port `8765`, SITL toggle **ON**.
3. Verify status bar shows "Connected" (green).
4. Verify mode shows "LOITER" or "STABILIZE".
5. Verify battery reads a simulated value (~16 V).

### 1.3 Run the Automated End-to-End Test

```bash
make e2e
# or:
bash scripts/run-sim-e2e.sh
# Windows (Windows PowerShell 5.1 or PowerShell 7; needs WSL2 for SITL):
#   .\scripts\run-sim-e2e.ps1
```

This test:
1. Arms the simulated drone
2. Commands takeoff to 4 m
3. Engages person tracking (mock target walking)
4. Asserts drone yaws toward and approaches the target
5. Asserts drone holds at configured standoff distance (5 m) **without breaching it**
6. Disengages tracking
7. Commands RTL and verifies landing

**The test MUST PASS before proceeding.** If it fails, do not fly hardware. Debug the
companion software per the SITL logs.

### 1.4 Manual Piloting SITL Test

```bash
make e2e-manual
# or:
python sim/test_manual_control.py
```

This test:
1. Arms + takeoff
2. Engages tracking, then sends `engageManual` — asserts tracking auto-releases,
   `controlSource` becomes `"manual"`
3. Streams synthetic stick inputs — asserts position/heading respond within clamped limits
4. Stops stick input — asserts watchdog zeroes setpoint within 500 ms (hold position)
5. Sends `disengageManual` — asserts `controlSource` returns `"auto"` and drone holds
6. Sends `emergencyStop` — asserts tracking and manual are immediately released

**All assertions must pass.** This validates the safety architecture.

### 1.5 SITL Checklist Sign-Off

- [ ] e2e test passed: arm, takeoff, engage, approach, hold at standoff, disengage, RTL/land
- [ ] Manual piloting test passed: all 6 sub-assertions
- [ ] Standoff not breached at any point in simulation
- [ ] Emergency stop overrides manual instantly in simulation
- [ ] Ground app behaves identically to live in SITL mode

---

## Stage 2: Hardware Bench Tests (Props Off)

**Goal:** Verify hardware connections before any motors spin with props.

### 2.1 First Power-On (No Props, No LiPo)

1. Connect FC to PC via USB. Open Mission Planner.
2. Verify connection: telemetry appears in Mission Planner flight data.
3. Check for any pre-arm warnings. Common first-run warnings:
   - "GPS not healthy" → normal until outdoors with sky view
   - "Compass not calibrated" → redo compass cal if needed
   - "Barometer not healthy" → check FC is not in a sealed box
   - "RC not calibrated" → redo RC calibration

### 2.2 FC + Jetson UART Communication

1. Power the Jetson (via bench power supply or LiPo + BEC, no motors yet).
2. Start the companion container.
3. In Mission Planner → **COMM LINKS** → check if MAVLink is flowing from both FC and companion.
4. In the ground app (SITL OFF) → Settings → enter Jetson IP → verify "Connected".
5. Check telemetry values in the ground app match Mission Planner.

### 2.3 Camera & Video

1. In the ground app, check the video panel shows the live camera feed.
2. Walk in front of the camera — verify person detection boxes appear in the video overlay.
3. Check tracking status in the left panel: should show "searching" (looking for targets).
4. Click on a detected person in the video panel — verify `selectTarget` command fires
   and tracking status shows "locked".

### 2.4 RC Transmitter Check

1. Power on RC transmitter.
2. Verify all channels move in Mission Planner's Radio Calibration page.
3. Verify mode switch changes modes: pos 0 = LOITER, pos 1 = GUIDED, pos 2 = STABILIZE.
4. Verify throttle-down disarms (if you set it up that way) or use RC arming switch.

### 2.5 Motor Direction Test (Still No Props)

In Mission Planner → **SETUP → Optional Hardware → Motor Test**:
- Test Motor A (M1, front-right) → should be CW (viewed from above). Verify by looking.
- Test Motor B (M2, back-right) → CCW.
- Test Motor C (M3, back-left) → CCW.
- Test Motor D (M4, front-left) → CW.

If any motor spins wrong direction, fix it now (see [assembly.md](assembly.md) §5.2).

### 2.6 Battery Voltage Calibration

1. Connect LiPo (no props). Read voltage in Mission Planner.
2. Measure actual battery voltage with a multimeter.
3. Adjust `BATT_VOLT_MULT` until Mission Planner reads within 0.1 V of the multimeter.

---

## Stage 3: Props-Off Armed Test

**Goal:** Verify arming, FC response, and companion link with motors armed but no props.

> **WARNING:** Armed motors CAN spin unexpectedly. Keep all hands and objects away from
> motor shafts. Work alone or have a helper hold the drone firmly.

### 3.1 Pre-Arm Checklist (In Ground App)

Click **Arm** in the ground app. The pre-flight checklist modal will appear.
Work through each item:

- [ ] GPS 3D fix acquired (≥12 sats) — must be outdoors or have clear sky view
- [ ] Battery ≥90% & secured
- [ ] Props clear of obstructions
- [ ] RC transmitter bound & armed
- [ ] Geofence configured (60 m default)
- [ ] Camera & companion link healthy

If any item is false, fix it. All items must be checked before Arm is enabled.

### 3.2 Arm and Verify

1. Complete checklist → click "Confirm & Enable Arm".
2. Drone arms (status bar shows "Armed" in red, motors at idle spin).
3. Verify motors spin at idle speed (very slow — this is `MOT_SPIN_ARM`).
4. Move RC sticks slightly — verify attitude changes are reflected in ground app.
5. Verify DISARM button (Space key) immediately disarms. Do this several times.

### 3.3 Emergency Stop Test

1. Arm again.
2. Press Space bar → verify instant disarm.
3. Click DISARM button → verify instant disarm.
4. Repeat 3× to confirm reliability.

---

## Stage 4: Tethered Low Hover Test

**Goal:** First prop-on flight in a tethered / controlled environment.

> **Install props only now. Double-check CW/CCW orientation for each motor.**
> Never install props until Stage 4. Props can cause serious injury.

### 4.1 Prop Installation

- Motors 1 and 4 (CW spin): install CW (right-hand thread) props — screw on counter-clockwise.
- Motors 2 and 3 (CCW spin): install CCW (left-hand thread) props — screw on clockwise.

**Self-tightening safety:** both prop types tighten under thrust. Verify each prop is
firmly seated before flight.

### 4.2 Environment

- Open area, 5× 5 m minimum, away from people.
- No wind, or light wind only.
- Have a second person available as safety observer (optional but recommended).
- Carry the RC transmitter at all times.

### 4.3 Tether Setup (Recommended for First Hover)

Attach a 2 m lightweight string (fishing line) to the drone's frame, held by an assistant.
The tether prevents runaway while still allowing free hovering. It is not required but
strongly recommended for a first hover test.

### 4.4 First Hover Procedure

1. Complete pre-flight checklist in ground app.
2. Arm via ground app or RC arming switch.
3. In Mission Planner / ground app: confirm mode is LOITER or GUIDED.
4. Command takeoff to **2 m** via the ground app Takeoff button (confirm alt = 2 m in dialog).
5. Drone should ascend to 2 m and hold.
6. Monitor in ground app: altitude, attitude, battery, GPS fix.
7. Let it hover for 30 seconds. Observe for:
   - Stable hover (minimal drift)
   - No unusual vibration noises
   - No smoke or heat
8. Command Land via ground app.
9. After landing, disarm.

**If the drone drifts aggressively or wobbles:**
- Land immediately via RTL or manual RC control.
- Check compass calibration, GPS fix quality, and vibration isolation of FC.
- Do not proceed to Stage 5 until hover is stable.

---

## Stage 5: First Person-Following Test (Open Area, Conservative Settings)

**Goal:** Validate the full autonomous tracking loop at safe, conservative settings.

### 5.1 Environment Requirements

- Open field: minimum 60 m × 60 m, clear of obstacles, away from spectators.
- Only the test subject and the operator (and optionally one safety observer).
- Weather: wind < 3 m/s, no rain, good visibility.
- Battery: freshly charged (≥ 90%).

### 5.2 Conservative Settings (First Flight)

Before this test, set in the ground app:
- **Standoff distance: 7 m** (more conservative than default 5 m)
- **Max speed: 1 m/s** (half the default)
- **Geofence: 30 m radius** (smaller than default for first flight)

### 5.3 Test Procedure

1. Complete pre-flight checklist.
2. Arm → Takeoff to **3 m** (enter 3 in the Takeoff dialog).
3. The operator (holding RC transmitter) stands 10 m from the drone.
4. The test subject stands in front of the camera at 10 m.
5. In the video panel, click the test subject's bounding box to lock tracking.
   Verify status shows "locked".
6. Click **Engage Tracking** (hold to confirm) in the Controls Panel.
7. The drone should:
   - Yaw to face the subject
   - Approach until ~7 m from the subject, then hold
   - Track the subject as they walk slowly (< 1 m/s)
8. The operator and RC transmitter: keep thumb on the mode switch ready to flip to
   STABILIZE at any moment.
9. Observe for 60–90 seconds. The drone should maintain standoff.
10. Click **Disengage Tracking** in the ground app.
11. The drone should stop and hold position.
12. Click **RTL** or command Land.
13. After landing and full stop, disarm.

### 5.4 What to Check After First Flight

- Ground app log console: look for any `warning`, `error`, `critical` messages.
- Mission Planner Logs (FC dataflash): download and review in Mission Planner's log
  viewer. Check for EKF errors, vibration issues, GPS quality.
- Battery: check cell voltages post-flight with cell checker. All cells should be > 3.5 V.

---

## Stage 6: Normal Operations

After successful Stage 5, you can:
- Increase standoff back to 5 m and speed to 2 m/s defaults.
- Increase geofence radius to 60 m for larger areas.
- Conduct longer flights as battery and area permits.
- Use manual control (see [operator-manual.md](operator-manual.md)).

---

## Pre-Flight Checklist (Standard, For Every Flight)

Copy this checklist and run it before every single flight.

### A. Ground Station

- [ ] Ground PC running, ground app open and "Connected" (green)
- [ ] SITL toggle is **OFF**
- [ ] Correct Jetson IP entered in Settings
- [ ] Video feed live (camera image visible)
- [ ] Standoff and max speed set to desired values
- [ ] Geofence configured for the flying area
- [ ] Battery failsafe thresholds correct (30% warn, 15% critical)

### B. Flight Controller

- [ ] GPS fix: 3D fix, ≥ 12 satellites, HDOP < 2.0 (shown in status bar)
- [ ] EKF status: no errors (check in Mission Planner or status bar)
- [ ] Mode: LOITER or GUIDED
- [ ] Arming checks: no pre-arm warnings except GPS (which clears when outdoors)

### C. Power

- [ ] Battery: ≥ 90% charge, cell voltages balanced (all cells 3.8–4.2 V)
- [ ] Battery connector: clicked firmly into drone XT60, nothing loose
- [ ] Battery secured with velcro strap, centred on drone CG

### D. Physical

- [ ] Props: all 4 installed correctly (CW/CCW), all screws tight (thread-locked)
- [ ] All motor screws tight (check by hand)
- [ ] Frame screws tight
- [ ] Camera ribbon cable secure, camera pointing forward and down 10–15°
- [ ] GPS mast upright and antenna facing sky
- [ ] Jetson cables secured (USB, UART — nothing dangling near props)
- [ ] No objects within 5 m of drone

### E. RC Transmitter

- [ ] TX powered on and bound (receiver LED solid)
- [ ] Mode switch at safe position (LOITER)
- [ ] Throttle at minimum
- [ ] All stick trim at center
- [ ] Battery level on TX: adequate

### F. Environment

- [ ] Flying area clear of unauthorised persons (minimum 30 m radius)
- [ ] Wind: < 5 m/s
- [ ] No rain or mist
- [ ] Not near airports, helipads, or restricted airspace

---

## Emergency Procedures (Detailed)

### E1: Immediate Disarm (Drone on Ground or Low Hover)

Option 1 (fastest, ground app): Press **SPACEBAR** anywhere in the ground app
(not in a text input field). This sends `emergencyStop` → `LAND`/`BRAKE` → disarm.

Option 2 (RC): Flip mode switch to STABILIZE, bring throttle to minimum.
Arming switch to disarm. This works even if the ground app is disconnected.

Option 3 (ground app): Click the red **DISARM** button (top-right of status bar).

### E2: Return to Launch (RTL)

Use when the drone has drifted or you need to recover it:
- Ground app: press **R key** (when drone is airborne) or click RTL in Controls Panel.
- RC: flip mode switch to RTL position (if you configured a switch for RTL).
- The drone will climb to `RTL_ALT` (20 m default), fly home, descend, and land.

### E3: RC Override (Instant Manual Control)

Move any RC stick noticeably → ArduPilot immediately gives RC priority.
The companion's GUIDED setpoints are paused. You have full manual control in
whatever mode the switch is set to (STABILIZE = easiest for emergency).

After you stop moving sticks, RC override remains active for `RC_OVERRIDE_TIME = 3 s`.

### E4: Ground App Manual Control Override

If tracking is engaged and behaving unexpectedly but the drone is still stable:
1. Press **D** (disengage tracking) immediately.
2. Drone holds position in GUIDED.
3. Either land via the ground app, or switch RC to STABILIZE for manual control.

### E5: Loss of WiFi Link

- Ground app will show "Disconnected" (red) after ~2 s.
- ArduPilot GCS failsafe triggers after 5 s → RTL (per `FS_GCS_ACTION = 2`).
- The companion stops sending GUIDED setpoints on ground-link loss (deadman = 2 s).
- If the drone does not RTL, use RC to manually fly and land.

### E6: Loss of RC Link

- ArduPilot RC failsafe triggers → Land (`FS_THR_ACTION = 4`).
- The drone lands where it is. This is why you need a clear landing zone at all times.

---

## Post-Flight Log Review

After every flight:

### 1. Ground App Log Console

Review the log console (bottom-right panel in ground app). Look for:
- `severity: "warning"` or above — investigate any warnings.
- Tracking state transitions: `searching → locked → lost` — if frequent "lost" events,
  investigate camera angle, lighting, or detection confidence threshold.
- Any `emergencyStop` or `failsafe` events — log the date/time and cause.

### 2. Download FC Dataflash Logs

In Mission Planner → **COMM LINKS** → connect → **DataFlash Logs → Download All**.
Open the `.BIN` log file in Mission Planner's Log Viewer.

Key things to check:
- **ATT (attitude):** Roll and pitch should be smooth. Spikes = vibration.
- **VIBE (vibration):** VibeX, VibeY, VibeZ should all be < 30 m/s² (ideally < 15).
  High vibration causes EKF errors and unstable flight.
- **GPS:** Track `NSats` (satellites) and `HAcc` (horizontal accuracy). `HAcc` < 1.5 m
  is good; > 3 m is concerning.
- **BAT:** Voltage should not dip below 14.0 V (3.5 V/cell) under load.
- **ERR:** Any error codes — cross-reference with ArduPilot error code documentation.

### 3. Battery Check

After every flight, check battery cells with a cell checker before recharging:
- All cells should be above 3.5 V (ideally > 3.6 V after resting 10 min).
- Cell imbalance > 0.1 V between cells indicates a cell problem — investigate.
- Do not store LiPo at full charge; store at 3.7–3.8 V/cell (storage voltage).

### 4. Physical Inspection

After every flight:
- Check all prop screws are tight.
- Check motor screws (vibration can loosen them).
- Inspect props for cracks, chips, or bends. Replace any damaged prop.
- Check frame screws.
- Check camera ribbon cable and connectors.

---

*For day-to-day UI operation, see [operator-manual.md](operator-manual.md).*
