# Eye in the Sky — Operator Manual

> This document describes day-to-day use of the Eye in the Sky ground control center.
> It covers every status indicator, panel, instrument, button, and safety interlock.
>
> Cross-references: [runbook.md](runbook.md) for commissioning & first-flight procedures,
> [network.md](network.md) for connection setup, [flashing.md](flashing.md) for firmware.

---

## 1. Application Layout

The ground control center uses a three-column layout when running full-screen:

```
┌──────────────────────────────────────────────────────────────────────┐
│  STATUS BAR (full width)                                              │
├──────────────┬──────────────────────────────────┬────────────────────┤
│              │                                   │                    │
│   LEFT       │     CENTER TOP: Video Panel       │   RIGHT            │
│   COLUMN     │                                   │   COLUMN           │
│              ├────────────────┬──────────────────┤   (Telemetry)      │
│  Controls    │  Map Panel     │  Log Console      │                    │
│  Panel       ├────────────────┴──────────────────┤                    │
│              │  (center bottom)                  │                    │
│  Manual      │                                   │                    │
│  Control     │                                   │                    │
└──────────────┴───────────────────────────────────┴────────────────────┘
```

Banners (Tracking and Manual) appear below the status bar when active.

---

## 2. Status Bar (Top of Screen)

The status bar is always visible and shows the most critical flight state at a glance.

### 2.1 Connection Status Pill

Located at the left of the status bar. Shows the WebSocket connection to the companion.

| Display | Colour | Meaning |
|---------|--------|---------|
| `Connected` (solid dot) | Green | WebSocket is connected; telemetry flowing |
| `Connecting` (pulsing dot) | Amber | Attempting to connect; waiting for response |
| `Disconnected` | Red | No connection; check network settings |
| `Error` | Red | Connection failed with error |

**If stuck at Connecting:** Verify the Jetson IP and control port in Settings.
See [network.md](network.md) §7.4 for troubleshooting.

### 2.2 Host / SITL Indicator

Immediately after the connection pill:
- Shows the hostname/IP of the connected companion (e.g., `192.168.4.1`).
- A `SITL` badge (amber) appears when Settings has SITL toggled ON.
- A `LIVE` badge (green) appears when SITL is OFF (real hardware).

> **Before any real flight:** verify this badge shows `LIVE`. Never fly with SITL ON
> while connected to real hardware.

### 2.3 Armed / Disarmed Pill

| Display | Colour | Meaning |
|---------|--------|---------|
| `Disarmed` | Grey (neutral) | FC is disarmed; motors will not spin |
| `Armed` | Red (solid, danger) | FC is armed; motors can spin at any time |

The armed state is authoritative from FC telemetry. If this shows "Armed" unexpectedly,
disarm immediately via the DISARM button or RC transmitter.

### 2.4 Flight Mode Label

Shows the current ArduPilot flight mode reported by the FC (e.g., `GUIDED`, `LOITER`,
`STABILIZE`, `RTL`, `LAND`). Displayed in accent colour.

Key modes for this system:

| Mode | Meaning |
|------|---------|
| `GUIDED` | Companion/ground station sends position/velocity setpoints. Required for tracking and manual control. |
| `LOITER` | FC holds position using GPS. No setpoints being sent. |
| `STABILIZE` | Manual stabilization via RC. No GPS hold. Pilot must fly it. |
| `RTL` | Return to Launch: climbs to 20 m, flies home, lands. |
| `LAND` | Landing vertically from current position. |
| `BRAKE` | Emergency horizontal stop (brakes using GPS). |
| `ALT_HOLD` | Manual throttle but holds altitude automatically. |
| `POSHOLD` | Like LOITER but more responsive to stick input. |

### 2.5 Flight Timer

Shows elapsed time since the FC was armed, in `MM:SS` format. Resets on disarm.
Use this to track total flight time and plan battery usage.

A typical 4S 2800 mAh pack gives **8–12 minutes** with the Jetson active.
Plan to land with at least 30% battery remaining.

### 2.6 Battery Gauge

A compact battery indicator showing:
- **Remaining percentage** (0–100%)
- **Current voltage** (in V)
- Colour-coded bar:
  - Green: > 30%
  - Amber: 20–30%
  - Red: < 20%

**Failsafe thresholds** (configurable in Failsafe Settings):
- **Warn at 30%:** audible alert + status text warning.
- **Critical at 15%:** automatic Land command executed.

