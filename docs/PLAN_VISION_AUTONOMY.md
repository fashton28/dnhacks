# Implementation plan: on-board computer vision and full autonomy

Two workstreams, run by two agents in parallel, joined by one contract they both depend on.
Workstream A gives the Drone real perception: detections with boxes, positions and temperatures from its own camera, live, without a model call per frame.
Workstream B removes the human from the loop where the human adds nothing: the system watches, judges, dispatches, re-tasks and reports on its own, and the Operator supervises with a veto instead of an approve button.

Everything below keeps the trust layer exactly as it is.
Autonomy decides more; it never bypasses the Safety Validator, the envelope, the hard stops or ArduPilot's fence.

## 0. The shared contract, built first (30 minutes, one agent, before the split)

A **Sighting** is one thing the Drone's perception saw in one frame, georeferenced.

```
Sighting
  id, drone_id, mission_id | null, ts
  label            vehicle | person | fire | smoke | steam | hot_spot | object | structure_damage | unknown
  confidence       0..1
  bbox             [x0, y0, x1, y1] in frame pixels
  frame_ref        evidence path when the frame was kept, else null
  camera_mode      rgb | thermal | lidar
  lat, lon         ground position of the box's foot point (camera pose ray cast to ground level)
  range_m          slant range to that point
  temp_max_c       peak temperature inside the box, thermal frames only
  source           perception | vision_model
```

- `contracts/models.py` gains `Sighting`; `contracts/protocol.py` gains an optional `temp_png_b64` on `Frame` (16-bit grayscale temperature map the Renderer emits with every thermal frame, one value per pixel).
- Live feed event `sighting` (one per Sighting) and `sightings` (a batch per frame), both in `trust_events`.
- `GET /sightings?since=` for reload; `POST /drones/{id}/scan` runs perception on the current frame without keeping evidence.
- Schemas regenerated; the dashboard session gets the event shapes the moment they exist.

Both agents code against this contract from minute one.
A stubs the producer, B stubs the consumer, and they meet in the Hub without touching each other's files.

## Workstream A: on-board computer vision (agent A)

Goal: the Drone perceives continuously and quantitatively, the way a real payload does, and the agent reasons over structured sightings instead of prose.

### A1. Radiometric thermal (1 hour)

The thermal renderer already computes a per-pixel temperature before it applies the palette.
Emit it: the Renderer attaches `temp_png_b64` to thermal frames, calibrated so 0 maps to -10 C and 1 maps to 700 C.
The Hub's `ThermalHotspot` detector thresholds the map, finds connected blobs, and produces `hot_spot` Sightings with `temp_max_c`, area in pixels and a box.
This is what makes "the bay saturates the sensor at 640 C" a measurement rather than a caption, and it is how the fire and steam cases become a number the report can cite.

Files: `console/src/vision/thermal.ts` (temperature readback), `console/src/main.ts` (frame message), `hub/perception/thermal.py`.

### A2. Plume and motion segmentation (1 hour)

`PlumeSegmenter`: in RGB, a tall low-saturation region rising from a bright or hot foot, split into `smoke` (dark, hot foot) and `steam` (bright, cool foot) using the thermal map when present.
`FrameDiff`: consecutive frames from the same pose, blocks that changed, for "something moved" cues during hover.
Both are numpy on the JPEG, no model, under 30 ms per frame.

Files: `hub/perception/plume.py`, `hub/perception/motion.py`.

### A3. Object detection with boxes (1.5 hours)

A real detector on the RGB feed for vehicles, people and objects.
Choice: `ultralytics` YOLOv8n on CPU, about 40 ms per 640 px frame on this machine, installed as an optional extra so the suite does not depend on torch.
The scene is low-poly, so verify on the rendered truck and person in the first 20 minutes; if recall is poor, fall back to the Renderer's instrumented boxes (it knows where every prop is and can project it to the frame) and label the source honestly as `renderer_truth`.
Either way the output is the same Sighting.

Files: `hub/perception/objects.py`, `console/src/main.ts` (instrumented boxes on request, fallback only).

### A4. Georeferencing (45 minutes)

Camera pose from the frame (position, heading, gimbal pitch, field of view) to a ray per pixel; intersect with ground level; produce lat, lon and slant range for each box's foot point.
Validated against the Scenario props, which have known positions: a Sighting of the fire must land within 5 m of the fire.

Files: `hub/perception/georef.py`, `tests/test_perception.py`.

### A5. Perception service and live overlay (1 hour)

`hub/perception/service.py` runs the detectors on every frame that reaches the Hub: evidence captures always, the live stream at 2 Hz while a Drone is airborne.
It publishes `sightings` events, stores them, and feeds them into the agent's tool results: `capture` and the new `scan` return structured sightings alongside the description, and `status` includes what is currently in view.
The Console draws the boxes and labels over the Drone view; the dashboard session does the same on its camera panel from the same event.

Files: `hub/perception/service.py`, `hub/server.py` (routes and wiring), `hub/agent_flight.py` (tool results), `console/src/main.ts` (overlay).

### A6. Tests and demo effect

Tests: hot spot on a synthetic temperature map, plume split on rendered fire and steam frames, georeferencing error against props, the perception service producing Sightings on a fake Drone dispatch.
Demo effect: boxes and temperatures appear on the live camera as the agent works; the report cites "hot spot 640 C at 41.20075, -98.39909" from a measurement, and the Sightings feed becomes the input Workstream B needs to act without an overhead pass.

