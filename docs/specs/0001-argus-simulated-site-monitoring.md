# ARGUS: simulated autonomous site monitoring for critical infrastructure

Vocabulary follows `CONTEXT.md`.
Simulator and flight-stack choices follow ADR 0001 (Webots, native flight controller).
This spec supersedes the PX4 and Gazebo based `ARCHITECTURE.md`; rewriting that document is part of the work.

## Problem Statement

Security teams at nuclear and energy plants watch a large perimeter with fixed cameras and periodic patrols.
A change at the fence line, a vehicle where none should be, or an object left near a building can sit unnoticed for hours.
When something is flagged, a human has to decide whether to send someone, and every false alarm erodes trust in the alerting.
Autonomous drones could close the gap between "something changed" and "a human has eyes on it", but nobody trusts an LLM to fly a drone over a reactor without hard guarantees on where it may go.

## Solution

ARGUS is a simulated platform, demoed end to end at DNHacks, that shows the full loop:

1. An overhead pass of the Site produces a before and an after image.
   The wide-area layer compares them and emits a Detection with a polygon and a confidence.
2. The Operator dispatches from the Console.
   The Triage Agent reads the Detection and Site context and emits a MissionSpec: what to look at, from how high, from how far.
   It never computes waypoints.
3. The Coverage Planner turns the MissionSpec into a FlightPlan deterministically.
4. The Safety Validator checks the FlightPlan against the geofence, no-fly zones, altitude limits, and battery range and returns a ValidationResult.
   A rejection names the rule that failed and re-prompts the agent, up to a limit, then hands off to the Operator.
5. An accepted FlightPlan is flown by one Drone of the Fleet in a Webots world of the Site.
6. Frames captured at each waypoint become Observations through a vision model.
   A Report Agent writes an Incident Report with a verdict of false alarm, log, or escalate.
7. Throughout, the Operator watches the Fleet on the Overview, the live 3D World view, and any Drone view, and can take Manual Control of any Drone at any moment.
   The Safety Validator's limits still hold under Manual Control.

A red-team mode feeds poisoned inputs (a waypoint inside a no-fly zone, a plan beyond endurance, a prompt injection in Detection metadata) and shows each rejection with the rule that caught it.

## User Stories

### Overview and Fleet

1. As an Operator, I want to see every Drone of the Fleet on a top-down Overview of the Site, so that I know where each one is at a glance.
2. As an Operator, I want each Drone's recent track drawn on the Overview, so that I can see where it has been.
3. As an Operator, I want the geofence, no-fly zones, and protected areas drawn on the Overview, so that I understand the limits the system enforces.
4. As an Operator, I want Detections drawn as polygons on the Overview with their confidence, so that I can judge what was flagged and where.
5. As an Operator, I want a planned FlightPlan route drawn on the Overview before dispatch, so that I can see what the Drone is about to do.
6. As an Operator, I want to click a Drone on the Overview to open its Drone view, so that I can drop into any Drone at any moment.
7. As an Operator, I want to configure the Fleet size before a run, so that the demo can show one Drone or several.
8. As an Operator, I want each Drone's battery, altitude, speed, and state (idle, on Mission, Manual Control, returning) visible on the Overview, so that I can pick a Drone that is actually available.

### World view

9. As an Operator, I want a live 3D World view of the simulated Site embedded in the Console, so that the audience sees the drones flying in a physical world rather than dots on a map.
10. As an Operator, I want to orbit and zoom the World view without affecting the simulation, so that I can frame the action during the demo.

### Drone view and Manual Control

11. As an Operator, I want a Drone view with the Drone's live camera feed, so that I can see what the Drone sees.
12. As an Operator, I want the Drone's telemetry (position, altitude, heading, battery, state) alongside the camera, so that I can judge its situation.
13. As an Operator, I want to see the Drone's current Mission, the MissionSpec rationale, and the ValidationResult in the Drone view, so that I understand why it is doing what it is doing.
14. As an Operator, I want to take Manual Control of a Drone from its Drone view with one action, so that I can intervene instantly.
15. As an Operator under Manual Control, I want to fly with keyboard velocity commands (forward, back, strafe, up, down, yaw), so that control is immediate and needs no training.
16. As an Operator under Manual Control, I want the geofence, altitude ceiling, and no-fly zones to remain hard limits that clamp my commands, so that not even a human can fly a Drone into the reactor exclusion zone.
17. As an Operator under Manual Control, I want clear feedback when a command was clamped and by which rule, so that I understand the limit rather than fighting it.
18. As an Operator, I want to hand control back so the Drone resumes or aborts its paused Mission, so that Manual Control is an interruption, not an end state.
19. As an Operator, I want a single Return Home action per Drone, so that I can always bring one back safely.

