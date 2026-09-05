# Deck — slide-by-slide

Nine slides plus an evidence appendix. Pairs with `DEMO_SCRIPT.md`; the live
demo sits between slides 4 and 6. Speaker notes are for the presenter only.

Design rule for every slide: **no claim appears here that is not reproducible by
a command in the appendix.** If a number cannot be re-run, it is not on a slide.

---

## 1 — Title

**A drone that is not allowed to fly the plan the model wrote.**

- Autonomous inspection for critical infrastructure — Komati power station
- Satellite cue → LLM plan → deterministic refusal → human approval → ArduPilot
- Offline, end to end, on this laptop

> **Speaker note.** Ten seconds. Do not explain the architecture yet. The title
> is the thesis: the interesting engineering is the word *not*. Everyone in the
> room has seen an LLM plan a mission. Almost nobody has seen one get refused by
> name, on stage, with the approve button greyed out.

---

## 2 — Problem

**A 10 m/pixel picture cannot tell you whether to send a security team.**

- Decommissioned plants are stripped for copper, cable and steel; response is
  reactive and the evidence arrives after the loss
- Sentinel-2 revisits every few days at **10 m/pixel** — enough to see laydown,
  earthworks and a changed footprint; **not** enough to see a vehicle or a person
- A guard patrol is the current answer: slow, expensive, and it goes to the
  location before anyone knows whether something is there
- The gap is not detection. The gap is **confirmation**

> **Speaker note.** Land the resolution number hard — it is the whole reason the
> system has two layers rather than one. One pixel of Sentinel-2 is a tennis
> court. A bakkie is a third of a pixel. The satellite is a *change* sensor, not
> an *identity* sensor, and no amount of model cleverness changes that. Komati is
> a real Eskom station and is treated here as protected critical infrastructure
> (`CONOPS.md`); we are using a labelled stub of its geometry, not survey data.

---

## 3 — Concept: two layers, two jobs

**The satellite finds the change. The drone identifies the thing.**

| | Wide layer | Close layer |
|---|---|---|
| Sensor | Satellite change detection | RGB + thermal + LiDAR on the aircraft |
| Question | *What is different?* | *What is it?* |
| Resolution | 10 m/pixel | centimetres |
| Cadence | Days | Minutes, on demand |
| Output | A georeferenced anomaly + confidence | A classified track + evidence frames + geometry |

- One anomaly becomes one bounded inspection: fly there, orbit once at standoff,
  observe, come home
- The aircraft never follows anyone off site, never interdicts, never confronts
- Every sortie ends in an incident report a human dispositions

> **Speaker note.** This is the slide that makes the demo legible. Say it as a
> handoff: the satellite escalates a *question*, the drone returns an *answer*,
> and a person decides. Note the aircraft's scope limits out loud — it is the
> difference between a security tool and a liability.

---

## 4 — Architecture: three authorities, in order

**The LLM proposes. Deterministic code verifies. ArduPilot enforces.**

```
  satellite tiles ──► change detection ──► anomaly (lat, lon, confidence)
                                              │
                                              ▼
                    LLM planner  ── tool calls only ──►  MissionPlan
                    (goto_gps · orbit_point · hold · rtl · follow · orbit)
                                              │
                                              ▼
                    MissionVerifier — 18 deterministic checks, fixed order
                    pass  │  corrected (re-walked, re-checked)  │  rejected
                                              │
                                       operator hold-to-approve
                                              │
                                              ▼
                    companion PlannerExecutor — re-clamps every setpoint
                    20 Hz loop · one control source · watchdogs
                                              │
                                              ▼
                    ArduPilot — GUIDED setpoints, polygon fence, firmware failsafes
```

- **Proposes, not commands.** The model's entire output surface is a closed
  union of tool calls. No free text, no coordinates-in-prose, no shell
- **Verifies, not reviews.** 18 named checks in fixed order — `schema`,
  `site_valid`, `nav_source`, `readiness`, `wind`, `rf_environment`, `airspace`,
  `anomaly_proximity`, `altitude`, `speed`, `standoff`, `geofence`,
  `nfz_transit`, `nfz_orbit`, `terminal`, `loiter`, `range`, `sortie`
