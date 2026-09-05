# ARGUS — Layered Autonomous Surveillance for Critical Infrastructure

**DNHacks · Defense track · 4 people · 24 hours**

A two-layer AI security system for a power plant. A wide-area satellite layer flags
change at a facility; an LLM agent triages the alert and declares a mission intent; a
deterministic safety layer validates the plan; PX4 SITL flies it; the agent observes the
site and writes an incident report for a human operator.

---

## 1. The pitch

Autonomous ISR (intelligence, surveillance, reconnaissance) for critical infrastructure,
demonstrated in simulation on the real flight stack.

- **Wide-area layer (satellite).** Before/after Sentinel-2 imagery of a facility, with
  cloud-masked change detection producing a georeferenced anomaly polygon and a
  confidence score.
- **Close-up layer (drone agent).** When the wide-area layer flags an anomaly, an LLM
  agent plans a mission to that area, flies it in PX4 SITL, observes the site, and
  decides: false alarm, log, or escalate to a human with a written incident report.
- **Trust layer.** Before any mission is dispatched, a verification step checks the plan
  against geofences, no-fly zones, battery range, and altitude limits — rejecting invalid
  plans before a single motor spins.

PX4 SITL runs the same flight code that runs on real hardware. The honest version of the
claim: **the mission planner and safety validator speak MAVLink and port to a real
airframe unchanged.** Avoid "the only thing missing is the airframe" — it invites the
GPS-denial and perception questions that simulation genuinely does not answer.

### Why it wins

The satellite + drone combination covers both wide-area detection and close inspection,
which most teams won't think to combine. And the trust layer plus its adversarial demo is
what makes it a defense project rather than a toy — almost nobody else will show their
autonomy stack *refusing* to fly.

---

## 2. Design constraints (read before building)

These are baked into the architecture. They are physics and scope, not preferences.

1. **Sentinel-2 is 10 m/pixel.** A pickup truck is sub-pixel; a fence line is
   centimeters. "Detect a new vehicle" and "detect a fence breach" are physically
   impossible at this resolution and a geospatial judge will catch it instantly. Pick a
   change class 10 m actually resolves: new construction pad, equipment laydown yard,
   earthmoving, impoundment change, vegetation encroachment. **State the resolution
   number out loud in the pitch.** Owning the limit reads as competence.
2. **Change detection on real imagery is a rabbit hole.** Sun angle, atmosphere,
   phenology, and co-registration error all differ between two passes. Naive differencing
   yields a wall of false positives. Choose the tile pair deliberately, commit it, and do
   the analysis offline against that fixed pair.
3. **The LLM does not compute geometry.** Waypoint routing is solved classical geometry;
   an LLM adds latency, cost, and nondeterminism for zero gain. The model emits *intent*
   (objective, area polygon, constraints) and *judgment* (triage, incident narrative).
   `planner/coverage.py` derives waypoints. This boundary is the answer to "why is an LLM
   flying your drone?"
4. **Safety is enforced twice, independently.** Layer 1 is the Python validator, which
   rejects pre-dispatch. Layer 2 is PX4's own onboard geofence and failsafe params, which
   the agent cannot reach or disable. Defense-in-depth is the architectural claim.
5. **Everything ships as one process.** No Redis, no Postgres, no message queue. FastAPI,
   in-memory state, an append-only `events.jsonl` audit log, WebSocket to the console.

---

## 3. System architecture

```
  [Wide-Area Detector]          offline, pre-run on a fixed tile pair
   Sentinel-2 before/after
   → Detection{polygon, confidence, change_type}
              │
              ▼
  ┌───────────────────────────────────────────────┐
  │            OPERATOR CONSOLE (web)             │
  │   alert queue · map · telemetry · report      │
  └───────────────────────────────────────────────┘
              │  dispatch
              ▼
  [Triage Agent]  claude-opus-5 + strict tool use
   Detection + asset metadata + weather
   → MissionSpec{objective, survey_polygon, alt, standoff}
              │           ← LLM stops here. No waypoints.
              ▼
  [Coverage Planner]  Shapely, deterministic
   → FlightPlan{waypoints[], est_duration_s, est_battery_pct}
              │
              ▼
  ┌───────────────────────────────────────────────┐
  │   SAFETY VALIDATOR  ── layer 1, pre-dispatch  │
  │   geofence · no-fly · altitude · range · AGL  │
  │   → ValidationResult{verdict, violations[]}   │
  └───────────────────────────────────────────────┘
              │  accept                    reject ──→ console, no motors
              ▼
  [Flight Executor]  MAVSDK-Python → PX4 SITL
   arm · upload · fly (time-accelerated)
   PX4 onboard geofence ── layer 2, independent
              │
              ▼ per-waypoint frame capture
  [Observation]  Claude vision on rendered frame
              │
              ▼
  [Report Agent] → IncidentReport{verdict, narrative, evidence}
              │
              ▼
        console · operator escalates
```

