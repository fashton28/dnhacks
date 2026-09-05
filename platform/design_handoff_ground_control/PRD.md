# PRD — Ground Control Center UI (for Claude Design)

> **How to use this prompt:** Paste this whole document into Claude Design. It is a one-shot brief: produce the complete, runnable front-end for a drone ground control center, driven entirely by a mock data layer, with zero further input from me. Build it so Claude Code can later swap the mock data for live drone data by changing a single line. Assume unlimited time/tokens — favour completeness over brevity.

---

## 1. Project context

I'm building (as a student summer project) an autonomous **person-following drone**. A quadcopter running ArduPilot carries an NVIDIA Jetson companion computer that detects a person with a camera and flies the drone toward them, **stopping and holding at a safe standoff distance** (this is a follow-me / tracking system — it maintains distance, it never collides with or contacts the person). I control and monitor everything from a **Windows desktop control center** — that is what you are building.

You are building **only the desktop UI**, as real front-end code, with realistic fake data so it looks and behaves like the finished product. A separate Claude Code prompt builds the drone software, the live data backend, the simulator, and the hardware. The two halves connect through the shared contract in Section 4 — follow it exactly.

## 2. Your task (one-shot objective)

Produce a **complete, polished, fully interactive React + TypeScript front-end** for the control center:

- Every screen, panel, and component listed in Sections 6–7, in every state in Section 7.
- A `MockDataProvider` (Section 4) that emits animated, believable telemetry and tracking data and responds to commands locally, so the entire UI is demoable with **no backend and no hardware**.
- A centralised design system (tokens, components) so it's consistent and easy to extend.
- It must run immediately with `npm install && npm run dev` and show a live-feeling mission control screen.

Do not ask me questions. Make sensible, opinionated decisions and document them in the README.

## 3. Tech stack & constraints

- **React 18 + TypeScript + Vite.** Function components and hooks only.
- **Electron-ready:** this UI will be wrapped in Electron later. Keep all rendering logic in the renderer; do **not** call Node/Electron APIs directly. Touch the outside world only through the `DataSource` interface (Section 4) so the Electron/IPC layer can be injected later.
- **Styling:** Tailwind CSS. Centralise all colours, spacing, and typography as Tailwind theme tokens — no hard-coded hex values scattered through components.
- **Icons:** `lucide-react`.
- **Map:** `react-leaflet` with OpenStreetMap tiles (free). Make the tile source configurable and degrade gracefully offline (show last position + grid if tiles fail).
- **Charts/instruments:** custom SVG/Canvas for the attitude indicator (artificial horizon), compass, and battery/signal gauges. A small library (e.g. `recharts`) is fine for time-series (battery, altitude history).
- **State:** React context + hooks, or Zustand. No Redux.
- **No browser storage restrictions to worry about** in the final Electron app, but keep persisted settings behind a tiny `SettingsStore` abstraction (in-memory default) so Code can back it with a file later.
- Target a **dark, high-density, glanceable mission-control aesthetic** (Section 5).

## 4. THE SHARED CONTRACT — authoritative, do not change

This contract is the seam between your UI and the live backend. Implement the types and the `DataSource` interface **exactly** as written. Build a `MockDataProvider implements DataSource`. Claude Code will build a `LiveDataProvider implements DataSource` against the identical interface and swap it in via one config line.

Put all of this in `src/contract/` and treat it as the single source of truth.

### 4.1 Message types

