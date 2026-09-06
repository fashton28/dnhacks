# SUBMISSION — ready-to-paste text

Paste-ready copy for the submission page. Each `##` heading maps to a standard
submission field. Numbers in the evidence table were measured on this tree; the
reproduction command sits next to each one. Runtime paths are relative to
[`platform/`](../platform/) unless stated otherwise.

---

## Project name

**ARGUS** — Layered Autonomous Site Monitoring for Critical Infrastructure

## Tagline / one-liner

An LLM can propose a drone mission over critical infrastructure, but it can never
fly one: every plan passes a deterministic verifier on the ground, gets re-clamped
independently on the aircraft, and lands inside ArduPilot's own geofence.

## Repository

https://github.com/fashton28/dnhacks

## Elevator pitch (3 sentences)

ARGUS watches a power station from two layers: a wide-area imagery pass that flags
change, and a close-up drone inspection that goes and looks. An LLM decides *what
is worth investigating* and emits nothing but schema-bound tool calls — it never
computes a waypoint, never touches an actuator, and never chooses a failure
response. Between the model and the motors sit three independent authorities: a
deterministic 18-check mission verifier on the ground, a re-clamping executor on
the aircraft, and ArduPilot's native fence and failsafes, which no software above
them can reach.

---

## Inspiration

Critical-infrastructure sites are large, mostly empty, and monitored by cameras
that nobody watches. A perimeter breach at a substation or a coal-fired plant is
detected hours later, from a recording. The obvious fix — put a drone on it — runs
straight into the reason it does not already exist: nobody will let a language
model dispatch an aircraft over a live plant, and they are right not to.

So we stopped asking whether the model could plan a good mission and started asking
a different question: **what would have to be true for the model's judgment to be
safe to act on?** The answer is that the model's output has to be the *least*
trusted thing in the system — a proposal, in a narrow typed vocabulary, that a
deterministic layer is free to reject with the rule named. Everything we built
follows from putting the model in that position and then proving, mechanically,
that it stays there.

That framing is also what makes the demo interesting to watch. The best moment in
our run is not the drone flying. It is the autonomy stack **refusing to fly**, and
naming the rule.

## What it does

Five steps, cue to evidence:

**1. Detect.** A wide-area layer compares a before/after overhead image pair of the
site and emits a georeferenced anomaly: a polygon, a change type, and a confidence.
Passive RF and SDR rails feed the same anomaly envelope. Every cue carries its
source, timestamp, and TTL.

**2. Plan.** An LLM triage agent reads the anomaly plus the site's static context
(zones, what is normally present, maintenance schedule) and emits **tool calls
only** — a schema-bound task naming an existing anomaly, an observation question,
urgency, and rationale. It states intent; it does not compute geometry. A
deterministic generator expands that task into a route: profile, altitude at the
midpoint of the site/profile/capability intersection, one orbit lap at a preferred
radius, an optional hold, and a terminal RTL.

**3. Verify.** The `MissionVerifier` runs **18 deterministic checks in a fixed
order** across the complete route — schema, site validity, nav source, readiness,
wind, RF environment, airspace, anomaly proximity, altitude, speed, standoff,
geofence, NFZ transit, NFZ orbit, terminal, loiter, range, sortie. The verdict is
`pass`, `corrected`, or `rejected`. A correction shows every change it made and is
then **re-verified as a whole path** — a fix is not allowed to smuggle a breach in
somewhere else. A rejection names the rule.

**4. Approve.** The operator sees the proposed route, the ordered check list, and
any correction in an Electron ground station, and approves the exact verified
record. There is no path from the model to dispatch that skips this.

**5. Fly and report.** The companion process on the aircraft **re-validates and
re-clamps the approved plan against its own limits** before issuing a single
GUIDED command to ArduCopter. RGB, thermal, and LiDAR observations fuse into an
incident report that cites the modalities it actually had; a missing or stale
sensor frame is reported as *no observation*, never as an empty scene. The
aircraft returns and lands. Underneath all of it, ArduPilot's native geofence and
failsafes run in firmware.

