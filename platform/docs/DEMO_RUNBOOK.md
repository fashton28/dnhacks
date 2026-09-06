# Demo runbook

Runtime paths in this document are relative to [`platform/`](..), this file's
parent directory.

> **Name.** The hardware commissioning runbook is
> [`docs/runbook.md`](runbook.md). This file is the demo runbook; it is not
> called `RUNBOOK.md` because the two names collide on a case-insensitive
> filesystem (ADR D18).

The demo shows one thing: **a cue becomes a bounded, verified, evidenced look,
and every layer that could refuse it is visible while it happens.** Site is
Meridian Station, a fictional generating station — simulation only, said out loud
once, early.

---

## 1. Pre-demo checklist

Work top to bottom. Anything that fails here has a replacement beat in §4;
nothing here is debugged live.

**Environment**

- [ ] Scripted mode everywhere: `EIS_PLANNER_MODE=scripted`, `EIS_SAT_MODE=baked`,
      cue rails on fixtures. Nothing on the demo path may block on the network,
      and nothing on the demo path calls a model provider.
- [ ] `EIS_SITE_FILE=site/site.stub.json` selected explicitly; the console shows
      Meridian Station geometry — site-footprint perimeter, inset geofence,
      reactor-exclusion and switchyard NFZs with the 25 m buffer drawn.
- [ ] SITL up with two vehicles; both report `eis-1` / `eis-2` and sit on their
      pads, armed-capable, SoC ≥ 80%, `charge_state=charged`.
- [ ] Ground station connected; the operator session is live and the approval
      authority is valid (attended mode, not unattended).
- [ ] Audit log empty or freshly rotated, so the chain shown at the end is this
      run's.

**Console**

- [ ] Exactly five panels visible (§6). Anything else is closed — no terminal, no
      editor, no logs pane, no second browser window.
- [ ] Map centred on the site with the east fence line in frame; the switchyard
      NFZ visible without panning, because the refusal beat happens there.
- [ ] Report panel cleared of previous runs.

**Dry runs**

- [ ] Run the 90-second sequence once end to end, silently, and confirm the
      timings in §2 hold within a few seconds.
- [ ] Run the `--bad-plan` and `--gust` beats once each so the replacements are
      known-good before they are needed.
- [ ] Backup recording of the full sequence exists and is openable in one click.

**Say-once framing** (before beat 1, ~8 seconds): a generating station wound down
from generation, critical infrastructure, copper theft is the real threat, the
site itself is fictional and everything you are about to see is simulated, and
the system observes and reports — it never intervenes.

---

## 2. The 90-second beat list

Opens on the CCTV beat, because that is the rail an operator at a site like this
already has.

| Time | Beat | On screen | The line |
|---|---|---|---|
| 0:00–0:08 | Framing | Five panels, map on Meridian Station, both vehicles on their pads | Site, threat, "this is simulation", "it observes and reports" |
| 0:08–0:20 | **CCTV cue** — motion at the east fence | A camera zone lights on the map; the cue appears with its zone centroid, `ttl_s`, confidence and `cameraId` | "A fixed camera sees motion in the east fence zone. That is the only thing that happened so far — a cue is not a mission" |
| 0:20–0:30 | **Task** | Task panel shows the model's JSON: `lookFor: fence_gap`, zone, priority, rationale | "The model gets a vote on *what to look at*. It emits schema-bound JSON — no coordinates, no altitude, no plan. It cannot fly anything" |
| 0:30–0:42 | **Plan + verification** | Plan panel draws the corridor: `inspect` profile, altitude mid-band, straight leg, orbit radius, 15 s hold, `rtl`. Verifier panel turns green with each check named | "The plan is a rule table over the site file — same task, same plan, every time. The verifier checks it against geofence, NFZ buffers, altitude band, standoff and range, and names every check" |
| 0:42–0:60 | **Sortie** | Vehicle arms, takes off, flies the corridor; envelope/status panel shows attended, approval valid, corridor tolerance, live separation from the second vehicle | "Stock ArduPilot in GUIDED. The corridor is what the monitor watches — not the waypoint list. The operator can take it at any moment, and manual preempts everything" |
| 0:60–0:72 | **Observation + report** | Frames come back; report panel writes the schema-bound report: verdict `escalate`, evidence references, `vehicleId` | "The model writes the report, and only the report. Verdict goes to a human — the system has no other move" |
| 0:72–0:82 | **Satellite audit pin** | Satellite layer pins the same fence section as changed since the last pass; the pin sits next to the CCTV cue on the map, marked audit-only | "Different rail, different physics, same fence section. This one is a site-integrity pin — it is evidence and audit, not a dispatch trigger" |
| 0:82–0:90 | **Close** | Vehicle RTLs and lands; audit panel shows the hash chain for the run | "Cue, task, plan, refusal-capable verifier, bounded flight, report, chained audit. One human decision at the end, and no interdiction anywhere" |

### Why the satellite beat is a pin, not a dispatch

Say it explicitly, because it is the honest and the stronger claim: the overhead
rail runs on its own cadence, not on the timescale of an intrusion. It corroborates
what the fast rails saw and it catches slow change nobody cued — a fence section
that has been open since the last pass. It is an **audit pin**: it lands on the
map, it lands in the record, and it does not dispatch a sortie by itself.

---

## 3. The handoff beat

Flag: `--handoff`. Runs after beat 6 when there is time, or replaces the satellite
pin when the two-vehicle story matters more to the audience.