- **Enforces, not trusts.** Every limit is clamped twice, on independent sides of
  the wire: a TypeScript verifier on the ground, a Python executor on the
  aircraft. A corrected plan is fully re-walked and re-checked before release
- **Exactly one control source** is ever active (`auto`, `tracking`, `manual`,
  `planner`), reported in every telemetry frame

> **Speaker note.** The ordering is the argument. Each layer is allowed to be
> less trustworthy than the one below it, and none of them can be talked out of
> its job by the one above. If asked what happens when the LLM is offline: the
> scripted planner takes over, every failure class converges on the deterministic
> path, and no airborne behaviour depends on the model.

---

## 5 — The refusal *(live demo — 3 minutes)*

**Watch the verifier say no, by name, and disable the button.**

- Plan 1 is **REJECTED** on three of eighteen checks:
  - `nfz_transit` — route passes **0 m** from the chimney NFZ; **25 m** required
  - `altitude` — **15 m**, outside the site band **[20, 45] m**
  - `anomaly_proximity` — **no target within 200 m** of the anomaly
- The verifier *offers* repairs it can make (clamp the altitude, route around the
  NFZ) and still refuses, because it will not invent a target near the anomaly
- Plan 2 is **18 for 18 green**. A human holds the button for 900 ms. Readiness
  is re-checked at approve time
- Then: SITL flight, orbit at 25 m standoff, multimodal observation, incident
  report, operator escalation

> **Speaker note.** Do not narrate the architecture while the demo runs — the
> demo *is* the architecture. Read the three red rows out loud, verbatim; the
> specificity is the point. If the verifier's repairs are visible on the failed
> rows, say that the correction is disclosed rather than silent: the corrected
> plan is re-verified and the panel renders a per-tool original-to-corrected
> diff. Full stage script and contingencies: `DEMO_SCRIPT.md`.

---

## 6 — Honest data

**Everything synthetic is labelled. Every interface it sits behind is real.**

| Element | What it actually is | What is real about it |
|---|---|---|
| Satellite tiles | Generated PNGs — `ground/satellite/scripts/make-tiles.mjs`, seed `1592598566`, provenance stamped into `tiles.json` | `detectAnomalies` / `latLonToPixel` / `validateGeoRef` are the production core, running in the browser on those bytes |
| Tile resolution | 512 × 512 px over a **1,300 m × 1,568 m** footprint ≈ **2.5–3.1 m/pixel** | Sentinel-2's real constraint is **10 m/pixel**. Our tiles are *easier* than reality — the two-layer argument is what survives, not the pixel count |
| Staging imagery | `image_kind: "scripted_placeholder"` in the site model, four PNGs | Resolved, decoded and cited through the same frame-reference path a real camera uses; a failed rail shows *evidence withheld*, never a stale frame |
| Site model | Labelled **Komati stub** — nine required fields, `docs/SITE_CONTRACT.md` | Validated by two independent validators; drives the plan, the fence upload, the map and the verifier from one file |
| RF / SDR | Scripted sidecar, fixed detector thresholds (ADR D11) | Receive-only by design; events flow through the real contract envelopes |
| Thermal / LiDAR | Synthetic rails against staged truth | Fusion, disagreement penalties and health gating are real code with real tests |
| Flight | ArduCopter SITL | Real MAVLink GUIDED, real polygon fence upload, real firmware failsafes |

- **No real flight is authorized by any of this** (`CONOPS.md`). Simulation
  results are the only flight evidence in scope
- Known gaps are written down, not hidden: `docs/FAILURE_MODES.md`,
  `docs/BASIC_DEMO_PENDING.md`, and a demo-risk register with ~90 entries