Total: about 5.5 hours for one agent.

## Workstream B: full autonomy (agent B)

Goal: nobody clicks Dispatch.
The system watches the Site, decides when a change deserves a flight, chooses and tasks Drones, re-tasks on new information, and reports; the Operator supervises with a veto window and can always take a stick.

### B1. Autonomy modes and policy (45 minutes)

`AutonomyPolicy` in `hub/policy.py`, exposed on `/autonomy` and settable with `POST /autonomy/mode`:

- `manual`: today's behaviour, Dispatch is a click.
- `supervised`: the system dispatches on its own after a veto window (default 15 s) during which the dashboard shows the decision and a Hold button.
- `autonomous`: no window; the Operator is informed and can abort at any time.

Policy also carries the budgets the agent cannot exceed: dispatches per hour, concurrent flights, minimum battery to task a Drone, quiet hours for patrol.
Every automatic decision is a `decision` event with the rule or rationale, in `trust_events` and the audit log.

### B2. The Watch loop (1.5 hours)

`hub/watch.py`: a background task that keeps a baseline overhead image, captures a fresh pass every N seconds (default 60, configurable), runs the change detector, deduplicates against known Detections and props, and hands new Detections to triage without a click.
Triage already returns dispatch, log only or ignore with a rationale; in supervised or autonomous mode that decision executes itself.
The loop is idempotent: the same change is not re-dispatched while a Mission for it is in flight or was closed within a cooldown.

### B3. Drone-originated Detections (45 minutes)

Sightings from Workstream A that are not explained by the current Mission's target become Detections themselves: a Drone flying to a steam vent that sees a person in the switchyard creates a `person` Detection with a position, and the Watch loop triages it like any other.
This is the loop closing without the overhead pass, and it is what "the agents have their own judgment on when to act" means in practice.

### B4. Patrol (1 hour)

When idle and allowed by policy, one Drone flies a scheduled perimeter patrol inside a pre-approved envelope, perception running, and returns on its battery budget.
Patrol legs are a standard FlightPlan through the existing Mission runner, validated like everything else; the agent is not needed to fly a patrol, only to react to what it sees.

### B5. Re-tasking and multi-Drone response (1 hour)

The triage step gains an `escalation` field: `assets` (how many Drones), `hold_on_station` (keep one Drone watching after the report), `retask` (interrupt a lower-priority Mission).
For a confirmed fire the policy tasks a second Drone to hold at standoff and report spread every 60 seconds, while the first returns.
Implemented as a small scheduler over the existing dispatch path, so nothing new flies that the validator did not approve.

### B6. Operator supervision (45 minutes, Hub side)

Events: `decision` (what the system is about to do and why, with the veto deadline), `veto` (the Operator held it), `retask`.
Endpoints: `POST /decisions/{id}/hold`, `POST /decisions/{id}/release`.
The dashboard session renders the countdown, the Hold button and the mode switch from these; the Console shows the same in its log.

### B7. Tests and demo effect

Tests on the fake Drone: a Scenario runs, the Watch loop detects and dispatches with no request from the test, the flight completes and the report exists; a veto within the window stops the dispatch; the dispatch budget refuses a fourth dispatch in an hour; a Sighting of a person creates a Detection and a second Mission; a fire escalation tasks a second Drone.
Demo effect: the presenter runs the fire Scenario and takes their hands off the keyboard.
The system finds the change, decides, flies, confirms on thermal, escalates, tasks a second Drone to watch the bay, and writes the report, while the dashboard shows each decision as it is made and the presenter narrates.

Total: about 6 hours for one agent.

## Ownership, so the two agents never collide

| Agent A owns | Agent B owns | Shared, edited only in step 0 |
|---|---|---|
| `hub/perception/*`, `console/src/vision/*`, `console/src/main.ts` overlay and frame changes, `tests/test_perception.py` | `hub/watch.py`, `hub/policy.py`, `hub/scheduler.py`, `hub/autonomy.py` escalation and dispatch changes, `tests/test_watch.py`, `tests/test_policy.py` | `contracts/models.py` (Sighting, escalation fields), `contracts/protocol.py` (temperature map), `hub/server.py` route stubs for both |

`hub/server.py` after step 0: A adds only the perception routes and wiring, B adds only the autonomy routes and the Watch task start; both append, neither reorders.
`hub/agent_flight.py`: A edits the tool results only; B edits nothing there.
The dashboard stays with its own session; both agents send it event shapes, not code.

## Order and checkpoints

1. Step 0 contract, one commit, pushed, both agents start.
2. Hour 2 checkpoint: A has thermal hot spots as Sightings on a fake Drone; B has the Watch loop dispatching in supervised mode on a fake Drone.
3. Hour 4 checkpoint: A has boxes on the live camera; B has veto, budgets and drone-originated Detections.
4. Hour 6: live rehearsal of the hands-off fire demo on the real fleet; both agents fix what it exposes.

## Risks and the honest answer to each

- YOLO on low-poly renders may miss: the instrumented-box fallback keeps the pipeline and the demo intact, labelled as renderer truth.
- Torch adds a heavy dependency: optional extra, never imported by the test suite.
- An autonomous system can dispatch on noise: dedupe, cooldown and budgets are policy, tested, and the veto window is the default mode for the demo.
- The API balance: every model call already degrades to rules; the Watch loop and perception are model-free by design, so hands-off autonomy works with the API down.