Failure is a first-class output. Every detected failure resolves to exactly one of
four states — `hold`, `rtl`, `escalate`, `refuse` — with exactly one named
authority. GPS loss, hostile drone, link loss, camera failure, battery fault,
night thermal failure, LiDAR failure, and a tightened sortie cap are all
injectable from the demo launcher as flags, so the safety behaviour can be
demonstrated on command rather than hoped for.

## How we built it

**Ground station.** React + TypeScript + Vite + Tailwind + Zustand, hosted in
matching Electron shells for Windows and Linux. The renderer has zero Node access;
every OS capability crosses a preload bridge. The mission planner, the verifier,
the change-detection layer, and the receive-only SDR sidecar are separate
TypeScript/Python packages so an optional radio driver can never block the UI.

**Companion.** Python on the vehicle side. A pure-logic control core (numpy +
stdlib only — PID, tracker, guidance, envelope, planner executor, battery health,
nav health, failsafe) that unit-tests with no hardware, wrapped by MAVLink,
vision, WebSocket API, and streaming I/O. An asyncio orchestrator composes them at
20 Hz and owns no control math of its own.

**Flight stack.** Real ArduCopter, unmodified, via SITL. The companion speaks
MAVLink GUIDED and uploads the site perimeter as a native polygon inclusion fence,
so the firmware enforces a boundary the rest of the stack cannot argue with.

**Contract.** One wire contract with a single authoritative copy
(`ground/ui/src/contract/index.ts`) and two mirrors (`shared/shared.ts`,
`shared/shared.py`). Parity tests assert the ground and vehicle sides agree on
constants and types.

### What is synthetic and what is real — stated plainly

We would rather say this ourselves than have a judge find it.

| Layer | Status |
|---|---|
| Overhead imagery | **Synthetic.** Generated tiles and a clearly labelled synthetic SAR fallback. No real Sentinel-2 pair is used. |
| Site model | **Deterministic stub.** Meridian Station geometry, generated from the ARGUS site sources — site-footprint perimeter, inset geofence, NFZ buffer, clutter, staging points. An integration stub, not a survey. The real model drops in through one env var (`EIS_SITE_FILE`). |
| Staged RGB / thermal frames | **Generated placeholder PNGs**, declared as `image_kind=scripted_placeholder`. Never described in code, docs, or UI as real captures. |
| SDR / RF feed | **Receive-only by construction** — no transmit API exists anywhere in the path. Default source is scripted; live mode needs real hardware. |
| LLM planning | **Scripted by default.** The default demo path makes no network request. Live LLM is an explicit opt-in flag. |
| Change detection, verifier, clamps, failsafes, sensor fusion | **Real code, really executed, really tested.** These are the parts the evidence below measures. |
| Flight controller | **Real ArduCopter firmware** in SITL. Physics is ArduPilot's own model. |
| Flight results | **Not claimed.** Every number in this submission is unit, property, or fixture level. Nothing here was flown on hardware or hardware-in-the-loop. |

The honest version of the claim: the flight code and the trust layer are real; the
world and the sensors are simulated. Both halves of that sentence matter.

## The trust layer — why this is different

Most autonomy demos put a model in the loop and hope. We treated the safety
argument as the deliverable, and we can show our work.

**Safety is enforced twice, on independent sides of the wire.** The ground verifier
(TypeScript) and the vehicle-side executor (Python) are two separate
implementations of the same envelope. The vehicle does not trust an approved plan;
it re-derives the limits and clamps every setpoint again. Beneath both, ArduPilot's
firmware fence is a third authority that neither the model nor the ground station
can reach. A bug in one layer does not become a breach.

**The model is architecturally incapable of choosing a failure response.** Hold,
RTL, escalate, and refuse each belong to exactly one named authority — a companion
watchdog, a ground check, or the firmware — and the failure catalogue asserts both
the state *and* the authority, so a ground-side event can never masquerade as a
firmware action.