### Repo layout

```
contracts/          shared Pydantic models + fixtures   (frozen H0–2, all)
  models.py
  fixtures/
widearea/           satellite layer                     (Person B)
  fetch.py  detect.py  eval.py
agent/              LLM triage, observation, reporting   (Person C)
  triage.py  observe.py  report.py
safety/             validator + rule table              (Person C)
  rules.py  validator.py  geofence.geojson
redteam/            adversarial cases                   (Person C)
  cases.py
planner/            polygon → waypoints                 (Person A)
  coverage.py
flight/             SITL + mission execution            (Person A)
  sitl.md  executor.py  capture.py
api/                FastAPI server + event bus          (Person D)
  server.py
console/            operator UI                         (Person D)
  index.html
```

---

## 4. The five contracts

**Freeze these in the first two hours.** Everything else is negotiable; these are not.
Write them in `contracts/models.py` as Pydantic models with hand-written examples in
`contracts/fixtures/`. All four people code against the fixtures from hour two, so nobody
is blocked on anybody.

```python
Detection        {id, polygon: GeoJSON, confidence: float, change_type: str,
                  before_ref: str, after_ref: str, detected_at: datetime}

MissionSpec      {detection_id, objective: Literal["inspect", "perimeter_sweep",
                  "standoff_observe"], survey_polygon: GeoJSON,
                  max_altitude_m: float, standoff_m: float, rationale: str}

FlightPlan       {mission_id, waypoints: list[{lat, lon, alt}], pattern: str,
                  est_duration_s: float, est_battery_pct: float}

ValidationResult {mission_id, verdict: Literal["accept", "reject"],
                  violations: list[{rule: str, detail: str, severity: str}]}

IncidentReport   {mission_id, verdict: Literal["false_alarm", "log", "escalate"],
                  narrative: str, evidence_refs: list[str]}
```

Note what `MissionSpec` does **not** contain: waypoints.

### Getting a schema-valid MissionSpec out of the model

Use **strict tool use** — `strict: true` plus `additionalProperties: false` plus a full
`required` list guarantees the returned `tool_use.input` validates against the schema
exactly. That turns "JSON I have to defensively parse" into a typed object.

```python
import anthropic

client = anthropic.Anthropic()

MISSION_SPEC_TOOL = {
    "name": "emit_mission_spec",
    "description": "Emit a mission intent for a flagged detection. Do NOT compute "
                   "waypoints; specify the area to survey and the constraints.",
    "strict": True,
    "input_schema": {
        "type": "object",
        "additionalProperties": False,
        "required": ["detection_id", "objective", "survey_polygon",
                     "max_altitude_m", "standoff_m", "rationale"],
        "properties": {
            "detection_id": {"type": "string"},
            "objective": {"type": "string",
                          "enum": ["inspect", "perimeter_sweep", "standoff_observe"]},
            "survey_polygon": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["lat", "lon"],
                    "properties": {"lat": {"type": "number"},
                                   "lon": {"type": "number"}},
                },
            },
            "max_altitude_m": {"type": "number"},
            "standoff_m": {"type": "number"},
            "rationale": {"type": "string"},
        },
    },
}

resp = client.messages.create(
    model="claude-opus-5",
    max_tokens=16000,
    thinking={"type": "adaptive"},
    output_config={"effort": "high"},
    tools=[MISSION_SPEC_TOOL],
    messages=[{"role": "user", "content": detection_context}],
)

for block in resp.content:
    if block.type == "tool_use" and block.name == "emit_mission_spec":
        spec = MissionSpec.model_validate(block.input)
```

Always parse tool inputs as JSON objects — never string-match the serialized input.

---

## 5. The four workstreams

### Person A — Flight & Simulation

Owns everything below the validator.

**Deliverables**