> Do not rely solely on the percentage — watch the voltage. A fully charged 4S pack is
> 16.8 V; a safe minimum under-load is ~14.0 V (3.5 V/cell).

### 2.7 GPS Indicator

Shows:
- **Fix type label:** `NO GPS`, `NO FIX`, `2D`, `3D`, `DGPS`, `RTK`
- **Satellite count** (e.g., `14 sats`)

For safe autonomous flight, you need **3D fix** with **≥ 10 satellites** and HDOP < 2.
The pre-flight checklist requires ≥ 12 satellites.

### 2.8 Signal Gauge (Link Quality)

Shows the WiFi link quality to the companion:
- **RSSI** (Received Signal Strength): higher (less negative) is better.
  -50 dBm = excellent; -80 dBm = weak; `lost` = disconnected.
- **Latency** in ms (round-trip WebSocket ping).
  < 50 ms is excellent; > 200 ms may cause control delay.

### 2.9 Controller / Manual Indicator (Right Side)

| Display | Colour | Meaning |
|---------|--------|---------|
| `MANUAL` (with gamepad icon) | Accent blue | Manual control is **active** — companion is accepting stick inputs |
| `PAD` (with gamepad icon) | Green | A gamepad is detected and ready but manual is not yet engaged |
| `NO PAD` (with gamepad icon) | Grey | No gamepad detected; keyboard mode only |

**`MANUAL` state** is authoritative from the companion's telemetry `controlSource` field —
not just local UI state. If the companion releases manual control (e.g., due to the input
watchdog or an emergency stop), this indicator changes to `PAD` or `NO PAD` automatically.

### 2.10 Action Icon Buttons (Right Side)

| Icon | Action | Opens |
|------|--------|-------|
| Shield/Alert icon | Failsafe settings | Failsafe modal |
| Sliders icon | PID tuning | PID tuning modal |
| Scroll/text icon | Log browser | Log browser modal |
| Settings gear | All settings | Settings modal |

### 2.11 DISARM Button

The red `DISARM` button is the most important button on the screen.

- **Clicking it sends `emergencyStop`** → stops all guidance and manual control,
  zeros setpoints, and commands `LAND`/`BRAKE` to the FC.
- Keyboard shortcut: **SPACEBAR** (works anywhere on the screen except text inputs).
- This is an **instant action with no confirmation gate** — stopping is immediate.
- When the drone is disarmed, the button is grey (less alarming); when armed, it
  glows red with a drop-shadow.

> **Memorise SPACEBAR as your emergency stop.** Keep one hand near it at all times
> when the drone is armed.

---

## 3. Banners

Banners appear below the status bar when certain modes are active.

### 3.1 Tracking Banner

**Appears when:** tracking is engaged (state is `searching`, `locked`, or `lost`).

Shows:
- Current standoff distance setting (e.g., `5 m`)
- Current max speed setting (e.g., `2 m/s`)
- A **Disengage** button (stops tracking, drone holds position)

The tracking banner is amber/warning to clearly indicate autonomous operation is active.

### 3.2 Manual Banner

**Appears when:** manual control is active (`manualActive` = true in the UI,
confirmed by `controlSource = "manual"` in telemetry).

Shows:
- "Manual control active — operator has the sticks"
- A **Release to auto-hold** button (sends `disengageManual`, drone holds position)

The manual banner is visible whenever any stick input is being forwarded to the drone.

---

## 4. Left Column — Controls Panel

### 4.1 Flight Panel

Contains four flight action buttons and the mode selector.

#### Arm Button

- **Arm** (green, when disarmed): Opens the **pre-flight checklist modal** if it hasn't
  been completed yet. After all 6 items are checked, sends the `arm` command.
- **Disarm** (secondary, when armed): Sends `disarm` command — graceful disarm.
  For emergency, use the DISARM button in the status bar or SPACEBAR instead.

#### Takeoff Button

- Disabled until drone is armed and on the ground (relAlt < 0.5 m).
- Opens the **Takeoff modal**: enter target altitude (default 4 m, range 1–30 m).
- After confirming, sends `takeoff` with the specified altitude.
- The drone climbs to that altitude and holds in GUIDED mode.

#### Land Button

- Disabled when drone is not airborne (relAlt < 0.5 m).
- Sends `land` command immediately (no confirmation dialog).
- Drone descends and lands at current position.

