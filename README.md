# ARGUS — governed autonomous site monitoring

An overhead pass finds a change at a simulated critical-infrastructure site. A vision
model says what changed, an agent decides whether it is worth a flight and declares the
envelope it wants to work in, a deterministic layer approves or shrinks that envelope,
and the agent then flies inside it — with every move re-checked, and real ArduPilot
firmware underneath enforcing its own geofence.

**To run the demo, read [`docs/DEMO.md`](docs/DEMO.md).** It is the rehearsed script,
including the pre-flight checklist and what to do when the model API misbehaves.

## Quick start

```bash
uv sync                                 # Python deps
cd console && pnpm install && cd ..     # Console deps
python scripts/fetch_assets.py          # ~85 MB of CC0 textures, HDRI and models — required
```

Assets are gitignored, so **every machine runs `fetch_assets.py` once**. Without it the
scene renders untextured and dark.

Put the model keys in `.env` at the repo root (gitignored; the Hub reads it at startup):

```
GEMINI_API_KEY=...      # wide-area vision
ANTHROPIC_API_KEY=...   # triage, in-flight inspection, incident reports
```

Both are optional — every live model call degrades to a rule-based path and says so —
but the live agent is the demo.

Then build ArduPilot per [`docs/sim-setup.md`](docs/sim-setup.md) and:

```bash
make hub                 # Hub on :8000, serves /gcs/ and /console/
make sim FLEET=3         # ArduCopter SITL + Bridge per Drone
```

Open <http://localhost:8000/> (redirects to the dashboard). `make fake-fleet` substitutes
kinematic Drones when you do not want ArduPilot, and `scripts/sim_renderer.py` is a
headless renderer for when no browser is open.

## Repository map

### The ARGUS stack

| Path | What it is |
|---|---|
| [`hub/`](hub/) | One FastAPI process and the only authority. Drone registry, Mission runner, Safety Validator, agent-flown missions, in-flight inspection, detection and incident stores, Scenario engine, audit log. Serves the Console at `/console/` and the dashboard at `/gcs/`. |
| [`console/`](console/) | Three.js World view, per-Drone view (RGB / thermal / LiDAR), MapLibre Overview, Fleet/Mission/Log panels. **Also the Renderer** — there is no camera on a simulated Drone, so the browser draws every frame the Hub asks for. |
| [`widearea/`](widearea/) | Overhead change detection. `vision.py` (Gemini, structured output) and `detect.py` (numpy pixel differencing) both return the same `Detection`. |
| [`sim/`](sim/) | ArduCopter SITL launcher and params, the MAVLink Bridge, the fake Drone, and the Site generator. `sim/common/site_limits.py` is read by both the Safety Validator and the firmware fence. |
| [`contracts/`](contracts/) | Pydantic models, the controller protocol, fixtures and exported JSON schema. Every model names a term from [`CONTEXT.md`](CONTEXT.md). |
| [`scripts/`](scripts/) | `launch_sim.py`, `sim_renderer.py`, `headless_renderer.py`, `argus_autonomy.py` (one closed loop end to end), `argus_detect.py`, `smoke_flight.py`, `fetch_assets.py`, `sitl_diag.py`, `export_schema.py` |
| [`tests/`](tests/) | Hub API tests against the fake Drone, Safety Validator, incidents, wide-area, contracts, site |

### Team components, maintained as separate roots

| Path | What it is |
|---|---|
| [`platform/`](platform/) | Companion software, the React ground-control dashboard, hardware docs and design assets. The dashboard now talks to the ARGUS Hub and is served at `/gcs/`. |
| [`rails/`](rails/) | An independent Python oracle for the trust layer, with parity harnesses. Scoped to `platform/`; imports nothing from it by design. |
| [`argus-core/`](argus-core/) | Decision, validation and vision component. Its own contracts — adapt at a boundary, never share an import path. |
| [`mock-drone-agent/`](mock-drone-agent/) | The planner, verifier, triage and report writer that `hub/autonomy.py` adapts. Also the plan-based fallback when `ARGUS_FLIGHT_MODE` is not `agent`. |

## Documentation

| Document | Read it for |
|---|---|
| [`docs/DEMO.md`](docs/DEMO.md) | **The runbook.** Pre-flight, the two acts, the codas, the API fallback. |
| [`CONTEXT.md`](CONTEXT.md) | The vocabulary. Every term the code and the pitch use, and what to avoid calling things. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the pieces fit and the contracts between them. |
| [`docs/ARGUS_AUTONOMY.md`](docs/ARGUS_AUTONOMY.md) | The autonomy loop in detail. |
| [`docs/adr/`](docs/adr/) | Why the environment and flight stack are what they are, and why the agent flies inside an envelope. |
| [`docs/sim-setup.md`](docs/sim-setup.md) | Building ArduPilot and running the stack. |
| [`docs/ASSETS.md`](docs/ASSETS.md) | Asset provenance and licences. |
| [`docs/REPOSITORY_REVIEW.md`](docs/REPOSITORY_REVIEW.md) | Provenance, contract discrepancies between roots, and the adapters they require. |
| [`docs/specs/`](docs/specs/) | The spec and user stories. |

## Tests

```bash
make test                # or: uv run pytest -q
cd console && pnpm build # TypeScript + Vite
```

The root [CI workflow](.github/workflows/ci.yml) currently covers `platform/` only; the
ARGUS suites above are run by hand.
