# rails — the oracle

`rails/` is a **second, independent implementation** of the rules that decide
whether a mission may fly: the geometry, the deterministic planner, the twenty
verifier checks, the scripted triage ranking, and the runtime envelope
monitor's policy.

It is written in Python, from `platform/docs/ADR-hackathon.md` and the shared
contract, and it **imports nothing from `platform/`**. That is the whole point.
Two implementations that share a library agree by construction; two that share
only a specification agree only when the specification is being followed.

```
                       the same inputs
                              │
        ┌─────────────────────┴─────────────────────┐
        ▼                                           ▼
  rails/  (Python)                    platform/ground/planner  (TypeScript)
  the ORACLE                          platform/companion       (Python)
        │                                           │
        └───────────────► compared ◄────────────────┘
                     parity harnesses
```

## The rule

**The oracle is the reference. A parity failure is a bug in the port.**

When `rails/` and a port disagree, the port changes. The oracle is edited only
when it is provably wrong against the ADR or the contract — and then *before*
the first green parity run, with the correction recorded in the commit message.
An oracle edited after the fact, until it agrees, proves nothing at all; it is
just a slower copy of the code it was meant to check.

This is why the oracle is structured differently from the ports rather than
transcribed from them. `rails/envelope.py` evaluates its constraints from one
declarative pass where the companion writes a function per constraint;
`rails/verifier.py` carries its context as a plain mapping where the TypeScript
carries an interface. The NUMBERS and the ORDER are identical, because those
are the specification. The shape is not, because a transcription would
reproduce a bug rather than find one.

## Modules

| File | What it is a reference of |
|---|---|
| `policy.py` | `ground/planner/src/policy.ts` — profiles, hard limits, `UNATTENDED_ENVELOPE`, corridor and deconfliction policy. |
| `schemas.py` | The contract's planning slice in Pydantic (`MissionPlan`, `Task`, `Anomaly`, `Corridor`, `Verification`, `IncidentReport`), plus `validate.ts` as `validate_mission_plan`. |
| `site.py` | `ground/planner/src/site.ts` — the site model of `docs/SITE_CONTRACT.md`. |
| `geometry.py` | `ground/planner/src/geometry.ts` — local frame, buffered NFZs, geofence, segment intersection, via-point search, orbit shrink, the plan walk and the time/range model. |
| `deterministic.py` | `ground/planner/src/deterministic.ts` — the ADR D20 rule table and its tie-breaks. |
| `verifier.py` | `ground/planner/src/verifier.ts` — the twenty ordered checks, `attended`, `deconfliction`, and the correction path. |
| `triage.py` | The **scripted** path of `ground/planner/src/triage.ts`. The live LLM path is deliberately absent. |
| `prompts/triage.md` | A byte-for-byte copy of `ground/planner/prompts/triage.md`, so a prompt change is visible to the oracle's reviewer. `test_rails.py` fails if the two drift. |
| `envelope.py` | `companion/src/eis_companion/control/envelope.py` — the ADR D21/D22 policy, including separation and staleness. |
| `scripted.py` | `ground/planner/src/scripted.ts` — the `EIS_TEST_BAD_PLAN` rail, and **never** a plan source. |

And the two evaluators, which are what the harnesses actually call:

| File | What it does |
|---|---|
| `eval_planner.py` | Runs every `platform/verifier_fixtures/V*.json` through the oracle's verifier *and* its deterministic planner. `--json` emits the parity document. |
| `eval_envelope.py` | Twenty deterministically-generated trajectories → envelope state sequences. `--json` emits the parity document. |
| `test_rails.py` | The oracle's own tests, pinning it against the checked-in specification. |

## Running it

```bash
# from the repo root
python rails/eval_planner.py                 # human summary
python rails/eval_planner.py --json          # the parity document
python rails/eval_planner.py --json V10 V36  # named cases
python rails/eval_envelope.py                # per-trajectory state transitions
python -m pytest rails/test_rails.py -q      # the oracle's own tests
```