#### RTL Button

- Disabled when not airborne.
- Sends `rtl` command: drone climbs to `RTL_ALT` (20 m), flies home, lands.
- Keyboard shortcut: **R** (when airborne).

#### Pre-Flight Checklist Warning

If the checklist has not been completed, a yellow warning appears below the buttons:
"Pre-flight checklist required". The Arm button will re-open the checklist.
This warning disappears once the checklist is completed for the current session.

#### Mode Chips

A row of mode buttons: `LOITER`, `GUIDED`, `ALT_HOLD`, `POSHOLD`, `BRAKE`.
Click any chip to send `setMode` with that mode.

The **active mode** is highlighted (accent colour border and background).

> Normally you should not need to change modes manually during autonomous operation.
> The companion manages GUIDED mode. Use LOITER for free hovering, BRAKE for emergency
> horizontal stop.

### 4.2 Person Tracking Panel

Shows the current tracking state and contains the engage/disengage controls.

#### Tracking State Pill

| State | Colour | Meaning |
|-------|--------|---------|
| `idle` | Grey | Tracking not engaged; system is off |
| `searching` | Blue (info) | Tracking engaged; scanning for persons |
| `locked` | Amber (pulsing) | Target locked; drone is following |
| `lost` | Red (danger) | Target was locked but has been lost |

**`lost` state:** The companion maintains the last estimated position (Kalman filter) for a
configurable timeout, then returns to `searching`. When in `lost`, the drone holds position.

#### Engage Tracking Button (Hold-to-Confirm)

- **Only active when drone is airborne** (altitude > 0.5 m).
- A "hold to engage" button: click and hold for ~1 second to confirm.
  This prevents accidental engagement.
- After confirming, sends `engageTracking`, `setStandoff`, and `setMaxSpeed` commands.
- Keyboard shortcut: **T** (when airborne and tracking is idle).

#### Disengage Tracking Button

- Appears (red) when tracking is active.
- Click to immediately disengage tracking. Drone holds current position.
- Keyboard shortcut: **D** (when tracking is active).
- Also triggered by: `emergencyStop` (DISARM/SPACEBAR).

#### Standoff Distance Slider

Range: 2 m – 15 m. Default: 5 m. Step: 0.5 m.

**The standoff is a hard limit** — the companion will never command forward motion
inside this distance. The drone approaches to this distance and stops. Setting it below
the minimum of 3 m is possible via the slider (min is 2 m in the UI) but the companion
enforces a hard floor of 3 m regardless of the UI setting.

Moving the slider sends `setStandoff` in real-time. Changes take effect immediately
during active tracking.

#### Max Speed Slider

Range: 0.5 m/s – 8 m/s. Default: 2 m/s. Step: 0.5 m/s.

Controls the maximum velocity the drone will move in any direction during tracking
(horizontal, vertical, and yaw all clamped to this and related limits).

The companion enforces an absolute max speed cap of 8 m/s regardless of this setting.
Start at the default 2 m/s; increase only after validating tracking behaviour.

---

## 5. Left Column — Manual Control Panel

Allows the operator to fly the drone manually via a connected gamepad or keyboard,
bypassing the autonomous tracking.

### 5.1 Stick Visualizers

Two circular displays show the current stick positions:

| Display | Axes |
|---------|------|
| **Left stick (Throttle / Yaw)** | Vertical = throttle (climb/descend); horizontal = yaw rate |
| **Right stick (Pitch / Roll)** | Vertical = pitch (forward/backward); horizontal = roll (left/right) |

The dot moves to reflect current stick input. The visualizer is dim grey when manual is
not engaged; active blue when manual control is live.

These are live previews even before engaging manual — useful to verify your controller
inputs are being received correctly.

### 5.2 Channel Bars

Four bars (THR, YAW, PITCH, ROLL) showing each axis value (-1.0 to +1.0).

The bars are centred (zero = middle). A bar extending to the right means positive value;
to the left means negative. Values are shown numerically on the right.

The **deadzone (9%)** is applied: small inputs near centre are treated as zero.
This prevents drift from a slightly off-centre gamepad.

### 5.3 Take Manual Control (Hold-to-Confirm)

