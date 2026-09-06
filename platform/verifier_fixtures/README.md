# verifier_fixtures

The executable specification for the deterministic mission trust layer.

The behaviour these cases pin **is** `ground/planner/src/verifier.ts` — the
module the planner CLI, the Electron host and the SITL gate all call. These
files say what it must decide, so a change in verdict shows up as a failing
fixture instead of a surprise in flight.

Since Phase 4 there **is** a second implementation, and it is not in this
directory: [`rails/`](../../rails/README.md) at the repo root is a Python
ORACLE for the same rules, written from the ADR and the contract and importing
nothing from `platform/`. Every case below is run through both and the answers
compared — see [Parity](#parity).

| File | What it is |
|---|---|
| `V01.json` … `V25.json`, `V29.json` … `V36.json` | One case each: a plan, a runtime context, the task its state is planned for, and the verdict + failing checks the verifier must produce. |
| `site.fixture.json` | The site most cases verify against (`docs/SITE_CONTRACT.md` schema). |
| `baseline_context.json` | The healthy runtime context each case starts from. |
| `profiles.json` | Mission profiles, aliases and hard limits, mirrored by `ground/planner/src/policy.ts`. |
| `range_model.json` | Endurance, reserve, wind and battery constants, mirrored the same way. |
| `run_fixtures.mjs` | Standalone runner against the compiled planner. |

`profiles.json` and `range_model.json` are the reviewable source for
`policy.ts`; `ground/planner/test/policy-parity.test.ts` fails if they drift.
`rails/policy.py` mirrors the same two files a third time, and
`ground/planner/test/parity.test.ts` fails if THAT drifts, because a drifted
constant changes a verdict.

**V26–V28 do not exist.** They are reserved for the cue-budget wave, whose
`cue_budget` check has not landed. `ground/planner/test/verifier-fixtures.test.ts`
pins the exact id set, so the gap is asserted rather than assumed: adding the
three cases means adding their ids there too.

## The check table

The verifier runs `CHECK_ORDER` — all twenty checks, in this order, every time,
including the ones a prior failure has already made moot (they report *why* they
were not evaluated rather than silently passing):

| # | Check | What it decides | Oracle reference | Pinned by |
|---|---|---|---|---|
| 1 | `schema` | The plan is a well-formed, finite `MissionPlan`. | `rails/schemas.py::validate_mission_plan` | V02, V18 |
| 2 | `site_valid` | The site model's own geometry and policy fields hold. | `rails/verifier.py::check_site` | V17 |
| 3 | `nav_source` | New missions fly on GPS, never on `extnav`/`optflow`. | `check_nav_source` | V03, V22 |
| 4 | `readiness` | Battery dispatch gates, sensor health, night thermal, LiDAR-vs-clutter. | `check_readiness` | V15, V16, V24, V34 |
| 5 | `wind` | Reported wind is within the attended limit. | `check_wind` | V04 |
| 6 | `rf_environment` | GNSS interference blocks dispatch without an operator override; **no SDR is `unknown`, not clear**. | `check_rf_environment` | V19, V20, V22 |
| 7 | `airspace` | A hostile drone in mission airspace is yielded to, never contested — **pre-flight, this refuses**. | `check_airspace` | V21 |
| 8 | `anomaly_proximity` | Some mission target actually looks at the cue. | `check_anomaly_proximity` | V05 |
| 9 | `altitude` | Every target sits in the site band ∩ the profile band. | `check_altitude` | V06, V13 |
| 10 | `speed` | Every leg is inside the profile cap and the 8 m/s hard cap. | `check_speed` | V07 |
| 11 | `standoff` | Every explicit orbit radius clears the profile and 3 m hard floors. | `check_standoff` | V08 |
| 12 | `geofence` | Targets, orbit circumferences and complete legs stay contained. | `check_geofence` | V09, V25 |
| 13 | `nfz_transit` | Legs clear every buffered NFZ that applies at their lowest altitude. | `check_nfz_transit` | V10 |
| 14 | `nfz_orbit` | Orbit circumferences clear the buffer plus their own radius. | `check_nfz_orbit` | V11 |
| 15 | `terminal` | Exactly one `rtl`, and it is last. | `check_terminal` | V12 |
| 16 | `loiter` | Hold durations and orbit laps are bounded. | `check_loiter` | V23 |
| 17 | `range` | Wind-adjusted flight time fits the live pack, 25 % reserve intact. | `check_range` | V14, V20 |
| 18 | `sortie` | Wind-adjusted flight time fits the sortie cap. | `check_sortie` | V23 |
| — | *(`cue_budget`)* | **Reserved**, with V26–V28. Not implemented on this branch. | — | — |
| 19 | `attended` | Unattended: anything outside `UNATTENDED_ENVELOPE` is `needs_operator`. | `check_attended` | V32, V33, V34, V35 |
| 20 | `deconfliction` | 40 m lateral or 10 m stagger from every peer corridor; no shared orbit centre. | `check_deconfliction` | V29, V30, V31 |

Every row is checked twice per run: once by `verifier.ts` and once by the
oracle's `rails/verifier.py`, over the same case. The check names, the verdict
and `requiresOperator` must agree exactly (see [Parity](#parity)).

**The in-flight half of rows 6 and 7 is not here, and cannot be.** The verifier
is a PRE-FLIGHT gate: a hostile drone found before launch refuses (V21), and
GNSS interference before launch needs an operator override (V19). What happens
when either appears *after* takeoff — hold, then the operator chooses continue
or RTL (ADR D14/D18) — belongs to the runtime envelope monitor, and is pinned
by `rails/eval_envelope.py`'s recorded trajectories through
`platform/companion/tests/test_envelope_parity.py`. A plan fixture has no
timeline, so it cannot express "after takeoff".

`attended` sits where the cue-budget wave will put `cue_budget` immediately
before it: budget is about *whether* to spend a sortie, attendance about *who is
watching it*, and deconfliction — which needs the final geometry, including a
delayed dispatch time — is last.

`attended` and `deconfliction` never *correct* a refusal into a pass. Quietly
shrinking a task into the unattended envelope would hide the refusal a human is
supposed to see, and two vehicles on one orbit centre is a tasking mistake, not a
geometry problem. `deconfliction` does correct, in the documented order —
altitude stagger first, then a delayed dispatch (`holdUntil`) — and never by
moving the route sideways: lateral geometry answers the anomaly.

The 40 m doubles to 80 m when the peer view is older than 3 s (ADR D21). Age
comes from the runtime context's `fleetTs` (the `FleetMessage.ts` the `fleet`
array arrived on), because `FleetVehicle` carries no timestamp of its own; a
caller that omits it gets the nominal 40 m. No fixture can pin that rule — it is
a function of when the message arrived, not of anything in the plan — so
`ground/planner/test/verifier.test.ts` pins it instead, with one 55 m gap that is
legal fresh and illegal stale.

## Running

```bash
cd ground/planner && npm test          # vitest suite, against the TypeScript sources
```

```bash
cd ground/planner && npm run build     # then, against the compiled dist:
node verifier_fixtures/run_fixtures.mjs            # every case
node verifier_fixtures/run_fixtures.mjs V10 V23    # named cases
node verifier_fixtures/run_fixtures.mjs --json V10 # dump the Verification
```

Both paths read the same JSON and assert the same things.
`ground/planner/test/verifier-fixtures.test.ts` is the CI hookup.

## Parity

```bash
python rails/eval_planner.py            # human summary, run from the repo root
python rails/eval_planner.py --json     # the parity document
python -m pytest rails/test_rails.py    # the oracle's own tests
cd platform/ground/planner && npx vitest run test/parity.test.ts
```

`ground/planner/test/parity.test.ts` shells out to `rails/eval_planner.py
--json` (interpreter from `EIS_PYTHON`, defaulting to the companion venv then
`python3`/`python`), runs the same cases through `verifier.ts` and
`deterministic.ts`, and compares, per case:

| Compared | Why it is the parity surface |
|---|---|
| `verdict` | The decision itself. |
| `requiresOperator` | `attended` failing, or the context's lure flag — the "a human looks first" answer, derived identically on both sides. |
| non-pass check names | *Which* rule refused, not just that one did. |
| corrected tool sequence | Args agree within **1 m / 1 s**: the same repair, not merely the same verdict. |
| `planTrace` rule names | Which rules FIRED, in order — the planner's reasoning, without its geometry. |

The oracle is the reference for `ground/planner`. **A parity failure is a bug
in the TypeScript port, never a reason to edit the oracle afterwards.** If the
oracle is provably wrong against the ADR or the contract it is corrected — but
before the first green run, and the correction is recorded, because an oracle
edited until it agrees proves nothing.

## Case format

```jsonc
{
  "id": "V10",
  "scenario": "nfz_transit",          // stable slug
  "description": "…",                 // why this case exists, in prose
  "covers": ["NFZ at ceiling", …],    // the edges it pins
  "site": "site.fixture.json",        // or "../site/site.stub.json" (V36)
  "siteOverride": { … },              // optional: patch the VALIDATED SiteModel
  "plan": { …MissionPlan… },
  "probeTask": { …Task… },            // REQUIRED: the task this STATE is planned for
  "probeRequestId": "probe-V10",      // REQUIRED: the requestId that plan carries
  "task": { "task": …, "anomaly": … },// optional: the input the plan came from
  "telemetry": { …VerificationContext patch… },
  "expected": {
    "verdict": "pass" | "corrected" | "rejected",
    "failingChecks": ["nfz_transit"], // exact set, in CHECK_ORDER
    "editedChecks": ["nfz_transit"],  // optional: checks carrying an edit note
    "reasonContains": { "nfz_transit": ["25 m required"] },   // optional
    "editContains":   { "nfz_transit": ["moved tool 0 clear"] } // optional
  }
}
```

`telemetry` is merged over `baseline_context.json`: one level deep for
`battery`, `readiness`, `sensors` and `anomaly` — so a case can change a single
SoC or sensor field without restating a whole healthy vehicle — and replacing
every other key outright. It is the same JSON shape the planner CLI accepts as
`verify --context`.

`siteOverride` patches the model *after* validation. `site.ts` would refuse
V17's geofence outright; patching past the loader proves the verifier re-checks
the geometry itself rather than trusting whoever loaded the file.

`probeTask` and `probeRequestId` are the inputs the DETERMINISTIC PLANNER needs
to be run against this case's runtime state — every case carries them, so the
TypeScript planner and the `rails/` oracle read literally the same task instead
of each constructing a probe of its own. Together with `site`, `siteOverride`
and `telemetry` (which is where `mode`, `fleet`, `vehicleId`, `now` and
`dispatchAt` live), that is the complete input set both implementations need:
task, state, site, mode, fleet. Adding a case means adding these two fields
too; `rails/eval_planner.py` refuses a case without them rather than inventing
a task, because an invented input is not a fixture.

A case carrying a `task` block declares that its `plan` is the DETERMINISTIC
PLANNER's own output for that task, cue, site and context.
`ground/planner/test/deterministic.test.ts` re-plans it and asserts the emitted
plan matches byte for byte, so a drift in the rule table shows up as a fixture
diff rather than as a different mission in flight.

Every case additionally asserts, without saying so:

- the checks run in `CHECK_ORDER`, all twenty, every time;
- a schema or `site_valid` failure blocks every later check rather than
  reporting them as passed;
- a `corrected` verdict carries a corrected plan that itself re-verifies to
  `pass` with no further edits, and `pass`/`rejected` never carry one.

And, in `ground/planner/test/deterministic.test.ts`, every case's runtime STATE
is fed to the deterministic planner, which must answer with a plan the verifier
passes or an explicit `infeasible` — never something to correct.

## What the set covers

| | Case |
|---|---|
| Nominal, with every legal edge at once | V01 |
| Malformed tool / malformed coordinate | V02, V18 |
| Invalid site geometry — `site_valid` refuses outright | V17 |
| Navigation source; RF needing an operator override; hostile airspace refused pre-flight; GPS loss correlated with interference | V03, V19, V21, V22 |
| Wind, anomaly proximity | V04, V05 |
| Altitude band — above ceiling, below floor, edges legal | V06, V13, V01 |
| Speed cap, standoff floor | V07, V08 |
| Geofence — target out, leg out of a concave fence, in | V09, V25, V01 |
| NFZ — route buffer at the ceiling, orbit buffer, legal overflight above it | V10, V11, V01 |
| Terminal rtl, loiter bounds, sortie cap | V12, V23 |
| Battery dispatch gates, range boundary either side | V24, V14 / V20 |
| Night thermal, LiDAR + clutter | V15, V16 |
| Corrected plans | V06–V13, V16, V23, V30 |
| Fleet — clean second vehicle, crossing corridors, shared orbit centre | V29, V30, V31 |
| Unattended — in-envelope pass, survey refused, night without thermal | V32, V33, V34 |
| Unattended — the lure flag becomes a rejection | V35 |
| Deterministic planner output, verified without correction | V36 |
| Every case's runtime STATE through the deterministic planner and the oracle | V01–V36 |

Thirteen of the thirty-three states cannot be planned at all, and the set is
asserted exactly rather than counted: **V03, V04, V09, V15, V16, V17, V19, V21,
V22, V24, V31, V34, V35**. Each is a state the verifier would also have refused,
so refusing earlier costs nothing and explains more. The other twenty produce a
plan the verifier passes with no correction. Both implementations must agree on
that split, on the reason, and on which rules fired.

V14 and V20 are the same mission one second either side of the live-endurance
range boundary: 455 s of reported endurance is refused, 456 s flies. They are
the canary for any change to the range model, the flight-time walk, or the 25 %
reserve.

The site geometry exists to make those edges provable: the ash-dam NFZ has a
30 m ceiling so the 20–80 m band contains both a legal overflight and an
at-ceiling breach, and the geofence has a notch cut out of its east edge so a
leg between two contained targets can still leave containment.

## Provenance

`site.fixture.json` is **synthetic**. It is a generic fixture site: home is an
arbitrary anchor and every other coordinate is generated from metre offsets
chosen to sit on a check boundary. It models no real place, it is not a survey,
and it never substitutes for `site/site.json` — see `docs/SITE_CONTRACT.md` for
the real cutover. Its geometry is frozen: the `V01`–`V25` verdicts are pinned to
these exact edges, so it does NOT track `site/site.stub.json`.

The `V01`–`V25` identifiers replace the placeholder stubs committed in the
Phase 0 slice. Scenario slugs are unchanged except where a placeholder was
folded into a stronger case: the two NFZ buffer stubs merged into `V10`/`V11`
(a buffer breach subsumes a polygon breach), `long_hold` merged into `V23`, and
the two battery stubs merged into `V24`. The freed IDs became the cases the
placeholder set had no coverage for at all — `low_altitude` (V13),
`night_thermal` (V15), `lidar_clutter` (V16) and `geofence_segment` (V25).

`V29`–`V36` arrived with the `attended` and `deconfliction` checks and the
deterministic planner. `V29`–`V31` and `V36` pin fixed `now` / `dispatchAt`
timestamps rather than reading the clock, because a time-overlap test that
depends on when it is run is not a fixture. `V36` is the only case that verifies
against `../site/site.stub.json` instead of `site.fixture.json`: the switchyard
NFZ that forces a via-point on both the outbound and the return leg lives in the
stub site, and re-drawing it here would have meant a second copy of the geometry
the planner is being tested against.

Phase 4 added `probeTask` / `probeRequestId` to every case and nothing else: no
verdict, no failing-check list, no reason and no correction moved. The values
are exactly the probe `ground/planner/test/deterministic.test.ts` already built
in code, lifted into the data so the oracle and the port cannot diverge on
their input. V19–V22 were reviewed against the Phase 4 brief's four behaviours
and already covered them — RF needing an operator override (V19), a hostile
drone refused pre-flight (V21), an unusable site model (V17), and GPS loss
correlated with interference (V22) — so no case was added and no new verifier
check was needed. The in-flight hold half of the hostile-drone rule is the
envelope monitor's, not the verifier's; see the note under the check table.

Adding `attended` and `deconfliction` to `CHECK_ORDER` changed exactly three
existing cases — `V02`, `V17`, `V18` — and only their `failingChecks` lists.
Those are the three whose `schema` or `site_valid` failure blocks every later
check, so the two new names join the blocked list. No verdict, no reason and no
correction in the V01–V25 set moved.