**We test the envelope, not just the happy path.** Property-based tests generate
mission plans with deliberately out-of-range latitude, longitude, altitude, radius,
and profile values and step them through the executor, asserting on every single
emitted setpoint that speed is capped, altitude is inside the intersected band,
orbit radius never closes inside the standoff floor, climb and yaw rates are
bounded, and every value is finite.

### Evidence

| Claim | Measured | How to reproduce |
|---|---|---|
| Companion (Python) unit suite | **270 / 270 passing**, 16 test files, 5.28 s | `cd platform/companion; .venv\Scripts\python.exe -m pytest -o addopts="" -q` |
| Ground planner (verifier + planner) suite | **182 / 182 passing**, 13 files, 4.33 s | `cd platform/ground/planner; npm test` |
| Ground satellite (change detection) suite | **24 / 24 passing**, 5 files | `cd platform/ground/satellite; npm test` |
| SDR sidecar suite | **7 / 7 passing** | `cd platform; companion\.venv\Scripts\python.exe -m pytest ground\sdr\tests` |
| Ground UI gates | typecheck **clean (0 errors)**, lint **clean (0 errors, 0 warnings)** | `cd platform/ground/ui; npm run typecheck; npm run lint` |
| **Total automated tests passing** | **483** (270 + 182 + 24 + 7) | sum of the four suites above |
| Deterministic checks per plan, fixed order | **18** | `CHECK_ORDER` in `ground/planner/src/verifier.ts` |
| Verifier fixture corpus | **25 / 25 fixtures match the verifier** | `cd platform/verifier_fixtures; node run_fixtures.mjs` |
| Fixture verdict spread (proves it is not trivially permissive) | **13 rejected, 10 auto-corrected, 2 pass** | same run |
| Corrections cannot smuggle a breach through | **10 / 10 corrected plans re-verify to `pass` with 0 failing checks** | third assertion in `verifier-fixtures.test.ts` |
| Property tests as committed | **6 properties, 670 randomized examples per `pytest` run** | `@settings(max_examples=…)` in `test_planner_exec.py`, `test_failsafe.py`, `test_battery_health.py` |
| Property tests at a raised example count | **12,000 examples (6 × 2,000), 0 failures** | driver re-runs each property's unmodified body with the same strategies at `max_examples=2000` |
| Mission-envelope stress (raised run) | **6,000 random plans → 15,097 emitted setpoints, 0 envelope breaches** | the three planner properties at 2,000 examples each |
| Failsafe state machine (raised run) | **17,901 transitions, every output a defined safe state** | 2,000 random signal sets + 2,000 random sequences |
| Battery SoC monotonicity (raised run) | **16,242 samples, SoC never rose in flight** | 2,000 randomized flight profiles |
| Trust layer size | **6,067 lines across 45 files** | verifier/validation TS + companion clamp/failsafe Python + their tests + fixture corpus |
| Enforcement vs. evidence | **2,887 lines of verifier/clamp code, 3,180 lines of test + fixture code — 1.10 lines of evidence per line of enforcement** | same scope |

Reading notes, so the numbers are not overread: the 12,000-example figures come
from a **raised-example run** — the committed suite runs 670; the raised run
re-executes each property's untouched body with the same strategies at a higher
example count. Setpoint/transition/sample counts are individual calls inside
randomized runs, not independent draws. "Zero breaches" means zero failures on the
invariants the tests assert, not a proof of the full envelope. The 25 fixture
expectations are authored in this project, so 25/25 means **spec-conformant**, not
externally certified. `ground/ui` has no unit suite — typecheck and lint are its
only automated gates, and both are clean.

## Challenges we ran into