- **Only active when armed AND airborne.**
- Hold for ~1 second to confirm taking manual control.
- When confirmed: sends `engageManual` command.
  - Companion immediately **disengages any active tracking** (mutual exclusion).
  - Sets `controlSource = "manual"` in telemetry.
  - The MANUAL indicator in the status bar activates.
  - The Manual Banner appears below the status bar.

**Important:** manual control and autonomous tracking are mutually exclusive. Only one
can be active at a time. Engaging one automatically disengages the other.

### 5.4 Release to Auto-Hold Button

Appears (grey) when manual control is active.
- Click once to release: sends `disengageManual`.
- Companion zeros all setpoints, holds position in GUIDED (or switches to LOITER).
- `controlSource` returns to `"auto"`.
- The Manual Banner disappears.
- Gamepad button: **B (Xbox) / Circle (PlayStation)** also releases manual control.

### 5.5 Controller Status

At the bottom of the panel:
- **Green dot + controller name:** A gamepad is connected (e.g., `Xbox Wireless Controller`).
- **Grey dot + "No controller · keyboard WASD + arrows":** No gamepad; keyboard mode active.

In keyboard mode:
- `W` / `S`: throttle up / down
- `A` / `D`: yaw left / right
- Arrow Up / Down: pitch forward / backward
- Arrow Left / Right: roll left / right

Keyboard mode gives binary on/off inputs (no analogue feel). Gamepad is strongly preferred
for smooth control. The keyboard shortcut conflict with flight controls (Engage = T,
Disengage = D, RTL = R, Disarm = Space) is avoided because the keyboard stick keys
`WASD + arrows` are only active when manual mode is already engaged.

### 5.6 Manual Control Safety Interlocks

1. **Armed + airborne required:** The "Take manual control" button is disabled unless
   `armed = true` AND `relAlt > 0.5 m`. You cannot take manual control on the ground.

2. **Mutual exclusion with tracking:** Engaging manual always disengages tracking first.
   You cannot have both active simultaneously.

3. **Input watchdog (500 ms):** If no stick frame arrives from the ground app for 500 ms
   (network hiccup, app freeze, disconnection), the companion zeros all velocity setpoints
   and the drone holds position. It does **not** continue the last commanded velocity.
   This is a deadman switch. The `manualWatchdogMs` default is 500 ms (from `DEFAULTS`
   in `shared/shared.py`).

4. **Ground link deadman (2000 ms):** If the WebSocket connection drops entirely for
   2 seconds (`groundLinkTimeoutMs = 2000`), the companion also stops all guidance and
   manual setpoints and holds position (or RTLs per the failsafe setting).

5. **All axes clamped:** The companion clamps every manual axis to the same limits as
   autonomous guidance: max speed, max climb rate, max yaw rate. No manual input can
   exceed these safety limits.

6. **emergencyStop always wins:** SPACEBAR / DISARM button overrides manual control
   instantly, no confirmation. The drone brakes and lands.

---

## 6. Center Column — Video Panel

The largest panel in the center. Shows the live camera feed from the drone.

### 6.1 Live Video Feed

When connected to a live drone:
- Displays the RTSP stream from the Jetson (via mediamtx).
- Stream URL: `rtsp://<jetson-ip>:8554/stream` (configurable in Settings).
- H.264 video, typically 720p at 30 fps.
- Expected latency: 100–400 ms over WiFi (lower is better).

When connected to SITL (or video URL is empty):
- Displays a simulated animated scene with a mock target.
- The mock scene shows a person walking; tracking boxes are rendered over it.

### 6.2 Tracking Overlay

The companion sends bounding box data over the WebSocket (`tracking` message with
`targets[]`). The ground app renders these as overlay boxes on the video:

- **Unlocked targets** (persons detected but not locked): shown as thin grey boxes.
- **Locked target** (the one being followed): shown as a bright accent box.

**Click on any bounding box** in the video to send `selectTarget` with that target's ID.
The companion then locks tracking onto that specific person.

### 6.3 Video Panel Status

When video is unavailable:
- A placeholder is shown with a camera icon and status text.
- This happens when: disconnected from companion, RTSP stream not started, or camera error.
- Check the Log Console for camera-related status messages.

---

## 7. Center Bottom — Map Panel

Shows a top-down map view centred on the drone's current GPS position.

### 7.1 Map Elements

| Element | Meaning |
|---------|---------|
| **Blue pulsing dot** | Drone's current position |
| **Grey trail line** | Flight path (last ~120 seconds) |
| **Green home marker** | Home position (where the drone was armed) |
| **Orange/red dashed circle** | Geofence boundary |
| **Arrow indicator** | Drone heading |

