# Demo script — 3 minutes, rehearsable

One repeatable sequence: a satellite change is flagged, an unsafe plan is
**refused by name**, a clean plan is approved by a human, the aircraft flies the
inspection, multimodal evidence produces an incident report, the operator
escalates. Closes on measured numbers and the hardware path.

This file is the stage script. It does not restate the safety contract
(`FAILURE_MODES.md`), the build history (`SESSION_AUDIT.md`,
`platform/docs/BUILD_SUMMARY.md`), the design decisions (`ADR-hackathon.md`) or
the operating policy (`CONOPS.md`). Read those separately; cite them on stage,
do not read them aloud.

---

## Pick a track before you rehearse

| | Track A — offline scene (**primary**) | Track B — SITL hardware-in-the-loop |
|---|---|---|
| Data source | `MockDataProvider` (`VITE_EIS_DATA_SOURCE` unset) | `LiveDataProvider` over the control WebSocket to the companion |
| Flight | Kinematic sim in the renderer, `MISSION_TIME_SCALE = 6` | Real ArduCopter SITL, MAVLink GUIDED, real polygon fence upload |
| Anomaly → plan → verdict | **Auto-runs on a timer** at 5.0 / 7.5 / 9.5 / 12.0 / 14.0 s after the window connects (`SCENARIO_DELAYS_MS`) | One `Start scripted inspection` button press; one proposal only |
| Two proposals (rejected, then clean) | **Yes** — this is the refusal beat | No. Only one plan is ever produced |
| Sortie wall-clock | ~20 s end to end | ~3 min of real flight (250 m out at 4 m/s, one 25 m orbit, RTL) |
| Dependencies | Node + the two `node_modules` trees | Above, plus Docker/WSL2 SITL, the companion venv, port 5760/8765/14550 free |
| Known blocker | none | **FM-72 — the live path is always `rejected`.** See contingency C1 |

**Rehearse and present Track A.** It is the only path that delivers the
reject-then-approve beat, it is deterministic, and it needs no simulator. Keep
Track B running on a second screen as the "this is real ArduPilot" cutaway if
the room is technical and the contingency in C1 is understood.

Everything below is written for Track A, with Track B deltas marked **[B]**.

---

## Preflight — T-15 minutes

All paths are relative to the platform root
`C:\Users\User\Documents\eyeinthesky\dnhacks\platform`.

```powershell
# 1. Build the Electron main process. `npm run dev` does NOT do this (FM-132).
cd platform\ground\app\windows
npm run build:electron          # produces dist-electron/main.js

# 2. Refresh the planner the shell loads by require() (FM-83).
cd ..\..\planner
npm test                        # tsc build + typecheck + 148 vitest tests

# 3. Launch. Vite on :5173, Electron attaches.
cd ..\app\windows
npm run dev
```

Confirm on the status bar before you say a word:

- Mode chip reads **`MOCK`** (Track A) — `StatusBar.tsx` renders `MOCK` / `SITL`
  / `HUB` / `LIVE` from `sourceKind` + `sitl`. If it reads anything else you are
  not on the track you rehearsed.
- Mission strip shows **`OFFLINE SIMULATION`**, **`READY`**, and `rgb ok`,
  `thermal ok`, `lidar ok`.
- Nothing is on port 5173 but this Vite (FM-131) and nothing on 5760/8765/14550
  but you (FM-133, FM-137, FM-153).