**Geofence upload against real firmware.** Uploading the site perimeter as an
ArduPilot polygon inclusion fence is a MAVLink mission-protocol transfer, and the
firmware's behaviour is genuinely awkward: it answers with either
`MISSION_REQUEST` or `MISSION_REQUEST_INT` depending on version, requests items out
of order, sometimes NACKs early mid-transfer, and sometimes accepts the fence while
staying silent on the parameter echo. Older firmware prefers `REQUEST_DATA_STREAM`
where newer builds want `SET_MESSAGE_INTERVAL`. Getting this right meant handling
every one of those branches explicitly rather than assuming a clean transfer — and
then pinning the behaviour with tests for out-of-order requests, early NACK, request
timeout, parameter silence, degenerate perimeters, and out-of-range vertices, so a
firmware quirk can never silently mean "no fence".

**Keeping one contract true in three places.** The wire contract has an
authoritative TypeScript copy and two mirrors — one TS, one Python — and the
Python mirror is what the companion's WebSocket server actually implements. Any
drift between them is a bug that only shows up over the wire, at runtime, in
flight. There is also a live naming alias (`engageManual` / `disengageManual`
aliasing the original brief's `takeManualControl` / `releaseManualControl`), and a
high-rate `manualInput` message that is deliberately *never* acked per frame,
because per-frame acks build backpressure on exactly the path that must not lag.
We handled this with parity tests that fail the build when the sides disagree on
constants or types, rather than with discipline.

**Merging two independently built stacks.** Two runtimes arrived at the same demo
from different directions — a Three.js console with a Hub and its own SITL bridge,
and this platform retrofit with an Electron ground station and its own site model.
They did not share contracts, site models, or simulators, and there was no adapter
between them. The temptation was to hand-merge them into one blurry thing. We
instead kept both roots independent and explicit, documented the exact
discrepancies (different schema vocabularies, different named sites, a stale
"PX4-flown" line in the glossary against an ArduPilot decision recorded in an ADR),
and required conversion at an explicit boundary with **re-verification against the
current site and live readiness** — because a plan validated under one site model
is not a plan validated under another.

**Deciding what we were allowed to claim.** A surprising amount of the work was
resisting convenient language: a collected test count is not a passed test count, a
staged PNG is not a thermal capture, an empty valid sensor frame is not a sensor
failure, and a scripted delivery receipt is not a human acknowledgement. Those
distinctions are written into the code and the fixtures, not just the docs.

## Accomplishments we're proud of

- **483 automated tests passing** across four suites, with clean typecheck and lint
  on the ground UI.
- **A verifier that says no.** 13 of 25 fixture cases are rejections and 10 are
  corrections — the trust layer is demonstrably not a rubber stamp, and every
  correction is re-verified as a complete path.
- **More evidence than enforcement.** 3,180 lines of tests and fixtures guarding
  2,887 lines of verifier and clamp code.
- **Property-based proof of the flight envelope**, not spot checks: thousands of
  randomized mission plans stepped through the real executor with every emitted
  setpoint asserted against speed, altitude, standoff, climb-rate, yaw-rate, and
  finiteness bounds.
- **A failure catalogue that assigns authority.** Every failure maps to one of
  four states and exactly one owner, and the tests assert the owner too — so a
  ground-side event cannot be mistaken for a firmware action.
- **Safety limits that configuration cannot relax.** The config layer re-asserts a
  hard envelope *after* loading YAML and env, so no operator setting and no site
  file can lower the standoff floor or raise the speed cap.
- **A demo you can break on purpose.** Eight failure injections are launcher flags,
  so the safety behaviour is a live demonstration rather than a claim.

## What's next

- **Real imagery.** Swap the synthetic tiles for a genuine Sentinel-2 before/after
  pair over a real site and re-tune the change-detection thresholds against actual
  atmospheric and seasonal variation — the interface is already the one the baked
  loader implements, so this is a data change, not an architecture change.
- **Hardware-in-the-loop.** Move from SITL to a bench with a physical flight
  controller and a real companion computer, so the MAVLink timing, the fence
  upload, and the watchdogs are exercised against real firmware on real silicon
  rather than a simulated link.
- **Field flight under Part 107.** A licensed remote pilot, a permitted site, a
  visual observer, and the same trust layer running unchanged — with the verifier's
  rejections and the firmware fence as the outer guarantees they were designed to
  be.
- **Close the end-to-end gate.** Run the full sortie — approve, arm, take off,
  transit, orbit, observe, report, RTL, land, disarm — through the public WebSocket
  contract against ArduCopter SITL, with telemetry retained and geofence/standoff
  assertions recorded, so the flight numbers can join the table above instead of
  being absent from it.
- **Two vehicles.** Per-vehicle identity and the fleet wire already exist;
  allocation, explicit handoff, and corridor deconfliction are the next slice.

## Try it

Everything below runs offline. The launchers inspect local caches only — they never
download during a demonstration.

**The platform demo** (Electron ground station + companion + ArduCopter SITL):

```powershell
# Windows, with Docker Desktop running
cd platform
.\scripts\demo.ps1
```

```bash
# Linux or a prepared WSL2 distribution
cd platform
bash scripts/demo.sh
```

Wait for **READY**, choose **Start live inspection**, review the proposed route and
the verifier's ordered checks, approve the effective plan, then watch the
observation, the incident decision, and the return.

Check the offline install without starting anything:

```powershell
.\scripts\demo.ps1 --preflight
```

Break it on purpose — flags schedule a guarded fault after launch, and combine:

```powershell
.\scripts\demo.ps1 --gps-loss
.\scripts\demo.ps1 --hostile-drone
.\scripts\demo.ps1 --link-loss
.\scripts\demo.ps1 --camera-fail
.\scripts\demo.ps1 --battery-fault
.\scripts\demo.ps1 --night --thermal-fail
.\scripts\demo.ps1 --lidar-fail
.\scripts\demo.ps1 --sortie-cap 45
```

**The simulation and operator stack** (Three.js console, Hub, SITL):

```bash
uv sync
# build ArduPilot per docs/sim-setup.md, then:
make hub
make sim FLEET=3
# open http://localhost:8000/console/
```

**Run the test suites** from the `platform/` root:

```powershell
cd platform
companion\.venv\Scripts\python.exe -m pytest companion\tests
Push-Location ground\planner; npm test; Pop-Location
Push-Location ground\satellite; npm test; Pop-Location
companion\.venv\Scripts\python.exe -m pytest ground\sdr\tests
Push-Location ground\ui; npm run lint; npm run typecheck; npm run build; Pop-Location
```

Use the matching shell syntax on Linux.

## Built with

`typescript` · `react` · `vite` · `tailwind` · `zustand` · `electron` · `python` ·
`asyncio` · `numpy` · `pytest` · `hypothesis` · `vitest` · `mavlink` · `pymavlink` ·
`ardupilot` · `ardupilot-sitl` · `three.js` · `maplibre` · `fastapi` · `yolo` ·
`opencv` · `websockets` · `soapysdr` · `docker` · `uv`

---

## Where to read further

| Question | Document |
|---|---|
| What happens when X fails, and who owns the response? | [`docs/FAILURE_MODES.md`](FAILURE_MODES.md) |
| Why is it built this way? | [`docs/ADR-hackathon.md`](ADR-hackathon.md) |
| How does the system operate, and who does what? | [`docs/CONOPS.md`](CONOPS.md) |
| What is the site model? | [`docs/SITE_CONTRACT.md`](SITE_CONTRACT.md) |
| What is the attack surface? | [`docs/THREAT_MODEL.md`](THREAT_MODEL.md) |
| What is verified, and what is still integration in progress? | [`docs/BASIC_DEMO_PENDING.md`](BASIC_DEMO_PENDING.md), [`docs/IMPLEMENTATION_STATUS.md`](IMPLEMENTATION_STATUS.md) |
| Where did each component come from? | [`docs/REPOSITORY_REVIEW.md`](REPOSITORY_REVIEW.md), [`docs/SESSION_AUDIT.md`](SESSION_AUDIT.md) |