The map tiles can be changed in Settings: Satellite, Terrain, or OpenStreetMap.

### 7.2 Geofence Circle

The orange circle shows the configured geofence radius (default 60 m from home).
If the drone approaches the circle, ArduPilot will brake and RTL (per `FENCE_ACTION = 1`).

The geofence radius shown in the map always matches the value configured in the
Failsafe Settings modal — adjust it there.

---

## 8. Center Bottom — Log Console

A real-time scrolling log of status messages from the companion.

### 8.1 Severity Levels

| Severity | Colour | Meaning |
|----------|--------|---------|
| `info` | White/grey | Normal operational messages |
| `warning` | Amber | Something to be aware of; non-critical |
| `error` | Red | An error occurred; may affect function |
| `critical` | Bright red | Critical failure; immediate attention required |

**Critical messages** also trigger a **toast notification** (pop-up overlay, auto-dismisses
after ~4 seconds) so they are not missed even if you are not looking at the log.

### 8.2 Recording

The **Record** button (top of the Log Console) toggles telemetry recording to disk.
When recording:
- All telemetry, tracking, and statusText frames are saved to a log file.
- The recording indicator is lit (red dot).
- In the Electron build, logs are saved to disk via the Electron main process bridge.
  In the browser build, logs are kept in memory.

### 8.3 Log Browser

Click **Browse** to open the **Log Browser modal**, which shows saved log files and
allows replay of historical sessions.

---

## 9. Right Column — Telemetry Panel

Three stacked panels showing detailed flight data.

### 9.1 Attitude & Heading Panel

Two instruments side by side:

**Attitude Indicator (artificial horizon):**
- A circular instrument showing the drone's roll (tilt left/right) and pitch (nose up/down).
- Brown sector = ground; blue sector = sky.
- The horizon line tilts to show roll angle; the aircraft symbol moves up/down to show pitch.
- Normal level flight: horizon centred, no tilt.

**Compass (heading indicator):**
- A circular compass rose showing the drone's current heading (0–360°, north = 0°).
- North is at the top of the compass.
- A marker indicates the drone's current heading direction.

### 9.2 Telemetry Panel (Numeric Readouts)

| Readout | Unit | Meaning |
|---------|------|---------|
| **Rel Alt** | m | Altitude relative to the arm/takeoff point. 0 = on ground. |
| **Ground Spd** | m/s | Horizontal speed over ground. |
| **Vert Spd** | m/s | Vertical speed (positive = climbing, negative = descending). Trend arrow shown. |
| **To Home** | m | Horizontal distance from current position to the home/arm point. |
| **To Target** | m | Estimated distance to the locked tracking target. Shown only when locked. |
| **Battery** | % | Battery remaining percentage. Colour-coded (green/amber/red). |

Below the main readouts, three smaller values:

| Mini Readout | Meaning |
|--------------|---------|
| **Sats** | GPS satellite count |
| **HDOP** | Horizontal dilution of precision (lower = more accurate; < 1.5 = excellent) |
| **Voltage** | Battery voltage in V |
| **Lat** | Current latitude (4 decimal places) |
| **Lon** | Current longitude (4 decimal places) |

### 9.3 History Panel (Sparklines)

Two small line graphs:

**Altitude history:** Last ~60 seconds of altitude data (blue line). Useful to verify
a steady hover or see altitude trends during tracking.

**Battery history:** Last ~60 seconds of battery percentage. The line colour matches
the battery status (green / amber / red). A steep downward curve suggests a high-drain
situation; land soon.

---

## 10. Modals

### 10.1 Pre-Flight Checklist Modal

**Opened by:** Clicking Arm (when checklist not yet done) or from Controls Panel.

Six checklist items must all be ticked before Arm is enabled:

1. GPS 3D fix acquired (≥ 12 sats)
2. Battery ≥ 90% & secured
3. Props clear of obstructions
4. RC transmitter bound & armed
5. Geofence configured
6. Camera & companion link healthy

Click each row to check/uncheck it. The "Confirm & Enable Arm" button activates only
when all 6 are checked. Cancel returns without arming.

Once completed, the checklist does not re-appear for the rest of the session.
On next app launch, it resets.

### 10.2 Takeoff Modal

