# verifier_fixtures

The executable specification for the deterministic mission trust layer.

There is no second implementation of the checks in this directory. The
reference behaviour **is** `ground/planner/src/verifier.ts` — the module the
planner CLI, the Electron host and the SITL gate all call. These files pin what
it must decide, so a change in verdict shows up as a failing fixture instead of
a surprise in flight.

| File | What it is |
|---|---|
| `V01.json` … `V25.json` | One case each: a plan, a runtime context, and the verdict + failing checks the verifier must produce. |
| `site.fixture.json` | The site every case verifies against (`docs/SITE_CONTRACT.md` schema). |
| `baseline_context.json` | The healthy runtime context each case starts from. |
| `profiles.json` | Mission profiles, aliases and hard limits, mirrored by `ground/planner/src/policy.ts`. |
| `range_model.json` | Endurance, reserve, wind and battery constants, mirrored the same way. |
| `run_fixtures.mjs` | Standalone runner against the compiled planner. |

`profiles.json` and `range_model.json` are the reviewable source for
`policy.ts`; `ground/planner/test/policy-parity.test.ts` fails if they drift.

## Running

```bash
cd ground/planner && npm test          # vitest suite, against the TypeScript sources
```

```bash
cd ground/planner && npm run build     # then, against the compiled dist:
node verifier_fixtures/run_fixtures.mjs            # all 25
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
  "site": "site.fixture.json",
  "siteOverride": { … },              // optional: patch the VALIDATED SiteModel
  "plan": { …MissionPlan… },
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

Every case additionally asserts, without saying so:

- the checks run in `CHECK_ORDER`, all eighteen, every time;
- a schema or `site_valid` failure blocks every later check rather than
  reporting them as passed;
- a `corrected` verdict carries a corrected plan that itself re-verifies to
  `pass` with no further edits, and `pass`/`rejected` never carry one.

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
| Corrected plans | V06–V13, V16, V23 |

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