Dependencies: the standard library and **pydantic**. Nothing else, and no
network — `rails/` cannot reach one, by construction, which is the same
constraint the demo and test paths are under (ADR D4).

## The parity harnesses

```bash
cd platform/ground/planner && npx vitest run test/parity.test.ts
cd platform/companion && python -m pytest tests/test_envelope_parity.py -q
```

**`platform/ground/planner/test/parity.test.ts`** shells out to `python
rails/eval_planner.py --json` and compares, for every fixture:

| Compared | Tolerance |
|---|---|
| `verdict` | exact |
| `requiresOperator` | exact |
| the set of non-pass check names | exact (and the ordered list, since both run `CHECK_ORDER`) |
| the corrected tool sequence | positions within **1 m**, altitudes/radii within **1 m**, holds within **1 s**, laps and profile exact |
| the deterministic planner's `planTrace` rule names | exact, in order |
| whether that planner refused, and the verdict its plan earns | exact |

The interpreter comes from `EIS_PYTHON`. Without it the harness tries, in
order, `platform/companion/.venv/Scripts/python.exe` (`bin/python` off
Windows), then `python3`, then `python`, and takes the first that can import
pydantic. If none can it **fails** rather than skipping: a parity harness that
quietly does nothing is worse than no harness.

**`platform/companion/tests/test_envelope_parity.py`** imports
`rails.eval_envelope` for its twenty recorded trajectories — plain wire-shaped
data, not monitor objects, so each side builds its own monitor — and compares
the two state sequences tick for tick: `state`, `constraint`, `action`,
`base_action`, `wire_action`, `escalated`, the signed margin (within 1 mm /
1 ms), `margin_unit`, `speed_scale`, `back_off_m`, `breach_duration_s` and
`suspended`.

## `requiresOperator`

Both sides derive it from two facts the verifier already reports, and neither
side is allowed a private definition:

```
requiresOperator = (the `attended` check failed)
                OR (the runtime context carries requiresOperator)
```

The first is the unattended envelope refusing a dispatch (ADR D23); the second
is triage's lure rule naming a cue a human should look at before anything flies
(`docs/THREAT_MODEL.md` § A6.2). Both mean the same thing operationally — a
person looks first — which is why they are one field.

## What the oracle asserts about the planner

`eval_planner.py` exits non-zero if the deterministic planner ever emits, from a
fixture's runtime state, a plan the verifier answers with anything but `pass`:

> **pass or infeasible, never corrected.**

A `corrected` verdict on planner output would mean the planner wrote a plan
that violates a limit and the verifier rescued it. That is precisely the
failure the deterministic rule table exists to make impossible: `infeasible` is
a first-class outcome, and the planner refuses rather than producing something
for the trust layer to repair.

## Porting notes

Three JavaScript behaviours are reproduced explicitly, because the fixtures sit
on boundaries where "close enough" is a different verdict:

- **`Math.round` rounds half UP** (toward +∞) where Python's `round` is
  banker's rounding. `geometry.round6` uses `floor(x + 0.5)`.
- **`Array.prototype.sort` with a near-equality comparator.** The via-point
  ordering treats detours within 10⁻⁶ m as a tie and breaks it northernmost;
  the oracle reproduces the identical comparator through
  `functools.cmp_to_key` rather than approximating it with a sort key.
- **`plan.planTrace = trace` aliases one array.** Rules that fire *after* the
  plan object is built — the corridor, the deconfliction guard — are in the
  record the mission carries. The oracle assigns the same list object rather
  than a copy.

`rails/envelope.py` deliberately does **not** import `rails/geometry.py`. The
companion's monitor carries its own arithmetic — a boundary-inclusive ray cast
in degree space, a capsule distance about the segment start — and sharing a
library here would hide a divergence instead of exposing it. That mirrors the
monitor's own independence rule: it shares no state with guidance, and the
oracle shares no geometry with the planner's.