**Opened by:** Clicking Takeoff button (when armed and on ground).

Enter the desired takeoff altitude in meters. Default: 4 m. Range: 1–30 m.

Click **Confirm** to send the `takeoff` command. The drone climbs to that altitude
and holds in GUIDED mode.

### 10.3 Settings Modal

**Opened by:** Settings gear icon (status bar, top-right).

| Field | Description |
|-------|-------------|
| **Host / Jetson IP** | IP address of the Jetson companion (e.g., `192.168.4.1`). Disabled when SITL is ON. |
| **Control port** | WebSocket port (default 8765). Change only if you changed the companion config. |
| **Video URL** | Full RTSP/WebRTC URL (e.g., `rtsp://192.168.4.1:8554/stream`). Leave empty for mock/SITL. |
| **SITL toggle** | ON = use SITL mode (no hardware); OFF = connect to real drone. |
| **Units** | Metric (m, m/s) or Imperial (ft, mph). |
| **Map tiles** | Satellite, Terrain, or OpenStreetMap. |
| **Failsafe settings** | Button shortcut → opens Failsafe modal. |
| **PID tuning** | Button shortcut → opens PID modal. |

Settings are automatically saved to disk (Electron build) or localStorage (browser build).
Changes to connection settings cause the app to reconnect immediately.

### 10.4 Failsafe Modal

**Opened by:** Shield icon in status bar, or from Settings modal.

| Setting | Default | Description |
|---------|---------|-------------|
| **Geofence radius** | 60 m | Drone will RTL if it exceeds this distance from home. Slider 20–500 m. |
| **Max altitude** | 30 m | Drone will not fly above this altitude. Slider 5–120 m. |
| **Battery warn** | 30% | Trigger an alert at this battery percentage. |
| **Battery failsafe** | 15% | Trigger automatic `linkLossAction` at this percentage. |
| **Link-loss action** | RTL | Action when WiFi link to companion is lost. Options: Hold, RTL, Land. |
| **GCS heartbeat-loss action** | RTL | Action when the GCS heartbeat stops (ArduPilot-level failsafe). |

Click **Apply** to save and push settings. Click **Reset to defaults** to revert.
Click **Cancel** to close without saving.

**The battery warn/failsafe percentages are UI-side alerts.** The ArduPilot `BATT_FS_*`
parameters (set in [flashing.md](flashing.md)) are the authoritative FC-level failsafe.
Both layers of failsafe are independent and complement each other.

### 10.5 PID Tuning Modal

**Opened by:** Sliders icon in status bar, or from Settings modal.

Three axis blocks: **Yaw**, **Altitude**, **Forward**.

Each block shows three gain fields: **Kp**, **Ki**, **Kd**.

These gains control the visual servoing PID controller in the companion:
- **Yaw Kp/Ki/Kd:** How aggressively the drone turns to keep the target centred.
- **Altitude Kp/Ki/Kd:** How aggressively the drone adjusts altitude to keep the target
  vertically centred in frame.
- **Forward Kp/Ki/Kd:** How aggressively the drone moves toward/away from the target
  to maintain standoff distance.

**Defaults (conservative, from `shared/shared.py`):**

| Axis | Kp | Ki | Kd |
|------|----|----|-----|
| Yaw | 0.40 | 0.05 | 0.00 |
| Altitude | 0.80 | 0.10 | 0.04 |
| Forward | 0.60 | 0.08 | 0.02 |

**Tuning guidance:**
- **Too oscillatory (drone overshoots):** Reduce Kp. Increase Kd slightly.
- **Too slow to respond:** Increase Kp slightly. Check Ki is not too high (causes windup).
- **Steady-state offset (drone always ends up slightly off-target):** Increase Ki slightly.
- **Changes take effect immediately** when you click Apply — only tune with the drone
  in a safe, open area with room to correct mistakes.

Click **Apply** to persist and (when connected) push gains to the companion.
Click **Reset to defaults** to revert to factory settings.

### 10.6 Log Browser Modal

**Opened by:** Scroll/text icon in status bar, or from Log Console.

Shows a list of saved log sessions (in the Electron build). Each entry shows:
- Date/time of recording
- Duration
- File size

Click a session to open a replay view of the telemetry/tracking data from that session.
This is useful for post-flight analysis.

---

## 11. Keyboard Shortcuts