1. Vehicle `eis-1` is orbiting the cue and reaches its sortie cap.
2. The task is handed to `eis-2`, which is already airborne or launches on its own
   plan for the same task.
3. Both vehicles are visible on the map with the live separation readout; the
   nominal 40 m separation holds through the overlap.
4. `eis-1` RTLs on its own timer. `eis-2` completes the observation.

The line: *"Two vehicles, star topology, no mesh. Each one holds and returns on its
own timer — the hub going away is not a fleet event. Handoff is an explicit,
audited action; the fleet never reallocates a task by itself."*

---

## 4. Replacement beats

Both are complete, self-contained and rehearsed. Use one when a beat above fails,
or when the audience asks the obvious question.

### R1 — "The operator is the one who is wrong"

**Flag:** `--bad-plan`, or performed live by dragging the target.

The operator drags the observation target into the **switchyard**. The switchyard
is an NFZ with a 120 m ceiling above the 20–80 m band, so it is a full no-go. The
verifier refuses, naming `nfz` and `altitude`; the approve control stays disabled;
one repair attempt is offered and the second rejection escalates.

The line: *"The system just refused its own operator. Not the model — the operator.
Then the companion refuses it again on the vehicle, and behind both of those sits
ArduPilot's own fence, which nothing in our stack can reach."*

Use this whenever a beat fails: it is the strongest thirty seconds in the demo.

### R2 — "The wind is the one that is wrong"

**Flag:** `--gust S`.

A gust of `S` m/s pushes the vehicle off its corridor. At one tolerance the
monitor warns and slows; past 2× tolerance it holds; when the gust ends and the
error stays inside tolerance through the hysteresis window, the vehicle resumes
the same plan.

The line: *"Drift gets a proportionate response — warn and slow. Twice the
tolerance is a control problem, not weather, so it holds. And it does not flap:
recovery is hysteretic, one entry and one exit in the audit."*

---

## 5. Failure beats and their flags

Each is 15–25 seconds. Pick by what the audience pushed on; never run more than
three.

| Flag | What it injects | What the audience sees | Response |
|---|---|---|---|
| `--gust S` | `S` m/s gust pushing the vehicle off the corridor | Warn-and-slow, then `hold` at 2× tolerance, then hysteretic recovery onto the same plan | `hold` |
| `--guidance-override S` | A guidance override commanding toward the switchyard NFZ for `S` seconds | Monitor `rtl` on the buffer breach; the unbuffered NFZ is never entered; past 5 s it also escalates | `rtl`, then `escalate` |
| `--operator-absent` | No operator session; approvals expire | Dispatch `refuse` on expired approval; the escalation chain runs to its end; `escalation_undelivered` health event; the vehicle RTLs on its own timer; the cue is not re-flown | `refuse`, then `escalate` |
| `--bad-plan` | A plan that fails verification (switchyard NFZ plus altitude) | Verifier refuses with both checks named; one repair attempt; second rejection escalates; no third model attempt | `refuse`, then `escalate` |
| `--handoff` | Vehicle 1 reaches its sortie cap mid-task | Task handed to vehicle 2, 40 m separation maintained through the overlap, vehicle 1 RTLs independently | — |
| `--peer-stale S` | Peer telemetry aged `S` seconds | At 3 s the separation requirement widens to 80 m; at 10 s the vehicle holds unconditionally | `hold` |

Rows, authorities and required assertions for all of these are in
[`docs/FAILURE_MODES.md`](FAILURE_MODES.md) § "Runtime assurance, unattended mode
and fleet".

---

## 6. The 30-second cut

For a hallway demo, a hard time signal, or a judge who has already seen it.

| Time | Beat |
|---|---|
| 0:00–0:04 | One line: Meridian Station, copper theft, simulation, observes and reports |
| 0:04–0:10 | CCTV cue at the east fence |
| 0:10–0:16 | Task JSON — "the model picks what to look at, not where to fly" |
| 0:16–0:22 | Plan drawn, verifier green with checks named |
| 0:22–0:28 | Sortie inside the corridor, report written, verdict to a human |
| 0:28–0:30 | Close on the hash chain |

**Dropped from the cut:** the satellite audit pin, the handoff beat, and every
failure beat. **Never dropped:** the task JSON (it is the whole authority
argument), the verifier turning green with its checks named, and the sentence that
says this is simulated.

If there is one spare beat, add R1 — the refusal — not another success.

---

## 7. The five-panel rule

Five panels, always, and nothing else on screen.

| Panel | Shows | Why it is on screen |
|---|---|---|
| **Map** | Site geometry, geofence, buffered NFZs, cues, corridor, both vehicles, no-image zones | Everything spatial resolves here; the audience never has to be told where something is |
| **Task / plan** | The model's schema-bound task JSON, then the deterministic plan and corridor | The authority split is the argument, and it is only legible side by side |
| **Verifier** | Each check by name with its verdict; refusals with reasons | The refusal beat has nowhere to land without it |
| **Envelope / status** | Mode (attended/unattended), approval validity, altitude band, corridor tolerance, standoff, separation, battery, sortie timer, rail health | The bounds, live, so a claim about limits is visible rather than asserted |
| **Report** | The written report, verdict, evidence references, `vehicleId`, audit chain | The output that reaches a human |

Rules: no sixth panel, ever. No terminal, no logs pane, no editor — an injection
flag is set before the run, not typed during it. If a panel has nothing to show in
a beat it stays open and empty rather than being swapped out; the audience learns
the layout in the first ten seconds and never relearns it.
