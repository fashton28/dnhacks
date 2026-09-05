# Autonomous ISR agent — LLM layer

Layered autonomous surveillance for critical energy infrastructure. A wide-area
satellite layer flags an anomaly; an LLM agent plans a close-inspection drone
mission; a **deterministic verification layer** approves or refuses it before a
motor spins; the drone flies it; the LLM triages what it saw and writes the
incident report.

This repo is the **LLM layer plus the trust layer**. The simulation team plugs
in at one function, the dashboard team plugs in at one file.

## Run it right now

No API key, no `pip install`, nothing:

```bash
python3 run_demo.py --all
```

The full pitch demo — a plan gets rejected and repaired, then flown:

```bash
python3 run_demo.py --fresh --force-bad-plan --realtime --anomaly fence-breach-01
```

28 tests — 19 unsafe plans the system provably refuses, plus 9 that check the
live API path offline (tool schemas, prompt rendering, cache stability) so your
first real API call fails for interesting reasons only:

```bash
python3 -m unittest discover -s tests -v
```

To use the real Claude API instead of the mock planner:

```bash
pip install anthropic && export ANTHROPIC_API_KEY=sk-ant-...
python3 run_demo.py --all
```

`--mode auto` (the default) uses the API when credentials exist and the mock
planner when they don't. **Everything else in the system is identical either
way** — same contract, same verifier, same events, same reports. That means you
can develop, test, and rehearse the demo offline and burn API budget only when
you mean to.

## The pipeline

```
  satellite anomaly (lat/lon + description)
        │
        ▼
  ┌─────────────────┐   agent/planner.py
  │ PLANNER  (LLM)  │   Claude proposes a mission plan via a strict tool schema
  └────────┬────────┘
           ▼
  ┌─────────────────┐   agent/verifier.py       ← no model runs here
  │ VERIFIER        │   11 hard checks: geofence, no-fly zones (waypoints AND
  │ (plain Python)  │   transit legs), altitude, hover, range, battery reserve,
  └────┬────────┬───┘   and "does this plan actually observe the anomaly?"
       │        │
   approved   rejected ──► reasons fed back to the planner, up to 3 attempts
       │                   never approved ──► NOT FLOWN, escalate to a human
       ▼
  ┌─────────────────┐   agent/executor.py
  │ DRONE CONTROL   │   SimStubExecutor today, Px4Executor (MAVSDK/PX4 SITL)
  └────────┬────────┘   when the sim team lands it
           ▼
  ┌─────────────────┐   agent/triage.py
  │ TRIAGE   (LLM)  │   false_alarm / log_only / escalate + incident report
  └────────┬────────┘
           ▼
   runs/events.jsonl  +  runs/reports/*.md   ← the dashboard's only inputs
```

## The three interfaces (agree these, then work in parallel)

Nobody should be blocked on anybody today. There are exactly three seams.

### 1. Mission plan — LLM layer → drone control

`contracts/mission_plan.schema.json`. **Sim team: implement one method.**

```python
class Px4Executor:                       # agent/executor.py
    def execute_mission(self, plan: dict) -> dict: ...
```

`plan` matches the contract. The return shape is `MISSION_RESULT` at the top of
`agent/executor.py`. `Px4Executor` is already there with the MAVSDK call
sequence sketched in its docstring and the two gotchas that will cost you an
hour each (AGL→AMSL conversion, and emitting events per waypoint so the
dashboard animates live). Until it works, `SimStubExecutor` stands in and the
rest of the system does not care.

The contract file is also the *literal source* of the tool schema Claude sees —
`planner.mission_tool()` reads `$defs.waypoint` out of it. Change the contract
and the model's tool changes with it. One source of truth.

### 2. Event stream — everything → dashboard

`contracts/events.md`. Append-only JSONL at `runs/events.jsonl`, one event per
line, monotonically increasing `seq`.

```bash
python3 tools/tail_events.py --replay          # reference implementation
```

**Dashboard team: you never import the agent.** Poll the file, track the last
`seq` you rendered. Works from any language. 16 event types, all documented,
including `plan_rejected` (with the violated rules) and `plan_abandoned` —
those two are the visual money shot for the pitch.

### 3. Facility definition — architecture → verifier

`config/facility_riverbend.json`. Geofence polygon, no-fly zones, altitude
ceiling, battery reserve, airframe performance. Every rule the system enforces
is in this one readable file. Point a judge at it.

## Why the verifier is the whole pitch

An LLM planning drone missions is a demo. An LLM planning drone missions
*behind an auditable gate that refuses unsafe plans* is a defense product.

`agent/verifier.py` contains no model call and no prompt. It is arithmetic
against a JSON config. Concretely it catches things a prompt will not:

