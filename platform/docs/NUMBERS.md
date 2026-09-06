# Numbers

Runtime paths in this document are relative to [`platform/`](..), this file's
parent directory.

The single place any quantitative claim about this system is allowed to come
from. A number that is not a row here does not get said in a demo, written in a
report, or put on a slide.

## Rules for this file

1. **`TBD` is a legitimate value.** An unmeasured metric stays `TBD` until it is
   measured. It is never replaced by an estimate, a target restated as a result,
   or a figure carried over from a different configuration.
2. **Every filled row names how it was produced** — the command or fixture set —
   so it can be reproduced and so a stale value is detectable when the underlying
   fixture changes.
3. **Simulation results are labelled as simulation results.** Every number in this
   file is measured against SITL, scripted rails and fixtures. None of it is field
   performance, and none of it substitutes for the flight-test campaign described
   in [`docs/CONOPS.md`](CONOPS.md) § 6.
4. **Targets are design intent, not achievements.** The `Target` column says what
   the design aims at; the `Value` column says what was measured. They are never
   merged.
5. A metric that is measured and misses its target stays in the file with the
   miss visible. Rows are not deleted for being inconvenient.

---

## 1. Planner and verifier

| Metric | Definition | Measured by | Target | Value |
|---|---|---|---|---|
| Planner pass rate | Share of task fixtures for which the deterministic planner produces a plan the verifier accepts on the first attempt (excluding fixtures whose expected outcome is `infeasible` or a refusal) | Planner fixture suite over the Meridian Station stub site | — | `TBD` |
| Planner refusal correctness | Share of fixtures expected to yield `infeasible` or a verifier refusal that do so, **with the expected reason names** | Same suite | 100% | `TBD` |
| Plan determinism | Share of task fixtures whose plan is byte-identical across repeated runs (D20 tie-break: lowest detour, then northernmost via-point) | Repeat-run comparison over the fixture set | 100% | `TBD` |
| Verifier check coverage | Number of distinct named checks the verifier can emit, and the number exercised by at least one fixture | Fixture-to-check cross-reference | every check exercised | `TBD` |

## 2. Runtime assurance (monitor)

| Metric | Definition | Measured by | Target | Value |
|---|---|---|---|---|
| Monitor detection latency | Control-loop ticks between a constraint first being violated in the injected truth and the monitor changing state (20 Hz loop, so 1 tick = 50 ms) | Corridor, altitude-band, standoff, NFZ-buffer and geofence-margin injections | — | `TBD` (ticks) |
| Monitor detection latency, worst case | Maximum of the above across all injected constraints | Same injections | — | `TBD` (ticks) |
| False-breach rate | Monitor state changes raised per hour of nominal flight with no injected fault — the flapping metric that hysteresis exists to keep at zero | Long nominal SITL runs at the demo wind profile | 0 per hour | `TBD` |
| Recovery correctness | Share of recovered breaches showing exactly one state entry and one state exit in the audit (no flapping) | Gust injections at 1×, 2× and 3× tolerance | 100% | `TBD` |
| Corridor containment | Maximum observed cross-track and radial excursion during injected disturbance, against the 10 m / 15 m / 5 m tolerances | Gust and override injections | never inside an unbuffered NFZ or outside the geofence | `TBD` |

## 3. Unattended mode

| Metric | Definition | Measured by | Target | Value |
|---|---|---|---|---|
| Unattended-envelope fixtures | Number of fixtures covering `UNATTENDED_ENVELOPE` constraints (D23), one per constraint plus boundary cases either side | Envelope fixture suite | every constraint covered, both sides of each boundary | `TBD` |
| Unattended-envelope refusal rate | Share of out-of-envelope fixtures refused **and** escalated, with the violated constraint named | Same suite with `--operator-absent` | 100% | `TBD` |
| Signed-command enforcement | Share of unattended-entry attempts without a valid signed command that are rejected and audited | Unsigned and replayed command fixtures | 100% | `TBD` |
| Auto-revert latency | Time from an operator session connecting to the system reporting attended mode | Operator-connect injection | — | `TBD` |

## 4. Contract parity