```ts
export type Mode =
  | 'STABILIZE' | 'ALT_HOLD' | 'LOITER' | 'GUIDED'
  | 'AUTO' | 'RTL' | 'LAND' | 'POSHOLD' | 'BRAKE';

export interface Telemetry {
  type: 'telemetry';
  ts: number;                       // epoch ms
  armed: boolean;
  mode: Mode;
  attitude: { roll: number; pitch: number; yaw: number };   // degrees
  position: { lat: number; lon: number; relAlt: number; absAlt: number }; // m
  velocity: { groundspeed: number; verticalSpeed: number }; // m/s
  heading: number;                  // degrees 0..360
  battery: { voltage: number; current: number; remaining: number }; // V, A, %
  gps: { fixType: number; satellites: number; hdop: number };
  home: { lat: number; lon: number; distance: number };     // distance m
  link: { rssi: number; latencyMs: number };
}

export type TrackingState = 'idle' | 'searching' | 'locked' | 'lost';

export interface DetectedTarget {
  id: number;
  bbox: [number, number, number, number]; // x,y,w,h NORMALISED 0..1 of the video frame
  confidence: number;                      // 0..1
  isLocked: boolean;
}

export interface TrackingStatus {
  type: 'tracking';
  ts: number;
  state: TrackingState;
  targets: DetectedTarget[];
  lockedTargetId: number | null;
  standoffDistance: number;          // configured target distance, m
  estimatedDistance: number | null;  // estimated current distance to locked target, m
  maxSpeed: number;                  // configured cap, m/s
}

export interface StatusText {
  type: 'statusText';
  ts: number;
  severity: 'info' | 'warning' | 'error' | 'critical';
  text: string;
}

export type CommandName =
  | 'arm' | 'disarm' | 'takeoff' | 'land' | 'rtl' | 'setMode'
  | 'engageTracking' | 'disengageTracking' | 'selectTarget'
  | 'setStandoff' | 'setMaxSpeed' | 'emergencyStop';

export interface Command {
  type: 'command';
  command: CommandName;
  params?: {
    altitude?: number;     // takeoff, m
    mode?: Mode;           // setMode
    targetId?: number;     // selectTarget
    meters?: number;       // setStandoff
    mps?: number;          // setMaxSpeed
  };
}

export interface CommandAck {
  type: 'ack';
  ts: number;
  command: CommandName;
  success: boolean;
  message: string;
}

export type ConnectionState =
  | 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectionConfig {
  host: string;            // Jetson IP, or 'sitl'
  controlPort: number;     // websocket control/telemetry port, default 8765
  videoUrl: string;        // rtsp/webrtc/http url, or '' for mock
  sitl: boolean;
}
```

### 4.2 The DataSource interface

```ts
export type Unsubscribe = () => void;

export interface DataSource {
  connect(config: ConnectionConfig): Promise<void>;
  disconnect(): void;

  onConnectionChange(cb: (s: ConnectionState) => void): Unsubscribe;
  onTelemetry(cb: (t: Telemetry) => void): Unsubscribe;
  onTracking(cb: (t: TrackingStatus) => void): Unsubscribe;
  onStatusText(cb: (s: StatusText) => void): Unsubscribe;
  onAck(cb: (a: CommandAck) => void): Unsubscribe;

  sendCommand(cmd: Command): Promise<CommandAck>;

  /** RTSP/WebRTC/HTTP URL for the live backend.
   *  MockDataProvider returns '' and the UI renders the mock canvas scene instead. */
  getVideoUrl(): string;
}
```

The whole app consumes data **only** through a `DataSource` obtained from a single `DataSourceContext`. Selecting Mock vs Live happens in exactly one place:

```ts
// src/dataSource/index.ts
export const dataSource: DataSource = new MockDataProvider();
// Claude Code replaces this one line with: new LiveDataProvider();
```

### 4.3 MockDataProvider requirements

Make the mock genuinely lifelike so the UI is demoable and testable on its own:

- Emit `telemetry` at ~10 Hz. Simulate a drone that arms, takes off to the commanded altitude, drifts/flies a gentle pattern, drains battery slowly, and reports a moving GPS position near a default home location (make home configurable; default somewhere generic).
- Maintain a coherent state machine that responds to commands: `arm`/`disarm` flip `armed`; `takeoff` climbs to altitude and switches `mode` to `GUIDED`; `rtl` flies home; `land` descends and disarms; `setMode` updates mode; `emergencyStop`/`disarm` cut to disarmed.
- Render a **synthetic video scene on a canvas** (no external video file, no copyrighted assets): a simple top-down or forward-view scene with one or two moving "person" markers drawn as labelled rectangles. Emit matching `tracking` messages whose `bbox` values correspond to those markers in normalised coords, so click-to-select works against the mock.
- `engageTracking` → move `state` `searching` → `locked` on the selected/closest target, then animate `estimatedDistance` converging toward `standoffDistance` (the follow-me approach). `disengageTracking` → `idle`. Occasionally simulate `lost` then re-acquire, to exercise that state.
- Honour `setStandoff` and `setMaxSpeed`.
- Periodically emit `statusText` of varying severity ("EKF healthy", "GPS fix acquired", "Battery 35%", "Tracking lock lost", etc.) to fill the log console.
- Implement `getVideoUrl()` returning `''`.