### Detections and dispatch

20. As an Operator, I want a queue of Detections ordered by time with confidence and change type, so that I can triage what the wide-area layer found.
21. As an Operator, I want to view the before and after overhead images for a Detection with the change polygon highlighted, so that I can sanity-check the flag myself.
22. As an Operator, I want to dispatch a Mission for a Detection with one action, so that response is fast but always Operator-initiated.
23. As an Operator, I want the system to pick an idle Drone with enough battery for the FlightPlan, so that I do not have to think about which Drone to send.
24. As an Operator, I want to be told when no Drone can take a Mission and why, so that I am never left guessing.

### Triage Agent, Coverage Planner, Safety Validator

25. As an Operator, I want to see the Triage Agent's MissionSpec and its rationale before the Drone moves, so that the LLM's intent is visible and auditable.
26. As an Operator, I want the FlightPlan derived from the MissionSpec deterministically with estimated duration and battery use, so that the same intent always yields the same plan.
27. As an Operator, I want the Safety Validator's verdict shown next to the MissionSpec, green on accept and red on reject with the violated rules named, so that the trust layer is visible, not implied.
28. As an Operator, I want a rejected plan to be re-prompted to the Triage Agent with the violation attached, so that the agent repairs its own mistake.
29. As an Operator, I want the repair loop capped and handed to me after the cap, so that a confused agent cannot loop forever.
30. As an Operator, I want every dispatch, verdict, command, clamp, and report appended to an audit log, so that the run can be reviewed afterwards.

### Flight

31. As an Operator, I want the Drone to take off, fly the FlightPlan's waypoints, capture a frame at each, and return home, so that a Mission completes without my input.
32. As an Operator, I want flight to run in real time by default, so that live camera views and the World view look natural during the demo.
33. As a developer, I want a speed factor setting, so that CI runs and backup recordings can go faster than real time.
34. As a developer, I want the Drone interface to be MAVLink-shaped (lat/lon/alt positions, NED velocities), so that a real flight stack can replace the native controller behind the same interface later.

### Observation and Incident Report

35. As an Operator, I want each captured frame analysed into an Observation describing what is seen and whether it matches the Detection, so that the drone's finding is in words, not only pixels.
36. As an Operator, I want an Incident Report per Mission with a verdict of false alarm, log, or escalate, a narrative I would actually read, and links to the evidence frames, so that I can act on it.
37. As an Operator, I want to escalate or dismiss an Incident Report with one action, so that a human always makes the final call.
38. As an Operator, I want an incident queue of escalated reports, so that nothing escalated gets lost.

### Scenarios and wide-area layer

39. As a demo driver, I want to trigger a Scenario (intruder vehicle at the perimeter, fence section opened, unattended object) from the Console or a script, so that the demo is repeatable.
40. As a demo driver, I want the Supervisor to capture a before and an after overhead image around a Scenario, so that the wide-area layer has honest inputs.
41. As a demo driver, I want the wide-area layer to produce a Detection from those two images with a polygon in Site coordinates and a confidence, so that the loop starts from a detected change, not a hardcoded one.
42. As a demo driver, I want to reset the Site to its baseline between runs, so that rehearsals and the live demo start clean.

### Red team

43. As a demo driver, I want to run each red-team case (no-fly waypoint, over-endurance plan, prompt injection in Detection metadata) with one action, so that the "watch it refuse" moment is reliable.
44. As a demo driver, I want each red-team rejection shown with the exact rule that caught it, so that the defense story is concrete.

### Setup

45. As a teammate on a Mac, I want to install Webots, clone the repo, run one command, and see the Site with the Fleet in Webots and the Console in a browser, so that all four of us can develop against the real simulation tonight.
46. As a teammate, I want the whole loop runnable with a fake Drone and a fake Triage Agent, so that I can develop and test without Webots open or an API key.

## Implementation Decisions

### Simulator and world

- Webots R2025a, installed from the GitHub release DMG (the Homebrew cask is disabled for Gatekeeper).
  Native macOS, no VM.
