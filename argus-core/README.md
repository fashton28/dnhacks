# ARGUS core — portable decision and safety slice

This folder is deliberately independent of the simulator, dashboard, SDR, and
LLM provider. It uses only Python's standard library and exchanges ordinary
JSON-shaped dictionaries. It is designed to be copied into the eventual shared
GitHub repository as `argus-core/` (or its contents can be moved into the
repository's `agent/`, `planner/`, `safety/`, and `contracts/` folders).

The stable handoff is:

`Detection -> MissionSpec -> FlightPlan -> ValidationResult`

* `contracts/models.py` validates those messages at the boundary.
* `agent/triage.py` creates a safe, deterministic fallback MissionSpec today;
  the dashboard or Hub can later call an LLM adapter with the same output.
* `planner/coverage.py` creates a simple inspection pattern in a local metric
  frame. It is a simulator route proposal, not a real-flight planner.
* `safety/validator.py` is the only gate that can accept a FlightPlan.

Run the self-contained example:

```bash
python3 run_example.py
```

The next team only needs to either POST a `Detection` to this layer or call
`run_pipeline(detection, drone_state, policy)`. The dashboard can render the
four returned JSON objects without importing Python.

## Inputs this layer requires

### 1. Detection — from the scenario / wide-area team

```json
{
  "id": "det-fence-01",
  "polygon": [[39.9502, -75.1905], [39.9502, -75.1902], [39.9504, -75.1902]],
  "confidence": 0.82,
  "change_type": "simulated_fence_breach",
  "detected_at": "2026-09-05T15:00:00Z",
  "before_ref": "sim://before/fence-01",
  "after_ref": "sim://after/fence-01"
}
```

### 2. Drone state — from the Hub / simulator team

```json
{
  "drone_id": "drone-1",
  "lat": 39.9495,
  "lon": -75.1900,
  "battery_pct": 90,
  "link_state": "healthy"
}
```

`link_state` should be `healthy`, `degraded`, or `offline`. A degraded or
offline drone cannot be newly dispatched. Its controller/autopilot—not this
layer—must perform hold, return-home, or landing failsafe behaviour.

### 3. Policy — agreed once by the team

The policy has the facility geofence and basic operating limits. See
`fixtures/policy.json` for the complete small example.

## Outputs this layer returns

1. **MissionSpec** — intent: what to inspect, at what standoff, and why.
   It deliberately contains **no waypoints**.
2. **FlightPlan** — an explicit simulator route with altitude, duration, and
   estimated battery use.
3. **ValidationResult** — `accept` or `reject`, plus named rule violations.

The Hub should dispatch only an accepted FlightPlan. The dashboard can show all
three objects directly as JSON cards, a route polyline, and a green/red safety
state.

## Is this an LLM agent?

Yes, it is ready for a real Gemini call. `agent/triage.py` uses mock mode by
default so integration and tests do not spend money. In live mode it calls
Gemini with a JSON schema and receives a structured `objective` plus
`rationale`.

The model cannot supply coordinates, altitude, or safety settings: Python
copies those from the trusted Detection and Policy after the model responds.
That is intentional. The LLM makes a real, bounded judgment; deterministic
code still calculates the route and accepts/rejects it.

### Enable live mode on your laptop

From this `argus-core` folder, once you have created a Gemini API key:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export GEMINI_API_KEY="paste-your-key-here"
export ARGUS_LLM_MODE=live
python3 run_example.py
```

Do **not** paste a key into `agent/triage.py`, `README.md`, or GitHub. It stays
only in your terminal environment. `.env.example` is a reminder template, not
a file to put your actual key in. Add `.env` to `.gitignore` if you later use a
local environment-file loader.

The live-call implementation is already in `agent/triage.py`; no manual code
pasting is needed after you upload this folder. Set `ARGUS_LLM_MODEL` only if
your Google AI Studio account exposes a different Gemini model. The included
default is `gemini-3.6-flash`.

`planner/coverage.py` calculates the route deterministically, and
`safety/validator.py` makes the final accept/reject decision deterministically.
That split is safer, easier to test, and means a model outage cannot stop the
dashboard or make the flight controller accept an unsafe plan.
