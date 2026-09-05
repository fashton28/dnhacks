# verifier_fixtures

The executable specification for the deterministic mission trust layer.

There is no second implementation of the checks in this directory. The
reference behaviour **is** `ground/planner/src/verifier.ts` — the module the
planner CLI, the Electron host and the SITL gate all call. These files pin what
it must decide, so a change in verdict shows up as a failing fixture instead of
a surprise in flight.

| File | What it is |
|---|---|
| `V01.json` … `V25.json`, `V29.json` … `V36.json` | One case each: a plan, a runtime context, and the verdict + failing checks the verifier must produce. |
| `site.fixture.json` | The site most cases verify against (`docs/SITE_CONTRACT.md` schema). |
| `baseline_context.json` | The healthy runtime context each case starts from. |
| `profiles.json` | Mission profiles, aliases and hard limits, mirrored by `ground/planner/src/policy.ts`. |
| `range_model.json` | Endurance, reserve, wind and battery constants, mirrored the same way. |
| `run_fixtures.mjs` | Standalone runner against the compiled planner. |

`profiles.json` and `range_model.json` are the reviewable source for
`policy.ts`; `ground/planner/test/policy-parity.test.ts` fails if they drift.

**V26–V28 do not exist.** They are reserved for the cue-budget wave, whose
`cue_budget` check has not landed. `ground/planner/test/verifier-fixtures.test.ts`
pins the exact id set, so the gap is asserted rather than assumed: adding the
three cases means adding their ids there too.

## The check table

The verifier runs `CHECK_ORDER` — all twenty checks, in this order, every time,
including the ones a prior failure has already made moot (they report *why* they
were not evaluated rather than silently passing):

| # | Check | What it decides |
|---|---|---|
| 1 | `schema` | The plan is a well-formed, finite `MissionPlan`. |
| 2 | `site_valid` | The site model's own geometry and policy fields hold. |
| 3 | `nav_source` | New missions fly on GPS, never on `extnav`/`optflow`. |
| 4 | `readiness` | Battery dispatch gates, sensor health, night thermal, LiDAR-vs-clutter. |
| 5 | `wind` | Reported wind is within the attended limit. |
| 6 | `rf_environment` | GNSS interference blocks dispatch without an operator override. |
| 7 | `airspace` | A hostile drone in mission airspace is yielded to, never contested. |
| 8 | `anomaly_proximity` | Some mission target actually looks at the cue. |
| 9 | `altitude` | Every target sits in the site band ∩ the profile band. |
| 10 | `speed` | Every leg is inside the profile cap and the 8 m/s hard cap. |
| 11 | `standoff` | Every explicit orbit radius clears the profile and 3 m hard floors. |
| 12 | `geofence` | Targets, orbit circumferences and complete legs stay contained. |
| 13 | `nfz_transit` | Legs clear every buffered NFZ that applies at their lowest altitude. |
| 14 | `nfz_orbit` | Orbit circumferences clear the buffer plus their own radius. |
| 15 | `terminal` | Exactly one `rtl`, and it is last. |
| 16 | `loiter` | Hold durations and orbit laps are bounded. |
| 17 | `range` | Wind-adjusted flight time fits the live pack, 25 % reserve intact. |
| 18 | `sortie` | Wind-adjusted flight time fits the sortie cap. |
| — | *(`cue_budget`)* | **Reserved**, with V26–V28. Not implemented on this branch. |
| 19 | `attended` | Unattended: anything outside `UNATTENDED_ENVELOPE` is `needs_operator`. |
| 20 | `deconfliction` | 40 m lateral or 10 m stagger from every peer corridor; no shared orbit centre. |

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
| Invalid site geometry | V17 |
| Navigation source, RF, hostile airspace | V03, V19, V21, V22 |
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

V14 and V20 are the same mission one second either side of the live-endurance
range boundary: 455 s of reported endurance is refused, 456 s flies. They are
the canary for any change to the range model, the flight-time walk, or the 25 %
reserve.

The site geometry exists to make those edges provable: the ash-dam NFZ has a
30 m ceiling so the 20–80 m band contains both a legal overflight and an
at-ceiling breach, and the geofence has a notch cut out of its east edge so a
leg between two contained targets can still leave containment.

## Provenance

`site.fixture.json` is **synthetic**. Home is Komati Power Station; every other
coordinate is generated from metre offsets chosen to sit on a check boundary.
It is not a survey, it is not the plant, and it never substitutes for
`site/site.json` — see `docs/SITE_CONTRACT.md` for the real cutover.

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

Adding `attended` and `deconfliction` to `CHECK_ORDER` changed exactly three
existing cases — `V02`, `V17`, `V18` — and only their `failingChecks` lists.
Those are the three whose `schema` or `site_valid` failure blocks every later
check, so the two new names join the blocked list. No verdict, no reason and no
correction in the V01–V25 set moved.