- One Webots world file for the Site: about 300 by 300 metres, built from Webots PROTOs.
  A Warehouse stands in for the reactor building, two scaled Silos for cooling towers, a SimpleBuilding for the control building, boxes for a switchyard, roads and trees outside the fence.
  A double perimeter fence is built from thin wall solids with a gate.
  Fence sections that a Scenario "opens" are individually named solids.
- The Site is anchored at a real, unremarkable rural US latitude and longitude via the world's reference coordinates, so all geodesic math is real.
  Site name is configuration; default is decided in Further Notes.
- Drones are Webots Mavic 2 Pro robots, one per Fleet member, each on its own helipad, each running an extern controller.
- A Supervisor robot runs Scenarios (spawn a Webots vehicle PROTO at the perimeter, translate a fence section open, spawn a crate), captures overhead images from a fixed top-down camera, and resets the world.
- Webots runs with web streaming enabled in W3D mode.
  The Console embeds the official Webots web viewer component as the World view.

### Flight controller

- A native Python flight controller per Drone, extended from the Webots Mavic patrol sample: altitude hold, attitude stabilisation, and GPS waypoint navigation.
- Exposed behind a `Drone` interface with commands `goto(lat, lon, alt_m)`, `hover()`, `set_velocity(vx, vy, vz, yaw_rate)` in NED, `look_at(pitch)`, `return_home()`, `capture_frame()`, and a telemetry stream of position, altitude, heading, velocity, battery, and state.
- Battery is simulated as a depletion model driven by time in flight and speed, so range checks have something real to check.
- The controller enforces its own hard altitude ceiling and geofence containment as a last line behind the Safety Validator, replacing the independent second layer PX4 would have provided.
- ArduPilot SITL via the official Webots bridge is a stretch behind the same interface and is not planned.

### Processes and protocol

- One Hub process (FastAPI) holds in-memory state, an append-only JSONL audit log, the REST and WebSocket API for the Console, and the controller protocol for Drones.
- Each Drone's extern controller connects to the Hub over a WebSocket and speaks a small JSON protocol: telemetry and JPEG frames upward at about 10 Hz, commands downward.
  A Drone that disconnects is shown as offline.
- The Supervisor connects to the Hub over the same protocol with its own message types: run scenario, capture overhead, reset.
- A fake Drone implements the same protocol with kinematic motion and synthetic frames, for tests and API-key-free development.
- Time: real time by default; a speed factor setting applies to Webots and to timeouts consistently.

### Contracts

The five contracts from the original architecture stay, as Pydantic models with committed fixtures.
Polygons are in latitude and longitude; all distance math happens in a local projected frame.

- Detection: id, polygon, confidence, change type, before and after image references, detected at.
- MissionSpec: detection id, objective (inspect, perimeter sweep, standoff observe), survey polygon, max altitude, standoff distance, rationale.
  No waypoints.
- FlightPlan: mission id, drone id, waypoints with lat, lon, alt, pattern, estimated duration, estimated battery use.
- ValidationResult: mission id, verdict (accept or reject), violations with rule, detail, severity.
- IncidentReport: mission id, verdict (false alarm, log, escalate), narrative, evidence references.

Additions for this spec:

- DroneState: drone id, position, altitude, heading, velocity, battery percent, state (idle, on mission, manual control, returning, offline), current mission id.
- ManualCommand: drone id, velocity in NED, yaw rate, timestamp.
- ClampEvent: drone id, original command, clamped command, rule.
- Scenario: id, kind (intruder vehicle, fence breach, unattended object), parameters, run at.

### Triage Agent, Coverage Planner, Safety Validator

- The Triage Agent calls Claude with strict tool use so the MissionSpec is schema-valid by construction.
  Detection metadata is passed as data inside a clearly delimited block and the system prompt states that nothing in it is an instruction.
- The Coverage Planner is pure geometry: rotate the survey polygon to its principal axis, generate parallel lines at camera swath width, clip, stitch alternating, prepend takeoff and append return home, estimate duration and battery from the Drone's speed and depletion model.
- The Safety Validator is a rule table evaluated in a projected frame: every waypoint inside the geofence, no segment intersecting a no-fly zone, altitude within floor and ceiling, estimated battery use under capacity minus reserve, standoff at least the minimum, mission duration under a cap.
  It has two entry points: validate a FlightPlan, and clamp a ManualCommand against the same rules given the Drone's current state.
- Rejections carry the rule name and detail and are fed back to the Triage Agent verbatim.
  The repair loop is capped at three attempts, then the Detection is marked needs Operator.