## 5. Design direction & visual system

This is a safety-critical control surface, not a marketing dashboard. Aim for the feel of a professional ground control station (think QGroundControl / Mission Planner) but cleaner and more modern. Make deliberate, distinctive choices — avoid the generic SaaS-admin-template look.

- **Theme:** dark first (near-black/charcoal surfaces). Optional light theme is a bonus, not required.
- **Density:** information-dense and glanceable. The pilot scans this at a glance — critical numbers must be readable instantly.
- **Numerals:** use a monospaced/tabular font for all live numeric readouts so values don't jitter as digits change.
- **Colour semantics (consistent everywhere):** green = nominal/safe, amber = caution, red = danger/critical, neutral grey = inactive. Reserve red strictly for genuine danger (disarm/kill, critical battery, link loss, tracking-active warning).
- **Hierarchy:** the live video and the master safety controls (disarm/kill, tracking engage) are the most prominent elements. Telemetry is secondary but always visible. Config lives in modals/drawers.
- **Motion:** subtle and functional only (smooth needle/horizon movement, gentle state transitions). No decorative animation.
- Centralise the palette, type scale, spacing, and radii as tokens. Document them.

## 6. Layout & screens

Single primary window, panel-based, resizable. Lay it out so nothing critical is ever hidden.

### 6.1 Top status bar (always visible)
Connection state (with host + SITL/LIVE badge); armed/disarmed indicator; current flight mode; mission/flight timer; battery (V, %, with colour state and a small bar); GPS fix type + satellite count; link quality (RSSI + latency). A persistently visible, unmistakable **DISARM / KILL** button at the far right (red, requires the confirmation rules in Section 8).

### 6.2 Center — live video + tracking overlay (primary element)
- Large video area rendering `getVideoUrl()` when live, or the MockDataProvider canvas scene when mock.
- Overlay layer driven by `tracking.targets`: draw each detected person's bounding box (normalised → pixel), confidence label, and a distinct highlight for the locked target. Draw a center crosshair and a readout of `estimatedDistance` vs `standoffDistance`.
- **Click-to-select:** clicking a bounding box sends `selectTarget { targetId }`. Show hover affordance.
- States: connected w/ video, connected no video ("NO VIDEO SIGNAL"), disconnected, tracking idle vs searching vs locked vs lost (clear visual treatment for each, e.g. amber pulsing border while tracking is active).

### 6.3 Left panel — flight & tracking controls
- **Flight:** Arm / Disarm, Takeoff (with an altitude input), Land, RTL, and a flight-mode selector (the `Mode` values).
- **Tracking:** a large, prominent **Engage Tracking / Disengage** control — the single most safety-sensitive action — gated per Section 8. Show current `TrackingState` clearly.
- **Tuning sliders:** Standoff distance (e.g. 2–15 m) → `setStandoff`; Max speed (e.g. 0.5–8 m/s) → `setMaxSpeed`. Show current values.

### 6.4 Right panel — telemetry dashboard
- Artificial horizon (roll/pitch) — custom SVG/Canvas.
- Compass/heading.
- Numeric readouts: relative altitude, groundspeed, vertical speed, distance to home, distance to target, lat/lon, satellites, HDOP, battery V / A / %.
- Small history sparklines for altitude and battery.

### 6.5 Map panel (toggle or docked)
Drone position + heading marker, home marker, locked-target marker (if positionable), breadcrumb trail, and a geofence ring. `react-leaflet` + OSM, offline-tolerant.

### 6.6 Bottom — log console
Scrolling stream of `statusText` messages, colour-coded by severity, timestamped, filterable by severity. Include flight-recording controls (start/stop recording — wired to a no-op in the UI; Code implements actual recording).