- `flight/sitl.md` — reproducible PX4 SITL launch, `PX4_SIM_SPEED_FACTOR` set, geofence
  params (`GF_ACTION`, `GF_MAX_HOR_DIST`) configured and documented
- `flight/executor.py` — MAVSDK-Python: take a validated `FlightPlan`, arm, upload, fly,
  RTL; stream telemetry to the bus
- `planner/coverage.py` — `MissionSpec.survey_polygon` → lawnmower waypoints via Shapely;
  endurance and battery estimate
- `flight/capture.py` — grab a camera frame at each waypoint, write to `evidence/`

**Consumes** `FlightPlan`. **Produces** telemetry stream, `evidence/*.jpg`.

**Assign this to whoever has the best Linux or macOS machine.** PX4 SITL through WSL2
with Gazebo wanting GPU passthrough is the single most likely way this project loses six
hours.

**Done at H12:** a hardcoded `FlightPlan` fixture flies in SITL, time-accelerated, with
telemetry visible in a terminal.

**H8 fallback gate:** if Gazebo isn't rendering a camera feed by hour 8, cut it. Run
headless SITL and serve pre-positioned georeferenced stills as the "camera." Decide at 8,
not 16.

Lawnmower coverage is ~30 lines: rotate to the polygon's principal axis, generate
parallel scan lines at camera swath width, clip to the polygon, stitch alternating.

---

### Person B — Wide-Area Detection

Owns the satellite layer and the only real numbers in the pitch.

**Deliverables**

- `widearea/fetch.py` — Sentinel-2 access via a STAC client. **Verify your access path
  works in the first 30 minutes.**
- Two committed tiles, chosen deliberately, showing one large unambiguous change
- `widearea/detect.py` — cloud-masked (SCL / s2cloudless), index-based change detection →
  `Detection` with polygon and confidence
- `widearea/eval.py` — 20 labeled before/after pairs, reporting precision and recall

**Produces** `Detection`.

**Design constraint:** see §2.1. Pick a change class 10 m resolves. Not vehicles, not
fence breaches. False-positive rate is *the* operational metric for a surveillance system
— alert fatigue is why these get switched off — so the eval numbers are not optional
polish, they're part of the pitch.

If there is lead time before the clock starts, spike **Umbra's open SAR archive** (AWS
open data, sub-meter, all-weather, day/night — a much better defense story than optical).
Caveats: coverage is sparse so you need repeat collects over the same spot, and speckle
makes interpretation harder. If a usable repeat pair isn't there, fall back to Sentinel-2
without regret.

**Done at H12:** the fixed tile pair produces a valid `Detection` JSON on disk.

---

### Person C — Agent & Safety

Owns the differentiator. Give this to your strongest engineer.

**Deliverables**

- `agent/triage.py` — `claude-opus-5`, strict tool use emitting a schema-valid
  `MissionSpec` (see §4)
- `safety/rules.py` — the rule table: geofence containment, no-fly intersection, altitude
  ceiling and AGL floor, range against endurance, standoff minimum
- `safety/validator.py` — Shapely + pyproj; `FlightPlan` → `ValidationResult`
- `safety/geofence.geojson` — facility boundary and no-fly polygons
- `agent/observe.py` — Claude vision over captured frames (base64 image blocks)
- `agent/report.py` — `IncidentReport` with a narrative an operator would actually read
- `redteam/cases.py` — **the money shot.** Three poisoned inputs:
  1. a hallucinated waypoint inside a no-fly zone
  2. a plan exceeding endurance
  3. a prompt injection buried in detection metadata instructing the agent to raise the
     altitude ceiling

  Each rejected, each rejection logged with the specific rule that caught it.

**Consumes** `Detection`, captured frames.
**Produces** `MissionSpec`, `ValidationResult`, `IncidentReport`.

Do distance math in a projected CRS via pyproj, never in degrees.

**Done at H12:** a `Detection` fixture yields a valid `MissionSpec`, and all three
red-team cases are rejected with named violations.

---

### Person D — Console & Integration

Owns the thing judges actually look at, and the glue.

**Deliverables**

- `api/server.py` — FastAPI: detection intake, dispatch endpoint, WebSocket telemetry,
  append-only event log
- `console/` — MapLibre GL JS map with detection polygons, planned route, live drone
  marker; alert queue; validation panel showing accept/reject with violated rules;
  incident report view
- Integration wiring between all four modules
- **The demo script and the recorded backup run**

