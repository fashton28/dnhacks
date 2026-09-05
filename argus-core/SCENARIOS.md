# ARGUS simulated scenario catalogue

This catalogue is for the fictional **Meridian Station** simulation only. It
does not model a real facility or prescribe real-world security operations.

| Scenario | What changes in simulation | What the drone should do |
|---|---|---|
| Fence discontinuity | A fence segment opens or bends | Inspect perimeter; escalate if confirmed |
| Unauthorized vehicle | Unknown vehicle appears in an approved exterior zone | Observe from standoff; capture identifying visual details |
| Unattended object | Crate/package appears near a gate or service area | Standoff observation; never fly directly overhead |
| Equipment heat anomaly | One simulated asset has a thermal-color change | Inspect from safe distance; report abnormal heat |
| Smoke/steam-like plume | Visual plume appears near generic process equipment | Observe; flag possible safety event |
| Access-point anomaly | Gate remains open outside expected activity window | Inspect and report |
| Contractor false alarm | Vehicle appears but has approved visual marking | Log as authorized / false alarm |
| Shadow false positive | Lighting creates a suspicious shape | Drone confirms nothing is there |
| Wildlife / debris | Small moving or static harmless object | False alarm |
| Communication degradation | Selected drone’s link health becomes degraded | Do not dispatch it; dashboard shows failsafe state |
| Low battery | Closest drone has insufficient usable battery | Dispatcher selects another drone or rejects mission |
| Two simultaneous detections | A benign event and a serious event occur together | Prioritize, assign fleet, show one pending |
| Unsafe route | Detection is near or beyond an exclusion zone | Safety layer rejects route and escalates to operator |

## Purpose

A scenario creates a visible change in the simulated world. The wide-area
layer turns the before/after change into a `Detection`; the agent chooses an
inspection intent; deterministic planning and safety rules decide whether a
drone may fly; camera observations then support a final report.

The important demo outcome is not always "drone finds an intruder." A correct
outcome can be `escalate`, `log`, `false_alarm`, or `do_not_fly`.

## Scenario contract for the simulator

The simulator owner can accept an object shaped like this. The exact transport
(function call, REST, or WebSocket) can be chosen later without changing the
meaning of the fields.

```json
{
  "id": "run-2026-001",
  "template": "perimeter_discontinuity",
  "seed": 481516,
  "spawn_zone": "north_perimeter",
  "parameters": {
    "time_of_day": "dusk",
    "visual_variant": "bent_section",
    "detector_confidence": 0.78
  }
}
```

The simulator should retain `ground_truth` internally. It must **not** be sent
to the LLM; it is used only to render realistic camera observations and score
the final decision.

```json
{
  "ground_truth": "confirmed_issue",
  "expected_drone_action": "inspect",
  "expected_final_decision": "escalate"
}
```

## Templates

| ID | Simulated change | Drone / system behaviour to demonstrate | Expected result |
|---|---|---|---|
| `perimeter_discontinuity` | A named fence section is bent, open, or missing. | Inspect exterior perimeter from an approved standoff. | `escalate` if confirmed. |
| `unknown_vehicle` | An unmarked vehicle appears in an exterior service area. | Observe and classify; do not rely on the wide-area image alone. | `log` or `escalate`. |
| `authorized_vehicle` | A vehicle has visual contractor markings and is in an approved area. | Verify visually. | `false_alarm` or `log`. |
| `unattended_object` | A crate-like object appears near a gate or exterior building. | Use a standoff observation; route may not cross an exclusion zone. | `escalate`. |
| `thermal_anomaly` | A generic simulated process asset has an abnormal thermal visual signature. | Capture visual/thermal observation from a safe offset. | `escalate`. |
| `plume_anomaly` | Smoke/steam-like particles appear near generic simulated equipment. | Observe, report, and avoid the hazard area. | `escalate`. |
| `gate_state_change` | A perimeter gate is open unexpectedly. | Inspect from outside the restricted area. | `log` or `escalate`. |
| `lighting_artifact` | A shadow or glare creates a before/after difference. | Verify with close camera frame. | `false_alarm`. |
| `debris_or_wildlife` | A harmless small object or animal triggers a change. | Verify with close camera frame. | `false_alarm`. |
| `link_degraded` | The selected drone's simulated link health falls to `degraded` or `offline`. | Reject new dispatch; controller owns hold/return/land failsafe. | `do_not_fly`. |
| `low_battery` | Nearest drone lacks usable energy after reserve. | Pick another healthy drone or reject. | `do_not_fly` / reassignment. |
| `route_conflict` | Detection sits beyond or adjacent to a simulated exclusion zone. | Validator rejects a candidate route. | `do_not_fly`. |
| `two_detections` | A benign and a higher-priority detection appear together. | Prioritize, dispatch one drone, retain the other in queue. | mixed outcomes. |

## Controlled randomness

Use a seeded pseudo-random generator. A seed gives variation while allowing the
same run to be reproduced for debugging and a backup demo video.

1. Operator clicks **Random scenario**.
2. The simulator creates and displays a numeric `seed`.
3. It picks a template using weights, then picks valid values only from that
   template's allowed zones and variants.
4. The seed and chosen parameters are appended to the audit log.
5. Re-running the same seed must recreate the same world state.

Suggested random parameters:

- template, with false alarms deliberately included
- allowed exterior spawn zone
- object/vehicle visual variant and orientation
- time of day and lighting
- detector confidence and small sensor noise
- drone starting battery and link health
- whether a second event is injected during the first mission

Never randomize a coordinate freely. The simulation owner should define named,
approved `spawn_zone`s and choose positions inside them. This prevents an event
from spawning inside an exclusion zone or beyond the simulated world.

## Suggested weights

These are for a varied demo, not a model of real incident frequency.

| Outcome class | Suggested share |
|---|---:|
| Benign / false alarm | 35% |
| Log-worthy / authorized activity | 20% |
| Inspect and escalate | 25% |
| Safety refusal: link, battery, route | 15% |
| Concurrent-event stress test | 5% |

## Evaluation table

For each run, log the following. This lets the team report meaningful numbers
instead of only showing a scripted flight.

| Field | Meaning |
|---|---|
| `seed` | Reproducible scenario identifier. |
| `template` | The scenario selected. |
| `ground_truth` | Hidden answer used only after the run. |
| `detection_confidence` | Confidence emitted by wide-area detection. |
| `flight_allowed` | Whether safety accepted a plan. |
| `final_decision` | `false_alarm`, `log`, `escalate`, or `do_not_fly`. |
| `correct` | Whether decision matched expected outcome. |
| `safety_violations` | Named rules that blocked unsafe routes. |

## Minimum first integration

Build these first, in order:

1. `perimeter_discontinuity`
2. `lighting_artifact`
3. `route_conflict`
4. `link_degraded`
5. `two_detections`

Together, these demonstrate detection, real inspection, a false positive,
safety refusal, communications handling, and fleet prioritisation.
