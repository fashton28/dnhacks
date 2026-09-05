# Failure modes and deterministic responses

Each row represents one phase of one failure. The `Response` cell contains
exactly one wire/UI failsafe state: `hold`, `rtl`, `escalate`, or `refuse`.
Multi-stage failures have separate rows so authority and assertions remain
unambiguous. The UI displays the state and the reason from the named authority.

| Failure | Phase | Detection | Response | Authority | SITL/scripted injection | Required e2e assertion |
|---|---|---|---|---|---|---|
| Vehicle datalink loss | Initial watchdog window | Companion receives no ground heartbeat inside its configured watchdog window; commanded velocity is zeroed | `hold` | Companion watchdog | `--link-loss` drops the control WebSocket | State becomes `hold` within 5 s, setpoint is zero, position remains inside fence and standoff is not breached |
| Vehicle datalink loss | GCS failsafe timeout | ArduPilot GCS failsafe observes continued heartbeat loss | `rtl` | ArduPilot firmware | Keep the link dropped beyond the firmware timeout | Mode becomes RTL and vehicle returns without a new ground command |
| Planner heartbeat loss | Active planner mission | Companion misses planner heartbeat while vehicle link remains healthy | `hold` | Companion planner watchdog | Stop `planHeartbeat` only | State becomes `hold` at current standoff within 5 s |
| Planner heartbeat loss | Subsequent command | A `planCommand` arrives while planner heartbeat is stale | `refuse` | Companion planner executor | Send a command after heartbeat cutoff | Ack is rejected with stale-heartbeat reason and no setpoint changes |
| LLM timeout, malformed output, or refusal | Scripted recovery available | 20 s deadline, schema parse, or refusal check fails | `hold` | Ground planner host | Inject timeout, invalid JSON, and refusal fixtures | ScriptedPlanner is selected without waiting on network; any airborne vehicle stays held until its verified plan is accepted |
| LLM timeout, malformed output, or refusal | Scripted recovery unavailable or invalid | Scripted fallback cannot produce a schema-valid plan | `escalate` | Ground planner host | Make both live and scripted planner fixtures fail validation | Operator event names the LLM/fallback error and the planner emits no executable plan |
| Verifier rejects twice | Second deterministic rejection | Same request fails initial verification and the one allowed repair attempt | `escalate` | Ground MissionVerifier | Feed two invalid plans for one request | Operator escalation contains both check lists; there is no third LLM attempt |
| GPS loss | In flight, healthy fallback pending | EKF/GPS health vote fails for 2 s | `hold` | Companion navigation manager | Disable `SIM_GPS1_ENABLE` or set legacy `SIM_GPS_DISABLE=1` | Vehicle holds while source vote runs; ground cannot command a source switch |
| GPS loss | New mission | `navSource != gps` after GPS vote failure | `refuse` | Ground MissionVerifier and companion re-clamp | Attempt dispatch while GPS is disabled | Mission is refused with `nav_source` reason even if extnav or optflow is healthy |
| GPS loss with healthy LiDAR-inertial odometry | Source selection | GPS vote fails and extnav freshness/covariance checks pass | `hold` | Companion navigation manager | Disable GPS and inject healthy LIO | `MAV_CMD_SET_EKF_SOURCE_SET` selects extnav, telemetry reports `extnav`, and no health claim is made before evidence passes |
| GPS loss with healthy optical flow only | Source selection | GPS vote fails, extnav is unhealthy, flow quality ≥ 50, and velocity innovation ≤ 0.15 m/s | `hold` | Companion navigation manager | Disable GPS/LIO and inject qualifying flow | Source changes to optflow; sub-threshold quality or excessive innovation never reports optflow healthy |
| GPS loss plus GNSS interference | Correlation window | `navSource` leaves GPS and a `gnss_interference` event occurs within 60 s | `escalate` | Ground health correlator | Disable GPS, then inject SDR event inside 60 s | One `probable interference` health event appears within 5 s with both evidence IDs |
| Hostile drone | Pre-flight inside geofence or buffered route | `hostile_drone` RF event intersects geofence or route buffer | `refuse` | Ground MissionVerifier `airspace` check | Inject hostile-drone fixture before approval | Verification refuses and approve remains disabled with airspace reason |
| Hostile drone | In flight | Valid hostile-drone event enters active geofence | `hold` | Companion/ground airspace monitor | `--hostile-drone` during orbit | Vehicle holds within 5 s; only operator continue or operator RTL can leave the state |
| Battery below reserve | In flight | Lower authoritative SoC estimate crosses reserve/return threshold | `rtl` | Companion battery watchdog | Drain `SIM_BATT` | RTL preempts planner within 5 s and audit reason names reserve |
| Sortie timer | In flight | Elapsed time reaches `max_sortie_s - estimated_return_time_s` | `rtl` | Companion sortie watchdog | `--sortie-cap SECONDS` | RTL begins before cap; planner heartbeat cannot override it |
| Pack fault, cell imbalance, or over-temperature | On pad | Fault bit, cell delta > 0.10 V, or temperature > 60 °C | `refuse` | Companion arming gate and verifier readiness check | `--battery-fault` with each fault variant | Arm/dispatch is refused and UI lists the exact threshold failure |
| Pack fault, cell imbalance, or over-temperature | In flight | Same pack health checks become unsafe after takeoff | `rtl` | Companion battery watchdog | Inject fault after takeoff | RTL preempts planner and records the measured fault |
| Charge stalled or regressing | On pad | Requested charge gains < 0.5 percentage points in 15 s or falls > 0.5 points | `refuse` | Companion charge-state monitor | Freeze or reverse scripted charge curve | `battery charge_stalled` is emitted and readiness remains false |
| SoC estimate divergence | On pad | Coulomb and voltage estimates differ by > 10 percentage points | `refuse` | Companion battery estimator | Inject divergent estimates above and below readiness | Lower estimate is used, state is `degraded_estimate`, and dispatch stays disabled pending a trustworthy estimate |
| SoC estimate divergence | In flight above reserve | Same divergence occurs while the lower estimate remains above return threshold | `escalate` | Companion battery estimator | Inject divergence without crossing reserve | Lower estimate drives remaining time and a degraded-estimate event is shown; crossing reserve is covered by the battery-reserve row |
| Wind above limit | First detection | Wind estimate exceeds 12 m/s | `hold` | Companion safety monitor | Inject wind above threshold | Hold occurs within 5 s and no new mission leg starts |
| Wind above limit | Persistent/unsafe return decision | Above-limit wind persists for the configured confirmation period | `rtl` | Companion safety monitor | Keep injected wind above threshold | RTL starts and cannot be cancelled by planner output |
| Bad setpoint reaches flight controller | Firmware backstop | Raw env-gated test command targets outside loaded fence | `rtl` | ArduPilot native fence | Enable test hook and inject out-of-fence target | Configured fence action is observed, telemetry/audit identify firmware authority, maximum geofence excursion is measured, and the vehicle remains inside the outer perimeter containment margin |
| Camera or YOLO failure | Recognition | RGB capture is missing/stale or detector raises; no valid observation frame exists | `escalate` | Recognizer | `--camera-fail` | Incident says `no observation`; it does not describe an empty valid frame as sensor failure |
| Camera or YOLO failure | Mission terminal | Recognition completes with no observation | `rtl` | Companion mission executor | Continue camera-fail scenario | Mission still returns home after the escalation |
| Thermal failure | Pre-flight night mission | `simulateNight` and thermal readiness is not `ok` | `refuse` | Ground verifier readiness check and companion gate | `--night --thermal-fail` | Dispatch is refused with thermal-at-night reason |
| Thermal failure | In flight | Thermal rail becomes stale/failed after takeoff | `escalate` | Recognizer | Fail thermal during active mission | RGB/LiDAR evidence continues, report is marked degraded, and no thermal detections are fabricated |
| LiDAR failure | Pre-flight clutter route | Route intersects `clutter` while LiDAR readiness is not `ok` | `refuse` | Ground verifier readiness check | `--lidar-fail` before clutter mission | Dispatch is refused with LiDAR/clutter reason |
| LiDAR failure | In flight | LiDAR freshness/health fails after takeoff | `hold` | Companion obstacle/navigation manager | Fail LiDAR during active route | Avoidance disables, vehicle holds while climbing to `clear_altitude_m`, and only then continues outside clutter |
| Modality disagreement | Recognition | Associated thermal/RGB/LiDAR tracks disagree within fusion gate | `escalate` | Recognizer | Thermal-person fixture with no matching LiDAR cluster | Both modality tracks remain, fused confidence is reduced by 0.15, and low-confidence policy escalates |
| Companion crash | In flight | MAVLink/GCS heartbeat from companion disappears | `rtl` | ArduPilot firmware | Terminate companion process | Firmware enters RTL without ground involvement |
| Ground station crash | Active outbound/observation leg | Companion loses both ground and planner heartbeats | `hold` | Companion watchdog | Terminate Electron host during active leg | Current safe hold policy persists and local audit remains recoverable on reconnect |
| Ground station crash | Return already required | Companion loses ground while sortie/battery/fence policy already requires return | `rtl` | Companion watchdog and ArduPilot firmware | Terminate ground station after return trigger | Existing RTL continues; reconnect resyncs state without replaying commands |
| Vehicle lost mid-mission | Fleet view | Vehicle heartbeat and telemetry disappear beyond loss timeout | `escalate` | Ground fleet monitor | Drop one vehicle fixture permanently | Operator alert names `vehicleId`; no automatic fleet reallocation occurs |
| Mesh partition | Any | Mesh adapter reports partition or peer timeout | `escalate` | Ground fleet monitor | Script a mesh-partition health event | Event is documented and visible; no invented peer health or reallocation occurs |
| Invalid `site.json` | Pre-flight | Site parser or geometry invariants fail | `refuse` | Ground MissionVerifier `site_valid` check | Select malformed/missing-field site fixture | Every mission is refused with validation detail and no fallback occurs for an explicitly selected path |
| False-positive anomaly | Mission terminal | Valid observation supports `false_alarm` | `rtl` | Recognizer and companion mission executor | Inject false-alarm staging truth | Report verdict is `false_alarm`, audit is retained without incident escalation, and vehicle returns home |
| Manual engage | Any automated mode | Acked operator manual-engage command arrives | `hold` | Companion control arbiter | Engage manual during planner/tracking mode | Automation is released immediately, one control source remains active, and zero/hold precedes fresh manual input |

