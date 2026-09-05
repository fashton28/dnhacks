# Ground Control — UI kit

Interactive, click-through recreation of the **Eye in the Sky** drone ground-control
center, built from the design-system primitives. Runs entirely on a self-contained
mock data layer (`mock.js`) that mirrors the PRD's `DataSource` contract.

## Files
- `index.html` — entry; loads React + the DS bundle, mounts `GroundControl`.
- `mock.js` — `window.EISMock`, a lifelike mock (telemetry @10 Hz, tracking with
  bboxes that match the canvas scene, status-text log, command state machine).
- `GroundControl.jsx` — app shell: state, safety flows, keyboard shortcuts, layout.
- `StatusBar.jsx` — always-visible top bar + persistent DISARM/KILL.
- `VideoPanel.jsx` — synthetic forward-view canvas scene + tracking overlay (click-to-select).
- `ControlsPanel.jsx` — flight controls, Engage Tracking (hold-to-confirm), tuning sliders.
- `ManualControl.jsx` — game-controller / keyboard piloting: dual-stick visualizers, channel bars, Gamepad-API polling (WASD + arrows fallback), deliberate engage / instant release.
- `TelemetryPanel.jsx` — artificial horizon, compass, numeric readouts, sparklines.
- `MapPanel.jsx` — Google-Earth-style situational map (home, drone heading, target, geofence, trail).
- `LogConsole.jsx` — colour-coded event stream + recording controls.
- `Modals.jsx` — pre-flight checklist, takeoff confirm, settings, tracking banner.

## Try it
Arm (a pre-flight checklist gates it) → **Takeoff** (hold to confirm) → **Engage
Tracking** (hold to confirm). Click a bounding box in the video to select that
target. **Space** = instant disarm/kill. `T` engage · `D` disengage · `R` RTL.

## Manual piloting (game controller)
With the drone armed and airborne, **Take manual control** (hold-to-confirm) hands
the sticks to the operator (switches to STABILIZE, releases any active tracking).
- **Gamepad** (Xbox/PS/any standard pad): left stick = throttle/yaw, right stick =
  pitch/roll; **B / Circle** releases manual. The status bar shows `PAD` / `MANUAL`.
- **Keyboard fallback** (no controller): `W`/`S` throttle, `A`/`D` yaw, `↑`/`↓`
  pitch, `←`/`→` roll — active only while manual is engaged.
- **Release to auto-hold** is one instant tap; **Space** (disarm) always wins.
Live stick positions render on the two visualizers and channel bars, and the
vehicle (attitude, heading, altitude, map position) responds to input.

## Safety model (per PRD §8)
- Arm requires the checklist; Takeoff & Engage require a deliberate hold-to-confirm.
- Disarm and Disengage are always one instant tap — never gated.
- A persistent amber banner shows while tracking is active; critical events also toast.

## Notes
- The map and video are self-contained mocks. In production the map is
  `react-leaflet` over Google/OSM satellite tiles and the video is the real feed
  from `getVideoUrl()`; both degrade to these mock renderers offline.
