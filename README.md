# ARGUS: autonomous drone observability for critical infrastructure

ARGUS watches a nuclear plant from two layers: an overhead pass that notices change, and an AI-flown drone that goes and finds out what the change is.
Between the AI and the aircraft sits a trust layer that is not an AI: every plan, every flight step and every human stick input is checked against the site's geofence, no-fly zone and altitude limits before it reaches the flight controller.
The flight controller is ArduPilot, the same open-source code that flies real multirotors, running in software-in-the-loop simulation.

Built by a team of four for DNHacks (defense track) on a fictional site, Meridian Station.

![Dashboard, Mission view during an agent-flown flight](docs/screenshots/dashboard-mission.jpg)

## What happens on one anomaly

1. **Detect.** The wide-area layer compares an overhead image before and after and flags a change: a rising column in the switchyard, a vehicle at the fence, an object where nothing should be.
2. **Decide whether to fly.** The Triage Agent (Claude) reads the detection with the site context: which zone it is in, what is normally there, whether maintenance is declared. A contractor van in the service yard during a declared window is logged, no motor spins.
3. **Declare an envelope.** The agent states where it intends to fly: a radius, a ceiling, a time budget. The Safety Validator checks the envelope against the site limits and refuses or shrinks it before takeoff.
4. **Fly it.** Inside the envelope the agent is in control through tools: fly to, hold, tilt the camera, switch to thermal, zoom, capture. Every move is re-validated live, and hard stops in code (step budget, time, battery reserve, operator abort) bring the drone home no matter what the model says.
5. **Report.** A written incident report with the frames, the agent's on-station assessment, a verdict and a recommended action. A transformer fire escalates as critical with de-energize and fire response; a steam release from a relief vent, identical from above, reads cool on thermal and is logged for maintenance.

Everything the agent does is a published event and an audit line, so the operator watches the decision being made, not just the result.

## Subsystems

| | |
|---|---|
| ![Flight view](docs/screenshots/dashboard-flight.jpg) | **Ground control dashboard.** Live drone camera with a flight HUD, fleet, missions, the trust column (triage decision, validator verdicts, agent actions with their reasons), incident reports, manual control. React and TypeScript. |
| ![World view](docs/screenshots/world-fire-wide.jpg) | **3D world.** The site in Three.js: terrain, buildings, switchyard, fences, woodland, weather. Scenarios place anomalies into it, such as this transformer fire, and the camera flies to them. 60 fps on a laptop. |
| ![Chase view](docs/screenshots/world-chase.jpg) | **Aircraft.** Each drone is an ArduCopter instance with its own physics. The model banks and pitches with the autopilot's real attitude; telemetry at 20 Hz with per-frame interpolation. |
| ![Overhead](docs/screenshots/overhead-fire.jpg) | **Wide-area layer.** Overhead renders before and after, differenced and georeferenced into detections with a footprint, an area and a confidence. |
| ![Thermal](docs/screenshots/thermal-fire.jpg) | **Sensors.** The drone camera renders RGB, thermal (true per-object temperature with sensor noise and palettes) and LiDAR. This is the fire the agent confirmed: the bay saturates the sensor. |
| ![Steam in thermal](docs/screenshots/thermal-steam.jpg) | **Same picture, different answer.** The steam release from above looks like the fire. In thermal it reads cool, water vapour, and the report says maintenance ticket, not emergency. |

## Stack

**Hardware.** None is required to run this, and that is the point of the pitch: the flight code is real.

- Flight controller: ArduPilot ArduCopter, built natively for Apple Silicon and run as three software-in-the-loop instances with their own physics, EKF, battery model and onboard geofence. The same firmware runs on a Pixhawk; only the airframe is missing.
- Everything runs on one MacBook: three autopilots, the Hub, both front ends and the renderer.

**Software.**

- `hub/` FastAPI. Drone registry, mission runner, manual control clamping, scenario engine, wide-area detection, the autonomy layer (site context, triage, envelope, agent flight, incident reports), audit log, live WebSocket feed.
- `sim/` The MAVLink bridge between ArduPilot and the Hub, the site generator (one source of truth for geometry, geofence, zones and posture), a fake drone for tests.
- `console/` The Three.js world and drone camera, also the renderer that produces evidence frames and overhead images for the Hub.
- `platform/ground/ui/` The operator dashboard.
- `contracts/` Pydantic models and JSON schemas shared by everything: Detection, MissionSpec, FlightPlan, ValidationResult, DroneState, IncidentReport.
- AI: Claude Opus 5 for triage, envelope, the flight tool loop and vision. Every model call has a rule-based fallback so the pipeline runs identically with no API key.

**Trust layer, in three independent lines.** The agent's own verifier, the Hub's Safety Validator on real site geometry, and ArduPilot's onboard polygon fence, which refuses a destination outside it regardless of what the Hub sends. Red-team cases exercise all three: an illegal first plan, a prompt injection in detection metadata, a target outside the fence, a plan beyond endurance.

## Run it

```bash
uv sync
cd console && pnpm install && pnpm build && cd ..
cd platform/ground/ui && npm ci && npm run build && cd ../../..
uv run python scripts/launch_sim.py --fleet 3 --speedup 1 --wipe --with-hub --renderer
```

Then open http://localhost:8000/ (dashboard) or http://localhost:8000/console/ (3D world).
ArduPilot must be built once per [docs/sim-setup.md](docs/sim-setup.md).
Put `ANTHROPIC_API_KEY=...` in a `.env` file for live mode; without it the same pipeline runs on rules.

`uv run pytest` runs 105 tests, including full dispatches on a fake drone: detection, triage, envelope, flight, thermal confirmation, report.

## Read more

- [docs/DEMO.md](docs/DEMO.md): the demo runbook, fire versus steam.
- [ARCHITECTURE.md](ARCHITECTURE.md): how the pieces connect and why.
- [CONTEXT.md](CONTEXT.md): the domain glossary and the scenarios.
- [docs/sim-setup.md](docs/sim-setup.md): building ArduPilot and running everything on a Mac.
- [docs/REPOSITORY_REVIEW.md](docs/REPOSITORY_REVIEW.md), [docs/BASIC_DEMO_PENDING.md](docs/BASIC_DEMO_PENDING.md) and [docs/DISCREPANCY_REWRITE.md](docs/DISCREPANCY_REWRITE.md): provenance, demo gates, and what the platform rewrite removed and re-implemented.

## Repository map

- [`hub/`](hub/) the Hub, [`console/`](console/) the 3D console and renderer, [`sim/`](sim/) autopilot launcher, bridge and site generator, [`contracts/`](contracts/) shared models, [`scripts/`](scripts/) launch, smoke test and headless renderer, [`tests/`](tests/).
- [`platform/`](platform/) the operator dashboard, companion software and shared wire contracts; [`argus-core/`](argus-core/) decision, validation and vision components; [`mock-drone-agent/`](mock-drone-agent/) the planner, verifier and triage the Hub's autonomy layer builds on.