| Key | When Active | Action |
|-----|-------------|--------|
| **SPACEBAR** | Always (except text inputs) | **Emergency stop / Disarm** — sends emergencyStop, then LAND/BRAKE |
| **T** | When airborne and tracking is idle | Engage tracking |
| **D** | When tracking is active | Disengage tracking |
| **R** | When airborne | Return to Launch (RTL) |
| **W** | When manual active (no gamepad) | Throttle up |
| **S** | When manual active (no gamepad) | Throttle down |
| **A** | When manual active (no gamepad) | Yaw left |
| **D*** | When manual active (no gamepad) | Yaw right (**D** key: if manual is active, overrides disengage; if manual not active, D = disengage tracking) |
| **Arrow Up** | When manual active (no gamepad) | Pitch forward |
| **Arrow Down** | When manual active (no gamepad) | Pitch backward |
| **Arrow Left** | When manual active (no gamepad) | Roll left |
| **Arrow Right** | When manual active (no gamepad) | Roll right |

> **D key conflict note:** The D key serves as "Disengage tracking" when tracking is active
> and manual is not, but as "Yaw right" in keyboard manual mode. The system gives priority
> to the manual control key bindings when manual is engaged. When manual is not engaged,
> D = Disengage.

---

## 12. Status Messages — What They Mean

The Log Console and toast notifications emit status messages from the companion.
Here is a guide to common messages:

| Message | Severity | Meaning |
|---------|----------|---------|
| `Companion started` | info | System boot; companion is running. |
| `MAVLink connected on /dev/ttyTHS1` | info | FC UART link established. |
| `GPS 3D fix, 14 sats` | info | GPS is healthy. |
| `Tracking engaged` | info | tracking successfully started. |
| `Target locked: id=1` | info | Tracking locked onto a detected person. |
| `Target lost` | warning | Tracked person has left the frame or become occluded. |
| `Standoff reached: 5.0 m` | info | Drone has reached the standoff distance and is holding. |
| `Manual control engaged` | warning | Manual sticks are now driving the drone. |
| `Manual watchdog: input timeout` | warning | No stick frames received for 500 ms; holding position. |
| `Manual control released` | info | Manual mode disengaged; drone is in auto-hold. |
| `Battery low: 28%` | warning | Battery below warn threshold. Land soon. |
| `Battery critical: 13% — LANDING` | critical | Automatic landing triggered. |
| `GCS heartbeat lost` | error | No WebSocket heartbeat for 2 s; stopping guidance. |
| `GCS heartbeat restored` | info | WebSocket reconnected. |
| `Geofence breach — RTL` | critical | Drone hit geofence limit; returning home. |
| `EKF variance high` | warning | Navigation estimate degrading; GPS quality issue. |
| `emergencyStop received` | critical | Emergency stop command received and executed. |

---

## 13. Day-to-Day Operational Workflow

A typical session from startup to shutdown:

1. **Pre-flight:** Complete the [runbook.md](runbook.md) pre-flight checklist.
2. **Connect:** Launch ground app, go to Settings, set Jetson IP, SITL OFF. Wait for "Connected" (green).
3. **Verify:** Battery %, GPS fix, video feed, mode = LOITER.
4. **Pre-flight checklist in app:** Click Arm → check all 6 items in the modal → "Confirm & Enable Arm".
5. **Takeoff:** Click Takeoff → enter altitude (start with 3 m) → Confirm.
6. **Hover check:** Let the drone hover for 10–15 seconds. Watch altitude, attitude, battery.
7. **Engage tracking:** Position the target person in front of the camera → click their bounding box
   to lock → hold "Engage Tracking" button. Observe drone yaw and approach.
8. **Monitor:** Watch standoff distance in the Telemetry Panel → "To Target" readout.
   Watch the Tracking Banner (active = amber) and tracking state pill.
9. **Flying:** Keep an eye on battery %. Plan to disengage and land at 30%.
10. **Disengage:** Click "Disengage Tracking" or press D. Drone holds.
11. **Land:** Click Land (descend in place) or RTL (return home first). 
12. **Disarm:** After landing and full stop, click Disarm in Controls Panel.
13. **Post-flight:** Disconnect battery, check props, review log console.

---

*For detailed commissioning steps, see [runbook.md](runbook.md).*
*For network configuration, see [network.md](network.md).*
*For firmware parameters, see [flashing.md](flashing.md).*