### 6.7 Secondary views / modals
- **Settings:** connection config (host/IP, control port, video URL, **SITL toggle**), units (metric default), map tile source, theme.
- **Failsafe & geofence config:** geofence radius/altitude, battery failsafe thresholds, link-loss action, GCS-heartbeat-loss action. (UI + persisted via `SettingsStore`; enforcement is Code's job.)
- **PID / gain tuning:** editable gains for the yaw / altitude / forward-velocity controllers, with apply/reset. (Sends via a generic command path or `SettingsStore`; document the shape you choose so Code can honour it.)
- **Flight log browser + replay:** list recorded sessions, a timeline scrubber that replays telemetry/tracking (replay can run against recorded mock data).
- **Pre-flight checklist modal:** a gated checklist (GPS fix, battery OK, props clear, RC bound, geofence set, etc.) that must be acknowledged before Arm is enabled.

## 7. Component states & interactions

Every component must visibly handle: connected / connecting / disconnected / error; armed / disarmed; tracking idle / searching / locked / lost; low-battery warning and critical-battery alarm; link-degraded and link-lost; SITL vs LIVE; and command pending / acked / failed (reflect `CommandAck`). Build a small set of reusable primitives (StatusPill, GaugeReadout, ConfirmButton, Panel, Modal, Toast) and use them everywhere.

Keyboard shortcuts (document them): a clear key for emergency disarm, plus shortcuts for engage/disengage tracking and RTL. Make destructive shortcuts require the same confirmation as their buttons.

## 8. Safety UX requirements (mandatory)

Because the drone autonomously approaches a person, the UI must make unsafe actions deliberate and reversible:

- **Arm** requires the pre-flight checklist acknowledged.
- **Takeoff** and **Engage Tracking** require an explicit confirmation step (hold-to-confirm or a confirm modal), and Engage Tracking must show the active standoff distance and max speed in the confirmation.
- While tracking is active, show a persistent, unmistakable banner.
- **Disarm/Kill** and **Disengage Tracking** are always one action away, never buried, never require confirmation to *stop* (stopping must be instant). Emergency stop is the easiest thing in the whole UI to do.
- Surface every `critical` `statusText` as a prominent alert, not just a log line.

## 9. Project structure & replicability

```
ground-ui/
├── src/
│   ├── contract/          # the shared contract (Section 4) — single source of truth
│   ├── dataSource/        # MockDataProvider + the one-line selector
│   ├── components/        # reusable primitives
│   ├── panels/            # video, telemetry, controls, map, log
│   ├── views/             # modals & secondary screens
│   ├── instruments/       # attitude indicator, compass, gauges
│   ├── theme/             # tokens (tailwind config + ts tokens)
│   ├── store/             # app state, SettingsStore
│   └── App.tsx
├── index.html
├── package.json           # pin all versions
├── tailwind.config.ts
├── tsconfig.json
├── vite.config.ts
└── README.md
```

- **Pin every dependency version** in `package.json`.
- README must cover: how to run, the architecture, the `DataSource` seam and exactly how Code swaps in `LiveDataProvider`, every design-token decision, and the keyboard shortcuts.
- Keep components pure and presentational where possible; all I/O behind `DataSource`. The goal: Claude Code can drop this folder into a monorepo at `ground/ui`, replace one line, and have a live control center.

## 10. Deliverables & acceptance criteria

- A complete `ground-ui/` project that runs with `npm install && npm run dev`.
- On launch, the control center shows animated mock telemetry, a synthetic video scene with selectable people, working flight + tracking controls, all panels, all modals, and a flowing log — with no backend.
- All states in Section 7 reachable/demoable (provide a tiny hidden "demo controls" or have MockDataProvider cycle through interesting states).
- Every safety rule in Section 8 enforced in the mock.
- Clean TypeScript (no `any` in the contract), consistent tokens, documented README.

## 11. Out of scope (Claude Code will do these)
- Electron shell/packaging, real MAVLink, real video decoding, the `LiveDataProvider`, the simulator, the drone software, the hardware. Build the UI to receive all of that through the contract — don't implement it.