**[B]** Track B is launched by `scripts/demo.ps1`. **As of this writing that
script is misrooted** — it computes `$repoRoot` as its own parent, which is the
merged repository root, and then looks for `site/`, `companion\.venv\` and
`ground\ui\node_modules` that now live under `platform/`. Verified failures from
the repo root: `Site model not found: ...\dnhacks\site\site.stub.json`, and with
`EIS_SITE_FILE` overridden, `Companion environment missing:
...\dnhacks\companion\.venv\Scripts\python.exe`. Run it from a copy at
`platform\scripts\demo.ps1` (every path it uses resolves there), or do not run
Track B. This is FM-152 / FM-168.

Have open and off-screen: `docs/BOM.md` (hardware slide), the eval table from
`docs/DECK.md`, and this file's appendix.

---

## Stage geometry — what the audience is looking at

The Mission tab of the ground station. It auto-selects on the first anomaly, so
you never have to click into it.

- **Top strip** — offline badge, readiness, battery/SoC, `MUST RTL` clock, the
  three sensor rails, gps/link/planner health, RF state.
- **Centre row** — Mission map (site perimeter, geofence, two NFZs, anomaly,
  route, trail) · Multimodal observation (RGB/Thermal tabs, track boxes) ·
  Satellite change detection (Before/After tabs, Diff toggle, marker).
- **Bottom row** — Mission verifier (proposal chips, tool list, rationale, 18
  check rows, Approve/Deny) · Incident report · Audit log.

---

## The script

Total 3:00. Times are cumulative from the moment the window is on the projector.
The Track A scenario beats arrive **on their own** in the first 14 seconds — your
job in beats 1–3 is to narrate what has already landed, not to wait for it.

| Time | Operator does | On screen | Say |
|---|---|---|---|
| **0:00** | Nothing. Window is already up on the Mission tab. | Mission strip green. Satellite panel shows the **After** tile with the red diff overlay and a `1 CHANGE` badge. Amber marker ring labelled `sat-change-1`. | "This is Komati, a decommissioned Eskom power station. Every few days a Sentinel-2 pass lands on this desk at **10 metres per pixel. At 10 metres per pixel we detect laydown and earthworks — we cannot detect a vehicle. So the satellite flags the change, and the drone identifies the vehicle.** That is the entire product in one sentence." |
| **0:20** | Click **Before**, then **After** on the satellite panel. Leave **Diff** on. | Tiles swap. Overlay stays. Audit log line: `Satellite change detection flagged sat-change-1 (change, conf 94%)`. | "Before, after, and the diff. That overlay is not a screenshot — the change-detection core is running in this browser on those two PNGs, the same `detectAnomalies` the pipeline uses. It georeferences the blob and dispatches it: one anomaly, 94 per cent, on the west service road." |
| **0:35** | Click the **first proposal chip** in the Mission verifier (`scripted-failing-sat-change-1`). | Chip row shows two proposals. Plan tool list and the planner's own rationale text render below it. | "The planner receives the anomaly, the site model and the aircraft's capability envelope. It can only answer in **tool calls** — goto, orbit, hold, return-to-launch. No free text ever reaches the aircraft. Here is its first proposal, and here, in its own words, is why." |
| **0:55** | Point at the verdict badge, then read the three red rows. | Badge: **`REJECTED`** (danger tone). Three rows red with an X: `nfz_transit`, `altitude`, `anomaly_proximity`. Approve button greyed, hint reads `Rejected by verifier`. | "Now the part that matters. Every plan goes through a **deterministic verifier — 18 checks, fixed order, no model in the loop**. This plan is REJECTED on three. `nfz_transit`: the route passes **0 metres** from the chimney no-fly zone; we require 25. `altitude`: **15 metres**, outside the site band of 20 to 45. `anomaly_proximity`: **no target within 200 metres** of the thing we were sent to look at. The verifier will clamp the altitude and route around the NFZ — you can see the proposed edits on those rows — but it will not invent a target near the anomaly, so it refuses outright. The operator physically cannot approve this. The button is disabled." |
| **1:20** | Click the **second proposal chip** (`scripted-sat-change-1`). | Badge flips to **`PASS`**. All 18 rows green with ticks. Tools: `goto -26.09060, 29.46949 @ 45 m`, `orbit -26.09066, 29.46924 r=25 m`, `return to launch`. | "Second proposal. Same anomaly, same site, same verifier — **18 for 18 green**. Fly to the observation ring at 45 metres, orbit at a 25-metre standoff, come home. Note `standoff`: the 3-metre floor is not a preference, it is asserted here on the ground and again on the aircraft." |
| **1:35** | **Press and hold** the primary button for ~1 s. | HoldButton fills, then fires. Toast: `Mission approved`. Blue banner drops in: **PLANNED MISSION EXECUTING · scripted-sat-change-1** with a red **Abort plan** button. | "Approval is a human, holding a button, for nine hundred milliseconds — and it is gated on **live readiness**, not on the plan alone. If the battery had drifted below 80 per cent between proposal and now, this is refused." |
| **1:50** | Nothing. Let it fly. **[B]** Cut to the SITL window. | Aircraft leaves home on the map, trail draws, climbs to 45 m, arrives at the ring, begins orbiting. Audit log: `Waypoint reached (tool 0) — 45 m AGL`, `Orbiting observation point at 25 m radius`. | "**[B]** That is ArduCopter — not an animation. The same MAVLink GUIDED setpoints a real Pixhawk gets, and the site polygon uploaded to the firmware as a fence, so the aircraft is contained by something we do not control. Control source reads `planner`: **exactly one source is ever active**, and Abort is one click — never hold-to-confirm, because stopping must be instant." |
| **2:15** | Nothing. | Observation panel populates: `RGB ok` `THERMAL ok` `LIDAR ok`, scene badge `komati-west-service-road`, an amber box labelled **`vehicle 92%`**, `1 track(s)`. Toggle RGB/Thermal if there is time. | "On the ring it takes the observation pass. RGB, thermal, LiDAR — **one vehicle, 92 per cent, fused across modalities**. That is the identification the satellite could not make. If a rail had failed, this panel would say *evidence withheld* rather than show you a stale frame." |
| **2:30** | Nothing — the report writes itself ~3 s later. | Incident report panel fills. Badge **`ESCALATE`**. Critical toast `Incident report: escalate`. Markdown lists modalities used, RGB/thermal frame references, geometry citations. | "The report cites what it actually had: which modalities, which frames, which geometry claims. Confirmed activity at the flagged location, so the verdict is **escalate**." |
| **2:40** | Click **Escalate**. | Buttons collapse to a red badge **`ESCALATED TO SECURITY`**. Critical toast `Escalated to on-site security`. Audit log records it. | "And escalation is still a person clicking a button. The system never dispatches a response team, never confronts anyone, never leaves the perimeter." |
| **2:50** | Stop clicking. Look up. | Aircraft is on the RTL leg. Trail closes back to home. | "**411 automated tests**, all green. **49,240 randomised states** through the safety properties — zero invariant violations. **25 verifier fixtures: 13 rejected, 10 auto-corrected, 2 clean** — it is not a rubber stamp. And the hardware path starts at about **150 dollars** for a physical Pixhawk on the bench, speaking the same MAVLink you just watched fly." |

### Spoken-line cheat sheet

If you lose the table, these are the only sentences that must be said:

1. 10 m/pixel — we detect laydown and earthworks, the drone identifies the vehicle.
2. The planner emits tool calls only. No free text reaches the aircraft.
3. Eighteen deterministic checks. This plan is REJECTED on nfz_transit, altitude and anomaly_proximity.
4. Eighteen for eighteen. A human holds the button. Readiness is re-checked at approve time.
5. Exactly one control source. Abort is never hold-to-confirm.
6. One vehicle, 92 per cent, fused. That is what the satellite could not see.
7. Escalation is a person clicking a button.
8. 411 tests, 49,240 randomised states, 13 of 25 fixtures rejected, $150 to first hardware.

---

## Contingency appendix

Sourced from the demo risk register. Each item: what you will see, what is
actually happening, what to say, what to do. Rehearse **A1–A4 and C1** — those
are the ones that end the demo.

### A. It will not start

| # | Symptom on stage | Cause | Say | Do |
|---|---|---|---|---|
| **A1** | `Cannot find module '...dist-electron/main.js'`; Electron exits instantly; `demo.ps1` aborts with *Ground station exited unexpectedly*. | FM-132 — neither the setup scripts nor `npm run dev` compile the Electron main process; `package.json` `main` points at an artifact only `build:electron` produces. | Nothing. Do not narrate a build. | `npm run build:electron` in `ground/app/windows`, relaunch. This is why it is in preflight. |
| **A2** | `planner:propose` throws *Cannot find module*, toast reads **Planning failed**, and the plan beat dead-ends. Or worse: everything works but you are running last night's verifier. | FM-83 — the shell `require()`s `ground/planner/dist`, which no setup or shell build script produces or refreshes. | "One second." | `cd ground/planner; npm test` (it builds), relaunch. Never demo without having rebuilt `dist` in the same session. |
| **A3** | Launcher aborts at preflight: *Site model not found* or *Companion environment missing*, naming paths under the repo root instead of `platform/`. | FM-152 / FM-168 — the platform relocation to `platform/` landed, but `scripts/demo.ps1` still resolves `$repoRoot` to the merged root. Reproduced above. | Nothing — this happens before the audience sees anything. | Run the copy at `platform/scripts/demo.ps1`, or fall back to Track A, which does not use the launcher at all. |
| **A4** | Electron renders someone else's page, or the 3D console 404s every Hub call. | FM-131 — Vite's port 5173 is not `strictPort`; it silently takes 5174 and `wait-on` succeeds against whatever already answers on 5173. | "Wrong window, one moment." | Kill every stray dev server before launch. Confirm the Vite banner says 5173 and the ground station shows the Mission tab, not a foreign page. |
| A5 | Two to two and a half minutes of silence, then *companion did not become ready*. | FM-143 — `wait-ready` burns ~150 s before giving up; FM-145 — the companion continues in "degraded mode" with no flight controller instead of failing fast, so the real cause (UDP 14550 taken by another GCS, FM-133; port 8765 held by an aborted run, FM-137; SITL TCP 5760 claimed by the teammates' stack, FM-153) surfaces late and unnamed. | Do not wait on stage. | Abandon Track B, present Track A. Post-mortem the port later. |
| A6 | Preflight stalls, then SITL behaves unlike rehearsal. | FM-144 — an unresponsive Docker probe silently reroutes to the WSL backend, which skips the 30-parameter bootstrap entirely (FM-135) and can pick the wrong transport (FM-134: `sim_vehicle.py --no-mavproxy` never serves the `--out=udp:14550` endpoint the companion is waiting on). | — | Start Docker Desktop *before* the launcher, or accept Track A. |
| A7 | ArduPilot refuses to arm, or breaches immediately after takeoff, for no reason you changed. | FM-136 — the persisted SITL EEPROM carries yesterday's polygon fence and params into today's run. FM-155 — the native fallback fences the aircraft into a 60 m circle at a 30 m ceiling on an ~800 m site, so the first outbound leg breaches with firmware authority and looks exactly like a real safety event. | If it happens live: "That is the firmware fence doing its job — and it is configured for a different footprint than this site, which is a bug on our side, not a safety failure." | Remove the state volume before the run. Do not try to talk your way past it. |

### B. It started, but the screen is lying

| # | Symptom | Cause | Say / Do |
|---|---|---|---|
| **B1** | Everything looks perfect; SITL, companion and socket are all running — but the flight is entirely synthetic. | FM-130 — a *packaged/built* UI is mock-only, because `VITE_EIS_DATA_SOURCE` is never set at build time; the current `dist` bundle contains zero `ws://` strings. | Check the **mode chip** in the status bar before speaking. It is there for exactly this. Never claim SITL while the chip says `MOCK`. |
| B2 | Map basemap is blank or hangs; on venue wifi, requests redirect. | FM-140 — the default basemap is a remote ArcGIS tile server, contradicting the offline claim. | A first-tile-error watcher falls back to an offline view keeping markers, trail, geofence and the lat/lon readout with an `OFFLINE` badge. Say: "Offline mode — the geometry is local; only the pretty basemap was remote, and it is going away." |
| B3 | The anomaly marker is off the satellite tile. | FM-109 — `latLonToPixel` extrapolates with no clamp; the panel converts straight to percentages. | Do not point at the marker. Point at the diff overlay, which is computed from the pixels. |
| B4 | The whole ground-control window disappears mid-demo. | FM-149 — the SDR sidecar spawn has no `error` listener, so a failed spawn throws in the Electron main process instead of degrading to "SDR unavailable". | Nothing to say. Relaunch; the scenario state does not survive, so restart the beat from 0:00. Consider running with the sidecar's Python present and verified in preflight. |
| B5 | A browser window pops over the full-screen ground station. | FM-151 — `will-navigate` prevents default and then calls `shell.openExternal`. | Do not click links inside the app. Alt-tab back and continue. |

