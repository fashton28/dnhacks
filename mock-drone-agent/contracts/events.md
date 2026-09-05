# Event stream contract (for the dashboard team)

Every run appends newline-delimited JSON to `runs/events.jsonl`. Nothing is ever
rewritten, so you can `tail -f` it or poll it — no coordination needed.

Every line has the same envelope:

```json
{"seq": 4, "ts": "2026-09-05T18:22:31.884Z", "mission_id": "m-20260905-0001", "type": "plan_approved", "payload": {}}
```

- `seq` — monotonically increasing integer, unique per file. Use it to dedupe / resume.
- `mission_id` — `null` for events that happen before a mission exists.
- `type` — one of the types below.
- `payload` — type-specific, documented below.

## Reading it from Python

```python
from agent.events import read_events
for ev in read_events("runs/events.jsonl", since_seq=last_seen):
    ...
```

## Event types

| `type` | When | `payload` |
|---|---|---|
| `run_started` | Once at the top of a run | `{facility_id, mode}` — `mode` is `"live"` or `"mock"` |
| `anomaly_detected` | Satellite/change-detection layer flags something | the anomaly object (see below) |
| `plan_proposed` | LLM returned a mission plan | `{plan, attempt}` — `plan` matches `contracts/mission_plan.schema.json` |
| `plan_rejected` | Verifier blocked the plan | `{attempt, violations: [{code, message, waypoint_index}]}` |
| `plan_approved` | Verifier passed the plan | `{plan, checks_passed, flight_time_s, battery_needed_pct}` |
| `plan_abandoned` | Verifier rejected every attempt; escalated to a human instead of flying | `{attempts, last_violations}` |
| `mission_started` | Handed to the drone-control layer | `{waypoint_count}` |
| `waypoint_reached` | Drone arrived at a waypoint | `{index, lat, lon, alt_m, action}` |
| `observation` | Sensor reading collected at a hover point | an observation object (see below) |
| `mission_completed` | Drone-control layer returned | `{status, observation_count}` — `status` is `success` / `aborted` / `failed` |
| `triage_decision` | LLM judged the observations | `{decision, confidence, rationale}` — `decision` is `false_alarm` / `log_only` / `escalate` |
| `incident_report` | Written report produced | `{title, severity, body_markdown, recommended_action}` |
| `run_finished` | Once at the end | `{missions, escalations}` |

## Anomaly object

```json
{
  "anomaly_id": "fence-breach-01",
  "lat": 39.9531,
  "lon": -75.1901,
  "detected_at": "2026-09-05T18:22:30.101Z",
  "source": "sentinel2-change-detection",
  "confidence": 0.72,
  "description": "New 4x2m dark object adjacent to north perimeter fence; fence line discontinuity in NIR band."
}
```

## Observation object

```json
{
  "waypoint_index": 2,
  "lat": 39.9531, "lon": -75.1901, "alt_m": 25,
  "timestamp": "2026-09-05T18:23:44.002Z",
  "detections": [{"label": "vehicle", "confidence": 0.88}],
  "thermal_max_c": 41.2,
  "rf_anomaly_db": 3.1,
  "caption": "Light truck parked against the fence line; fence fabric appears intact."
}
```

The dashboard should treat `detections`, `thermal_max_c`, `rf_anomaly_db` and
`caption` as best-effort — the simulation team fills these in, and any one of
them may be absent depending on what the sim renders.