## Observation-state invariant

A healthy sensor frame containing zero tracks is a valid observation and may
support `false_alarm`. `No observation` is reserved for a missing, stale, failed,
or invalid sensor frame. The recognizer, UI, fixtures, and reports must preserve
this distinction.

## Authority invariant

The LLM never owns a response in this table. Ground validation may refuse or
escalate; companion watchdogs may hold, refuse, or RTL; ArduPilot firmware owns
the final fence and heartbeat RTL backstops. Manual engagement is operator intent
enforced by the companion arbiter. Every e2e injection must assert both the state
and the named authority so a ground-side event cannot masquerade as a firmware or
companion action.

---

## Runtime assurance, unattended mode and fleet (Phases 2–3)

Corridor geometry and tolerances are ADR D21; monitor policy per constraint is
ADR D22; `UNATTENDED_ENVELOPE` is ADR D23; the escalation adapter is ADR D24; cue
rails are ADR D25; the two-vehicle star topology is ADR D26. The columns, the
one-state-per-row rule, and the authority invariant above apply unchanged to every
row in this section.

Two conventions specific to this section. **Warning-and-slow is not a failsafe
state**: drift inside 2× tolerance reduces commanded speed and raises a warning,
and only the rows below change state. **Recovery is hysteretic**: a condition
clears only after the measurement returns inside tolerance by a margin and stays
there, so a vehicle riding the tolerance edge does not flap between states.