| Metric | Definition | Measured by | Target | Value |
|---|---|---|---|---|
| Parity cases | Number of wire-type cases checked across all three contract mirrors — `ground/ui/src/contract/index.ts` (authoritative), `shared/shared.ts`, `shared/shared.py` | Parity check over the mirrors | every wire message and every field | `TBD` |
| Parity cases passing | Cases where the three mirrors agree semantically and `MockDataProvider` produces the same shape | Same check | 100% | `TBD` |
| `vehicleId` coverage | Share of wire messages and audit entries carrying `vehicleId` | Static check over the contract plus a captured run | 100% | `TBD` |

## 5. Fixtures and tests

| Metric | Definition | Measured by | Target | Value |
|---|---|---|---|---|
| Fixtures passing | Total fixtures across cue rails, planner, verifier, monitor, envelope and fleet, and the number passing | Full fixture run | 100% | `TBD` |
| Companion unit tests | Tests passing in `platform/companion` (no hardware) | `python -m pytest -q` | 100% | `TBD` |
| Ground planner tests | Tests passing in `platform/ground/planner` | `npm test` | 100% | `TBD` |
| Ground satellite tests | Tests passing in `platform/ground/satellite` | `npm test` | 100% | `TBD` |
| UI typecheck and lint | Clean/not clean | `npm run typecheck`, `npm run lint` | clean | `TBD` |
| Control-core purity | `control/` imports confined to numpy plus the standard library | Static import check | 0 violations | `TBD` |

## 6. End-to-end gauntlet

| Metric | Definition | Measured by | Target | Value |
|---|---|---|---|---|
| e2e gauntlet steps | Number of steps in the SITL gauntlet — arm, takeoff, cue, task, verify, fly corridor, observe, report, RTL, land, plus each injected failure — and the number passing | SITL gauntlet run | every step passing | `TBD` |
| Failure beats covered | Injection flags with a passing gauntlet step: `--gust`, `--guidance-override`, `--operator-absent`, `--bad-plan`, `--handoff`, `--peer-stale` | Same run | 6 of 6 | `TBD` |
| Standoff breaches | Position samples inside the standoff floor across the whole gauntlet | Same run | 0 | `TBD` |
| Geofence and NFZ breaches | Position samples outside the geofence or inside an unbuffered NFZ | Same run | 0 | `TBD` |
| Maximum geofence excursion | Largest measured excursion past the geofence when the firmware fence is the backstop | Fence-backstop injection | inside the outer perimeter containment margin | `TBD` |
| Two-vehicle separation | Minimum observed separation, against the 40 m nominal and 80 m widened requirements | `--handoff` and `--peer-stale` runs | never below the applicable requirement | `TBD` |
| Gauntlet wall-clock | Time for one full gauntlet run | Same run | — | `TBD` |

---

## Numbers that are configuration, not measurement

These are inputs, listed so they are never mistaken for results. They are
**initial simulation tuning values**, not flight-proven settings.

| Constant | Value | Source |
|---|---|---|
| Standoff floor | 3 m | Companion hard safety envelope |
| Maximum speed | 8 m/s | Companion hard safety envelope |
| Site altitude band | 5–60 m AGL | `site/site.stub.json` |
| Unattended altitude band | 30–50 m AGL | ADR D23 |
| NFZ route buffer | 25 m | `site/site.stub.json`, [`docs/SITE_CONTRACT.md`](SITE_CONTRACT.md) |
| Corridor lateral tolerance | 10 m `inspect` / 15 m `survey` | ADR D21 |
| Orbit radial tolerance | 5 m | ADR D21 |
| Inter-vehicle separation | 40 m nominal / 80 m when peer data > 3 s stale; hold > 10 s | ADR D21 |
| Persistent-breach escalation | 5 s | ADR D22 |
| Nominal endurance | 1500 s | `verifier_fixtures/range_model.json` |
| Battery reserve | 25 percentage points | `verifier_fixtures/range_model.json` |
| Sortie cap | 480 s | `verifier_fixtures/range_model.json` |
| Dispatch minimum SoC | 80% | `verifier_fixtures/range_model.json` |
| Maximum wind | 12 m/s attended, 6 m/s unattended | `verifier_fixtures/range_model.json`, ADR D23 |
| Unattended sortie rate | ≤ 2 per hour | ADR D23 |
| Control loop rate | 20 Hz | Companion orchestrator |
