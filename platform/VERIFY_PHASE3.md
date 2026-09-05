# Phase 3 verification instructions (self-contained — for a fresh agent)

Run these checks from the repository root on Windows. You are verifying the
just-built **ground** slice of a hackathon system: `ground/satellite` (change
detection), `ground/planner` (deterministic MissionVerifier + scripted/LLM planners +
CLI), `ground/ui` (mission panels + full offline mock flow), and the two Electron
shells (`ground/app/windows`, `ground/app/linux`). Fix small issues directly; report
anything structural. **Do NOT git commit** — the orchestrating session commits.

## Hard boundaries

- **`companion/**` is being modified RIGHT NOW by a concurrent workflow.** Do not
  edit, test, or "clean up" anything under `companion/`, and ignore its entries in
  `git status`.
- **Frozen files — never edit:** `ground/ui/src/contract/index.ts`, `shared/shared.ts`,
  `shared/shared.py`, anything under `sim/`, `site/`, `docs/`. Report gaps instead.
- Don't touch `components/`, `instruments/`, `tokens/`, `ui_kits/`, `guidelines/`,
  `templates/`, `slides/`, `design_handoff_ground_control/`.

## 1. Commands — all must pass (run each, paste results)

```powershell
Push-Location platform/ground/ui;          npm run typecheck; npm run lint; npm run build; Pop-Location
Push-Location platform/ground/planner;     npm test; Pop-Location
Push-Location platform/ground/satellite;   npm test; Pop-Location
Push-Location platform/ground/app/windows; npm run typecheck; Pop-Location
```

## 2. CLI smoke (proves Node-purity + the trust layer end-to-end)

From `ground/planner` (build first if `npm test` didn't): generate the scripted
FAILING plan against the stub site, verify it, and check the verdict:

```powershell
$env:EIS_SITE_FILE="site/site.stub.json"
node dist/cli.js plan --scripted --failing <anomaly.json> <site>   # see cli.js --help / README for exact args
node dist/cli.js verify <that-plan.json> <site>
```

PASS = valid `Verification` JSON, verdict **rejected**, with the `nfz` and
`altitude` checks `ok:false`. (Note: 'rejected' — not 'corrected' — is the expected
verdict for this plan against the stub geometry; the corrected path is covered by
unit tests.) Also verify the passing plan → verdict `pass`.

## 3. Static checks

- **No Electron leakage:** `grep -r "from 'electron'\|require('electron')"` over
  `ground/planner/src` and `ground/satellite/src` → zero hits. No `document`/`window`
  in their core logic (browser-only helpers must be clearly separated).
- **No hardcoded geometry:** grep `-35.36` and `149.16` in `ground/planner/src`,
  `ground/satellite/src`, `ground/ui/src` — excluding test files and generated
  `data/` — zero hits; all geometry must flow from the loaded site JSON.
- **Contract frozen:** `git -C <repo> status --porcelain` — no modifications under
  `ground/ui/src/contract/`, `shared/`, `sim/`. (`companion/**` WILL show modified —
  that's the other workflow; leave it.)
- **Shell sync:** `diff -r ground/app/windows/src ground/app/linux/src` — identical
  except the documented Linux-only power IPC (see PORT_AUDIT.md). The new
  `site:load` + `satellite:loadTiles` handlers must exist in BOTH trees, and both
  `electron-builder.yml` files must ship `site/` + `ground/satellite/data` in
  extraResources.

## 4. Mock-flow review (read, don't run)

Open `ground/ui/src/dataSource/MockDataProvider.ts` (+ the mission store/panels) and
confirm:
- It drives the full offline flow: anomaly → scripted failing plan → real
  `verifyMission` rejection (nfz + altitude) → passing plan → pass verification →
  approve sends `executePlan` carrying the effective plan → simulated flight
  (goto → orbit) → locked `tracking` observation at the staging point →
  `IncidentReport` 'escalate' → rtl.
- It calls the REAL `ScriptedPlanner` / `verifyMission` / report-writer from
  `ground/planner` — no duplicated logic.
- Exactly one `controlSource` at all times (executePlan releases manual/tracking;
  engageManual/engageTracking release planner; deny/abortPlan return to idle).
- LLM code (`ground/planner/src/llm.ts`): tool-calls-only (forced `tool_choice`,
  `strict: true`), no `temperature`/`top_p`, and NEVER constructed on the default
  path (gated on `EIS_PLANNER_MODE==='live'` + `ANTHROPIC_API_KEY`).

## 5. Known reported gaps — do NOT re-discover; skip unless trivially fixable

- `site/site.json` doesn't exist by design — everything falls back to
  `site/site.stub.json` (that's the intended cutover mechanism).
- Ack correlation is name-based FIFO (frozen contract) — a known limitation, leave it.
- `vite-env.d.ts` `ElectronBridge` typing for `loadSiteFile`/`loadSatelliteTiles`:
  the shells agent flagged it, the UI agent's typecheck ran clean afterward — verify
  it's actually declared; if missing, adding the optional method signatures IS in
  scope (UI file, not contract).
- Baked satellite tiles are generated from the stub site; regeneration is needed if
  site geometry changes (`ground/satellite` `npm run generate`). Not a defect.

## 6. Report format

Short markdown: (1) each command + PASS/FAIL, (2) issues found → fixed / reported,
(3) any frozen-file gaps discovered, (4) one-line verdict: SHIP or list of blockers.
