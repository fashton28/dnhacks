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