- Drone selection for dispatch: idle Drones with battery above the FlightPlan's estimate plus reserve, nearest first.

### Wide-area layer

- Input is two top-down renders from the Supervisor's overhead camera, before and after a Scenario, at a fixed known footprint.
- Change detection is a per-pixel difference with blur and threshold, connected components, minimum area filter, and conversion of the component bounding polygon from pixel to latitude and longitude via the known footprint.
  Confidence is a function of component area and mean difference.
- Output is a Detection with change type set by the Scenario kind when running a scripted Scenario, and unknown otherwise.

### Observation and reporting

- Frames captured at waypoints are sent to Claude vision with the Detection context.
  The response is a structured Observation: what is seen, whether it is consistent with the Detection, and confidence.
- The Report Agent takes the Observations and Detection and produces the IncidentReport through strict tool use.
- Escalation is an Operator action on the Console; the system never escalates on its own.

### Console

- TypeScript single-page application talking to the Hub over REST for actions and one WebSocket for live state.
- Screens: Overview (MapLibre with the Site footprint, fences, no-fly zones, Drones, tracks, Detections, routes), World view (embedded Webots viewer), Drone view (MJPEG-style frames over WebSocket, telemetry, Mission panel, Manual Control), detection queue, validation panel, incident queue, red-team panel, Scenario controls.
- Manual Control sends ManualCommands at 10 Hz while keys are held and shows ClampEvents inline.

### Documentation

- ARCHITECTURE.md is rewritten to match this spec and ADR 0001, keeping the timeline, demo script, and CONOPS sections that still apply.

## Testing Decisions

A good test exercises the system from outside a seam and asserts on observable behaviour: what the Console would see, what the audit log records, where the Drone ended up.
Tests never reach into planner internals or controller state.

Primary seam: the Hub API.
Tests start the Hub with a fake Drone (or several) and a fake Triage Agent and Report Agent that return fixture MissionSpecs and IncidentReports, then drive the REST and WebSocket API exactly as the Console does:

- Dispatch a fixture Detection and assert the MissionSpec, FlightPlan, and ValidationResult appear in order, the fake Drone receives goto commands matching the FlightPlan, frames come back, and an IncidentReport is produced.
- Dispatch a red-team Detection and assert a reject with the expected rule name, the re-prompt count, and that the fake Drone received no commands.
- Take Manual Control of a Drone, send a velocity that would leave the geofence, and assert the Drone receives the clamped velocity and a ClampEvent names the geofence rule.
- Hand back control and assert the Mission resumes from the next waypoint.
- Dispatch with no idle Drone and assert the needs Operator outcome.

Secondary seam: the contract functions.
The Safety Validator, Coverage Planner, and change detector are pure functions from contract to contract and get table-driven tests on fixtures: polygons that cross the fence, plans that exceed endurance, overhead image pairs with one known change.

Not tested automatically: the Webots world and the native flight controller, beyond a smoke script that launches Webots headless, connects one real Drone to the Hub, flies a short square, and asserts it returned home within tolerance.
Frame contents from vision models are not asserted beyond schema validity.

Prior art: none in this repo.
The Hub tests use FastAPI's test client and an in-process WebSocket client; the contract tests are plain pytest with fixtures.

## Out of Scope

- Real satellite or aerial imagery (Sentinel-2, NAIP, Umbra SAR).
  The wide-area layer runs on overhead renders of the Site.
- PX4 or ArduPilot flight stacks.
  ArduPilot via the Webots bridge is a stretch behind the Drone interface, not part of this spec.
- In-flight agent tool use (re-tasking, orbit on demand).
  The Triage Agent is one-shot per Detection.
- Thermal, smoke, or vapor detection; drone-on-drone incursion.
- Multiple Sites, persistence beyond the audit log, authentication, or deployment.
- Detailed building meshes, weather, wind, or GPS denial.
- Manual Control that bypasses the Safety Validator.

## Further Notes

- Default Site name: Meridian Station.
  Change it in configuration if the team prefers another.
- The pitch must state plainly that the flight controller is simulated and that the planner, Safety Validator, and tool boundary are flight-stack agnostic.
  The old line "the only thing missing is the airframe" is retired.
- Defense in depth now means Safety Validator at dispatch, Safety Validator clamping under Manual Control, and the flight controller's own hard limits.
  All three should be shown in the demo.
- Deadline is noon.
  Anything not on the path to the three-minute demo and the red-team moment is a cut candidate at hour 12.