### C. The planner / verifier beat fails

| # | Symptom | Cause | Say | Do |
|---|---|---|---|---|
| **C1** | **Track B only.** The single live proposal comes back **`rejected`**, the only red row is `wind`, and Approve is permanently disabled. | FM-72 — `App.tsx` builds the `VerificationContext` without `windMps`; `checkWind` fails on non-finite wind and wind has no correction rule, so *every* live plan is rejected. Reproduced: verdict `rejected`, `wind: wind speed must be a finite non-negative number`. | If you are caught: "That is the verifier refusing to fly without a wind reading — fail-closed. We have no wind source wired on the live path yet, so it refuses every mission. That is the correct direction of failure and the wrong ergonomics." | Do not try to approve. Switch to Track A. This is the single strongest reason Track A is primary. |
| C2 | 20 to 40 seconds of a frozen ground station with no progress bar and no cancel, then a plan appears. | FM-80 — up to ~40 s of blocking LLM latency with no aggregate deadline; FM-79 — a ~2.9k-token base64 thumbnail is on the prompt's critical path. | — | Never run `--live-llm` on stage. Scripted is the default and `demo.ps1` refuses `--live-llm` without a key. |
| C3 | A live demo runs entirely scripted while you present it as LLM-driven — or the reverse. | FM-85 — the fallback is invisible at plan time; FM-92 — the default model id may 404 into a silent fallback on every call; FM-89 — a stray `.env` can flip the mode without anyone choosing it. | Say what is true: "the planner is running in scripted mode." | Present the *shape* of the planner (tool-calls-only, verifier-gated) as the claim. The claim does not depend on which planner ran. `source`, `attempts` and `fallbackReason` are written to the audit line — show that line if challenged. |
| C4 | The inspection button is permanently disabled reading **Inspection planned** and nothing can be re-requested. | FM-81 — no retry after a failed or rejected proposal; the latch is only cleared by restarting Electron. | — | Restart the shell. Budget 30 s. |
| C5 | You re-plan the same anomaly, the toast announces a fresh result, but approving sends the old plan. | FM-43 — `ingestPlan` drops the new plan and `ingestVerification` ignores the new verdict for a repeated anomaly. | — | Do not re-plan on stage. One pass only. |
| C6 | Every mission is rejected with *RF events and SDR health state are required*. | FM-49 — `checkRfEnvironment` hard-fails when `sdrState` is absent, which is what one sidecar spawn failure produces; the message names the SDR, not the missing sidecar. Related: FM-51, a single 20-minute-old hostile-drone event blocks every mission forever because RF events never expire. | "The RF gate is fail-closed and it is currently too strict." | Track A supplies `sdrState: 'nominal'` from the mock; this is a Track B risk. |
| C7 | The verdict is `corrected` and approvable, but the check rows on screen are the **original failing** ones. | FM-74 — `checksWithEdits` is returned on the rejected branch too (FM-60), so an operator can read applied repairs beside a failed check. | If a judge spots it: "The correction is disclosed — the corrected plan is re-walked and re-checked before release, and the panel renders an original-to-corrected per-tool diff. The row rendering is a real presentation bug." | The scripted demo path produces `rejected` then `pass`, never `corrected`, so this does not fire in Track A. |
| C8 | A plan with a plausible but hallucinated coordinate passes every check. | FM-73 — anything within 200 m of the anomaly satisfies `anomaly_proximity`; FM-64 — `checkStandoff` covers only explicit orbit radii, so a `goto` to within 1 m passes while the panel shows standoff green. | Concede it: "Proximity is a 200-metre gate, not a proof of correctness, and goto targets are not standoff-checked on the ground. `planner_exec` floors the flown radius on the aircraft; the ground gap is real." | — |
| C9 | The operator approves and the toast says success, but nothing flies. | FM-42 — `executePlan` acks are discarded and the UI reports success unconditionally; `approvedAt` then permanently disables the button. FM-86 — a 61-tool plan verifies `pass`, the operator approves, and the companion rejects it at load. | "Approve is currently optimistic. That is on the fix list." | Watch the banner, not the toast. If `PLANNED MISSION EXECUTING` does not appear, the plan did not launch. |

