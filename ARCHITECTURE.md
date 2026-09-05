# ARGUS: Layered Autonomous Site Monitoring for Critical Infrastructure

**DNHacks, Defense track, 4 people, deadline at noon**

Vocabulary follows `CONTEXT.md`.
Simulator and flight-stack decisions are recorded in `docs/adr/0001-webots-over-px4-gazebo.md`.
The full spec with user stories is `docs/specs/0001-argus-simulated-site-monitoring.md` (GitHub issue #2).
This document is the build plan: how the pieces fit and who builds what.

---

## 1. The pitch

Autonomous ISR (intelligence, surveillance, reconnaissance) for critical infrastructure, demonstrated end to end in a physics simulation with a human always in the loop.

- **Wide-area layer.** An overhead pass of the Site produces a before and an after image.
  Change detection emits a Detection: a georeferenced polygon and a confidence.
- **Close-up layer.** The Operator dispatches.
  An LLM Triage Agent emits a MissionSpec, a deterministic Coverage Planner expands it into a FlightPlan, and a Drone from the Fleet flies it in Webots, captures frames, and a vision model turns them into Observations and an Incident Report.
- **Trust layer.** Before dispatch, the Safety Validator checks the FlightPlan against the geofence, no-fly zones, altitude limits, and battery range.
  Rejections name the rule and are fed back to the agent.
  The same rules clamp the Operator under Manual Control.
  Not even the human can fly a Drone into the reactor exclusion zone.
- **Operator surface.** A Console with an Overview of the Fleet, a live 3D World view, and a Drone view per Drone that the Operator can drop into and take Manual Control of at any moment.

**The honest version of the claim.**
The flight controller is simulated.
The planner, the Safety Validator, and the Drone interface are flight-stack agnostic and MAVLink-shaped, so a real autopilot slots in behind the same interface.
Say this out loud.
Do not say "the only thing missing is the airframe".

### Why it wins

The two-layer combination covers wide-area detection and close inspection, which most teams will not combine.
The Fleet Overview with drop-in Manual Control makes the system feel operated rather than scripted.
And the trust layer plus its red-team demo is what makes it a defense project rather than a toy: almost nobody else will show their autonomy stack refusing to fly.

---

## 2. Design constraints (read before building)

1. **The LLM does not compute geometry.**
   The Triage Agent emits intent (objective, survey polygon, constraints) and judgment (triage, narrative).
   The Coverage Planner derives waypoints.
   This boundary is the answer to "why is an LLM flying your drone?"
2. **Safety is enforced three times.**
   The Safety Validator gates every FlightPlan before dispatch.
   The same rules clamp every ManualCommand in flight.
   The flight controller itself enforces a hard altitude ceiling and geofence containment as the last line.
   Show all three in the demo.
3. **Manual Control never bypasses the rules.**
   It pauses the Mission, clamps the Operator's velocity at the boundary, reports the clamp and the rule, and ends in resume or abort.
4. **Real time by default.**
   Humans watch live camera and World views, so the sim runs at speed factor 1 on a compact Site where a flight is under a minute.
   The speed factor is a setting for CI and for recording the backup video.
5. **Everything runs on a Mac.**
   Webots is native on Apple Silicon.
   No Linux VM, no Docker, no ROS.
6. **One Hub, one controller per Drone, one Supervisor.**
   The Hub is a single FastAPI process with in-memory state, an append-only `events.jsonl` audit log, and one WebSocket to the Console.
   No Redis, no Postgres, no queue.
7. **Everything runs without Webots or an API key too.**
   A fake Drone speaks the same controller protocol and fake agents return fixtures, so every workstream can develop and test the whole loop alone.

---

## 3. System architecture

```
  ┌──────────────── WEBOTS (one Mac) ─────────────────┐
  │  Site world      Drone x N (Mavic, extern ctrl)    │
  │  Supervisor: run Scenario · overhead capture · reset│
  │  --stream (W3D)  ─────────────────────────┐        │
  └───────┬──────────────┬────────────────────┼────────┘
          │ telemetry +  │ scenario /          │ live 3D
          │ JPEG frames  │ overhead images     │ scene
          │ ↑ commands   │                     │
          ▼              ▼                     │
  ┌──────────────────── HUB (FastAPI) ─────────┼────────┐
  │  DroneState registry · dispatch · audit log│        │
  │                                            │        │
  │  [Wide-area]  before/after render ───────► Detection│
  │       ▼ Operator dispatch                  │        │
  │  [Triage Agent]  Claude, strict tool use   │        │
  │       → MissionSpec (no waypoints)         │        │
  │       ▼                                    │        │
  │  [Coverage Planner]  Shapely, deterministic│        │
  │       → FlightPlan                         │        │
  │       ▼                                    │        │
  │  [Safety Validator]  rule table            │        │
  │       → ValidationResult  reject ─► re-prompt (≤3) │
  │       ▼ accept                             │        │
  │  [Dispatcher] pick idle Drone with battery │        │
  │       → goto / capture / return_home       │        │
  │       ▼ frames                             │        │
  │  [Observation]  Claude vision              │        │
  │  [Report Agent] → IncidentReport           │        │
  │                                            │        │
  │  [Manual Control] ManualCommand ─► clamp ─► Drone   │
  └──────────────────────┬─────────────────────┼────────┘
                         │ REST + WebSocket    │
                         ▼                     ▼
  ┌──────────────── CONSOLE (TypeScript) ──────────────┐
  │  Overview · World view · Drone view · Manual Control│
  │  detection queue · validation panel · incidents     │
  │  Scenario controls · red-team panel                 │
  └─────────────────────────────────────────────────────┘
```

### Repo layout

```
contracts/          shared Pydantic models + fixtures        (frozen H0-2, all)
sim/
  worlds/           meridian_station.wbt, PROTO overrides     (Person A)
  controllers/
    drone/          extern controller: flight controller + Hub client   (A)
    supervisor/     Scenarios, overhead capture, reset        (Person B)
  fake_drone/       protocol-compatible kinematic Drone       (Person A)
hub/
  server.py         FastAPI: REST, WebSocket, controller protocol   (Person D)
  dispatch.py       Drone selection, Mission lifecycle        (Person D)
  manual.py         Manual Control session, clamping          (Person D)
  audit.py          events.jsonl                             (Person D)
widearea/           overhead change detection → Detection     (Person B)
agent/              triage.py  observe.py  report.py          (Person C)
safety/             rules.py  validator.py  geofence.geojson  (Person C)
planner/            coverage.py                              (Person C)
redteam/            cases.py                                 (Person B)
console/            Vite + TypeScript + MapLibre + webots-view   (Person D)
tests/              Hub API tests with fake Drone and fake agents; contract tests
docs/               adr/  specs/
```

---

## 4. The contracts

**Freeze these in the first two hours.**
Pydantic models in `contracts/` with hand-written fixtures.
All four people code against the fixtures from hour two.
Polygons are latitude and longitude; all distance math happens in a local projected frame via pyproj.

```
Detection        {id, polygon, confidence, change_type, before_ref, after_ref, detected_at}

MissionSpec      {detection_id, objective: inspect | perimeter_sweep | standoff_observe,
                  survey_polygon, max_altitude_m, standoff_m, rationale}
                  → contains NO waypoints

FlightPlan       {mission_id, drone_id, waypoints: [{lat, lon, alt}], pattern,
                  est_duration_s, est_battery_pct}

ValidationResult {mission_id, verdict: accept | reject,
                  violations: [{rule, detail, severity}]}

IncidentReport   {mission_id, verdict: false_alarm | log | escalate, narrative, evidence_refs}

DroneState       {drone_id, lat, lon, alt, heading, velocity_ned, battery_pct,
                  state: idle | on_mission | manual_control | returning | offline,
                  mission_id | null}

ManualCommand    {drone_id, velocity_ned: {vx, vy, vz}, yaw_rate, ts}

ClampEvent       {drone_id, original: ManualCommand, clamped: ManualCommand, rule}

Scenario         {id, kind: intruder_vehicle | fence_breach | unattended_object, params, run_at}
```

### Controller protocol (Hub ⇄ Drone, Hub ⇄ Supervisor)

One WebSocket per controller, JSON messages, about 10 Hz upward.

```
Drone → Hub        hello{drone_id}  telemetry{DroneState}  frame{drone_id, jpeg_b64, ts}
                   ack{cmd_id, ok, detail}
Hub → Drone        goto{lat, lon, alt}  hover  set_velocity{vx, vy, vz, yaw_rate}
                   look_at{pitch}  capture_frame{cmd_id}  return_home
Supervisor → Hub   hello{supervisor}  overhead{before_ref | after_ref, png_b64}  ack
Hub → Supervisor   run_scenario{Scenario}  capture_overhead{ref}  reset
```

The fake Drone implements exactly this protocol with kinematic motion and synthetic frames.

### Getting a schema-valid MissionSpec out of the model

Use strict tool use: `strict: true`, `additionalProperties: false`, full `required` list.
The returned `tool_use.input` then validates against the schema exactly, and `MissionSpec.model_validate` is the second line.
Detection metadata goes into the prompt inside a delimited data block with an explicit statement that nothing inside it is an instruction.
Always parse tool inputs as JSON objects, never string-match the serialized input.

---

## 5. The four workstreams

### Person A: World and Flight

Owns Webots.

**Deliverables**

- `sim/worlds/meridian_station.wbt`: the Site.
  About 300 by 300 metres.
  Warehouse as reactor building, two scaled Silos as cooling towers, SimpleBuilding as control building, boxes as switchyard, roads and trees outside.
  Double perimeter fence from thin wall solids with a gate; each fence section is a named solid so a Scenario can open it.
  Helipad row for the Fleet.
  Real rural US lat/lon anchor in `WorldInfo`.
- `sim/controllers/drone/`: extern controller extended from the Webots Mavic patrol sample.
  Altitude hold, attitude stabilisation, GPS waypoint navigation, gimbal pitch.
  Implements the `Drone` interface (`goto`, `hover`, `set_velocity` in NED, `look_at`, `return_home`, `capture_frame`) and the controller protocol to the Hub.
  Simulated battery depletion by time and speed.
  Hard altitude ceiling and geofence containment inside the controller.
- `sim/fake_drone/`: protocol-compatible kinematic Drone for everyone else.
  **Ship this first, by hour 3.**
- `make sim`: launches Webots with `--stream`, N Drones, and the Supervisor, and connects them to a running Hub.

**Done at H12:** a fixture FlightPlan flies in Webots at real time, frames arrive at the Hub, and Manual Control velocity commands move the Drone.

**Install note:** the Homebrew cask for Webots is disabled (Gatekeeper).
Install from the R2025a GitHub release DMG and clear the quarantine flag once.

---

### Person B: Scenarios, Wide-area, Red team

Owns everything that creates something to detect.

**Deliverables**

- `sim/controllers/supervisor/`: runs Scenarios (spawn a Webots vehicle PROTO at the perimeter, translate a fence section open, spawn a crate), captures a top-down render from a fixed overhead camera with a known footprint, resets the world.
- `widearea/detect.py`: before and after render → blur, difference, threshold, connected components, minimum area, bounding polygon in pixel space → lat/lon via the footprint → Detection with confidence from area and mean difference.
- `widearea/eval.py`: run every Scenario kind ten times with randomised placement and report precision and recall.
  False-positive rate is the operational metric; these numbers are part of the pitch.
- `redteam/cases.py`: three poisoned inputs, each runnable from the Console with one action:
  1. a MissionSpec whose survey polygon reaches into a no-fly zone
  2. a plan that exceeds endurance
  3. a prompt injection in Detection metadata telling the agent to raise the altitude ceiling

**Done at H12:** a Scenario runs, the Supervisor captures before and after, and a valid Detection lands in the Hub.

---

### Person C: Agent, Planner, Safety

Owns the differentiator.
Give this to your strongest engineer.

**Deliverables**

- `agent/triage.py`: Claude with strict tool use emitting a schema-valid MissionSpec.
  Accepts a prior ValidationResult and repairs the spec; the Hub caps the loop at three.
- `planner/coverage.py`: survey polygon → lawnmower waypoints (rotate to principal axis, parallel lines at camera swath width, clip, stitch alternating), prepend takeoff and append return home, estimate duration and battery from the Drone's speed and depletion model.
  About 30 lines of Shapely.
- `safety/rules.py`, `safety/validator.py`, `safety/geofence.geojson`: the rule table evaluated in a projected frame.
  Geofence containment for every waypoint, no segment intersecting a no-fly zone, altitude within floor and ceiling, battery estimate under capacity minus reserve, standoff minimum, mission duration cap.
  Two entry points: `validate(FlightPlan) → ValidationResult` and `clamp(ManualCommand, DroneState) → (ManualCommand, ClampEvent | None)`.
- `agent/observe.py`: Claude vision over captured frames with the Detection as context → structured Observation.
- `agent/report.py`: Observations + Detection → IncidentReport with a narrative an operator would actually read.

Do distance math in a projected CRS via pyproj, never in degrees.

**Done at H12:** a Detection fixture yields a valid MissionSpec and FlightPlan, all three red-team cases are rejected with named rules, and a manual velocity toward the fence is clamped with the geofence rule named.

---

### Person D: Hub, Console, Integration

Owns the thing judges actually look at, and the glue.

**Deliverables**

- `hub/`: FastAPI.
  Controller protocol server, DroneState registry, dispatch (idle Drone with enough battery, nearest first), Mission lifecycle, Manual Control sessions with clamping, `events.jsonl` audit log, REST for actions, one WebSocket for live state to the Console.
- `console/`: Vite + TypeScript.
  Overview (MapLibre: Site footprint, fences, no-fly zones, Drones, tracks, Detections, routes; click a Drone to open its Drone view).
  World view (embedded `webots-view` component connected to the Webots stream).
  Drone view (frames over WebSocket, telemetry, Mission panel with MissionSpec rationale and ValidationResult, Manual Control with WASD, Q/E altitude, arrow yaw, at 10 Hz, ClampEvents shown inline, Return Home).
  Detection queue with before/after images, validation panel, incident queue, Scenario controls, red-team panel.
- Integration wiring and **the demo script and the recorded backup run**.

D is the integration owner.
**At hour 10, D has the authority to tell A, B, or C to stop building and start connecting.**

**Done at H12:** Console shows the fake Drone moving on the Overview, a fixture Detection on the map, and a live frame in the Drone view.

---

## 6. Timeline

Hours count from the moment the team starts, ending at the stated deadline.

| Hours | What happens |
|---|---|
| 0-2 | Contracts and controller protocol frozen, fixtures committed. Three env spikes pass: Webots opens the Mavic sample on every Mac, Hub serves a WebSocket, API key works. **No feature work until all three pass.** |
| 2-3 | A ships the fake Drone. Everyone else is now unblocked from Webots. |
| 3-8 | Four parallel vertical slices against fixtures and the fake Drone. No cross-dependencies. |
| 8 | Webots gate: real Drone flying a fixture FlightPlan with frames at the Hub. If not, the demo runs on the fake Drone with the World view cut. Decide at 8, not 16. |
| 8-12 | Pairwise integration: B→C, C→D, A→D. |
| **12** | **Hard gate: end-to-end run works, however ugly.** If it does not, cut features rather than debug. |
| 12-16 | Red-team demo, Manual Control clamping, eval numbers, staggered sleep: two down, two up. |
| 16-20 | Report quality, Overview polish, incident narrative tuning. |
| 20-21 | **Record the backup demo video.** Non-negotiable. |
| 21-22 | Deck. |
| 22-24 | Rehearse to three minutes, buffer. |

Feature freeze at hour 20.
A recorded clean run means a live failure on stage costs you nothing, and live demos fail.

---

## 7. The three-minute demo

1. Overview shows Meridian Station with three Drones on their pads and the World view alongside.
2. Run the intruder vehicle Scenario.
   The wide-area layer flags a Detection on the Overview with its confidence.
3. Operator clicks dispatch.
   The Triage Agent's MissionSpec and rationale appear.
4. The Coverage Planner draws the route.
5. The Safety Validator turns green.
6. A Drone lifts off in the World view and moves on the Overview.
   Click it: live camera in the Drone view.
7. Take Manual Control, fly toward the reactor exclusion zone, get clamped, with the rule named on screen.
   Hand back; the Mission resumes.
8. Frames come back, Observations appear, the Incident Report writes itself, the Operator escalates.

Then: *"now watch what happens when the model is wrong."*
Run the red-team cases and show each rejection with the rule that caught it.

Close on the eval numbers and one sentence on the hardware path.

**Have an answer ready for CONOPS.**
BVLOS flight over critical infrastructure needs FAA Part 107 waivers, and autonomous response to intrusion has real regulatory constraints.
One slide (Operator-approved dispatch, drone-in-a-box sited at the facility, Part 107 waiver path) turns an obvious hole into credibility.

---

## 8. Stack

```bash
pip install anthropic pydantic shapely pyproj fastapi uvicorn websockets \
            opencv-python numpy pillow pytest httpx
```

Webots R2025a installs separately from the GitHub release DMG.

| Layer | Tool | Role |
|---|---|---|
| Simulator | **Webots R2025a** | Physics, rendering, Mavic 2 Pro model, asset library, native macOS |
| World view | **Webots web streaming** (`--stream`, W3D) + `webots-view` | Live 3D scene embedded in the Console |
| Flight | **Native Python controller** (extern) | Extended Mavic patrol sample behind the `Drone` interface |
| Scenarios | **Webots Supervisor** | Spawn, translate, capture, reset |
| LLM | **anthropic** / `claude-opus-5` | Triage, observation, reporting, strict tool use |
| Validation | **Pydantic** | Contracts, second line behind `strict: true` |
| Geometry | **Shapely**, **pyproj** | Geofence, no-fly, coverage, projected distance |
| Wide-area | **OpenCV**, **NumPy** | Difference, threshold, components |
| Hub | **FastAPI** + WebSocket | Controller protocol, live state, audit log |
| Console | **Vite + TypeScript**, **MapLibre GL JS** | Overview, Drone view, Manual Control |

### Stretch, only if someone is idle after hour 12

**ArduPilot SITL via the official Webots bridge** behind the same `Drone` interface, to restore the "real flight code" claim.
Undocumented on Apple Silicon.
Do not start it before the H12 gate passes.

### Skip list

**PX4 and Gazebo** (unstable on Apple Silicon, multi-vehicle Linux-only, no Webots bridge; see ADR 0001).
**ROS 2** (a day of setup for capability you will not demo).
**LangChain** (a framework's worth of abstraction over about 40 lines you would rather debug at 3 a.m.).
**Real satellite or aerial imagery** (Sentinel-2 cannot resolve vehicles at 10 m, NAIP has no before/after cadence; the overhead renders are honest and consistent with the drone's world).
**DroneKit-Python** (unmaintained).
**AirSim** (archived).
**Teleop that bypasses the Safety Validator** (it would undo the trust story).
Every one is a plausible-looking detour that costs half a day and buys nothing a judge will see.
