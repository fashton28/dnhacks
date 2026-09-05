# Session audit — Komati safety rails

Audit date: 2026-09-06. Initial baseline: clean commit `cd7e25c`
(`chore: preserve verified ground phase 3 baseline`). The audit was read-only for
companion and ground code. Teammate-owned topology/world content and all design
handoff reference directories were outside scope.

## Items marked “may exist” in the brief

| Brief item | Initial state | Evidence and disposition |
|---|---|---|
| `companion/control/planner_exec.py` | Present | `companion/src/eis_companion/control/planner_exec.py` exists with plan validation/clamping and guidance mapping; baseline came from Phase 2 commit `4ced313`. Preserve and extend rather than recreate. |
| `ground/planner/` | Present | TypeScript planner, schema validation, ScriptedPlanner, LLM adapter, deterministic verifier, report writer, CLI, and tests exist; verified in `cd7e25c`. Preserve and extend for new readiness/range/failure checks. |
| `ground/satellite/` | Present | Offline change detection, baked tile loader, generated placeholder tiles, and tests exist; verified in `cd7e25c`. Preserve. Baked assets need regeneration after the Komati stub geometry change. |
| `site/site.stub.json` | Present | Initially a CMAC/Canberra integration stub from commit `01faa5d`; replaced in this Phase 0 slice with the required Komati stub. `site/site.json` remains absent by design and teammate-owned. |
| Root `verifier_fixtures/` | Absent | No directory, V01–V25 cases, reference verifier, profiles, range model, or fixture site existed at audit time. This Phase 0 slice creates only `profiles.json` and `range_model.json`; case fixtures/reference verifier remain work for the verifier phase. |

Related new-run inputs were also absent at audit time: `ground/sdr/`,
`rf_events.json`, `rails/`, and `data/tiles/komati/`. Their absence is expected;
they are Phase 2/3 inputs, not evidence that earlier baseline work failed.

## Phase disposition at session start

| Phase | Existing work | Decision for this run |
|---|---|---|
| Phase 0 — audit/stabilise/decide | Earlier `01faa5d` supplied a first site contract, CMAC stub, and short ADR. Failure catalogue, session audit, Komati geometry, expanded decisions, and root verifier model files were absent. | Partially complete; retain file-selection/NFZ semantics and replace the obsolete stub/decisions with this expanded Phase 0 documentation. |
| Phase 1 — contract | Commit `99ca61d` contains the hackathon mission envelopes and planner tool/profile vocabulary in all three mirrors. At audit time the direct planner-run observation, capabilities, plan-command/ack, and heartbeat messages were absent. | Preserve the existing mission envelopes; add the missing planner-run messages and this run's vehicle, nav, battery, RF, sensor, fleet, readiness, and health fields across all mirrors. Default `vehicleId` is `eis-1`; nested mission payloads remain compatible. |
| Phase 2 — companion planner path | Commit `4ced313` contains planner execution, GUIDED GPS/fence support, staged vision, and tests. | Baseline slice is complete. Extend it with companion-owned navigation switching, battery/sortie/charge logic, sensing rails, and failure authority. |
| Phase 3 — ground planner/satellite/UI/shells | Commit `cd7e25c` contains and verifies the original ground retrofit. | Original ground slice is complete and SHIP. Extend it with this run's verifier checks, SDR/RF feeds, sensor/fleet UI, and shell lifecycle wiring. |
| Phase 4 — gate/demo | Only the earlier person-following e2e/scripts exist. The expanded Komati ISR flow and failure gauntlet do not. | Not complete; implement after Phases 1–3. |

## Verified baseline results

The Phase 3 verification requested before this task was completed and preserved
in `cd7e25c` with verdict **SHIP**:

- ground UI typecheck, lint, and production build passed;
- 43 ground planner tests and 21 satellite tests passed;
- Windows Electron shell typecheck passed;
- planner CLI failing-plan and passing-plan smokes returned the expected rejected
  (`nfz` plus `altitude`) and pass verdicts;
- Electron-purity, geometry, frozen-contract, shell-sync, packaged-resource, and
  offline mock-flow reviews passed;
- companion baseline pytest passed 193 tests.

The Docker daemon is available and `radarku/ardupilot-sitl:latest` is cached.
WSL contains only the `docker-desktop` utility distro, so Docker SITL is the
usable host path here; native WSL2 SITL is unavailable.

## Contract and model conventions handed to later phases

- Site selection remains `EIS_SITE_FILE`, production default `site/site.json`,
  explicit demo fallback `site/site.stub.json`.
- Site coordinates are WGS84 `[lat, lon]`; home altitude is AMSL; flight bands,
  NFZ ceilings, and clear altitude are AGL.
- `perimeter` is the surveyed boundary, `geofence` is the operational fence,
  `nfz_buffer_m` is 25 m, and clutter/readiness geometry comes from the site file.
- Staged RGB/thermal paths and `image_kind` declare fixture provenance. Existing
  PNGs are scripted placeholders and are not real imagery. Phase 2 must replace
  the interim aliased thermal paths with distinct scripted thermal variants.
- Profiles live at `verifier_fixtures/profiles.json`; `slow`, `standard`, and
  `fast` remain aliases for `follow`, `inspect`, and `survey` at 2, 4, and 6 m/s.
- Range constants live at `verifier_fixtures/range_model.json`: 1500 s nominal,
  25% reserve, wind factor 0.05 per m/s, maximum wind 12 m/s, anomaly proximity
  200 m, sortie cap 480 s, dispatch SoC 80%, cell delta 0.10 V, temperature 60 °C.
- Current planner and companion site loaders only return the legacy site fields;
  Phase 3/companion consumers must extend them before using geofence, buffer,
  clutter, clear altitude, or thermal staging fields.
- The stub's `clear_altitude_m=45` exceeds the baseline companion maximum altitude
  of 30 m. Missions needing the degraded-LiDAR clear band must be refused until
  the Phase 2 SITL configuration safely raises the effective limit within the
  site's 80 m band.

## Git publication decision

The configured GitHub repository `fashton28/dnhacks` began with unrelated remote
`main` history and no merge base with this monorepo. The verified baseline was
integrated through a separate worktree, preserving the remote README, ignore
rules, and subsequent remote changes. GitHub `main` was then advanced normally
to integration commit `2a10ebf`. This feature workspace keeps logical phase
commits and integrates them incrementally through the same worktree; no force
push or remote-history overwrite is permitted.