D is also the integration owner, which means **at hour 10 D has the authority to tell A,
B, or C to stop building and start connecting.**

**Done at H12:** console renders a fixture detection on the map and displays a mock
telemetry stream.

Skip Streamlit — it fights you on live telemetry over WebSockets. Plain HTML plus
MapLibre is genuinely fast if nobody on the team is a frontend specialist.

---

## 6. Timeline

| Hours | What happens |
|---|---|
| 0–2 | Contracts frozen, fixtures committed, three env spikes pass: PX4 boots, imagery reachable, API key works. **No feature work until all three pass.** |
| 2–8 | Four parallel vertical slices against fixtures. No cross-dependencies. |
| 8 | Gazebo go/no-go gate. |
| 8–12 | Pairwise integration: B→C, C→A, A→D. |
| **12** | **Hard gate: end-to-end run works, however ugly.** If it doesn't, cut features rather than debug. |
| 12–16 | Red-team demo, eval numbers, staggered sleep — two down, two up. |
| 16–20 | Report quality, map polish, incident narrative tuning. |
| 20–21 | **Record the backup demo video.** Non-negotiable. |
| 21–22 | Deck. |
| 22–24 | Rehearse to three minutes, buffer. |

Feature freeze at hour 20. A recorded clean run means a live failure on stage costs you
nothing — and live demos fail.

---

## 7. The three-minute demo

1. Satellite layer flags a change on the map, with a confidence score and a stated 10 m
   resolution.
2. Operator clicks dispatch.
3. Agent emits a mission spec with its rationale visible.
4. Planner draws the route.
5. Validator turns green.
6. Drone flies, time-accelerated, telemetry live on the map.
7. Frame comes back, agent observes, incident report writes itself, operator escalates.

Then: *"now watch what happens when the model is wrong."* Run the red-team case and show
the rejection with the rule that caught it — followed by the PX4 geofence catching a
violation you deliberately let past layer 1.

Close on the eval numbers and one sentence on the hardware path.

**Have an answer ready for CONOPS.** BVLOS flight over critical infrastructure needs FAA
Part 107 waivers, and autonomous response to intrusion has real regulatory constraints.
One slide — operator-approved dispatch, drone-in-a-box sited at the facility, Part 107
waiver path — turns an obvious hole into credibility.

---

## 8. Stack

```bash
pip install anthropic mavsdk pydantic shapely pyproj geographiclib \
            fastapi uvicorn opencv-python rasterio pystac-client
```

PX4, Gazebo, and QGroundControl install separately per PX4's docs, on Linux or macOS.

| Layer | Tool | Role |
|---|---|---|
| Flight stack | **PX4 Autopilot** | `make px4_sitl gz_x500`; `gz_x500_mono_cam` for a camera airframe |
| Simulator | **Gazebo** (Harmonic+) | Physics + sensor rendering. PX4 moved off Gazebo Classic — follow current docs |
| Simulator fallback | **jMAVSim** | Lightweight, no rendering, boots in seconds |
| Ground station | **QGroundControl** | Demo eye candy: real mission upload, telemetry, map |
| Control API | **MAVSDK-Python** | Primary interface: `mission.upload_mission()`, `action.arm()`, `telemetry.position()` |
| Control API | **pymavlink** | Lower-level raw MAVLink for anything MAVSDK doesn't expose |
| LLM | **anthropic** / `claude-opus-5` | Triage, observation, reporting. $5/$25 per MTok, 1M context |
| Validation | **Pydantic** | Schema + type validation, second line behind `strict: true` |
| Geometry | **Shapely** | Geofence containment, no-fly intersection, coverage patterns |
| Geometry | **pyproj**, **geographiclib** | CRS transforms, geodesic distance for range checks |
| Console | **FastAPI** + WebSocket | Telemetry streaming, alert queue |
| Console | **MapLibre GL JS** | Map |
| Satellite | **rasterio**, **pystac-client** | Imagery access and raster ops |

### Skip list

**ROS 2** (a day of setup for capability you won't demo), **LangChain** (a framework's
worth of abstraction over ~40 lines you'd rather debug at 3 a.m.), **DroneKit-Python**
(unmaintained, but most tutorials use it), **AirSim** (archived by Microsoft), and any
fine-tuning. Every one is a plausible-looking detour that costs half a day and buys
nothing a judge will see.
