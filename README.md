# DNHacks drone safety platform

This repository keeps the integrated flight platform and the team's complementary planning components in clear, independent roots.

## Repository map

Simulation and operator stack (Three.js renderer, ArduCopter SITL, Hub):

- [`hub/`](hub/) — the Hub: FastAPI process with the Drone registry, Mission runner, Manual Control clamping, Scenario engine, Renderer role and audit log. Serves the Console at `/console/`.
- [`console/`](console/) — the Console: Three.js World view and Drone view (RGB, thermal, LiDAR), MapLibre satellite Overview, Fleet/Mission/Log panels. Vite + TypeScript.
- [`sim/`](sim/) — ArduCopter SITL launcher and params, the MAVLink Bridge, the fake Drone, and the Site generator (`site.json` + `site.geojson`).
- [`scripts/`](scripts/) — `launch_sim.py`, `smoke_flight.py`, `headless_renderer.py`, `sitl_diag.py`, `fetch_assets.py`.
- [`docs/sim-setup.md`](docs/sim-setup.md) — how to build ArduPilot and run everything on a Mac; [`docs/adr/`](docs/adr/) — ADR 0002 records the Three.js + ArduPilot decision.

Quick start: `uv sync`, build ArduPilot per the setup guide, then `make hub` and `make sim FLEET=3`, open http://localhost:8000/console/.

Team components:

- [`platform/`](platform/) — companion software, ground station, simulator, site model, shared wire contracts, scripts, hardware documentation, and imported design assets.
- [`argus-core/`](argus-core/) — decision and validation component maintained as a separate Python package.
- [`contracts/`](contracts/) — the team's earlier Pydantic model contracts.
- [`mock-drone-agent/`](mock-drone-agent/) — mock-agent scenarios, schemas, and reports.
- [`docs/`](docs/) — cross-component architecture decisions, site policy, failure modes, and specifications.
- [`docs/REPOSITORY_REVIEW.md`](docs/REPOSITORY_REVIEW.md) — provenance evidence, contract discrepancies, and adapter guidance.
- [`docs/BASIC_DEMO_PENDING.md`](docs/BASIC_DEMO_PENDING.md) — basic demo gates, teammate progress, and video evidence plan.

## Platform commands

Run platform commands from the platform root so existing relative paths remain valid:

```bash
cd platform
make test
make build-ground
```

The root [CI workflow](.github/workflows/ci.yml) uses the relocated paths directly.