| Failure | Phase | Detection | Response | Authority | SITL/scripted injection | Required e2e assertion |
|---|---|---|---|---|---|---|
| Corridor breach | In flight, first trip | Cross-track error exceeds 2× lateral tolerance (10 m `inspect` / 15 m `survey`), or orbit radial error exceeds 2× 5 m, or altitude leaves the plan's band | `hold` | Companion monitor | `--gust SECONDS` pushes the vehicle off the corridor | State becomes `hold` within 5 s of the 2× crossing, the setpoint is zeroed, and the audit entry names the breached constraint, the measured error and the tolerance |
| Corridor breach | Recovery | Error returns inside tolerance by the hysteresis margin and holds for the recovery window | `hold` | Companion monitor | End the injected gust | The vehicle leaves `hold` only after the hysteresis window, resumes the same plan, and the audit shows one entry and one exit — no state flapping |
| NFZ buffer or geofence margin breach | In flight | Position enters an NFZ polygon buffered by `nfz_buffer_m`, or crosses the geofence margin | `rtl` | Companion monitor | `--guidance-override SECONDS` commands toward the switchyard NFZ | RTL begins within 5 s, no position sample lies inside the unbuffered NFZ or outside the geofence, and the plan cannot resume without a new verified dispatch |
| Persistent breach | In flight, breach unresolved | Any monitor trip above persists 5 s | `escalate` | Companion monitor and ground escalation adapter | Hold the injected gust or override past 5 s | One escalation is raised within 1 s of the 5 s mark, carries `vehicleId`, the constraint and the measured excursion, and the vehicle's `hold`/`rtl` state is unchanged by the escalation |
| Monitor input stale — mission record hash mismatch | Dispatch | The mission record hash the monitor holds does not match the verified plan's hash, or the audit chain has a gap | `refuse` | Companion validator | Mutate the plan after verification, or drop an audit link | Dispatch is refused with a hash-mismatch reason, no setpoint is issued, and the refusal names both hashes; the monitor never runs against an unverifiable record |
| Unattended task outside envelope | Unattended dispatch | Task violates any `UNATTENDED_ENVELOPE` constraint — outside perimeter, non-`inspect` profile, altitude outside 30–50 m, more than one lap, hold > 15 s, third sortie in the hour, `navSource != gps`, RF interference, hostile drone, night without healthy thermal, or wind above half the attended limit | `refuse` | Ground verifier and companion validator | `--unattended` with a fixture violating each constraint in turn | Dispatch is refused, the refusal names the violated constraint and its envelope value, and no arming occurs; refusal happens with the operator absent, not merely without approval |
| Unattended task outside envelope | Operator notification | The refusal above is raised while no operator session is connected | `escalate` | Ground escalation adapter | Same fixtures with `--operator-absent` | An escalation is raised for every envelope refusal, reaching the control-room destination first, and the escalation is retained in the outbox when no channel is available |
| Operator absent, approval expired | Attended dispatch | No operator session, or the approval covering this task has passed its expiry | `refuse` | Ground verifier | `--operator-absent` after issuing a short-lived approval | Dispatch is refused with an expired-approval reason, an expired approval cannot be reused or extended by any wire message, and entering unattended mode still requires a signed command |
| Operator absent, escalation unacknowledged | Escalation chain exhausted | No acknowledgement at any destination through the full chain | `escalate` | Ground escalation adapter | `--operator-absent` for the whole chain duration | Every step fires at its configured time and destination, the vehicle RTLs on its own sortie/battery timer regardless of acknowledgement, the same cue is not re-flown, and no party outside the site is contacted |
| Escalation delivery failure | Any escalation | A channel's retries are exhausted without delivery | `escalate` | Ground escalation adapter | Fail the scripted channel, then each stub channel | Retries occur on the configured schedule, a `healthEvent` of `escalation_undelivered` is emitted, the incident remains in the local outbox, and further unattended dispatch is refused while it is undelivered |
| VMS down | Cue ingest | The CCTV rail's VMS connection fails or its events stop inside the freshness window | `escalate` | Ground cue adapter (`cctv`) | Stop the scripted VMS event source | The `cctv` rail reports `failed` (never `healthy`, never `unknown`-as-nominal), a health event names the rail, every other rail continues to produce cues, and no cue is synthesised for the failed rail |
| Camera offline | Cue ingest | One camera's health fails while the rail is otherwise up | `escalate` | Ground cue adapter (`cctv`) | Mark one fixture camera offline | The zones covered by that camera are reported blind and shown as blind, no dispatch originates from a blind zone, and coverage elsewhere is unchanged |
| Miscalibrated camera | Cue ingest | A pixel-derived cue projects outside the operational geofence, or calibration validation fails | `refuse` | Ground cue adapter (`cctv`) | Corrupt the fixture camera's heading/FOV/range calibration | The cue is rejected without dispatch, a calibration warning names the camera, and the invalid projection never reaches triage or the planner |
| Peer data stale | Separation widened | Peer telemetry age exceeds 3 s; the separation requirement becomes 80 m | `hold` | Companion monitor | `--peer-stale SECONDS` with `SECONDS` between 3 and 10 | The separation requirement widens to 80 m within one tick; the vehicle holds rather than closing inside the widened separation, and continues only while the widened separation is satisfied |
| Peer data stale | Beyond 10 s | Peer telemetry age exceeds 10 s | `hold` | Companion monitor | `--peer-stale 12` or longer | The vehicle holds unconditionally within 5 s regardless of geometry, and does not resume until fresh peer data restores the age below 3 s under hysteresis |
| Ground station down, two vehicles airborne | Loss detected | Both vehicles lose the ground and planner heartbeats; peer data ages past its limits with no relay | `hold` | Companion watchdog, each vehicle independently | Terminate the hub with both vehicles on active legs | Each vehicle holds within 5 s on its own watchdog, neither waits on the other, separation is evaluated from last-known peer data at the widened requirement, and no vehicle-to-vehicle path is used |
| Ground station down, two vehicles airborne | Hold timer expires | Each vehicle's own hold/sortie/battery timer reaches its return trigger | `rtl` | Companion watchdog and ArduPilot firmware | Keep the hub down past both timers | Each vehicle RTLs on its own timer, the two returns are independent and need no coordination, and reconnecting the hub resyncs state without replaying commands |
| One vehicle lost | Fleet, other vehicle airborne | One vehicle's heartbeat and telemetry disappear beyond the loss timeout while the other flies | `escalate` | Ground fleet monitor | Drop one vehicle fixture permanently mid-mission | The operator alert names the lost `vehicleId`, the surviving vehicle continues its plan under the widened 80 m separation against the peer's last-known position, and no automatic reallocation of the lost vehicle's task occurs |
| Allocation loop | Task allocation | A task cannot be allocated because each candidate vehicle is excluded by a different constraint, and re-evaluation would repeat the same exclusions | `refuse` | Ground fleet allocator | Construct a two-vehicle fixture where each vehicle is excluded for a different reason | The task is refused once, the refusal names **both** exclusion reasons with the `vehicleId` each applies to, and the allocator does not re-enter the loop or hand the decision back to the LLM |

### Section invariants

- **The monitor constrains; it never guides.** Every row above is the monitor
  observing a plan being flown and changing state; no row produces a new
  trajectory, a new waypoint, or a relaxed limit.
- **Envelope and corridor values are not configurable downward into unsafety.**
  A profile or configuration may tighten a tolerance, a band or a sortie cap; it
  can never widen one past the hard envelope, and a configuration that tries is a
  `refuse`, not a clamp.
- **Every row carries `vehicleId`** in its wire message and its audit entry, so a
  fleet event is always attributable to a specific vehicle rather than to "the
  fleet".
- **Escalation never changes the flight state.** An escalation is a message to
  humans; the vehicle's `hold`/`rtl` is decided by the companion and remains
  decided by the companion whether or not anyone reads it.
- Demo flags (`--gust`, `--guidance-override`, `--operator-absent`, `--bad-plan`,
  `--handoff`, `--peer-stale`) are the injection surface for these rows and are
  listed with their demo beats in [`docs/DEMO_RUNBOOK.md`](DEMO_RUNBOOK.md).