### D. In flight

| # | Symptom | Cause | Say |
|---|---|---|---|
| **D1** | Telemetry reports `failsafeState = rtl` but the aircraft just hovers in GUIDED. | FM-01 — the RTL latch is stamped *before* `set_mode`, so a failed RTL never retries; FM-02 — `set_mode` is fire-and-forget and returns `True` unconditionally, so every rung of the failsafe ladder believes it succeeded. | Do not claim RTL happened. "The state machine decided RTL; the mode change was not verified. Firmware `FS_GCS_ENABLE` is the documented backstop." |
| D2 | A failsafe fires and now **Abort plan** does nothing. | FM-18 — any latched failsafe state, including a notification-only `escalate`, locks out `abortPlan`, `disengageTracking` and `setMode`; only RTL / LAND / disarm / manual are accepted. | "Emergency stop and RTL are still live — those dispatch before the gate." Use RTL. |
| D3 | Nothing happens during the takeoff climb no matter what you inject. | FM-04 — the takeoff early-return precedes the failsafe block, suspending the entire ladder for up to 60 s. | Deliberate, so the idle zero-velocity frame cannot overwrite the `NAV_TAKEOFF` target. Say so if asked; do not inject faults during climb. |
| D4 | The vehicle sits at a waypoint forever, everything nominal. | FM-105 — the goto leg has a 2 m arrival gate with no timeout, attempt counter or loosening; FM-106 — arrival gating consumes raw unfiltered lat/lon. | Only the coarse sortie and battery backstops eventually RTL. Abort and move on. |
| D5 | The wind failsafe never fires when you inject wind. | FM-20 — `wind_mps` degrades to `0.0` with no WIND message, indistinguishable from calm. | Do not script a wind beat. |
| D6 | GPS-loss beat: the aircraft holds and never recovers, and Abort is locked out. | FM-21 — `app.py` feeds the *raw* `gps_healthy` flag into `FailsafeSignals`, so `decide()` holds indefinitely on a healthy fallback. | This matches the specification (`FAILURE_MODES.md`): hold is the intended response. Say that, then RTL. |
| D7 | With avoidance enabled the aircraft refuses to move at all. | FM-118 — `min(lidar_ranges_m)` is published as a 72-bin `OBSTACLE_DISTANCE` fan with the same value in every sector, computed in the staging frame, not the vehicle frame — ArduPilot sees a wall in all directions. | Do not enable avoidance. |
| D8 | A judge asks whether limits reach the firmware. | FM-16 — `failsafe_param_map` is defined and exported but never called; FM-154 — the Docker demo path loads no `FENCE_*` params, so the only FC-side fence is the runtime upload, and `upload_geofence` returns `False` on NACK without raising (FM-15). | Answer honestly: "The envelope is enforced twice in software, ground and vehicle. The firmware half of that claim is the runtime fence upload only, and a failed upload is a warning, not a refusal. That is a known gap." |