| Check | The failure it catches |
|---|---|
| `OUTSIDE_GEOFENCE` | waypoint beyond the authorised boundary |
| `IN_NO_FLY_ZONE` | waypoint parked over a live 500kV switchyard |
| `LEG_CROSSES_NO_FLY_ZONE` | **two legal waypoints with a hazard between them** — legs are sampled every 10 m, so a leg cannot skip a zone |
| `ABOVE_MAX_ALTITUDE` / `BELOW_MIN_ALTITUDE` | Part 107 ceiling, obstacle floor |
| `LEG_TOO_LONG` | a hallucinated coordinate, caught as a physically absurd leg |
| `HOVER_TOO_LONG` | a plan that burns the battery standing still |
| `EXCEEDS_RANGE` / `INSUFFICIENT_BATTERY` | a mission that cannot get home, with the 25% reserve actually withheld |
| `ANOMALY_NOT_OBSERVED` | **perfectly legal, completely useless** — no hover within 60 m of the thing it was sent to look at |
| `MALFORMED_PLAN` | anything not matching the contract, including string coordinates |

Two behaviours worth demoing out loud:

- **The repair loop.** A rejection goes back to Claude as a tool error naming
  the exact rule and waypoint, in the same conversation. It fixes that waypoint
  and resubmits — it does not re-plan from scratch. `--force-bad-plan` shows
  this in mock mode.
- **The refusal.** `offsite-activity-05` is an anomaly *outside* the geofence.
  No legal mission exists. The system tries three times, refuses to fly, and
  escalates to a human with a report explaining why. Ground truth for that one
  is `intruder` — so the honest framing is "the system knew what it could not
  safely do," which is a better story than a system that always launches.

## Layout

```
contracts/mission_plan.schema.json   THE interface contract — read, don't edit alone
contracts/events.md                  event stream reference for the dashboard
config/facility_riverbend.json       geofence, no-fly zones, limits (auditable)
agent/geo.py                         haversine, point-in-polygon, offsets (no deps)
agent/facility.py                    loads the config; renders the planner's brief
agent/types.py                       contract validation — the "is this even a plan" gate
agent/events.py                      append-only JSONL log
agent/anomaly.py                     mock satellite layer, 5 anomalies with ground truth
agent/llm.py                         the ONLY file that calls the Claude API
agent/planner.py                     LLM planning session + repair loop + mock planner
agent/verifier.py                    the trust layer (no model)
agent/executor.py                    the drone-control seam: stub + PX4 skeleton
agent/triage.py                      LLM judgement + incident report + mock rules
agent/orchestrator.py                the loop, ~100 lines of control flow
run_demo.py                          CLI
tools/tail_events.py                 dashboard reference consumer
tests/test_verifier.py               19 tests, each an unsafe plan that gets refused
tests/test_contracts.py              9 tests of the live API path, no network needed
```

## Model configuration

Set in `agent/llm.py`, overridable by env var:

```bash
export DRONE_AGENT_MODEL=claude-opus-5     # default; claude-sonnet-5 is cheaper/faster
export DRONE_AGENT_EFFORT=medium           # low|medium|high|xhigh|max — default high
```

Notes on the API usage, since a few of these are easy to get wrong:

- **Adaptive thinking** (`thinking={"type": "adaptive"}`), not a fixed thinking
  budget. `budget_tokens` is rejected on current models.
- **Strict tool schemas** (`"strict": True`), so tool inputs are guaranteed to
  validate against the schema. This is why there is no "the LLM returned
  malformed JSON at 2am" failure mode.
- **Prompt caching** on the system prompt. The facility brief is byte-identical
  across every mission in a run, so mission 2 onward reads it from cache. Keep
  it byte-stable — don't put a timestamp in it.
- Tool inputs are parsed dicts; never string-match the raw JSON.
- Drop `DRONE_AGENT_EFFORT` to `medium` or `low` if live demo latency is a
  problem. The verifier catches what lower effort costs you.

## Useful flags

```bash
python3 run_demo.py --all                    # every anomaly in the catalogue
python3 run_demo.py --anomaly fence-breach-01 --anomaly thermal-hotspot-03
python3 run_demo.py --battery 30             # watch the battery reserve check bite
python3 run_demo.py --force-bad-plan         # demo reject → repair → fly
python3 run_demo.py --realtime               # pace waypoints for a live audience
python3 run_demo.py --fresh                  # truncate the event log first
python3 run_demo.py --mode live              # fail loudly instead of falling back to mock
python3 run_demo.py --seed 42                # reproducible anomaly pick + sensor noise
```

## Not done yet

Honest list, so nobody assumes otherwise:

- **The live API path has never been executed** — there were no credentials on
  the machine this was written on. Mock mode is exercised end-to-end and the
  verifier is tested; the first `--mode live` run may need a small fix. Run it
  early, not at hour eleven.
- `Px4Executor.execute_mission` raises `NotImplementedError` — that's the sim
  team's piece.
- The satellite layer is a fixed catalogue in `agent/anomaly.py`, not real
  Sentinel-2 change detection.
- Triage in mock mode is rule-based and deliberately crude, keying off the
  strongest detection label. That crudeness is the argument for the LLM layer:
  run it live and compare the two reports for the same anomaly.
- No wind, no GPS error, no dynamic obstacles, no comms loss in the stub
  executor. The verifier's margins are static.