> **Speaker note.** Volunteer this slide before anyone asks. Judges assume the
> pretty parts are fake; the credibility win is being the one who says which, and
> then showing that the *seams* are load-bearing. The resolution line is the one
> to be scrupulous about: our synthetic tiles are ~2.5 m/pixel, which is better
> than Sentinel-2, so do not claim the detector was tested at 10 m/pixel. Claim
> the architecture, which is what the resolution constraint motivates.

---

## 7 — Evidence

**411 automated tests. 49,240 randomised states. Zero invariant violations.**

| | |
|---|---|
| Companion (Python) | **232 / 232** passed in 6.11 s, across 14 test files |
| Ground planner + verifier (TS) | **148 / 148** across 11 files in 4.68 s, behind two `tsc` gates |
| Ground satellite (change detection) | **24 / 24** across 5 files in 2.66 s |
| SDR sidecar | **7 / 7** |
| Ground UI | typecheck **0 errors**, lint **0 errors / 0 warnings** |
| **Total** | **411 passing** |

**Property tests — the safety envelope, not the happy path**

- 6 Hypothesis properties, re-run at **2,000 examples each = 12,000 plans /
  signal sets / flight profiles**, 0 failures, 64.1 s
- **6,000 random mission plans** → **15,097 PlannerExecutor control ticks**, every
  emitted setpoint asserted against speed, altitude band, standoff floor, climb
  rate, yaw rate and finiteness — **0 breaches**
- **17,901 failsafe evaluations** from randomised signal sets and 1–30-step
  sequences — every output in `{none, hold, rtl, escalate, refuse}`, **0 undefined**
- **16,242 battery samples** — SoC never increased in flight
- **49,240 randomised steps total, 0 invariant violations**

**The verifier is not a rubber stamp**

- **25 fixtures: 13 rejected, 10 auto-corrected, 2 pass** — and all **10/10**
  corrected plans re-verify to `pass` with zero failing checks, so no correction
  can smuggle a breach through
- **18 checks** run on every plan, in fixed order, asserted by name every run
- Trust layer: **6,067 lines across 45 files** — **2,887 lines of enforcement**
  against **3,180 lines of tests and fixtures** — **1.10 lines of evidence per
  line of enforcement**
- Two independent implementations of the envelope (TS ground, Python vehicle),
  with parity tests asserting their constants and types agree

> **Speaker note.** Lead with 411 and 49,240, then immediately with **13 of 25
> fixtures rejected** — a verifier that passes everything is decoration, and that
> ratio is the proof it is not. If challenged on the property counts, the
> raised-count run used a scratchpad driver that pulls each property's untouched
> body via `.hypothesis.inner_test` and re-applies the same strategies at 2,000
> examples; **no repository file was modified**. Commands are in the appendix.

---

## 8 — CONOPS: how it would actually be used

**Operator-approved dispatch. Nothing autonomous is unsupervised.**

- **Attended cycle is the only cycle we demo.** Shift start confirms site
  version, no-image policy, launch/return area, link, sensors, battery, wind and
  audit continuity. Synthetic fixture imagery is always labelled as such; no
  missing sensor is ever treated as healthy
- **The operator approves the exact verified record** through the command
  boundary — not a plan summary, not a similar plan
- **Corrected planner output is a defect, not a success.** Infeasible tasks stay
  refused with a reason
- **Escalation is a human chain** with an acknowledgement clock: control room →
  security dispatcher at 30 s → duty supervisor at 60 s → site duty manager at
  120 s. The system never calls emergency services and never directs enforcement
- **Unattended mode exists on paper only** and can only ever *tighten*: inspect
  profile, 30–50 m band (current ceiling 45 m), one lap, ≤15 s hold, ≤2 dispatches
  per rolling hour, GPS only, healthy thermal at night, wind ≤ half the attended
  limit. Operator disconnection alone never enables it
- **Regulatory path.** The site jurisdiction is South Africa: SACAA Part 101
  RPAS, operator/aircraft/pilot/airspace approvals, National Key Point
  restrictions. The equivalent US framing is a **Part 107 waiver path** —
  §107.31 BVLOS and §107.29 night, supported by the same artefacts the system
  already produces: a written CONOPS, a hazard/failure catalogue with
  deterministic responses, a containment argument (geofence + NFZ buffers +
  firmware fence), and a durable audit trail