### E. Evidence and report

| # | Symptom | Cause | Say / Do |
|---|---|---|---|
| E1 | A rail is red before flight and the mission is refused for points whose own assets are fine. | FM-25 — a single missing or non-PNG staging fixture marks the whole thermal/LiDAR/RGB rail unhealthy globally: permanent `escalate` (thermal, which then locks out `abortPlan`) or permanent hold-and-climb (LiDAR). | Fail-closed and correct in direction. Verify the four staging PNGs exist in preflight. |
| E2 | Sensor health flaps between failed and ok at 10 Hz after leaving a staging point. | FM-26 — `_camera_observation_valid` flaps between the staged verdict and an unconditional `True` from `source.observe()`. | Do not linger after the observation. Let RTL run. |
| E3 | The observation log spams duplicate evidence every lap. | FM-103 / FM-104 — the arrival gate chatters at the orbit radius and the observer burst restarts on every re-entry. | The UI de-dupes the incident-report call per `requestId`, so the report itself is written once. Ignore the log noise. |
| E4 | Installing the "real" YOLO extra makes the system detect **less**. | FM-98 — the live detector filters to COCO class 0 (person only), so vehicle and structure truths return `[]`, and staging treats an empty real result as a real result. FM-129 — the detector defaults to `cuda:0` with no CPU fallback and degrades to `[]` silently. | Never install the `detect` extra for this demo. The scripted staging path is the demo path. |
| E5 | A judge challenges the report's narrative. | FM-75 — LLM report markdown is passed through verbatim; sensor claims, modality lists and frame citations are not validated against the `ObservationSummary`. | "There is a verdict-only guard: on disagreement the whole LLM report is replaced by the deterministic writer, and any throw falls back the same way. The narrative prose is not independently validated — the verdict is." Track A uses the deterministic writer, so the report you show is a pure function of its inputs. |
| E6 | The satellite anomaly no longer matches the site. | FM-107 — baked tiles, PNGs and `anomalies.json` are pinned to the stub geometry and go stale on a Komati cutover; FM-108 — the mock and live paths use *different* staleness heuristics, so they can disagree about where the anomaly is. | Both paths re-anchor to `staging[0]` when their predicate fails, so the coordinate stays inside the site. Do not swap the site file on demo day. |

