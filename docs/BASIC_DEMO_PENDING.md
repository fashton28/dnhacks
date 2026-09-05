# Basic demo: pending features and evidence

The basic demo is one repeatable, offline sequence: an anomaly appears, an unsafe plan is refused, a safe plan is approved, ArduPilot SITL flies an inspection, sensor evidence produces a report, and the aircraft returns. Include a benign result and a visible safety intervention. The complete project brief remains broader than this minimum.

This is a progress snapshot against published [`d57da98`](https://github.com/fashton28/dnhacks/commit/d57da98), plus the implementation updates described below. Use this file's Git history for its timestamp. Local work and agent-reported tests are not evidence that a feature has shipped to `main`.

## Published and verified

- The earlier Phase 3 ground verification passed, including the offline rejected-plan to approved-flight to report walkthrough.
- The wire contract includes vehicle identity, battery/readiness, navigation health, sensor observations, RF events, and failure states.
- The platform is consolidated under `platform/`; the published UI and companion CI jobs pass. The optional SITL CI job was skipped, so this is not a live-flight certification.
- [The repository review](REPOSITORY_REVIEW.md) records overlapping components and the adapters they require.

## Teammate progress checked

| Workstream | Observed progress | Remaining dependency for the basic demo |
| --- | --- | --- |
| Teammate decision pipeline | [`181a1a1`](https://github.com/fashton28/dnhacks/commit/181a1a1) publishes `argus-core/` with separate intent, coverage, validation, and triage components. | Integrate through explicit adapters if this pipeline is selected; its verdicts do not authorize the platform directly. |
| Teammate scenarios | [`b36c87c`](https://github.com/fashton28/dnhacks/commit/b36c87c) updates `argus-core/SCENARIOS.md`, including perimeter, benign lighting, route conflict, link degradation, and simultaneous detections. | Choose a common initial scenario and its input/output mapping. Multi-vehicle dispatch is outside the platform's current scope. |
| Teammate topology and world | No committed Webots world or final `site/site.json` was found in the fetched `main` tree. | Use the labelled Komati stub and staged assets for the basic demo. Replace them only when the teammate site contract is available. Unpublished teammate work cannot be assessed from Git. |
| Ground implementation | Local agent reports 87 planner tests and all V01–V25 fixtures passing; satellite suite reports 24 passing tests. Both shell host implementations exist, with Windows typecheck passing. | Finish SDR regression checks, UI integration, shell lifecycle/packaging checks, then commit and publish. These changes are still local at this snapshot. |
| Companion implementation | Battery, navigation, failsafe, fusion, staged sensing, and test-hook code exists locally. The suite collects 216 tests; further runtime fixes are in progress. | Rerun the full suite after fixes and prove the actual WebSocket-to-SITL mission. A collected test count is not a passed test count. |
| Dashboard implementation | Sensor/status/readiness panels, overlays, mock transitions, and the main-process bridge are being integrated locally. | Finish build/lint/type checks and exercise the actual visible workflow. |

The checked GitHub repository has only `main` and no open pull requests. The other local task in this repository contains no implementation progress beyond an initial acknowledgement. This review does not imply access to teammates' unpublished work or private conversations.

## Must finish for a basic demo

| Priority | Pending feature | Done when | Owner/workstream |
| --- | --- | --- | --- |
| P0 | Reliable startup and reset | One command starts the preinstalled simulator, companion, and ground station with offline sources. It reports missing dependencies clearly and a second run starts cleanly. | Companion/runtime and demo scripts |
| P0 | Real battery and navigation readiness | The configured simulator publishes usable health data. Initial arming requires readiness; the arm-to-takeoff transition works; charging and faulted packs are refused with reasons. | Companion/runtime |
| P0 | One complete inspection sortie | Through the public WebSocket contract: approve, arm, take off, travel, orbit, observe, report, RTL, land, and disarm. Retain telemetry and assertions for geofence/standoff. | Companion/runtime and end-to-end gate |
| P0 | One consistent verified plan | Ground and companion agree on argument aliases, orbit laps, tightened speed/altitude limits, and flight-time budget. The executed plan matches the displayed corrected plan. | Ground verifier and companion executor |
| P0 | Working observation evidence | RGB and thermal frames actually resolve; LiDAR detects staged vehicle/gap geometry; processing does not block the control loop. Missing data is visibly unavailable. | Companion sensing and dashboard |
| P0 | Report tied to evidence | The report cites the available modalities. Missing/uncertain observations escalate; a valid reviewed benign scene can yield a false alarm. | Recognizer and dashboard |
| P0 | Visible refusal and intervention | Show unsafe-plan refusal, manual takeover with hold on release, and one in-flight return trigger. The banner and audit log name the actual cause. | Ground, companion, and dashboard |
| P0 | Rehearsed demonstration | The same sequence completes twice without editing code, fetching assets, or manually repairing state. New changes are committed and CI is green. | Integration |
| P1 | Shareable backup video | Save a playable UI walkthrough and a separate SITL clip, with an evidence manifest identifying the source commit, scenario, and simulated/staged inputs. | Dashboard capture and demo scripts |

## Useful after the minimum works

- GPS-loss source switching with genuine simulator evidence, recovery, and RF correlation.
- Hostile-drone preflight refusal and an in-flight operator decision.
- Camera, night-thermal, and in-flight LiDAR failure sequences.
- Native firmware rejection of an out-of-fence target, with observed firmware evidence.
- Two short sorties separated by the simulated charge cycle; battery-drain and sortie-expiry demonstrations.
- The broader failure gauntlet, reconnect/audit replay, Linux package validation, and teammate world integration.

These remain required by the full brief; they are sequenced after a reliable minimum rather than removed from scope. Physical sensors, physical flights, live SDR hardware, real thermal-model performance, and multi-vehicle execution must not be implied by the basic simulation demo.

## Decisions to align with teammates

| Discrepancy | Basic-demo decision |
| --- | --- |
| `CONTEXT.md` describes PX4; the platform brief specifies ArduPilot GUIDED. | Run ArduPilot. Keep teammate documents identifiable as a separate component until the team aligns the shared description. |
| ARGUS scenarios describe Meridian; the platform stub is Komati. | Run one named Komati stub scenario. Do not combine coordinates or exclusion rules from different sites. |
| Separate schemas use `Detection`, `MissionSpec`, `FlightPlan`, and `accept/reject`; the platform uses typed anomaly/mission/verification envelopes. | Convert explicitly at a boundary and reverify candidates with the platform's current site and live readiness. |
| Separate manual-release and fleet concepts exceed current platform behavior. | Manual release holds. Keep the demo single-vehicle. |

## Video collection

No `.mp4`, `.webm`, `.mov`, `.avi`, or `.mkv` files were found in the inspected repository. The existing application recorder writes NDJSON telemetry and event logs; it does not capture video.

Collect three short examples as functionality becomes verified:

1. **Offline UI prototype:** unsafe-plan refusal, corrected plan, readiness, observation panel, and report. Label the entire clip as mock/synthetic.
2. **ArduPilot SITL inspection:** live flight telemetry alongside the ground view, with staged RGB/thermal and synthetic LiDAR identified separately.
3. **Failure handling:** one clear intervention per clip, keeping the triggering action, reason banner, and resulting vehicle state visible.

Store large clips in ignored `recordings/` or a release asset and keep a small manifest with the source commit, scenario/seed, input provenance, capture command, duration, and accompanying log paths. Use Git and actual capture metadata for timestamps. A recording made now demonstrates the current development stage; it does not establish that work existed earlier.