- **Deployment shape.** Drone-in-a-box: a fixed dock on site, a scheduled
  satellite cue, an operator on a console that may be nowhere near the plant

> **Speaker note.** Two things to convey: this was designed by someone who read
> the rules, and the *evidence a waiver needs is a by-product of how the system
> is built* — the failure catalogue, the deterministic response table and the
> hash-chained audit are not slides written for the regulator, they are the
> running system. Be explicit that the dock is deferred (BOM Tier 2) and that
> unattended operation is specified, tested in pure modules, and **not wired**.

---

## 9 — Team and roadmap

**Working today · next 30 days · the deployment conversation**

**Today (demonstrated)**
- Satellite change detection → LLM planner (tool-calls-only) → 18-check
  deterministic verifier → operator approval → companion re-clamp → ArduCopter
  SITL → multimodal observation → incident report → escalation
- 411 tests, offline end to end, one site model driving plan, fence, map and
  verifier

**Next 30 days**
1. **Tier 0 hardware bench, ~$150** — Matek H743 or SpeedyBee F405, M10 GNSS,
   SiK radios. The companion talks to a *physical* autopilot over USB; the fence
   upload lands on real firmware. Zero flight risk, no regulatory scope
2. **Close the demo-risk register** — wire `windMps` on the live path, verify
   `set_mode` actually changed mode, retry a failed RTL latch, authenticate the
   control WebSocket, call `failsafe_param_map` so limits reach the FC
3. **One consistent verified plan** across ground and companion: aliases, orbit
   laps, budget, and a re-verification at approve time rather than a propose-time
   snapshot
4. **Backup capture** — a recorded UI walkthrough and SITL clip with an evidence
   manifest naming commit, scenario and simulated inputs

**Tier 1 — field validation (~$700–1,400)**
- Holybro X500 V2, Pixhawk 6C, Pi or Jetson companion, RC transmitter for manual
  override. One field day validates the full GUIDED goto → orbit → RTL loop on
  hardware

**Tier 2 — deployment concept (~$2,500–10,000/unit, dock $8,000+)**
- 7–13" long-endurance airframe, RTK GNSS, FLIR Lepton→Boson thermal, optical
  zoom gimbal, LTE link, Jetson Orin NX, commercial dock

> **Speaker note.** The roadmap slide's job is to prove the next step is small
> and specific. "$150 and a physical Pixhawk on the bench, running the fence
> upload you just watched" is a far better close than a funding ask. Name the
> open questions honestly: jurisdiction drives the weight ceiling and
> registration path; Pi versus Jetson is decided by whether live on-board
> inference is a near-term goal.

---

## Appendix — evidence, and how to re-run it

Every number on slide 7. Companion suite and SDR suite use
`companion/.venv/Scripts/python.exe`; ground suites use the pinned
`node_modules` already in the tree.