### F. If a judge asks — one-line honest answers

| Challenge | FM | Answer |
|---|---|---|
| "Is the standoff floor really enforced?" | FM-39 | On the aircraft, yes — `planner_exec` floors the flown radius at `limits.min_standoff`. On the ground there is a hole: an unvalidated `capabilities.profiles` entry makes `Math.max(base, NaN) = NaN`, and `radius < NaN` is false, so a 0.5 m orbit would return a green PASS. Real companion capabilities are sane; the validation is missing. |
| "Can a mission loiter forever?" | FM-44 | An indefinite `hold` passes the loiter bound with a false reason, is budgeted at 30 s, and `planner_exec` holds forever. The companion's sortie and battery-reserve watchdogs RTL independently, which is what actually ends it. |
| "Does the sortie budget know how long you have already flown?" | FM-45 | The ground check does not — it compares only the new plan against a static 480 s cap. `battery_health` on the aircraft computes elapsed against `must_rtl_by` and forces RTL. |
| "Is the range model conservative?" | FM-46 | Over-conservative, and wrongly so: the reserve is subtracted twice (~28 per cent over-conservative at 90 per cent SoC), while the reason string still claims "with 25% reserve". |
| "Is the verification current at approve time?" | FM-57 | No. It is a propose-time snapshot — wind, nav source, new RF events and SoC drain are invisible behind a green PASS that can be minutes old. Only readiness is re-checked at approve, plus site validity, manual engagement and latched failsafe on the companion. |
| "What happens if the operator denies?" | FM-59 | Local state only — no `abortPlan`, no companion notification, no planner feedback, and it cannot be undone. A separate Abort control exists on the planner banner while `controlSource` is `planner`. |
| "An empty NFZ list would pass, wouldn't it?" | FM-66 | The verifier would report "all legs clear buffered NFZs by 25 m". A *missing* `nfz` key throws; an empty array does not. The shipped stub has two NFZs. |
| "Do the ground and vehicle agree on what a valid site is?" | FM-67 / FM-68 / FM-69 | Not exactly: the companion defaults missing fields and arms, while the ground planner throws and refuses; four consumers resolve the site path against three different anchors; and the planner's site model is memoised for the app lifetime while the map re-reads. `SITE_CONTRACT.md` declares all nine fields required, and the demo scripts export one absolute `EIS_SITE_FILE` to collapse the resolvers. |
| "Is the WebSocket authenticated?" | FM-40 | No. It binds `0.0.0.0`, has no auth, and with test hooks armed any peer can send `executePlan`, `arm`, `emergencyStop` or `testFault` with no planner, verifier, approval or audit — and can also satisfy the ground-link deadman (FM-141), masking a real operator link loss. That is the top security item. |
| "Is the Python contract mirror checked?" | FM-159 | `shared/shared.py` has no parity guard; only `PROFILE_SPEED_MPS` is pinned by a test. The TS side has `contract-parity` and `policy-parity` tests. |
| "Do the night and clutter gates work?" | FM-55 | The ground verifier enforces both. The companion's own refusals are dead code — `_execute_plan` reads `params['night']` and `params['routeThroughClutter']`, which the contract and UI never send. |
| "Does the acceptance gate prove the demo works?" | FM-157 | No. `e2e` exercises a different SITL transport and parameter set than the demo path. A green gate is not evidence for the demo, and vice versa. |
| "How does this join the teammates' stack?" | FM-160 / FM-161 / FM-162 / FM-165 | Detection and Anomaly are structurally incompatible with no adapter on our side; there are two rival Detection schemas inside their own tree; three Python roots collide on package names; and three site models with three geographic anchors. `scripts/argus_detect.py` is a correct one-way adapter. The rule for the demo is `BASIC_DEMO_PENDING.md`: run one named Komati scenario, do not combine sites. |
| "Is any of it fully offline?" | FM-170 / FM-171 | Ours is, in Track A. `argus-core`'s vision seam requires a live hosted-model call, and the Three.js console fetches gitignored 3D assets at runtime. Both are disclosed. |
