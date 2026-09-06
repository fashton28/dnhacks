# ADR — hackathon retrofit (power-plant security system)

Runtime paths in this document are relative to [`platform/`](..), this file's
parent directory.

Decisions made while retrofitting the Drone Safety Platform monorepo into the
two-layer AI security demo (satellite change detection → LLM mission plan →
deterministic trust layer → SITL flight → observation → incident report).
Format: one numbered decision per row of work; append, don't rewrite.
Per the working agreement: we don't stop to ask — we decide, record here, move on.

## D1 — Site stub home = SITL default home (CMAC)

`site/site.stub.json` puts home at `-35.363261, 149.16523, 584 m` — ArduPilot
SITL's default CMAC home — so the stock SITL world flies the stub with zero
parameter changes. When the site owner's `site/site.json` lands with a real
plant location, nothing in code changes; SITL home comes from the same file.

## D2 — Site file selected by `EIS_SITE_FILE`

Default `site/site.json`; the demo/test path sets
`EIS_SITE_FILE=site/site.stub.json`. Cutting over to the real site model is
deleting that env var, nothing else. Schema + semantics live in
[`docs/SITE_CONTRACT.md`](SITE_CONTRACT.md); additions go there, never hardcoded.

## D3 — NFZ ceiling semantics

Flight inside an NFZ polygon at or below `ceiling_m` AGL is forbidden;
overflight above it is allowed. The stub switchyard ceiling (120 m) sits above
the alt band (20–60 m), making it a full no-go for this system — which is what
the scripted "plan fails verification" demo relies on.

## D4 — Offline-first fallbacks, selected by env vars

Nothing on the demo or test path may block on the network.

- `EIS_PLANNER_MODE` = `scripted` (default) | `live` — ScriptedPlanner vs live LLM.
- `EIS_SAT_MODE` = `baked` (default) | `live` — baked change-detection result vs
  computing it from the baked Sentinel-2 tiles (still offline) / fetched tiles.

Live modes are opt-in flags on the demo scripts only.

## D5 — Test strategy on this box

Ground: `npm run typecheck` + `lint` + unit tests run natively on Windows per
phase. Companion: pytest in a Python 3.10–3.12 venv (numpy 1.26.4 pin does not
build on 3.14). The SITL e2e gate runs under WSL2 with the ground side on
Windows; each phase commits green on everything runnable natively, and the
full gate is the Phase 4 exit criterion.

## D6 — Placeholder staging images are stdlib-generated PNGs

`site/staging/stage-*.png` are generated 320×240 PNGs (no PIL/opencv needed at
generation time): stage-a shows a crude vehicle (truth `vehicle`), stage-b an
empty pad (truth `false_alarm`). Live vision runs YOLO on whatever image the
site file points at; scripted paths use the `truth` field directly.

## D7 — `requestId` is ground-side correlation only

Wire acks keep correlating by command **name** (the existing FIFO match in
LiveDataProvider); `requestId` lives inside the MissionPlan/Verification
payloads for ground-side plan↔verdict correlation. CommandAck is unchanged.

## D8 — Toolchain reality: uv-managed 3.12 venv; SITL in Docker

WSL2 on this box has only the docker-desktop utility distro (no usable
userland), so the original "SITL under WSL2" assumption does not hold here.
Companion tests run in a uv-managed CPython 3.12 venv at `companion/.venv`
(numpy 1.26.4 pin does not build on the system 3.14). The Phase 4 e2e gate
targets ArduCopter SITL in a Docker container exposing TCP MAVLink
(`tcp:127.0.0.1:5760`); scripts keep a native/WSL2 path for boxes that have
a Linux userland.

## D9 — Meridian Station replaces the CMAC stub geometry

