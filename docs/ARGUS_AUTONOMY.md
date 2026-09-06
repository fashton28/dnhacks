# Closed-loop simulated autonomy

`scripts/argus_autonomy.py` is the one-command simulation-only path from a
seeded Scenario to an actual simulated Drone Mission. It does not edit the
Console and it never connects to physical drone hardware.

```text
reset scene -> overhead BEFORE -> seeded Scenario -> overhead AFTER
-> Gemini vision -> Detection posted to Hub -> Gemini Triage Agent
-> deterministic route + safety validation -> Hub MissionRunner
-> fake Drone / ArduPilot SITL flies -> renderer captures evidence -> RTL
```

## One-time setup

```bash
uv sync
cd console && pnpm install && pnpm build && cd ..
export GEMINI_API_KEY="your-local-key"
```

Do not commit the API key.

## Fastest local run: fake Drone

Use four terminals at the repository root:

```bash
# 1. Hub
make hub

# 2. Drone fleet (no ArduPilot build required)
make fake-fleet FLEET=1 SPEED=4

# 3. Renderer that produces overhead and evidence frames
uv run python scripts/headless_renderer.py --hub http://127.0.0.1:8000

# 4. One seeded full autonomy cycle
GEMINI_API_KEY="$GEMINI_API_KEY" uv run python scripts/argus_autonomy.py --seed 42
```

The script resets the Site before capturing the fixed normal `before.png`, then
uses the seed to choose and vary one of the five supported Scenarios. Reusing a
seed recreates the same Scenario parameters.

## ArduPilot SITL instead of fake Drone

After following `docs/sim-setup.md`, replace terminal 2 with:

```bash
make sim FLEET=1 SPEED=4
```

The same adapter calls `/missions/fly`; the Hub MissionRunner sends `goto`,
captures evidence, and requests return home through the existing Bridge.

## What appears where

- Console: posted Detection, live Drone telemetry, Mission state, renderer
  frames, and captured evidence.
- `evidence/argus/<run-id>/`: fixed-before and Scenario-after overhead images.
- `evidence/<mission-id>/`: one renderer frame per Mission waypoint.
- terminal: vision label/confidence, triage decision, safety refusal if any,
  and final Mission phase.

## Safe behaviour

- Gemini sees images and selects only `dispatch`, `log_only`, or `ignore` plus
  an inspection objective.
- Deterministic code, not Gemini, creates every waypoint.
- Every candidate point and direct leg is checked against the generated
  geofence, no-fly geometry, altitude range, and battery reserve before it is
  passed to the Hub.
- The simulator/ArduPilot Bridge also enforces an independent onboard fence.
