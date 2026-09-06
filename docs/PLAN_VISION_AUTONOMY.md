# Implementation plan: on-board vision and autonomy, simplified for the demo

Two agents, two workstreams, one shared contract each, and nothing the trust layer does not already check.

## Workstream A: on-board vision (agent A, about 2.5 hours)

The Drone measures instead of describing, and what it measures is drawn on the camera and handed to the agent as data.
No neural network, no torch: the thermal camera already computes a temperature for every pixel, and the plume shapes are simple to segment.
Semantics (what is that object) stay with the vision model, which already works.

### A1. Radiometric thermal (1 hour)

The Renderer attaches a per-pixel temperature map to every thermal frame (16-bit grayscale, calibrated: 0 maps to -10 C, 1 maps to 700 C).
The Hub thresholds it, finds blobs, and produces `hot_spot` Sightings with the peak temperature, the box and the area.
The fire is now "640 C at bay 2" as a measurement, and the steam vent is "46 C", from the same sensor.

### A2. Smoke versus steam (30 minutes)

In the RGB frame a tall low-saturation column rising from a foot; the foot's temperature in the thermal map decides `smoke` (hot foot) or `steam` (cool foot).
Numpy on the frame, under 30 ms.

### A3. Georeferencing and overlay (1 hour)

Camera pose (position, heading, gimbal pitch, field of view) casts each box's foot pixel to ground level: lat, lon, slant range.
Sightings are published live; the Console and the dashboard draw the boxes with the label and the temperature over the camera; the agent's `capture` and `status` tool results carry them as structured data, so its report cites a measurement.
Validated against the Scenario props, whose positions are known: a fire Sighting must land within 5 m of the fire.

### Contract

```
Sighting: id, drone_id, mission_id, ts, label (hot_spot | smoke | steam), confidence,
          bbox [x0, y0, x1, y1], camera_mode, lat, lon, range_m, temp_max_c, frame_ref
Frame gains optional temp_png_b64 (thermal frames only).
Events: sightings (per frame). GET /sightings.
```

Files: `console/src/vision/thermal.ts`, `console/src/main.ts`, `hub/perception.py`, `hub/server.py` (routes), `hub/agent_flight.py` (tool results), `tests/test_perception.py`.

## Workstream B: autonomy from plant signals (agent B, about 3 hours)

A nuclear plant already instruments itself: winding temperatures on transformers, relief valve position switches, fire alarm zones, radiation monitors.
ARGUS subscribes to those signals and acts on them, which is how a real deployment would start, and it removes the click.

### B1. Plant signals (45 minutes)

`PlantSignal`: `id, ts, sensor_id, kind (temperature | valve | fire_alarm | radiation), value, unit, threshold, asset (name and lat, lon), severity, note`.
`POST /plant/signals` ingests one; the Scenario engine emits them itself: the transformer fire Scenario raises `transformer_T2 winding temperature 142 C, threshold 105, rising`, the steam release raises `relief valve RV-3 lifted`.
Live event `plant_signal`, in the trust trail; `GET /plant/signals` for reload.

### B2. Signal to Detection (30 minutes)

A signal above its threshold becomes a Detection at the asset's position with the reading in its metadata (as data, never instructions), so everything downstream is the pipeline that already exists: Site context, triage decision, envelope, validator, agent flight, thermal confirmation, report.
Overhead change detection stays as the second trigger; nothing is removed.

### B3. Autonomy modes with a veto window (1 hour)

`POST /autonomy/mode` and `/autonomy` report `manual | supervised | autonomous`.
Manual is today.
Supervised: a triage decision to dispatch executes itself after a veto window (15 s) during which the dashboard shows the decision and a Hold button.
Autonomous: no window; the Operator is informed and can abort at any time.
Two budgets the system cannot exceed: concurrent flights (1 for the demo) and a cooldown per asset (no re-dispatch to the same asset within 10 minutes).
Every automatic decision is a `decision` event with its rationale and deadline; `POST /decisions/{id}/hold` and `/release`.

### B4. Test and demo effect (45 minutes)

Tests on the fake Drone: a fire Scenario raises a signal, the Hub dispatches in supervised mode with no request from the test, the flight completes and the report exists; a hold within the window stops it; the cooldown refuses a second dispatch to the same asset.
Demo: the presenter runs the fire Scenario and takes their hands off the keyboard.
The plant reports a transformer over temperature, ARGUS decides, counts down, flies, confirms on thermal with a measured temperature, and writes the report.
Then the steam Scenario: a valve lift, the same chain, a cool reading, a maintenance ticket.

Files: `contracts/models.py` (PlantSignal), `hub/plant.py`, `hub/policy.py`, `hub/server.py` (routes), `hub/autonomy.py` (mode and decision), `tests/test_plant_autonomy.py`.

## Ownership

Agent A: `hub/perception.py`, `console/src/vision/*`, `console/src/main.ts`, `tests/test_perception.py`, the Sighting contract and Frame field.
Agent B: `hub/plant.py`, `hub/policy.py`, `hub/autonomy.py`, `tests/test_plant_autonomy.py`, the PlantSignal contract.
Both append their own routes to `hub/server.py` and neither reorders it.
`hub/agent_flight.py` is A's for tool results only.
The dashboard stays with its own session and receives the event shapes.

## What stays fixed

The Safety Validator, the envelope, the hard stops and ArduPilot's onboard fence are untouched.
Autonomy decides when to act; it never gets to bypass what checks the action.
Both workstreams are model-free, so the hands-off demo works with the API down; the live agent narration needs the API balance.