This decision supersedes D1's temporary Canberra geometry. The demo site is
Meridian Station (fictional), the one site the whole team consolidated on: home
`41.1992364, -98.3995821`, terrain elevation `550 m` AMSL. `site/site.stub.json`
now carries the site footprint as its perimeter, the ARGUS operational geofence
inset inside it, a 25 m NFZ buffer, reactor-exclusion and switchyard NFZs, two
staging points, clutter polygons, and a 45 m AGL LiDAR-degraded clear altitude.
The stub is GENERATED from the ARGUS site sources by
[`site/gen_platform_site.py`](../site/gen_platform_site.py); it is a
deterministic integration stub, not a survey. The site owner still supplies
`site/site.json`; D2's environment-variable cutover is unchanged.

The checked-in stage PNGs are generated scripted placeholders. Both `image` and
`thermal_image` may point to the same placeholder only when
`image_kind=scripted_placeholder`; no documentation or UI may describe those
files as real RGB, thermal, satellite, or SAR captures.

## D10 — GPS-loss voting and EKF source ownership

The companion alone chooses the EKF source from onboard evidence. It evaluates
the source vote every 2 seconds, using the defaults demonstrated by ArduPilot's
[`ahrs-source-gps-optflow.lua`](https://raw.githubusercontent.com/ArduPilot/ardupilot/master/libraries/AP_Scripting/examples/ahrs-source-gps-optflow.lua): GPS speed accuracy of 0.3 m/s is the healthy target and values above 1.0 m/s are not usable; optical-flow quality must be at least 50 and the velocity innovation disagreement must be no more than 0.15 m/s. These are initial SITL tuning values, not claims that a rail is healthy.

Source set 1 is GPS. On GPS loss, source set 3 (`extnav`) is preferred only when
LiDAR-inertial odometry is reporting healthy. Source set 2 (`optflow`) is eligible
only when optical-flow quality and innovation checks pass. With no healthy
fallback the vehicle holds and refuses missions. The switch uses the actual
ArduPilot command `MAV_CMD_SET_EKF_SOURCE_SET` (`42007`) described in the
developer guide for [non-GPS position estimation](https://ardupilot.org/dev/docs/mavlink-nongps-position-estimation.html). The LLM and ground station can observe the result but cannot issue the switch.

## D11 — Receive-only SDR sidecar and fixed detector thresholds

`ground/sdr` is a separate Python process so optional radio drivers cannot block
the planner or UI. Live input uses SoapySDR or pyrtlsdr and numpy; scripted input
is the default e2e rail. The first live band is GNSS L1. Processing uses a
4096-point FFT, maintains a rolling 60-second floor baseline, and emits one band
summary per second. It declares `gnss_interference` when either the floor rises
by at least 6 dB for at least 2 seconds or a narrowband peak rises by at least
15 dB within ±1 MHz of the carrier. Warmup and no-device states are explicit and
never reported as nominal.

The sidecar is receive-only by construction: no transmit API, gain mode, config,
test hook, or documentation path exists. The Electron main process owns its
lifecycle and consumes newline-delimited JSON; the renderer receives validated
messages over `sdr:*` IPC.

## D12 — Passive RF-drone feed adapter

The RF-drone rail is a stub adapter in this run. Its fixture/event shape is:

```json
{
  "vehicleId": "eis-1",
  "source": "rf_drone",
  "kind": "hostile_drone",
  "band": "2.4GHz",
  "power_delta_db": 18.0,
  "lat": 41.1994161,
  "lon": -98.3993195,
  "pilot_lat": 41.1996407,
  "pilot_lon": -98.402746,
  "confidence": 0.9
}
```

An offboard sensor's raw ingress may omit `vehicleId` and the location/power
fields; `source`, `kind`, `band`, and `confidence` are required. Before the event
reaches the wire or audit log, the adapter attaches the configured vehicle ID
(`eis-1` by default), so every emitted envelope satisfies D13. The adapter
validates and forwards only; it cannot transmit or command a vehicle. Missing
hardware is `unknown`, not `healthy`.

## D13 — Vehicle identity and profile aliases

Every wire envelope and audit-log entry carries `vehicleId`; the single-vehicle
default is `eis-1`. Existing nested mission payload shapes remain unchanged.
Routing by identity is ready for the UI and logs, while fleet execution and
reallocation remain out of scope.

Mission profile names are `follow`, `inspect`, and `survey`. Compatibility names
remain valid: `slow → follow` at 2 m/s, `standard → inspect` at 4 m/s, and
`fast → survey` at 6 m/s. `verifier_fixtures/profiles.json` materializes both
name sets so old plans remain replayable. Every value remains beneath the hard
8 m/s speed cap and above the hard 3 m standoff floor.

## D14 — Hostile-drone response is phase-specific

A hostile drone inside the geofence causes pre-flight refusal. A detection after
takeoff causes an immediate hold; the operator chooses continue or RTL. The LLM
cannot choose that branch. GPS loss correlated with a GNSS-interference RF event
within 60 seconds escalates as `probable interference`; either signal alone holds
and is logged.

## D15 — RGB, thermal, LiDAR, and fusion policy

RGB, thermal, and LiDAR run in parallel. The real thermal detector is YOLO
fine-tuned on public thermal data such as FLIR ADAS and LLVIP; the default demo
uses the deterministic scripted detector. A night mission requires healthy
thermal at dispatch. Live thermal failure degrades the report but does not erase
valid RGB or LiDAR evidence.

LiDAR is used for obstacle avoidance, LiDAR-inertial `extnav`, vehicle-sized
geometry, fence continuity, and new structures. The deterministic first-pass
geometry rules use 0.25 m voxels and DBSCAN-style clusters with 1.5 m neighbour
radius and at least 8 points. A vehicle-sized cluster has a 2–20 m² footprint
and 1–4 m height. A fence gap requires at least 2 m of expected fence profile
without returns in three consecutive scans. Clutter transit requires healthy
LiDAR at dispatch; in-flight LiDAR loss disables avoidance and climbs to the
site's `clear_altitude_m` before continuing outside clutter.

Fusion associates tracks within 5 degrees bearing and 5 m range. Agreement by
two modalities adds 0.10 confidence, capped at 0.99. Disagreement retains every
modality-tagged track and subtracts 0.15 from the affected fused confidence,
floored at zero. Agreement is never required to report. An empty, valid sensor
frame means “no detections”; a missing, stale, or failed frame means “no
observation” and escalates. Those states must never be conflated.

## D16 — Battery, sortie, and charging policy

The range placeholder is a 25-minute quad endurance with RGB, thermal, and LiDAR
payload already accounted for, a 25-percentage-point full-pack reserve, wind time multiplier
`1 + 0.05 × wind_mps`, maximum wind 12 m/s, and anomaly proximity 200 m. Range
uses live SoC: available time is `1500 × max(0, (live_soc_pct − 25) / 100)`.
The planner budget is the smaller of that range time and the 480-second sortie cap.

Dispatch requires `charge_state=charged`, SoC at least 80%, cell delta no more
than 0.10 V, temperature no more than 60 °C, and no pack fault. Profile/config
overrides may shorten 480 seconds, raise 80%, lower 0.10 V, or lower 60 °C; they
cannot weaken those thresholds. The companion independently refuses arming when
the pack is not ready and RTLs at `cap − estimated return time`.

SoC is coulomb-counted in flight and re-anchored to the voltage-derived estimate
only while disarmed under low load. If the two estimates differ by more than 10
percentage points, the lower value is authoritative and the battery becomes
`degraded_estimate`. Positive current means discharge. On a disarmed vehicle at
the pad, external power plus current at or below −0.5 A and rising SoC for 10 s
means `charging`; SoC at least 95% and absolute current at or below 0.3 A for 10 s
means `charged`. A requested charge that gains less than 0.5 percentage points in
15 s, or regresses by more than 0.5 points, emits `battery charge_stalled` and
stays not-ready. SITL uses a scripted monotonic charge curve; demo scale defaults
to a complete 30-second cycle.

## D17 — Verified baseline and publication branch

The work began from clean commit `cd7e25c`, whose Phase 3 ground verification
verdict was SHIP: UI typecheck/lint/build, 43 planner tests, 21 satellite tests,
Windows shell typecheck, CLI failing/pass smokes, core-purity/static checks, shell
sync, and offline mock-flow review all passed. The companion baseline also passes
193 tests. The Docker daemon is available with cached `radarku/ardupilot-sitl:latest`;
WSL contains only `docker-desktop`, so native WSL SITL is unavailable on this host.

GitHub `fashton28/dnhacks` began with unrelated `main` history and no merge base
with this monorepo. The baseline was integrated through a separate worktree that
preserved remote files and subsequent changes, then pushed normally to `main` at
`2a10ebf`. Keep logical commits in the feature workspace and integrate them
incrementally through that worktree. Never force-push or overwrite remote history.

---

## Decision numbering

D14–D17 were already taken when the runtime-assurance decisions below were
recorded, so those decisions continue the sequence at **D18**. Where a phase
brief refers to them by a working label, the parenthesised label in each heading
is that reference. Numbers are never reused and never renumbered.

| Brief label | Recorded as |
|---|---|
| D14 | D18 |
| D15 | D19 |
| D16 | D20 |
| D17 | D21 |
| D18 | D22 |
| D19 | D23 |
| D20 | D24 |
| D21 | D25 |
| D22 | D26 |

## D18 (brief D14) — `platform/` is the canonical layout

The monorepo lives under `platform/`: `platform/ground/`, `platform/companion/`,
`platform/shared/`, `platform/site/`, `platform/sim/`, `platform/scripts/`,
`platform/verifier_fixtures/`, `platform/docs/`. The teammates' ARGUS stack keeps
the repository root (`hub/`, `console/`, `argus-core/`, `contracts/`, `sim/`,
`tests/`) and is not modified from this side.

A consolidation into that layout dropped four commits; they were re-applied on
top of the consolidated tree rather than reverted, because the layout is the thing
the rest of the work depends on. The retrofit documents (`ADR-hackathon.md`,
`FAILURE_MODES.md`, `SITE_CONTRACT.md`, `SESSION_AUDIT.md`) move with the code
into `platform/docs/`, which also makes every existing in-code reference of the
form `docs/SITE_CONTRACT.md` resolve correctly relative to `platform/`.

One consequence is a naming constraint: `platform/docs/runbook.md` is the hardware
commissioning runbook, and this repository is developed on a case-insensitive
filesystem, so a demo runbook cannot be called `RUNBOOK.md` without destroying it.
The demo runbook is [`docs/DEMO_RUNBOOK.md`](DEMO_RUNBOOK.md).

## D19 (brief D15) — Live planner provider is OpenAI; scripted stays the default

`EIS_PLANNER_MODE` keeps its D4 semantics: `scripted` is the default and the only
mode on the demo and test path, `live` is opt-in. The live provider is **OpenAI**,
matching the replayed `e40513c`; the adapter is one implementation behind the
planner-host interface and the scripted planner is not a fallback bolted on
afterwards but the primary path.

The choice of vendor changes nothing about authority. The model emits
**schema-bound JSON only** — a task, or a report — and never a plan, coordinate,
altitude, tool invocation, setpoint or mode change. A live-mode failure (timeout,
malformed output, refusal) selects the scripted planner without waiting on the
network; if the scripted fallback also cannot produce a schema-valid plan, the run
escalates and no executable plan is emitted.

## D20 (brief D16) — Plan generation is deterministic, not model-generated

**Why it moved out of the LLM.** Geometry is the part of this system that must be
reproducible, reviewable and refusable. A model-generated plan cannot be diffed
against a rule, cannot be replayed identically from a fixture, and turns every
verifier rejection into a negotiation. Worse, it makes the plan an attack surface:
a lure or an injected cue that can influence altitude, standoff or route defeats
the whole safety argument (see `docs/THREAT_MODEL.md` § A6.2). Moving plan
generation into a rule table means the model contributes judgement — what to look
for, how urgent — and the flight envelope is a pure function of the task and the
site file.

**The rule table.** Inputs: the task (`lookFor`, location, priority), the site
model, the profile table, and the range model. Output: a plan, or `infeasible`.

| Rule | Definition |
|---|---|
| Profile | `lookFor` ∈ {`person`, `vehicle`, `fence_gap`} → `inspect`; `structure` → `survey`; anything unknown → `inspect` |
| Altitude | Middle of (profile altitude band ∩ site `alt_band_m`). An empty intersection is `infeasible` — never a clamp to an unsafe value |
| Route | A straight leg if it clears every NFZ buffered by `nfz_buffer_m` and stays inside the geofence; otherwise the shortest via-point detour around the buffered polygons; otherwise `infeasible` |
| Orbit | Radius shrunk until it clears buffered NFZs and the geofence, but **never below the standoff floor**. If clearing requires going below standoff, `infeasible` |
| Laps | Exactly 1 |
| Hold | 15 s, and only when `lookFor = fence_gap`. Every other task has no hold |
| Terminal action | `rtl` |
| Time budget | `min(range time from the live-SoC range model, 480 s sortie cap)` |
| Tie-break | Lowest total detour distance first; on a tie, the **northernmost** via-point |

The tie-break exists so that two runs of the same task produce the same plan
byte-for-byte, which is what makes a plan hash usable as a mission-record
identity. `infeasible` is a first-class outcome: the planner refuses rather than
producing a plan that the verifier would have to reject.

## D21 (brief D17) — Corridor geometry and tolerances

A plan is flown inside a **corridor**, and the corridor — not the waypoint list —
is what the monitor checks.

| Constraint | Value |
|---|---|
| Lateral tolerance, `inspect` legs | 10 m |
| Lateral tolerance, `survey` legs | 15 m |
| Radial tolerance, orbits | 5 m |
| Inter-vehicle separation, nominal | 40 m |
| Inter-vehicle separation, peer data older than 3 s | 80 m |
| Peer data older than 10 s | Hold |

Survey is wider than inspect because a survey pattern is deliberately looser and
flown further from what it observes; the orbit's radial tolerance is tighter than
either because radius is the term that trades directly against standoff.
Separation doubles rather than degrades gracefully when peer telemetry ages,
because a stale peer position is an unknown peer position; past 10 s the honest
answer is to stop moving.

## D22 (brief D18) — Monitor policy, per constraint

The monitor observes and constrains; it never issues guidance. One state per
trip, from `hold`, `rtl`, `escalate`.

| Condition | Action |
|---|---|
| Corridor drift beyond tolerance | Warning, and slow (reduce commanded speed) |
| Drift beyond 2× tolerance, **or** altitude outside the band | `hold` |
| NFZ buffer or geofence margin breached | `rtl` |
| Standoff below the floor | `hold`, then back off to the floor |
| Any of the above persisting 5 s | `escalate` |
| Recovery | Hysteresis: a condition clears only after the measurement returns inside the tolerance by a margin and stays there, so a vehicle oscillating on the tolerance edge does not flap between states |

Warning-and-slow before hold exists so that ordinary wind produces a proportionate
response; the 2× threshold is where drift stops looking like disturbance and
starts looking like a control problem. NFZ and geofence go straight to `rtl`
because those are the boundaries that have consequences outside the aircraft.

## D23 (brief D19) — `UNATTENDED_ENVELOPE`

| Constraint | Value | Rationale |
|---|---|---|
| Area | Inside the perimeter | Nothing leaves the site unsupervised |
| Profile | `inspect` only | `survey` is longer and wider-tolerance; it deserves an operator |
| Altitude | 30–50 m AGL | Inside the 20–80 m site band with margin at both edges, above structures and clutter, low enough for useful RGB/thermal |
| Orbit | One lap | Bounded and predictable; no adaptive loiter |
| Hold | ≤ 15 s | Matches the planner's only hold case |
| Sortie rate | ≤ 2 per hour | Bounds cue flooding and preserves battery for a real event |
| No dispatch when | `navSource != gps` | Degraded navigation blocks dispatch instead of degrading it |
| | RF interference present | GNSS integrity unverifiable |
| | Hostile drone detected | Airspace is yielded, never contested |
| | Night without healthy thermal | No thermal at night means no observation worth flying for |
| | Wind above half the attended limit (> 6 m/s of 12 m/s) | Halved because nobody can take manual control |
| Entry | Signed command only | A compromised ground station cannot mint one |
| Exit | Automatic revert on operator connect | The safe direction is always toward supervision |

A task outside the envelope is **refused**, and the refusal **escalates** — an
unattended request the system declined is precisely what a human needs to see.

## D24 (brief D20) — Escalation adapter

Escalation is one interface with pluggable channels. The default and test channel
is **scripted**: it appends to the hash-chained audit log and to a **local
outbox**. Email, SMS and chat exist as stubs behind the same interface so the
delivery path is exercised without a network dependency — consistent with D4,
nothing on the demo or test path blocks on the network.

Each channel retries on its own schedule. When retries are exhausted the adapter
emits a `healthEvent` of `escalation_undelivered` rather than dropping the
escalation silently, and the incident stays in the outbox. Delivery failure is
never allowed to look like delivery, and an undelivered escalation suppresses
further unattended dispatch. The system never contacts any party outside the site
automatically; destinations and timings are in `docs/CONOPS.md`.

## D25 (brief D21) — Cue rails behind one `CueAdapter`

Every sensing rail implements the same adapter — `start`/`stop`, `onAnomaly`,
`health`, `whitelist` — and emits one normalised `anomaly` carrying `vehicleId`,
`source`, `observedAt`, `ttl_s`, `confidence`, location and optional `cameraId`.
Rails: `sentinel2`, `sar`, `sdr`, `rf_drone`, `cctv`, `fence_sensor`,
`drone_survey`. See `docs/CUE_RAILS_SPEC.md` for the binding detail.

Consequences of the single seam:

- **The existing `ground/satellite` and `ground/sdr` code is wrapped, not moved.**
  Working algorithms stay where they are and gain an adapter; no rail introduces a
  command or a new wire message.
- **CCTV is the primary rail in event mode.** A VMS event
  (`{cameraId, zone, class?, ts, thumbnail?}`) is preferred over pixel analysis;
  an ONVIF bridge maps motion topic, source camera token and region ID onto those
  fields. The calibrated one-stream pixel path is the fallback, not the default.
- **RF is an airspace and attribution rail, not a targeting rail.** It informs
  dispatch refusal, hold-after-takeoff, and correlation with GNSS interference. It
  cannot transmit and cannot command a vehicle.
- A live rail failing takes only itself out; the others are unaffected, and a
  failed rail reports `failed`, never `healthy` and never `unknown`-as-nominal.

## D26 (brief D22) — Two vehicles, star topology

Two vehicles, connected to the ground hub in a **star**. No mesh, no
vehicle-to-vehicle radio, no peer-to-peer negotiation.

- **Per-vehicle independence.** Each vehicle keeps its own watchdogs, its own
  battery and sortie timers, its own validator and monitor, and its own audit
  chain. Losing the hub is not a fleet event: each vehicle holds and then RTLs on
  its own timer.
- **The fleet message is the only cross-vehicle input.** A vehicle learns about
  its peer solely from the hub-relayed fleet message, which is what makes D21's
  staleness rule enforceable: separation is a function of peer data age, and the
  age is measurable because there is exactly one path by which peer data arrives.
- **No automatic reallocation.** A lost vehicle escalates to the operator; the
  other continues under widened separation. Task handoff between vehicles is an
  explicit, audited action, not an emergent one.
- Mesh was rejected because it adds a second, unobservable path for peer state and
  an autonomy surface (negotiated deconfliction) that nothing in this concept of
  operations needs at two vehicles.

