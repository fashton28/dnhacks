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

- [`platform/`](platform/) — companion software, ground station, simulator, site model, shared wire contracts, scripts, and hardware documentation.
- [`argus-core/`](argus-core/) — decision, validation, and vision component maintained as a separate Python package.
- [`mock-drone-agent/`](mock-drone-agent/) — mock-agent scenarios, schemas, and reports.
- [`contracts/`](contracts/) — the Hub's domain contracts (Pydantic); every model names a term from [`CONTEXT.md`](CONTEXT.md).
- [`docs/`](docs/) — cross-component architecture decisions, site policy, and failure modes.
- [`docs/REPOSITORY_REVIEW.md`](docs/REPOSITORY_REVIEW.md) — provenance evidence, contract discrepancies, and adapter guidance.
- [`docs/BASIC_DEMO_PENDING.md`](docs/BASIC_DEMO_PENDING.md) — basic demo gates, teammate progress, and video evidence plan.
- [`docs/DISCREPANCY_REWRITE.md`](docs/DISCREPANCY_REWRITE.md) — what was removed and re-implemented in the discrepancy rewrite, file by file.

Shared design documents for the ARGUS stack: [`ARCHITECTURE.md`](ARCHITECTURE.md)
(build plan), [`CONTEXT.md`](CONTEXT.md) (vocabulary), and
[`docs/specs/0001-argus-simulated-site-monitoring.md`](docs/specs/0001-argus-simulated-site-monitoring.md)
(spec and user stories).

**Two runtimes currently coexist.** The ARGUS stack above (`hub/`, `console/`,
`sim/`, `contracts/`) and the retrofit under `platform/` both implement the same
demo against different site models, contracts, and simulators. See
[`docs/BASIC_DEMO_PENDING.md`](docs/BASIC_DEMO_PENDING.md) for which one the basic
demo runs on.

## Platform commands

Run platform commands from the platform root so existing relative paths remain valid:

```bash
cd platform
make test
make build-ground
```

The root [CI workflow](.github/workflows/ci.yml) uses the relocated paths directly.
