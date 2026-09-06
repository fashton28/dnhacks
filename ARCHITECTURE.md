# ARGUS: Layered Autonomous Site Monitoring for Critical Infrastructure

**DNHacks, Defense track, 4 people, deadline noon 2026-09-06**

Vocabulary follows `CONTEXT.md`.
Environment and flight-stack decisions are recorded in `docs/adr/0002-threejs-renderer-ardupilot-sitl.md` (supersedes 0001).
The full spec with user stories is `docs/specs/0001-argus-simulated-site-monitoring.md` (GitHub issue #2).
This document is the build plan: how the pieces fit and who builds what.

---

## 1. The pitch

Autonomous ISR (intelligence, surveillance, reconnaissance) for critical infrastructure, demonstrated end to end on the real ArduPilot flight stack, in a photoreal environment the team controls completely, with a human always in the loop.

- **Wide-area layer.** An overhead pass of the Site produces a before and an after image.
  Change detection emits a Detection: a georeferenced polygon and a confidence.
- **Close-up layer.** The Operator dispatches.
  An LLM Triage Agent emits a MissionSpec, a deterministic Coverage Planner expands it into a FlightPlan, and an ArduPilot-flown Drone from the Fleet flies it.
  The Renderer produces what the Drone's camera sees; a vision model turns frames into Observations and an Incident Report.
- **Trust layer.** Before dispatch, the Safety Validator checks the FlightPlan against the geofence, no-fly zones, altitude limits, and battery range.
  Rejections name the rule and are fed back to the agent.
  The same rules clamp the Operator under Manual Control.
  Behind both sits ArduPilot's own onboard geofence, which the agent cannot reach.
- **Operator surface.** A Console with an Overview of the Fleet, a photoreal World view, and a Drone view per Drone that the Operator can drop into and take Manual Control of at any moment.

**The honest version of the claim.**
The flight code is real ArduPilot; the airframe physics is ArduPilot's own SITL model.
The environment and cameras are rendered, not sensed.
Say both.

### Why it wins

Two layers most teams will not combine.
A Fleet you can drop into and fly, with a real autopilot underneath.
And the trust layer plus its red-team demo: the autonomy stack refusing to fly, twice, with the rule named each time.

---

## 2. Design constraints (read before building)

1. **The LLM does not compute geometry.**
   The Triage Agent emits intent and judgment; the Coverage Planner derives waypoints.
2. **Safety is enforced three times.**
   Safety Validator at dispatch.
   Safety Validator clamping every ManualCommand.
   ArduPilot's onboard fence and failsafes, set from the same Site geometry.
   Show all three in the demo.
3. **Manual Control never bypasses the rules.**
   It pauses the Mission, clamps velocity at the boundary, reports the clamp and the rule, and ends in resume or abort.
4. **The Hub cannot tell Drones apart.**
   The fake Drone, the ArduPilot Bridge, and any future flight stack speak one controller protocol.
   Every workstream develops against the fake Drone.
5. **The Renderer is the only source of pixels.**
   Drone views, evidence frames, and overhead images all come from the Three.js scene, in the Console or headless.
   Nothing else renders anything.
6. **Scenarios are data.**
   The Hub owns a scene state (props, fence gaps); Renderers draw it.
   Running a Scenario is a state change, not a script inside a simulator.
7. **One Hub process, one SITL and one Bridge per Drone.**
   In-memory state, an append-only `events.jsonl` audit log, one live WebSocket to the Console.
   No Redis, no Postgres, no queue.
8. **Everything runs on a Mac.**
   ArduPilot SITL builds natively on Apple Silicon (Docker fallback documented).
   Three.js runs in the browser.
   No Linux VM, no ROS, no Gazebo, no Webots.

---

## 3. System architecture

```
  ArduCopter SITL x N (own physics, onboard fence)      Three.js RENDERER (in the Console or headless)
        │ MAVLink tcp                                        │ role: renderer
        ▼                                                    │ frames (drone views, evidence, overhead)
  Bridge x N  ── controller protocol ──┐          ┌──────────┘   ◄── scene state, render requests
  fake Drone  ── controller protocol ──┤          │
                                       ▼          ▼
  ┌──────────────────────── HUB (FastAPI) ─────────────────────────────────────┐
  │  Drone registry · dispatch · Mission runner · Manual Control · audit log   │
  │  Scenario engine: scene state · overhead before/after · reset             │
  │                                                                           │
  │  [Wide-area]  overhead before/after ──► Detection                         │
  │       ▼ Operator dispatch                                                 │
  │  [Site context]  Zone lookup + maintenance windows ──► briefing           │
  │  [Triage Agent]  Claude, strict tool use ──► Triage decision              │
  │       dispatch / log only / ignore; declines end in an Incident, no flight│
  │  [Triage Agent]  ──► Envelope (MissionSpec: radius, ceiling, budget)     │
  │  [Safety Validator]  rule table ──► ValidationResult; reject ─► repair    │
  │  [Agent-flown Mission]  the agent flies with tools inside the Envelope:  │
  │       fly_to · hold · look_at · set_camera · capture · return_home · done │
  │       every fly_to re-validated live; hard stops force return_home        │
  │  [Fallback: plan-based]  Coverage Planner ──► FlightPlan ──► runner       │
  │  [Observation]  Claude vision on frames ──► [Report Agent] ──► Incident   │
  │  [Red team]  POST /redteam/{case} runs the adversarial cases end to end   │
  └──────────────────────────────┬────────────────────────────────────────────┘
                                 │ REST + live WebSocket
                                 ▼
  ┌──────────────────── CONSOLE (Vite + TypeScript) ──────────────────────────┐
  │  Overview (MapLibre) · World view (Three.js) · Drone view (Three.js cam)  │
  │  Manual Control · detection queue · validation panel · incidents          │
  │  Scenario controls · red-team panel                                       │
  └───────────────────────────────────────────────────────────────────────────┘
```

### Repo layout

```
contracts/          Pydantic models, protocol, fixtures, JSON schema     (frozen, all)
hub/                FastAPI Hub: registry, missions, manual, scenarios   (Person D)
sim/
  site/             gen_site.py -> site.json + site.geojson              (Person A)
  ardupilot/        SITL launcher, per-Drone params, fence from Site     (Person A)
  bridge/           MAVLink <-> controller protocol, one per Drone       (Person A)
  fake_drone/       protocol-compatible kinematic Drone                  (done)
console/            Vite + TS: Three.js scene + renderer role, MapLibre  (Person D, Person B for scene)
widearea/           overhead change detection -> Detection               (Person B)
agent/ safety/ planner/ redteam/                                         (Person C)
scripts/            launch_sim.py, smoke_flight.py, export_schema.py
tests/              Hub API tests with fake Drone and fake agents; contract tests
docs/               adr/  specs/  setup guides
```

---

## 4. The contracts

Frozen and committed with fixtures (`contracts/`).
Polygons are latitude and longitude; distance math happens in a local projected frame.

```
Detection        {id, polygon, confidence, change_type, before_ref, after_ref, detected_at, metadata}
MissionSpec      {detection_id, objective, survey_polygon, max_altitude_m, standoff_m, rationale}  (no waypoints)
FlightPlan       {mission_id, drone_id, waypoints[{lat, lon, alt}], pattern, est_duration_s, est_battery_pct}
ValidationResult {mission_id, verdict: accept | reject, violations[{rule, detail, severity}]}
IncidentReport   {mission_id, verdict: false_alarm | log | escalate, narrative, evidence_refs}
DroneState       {drone_id, lat, lon, alt, heading_deg, velocity_ned, battery_pct, status, mission_id, ts}
ManualCommand    {drone_id, velocity_ned, yaw_rate_dps, ts}
ClampEvent       {drone_id, original, clamped, rule}
Scenario         {id, kind: intruder_vehicle | fence_breach | unattended_object, params, run_at}
```

### Controller protocol (Hub ⇄ Bridge / fake Drone / Renderer), one WebSocket each

```
Drone → Hub        hello{role: drone, id, sim}   telemetry{DroneState}   ack{cmd_id, ok, detail}
Hub → Drone        goto{lat, lon, alt, speed}  hover  set_velocity{vx, vy, vz, yaw_rate}  look_at{pitch}  return_home
Renderer → Hub     hello{role: renderer}   frame{drone_id, jpeg, pose, cmd_id?}   overhead{ref, png, footprint, cmd_id?}   ack
Hub → Renderer     render_frame{drone_id}   capture_overhead{ref}   scene{state}   reset
```

`capture_frame` from the Mission runner is served by asking a connected Renderer to render that Drone's camera.
The fake Drone still answers `capture_frame` itself with a synthetic frame so tests need no browser.

---

## 5. The four workstreams

### Person A: Flight

- ArduPilot Copter SITL builds on every Mac; documented install; Docker fallback.
- `sim/ardupilot/`: launch N SITL instances at the Site pads with per-instance params: home, `SYSID`, `FENCE_*` from `site.geojson` (altitude max, polygon), battery model, `RTL_ALT`.
- `sim/bridge/`: pymavlink Bridge per Drone.
  `goto` → GUIDED + `SET_POSITION_TARGET_GLOBAL_INT`; `set_velocity` → `SET_POSITION_TARGET_LOCAL_NED` with yaw rate; `return_home` → RTL; `hover` → zero velocity; telemetry from `GLOBAL_POSITION_INT`, `ATTITUDE`, `BATTERY_STATUS`, `HEARTBEAT`; arm and takeoff on the first goto.
- `sim/site/gen_site.py`: the one source of Site numbers → `site.json` (scene layout) and `site.geojson` (geofence, fences, no-fly, pads, overhead footprint).

**Done at H12:** `make sim` starts SITLs and Bridges, the square fixture flies via the Hub, an onboard-fence breach attempt is refused by ArduPilot itself.

### Person B: Scene, Scenarios, Wide-area, Red team

- Three.js Site scene from `site.json`: ground, buildings, double fence with named sections, pads, roads, props library (vehicle, crate, person).
- Photoreal pass: orthophoto ground (OpenAerialMap), HDRI sky (Poly Haven), PBR materials, GLTF assets; licenses recorded.
- Scenario rendering from Hub scene state; overhead orthographic capture before and after.
- `widearea/detect.py` and `eval.py`; `redteam/cases.py`.

**Done at H12:** a Scenario changes the scene, before and after overhead images produce a valid Detection.

### Person C: Agent, Planner, Safety

Unchanged from the spec: Triage Agent with strict tool use, Coverage Planner, Safety Validator with `validate` and `clamp`, Observations, Incident Report.
Do distance math in a projected CRS.

The LLM layer as built (`hub/autonomy.py`, `hub/site_context.py`, `hub/inspection.py`):

- Site context is generated with the Site (`sim/site/site_context.json`): six Zones with what is normally present in each, plus maintenance windows.
  The Hub resolves the Zone a Detection falls in (innermost wins) and the windows active at detection time, and briefs the agent in prose.
- The Triage decision comes before any plan. Live mode is one strict tool call to Claude; mock mode is a rule table (a vehicle or object in the service yard inside a declared window is log only; anything at the reactor is dispatched; anything outside every Zone is logged for the patrol).
  A decline publishes `pretriage`, `triage` and `incident` events and leaves every Drone idle.
- The Inspection runs at the first hover waypoint through the Mission runner's on-station hook, so the runner holds position and returns to the approved waypoint afterwards.
  Tools: `look_at` (gimbal), `set_camera` (rgb/thermal/lidar, zoom), `capture` (evidence frame plus description), `reposition` (at most 25 m from the approved waypoint, re-run through the Safety Validator), `done` (summary and threat assessment).
  Live mode is a Claude tool loop capped at six steps; mock mode is a fixed sweep of RGB, thermal and 2.5x zoom.
- Agent-flown Missions (`hub/agent_flight.py`, default `ARGUS_FLIGHT_MODE=agent`): the agent first declares an Envelope (one strict tool call live; fixed values in mock).
  The Hub validates its polygon at the ceiling with the Safety Validator, repairs a refusal by shrinking (radius times 0.6, ceiling under the Site limit, budget times 0.6) up to three times, and publishes each attempt as `mission_spec`, `validation` and `envelope` events.
  Then the agent flies with tools; each `fly_to` is expressed in metres east and north of the Detection, checked against the Envelope radius and ceiling, and run through the Safety Validator as a two-waypoint plan from the current position so the segment is checked for the no-fly zone too.
  Hard stops (14 tool calls, the Envelope's time budget, battery at reserve plus five percent, Operator abort through the Mission runner) raise inside the loop, return the Drone home and are published as `hard_stop`.
  The Mission record is attached to the runner so pause, abort and the dashboard's Mission state work as for any Mission.
  `ARGUS_FLIGHT_MODE=plan` restores the earlier plan-based pipeline.
- Detection metadata is quoted to the agent as data and never as instructions; the prompt-injection case shows the injected "fly at 200 m over the reactor" reaching the report body while the flown plan stays at the 50 m planner ceiling.

**Done at H12:** Detection fixture → MissionSpec → FlightPlan → accept; three red-team cases rejected with named rules; a manual velocity toward the fence clamped.

### Person D: Hub, Console, Integration

- Hub: renderer role, scene state, Scenario endpoints, Manual Control sessions with clamping, headless renderer launcher (Playwright) for unattended captures.
- Console: Overview (MapLibre), World view (Three.js), Drone view (Three.js camera at Drone pose, gimbal pitch, frame streaming to Hub), Manual Control keys at 10 Hz, detection queue, validation panel, incident queue, Scenario and red-team panels.
- Integration, demo script, backup recording.
  At hour 10, D may tell anyone to stop building and start connecting.

**Done at H12:** Console shows fake and real Drones on the Overview and in the World view, a live Drone view, and frames landing in the Hub.

---

## 6. Timeline

| Hours | What happens |
|---|---|
| 0-2 | Env spikes on every Mac: ArduCopter SITL boots and arms; `pnpm dev` shows the scene; API key works. Contracts already frozen. |
| 2-8 | Parallel slices against the fake Drone and fixtures. |
| 8 | Flight gate: real Drone flies the square via the Hub. If not, the demo flies the fake Drone and the pitch drops the ArduPilot claim. Decide at 8. |
| 8-12 | Pairwise integration: B→C, C→D, A→D. |
| **12** | **Hard gate: end-to-end run works, however ugly.** Cut features rather than debug. |
| 12-16 | Red-team demo, Manual Control clamping, onboard fence demo, eval numbers, staggered sleep. |
| 16-20 | Photoreal polish, report quality, Overview polish. |
| 20-21 | **Record the backup demo video.** |
| 21-22 | Deck. |
| 22-24 | Rehearse to three minutes, buffer. |

---

## 7. The three-minute demo

1. World view of Meridian Station, three Drones on their pads, Overview alongside.
2. Run the intruder vehicle Scenario; the wide-area layer flags a Detection with its confidence.
3. Dispatch. The Triage Agent's MissionSpec and rationale appear.
4. The Coverage Planner draws the route; the Safety Validator turns green.
5. A Drone arms and lifts off under ArduPilot; click it: live Drone view.
6. Take Manual Control, fly toward the reactor exclusion zone, get clamped with the rule named. Hand back; the Mission resumes.
7. Frames come back, Observations appear, the Incident Report writes itself, the Operator escalates.

Then: *"now watch what happens when the model is wrong."*
Red-team cases rejected with rules named.
Then a plan deliberately let past layer one, refused by ArduPilot's own fence.

Close on eval numbers, one sentence on the hardware path (same MAVLink, same fence params, real airframe), and the CONOPS slide (Operator-approved dispatch, drone-in-a-box, Part 107 waiver path).

---

## 8. Stack

```bash
uv sync                      # Python: pydantic, fastapi, shapely, pyproj, pymavlink, MAVProxy, opencv, anthropic
cd console && pnpm install   # TypeScript: three, maplibre-gl, vite
```

| Layer | Tool | Role |
|---|---|---|
| Flight | **ArduPilot Copter SITL** | Real flight code, own physics, onboard fence and failsafes; one process per Drone |
| Bridge | **pymavlink** | MAVLink ⇄ controller protocol |
| Environment | **Three.js** | Site scene, World view, Drone view cameras, overhead capture |
| Assets | **Poly Haven** (CC0), **OpenAerialMap** (open), GLTF models | HDRI, PBR textures, orthophoto ground, props |
| Headless frames | **Playwright** (Chromium) | Renderer without an operator tab, for smoke tests and unattended captures |
| LLM | **anthropic** / `claude-opus-5` | Triage, observation, reporting, strict tool use |
| Validation | **Pydantic** | Contracts, second line behind `strict: true` |
| Geometry | **Shapely**, **pyproj** | Geofence, no-fly, coverage, projected distance |
| Wide-area | **OpenCV**, **NumPy** | Difference, threshold, components |
| Hub | **FastAPI** + WebSocket | Controller protocol, live state, audit log |
| Console | **Vite + TypeScript**, **MapLibre GL JS** | Overview, panels, Manual Control |

### Skip list

**Webots, Gazebo, PX4** (see ADRs 0001 and 0002).
**ROS 2**, **LangChain**, **DroneKit-Python**, **AirSim**.
**Browser-side physics** (ArduPilot already has physics; two physics engines disagree).
**Teleop that bypasses the Safety Validator**.