| # | Claim | Value | How to reproduce |
|---|---|---|---|
| 1 | Companion unit suite | **232/232 passed in 6.11 s** | `cd companion; .venv\Scripts\python.exe -m pytest -o addopts="" -q --color=no` → `232 passed in 6.11s`. Python 3.12.14, pytest 8.2.0, hypothesis 6.100.1. `pyproject` already sets `addopts="-q"`, so a second `-q` suppresses the summary — override `addopts` to see the count |
| 2 | Companion breakdown (14 files) | `test_app_wiring` 42, `test_planner_exec` 45, `test_staging` 32, `test_vehicle` 28, `test_site` 18, `test_guidance` 15, `test_tracking` 14, `test_manual` 13, `test_battery_health` 6, `test_failsafe` 6, `test_failsafe_params` 4, `test_fusion` 3, `test_multimodal` 3, `test_nav_health` 3 = **232** | `pytest -o addopts="" -q --collect-only`, grouped by file |
| 3 | Ground planner suite | **148/148, 11 files, 4.68 s** | `cd ground/planner; npm test` → `tsc -p tsconfig.json` (build) && `tsc -p tsconfig.test.json` (typecheck) && `vitest run`. Both `tsc` gates exit clean. Per file: site 17, verifier-fixtures 77, verifier 14, rf_adapter 7, validate 7, report 7, cli 5, service 4, scripted 4, contract-parity 4, policy-parity 2 |
| 4 | Ground satellite suite | **24/24, 5 files, 2.66 s** | `cd ground/satellite; npm test` (vitest 2.1.9). Per file: detect 10, georef 5, png 5, sar 3, contract-compat 1 |
| 5 | Ground UI typecheck | **0 errors, exit 0** | `cd ground/ui; npm run typecheck` (`tsc --noEmit`) |
| 6 | Ground UI lint | **0 errors, 0 warnings, exit 0** | `cd ground/ui; npm run lint` (`eslint . --ext .ts,.tsx`). `ground/ui` has no unit suite; typecheck + lint are its only automated gates |
| 7 | Total automated tests | **411** = 232 companion + 148 planner + 24 satellite + 7 sdr | SDR suite runs from the repo root: `companion/.venv/Scripts/python.exe -m pytest ground/sdr/tests -q` → `7 passed in 1.20s`. Not in companion's `testpaths`; fails to import if run from inside `companion/` |
| 8 | Property tests as committed | **6 properties, 670 randomised examples per `pytest` run** | From the `@settings` decorators: `test_planner_exec` 120 + 150 + 100 = 370; `test_failsafe` 2 properties at the hypothesis default 100 = 200; `test_battery_health` 1 at default = 100. Default confirmed: `settings.default.max_examples == 100` on hypothesis 6.100.1 |
| 9 | Properties at raised count | **12,000 examples (6 × 2,000), 0 failures, 64.1 s** | Scratchpad driver imports the repo test modules, pulls each property's untouched body via `.hypothesis.inner_test`, re-applies the **same** strategies with `@settings(max_examples=2000, deadline=None)`, and counts. **No repository file was modified.** All 6 returned OK; exit 0 |
| 10 | Mission-envelope properties | **6,000 random plans / 15,097 control ticks, 0 breaches** | The three planner properties at 2,000 each: randomly generated `goto_gps` / `orbit_point` / `hold` / `rtl` legs with deliberately out-of-range lat/lon/alt/radius/profile values, 1–5 legs. `test_property_no_output_ever_breaches` steps each plan through a random 1–25-state run = 11,097 `update()` calls; the other two are 1 call each = 2,000 + 2,000. Every one of the 15,097 setpoints asserted against `speed ≤ min(profile, max_speed)`, alt inside band ∩ `[0, max_altitude]`, orbit radius ≥ `min_standoff` with no inward closure inside it, `|vz| ≤ max_climb_rate`, `|yaw_rate| ≤ max_yaw_rate`, all finite |
| 11 | Failsafe state machine | **2,000 random signal sets + 2,000 random sequences = 15,901 transitions, 0 undefined outputs** | `test_failsafe.py`'s two properties at 2,000 examples. Every `FailsafeSignals` field randomised as a boolean; sequences 1–30 long fed to a live `FailsafeMachine`; every output asserted in `{none, hold, rtl, escalate, refuse}` |
| 12 | Battery SoC monotonicity | **2,000 profiles / 16,242 samples, SoC never increased in flight** | `test_battery_health.py::test_flight_soc_never_increases` at 2,000 examples; each replays 1–30 random currents (0–40 A) plus the initial sample; each `BatteryHealth.update()` asserts `soc_pct ≤ previous` |
| 13 | Total randomised steps | **49,240** = 15,097 planner + 17,901 failsafe + 16,242 battery, **0 invariant violations** | Sum of the per-property tick counters in the driver's JSON summary |
| 14 | Verifier fixture corpus | **25/25 fixtures matched the deterministic verifier** | `cd verifier_fixtures; node run_fixtures.mjs` → one `ok` per case, then `25/25 fixtures matched the deterministic verifier`, exit 0. Runs against the `ground/planner/dist/` built moments earlier by `npm test`. The same 25 also run inside vitest as `verifier-fixtures.test.ts` — 77 of the planner suite's 148 tests (25 × 3 assertions + 2 corpus-integrity tests) |
| 15 | Verdict distribution | **13 rejected, 10 corrected, 2 pass** | From `run_fixtures.mjs`. **pass**: V01, V20 `sdr_no_device`. **corrected**: V06 high_altitude, V07 high_speed, V08 small_standoff, V09 outside_geofence, V10 nfz_transit, V11 nfz_orbit, V12 missing_rtl, V13 low_altitude, V16 lidar_clutter, V23 sortie_too_long. **rejected**: V02 bad_schema, V03 bad_nav, V04 high_wind, V05 far_anomaly, V14 low_range, V15 night_thermal, V17 bad_site, V18 bad_coordinate, V19 rf_interference, V21 hostile_airspace, V22 gps_rf, V24 battery_readiness, V25 geofence_segment |
| 16 | Checks per plan | **18, fixed order** | `CHECK_ORDER` in `ground/planner/src/verifier.ts:42-46`. Each fixture test asserts the full 18-name list is emitted every run |
| 17 | Corrections cannot smuggle a breach | **10/10 corrected plans re-verify to `pass`, 0 failing checks** | `verifier-fixtures.test.ts:114-123` feeds every emitted `correctedPlan` back through `verifyMission` and asserts zero failing checks plus verdict `pass` |
| 18 | Trust-layer size | **6,067 lines (5,582 non-blank) across 45 files** | TS verifier: `verifier.ts` 640 + `site.ts` 589 + `validate.ts` 265 + `policy.ts` 33 = 1,527. Python re-clamp/failsafe: `planner_exec.py` 698 + `battery_health.py` 367 + `nav_health.py` 161 + `failsafe.py` 134 = 1,360. Python property tests: 592 + 64 + 48 = 704. TS verifier tests: 171 + 162 + 126 + 113 + 39 + 32 = 643. Fixture corpus: 25 `V*.json` (1,545) + `baseline_context.json` 42 + `site.fixture.json` 102 + `run_fixtures.mjs` 144 = 1,833 |
| 19 | Enforcement vs evidence | **2,887 enforcement / 3,180 evidence = 1.10 lines of evidence per line of enforcement** | 1,527 TS + 1,360 Python enforcement; 704 + 643 + 1,833 evidence |
| 20 | Double clamp, both sides property-tested | **2 independent implementations; 18 ground checks + 6 vehicle-side proven invariants** | `verifier.ts` `CHECK_ORDER` (18) on the ground; `control/planner_exec.py` clamps proven by the 3 planner properties (speed cap, alt band, standoff floor, climb rate, yaw rate, finiteness) on the vehicle. `policy-parity.test.ts` and `contract-parity.test.ts` (6 tests) assert the two sides' constants and types agree |

### Live-demo facts quoted on slide 5

Reproduced against `site/site.stub.json` and the baked anomaly
`sat-change-1` (−26.090664, 29.469245, confidence 0.94):

- `scripted-failing-sat-change-1` → **rejected**, failing `anomaly_proximity`
  ("no mission target is within 200 m of the anomaly"), `altitude` ("tool 0
  altitude 15 m is outside [20, 45] m"), `nfz_transit` ("leg to tool 0 is 0 m
  from NFZ \"chimney\"; 25 m required")
- `scripted-sat-change-1` → **pass**, 18/18: `goto_gps` at 45 m,
  `orbit_point` radius 25 m, `rtl`
- Site policy in force: NFZ buffer 25 m, alt band [20, 80] m, clear altitude
  45 m, `standard` profile capped at 4 m/s and 45 m, hard standoff floor 3 m,
  hard speed ceiling 8 m/s, sortie cap 480 s, dispatch minimum SoC 80 %
