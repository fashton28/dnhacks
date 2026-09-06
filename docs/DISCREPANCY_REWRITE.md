# Discrepancy rewrite

## 1. Purpose and method

### What prompted this

A careful rereading of the event rules identified a discrepancy. Commit
`70c24dbc6dc8a5ce1637e57e1f397166416d558f` ("init: Eye in the Sky baseline") is
the repository's root commit. It predates the event. Material derived from it
does not conform to the rules, so it was not allowed to stay as it was.

Everything that commit introduced at the repository root now lives under
`platform/` (git follows the rename). This document records what was done about
it.

Two kinds of action were taken:

1. Redundant design and prototype material introduced by that commit was
   deleted. That is 96 files.
2. Every implementation the application still needs was re-implemented from its
   contract by twelve area agents working in parallel.

Some baseline material was retained on purpose: the wire-contract declarations
(`platform/ground/ui/src/contract/index.ts`, `platform/shared/shared.ts`,
`platform/shared/shared.py`), build, packaging and configuration files,
documentation, and brand assets. Section 4 lists every retained file and why.

Git history is preserved. Nothing here removes or obscures provenance; the
point of the exercise is conformance plus an honest record.

### How the audit was done

- **Blob comparison.** The baseline tree (`git ls-tree -r 70c24dbc`) was
  compared blob-for-blob against the current tree. A file whose blob hash is
  unchanged is byte-identical to the baseline.
- **Rename-aware diff into `platform/`.** The baseline's root-level layout was
  mapped onto the current `platform/` layout, so a file that only moved is not
  mistaken for a new file.
- **Line attribution.** `git blame -w -M -C` was run over every current file
  against the baseline commit. `-w` ignores whitespace changes and `-M -C`
  follow moved and copied lines, so a line still counts as baseline even if it
  was reindented or moved between files. The measure therefore *over*-reports
  baseline survival; it is deliberately conservative.
- **Two heuristic collisions were corrected by hand.** The rename matcher paired
  the removed `ui_kits/ground-control/index.html` with the retained
  `ground/ui/index.html` (same basename), and the removed
  `uploads/claude-design-prd.md` with `design_handoff_ground_control/PRD.md`
  (byte-identical blobs — the upload was a duplicate copy of the PRD). Both
  removed files are counted as deleted below, and the two retained files are
  counted once each.
- **Two files could not be matched at all.** `99-eyeinthesky-input.rules` and
  `eye-in-the-sky.desktop` were renamed to
  `99-dnhacks-platform-input.rules` and `drone-safety-platform.desktop` on
  `main` before this branch existed. Their current line counts are listed in
  section 4; their 33 baseline-attributed lines (23 + 10) are excluded from the
  totals in section 2, in both the before and the after column.

### Classification scheme

Every baseline file was placed in exactly one of three classes.

| Class | Meaning | Action |
|---|---|---|
| Required by the application or a supported mode | Imported, invoked or served by running code, or exercised by a test | Re-implemented from its contract |
| Required by builds, packaging, tests or deployment | Consumed by a build, packaging, CI or deployment step; its content is necessary constants | Retained |
| Redundant prototype or design material | No import, link, alias or copy step anywhere in the tree refers to it | Deleted |

"Re-implemented from its contract" means the replacement was derived from the
observable surface — exported names, component props, hook return shapes, wire
message formats, persisted file formats, config keys and defaults, command
names, CLI flags, and the log and audit formats that tests or documentation
pin — and then written with a different decomposition, different state handling
or different algorithms where the contract allows it. Renaming, reformatting or
reordering was not accepted as a rewrite. Standard syntax, interface and type
declarations, import lists and necessary constants (safety limits, port numbers,
MAVLink ids) may legitimately remain identical; each such case is listed as an
exception in section 5.

## 2. Inventory summary

The baseline commit contains 251 files. Counts below are over those files only.

| Measure | Before this work | After this work |
|---|---:|---:|
| Baseline files with a surviving counterpart | 251 | 155 |
| Byte-identical to the baseline | 107 | 9 |
| Lines still attributed to the baseline commit (all files) | 44041 | 22529 |
| Lines still attributed to the baseline commit (rewrite targets only) | 16990 | 7490 |

Attribution uses `git blame -w -M -C` against `70c24dbc`. Whitespace-only
changes and moved lines still count as baseline, so these figures are an
upper bound on what survives.

The row counts reconcile: 96 removed + 93 rewrite
targets + 62 retained = 251, the size of the baseline
tree. The line totals exclude the 33 baseline-attributed lines of the two
files renamed before this branch, in both columns.

The 9 files still byte-identical to the baseline are all in the
retained class, and are the two product briefs, two binary icons and five
build-configuration files:

- `platform/claude-code-prd(1).md`
- `platform/design_handoff_ground_control/PRD.md`
- `platform/ground/app/linux/build-resources/icon.png`
- `platform/ground/app/linux/tsconfig.json`
- `platform/ground/app/windows/build-resources/icon.ico`
- `platform/ground/app/windows/tsconfig.json`
- `platform/ground/ui/postcss.config.js`
- `platform/ground/ui/tailwind.config.ts`
- `platform/ground/ui/tsconfig.node.json`

No rewrite target is byte-identical to the baseline.

## 3. Removed artifacts

96 files, 12353 lines. All of it is design-system handoff material:
prototype components, design tokens, style guideline cards, slide templates, a
bundled design-system runtime, and the prompt and skill files that produced them.

The removal commit's own summary reads `96 files changed, 12021 deletions(-)`.
The 332-line difference is the two `.thumbnail` files (28 and 304 lines), which
git treats as binary in a diff and so does not count as deleted lines.

Dependency evidence: `git grep` across every tracked `.ts`, `.tsx`, `.js`,
`.json`, `.yml`, `.py`, `.html` and `.css` file, the `Makefile`, the `justfile`,
the CI workflow and both `electron-builder.yml` files found no import, link,
alias or copy step that referenced any of them. The only references were prose
in documentation, which this work updates. `platform/assets/logo-mark.svg` is
kept for the opposite reason:
`platform/ground/app/linux/build-resources/make-icons.sh` reads it.

`platform/ground/ui/src/components/` is the production component library and is
unrelated to the removed `components/` prototype directory.

| Group | Files | Lines |
|---|---:|---:|
| `components` | 50 | 1785 |
| `design_handoff_ground_control` | 1 | 168 |
| `guidelines` | 11 | 258 |
| `slides` | 4 | 139 |
| `templates` | 4 | 1884 |
| `tokens` | 5 | 260 |
| `ui_kits` | 12 | 1462 |
| `uploads` | 1 | 270 |
| `(root files)` | 8 | 6127 |
| **Total** | **96** | **12353** |

Every removed path, with its line count at the point of removal:

| path (relative to `platform/`) | lines |
|---|---:|
| `.thumbnail` | 28 |
| `DESIGN_SYSTEM.md` | 149 |
| `SKILL.md` | 45 |
| `_adherence.oxlintrc.json` | 534 |
| `_ds_bundle.js` | 5272 |
| `_ds_manifest.json` | 1 |
| `components/core/Badge.d.ts` | 12 |
| `components/core/Badge.jsx` | 38 |
| `components/core/Badge.prompt.md` | 9 |
| `components/core/Button.d.ts` | 27 |
| `components/core/Button.jsx` | 113 |
| `components/core/Button.prompt.md` | 10 |
| `components/core/GaugeReadout.d.ts` | 25 |
| `components/core/GaugeReadout.jsx` | 82 |
| `components/core/GaugeReadout.prompt.md` | 9 |
| `components/core/HoldButton.d.ts` | 25 |
| `components/core/HoldButton.jsx` | 118 |
| `components/core/HoldButton.prompt.md` | 12 |
| `components/core/IconButton.d.ts` | 15 |
| `components/core/IconButton.jsx` | 53 |
| `components/core/IconButton.prompt.md` | 9 |
| `components/core/Modal.d.ts` | 22 |
| `components/core/Modal.jsx` | 97 |
| `components/core/Modal.prompt.md` | 10 |
| `components/core/Panel.d.ts` | 28 |
| `components/core/Panel.jsx` | 85 |
| `components/core/Panel.prompt.md` | 10 |
| `components/core/Slider.d.ts` | 20 |
| `components/core/Slider.jsx` | 78 |
| `components/core/Slider.prompt.md` | 9 |
| `components/core/StatusPill.d.ts` | 28 |
| `components/core/StatusPill.jsx` | 73 |
| `components/core/StatusPill.prompt.md` | 10 |
| `components/core/Tabs.d.ts` | 18 |
| `components/core/Tabs.jsx` | 56 |
| `components/core/Tabs.prompt.md` | 10 |
| `components/core/Toast.d.ts` | 13 |
| `components/core/Toast.jsx` | 55 |
| `components/core/Toast.prompt.md` | 8 |
| `components/core/Toggle.d.ts` | 14 |
| `components/core/Toggle.jsx` | 49 |
| `components/core/Toggle.prompt.md` | 8 |
| `components/core/core.card.html` | 108 |
| `components/instruments/AttitudeIndicator.d.ts` | 20 |
| `components/instruments/AttitudeIndicator.jsx` | 102 |
| `components/instruments/AttitudeIndicator.prompt.md` | 7 |
| `components/instruments/BatteryGauge.d.ts` | 20 |
| `components/instruments/BatteryGauge.jsx` | 53 |
| `components/instruments/BatteryGauge.prompt.md` | 8 |
| `components/instruments/Compass.d.ts` | 16 |
| `components/instruments/Compass.jsx` | 75 |
| `components/instruments/Compass.prompt.md` | 7 |
| `components/instruments/SignalGauge.d.ts` | 16 |
| `components/instruments/SignalGauge.jsx` | 41 |
| `components/instruments/SignalGauge.prompt.md` | 8 |
| `components/instruments/instruments.card.html` | 46 |
| `design_handoff_ground_control/README.md` | 168 |
| `guidelines/brand-logo.card.html` | 30 |
| `guidelines/color-accent.card.html` | 19 |
| `guidelines/color-neutral.card.html` | 22 |
| `guidelines/color-status.card.html` | 43 |
| `guidelines/color-surfaces.card.html` | 32 |
| `guidelines/elevation.card.html` | 18 |
| `guidelines/radii.card.html` | 19 |
| `guidelines/spacing-scale.card.html` | 19 |
| `guidelines/type-body.card.html` | 17 |
| `guidelines/type-display.card.html` | 16 |
| `guidelines/type-mono.card.html` | 23 |
| `prompt.txt` | 70 |
| `slides/content.slide.html` | 48 |
| `slides/metrics.slide.html` | 31 |
| `slides/section.slide.html` | 27 |
| `slides/title.slide.html` | 33 |
| `styles.css` | 28 |
| `templates/gcs-deck/.thumbnail` | 304 |
| `templates/gcs-deck/GcsDeck.dc.html` | 52 |
| `templates/gcs-deck/ds-base.js` | 15 |
| `templates/gcs-deck/support.js` | 1513 |
| `tokens/colors.css` | 101 |
| `tokens/effects.css` | 45 |
| `tokens/fonts.css` | 8 |
| `tokens/spacing.css` | 41 |
| `tokens/typography.css` | 65 |
| `ui_kits/ground-control/ControlsPanel.jsx` | 78 |
| `ui_kits/ground-control/GroundControl.jsx` | 141 |
| `ui_kits/ground-control/LogConsole.jsx` | 54 |
| `ui_kits/ground-control/ManualControl.jsx` | 160 |
| `ui_kits/ground-control/MapPanel.jsx` | 154 |
| `ui_kits/ground-control/Modals.jsx` | 138 |
| `ui_kits/ground-control/README.md` | 45 |
| `ui_kits/ground-control/StatusBar.jsx` | 87 |
| `ui_kits/ground-control/TelemetryPanel.jsx` | 77 |
| `ui_kits/ground-control/VideoPanel.jsx` | 206 |
| `ui_kits/ground-control/index.html` | 44 |
| `ui_kits/ground-control/mock.js` | 278 |
| `uploads/claude-design-prd.md` | 270 |

## 4. Classification of every surviving baseline-derived file

Line counts are total lines in the file; the percentage is the share of those
lines still attributed to the baseline commit.

### 4.1 Rewrite targets

93 files, required by the application, its tests or a supported
workflow. Each was re-implemented from its contract.

| current path | lines before | baseline % before | lines after | baseline % after | status after |
|---|---:|---:|---:|---:|---|
| `platform/companion/src/eis_companion/__init__.py` | 33 | 97.0 | 58 | 53.4 | mostly-baseline |
| `platform/companion/src/eis_companion/api/__init__.py` | 22 | 95.5 | 49 | 40.8 | partly-baseline |
| `platform/companion/src/eis_companion/api/server.py` | 623 | 47.0 | 837 | 20.4 | partly-baseline |
| `platform/companion/src/eis_companion/app.py` | 4049 | 22.0 | 4747 | 12.3 | partly-baseline |
| `platform/companion/src/eis_companion/config.py` | 1191 | 46.4 | 1159 | 21.1 | partly-baseline |
| `platform/companion/src/eis_companion/control/__init__.py` | 97 | 46.4 | 108 | 35.2 | partly-baseline |
| `platform/companion/src/eis_companion/control/distance.py` | 158 | 86.7 | 177 | 36.2 | partly-baseline |
| `platform/companion/src/eis_companion/control/guidance.py` | 259 | 87.3 | 229 | 31.9 | partly-baseline |
| `platform/companion/src/eis_companion/control/manual.py` | 282 | 86.2 | 300 | 24.0 | partly-baseline |
| `platform/companion/src/eis_companion/control/pid.py` | 121 | 82.6 | 190 | 17.4 | partly-baseline |
| `platform/companion/src/eis_companion/control/tracker.py` | 479 | 89.1 | 541 | 29.4 | partly-baseline |
| `platform/companion/src/eis_companion/mavlink/__init__.py` | 58 | 89.7 | 77 | 29.9 | partly-baseline |
| `platform/companion/src/eis_companion/mavlink/safety.py` | 500 | 83.0 | 776 | 33.1 | partly-baseline |
| `platform/companion/src/eis_companion/mavlink/vehicle.py` | 1824 | 37.0 | 2037 | 16.3 | partly-baseline |
| `platform/companion/src/eis_companion/stream/__init__.py` | 16 | 93.8 | 42 | 33.3 | partly-baseline |
| `platform/companion/src/eis_companion/stream/video.py` | 248 | 99.6 | 334 | 46.7 | partly-baseline |
| `platform/companion/src/eis_companion/types.py` | 211 | 82.9 | 244 | 68.4 | mostly-baseline |
| `platform/companion/src/eis_companion/vision/__init__.py` | 23 | 82.6 | 50 | 30.0 | partly-baseline |
| `platform/companion/src/eis_companion/vision/capture.py` | 310 | 99.7 | 516 | 21.9 | partly-baseline |
| `platform/companion/src/eis_companion/vision/detector.py` | 300 | 84.0 | 395 | 30.4 | partly-baseline |
| `platform/companion/src/eis_companion/vision/export_tensorrt.py` | 182 | 98.4 | 227 | 42.7 | partly-baseline |
| `platform/companion/src/eis_companion/vision/sim_source.py` | 284 | 99.3 | 386 | 26.2 | partly-baseline |
| `platform/companion/tests/test_guidance.py` | 197 | 99.5 | 167 | 47.3 | partly-baseline |
| `platform/companion/tests/test_manual.py` | 231 | 100.0 | 186 | 38.7 | partly-baseline |
| `platform/companion/tests/test_tracking.py` | 227 | 99.1 | 182 | 29.1 | partly-baseline |
| `platform/ground/app/linux/build-resources/make-icons.sh` | 31 | 96.8 | 46 | 19.6 | partly-baseline |
| `platform/ground/app/linux/src/ipc.ts` | 178 | 64.6 | 239 | 10.9 | partly-baseline |
| `platform/ground/app/linux/src/main.ts` | 233 | 82.0 | 229 | 25.8 | partly-baseline |
| `platform/ground/app/linux/src/preload.ts` | 178 | 78.1 | 184 | 25.0 | partly-baseline |
| `platform/ground/app/linux/src/recorder.ts` | 172 | 100.0 | 372 | 20.7 | partly-baseline |
| `platform/ground/app/linux/src/settingsStore.ts` | 63 | 100.0 | 221 | 12.2 | partly-baseline |
| `platform/ground/app/windows/build-resources/make_icon.py` | 38 | 97.4 | 110 | 2.7 | partly-baseline |
| `platform/ground/app/windows/src/ipc.ts` | 153 | 58.8 | 191 | 11.5 | partly-baseline |
| `platform/ground/app/windows/src/main.ts` | 233 | 82.0 | 226 | 26.1 | partly-baseline |
| `platform/ground/app/windows/src/preload.ts` | 163 | 76.1 | 165 | 27.9 | partly-baseline |
| `platform/ground/app/windows/src/recorder.ts` | 172 | 100.0 | 372 | 20.7 | partly-baseline |
| `platform/ground/app/windows/src/settingsStore.ts` | 63 | 100.0 | 221 | 12.2 | partly-baseline |
| `platform/ground/ui/src/App.tsx` | 1119 | 35.8 | 1419 | 15.1 | partly-baseline |
| `platform/ground/ui/src/components/Badge.tsx` | 49 | 100.0 | 24 | 58.3 | mostly-baseline |
| `platform/ground/ui/src/components/Button.tsx` | 141 | 99.3 | 75 | 38.7 | partly-baseline |
| `platform/ground/ui/src/components/GaugeReadout.tsx` | 103 | 100.0 | 53 | 56.6 | mostly-baseline |
| `platform/ground/ui/src/components/HoldButton.tsx` | 133 | 99.2 | 236 | 17.8 | partly-baseline |
| `platform/ground/ui/src/components/IconButton.tsx` | 72 | 100.0 | 49 | 57.1 | mostly-baseline |
| `platform/ground/ui/src/components/Modal.tsx` | 150 | 100.0 | 86 | 52.3 | mostly-baseline |
| `platform/ground/ui/src/components/Panel.tsx` | 101 | 100.0 | 61 | 52.5 | mostly-baseline |
| `platform/ground/ui/src/components/Slider.tsx` | 95 | 100.0 | 95 | 48.4 | partly-baseline |
| `platform/ground/ui/src/components/StatusPill.tsx` | 87 | 100.0 | 52 | 61.5 | mostly-baseline |
| `platform/ground/ui/src/components/Tabs.tsx` | 71 | 100.0 | 46 | 52.2 | mostly-baseline |
| `platform/ground/ui/src/components/Toast.tsx` | 99 | 100.0 | 42 | 69.0 | mostly-baseline |
| `platform/ground/ui/src/components/Toggle.tsx` | 71 | 100.0 | 59 | 50.8 | mostly-baseline |
| `platform/ground/ui/src/components/index.ts` | 12 | 100.0 | 41 | 0.0 | rewritten |
| `platform/ground/ui/src/dataSource/LiveDataProvider.ts` | 501 | 58.1 | 563 | 17.2 | partly-baseline |
| `platform/ground/ui/src/dataSource/MockDataProvider.ts` | 2679 | 20.1 | 3042 | 7.4 | partly-baseline |
| `platform/ground/ui/src/dataSource/index.ts` | 26 | 3.8 | 36 | 2.8 | partly-baseline |
| `platform/ground/ui/src/index.css` | 232 | 97.0 | 615 | 33.8 | partly-baseline |
| `platform/ground/ui/src/instruments/AttitudeIndicator.tsx` | 114 | 100.0 | 150 | 28.7 | partly-baseline |
| `platform/ground/ui/src/instruments/BatteryGauge.tsx` | 71 | 100.0 | 81 | 35.8 | partly-baseline |
| `platform/ground/ui/src/instruments/Compass.tsx` | 88 | 100.0 | 120 | 25.0 | partly-baseline |
| `platform/ground/ui/src/instruments/SignalGauge.tsx` | 55 | 100.0 | 66 | 30.3 | partly-baseline |
| `platform/ground/ui/src/instruments/index.ts` | 4 | 100.0 | 16 | 0.0 | rewritten |
| `platform/ground/ui/src/main.tsx` | 18 | 72.2 | 32 | 31.2 | partly-baseline |
| `platform/ground/ui/src/panels/ControlsPanel.tsx` | 346 | 89.0 | 303 | 40.6 | partly-baseline |
| `platform/ground/ui/src/panels/LogConsole.tsx` | 180 | 100.0 | 168 | 53.0 | mostly-baseline |
| `platform/ground/ui/src/panels/ManualControl.tsx` | 446 | 100.0 | 412 | 24.5 | partly-baseline |
| `platform/ground/ui/src/panels/MapPanel.tsx` | 344 | 100.0 | 376 | 42.3 | partly-baseline |
| `platform/ground/ui/src/panels/StatusBar.tsx` | 469 | 60.3 | 467 | 33.0 | partly-baseline |
| `platform/ground/ui/src/panels/TelemetryPanel.tsx` | 244 | 100.0 | 181 | 40.9 | partly-baseline |
| `platform/ground/ui/src/panels/VideoPanel.tsx` | 522 | 97.5 | 574 | 35.5 | partly-baseline |
| `platform/ground/ui/src/panels/index.ts` | 18 | 44.4 | 77 | 0.0 | rewritten |
| `platform/ground/ui/src/store/DataSourceContext.tsx` | 35 | 74.3 | 36 | 27.8 | partly-baseline |
| `platform/ground/ui/src/store/index.ts` | 4 | 75.0 | 41 | 0.0 | rewritten |
| `platform/ground/ui/src/store/recorder.ts` | 102 | 99.0 | 156 | 34.6 | partly-baseline |
| `platform/ground/ui/src/store/settings.ts` | 173 | 99.4 | 342 | 28.4 | partly-baseline |
| `platform/ground/ui/src/theme/tokens.ts` | 35 | 100.0 | 71 | 29.6 | partly-baseline |
| `platform/ground/ui/src/views/ChecklistModal.tsx` | 91 | 100.0 | 124 | 38.7 | partly-baseline |
| `platform/ground/ui/src/views/FailsafeModal.tsx` | 271 | 100.0 | 259 | 40.2 | partly-baseline |
| `platform/ground/ui/src/views/LogBrowserModal.tsx` | 408 | 100.0 | 487 | 27.1 | partly-baseline |
| `platform/ground/ui/src/views/ManualBanner.tsx` | 53 | 100.0 | 35 | 54.3 | mostly-baseline |
| `platform/ground/ui/src/views/PidTuningModal.tsx` | 178 | 100.0 | 191 | 34.6 | partly-baseline |
| `platform/ground/ui/src/views/SettingsModal.tsx` | 252 | 100.0 | 287 | 46.3 | partly-baseline |
| `platform/ground/ui/src/views/TakeoffModal.tsx` | 88 | 100.0 | 105 | 45.7 | partly-baseline |
| `platform/ground/ui/src/views/TrackingBanner.tsx` | 55 | 100.0 | 37 | 56.8 | mostly-baseline |
| `platform/ground/ui/src/views/index.ts` | 11 | 81.8 | 29 | 0.0 | rewritten |
| `platform/scripts/run-sim-e2e.ps1` | 243 | 86.8 | 383 | 24.5 | partly-baseline |
| `platform/scripts/run-sim-e2e.sh` | 187 | 99.5 | 363 | 18.2 | partly-baseline |
| `platform/scripts/setup-ground-linux.sh` | 131 | 53.4 | 259 | 15.8 | partly-baseline |
| `platform/scripts/setup-ground.ps1` | 207 | 55.1 | 305 | 22.3 | partly-baseline |
| `platform/scripts/setup-jetson.sh` | 188 | 98.4 | 293 | 28.7 | partly-baseline |
| `platform/scripts/setup-sim.sh` | 236 | 98.7 | 355 | 29.9 | partly-baseline |
| `platform/sim/e2e_test.py` | 337 | 99.7 | 627 | 17.2 | partly-baseline |
| `platform/sim/headless_client.py` | 416 | 99.5 | 830 | 25.1 | partly-baseline |
| `platform/sim/manual_test.py` | 407 | 99.8 | 694 | 20.7 | partly-baseline |
| `platform/sim/run_sitl.sh` | 165 | 98.2 | 338 | 26.3 | partly-baseline |

`status after` is derived from the percentage: `rewritten` = no line traces to
the baseline, `partly-baseline` = under 50 %, `mostly-baseline` = 50 % or more.
Files that stay above 50 % are small components whose remaining lines are prop
declarations, destructuring defaults and closing tags; section 5 lists them per
file.

### 4.2 Retained baseline material

62 files. Reason codes: **C** contract, **B** build/config,
**A** asset, **D** documentation.

- **C** — Wire-contract declaration. Authoritative copy plus its two mirrors; the three must stay semantically identical, so the declarations are retained as declarations.
- **B** — Build, packaging, configuration or deployment file. Its content is necessary constants: versions, ports, paths, limits, target names.
- **A** — Brand or icon asset. `assets/logo-mark.svg` is read by the Linux icon generator.
- **D** — Documentation, not implementation. Links that pointed at removed material were updated.

| current path | lines | baseline % | reason |
|---|---:|---:|:---:|
| `.github/workflows/ci.yml` | 146 | 92.5 | B |
| `.gitignore` | 42 | 38.1 | B |
| `platform/.env.example` | 43 | 97.7 | B |
| `platform/CLAUDE.md` | 124 | 92.7 | D |
| `platform/LINUX_PRD.md` | 147 | 97.3 | D |
| `platform/Makefile` | 178 | 79.8 | B |
| `platform/PORT_AUDIT.md` | 153 | 58.2 | D |
| `platform/README.md` | 381 | 50.4 | D |
| `platform/SESSION_SUMMARY.md` | 174 | 18.4 | D |
| `platform/assets/logo-mark.svg` | 21 | 95.2 | A |
| `platform/assets/logo-wordmark.svg` | 21 | 90.5 | A |
| `platform/claude-code-prd(1).md` | 249 | 100.0 | D |
| `platform/companion/.dockerignore` | 50 | 98.0 | B |
| `platform/companion/Dockerfile` | 88 | 96.6 | B |
| `platform/companion/README.md` | 221 | 96.4 | D |
| `platform/companion/config/default.yaml` | 107 | 71.0 | B |
| `platform/companion/config/sitl.yaml` | 120 | 63.3 | B |
| `platform/companion/pyproject.toml` | 82 | 92.7 | B |
| `platform/companion/requirements.txt` | 30 | 96.7 | B |
| `platform/companion/src/eis_companion/stream/mediamtx.yml` | 52 | 98.1 | B |
| `platform/companion/systemd/eis-companion.service` | 58 | 94.8 | B |
| `platform/design_handoff_ground_control/PRD.md` | 270 | 100.0 | D |
| `platform/docs/BUILD_SUMMARY.md` | 190 | 97.4 | D |
| `platform/docs/assembly.md` | 528 | 99.8 | D |
| `platform/docs/flashing.md` | 457 | 96.9 | D |
| `platform/docs/hardware.md` | 268 | 99.6 | D |
| `platform/docs/network.md` | 301 | 96.7 | D |
| `platform/docs/operator-manual.md` | 735 | 99.7 | D |
| `platform/docs/runbook.md` | 559 | 84.3 | D |
| `platform/ground/app/linux/README.md` | 76 | 96.1 | D |
| `platform/ground/app/linux/build-resources/99-dnhacks-platform-input.rules` | 25 | 92.0 | B |
| `platform/ground/app/linux/build-resources/drone-safety-platform.desktop` | 15 | 66.7 | B |
| `platform/ground/app/linux/build-resources/icon.png` | 36 | 100.0 | B |
| `platform/ground/app/linux/build-resources/postinstall.sh` | 25 | 84.0 | B |
| `platform/ground/app/linux/build-resources/postremove.sh` | 11 | 54.5 | B |
| `platform/ground/app/linux/electron-builder.yml` | 96 | 69.8 | B |
| `platform/ground/app/linux/package.json` | 32 | 93.8 | B |
| `platform/ground/app/linux/tsconfig.json` | 18 | 100.0 | B |
| `platform/ground/app/windows/README.md` | 150 | 98.7 | D |
| `platform/ground/app/windows/build-resources/icon.ico` | 113 | 100.0 | B |
| `platform/ground/app/windows/electron-builder.yml` | 70 | 62.9 | B |
| `platform/ground/app/windows/package-lock.json` | 3700 | 99.9 | B |
| `platform/ground/app/windows/package.json` | 32 | 93.8 | B |
| `platform/ground/app/windows/tsconfig.json` | 18 | 100.0 | B |
| `platform/ground/ui/README.md` | 204 | 90.2 | D |
| `platform/ground/ui/index.html` | 12 | 91.7 | B |
| `platform/ground/ui/package-lock.json` | 4447 | 95.7 | B |
| `platform/ground/ui/package.json` | 42 | 88.1 | B |
| `platform/ground/ui/postcss.config.js` | 6 | 100.0 | B |
| `platform/ground/ui/src/assets/logo-mark.svg` | 21 | 95.2 | A |
| `platform/ground/ui/src/assets/logo-wordmark.svg` | 21 | 90.5 | A |
| `platform/ground/ui/src/contract/index.ts` | 805 | 20.0 | C |
| `platform/ground/ui/src/vite-env.d.ts` | 112 | 41.1 | B |
| `platform/ground/ui/tailwind.config.ts` | 66 | 100.0 | B |
| `platform/ground/ui/tsconfig.json` | 32 | 75.0 | B |
| `platform/ground/ui/tsconfig.node.json` | 12 | 100.0 | B |
| `platform/ground/ui/vite.config.ts` | 114 | 16.7 | B |
| `platform/justfile` | 133 | 99.2 | B |
| `platform/shared/shared.py` | 922 | 21.1 | C |
| `platform/shared/shared.ts` | 630 | 28.6 | C |
| `platform/sim/README.md` | 179 | 99.4 | D |
| `platform/sim/params/eis-sitl.parm` | 136 | 75.0 | B |

`99-dnhacks-platform-input.rules` and `drone-safety-platform.desktop` are the
two files renamed on `main` before this branch; their counts are measured
against the renamed files. `icon.png`, `icon.ico` and the `.svg` assets are
binary or near-binary, so their line counts are an artefact of how `git blame`
splits their bytes and carry no meaning beyond "unchanged".

## 5. Rewritten files, preserved contracts and identical-line exceptions

One subsection per area, as reported by the agent that did the work. `Preserved`
lists the behaviour the replacement had to keep. `Identical-line exceptions`
lists lines that legitimately remain identical to the baseline.

### Area `ui-views-stores`

**`platform/ground/ui/src/store/settings.ts`** — rewritten. Persistence is now an injectable adapter (bridgePersistence over window.eis.settings, storagePersistence over a Storage-like, memoryPersistence) chosen by detectPersistence(); every inbound blob (stored file, partial patch, updater result) goes through one normaliseSettings() funnel that fills missing keys from a base, coerces types (numeric strings, 'true'/'false'), rejects unknown enum values, drops unknown keys and pins theme='dark' — this is the migration path for older settings files. Store keeps a write counter so a bridge read that resolves after a local edit is discarded instead of clobbering it; sync reads (localStorage) are applied before the first get(); listeners are notified over a copy so mid-notify unsubscribes are safe; ready() exposes hydration. New additive exports: createSettingsStore, normaliseSettings, SETTINGS_STORAGE_KEY, SAFETY_ACTIONS/UNIT_SYSTEMS/MAP_TILE_SETS/PID_AXES/PID_GAIN_KEYS, persistence adapters, UnitSystem/MapTileSet/PidAxis/PidGainKey types, SettingsStore.ready().

- *Preserved:* Persisted key 'eis.settings' inside the Electron settings.json map (settingsStore.ts get/set) and localStorage; Persisted value shape: {connection{host,controlPort,videoUrl,sitl}, failsafe{...}, pid{yaw,altitude,forward{kp,ki,kd}}, units, mapTiles, theme:'dark'} — round-trips with the previous implementation in both directions; DEFAULT_SETTINGS values unchanged; SettingsStore.get/set(partial|updater)/subscribe/reset semantics: partial deep-merges per section, updater replaces, reset persists defaults; useSettings() via useSyncExternalStore; All previously exported names and types (SafetyAction, FailsafeConfig, PidAxisGains, PidGains, AppSettings, SettingsStore, DEFAULT_SETTINGS, settingsStore, useSettings)
- *Identical-line exceptions:* Header comment banner lines 1-3/23 (file-header convention); import lines 24-25; Type/interface declarations: SafetyAction, FailsafeConfig, PidAxisGains, PidGains, AppSettings fields, SettingsStore method signatures; DEFAULT_SETTINGS constant body (contract defaults, lines 67-89); theme: 'dark' pin line; export const settingsStore = createSettingsStore(); useSettings docblock + signature (3-line hook is the canonical useSyncExternalStore form)

**`platform/ground/ui/src/store/recorder.ts`** — rewritten. Recorder rebuilt as archive-array + live-session + seal() decomposition with an injectable clock and id factory (createRecorder(options), defaultRecordingId keeps the 'rec-<base36 start>-' prefix). Elapsed time is monotonic (max of prior, frame.ts-start, 0); stop() seals with wall-clock; list() reverses before a stable sort so equal start stamps come out newest-recorded first; meta is copied not aliased. New toRecordedFrame() adapter folds either recorder frames or the raw telemetry/tracking wire messages the shell writes to NDJSON (and the App appends) into RecordedFrame, returning null for statusText/malformed records — this is what lets the log browser read Electron sessions.

- *Preserved:* Recorder interface: isRecording, currentId, start(meta)->id, stop()->RecordingMeta|null, append(frame), list() newest-first, load(id)->session|null, clear(); RecordedFrame {ts, telemetry?, tracking?}, RecordingMeta {id,startedAt,durationMs,size}, RecordingSession {meta, frames}; start while recording seals the previous session and keeps it listed; append while idle is a no-op; Singleton export `recorder`; id prefix 'rec-' + base36 timestamp
- *Identical-line exceptions:* Header banner lines 1,3,15; import type line 16; Interface declarations RecordedFrame/RecordingMeta/RecordingSession/Recorder (lines 18-44); Object-literal method headers start(meta = {})/append(frame)/list()/load(id)/clear() and `export const recorder: Recorder = createRecorder();`

**`platform/ground/ui/src/store/DataSourceContext.tsx`** — rewritten. Context now defaults to null and the hook (not the context) falls back to the app singleton, so provided vs defaulted is distinguishable; provider built with React.createElement; displayName set; DataSourceProviderProps exported. Teammate lines (MissionDataSource typing, cd7e25c6) kept in behaviour.

- *Preserved:* DataSourceProvider({children, source?}) and useDataSource(): MissionDataSource; useDataSource() outside a provider returns the dataSource singleton
- *Identical-line exceptions:* Header banner lines 1-3,14; import lines 15,17; Prop declaration lines `children: React.ReactNode;` / `source?: MissionDataSource;`; useDataSource signature line

**`platform/ground/ui/src/store/index.ts`** — rewritten. Barrel converted from `export *` to explicit named value/type exports for settings, DataSourceContext and recorder (including the new additive names); `export * from './mission'` (teammate module) retained.

- *Preserved:* Every name previously reachable via '@/store' is still exported
- *Identical-line exceptions:* export * from './mission'

**`platform/ground/ui/src/main.tsx`** — rewritten. Entry split into selectConsole() (isHubMode() ? ArgusApp : App) and mount(), which throws a clear error if #root is missing instead of a non-null assertion; StrictMode wrapper kept.

- *Preserved:* isHubMode() -> <ArgusApp/> else <App/> switch (teammate commit 905e400d); Font/CSS side-effect imports and React.StrictMode root
- *Identical-line exceptions:* Import list lines 1-10 (side-effect CSS/font imports and module imports are the contract)

**`platform/ground/ui/src/views/index.ts`** — rewritten. Explicit named exports (values + types) for the eight rewritten views incl. the PidTuningModal-as-PidModal alias and the new pure helpers; `export *` retained for PlannerBanner and UnattendedModal (teammate modules).

- *Preserved:* All component and props-type names, PidModal alias
- *Identical-line exceptions:* export * from './PlannerBanner'; export * from './UnattendedModal'

**`platform/ground/ui/src/views/ChecklistModal.tsx`** — rewritten. Confirmed items held as a ReadonlySet<number> (new Set per toggle) instead of a boolean[]; rows are role=checkbox buttons with aria-checked; a progress Badge shows n/6; PREFLIGHT_ITEMS exported; onComplete guarded by completeness.

- *Preserved:* Props {open,onClose,onComplete}; six checklist strings; confirm disabled until all checked; reset on open; Modal tone/width/title/subtitle/footer labels
- *Identical-line exceptions:* Props interface; The six checklist item strings (user-facing contract); Modal prop lines (tone/width/icon/title/subtitle) and footer button labels; Design-token style fragments (colour/border tokens)

**`platform/ground/ui/src/views/TakeoffModal.tsx`** — rewritten. Uses the shared Slider component (with ticks) and a ghost Button for cancel; altitude always passes clampTakeoffAltitude() (exported, with TAKEOFF_ALT_RANGE {2,30,1}); quick-pick chips (3/4/6/10 m) with aria-pressed; HoldButton confirm unchanged.

- *Preserved:* Props {open,onClose,onConfirm(alt),defaultAlt=4}; range 2..30 step 1; re-seed on open; 'Takeoff · N m' hold-to-confirm; caution tone
- *Identical-line exceptions:* Props interface and destructured signature; Modal prop lines and HoldButton prop lines (variant/hint/icon/onConfirm)

**`platform/ground/ui/src/views/TrackingBanner.tsx`** — rewritten. Composed from shared StatusPill (pulsing caution), two mono Badges for standoff/max speed and a danger Button; role=status/aria-live container; static SHELL style constant.

- *Preserved:* Props {standoff,maxSpeed,onDisengage}; text 'Autonomous tracking active', 'standoff X.X m', 'max X.X m/s', plain-click Disengage
- *Identical-line exceptions:* Imports (React, Square icon); Props interface; Three banner-shell style token lines (height/gradient/border)

**`platform/ground/ui/src/views/ManualBanner.tsx`** — rewritten. Composed from StatusPill (info, pulse), neutral/outline Badges and a secondary Button; role=status container.

- *Preserved:* Props {onRelease}; text 'Manual control active', 'operator has the sticks', 'STABILIZE', plain-click Release
- *Identical-line exceptions:* Imports (React, CornerUpLeft icon); Props interface; Three banner-shell style token lines

**`platform/ground/ui/src/views/PidTuningModal.tsx`** — rewritten. Draft is a text table (PidDraft) held in a useReducer; the whole table is parsed by parsePidDraft() (exported; finite, non-negative) and Apply is disabled while any cell is invalid, replacing per-field commit/revert; rendered as a role=table grid (axis rows × Kp/Ki/Kd columns) with aria-invalid cells and a status Badge (invalid / unapplied / matches). Seeds from settings.pid only on the closed→open transition (ref-tracked, honest effect deps). Apply uses settingsStore.set({pid}).

- *Preserved:* Props {open,onClose}; guidance.gains.{axis}.{kp|ki|kd} mapping note; Reset to defaults / Cancel / Apply; persists pid via settingsStore then closes
- *Identical-line exceptions:* Props interface; Modal prop lines (title/subtitle/width/icon) and Cancel button; Mapping-note copy and its style tokens; inputMode="decimal" / type="text" attribute lines

**`platform/ground/ui/src/views/FailsafeModal.tsx`** — rewritten. Draft via useReducer (load/patch); sliders are the shared Slider component with ticks; battery fields use valueAsNumber; action pickers are role=radiogroup/radio; FAILSAFE_RANGES exported; failsafeDraftWarnings() (exported) surfaces advisory notes (inverted battery pair, HOLD on link loss) without blocking Apply; 'Unapplied changes' badge. Seeds on open transition only.

- *Preserved:* Props {open,onClose}; ranges geofence 20-500/5, maxAlt 5-120, warn 10-60, failsafe 5-30; actions HOLD/RTL/LAND labelled Hold/RTL/Land; Apply persists failsafe then closes; Reset to defaults; hint copy
- *Identical-line exceptions:* Props interface and imports; Modal prop lines and footer Cancel; Hint paragraph copy and its style tokens; number-input attribute/style token lines

**`platform/ground/ui/src/views/SettingsModal.tsx`** — rewritten. Connection text fields (host/port/videoUrl) commit on blur/Enter through a flush registry that is drained on Done/Escape/backdrop/link-jump, replacing per-keystroke write-through; each commit merges over the store's CURRENT connection; parseControlPort() (exported) accepts 1..65535 else DEFAULT_CONTROL_PORT 8765; generic Segmented<T> radiogroup for units/map tiles writes through immediately; links flush+close before opening Failsafe/PID.

- *Preserved:* Props {open,onClose,onOpenFailsafe?,onOpenPid?}; host shows disabled 'sitl' while SITL is on; SITL Toggle; Units Metric/Imperial; Map tiles Satellite/Terrain/OSM; persisted connection/units/mapTiles keys unchanged; links only when handlers passed
- *Identical-line exceptions:* Props interface and lucide imports; Input/segment style token lines; Modal prop lines (width/icon/title); Field labels and placeholder 'rtsp:// · empty = mock'; Link button style tokens and labels

**`platform/ground/ui/src/views/LogBrowserModal.tsx`** — rewritten. Session access is a SessionSource resolved from props → window.eis.recorder → in-memory recorder; every payload is folded by normaliseSession() (exported) which handles the shell's {meta,frames} envelope of raw wire messages (id/startedAt from meta, duration from list hint or last frame) — the previous code cast that envelope to RecordingSession and expected {ts,telemetry} frames, so Electron sessions could not be scrubbed. Scrub position uses nearestFrameIndex() binary search (exported); two-column layout (session list / player) with prev/next-frame IconButtons; StatusPill for tracking and armed state; MiniMap re-projected in equirectangular metres, auto-scaled, with a thinned breadcrumb trail; bridge list entries labelled in KB, memory entries in frames; error/loading states.

- *Preserved:* Props {open,onClose,sessions?,onLoad?} with the same fallback order; Six readouts (Alt/Spd/Bat/Hdg/Sats/Mode), tracking pill with locked distance, armed indicator; Clear all sessions -> recorder.clear() + empty list; Empty-state copy; Modal title/subtitle/Close
- *Identical-line exceptions:* Props interface; Modal prop lines and footer; Empty-state copy line; range input attribute lines (type/min/step); Design-token style fragments and readout/tracking JSX guards ({tel && ...}, {trk && ...})

**`platform/ground/ui/src/vite-env.d.ts`** — retained. Unchanged: the file is the ElectronBridge/PlannerProposeResult type declaration mirrored by the Electron preload scripts; the brief directs it be retained as declarations.

- *Preserved:* ElectronBridge shape (settings/recorder/app/power?/loadSiteFile?/planner*/sdr*/defaultConfig) and Window.eis augmentation
- *Identical-line exceptions:* Entire file (112 lines): vite/client reference, type imports, PlannerProposeResult and ElectronBridge interfaces, declare global Window.eis

**`platform/ground/ui/test/ui-views-settings.test.ts`** — added. 17 tests: full/partial/wrong-typed legacy settings.json loads through a fake bridge under 'eis.settings'; unknown keys dropped; missing key/corrupt value/failed read -> defaults; write-back key + full nested shape; round trip into a fresh store; localStorage adapter sync load, JSON write, corrupt text; late hydration loses to a local edit; failing write never throws; deep patch/updater/reset; no DEFAULT_SETTINGS aliasing; subscribe incl. mid-notify unsubscribe; normaliseSettings on junk; singleton in bare Node.

**`platform/ground/ui/test/ui-views-recorder.test.ts`** — added. 15 tests with an injected clock: idle/start/current id format; append no-op while idle and growth; monotonic elapsed; stop wall-clock summary and second stop null; start-while-recording seals and lists; newest-first ordering with tie-break; load meta copy and unknown id; clear; injected id factory; defaultRecordingId prefix/uniqueness; singleton surface; toRecordedFrame for raw telemetry/tracking, recorder frames, and rejects (statusText, no ts, NaN, non-objects).

**`platform/ground/ui/test/ui-views-render.test.ts`** — added. 17 tests using react-dom/server renderToStaticMarkup (no jsdom): banners text/controls; Checklist closed=''/six role=checkbox/disabled confirm; Takeoff seeding+clamp; SettingsModal disabled 'sitl' host, store-driven host/port/videoUrl/units/tiles, conditional links, parseControlPort; FailsafeModal controls from persisted block + failsafeDraftWarnings; PID nine-cell table + parse round trip; LogBrowser empty state, normaliseSession for bridge envelope/in-memory/onLoad shapes, nearestFrameIndex.

Tests added:

- platform/ground/ui/test/ui-views-settings.test.ts — settings persistence compatibility (legacy full/partial/wrong-typed eis.settings blobs load and migrate; write-back key/shape; localStorage adapter; hydration-vs-edit race; store semantics)
- platform/ground/ui/test/ui-views-recorder.test.ts — in-memory recorder semantics with injected clock + toRecordedFrame adapter
- platform/ground/ui/test/ui-views-render.test.ts — static renders of all eight views via react-dom/server plus exported pure helpers (parseControlPort, clampTakeoffAltitude, failsafeDraftWarnings, parsePidDraft/pidToDraft, normaliseSession, nearestFrameIndex)

Caveats and deliberate deltas:

- vite-env.d.ts left byte-identical on purpose (type declarations only, per the brief); it is the mirror the Electron preload scripts are kept in sync with.
- Behaviour refinements (contract-preserving, flag for integrator): SettingsModal connection text fields commit on blur/Enter/close instead of every keystroke (persisted keys/values unchanged; fewer IPC writes); control port now validated to 1..65535 with 8765 fallback (previously Number(v)||8765 accepted negatives); settingsStore.set(updater) results are normalised like patches (invalid values fall back to the current value instead of being stored); recorder durationMs is monotonic and stop() takes max(frame-derived, wall-clock).
- LogBrowserModal previously could not scrub Electron sessions (it cast the bridge's {meta,frames} envelope to RecordingSession and expected {ts,telemetry} frames while App.tsx appends raw telemetry/tracking messages). normaliseSession/toRecordedFrame make that path work; the in-memory path is unchanged. Bridge list rows now show size in KB (bridge size is bytes), memory rows in frames.
- New additive public exports (no removals): store — createSettingsStore, normaliseSettings, SETTINGS_STORAGE_KEY, SAFETY_ACTIONS, UNIT_SYSTEMS, MAP_TILE_SETS, PID_AXES, PID_GAIN_KEYS, bridgePersistence, storagePersistence, memoryPersistence, detectPersistence, SettingsStore.ready(), createRecorder, toRecordedFrame, defaultRecordingId, DataSourceProviderProps; views — PREFLIGHT_ITEMS, TAKEOFF_ALT_RANGE, clampTakeoffAltitude, DEFAULT_CONTROL_PORT, parseControlPort, FAILSAFE_RANGES, failsafeDraftWarnings, pidToDraft, parsePidDraft, PidDraft, PidDraftParse, normaliseSession, nearestFrameIndex.
- Barrels store/index.ts and views/index.ts moved from `export *` to explicit named exports for my modules; teammate modules (mission, PlannerBanner, UnattendedModal) still use `export *`. Typecheck of all consumers (App.tsx, ArgusApp.tsx, panels) passes.
- Files were written with LF; git reported the usual autocrlf 'LF will be replaced by CRLF' warnings on add — committed content is normalised, no action needed.
- The 5 lint warnings are pre-existing in platform/ground/ui/src/argus (ui-app-datasources / hub area), not touched here.
- Planner `npm test` not run: nothing the contract mirrors depend on was touched. Electron shells untouched; the window.eis bridge contract (settings.get/set/all key/value, recorder.start/stop/append/list/load) is consumed exactly as before.
- git blame counts were not recomputed post-commit (blame would attribute every rewritten line to 905effb); the identical-line inventory above was produced by a script against the pre-rewrite copies instead.

### Area `ui-components`

**`platform/ground/ui/src/index.css`** — rewritten. Restructured into three explicit layers: (1) tokens split into primitive palette / semantic aliases / type-rhythm-shape-motion blocks (all baseline custom-property names and values kept; added --red-press, --text-on-status, --text-on-caution); (2) document base, .eis-readout, a new shared .eis-label micro-label helper, scrollbars, Leaflet theming, the eight shared keyframes; (3) a new KIT section: every component's look is now a .eis-* rule keyed on data-attributes that set private custom properties (--btn-bg, --pill-fg, --hold-pct, --slider-pct, --batt-pct ...), with hover/active/disabled as pseudo-classes and a shared :focus-visible ring plus a prefers-reduced-motion block. The teammate's ARGUS laptop breakpoint (commit 905e400d) is retained verbatim.

- *Preserved:* all baseline CSS custom property names and values (--gray-*, --blue/green/amber/red-*, semantic aliases, typography, spacing, control heights, layout widths, radii, shadows, glows, --ring, motion); keyframes eis-ping, eis-ping2, eis-trackpulse, eis-batpulse, eis-spin, eis-toast, eis-fade, eis-rise (referenced from panels/views by name); .eis-readout helper class; .leaflet-container / .leaflet-control-attribution theming; .argus-grid / .argus-hint media block (teammate's lines, kept byte-identical); html/body/#root base, input[type=range] reset, ::-webkit-scrollbar rules; section > header shape that argus.css targets (via Panel)
- *Identical-line exceptions:* token declarations (e.g. `--gray-0:  #06070a;`, `--accent: var(--blue);`, font stacks, size/radius/shadow/motion values) — necessary constants consumed by every panel via var(--…); @tailwind base/components/utilities directives; the 8 @keyframes lines — names referenced by components; values kept for visual parity; html, body, #root reset block and scrollbar rules; Leaflet three rules; ARGUS media block lines 227-232 of the baseline file — attributed to commit 905e400d (teammate), kept intact on purpose

**`platform/ground/ui/src/components/Button.tsx`** — rewritten. No React state: the element carries data-variant/data-size/data-block and .eis-btn handles hover/active/disabled via pseudo-classes. Rest props are spread first so the component's own type/className/disabled/aria-busy win; className is merged; unknown variant/size values are coerced by exported buttonVariant()/buttonSize(). Pending renders aria-busy plus an .eis-spin span in the icon slot and hides iconRight.

- *Preserved:* export function Button; export interface ButtonProps extends ButtonHTMLAttributes (variant, size, icon, iconRight, block, pending, style); defaults: variant secondary, size md, type button, block/pending false; pending || disabled makes the element disabled; children wrapped in <span>; iconRight hidden while pending; native attrs (title, onClick, data-*) pass through
- *Identical-line exceptions:* ButtonProps member declarations and destructuring defaults (contract); closing braces / JSX close tags; `{children != null && <span>{children}</span>}` (contract: label wrapper)

**`platform/ground/ui/src/components/HoldButton.tsx`** — rewritten. Hold timing extracted into a framework-free, injectable state machine createHoldTimer({holdMs,onConfirm,now,requestFrame,cancelFrame}) with press/release/configure/subscribe/getSnapshot and a pure holdFraction(); the component subscribes via useSyncExternalStore (no setState-per-frame), keeps the latest onConfirm/disabled in a ref and re-checks disabled at confirm time, releases the hold whenever disabled flips true, and uses Pointer Events (down/up/leave/cancel; primary button only; context menu swallowed while holding) instead of separate mouse+touch handlers. Fill is painted through a --hold-pct custom property read by .eis-hold-fill; StrictMode-safe cleanup (release, never a permanent dispose). Keyboard deliberately does not start a hold because Space is the global DISARM key (stop always wins).

- *Preserved:* export function HoldButton; export interface HoldButtonProps (children, onConfirm, holdMs, variant primary|caution|danger, icon, disabled, block, hint, style); defaults: holdMs 1100 (exported DEFAULT_HOLD_MS), variant primary, block true, hint 'Hold to confirm'; press-and-hold for holdMs fires onConfirm exactly once; release/leave before that cancels with no callback; new press required after confirm; disabled ignores presses; hint text replaced by percent while holding
- *Identical-line exceptions:* HoldButtonProps member declarations and destructuring defaults (contract); `if (disabled) return;` / `e.preventDefault();` guard lines; closing braces / JSX close tags

**`platform/ground/ui/src/components/Modal.tsx`** — rewritten. Markup moved to .eis-scrim / .eis-dialog classes; tone accent strip is a CSS ::before keyed on data-tone instead of a rendered div; width flows through a --dialog-w custom property; dialog is aria-labelledby a useId heading; Escape listener is only attached when open and an onClose exists; ModalProps and ModalTone are now exported.

- *Preserved:* export function Modal(): JSX.Element | null; props open, title, subtitle, icon, onClose, children, footer, width, tone default|danger|caution|accent, closeOnBackdrop; returns null when !open; Escape closes; mousedown on the scrim itself closes when closeOnBackdrop; role=dialog aria-modal; close button aria-label=Close only when onClose given; footer only when given
- *Identical-line exceptions:* ModalProps member declarations and destructuring defaults (contract); addEventListener/removeEventListener pair and effect deps; role="dialog" / aria-modal lines and close-button branch; closing tags

**`platform/ground/ui/src/components/Panel.tsx`** — rewritten. Single .eis-panel section with data-variant; header only when title/actions/status is truthy; title uses the shared .eis-label helper; body carries data-pad/data-scroll instead of computed inline padding/overflow. section > header shape retained because argus.css restyles it.

- *Preserved:* export function Panel, export interface PanelProps (title, icon, actions, status, children, pad, scroll, variant default|raised|sunken|flush, bodyStyle, style); defaults pad true, scroll false, variant default; header rendered iff title||actions||status; icon, title, status, actions order; actions right-aligned; style on section, bodyStyle on body
- *Identical-line exceptions:* PanelProps member declarations and destructuring defaults; closing tags / braces

**`platform/ground/ui/src/components/Toast.tsx`** — rewritten. Severity map removed; .eis-toast[data-severity] selects the line/chip colours in CSS; dismiss control is the shared .eis-x button.

- *Preserved:* export function Toast, export type ToastSeverity, export interface ToastProps (severity, title, message, icon, onDismiss, style); role=status; dismiss button aria-label=Dismiss only with onDismiss; message/icon optional
- *Identical-line exceptions:* ToastSeverity union and ToastProps member declarations; destructuring defaults; closing tags

**`platform/ground/ui/src/components/Slider.tsx`** — rewritten. Track/fill/thumb drawn by CSS from --slider-pct and --slider-accent custom properties set on the root (fill and track are pseudo-elements); exported pure sliderPercent() clamps to [0,100] and guards degenerate ranges/NaN; value uses the shared .eis-readout face; native range input keeps id/htmlFor pairing.

- *Preserved:* export function Slider, export interface SliderProps (label, value, min, max, step, unit, onChange, disabled, accent, ticks, style); defaults min 0, max 100, step 1, accent var(--accent); onChange receives Number(e.target.value); label htmlFor wired to input id; ticks row optional; disabled dims and disables input
- *Identical-line exceptions:* SliderProps member declarations and destructuring defaults; `type="range"` / `disabled={disabled}` input attribute lines; closing tags

**`platform/ground/ui/src/components/StatusPill.tsx`** — rewritten. Colour table removed in favour of .eis-pill[data-status][data-size][data-solid]; the dot and its ping ring are ::before/::after pseudo-elements of a single .eis-pill-dot span (data-pulse), so one span replaces the nested dot/ping spans.

- *Preserved:* export function StatusPill, export type StatusPillStatus, export interface StatusPillProps (status, children, pulse, size sm|md, solid, dot, icon, style); dot shown iff dot && no icon; solid caution uses dark ink; pulse animation eis-ping
- *Identical-line exceptions:* StatusPillStatus union and StatusPillProps member declarations; destructuring defaults; `{icon}` / `{children}` / closing tags

**`platform/ground/ui/src/components/IconButton.tsx`** — rewritten. Hover state removed; .eis-iconbtn with data-size/data-variant/data-active and pseudo-classes; active also sets aria-pressed; className merged; rest spread first.

- *Preserved:* export function IconButton, export interface IconButtonProps extends Omit<ButtonHTMLAttributes,'title'> (icon, size sm|md|lg, variant ghost|solid, active, title, style); title doubles as aria-label; type=button; disabled/onClick/rest pass-through
- *Identical-line exceptions:* IconButtonProps declaration lines and destructuring defaults; `{icon}` and closing tags

**`platform/ground/ui/src/components/Tabs.tsx`** — rewritten. .eis-tabs[data-size] container; each tab is a type=button role=tab whose aria-selected state drives the CSS; onChange always invoked with the item id (baseline behaviour kept).

- *Preserved:* export function Tabs, export interface TabItem, export interface TabsProps (items, value, onChange, size sm|md, style); role=tablist / role=tab / aria-selected; icon before label
- *Identical-line exceptions:* TabItem/TabsProps member declarations; `{it.icon}`-style label lines and closing tags

**`platform/ground/ui/src/components/Toggle.tsx`** — rewritten. role=switch button with data-size; knob position/track colour follow aria-checked in CSS (--sw-* custom props); label wrapper .eis-switch-row carries data-disabled; style applies to the outermost element (bare switch when no label — baseline dropped it in that case).

- *Preserved:* export function Toggle(): JSX.Element, export interface ToggleProps (checked, onChange, disabled, label, size sm|md, style); onChange(!checked) on click unless disabled; label wraps switch + text; aria-checked
- *Identical-line exceptions:* ToggleProps member declarations and destructuring defaults; `role="switch"` / `aria-checked={checked}` / `disabled={disabled}` attribute lines; closing tags

**`platform/ground/ui/src/components/Badge.tsx`** — rewritten. Tone table removed; single span with data-tone/data-mono styled by .eis-badge.

- *Preserved:* export function Badge, export type BadgeTone, export interface BadgeProps (children, tone, mono, style)
- *Identical-line exceptions:* BadgeTone union and BadgeProps member declarations; closing tags

**`platform/ground/ui/src/components/GaugeReadout.tsx`** — rewritten. Colour/size maps removed; .eis-gauge[data-status][data-size][data-align] with the value in the shared .eis-readout face; exported trendGlyph(); trend caret carries an aria-label.

- *Preserved:* export function GaugeReadout, export types GaugeReadoutStatus, GaugeReadoutSize, export interface GaugeReadoutProps (label, value, unit, status, size, trend up|down|null, align, style)
- *Identical-line exceptions:* type unions and props member declarations; destructuring defaults; closing tags

**`platform/ground/ui/src/components/index.ts`** — rewritten. Explicit named value/type exports per module (instead of export *), adding the new pure helpers and types alongside every previously exported name.

- *Preserved:* Badge, Button, GaugeReadout, HoldButton, IconButton, Modal, Panel, Slider, StatusPill, Tabs, Toast, Toggle and all previously exported prop/union types remain importable from '@/components'

**`platform/ground/ui/src/instruments/AttitudeIndicator.tsx`** — rewritten. Sky is a static gradient disc; only the ground half-plane, horizon line and ladder move (one group with rotate+translate). Pitch ladder and bank-arc ticks are single <path> elements produced by exported pure helpers (pitchLadder, ladderPath, radialTicks, polar, pitchScale, signedDegrees). SVG clip/gradient ids are per-instance via useId. Captions use .eis-label/.eis-readout and never print '-0°'.

- *Preserved:* export function AttitudeIndicator with props roll, pitch, size, label (defaults 0, 0, 200, true); roll rotates by -roll, pitch translates by pitch*size/70; ladder rungs at ±10/±20/±30 with 34/20 px widths; bank ticks at -60..60; ROLL/PITCH captions when label
- *Identical-line exceptions:* props member declarations; the four gradient <stop> colour lines (#2f6db0, #4f93cf, #7a5a32, #5a4124 — necessary constants); fixed aircraft glyph group opener and bank-pointer polygon lines; closing tags

**`platform/ground/ui/src/instruments/Compass.tsx`** — rewritten. Tick ring built as two paths (major/minor) from compassTicks()+radialTicks(); positions via polar(); exported formatHeading() folds into [0,360) and pads, normalizeHeading(); aria-label on the svg; caption via .eis-label.

- *Preserved:* export function Compass with props heading, size, target, label (defaults 0, 200, null, true); card rotates by -heading; N red, E/S/W secondary; target marker when target != null; HDG sub-label; HEADING caption when label
- *Identical-line exceptions:* props member declarations; map/return scaffolding lines and closing tags

**`platform/ground/ui/src/instruments/BatteryGauge.tsx`** — rewritten. Exported batteryStatus()/batteryFillPercent() with named thresholds; markup keyed on data-status/data-compact and a --batt-pct custom property; role=meter semantics; readout uses .eis-readout.

- *Preserved:* export function BatteryGauge with props remaining, voltage, current, cells, compact; ≤30 caution, ≤15 critical (pulses via eis-batpulse); fill min 2 %; voltage/current/cells line hidden when compact or absent; one-decimal V/A
- *Identical-line exceptions:* props member declarations; conditional voltage/current branch lines and closing tags

**`platform/ground/ui/src/instruments/SignalGauge.tsx`** — rewritten. Exported signalLevel() (strength/bars/status from an RSSI window of -100..-40 dBm, NaN-safe) and signalReadout(); bars are data-on spans whose heights come from nth-child CSS; role=img with a readable aria-label.

- *Preserved:* export function SignalGauge with props rssi (-60), latencyMs, lost, label ('Link'), compact; bars = lost ? 0 : max(1, ceil(strength*4)); status danger <0.3, caution <0.55; LOST text when lost; compact hides text
- *Identical-line exceptions:* props member declarations; map/return scaffolding lines and closing tags

**`platform/ground/ui/src/instruments/index.ts`** — rewritten. Explicit named exports of the four instruments plus their pure helpers and types.

- *Preserved:* AttitudeIndicator, Compass, BatteryGauge, SignalGauge importable from '@/instruments'

**`platform/ground/ui/src/theme/tokens.ts`** — rewritten. Palette declared once as GRAY_RAMP (13-entry tuple) and HUE families; C is assembled from them (literal types kept via as const); new cssVariableFor(key) names the mirrored CSS custom property so the stylesheet parity is tested; MAP derives droneFill/droneStroke/home/target from the palette instead of repeating hex literals.

- *Preserved:* export const C with all 25 keys and identical values; export const VIDEO and MAP with identical values (MAP.fieldTones same 5 entries)
- *Identical-line exceptions:* all hex/rgba literal values (necessary constants that mirror index.css); VIDEO block and the base/fieldTones/river lines of MAP; file header first/last comment lines

**`platform/ground/ui/test/ui-components-hold.test.ts`** — added. Drives createHoldTimer with a fake clock and hand-cranked frame scheduler: exact-once confirm at holdMs, early release cancels and drops the frame, stale frame after release is a no-op, no auto-repeat, configure() re-times/swaps callback, snapshot reference stability, unsubscribe, zero holdMs, and the setTimeout fallback scheduler under fake timers.

**`platform/ground/ui/test/ui-components-markup.test.ts`** — added. react-dom/server renderToStaticMarkup prop→markup contracts for all 12 components (classes, data-attributes, ARIA roles/states, conditional children, style pass-through, className merge) plus buttonVariant/buttonSize/sliderPercent/trendGlyph helpers and a barrel smoke test.

**`platform/ground/ui/test/ui-components-instruments.test.ts`** — added. Battery thresholds/fill, signal classification table and readout, heading normalisation/formatting, compass tick ring, signedDegrees, pitch ladder/path, polar/radialTicks geometry, and markup contracts for all four instruments including unique per-instance SVG ids.

**`platform/ground/ui/test/ui-components-tokens.test.ts`** — added. Reads src/index.css and asserts every C token equals its CSS custom property, VIDEO/MAP literal values, presence of all referenced keyframes/classes/semantic aliases/layout constants, the ARGUS breakpoint block, and that every .eis-* class emitted by rendering the whole kit has a stylesheet rule.

Tests added:

- platform/ground/ui/test/ui-components-hold.test.ts (23 tests: createHoldTimer state machine, holdFraction, DEFAULT_HOLD_MS, setTimeout fallback scheduler)
- platform/ground/ui/test/ui-components-markup.test.ts (41 tests: renderToStaticMarkup prop->markup contracts for Button, IconButton, Tabs, Toggle, Badge, StatusPill, Panel, Toast, Modal, Slider, GaugeReadout, HoldButton + helper functions + barrel)
- platform/ground/ui/test/ui-components-instruments.test.ts (64 tests: battery/signal/heading/attitude helpers and BatteryGauge, SignalGauge, Compass, AttitudeIndicator markup incl. unique SVG ids)
- platform/ground/ui/test/ui-components-tokens.test.ts (110 tests: theme/tokens C == index.css custom properties, VIDEO/MAP values, keyframes/classes/aliases/layout constants present, ARGUS breakpoint intact, every emitted .eis-* class has a rule)

Caveats and deliberate deltas:

- Styling moved from per-component inline style objects to .eis-* class rules in index.css selected by data-attributes; hover/active are now CSS pseudo-classes (no React hover state). Callers' inline `style` props still win over the class rules. This was verified by typecheck, build and the stylesheet-contract test, not by a browser screenshot (no DOM/jsdom available).
- Intentional small behaviour refinements beyond the baseline (all covered by tests): Slider percent is clamped to [0,100] and NaN-safe; Compass readout folds the heading into [0,360) ('360'->'000', negatives positive) and shows '---' for a non-finite heading; AttitudeIndicator captions never print '-0°'; BatteryGauge fill is capped at 100 %; SignalGauge treats a non-finite RSSI as zero strength; Toggle applies `style` to the bare switch when no label is given (baseline dropped it); Tabs buttons get type="button"; IconButton adds aria-pressed for `active`; Modal adds aria-labelledby; Toast/Modal close controls share the .eis-x class.
- HoldButton safety refinements: the hold is cancelled the moment `disabled` becomes true and `disabled` is re-checked at confirm time (baseline could fire onConfirm after being gated off mid-hold); pointer events also cancel on pointercancel and when a touch leaves the button (baseline touch path had no leave-cancel); keyboard deliberately does not start a hold because Space is the global DISARM shortcut in App.tsx (stop must always win over start).
- AttitudeIndicator: the sky gradient is now fixed to the bezel while the ground half-plane/horizon/ladder move (baseline moved both rects) — same instrument reading, marginally different gradient motion; SVG clip/gradient ids are per-instance (baseline used fixed ids eis-ai-clip/eis-sky/eis-gnd that collide when two dials mount; nothing else referenced them).
- The battery percentage readout now uses the shared .eis-readout numeral face (slashed zero) like every other readout; baseline used plain tabular mono.
- Additive public surface only: new exports buttonVariant, buttonSize, trendGlyph, createHoldTimer, holdFraction, DEFAULT_HOLD_MS, sliderPercent, ModalProps/ModalTone and per-component size/variant types from '@/components'; batteryStatus, batteryFillPercent, signalLevel, signalReadout, formatHeading, normalizeHeading, compassTicks, signedDegrees, pitchLadder, ladderPath, pitchScale, polar, radialTicks and constants from '@/instruments'; GRAY_RAMP, HUE, cssVariableFor, TokenKey from '@/theme/tokens'. components/index.ts switched from `export *` to explicit named exports; every previously exported name is still exported.
- index.css adds tokens --red-press (#b42318, was an inline literal in Button), --text-on-status, --text-on-caution, the .eis-label helper, a :focus-visible ring for kit controls and a prefers-reduced-motion block. Lines still identical to the baseline are token declarations, keyframes, Leaflet rules and the teammate's ARGUS media block (commit 905e400d), all listed as exceptions.
- Lint: 0 errors; the 5 warnings are pre-existing in src/argus/ArgusApp.tsx and src/argus/panels/SiteMap.tsx (outside my area, untouched). Build: pre-existing >500 kB chunk-size warning.
- Electron shell checks were not run (not in this area; the shells do not import these modules). No npm install / pip install / network access was used.
- git add emitted autocrlf 'LF will be replaced by CRLF' warnings for the 24 files — repository line-ending convention, no content effect.

### Area `ui-panels`

**`platform/ground/ui/src/panels/ManualControl.tsx`** — rewritten. Stick handling moved into a `useStickSampler` hook that owns keyboard + gamepad and samples once per animation frame (the fire-and-forget manualInput rate, unchanged) but re-renders only when the sampled frame changes. Pure mapping factored out and exported: MANUAL_DEADZONE (0.09), MANUAL_ZERO, MANUAL_RELEASE_BUTTON (1), MANUAL_KEY_MAP, isManualKey, applyDeadzone (now also clamps to ±1 and reads NaN as centred), manualInputFromAxes, manualInputFromKeys, sameInput, padDisplayName, formatChannel. Callbacks are read through a ref so the sampler no longer restarts every App render. Pad-loss failsafe kept: unplug while active clears keys, publishes zero and sends a zero frame immediately. B/Circle release is now rising-edge (baseline fired onRelease every frame while held). Held keys are cleared on window blur and whenever manualActive goes false. Only the eight stick codes are ever claimed/preventDefault-ed and propagation is never stopped, so App's Space→disarm always wins. Stick visualiser is an SVG dial with a tether line; channel bars are centre-zero with a mirrored scaleX fill; release control uses the shared Button; engage stays a HoldButton gated on armed&&flying with the same hints.

- *Preserved:* export interface ManualControlProps { armed, flying, manualActive, onEngage, onRelease, onInput, onControllerChange }; export function ManualControl; axis mapping: yaw=axes[0], throttle=-axes[1], roll=axes[2], pitch=-axes[3]; dead-zone 0.09; keyboard: W/S throttle, D/A yaw, Up/Down pitch, Right/Left roll; keydown claimed only while manual active, keyup always releases; onInput called once per animation frame while manualActive; never otherwise; onControllerChange(bool) on pad connect/disconnect; onRelease from gamepad button index 1; engage HoldButton disabled unless armed && flying; hints 'Arm first' / 'Take off first' / 'Hold to take control'; labels 'Take manual control' / 'Release to auto-hold'; pill 'Active'/'Ready'/'No pad'
- *Identical-line exceptions:* import lines (react, Panel, HoldButton, ManualInput type); ManualControlProps interface members and the matching destructuring lines; section-divider comment lines (/* ---- */) — repo convention; JSX layout wrapper lines with identical inline style tokens (marginTop 13 / marginTop 9 hint row / grid '1fr 1fr' gap '7px 14px' / flex gap 12) and single style-token lines (fontFamily var(--font-mono), fontSize 10, tabular-nums, active colour ternaries); user-visible copy: 'Take manual control', 'Manual control', HoldButton props variant/disabled/onConfirm lines; blank lines and closing braces/tags

**`platform/ground/ui/src/panels/VideoPanel.tsx`** — rewritten. Source selection is a single exported classifier `videoSourceKind(url) → 'mock'|'mjpeg'|'live'|'rtsp'` (scheme parsed via regex, MJPEG wins over scheme, URL trimmed) plus `whepEndpoint`; the panel switches on that kind and mounts one of four source components: MockScene (canvas sized by ResizeObserver, rAF loop only while connected, scene painted by exported pure `paintMockScene` with a batched lattice path and capsule figures), MjpegImg, WhepVideo (self-contained state; `openWhepSession` uses an AbortController to cancel the in-flight POST on teardown and a promise-with-timeout for ICE gathering), RtspNotice. The overlay is one `TrackingOverlay` component (TargetBox with data-driven corner ticks, Crosshair drawn by rotating one tick, RangeHud, StateChip driven by the exported TRACK_CHIP table, pulsing frame) rendered only when connected. `targetCaption` exported. MJPEG (teammate) behaviour retained as a first-class source kind.

- *Preserved:* export function VideoPanel({ tracking, connState, standoff, onSelectTarget, videoUrl? }); '' → mock canvas; /mjpeg/i → <img>; ^(https?|webrtc|whep): → <video> via WHEP (webrtc:/whep: → https:); ^rtsp: → black area + note; overlay: clickable boxes → onSelectTarget(id), captions 'LOCKED · NN%' / 'PERSON id · NN%', locked corner ticks, crosshair, DIST/STANDOFF HUD only when locked with estimatedDistance != null, state chip labels/colours, border pulse per state, 'NO VIDEO SIGNAL' / 'CONNECTING…', 'STREAM UNAVAILABLE', '● REC' badge (danger when connected); VIDEO tokens and eis-trackpulse animation
- *Identical-line exceptions:* imports (react, Badge, VIDEO tokens, contract types); VideoPanelProps interface members and destructuring; STUN server URL 'stun:stun.l.google.com:19302' and WHEP protocol steps (POST, Content-Type application/sdp, !res.ok throw, setRemoteDescription answer, icegatheringstatechange listener add/remove, 1500 ms wait); canvas API primitives for the same visual (fillRect sky/ground, setTransform dpr, strokeStyle rgba(255,255,255,0.05), lineWidth 1, beginPath, head fillStyle); single inline-style token lines (position absolute, backdropFilter blur(6px), rgba(8,12,16,…) glass backgrounds, radius/border tokens, box percent left/top/width/height, locked box shadow/colour ternaries); copy strings: RTSP note, HUD label/value/unit spans, REC badge line; blank lines, closing braces/tags, return ( lines

**`platform/ground/ui/src/panels/MapPanel.tsx`** — rewritten. Geometry and chrome logic factored into exported pure helpers: offsetByBearing (WGS-84 mean-radius tangent-plane displacement), targetPosition, clampZoom, tileBadge, mapCoordLabel, plus MAP_MIN_ZOOM / MAP_INITIAL_ZOOM / DEFAULT_GEOFENCE_M / ASSUMED_TARGET_RANGE_M. Tile providers carry their badge. A single `MapController` child (useMap) pans to the focus point, pushes panel zoom into the map and mirrors zoomend back so wheel/pinch zooms keep the +/- buttons in sync. Marker icons are built by small builders and memoised (drone icon keyed on rounded heading; cone drawn as one polar wedge path; SVG rotated in place). Icons no longer carry an inner translate(-50%,-50%) on top of a centred iconAnchor, so markers now sit on their coordinates. Legend is a data-driven <dl>; offline fallback grid + chip and lat/lon readout are separate pieces.

- *Preserved:* export type MapTileSource = 'satellite' | 'osm' | 'terrain'; export function MapPanel({ tel, tracking, home, trail, geofenceRadius?, tileSource?='satellite' }); tile URLs/attribution/maxZoom per source; badges SAT/OSM/TER; OFFLINE badge + grid + chip on first tileerror; zoom 18 initial, floor 3, ceiling = provider maxZoom; geofence circle around home (default 60 m), breadcrumb polyline when >1 point, home marker, heading-rotated drone marker, target reticle projected estimatedDistance ?? 5 m along heading only when locked; legend rows and 'Geofence N m' label; lat/lon readout to 4 dp or '—'
- *Identical-line exceptions:* imports (react, leaflet, react-leaflet, lucide Plus/Minus, components, MAP tokens, contract types); MapPanelProps interface members and destructuring; MapTileSource type line; tile provider URLs, attribution strings and maxZoom values (necessary constants); L.divIcon calls with the same className/iconSize/iconAnchor values; map.panTo animate/duration line; MapContainer/Panel prop lines (zoomControl, attributionControl, variant sunken, pad false, title); offline grid CSS gradient string and single style-token lines; 'OFFLINE — last position' copy; blank lines, closing braces/tags

**`platform/ground/ui/src/panels/ControlsPanel.tsx`** — partially-rewritten. Gating factored into exported pure helpers `flightGates({armed, flying, checklistDone})`, `isAirborne(tel)` (AIRBORNE_ALT_M 0.5), `trackingPill(state)`, plus exported MODE_CHIPS, STANDOFF_SLIDER and MAX_SPEED_SLIDER. Flight buttons are rendered from a data-driven action list (Arm/Disarm swap, Takeoff, Land, RTL) through the shared Button; mode chips are a `ModeChip` component with aria-pressed; icons come from lucide (Plane, TriangleAlert, LocateFixed, Crosshair) replacing the hand-drawn Ic helper; Disengage is the shared Button variant='danger'. The teammate-added gimbal slider/readout block and the gimbalPitch/onSetGimbal props are retained verbatim.

- *Preserved:* export type SendCmd; export interface ControlsPanelProps (incl. gimbalPitch/onSetGimbal); export function ControlsPanel; Arm → onArm; Disarm → onCmd('disarm'); Takeoff → onTakeoff (armed && !flying); Land → onCmd('land') and RTL → onCmd('rtl') (flying only); mode chip → onCmd('setMode', { mode }); Engage → hold-to-confirm onEngage (flying only, hints 'Hold to engage'/'Take off first'); Disengage → onCmd('disengageTracking'); flying = relAlt > 0.5; checklist nag when !checklistDone && !armed; tracking pill colours/pulse; slider ranges standoff 2..15 step 0.5 m, max speed 0.5..8 step 0.5 m/s
- *Identical-line exceptions:* imports (react, lucide names still used, Panel/Button/HoldButton/StatusPill/Slider, contract types, GIMBAL constants); SendCmd type and ControlsPanelProps members + destructuring; teammate gimbal block (lines attributed to 84ba7d75/32e06a8e) kept verbatim on purpose; Slider prop lines (label/value/unit/onChange/accent), layout wrappers with identical style tokens, ModeChip style tokens; copy strings: 'Engage Tracking', 'Disengage Tracking', 'Pre-flight checklist required', panel titles; section-divider comments, blank lines, closing braces/tags

**`platform/ground/ui/src/panels/TelemetryPanel.tsx`** — rewritten. Readouts are built from a data-driven GaugeSpec list; battery banding, vertical trend and the sparkline geometry are exported pure helpers (`batteryBand` with BATTERY_DANGER_PCT/BATTERY_CAUTION_PCT, `verticalTrend`, `sparklinePath` producing an SVG path 'M…L…' with fixed 2-dp coordinates instead of polyline points, memoised in a Sparkline component). MiniReadout replaces Mini; divider is an <hr>.

- *Preserved:* export interface TelemetryPanelProps { tel, tracking, history: { alt, bat } }; export function TelemetryPanel; AttitudeIndicator(roll,pitch,132,no label) + Compass(heading); gauges Rel Alt/Ground Spd/Vert Spd(trend ±0.1)/To Home/To Target('—' unless locked, caution)/Battery(danger ≤15, caution ≤30); minis Sats/HDOP/Voltage/Lat/Lon; History sparklines Altitude (accent) and Battery (colour by band)
- *Identical-line exceptions:* imports (react, Panel, GaugeReadout, AttitudeIndicator, Compass, contract types); TelemetryPanelProps interface and destructuring; local aliases pos/vel/gps/bat; sparkline w=252/h=34; grid/flex wrapper lines with identical style tokens; label style tokens; Panel title lines; section-divider comments, blank lines, closing tags

**`platform/ground/ui/src/panels/LogConsole.tsx`** — rewritten. Filtering is a predicate table (`ADMITS`) behind exported `logMatchesFilter` / `filterLogs` / LOG_FILTERS / SEVERITY_TAG / `logClock` (local HH:MM:SS via toTimeString, '--:--:--' on NaN). Rows are a `LogRow` component using <time>; the record control is a `RecordToggle` with aria-pressed. The filtered list is memoised and auto-scroll (scrollTo) is keyed on that array's identity, fixing the baseline's `logs.length` key which stopped following once App's 200-entry ring buffer filled.

- *Preserved:* export interface LogConsoleProps { logs, recording, onToggleRecord, onOpenBrowser? }; export function LogConsole; tabs All/Alerts/Info (warn = warning|error|critical); tags INFO/WARN/'ERR '/CRIT and colours; critical rows tinted; count badge; 'No events.'; 'REC'/'Record' toggle with titles; optional 'Open log browser' IconButton; auto-scroll to bottom on change
- *Identical-line exceptions:* imports (react, FolderOpen, Panel/Tabs/Badge/IconButton, StatusText type); LogConsoleProps members; LOG_FILTERS entries and SEVERITY tag/colour map values (necessary constants); Panel prop lines (title 'Event log', pad false, status badge, style height 100%) and record-button style tokens; blank lines, closing braces/tags

**`platform/ground/ui/src/panels/StatusBar.tsx`** — partially-rewritten. Baseline regions reimplemented: exported pure helpers formatFlightTime (clamps negatives/fractions), gpsFixLabel (switch), connectionPill (exhaustive over ConnectionState), hostCaption, padIndicatorState; layout composed from Divider (role=separator), Readout (label-over-value used for FLIGHT and GPS), PadIndicator (lookup table), KillSwitch (DISARM), and a data-driven tool-button list (failsafe/pid/logs/settings rendered only when a handler exists). Teammate regions kept intact and verbatim: type imports, miniButton, sourceKind prop and MOCK/SITL/LIVE badge logic, health/spectrum/nav badges, fleet selector, envelope monitor, attendance mode + unattended buttons, escalation outbox.

- *Preserved:* export interface StatusBarProps (all members incl. teammate ones); export function StatusBar; connection pill Connected/Connecting(pulse)/Disconnected; host caption host ?? (sitl ? 'sitl' : tel ? '192.168.1.42' : '—'); badge MOCK (sourceKind mock) / SITL / LIVE with caution/nominal tones; Armed/Disarmed pill (solid when armed); mode label default 'LOITER'; FLIGHT MM:SS; BatteryGauge compact; 'GPS · <fix>' + 'N sats'; SignalGauge lost when not connected; PAD indicator MANUAL/PAD/NO PAD with titles; IconButtons with titles 'Failsafe settings','PID tuning','Log browser','Settings'; DISARM button title 'Disarm / Kill (Space)' → onDisarm, red when armed
- *Identical-line exceptions:* imports (react, lucide icons, StatusPill/Badge/IconButton, BatteryGauge/SignalGauge, logo asset); StatusBarProps baseline members and the destructuring list; teammate-attributed blocks (84ba7d75, a4d8efc9, 42b6941f, 2998c476) retained verbatim on purpose; header/kill-switch/pad-indicator style-token lines (statusbar height, surface-raised background, red-deep/glow-critical ternaries, radii), <img logo> line, Armed/Disarmed and mode label lines; copy strings 'DISARM', 'Disarm / Kill (Space)'; section-divider comments; blank lines; closing tags

**`platform/ground/ui/src/panels/index.ts`** — rewritten. Barrel now exports an explicit named surface for the seven flight-ops modules (components, prop types via `export type`, and the new pure helpers) instead of `export *`; the teammate-added mission-retrofit modules keep their `export *` lines unchanged. 0 lines trace to the baseline.

- *Preserved:* every previously re-exported name (StatusBar, ControlsPanel, SendCmd, ManualControl, TelemetryPanel, LogConsole, VideoPanel, MapPanel, MapTileSource, all *Props) is still exported from '@/panels'; export * for MissionMap, SatellitePanel, VerifierPanel, ReportPanel, AuditLogPanel, ObservationPanel, MissionStatusStrip, SimulationPanel, TaskPlanPanel unchanged
- *Identical-line exceptions:* teammate `export *` lines for the nine retrofit panels (cd7e25c6/42b6941f/84ba7d75) kept verbatim

**`platform/ground/ui/test/ui-panels-manual-input.test.ts`** — added. 15 tests: dead-zone/clamp/NaN, standard-mapping axes incl. missing axes, WASD/arrow mapping and opposed-pair cancel, key ownership (Space never claimed), release button index, sameInput, padDisplayName, formatChannel, and server-rendered ManualControl gating (Arm first / Take off first / Hold to take control, engage vs release control, keyboard hint).

**`platform/ground/ui/test/ui-panels-formatting.test.ts`** — added. 16 tests over StatusBar (flight clock, GPS fix labels, connection pill, host caption, pad indicator), LogConsole (filters, tag widths, local clock, NaN), TelemetryPanel (battery bands, vertical trend, sparkline path) and ControlsPanel (airborne threshold, flight gates, mode chips, tracking pill).

**`platform/ground/ui/test/ui-panels-video-source.test.ts`** — added. 12 tests: videoSourceKind for empty/unknown/mjpeg/http(s)/webrtc/whep/rtsp, whepEndpoint normalisation, targetCaption, TRACK_CHIP table, and server-rendered VideoPanel markup per connection state and source (canvas vs <img> vs <video> vs RTSP note, boxes/HUD/chip only when connected, HUD hidden without a range, REC badge).

**`platform/ground/ui/test/ui-panels-map-geometry.test.ts`** — added. 11 tests with leaflet/react-leaflet stubbed via vi.mock: offsetByBearing (north/east, cos-latitude stretch, zero), targetPosition (null cases, estimated vs assumed range, missing heading), clampZoom per provider, tileBadge, mapCoordLabel, and server-rendered MapPanel chrome (badge, geofence legend, readout, tile source).

**`platform/ground/ui/test/ui-panels-render.test.ts`** — added. 18 server-rendered markup tests: StatusBar (pre-telemetry state, MOCK/SITL/LIVE badge incl. sourceKind 'hub' → LIVE, armed/GPS/PAD/MANUAL, optional tool buttons, fleet selector + envelope + attendance + outbox), ControlsPanel (disabled attributes per gate, Arm/Disarm swap, mode chip aria-pressed, Disengage while tracking, gimbal readout), TelemetryPanel (zeros/dashes, live values, target range only when locked), LogConsole (rows/tags/count, empty state, record toggle, browser button).

Tests added:

- platform/ground/ui/test/ui-panels-manual-input.test.ts (15 tests)
- platform/ground/ui/test/ui-panels-formatting.test.ts (16 tests)
- platform/ground/ui/test/ui-panels-video-source.test.ts (12 tests)
- platform/ground/ui/test/ui-panels-map-geometry.test.ts (11 tests)
- platform/ground/ui/test/ui-panels-render.test.ts (18 tests)

Caveats and deliberate deltas:

- Behaviour refinements beyond the baseline, all within the contract: (a) ManualControl B-button release is rising-edge (baseline re-fired disengageManual + toast every frame while held); held keys are cleared on window blur and when manualActive drops; panel state updates only when the sampled frame changes (onInput rate unchanged: once per animation frame). (b) MapPanel marker icons dropped the inner translate(-50%,-50%) that, on top of a centred iconAnchor, drew every marker offset by half its icon size; zoom state now mirrors wheel/pinch zooms; offsetByBearing uses the WGS-84 mean radius (111,195 m/deg vs the baseline's 111,320 — sub-centimetre at standoff ranges). (c) VideoPanel trims the URL, MJPEG wins over an rtsp: scheme (baseline rendered <img> AND the RTSP note for rtsp://…/mjpeg), and WHEP teardown aborts the in-flight POST. (d) LogConsole auto-scroll keyed on the filtered array instead of logs.length (baseline stopped following once App's 200-entry ring buffer filled). (e) formatFlightTime clamps negative/fractional input (App only passes non-negative integers).
- Mode chip labels: kept the teammate logic verbatim — sourceKind 'mock' → MOCK, else sitl → SITL, else LIVE. No 'HUB' label exists anywhere in the codebase, so sourceKind 'hub' still displays LIVE; the task text mentioned HUB but adding a label would change teammate behaviour.
- panels/index.ts now uses explicit named exports for the seven flight-ops modules: a new symbol added to one of those modules must also be added to the barrel (teammate modules still use export *). Tests import the panel modules directly, not the barrel, because importing MapPanel pulls leaflet, which touches window/document at import time (the map test stubs leaflet and react-leaflet with vi.mock).
- Residual git blame -w -M -C attributions to 70c24dbc remain (see command outcomes) because -M/-C attributes any ≥20-alphanumeric line that also exists in the baseline; every remaining line is in a permitted exception category and no logic block survived as a unit. Section-divider comment lines (/* ---- */) are a repo convention and were kept.
- The 5 eslint warnings are pre-existing in src/argus/ (not my area) and unchanged. The vite chunk-size warning is pre-existing.
- The main checkout's git status listed platform/ground/ui/src/panels/StatusBar.tsx as modified, but its content was byte-identical to HEAD/worktree at start, so there is nothing extra to merge from the main checkout for this file.
- Electron shells and planner were not touched and their checks were not run (no contract mirror or shell file changed). Electron shells import nothing from panels/.

### Area `ui-app-datasources`

**`platform/ground/ui/src/App.tsx`** — rewritten. The shell logic that the baseline held in one component body (toasts, flight recorder, 1 Hz history/trail/timer sampling, modal routing, the checklist -> arm -> takeoff -> engage -> disarm and manual flows, keyboard shortcuts, display wake lock) is now a set of single-purpose hooks plus ToastStack and ModalHost components.

- *Preserved:* Every panel prop and every callback signature the panels receive; Teammates' planner, verifier, satellite, readiness, fleet and SDR flows are unchanged

**`platform/ground/ui/src/dataSource/LiveDataProvider.ts`** — rewritten. Rebuilt from the wire contract: typed fan-out channels, a static inbound routing table, an ack ledger that correlates by command name FIFO (the ack path carries no requestId) and synthesises failure acks on timeout, send error or link loss, an epoch-guarded socket session with exponential backoff, fire-and-forget manualInput, and an injectable socket factory so the transport can be faked in tests.

- *Preserved:* DataSource interface and provider construction; Wire message names and shapes from contract/index.ts; manualInput is fire-and-forget and never acked per frame; only engage/disengage are acked

**`platform/ground/ui/src/dataSource/MockDataProvider.ts`** — rewritten. A channel hub replaces the callback registry. A velocity-integrating airframe (phase machine, manual sticks with the contract watchdog and speed cap, follow/hover guidance, pack and link models) replaces the baseline's lerp kinematics; tracking is a deadline-driven model; commands go through a handler table with latency-modelled acks; standoff, speed and takeoff set-points are clamped to DEFAULTS.

- *Preserved:* Scenario timings; Mission, envelope, peer, attendance and cue-bus rails; DataSource interface

**`platform/ground/ui/src/dataSource/index.ts`** — rewritten. Provider selection is a kind -> factory table instead of a branch chain.

- *Preserved:* Mock/live/hub selection semantics and the exported factory name

Tests added:

- platform/ground/ui/test/ui-datasource-live.test.ts
- platform/ground/ui/test/ui-datasource-mock.test.ts

Caveats and deliberate deltas:

- The area's structured report was lost; this entry is derived from the commit message and diff of `3152e98`.

### Area `companion-control`

**`platform/companion/src/eis_companion/control/pid.py`** — rewritten. PID split into an immutable PIDGains record, an immutable PIDState (integral, prev_error) and a pure pid_step(gains, state, error, dt) -> (output, next_state). The PID dataclass is now a thin facade holding a PIDState (_memory) and delegating update() to pid_step. Anti-windup is the tracking form (integrator re-solved by the saturation excess so P+I+D sits on the bound) instead of clamping the I contribution in place; integral_limit still caps the raw sum. dt<=0 = no time elapsed (no integrate, no derivative, sample remembered); first step forms no derivative; non-finite error/dt returns 0.0 with state untouched. New exports PIDGains, PIDState, pid_step and read-only .gains/.state properties. Blame after commit: 33/190 lines attributed to baseline, all listed below.

- *Preserved:* PID(kp, ki, kd, out_min, out_max, integral_limit) positional/keyword field order (used as PID(*gain_triple) and PID(1.0,0.5,0.1,out_min=..,out_max=..)); update(error, dt) -> float clamped to [out_min,out_max]; reset(); set_gains(kp=None, ki=None, kd=None) without state reset; non-finite error/dt -> 0.0 and no state poisoning (test_nonfinite_safety); dt<=0 skips derivative and integral; no derivative kick on first call; __all__ still exports PID (extended with PIDGains, PIDState, pid_step)
- *Identical-line exceptions:* module docstring delimiters and 'from __future__ import annotations'; @dataclass / class PID: header and the six field declarations kp/ki/kd/out_min/out_max/integral_limit with their default values (positional API); def reset(self) -> None: and def update(self, error: float, dt: float) -> float: signatures; set_gains keyword signature line and its three 'if X is not None: self.X = float(X)' coercion pairs (the documented live-retune contract); docstring fragments 'Args:' and 'kp, ki, kd: gains.'

**`platform/companion/src/eis_companion/control/distance.py`** — rewritten. Pinhole model factored into a PinholeCamera NamedTuple (focal_px, frame_h_px) with from_vfov() and range_to(object_height_m, image_height_px, max_distance_m). estimate_distance and estimate_distance_px are thin adapters over it sharing one _positive_finite() admission helper and a _half_fov_tangent() intrinsic helper. estimate_distance never raises (invalid camera/subject -> None) because it runs per frame inside the tracker; focal_px_from_vfov keeps raising ValueError for bad intrinsics. Blame after commit: 64/177 lines, all signatures/constants/__all__/docstring fragments.

- *Preserved:* DEFAULT_PERSON_HEIGHT_M=1.7, DEFAULT_VFOV_DEG=41.0, DEFAULT_FRAME_HEIGHT_PX=720; focal_px_from_vfov(vfov_deg, frame_h_px) -> f_px = (frame_h/2)/tan(vfov/2); ValueError('frame_h_px must be positive') / ValueError('vfov_deg must be in (0, 180)'); estimate_distance(bbox_h_norm, *, person_height_m, vfov_deg, frame_h_px, max_distance_m=100.0) -> Optional[float]; None for None/<=0/<1e-4/non-finite; capped at max_distance_m; frame height cancels; estimate_distance_px(bbox_h_px, *, focal_px, person_height_m, max_distance_m=100.0) -> Optional[float]; __all__ preserved (PinholeCamera added)
- *Identical-line exceptions:* module docstring delimiters, 'from __future__ import annotations', 'import math'; the three DEFAULT_* constant lines (documented camera defaults); def focal_px_from_vfov(...) signature and its two ValueError message lines (pinned messages); estimate_distance / estimate_distance_px keyword signatures and default values (public API); 'return None' lines, 'Args:' and one 'vfov_deg: ...' docstring line; __all__ list entries (declaration)

**`platform/companion/src/eis_companion/control/tracker.py`** — rewritten. Generic matrix KalmanFilter(x0, P0, H, R) with predict(F, Q) and correct(z) using a linear solve for the gain (K = solve(S, H P).T) and the Joseph-form covariance update; correct() returns False instead of committing on singular S or non-finite results. BoxFilter specialises it to an 8-state constant-velocity model over [cx,cy,w,h] with discrete white-noise-acceleration process noise Q(dt) (plus a small floor) and R=4e-4, exposing centre/size/bbox/state. Association is a vectorised _iou_matrix (n x m, numpy broadcasting) reduced by best-first argmax assignment (_greedy_pairs) rather than a sorted pair list. Detection admission is one _measurement() pass that also yields the (cx,cy,w,h) vector. State resolution is a transition table _UNLOCKED_NEXT[prev][tracks_exist] plus the lock-freshness rule. ids come from an iterator; timestamps resolve via a candidate chain (ts arg, first admitted obs.ts, previous frame, 0.0) with non-finite rejected and dt clamped >=0. iou() is the 1x1 case of the matrix routine. Blame after commit: 159/541 lines, listed below.

- *Preserved:* Tracker(*, iou_threshold=0.3, max_age=1.5, lost_timeout=1.0, min_hits=2, vfov_deg=41.0, frame_h_px=720, person_height_m=1.7) with same-named public attributes; select(target_id|None), locked_id, state, update(observations, ts=None) -> TrackingResult; TrackingResult(state, targets, locked_target_id, estimated_distance, ts) + locked_bbox; DetectedTargetView(id, bbox, confidence, is_locked) - shapes consumed by app.py _tracking_message/_guidance_setpoint; Track dataclass fields id/kf/conf/hits/age/time_since_update/last_ts and bbox/cx/cy/height properties; idle->searching->locked->(coast<=lost_timeout)->lost->searching; culled after max_age; never back to idle; unconfirmed tracks not surfaced unless locked; auto-lock = 0.7*conf + 0.3*centrality among confirmed; select(None) clears immediately, unknown id stays pending; non-finite bbox/conf dropped at ingest; surfaced boxes clipped to [0,1] with non-finite -> 0.0; iou(a,b) semantics (0.0 when disjoint / zero area); __all__ preserved (KalmanFilter, BoxFilter added)
- *Identical-line exceptions:* module docstring first line and delimiters, 'from __future__ import annotations', 'import numpy as np', the two relative import lines; Tracker.__init__ keyword signature with default values and the seven 'self.X = X' attribute assignments (config contract), plus '_tracks', '_locked_id', '_state' initialisers; select/locked_id/state/update signatures, '@property' decorators, 'if target_id is None: self._locked_id = None' (documented select semantics); Track/DetectedTargetView/TrackingResult dataclass declarations (fields, docstrings, locked_bbox signature, 'return None'); iou(a, b) two-line signature and 'return 0.0'; 'self.x = F @ self.x' (the Kalman predict equation), 'self._cull()', 'self._resolve_lock()', 'continue', 'del self._tracks[tid]', the estimate_distance keyword-argument lines and the TrackingResult(...) keyword lines; __all__ list entries

**`platform/companion/src/eis_companion/control/guidance.py`** — rewritten. Guidance now computes a centroid error VECTOR (_centroid_error, deadzone applied with np.where) and keeps the three PIDs in a dict keyed yaw/vz/vx. Channel outputs are assembled into one 4-vector [vx,vy,vz,yaw_rate] and pushed through an explicit stage pipeline: _clamp_vector (bounds vector from Limits, non-finite -> 0) -> _standoff_gate (pure: positive vx only when a finite distance strictly exceeds standoff) -> EMA smoothing against a stored _filtered vector -> _standoff_gate again on the emitted value -> _clamp_vector again. When the range is unusable the vx channel is reset (no stale derivative/integral when the range returns) rather than fed a zero error. set_max_speed ignores a non-finite request (leaves the limit unchanged) and stays cap-agnostic. Blame after commit: 73/229 lines, all signatures/imports/docstring fragments plus the two one-line set_standoff body lines that ARE the Limits contract.

- *Preserved:* Guidance(*, yaw_gains=(90,0,4), vz_gains=(2,0,0.1), vx_gains=(0.6,0,0.05), smoothing=0.4, center_deadzone=0.03); update(tracking_state: TrackingState|str, locked_bbox, est_distance, limits, dt) -> VelocitySetpoint; only 'locked' + bbox produces motion, otherwise reset + hold(); HARD STANDOFF: vx<=0 when distance is None/non-finite or <= limits.standoff, asserted on raw and emitted values; back-off always allowed; every axis clamped to Limits before and after smoothing; vy always 0; set_standoff(meters, limits) -> limits.standoff = limits.clamp_standoff(meters) (3 m floor / 50 m ceiling); set_max_speed floors at min_speed only (app.py applies the 8 m/s cap); set_gains(yaw=,vz=,vx=); reset(); closed-loop convergence dynamics unchanged (same gains, same EMA alpha) so test_standoff_never_breached passes from 20/12/8/6/5.5 m; reset is a plain method (test_failsafe_latches monkeypatches it as an instance attribute)
- *Identical-line exceptions:* docstring delimiters, the 'HARD STANDOFF (PRD 11, non-negotiable)' heading and its underline, 'from __future__ import annotations', the two relative import lines; __init__ keyword signature with default gain triples (config contract) and 'self._alpha = float(smoothing)' / 'self._center_deadzone = float(center_deadzone)'; set_standoff signature and its two-line body 'limits.standoff = limits.clamp_standoff(meters)' / 'return limits.standoff' (the Limits contract itself); set_max_speed signature and 'return limits.max_speed'; set_gains keyword signature; reset signature; update() signature lines and 'Compute the next BODY-frame velocity setpoint.' docstring line; 'self.reset()' / 'return VelocitySetpoint.hold()' hold branch; 'return VelocitySetpoint(' / 'valid=True,' / ')'; __all__ = ["Guidance"]

**`platform/companion/src/eis_companion/control/manual.py`** — rewritten. Stick frames are numpy 4-vectors in contract order (throttle, yaw, pitch, roll) mapped to body axes by a fixed _STICK_TO_BODY matrix times a per-axis bounds vector from Limits, replacing four scalar assignments. Admission is a single _admit_frame() (four finite axes -> saturated vector via _clamp01, else None) shared by set_input and feed. The watchdog is a small _Deadman object (arm/disarm/expired); ONLY an admitted frame arms it - update() replays the stored frame through the pipeline without extending the window, so a silent ground station trips the pilot's own watchdog on schedule (baseline update() re-armed it every tick). Deadzone is a vectorised rescale (_apply_deadzone) that treats dz<=0 as pass-through and dz>=1/non-finite as fully centred. Smoothing is an EMA on a _filtered vector; watchdog/link trips and engage/release call _rest() which zeroes the memory and emits hold(). release()/reset() forget the stored frame. _clamp01 kept as the scalar axis saturation primitive (imported by test_nonfinite_safety). Blame after commit: 72/300 lines, listed below.

- *Preserved:* ManualPilot(*, smoothing=0.5, clock=None); engaged property; engage(); release() -> hold(); reset(); set_input(throttle, yaw, pitch, roll) -> bool; update(limits, dt, *, link_ok=True); feed(manual_input, limits, dt, *, link_ok=True); axis mapping and signs (throttle>0 -> vz<0 NED up; yaw>0 -> yaw_rate>0; pitch>0 -> vx>0; roll>0 -> vy>0) scaled to max_speed/max_climb_rate/max_yaw_rate and clamped there; deadzone with continuous rescale past the edge; set_input rejects a frame with any non-finite axis WITHOUT refreshing the watchdog (FM-05); _clamp01(nan) == 0.0; watchdog zero-and-hold (valid=False, all zero) after manual_watchdog_ms; link_ok=False -> immediate hold; disengaged -> hold; inside the window feed(None) re-issues the last emitted setpoint; engage() re-arms; _clamp01 module-level name retained (private import in test_nonfinite_safety.py); reset is a plain method (monkeypatched in test_failsafe_latches)
- *Identical-line exceptions:* docstring delimiters and the fragment 'autonomous guidance.', 'from __future__ import annotations', the three import lines; def _clamp01(v: float) -> float: signature; class ManualPilot: / __init__ keyword signature and 'self._alpha = float(smoothing)'; engaged property (decorator, signature, 'return self._engaged'); engage/release signatures with 'self._engaged = True/False'; set_input signature lines with axis defaults; 'if not self._engaged: self.engage()' (documented auto-engage); update() and feed() signatures; feed docstring 'Args:' + manual_input line; 'return VelocitySetpoint.hold()', 'valid=True,', ')' and __all__ = ["ManualPilot"]

**`platform/companion/src/eis_companion/control/__init__.py`** — partially-rewritten. Module docstring rewritten to describe the new decomposition (servo core vs mission/assurance groups, the pipeline names, the pure records). Import list and __all__ are declarations and were kept verbatim so the package export surface is byte-for-byte unchanged; teammates' lines (envelope/failsafe/mode/gimbal/planner_exec imports, their docstring lines and exports, commits 4436bf0a/4ced3133/cffad208) are intact. Blame after commit: 38/108 lines attributed to baseline - entirely the docstring first line/delimiters, the import statements and the __all__ entries.

- *Preserved:* package __all__ (33 names) unchanged; all from-imports unchanged, including teammates' envelope/failsafe/gimbal/mode/planner_exec groups; closing docstring paragraph about envelope/guidance separation kept verbatim (teammate text)
- *Identical-line exceptions:* docstring delimiters and the first line 'eis_companion.control -- the safety-critical control core.'; 'from __future__ import annotations'; from .distance / .guidance / .manual / .pid / .tracker import blocks (interface declarations); __all__ list and every entry (export declaration)

**`platform/companion/tests/test_manual.py`** — rewritten. Behavioural suite rebuilt around fixtures (StepClock, limits, an engaged unsmoothed pilot), a SimpleNamespace stick() builder and an is_hold() predicate; axis signs are one parametrised test over (axis, field, sign). Every asserted behaviour of the baseline file is retained: full deflection lands on each limit with correct signs, per-axis signs, overdriven sticks clamp, deadzone swallows 0.05 and is continuous at 0.10, watchdog expiry -> hold, inside-window replay then trip at 0.6 s, link loss -> hold, disengaged -> hold, release -> hold and stays disengaged, engage opens a fresh window. Blame after commit: 72/186 lines - imports, the Limits(...) fixture literal, section banners and one-line assert statements.

- *Preserved:* all 11 pinned manual behaviours and their numeric values (limits 2.0/0.5/1.5/45/0.09/500 ms; 0.05 and 0.10 deadzone probes; 0.3+0.3 s window probe; 10 s pre-engage gap)
- *Identical-line exceptions:* docstring delimiters, 'numpy + stdlib only.', 'from __future__ import annotations', 'import pytest', the two eis_companion import lines; 'def __call__(self) -> float:' on the fake clock; the Limits(...) fixture literal (six keyword lines) - the pinned test envelope; '# ----' section banner lines and the headings 'Deadzone' / 'Engage / release lifecycle'; single-line asserts: 'assert sp.valid is True/False', 'assert sp.vx == 0.0', 'assert sp.vx > 0.0', the all-zero tuple assert, 'sp = VelocitySetpoint.hold()'

**`platform/companion/tests/test_tracking.py`** — rewritten. Behavioural suite rebuilt around a box() observation builder and a run_frames(tracker, frames, start) driver that feeds per-frame detection lists DT apart, so lifecycle tests read as frame sequences. Every baseline assertion is retained: IoU identical/disjoint/half-overlap, one id for a drifting person, two ids for two people, auto-lock prefers the central confident person (cx in 0.4..0.6), LOCKED after confirmation, explicit select overrides, coast (LOCKED, same id) -> LOST -> culled with lock None, re-acquisition after loss, distance present when locked / absent when idle / taller box closer, locked_bbox mirrors the locked target. Blame after commit: 53/182 lines - imports, importorskip, banners, two IoU asserts, one loop header.

- *Preserved:* all 12 pinned tracking behaviours with the same tracker parameters (iou_threshold 0.2, min_hits 1/2, lost_timeout 0.5/0.3, max_age 5.0/0.5) and frame counts
- *Identical-line exceptions:* docstring delimiters, 'from __future__ import annotations', 'import pytest', 'np = pytest.importorskip("numpy")'; 'return TargetObservation(bbox=(x, y, w, h), conf=conf, ts=ts)' builder body; '# ----' banners and the headings 'IoU', 'Locking', 'Lifecycle: lock -> occlusion coast -> lost -> searching', 'Estimated distance', 'locked_bbox convenience'; the two one-line IoU asserts (identical == 1.0, disjoint == 0.0), 'for i in range(10):', 't = 0.0', 'def test_explicit_select_overrides_autolock():'

**`platform/companion/tests/test_guidance.py`** — rewritten. Behavioural suite rebuilt around a centred_box() helper, a limits fixture, a closed_loop() generator that integrates the forward command into the range and yields it per tick (the headline gate is parametrised over start distances and asserts every tick), and a last_of() driver for settle tests. Every baseline assertion is retained: standoff never breached + converges within 0.1 m from 20/12/8/6/5.5 m, approach when far, rest at standoff, back off inside, unknown range never approaches, non-locked states hold, locked without box holds, all axes within limits under an extreme box, yaw/vz servo signs, set_standoff floor, set_max_speed floor, higher gain -> larger first response. Blame after commit: 79/167 lines - imports, the Limits(...) fixture literal, banners, parametrize line and one-line asserts.

- *Preserved:* all 13 pinned guidance behaviours with the same numbers (limits 2.0/0.5/1.5/45/standoff 5/min 3; dt 0.1; 600/10/50/20/50/200 ticks; extreme box (0.9,0.05,0.05,0.05) at 50 m; 1e-6 tolerance)
- *Identical-line exceptions:* docstring delimiters, 'numpy + stdlib only (no hardware, no FC).', 'from __future__ import annotations', 'import pytest', the Guidance import line; the Limits(...) fixture literal (six keyword lines) - the pinned test envelope; '# ----' banners and headings 'HARD STANDOFF -- the primary acceptance gate', 'Clamping to Limits', 'Servo signs', 'Tuning hooks'; '@pytest.mark.parametrize("state", ["lost", "searching", "idle"])'; single-line asserts/loops: 'assert sp.vx > 0.0', 'assert sp.valid is True/False', 'assert sp.vx <= 0.0', 'for _ in range(50):', 'for _ in range(200):', 'assert sp.yaw_rate > 0.0', 'assert sp.vz < 0.0', 'assert abs(hi.yaw_rate) > abs(lo.yaw_rate)', 'sp = None'

**`platform/companion/tests/test_control_pid.py`** — added. 19 tests: output band (parametrised errors, swapped band tolerated, P linearity); anti-windup (integrator stores exactly the band after 100 saturated steps and answers a reversal on the very next step; integral_limit caps the sum; integrator idle while ki==0); dt handling (dt==0 and dt<0 integrate nothing, form no derivative, remember the sample; first step has no derivative; derivative follows error rate); refusal (non-finite error/dt leave PIDState untouched and output 0.0; garbage types); facade API (positional gain-triple construction and .gains record, set_gains leaves memory alone, reset clears, pid_step is pure).

**`platform/companion/tests/test_control_standoff.py`** — added. 29 tests over the hard floor and the clamp stage: Limits.min_standoff default 3.0; clamp_standoff closed band [3,50] and garbage -> current value; clamp_speed band; Guidance.set_standoff never undercuts the floor for -5/0/1/2.999/nan/-inf and returns what it applied; set_max_speed floors and ignores NaN; no forward command at or inside standoffs 3/5/10/50 for offsets -2/-0.01/0 over 30 ticks; forward beyond standoff positive and <= max_speed; range dropout (None and non-finite) or a jump inside mid-approach cuts vx on that same tick (no smoothing leak); raising the standoff under an approach is honoured immediately; lock loss clears smoothing memory; every axis clamps under 1e6 gains; NaN/inf gains and a NaN limit produce 0.0 on that axis only; vy never commanded.

**`platform/companion/tests/test_control_manual_watchdog.py`** — added. 33 tests (incl. parametrised): update() never extends the deadman window (0.6 s of ticks -> hold) while 50 ms set_input refreshes keep it live; update() replays the stored frame and converges as max_speed*(1-0.5^n); a fresh frame after expiry or after link loss ramps from zero (no coast); reset() forgets the frame; set_input auto-engages; a non-finite axis (3 values x 4 axes) rejects the frame and does not refresh; feed() rejects a non-finite or axis-missing object whole without refresh; _clamp01 table; negative deflection signs; each stick drives exactly one body axis; rescaled limits rescale output; deadzone edge continuity, dz=0 pass-through, full deflection still reaches the limit, dz>=1/NaN reads centred.

**`platform/companion/tests/test_control_tracker_states.py`** — added. 27 tests: first empty frame idle; unconfirmed track = searching and unsurfaced; confirmation locks; exact tick-by-tick sequence LOCKED,LOCKED,LOST,LOST,LOST,LOST,SEARCHING,SEARCHING for lost_timeout 0.25/max_age 0.6; idle never revisited; re-acquisition mints a larger new id; select(None) resumes auto-selection; select of an unborn id stays pending until it appears; explicitly selected unconfirmed track surfaced as locked; a live lock is not stolen by a stronger newcomer; a coasting lock keeps moving along its estimated velocity and re-associates with the reappearing person; time never runs backwards (earlier/NaN ts = zero step); ts defaults (observation, then last frame, then 0.0); non-finite confidence and malformed bbox dropped; surfaced boxes inside the unit square; KalmanFilter predict/correct maths, singular-S and NaN refusals; BoxFilter dim floor and bbox geometry; iou value table.

**`platform/companion/tests/test_control_distance.py`** — added. 38 tests (incl. parametrised): 90-degree FOV reduces to Z = H/(2h); frame height cancels for 480/720/1080/2160; pixel and normalised paths agree; range monotone in box height and person height; documented defaults; sliver capped at 100 m or a custom cap; unusable heights (None/0/negative/sub-floor/nan/inf/str/object) -> None; invalid camera or subject (vfov 0/180/negative/nan, frame 0/negative, height 0/inf) -> None; pixel path refuses bad height/focal; focal_px_from_vfov geometry and ValueError table; PinholeCamera round trip.

Tests added:

- platform/companion/tests/test_control_pid.py
- platform/companion/tests/test_control_standoff.py
- platform/companion/tests/test_control_manual_watchdog.py
- platform/companion/tests/test_control_tracker_states.py
- platform/companion/tests/test_control_distance.py
- platform/companion/tests/test_manual.py (rewritten behavioural suite, all baseline assertions kept)
- platform/companion/tests/test_tracking.py (rewritten behavioural suite, all baseline assertions kept)
- platform/companion/tests/test_guidance.py (rewritten behavioural suite, all baseline assertions kept)

Caveats and deliberate deltas:

- Behaviour change (safer, matches the documented contract): ManualPilot.update() no longer refreshes the input watchdog; only an admitted stick frame (set_input/feed) does. In the baseline, update() re-armed the watchdog every tick, so the pilot-level watchdog could never trip through the orchestrator path (app.py's own _last_manual_input_ms gate was the only working one). UI cadence is 60 Hz (LiveDataProvider) / 10 Hz (Hub), both well inside the 500 ms window. Pinned by test_control_manual_watchdog.py.
- Behaviour change: ManualPilot.release() (and reset()) now forget the stored stick frame; the baseline kept _pending across release()->engage() so an update() after re-engage replayed a stale frame. app.py already calls reset() on engage/expiry.
- Behaviour change: ManualPilot.feed() with a non-finite or axis-missing input now rejects the whole frame without refreshing the watchdog (same rule as set_input, FM-05); the baseline centred only the bad axis and DID refresh. No caller passes such objects; only tests exercise feed() directly.
- Behaviour change: Guidance.set_max_speed with a non-finite request leaves limits.max_speed unchanged (baseline: max(min_speed, nan) collapsed it to min_speed). app.py normalises NaN to the 8 m/s cap before calling, so the wire path is unaffected.
- Design change: when the range is unusable, Guidance resets the vx PID instead of feeding it a zero error; identical output with the default vx ki=0, and it avoids a derivative kick when the range returns.
- Behaviour change: estimate_distance() never raises - an invalid camera (vfov <=0, >=180, NaN; frame_h <=0) or subject height now returns None instead of ValueError; focal_px_from_vfov still raises. vfov exactly 180 deg is now rejected (baseline accepted it and produced a ~0 focal length).
- Tracker filter tuning changed with the model: DWNA constant-velocity process noise (intensity 0.5, floor 1e-6) and R=4e-4 instead of constant Q=1e-3/R=1e-2, so filtered boxes follow measurements more tightly and coasting follows the estimated velocity. Not pinned by any test; recommend a SITL e2e run (make e2e under WSL2 - SITL cannot run natively on Windows) before merging.
- Association tie-break differs only for exactly equal IoUs (argmax picks the lowest det/track index; baseline sorted (score, det_idx, track_id) descending).
- New public names added at module level only (package __all__ untouched): pid.PIDGains/PIDState/pid_step, distance.PinholeCamera, tracker.KalmanFilter/BoxFilter. The private manual._clamp01 name is retained because tests/test_nonfinite_safety.py imports it.
- Remaining git blame -w -M -C baseline attribution is non-zero because that mode ignores whitespace and matches structurally identical declaration lines; the identical_exceptions lists per file are exhaustive for the non-blank attributed lines and contain no algorithmic code.
- The known pre-existing failure test_resolve_default_is_site_json_at_repo_root did not reproduce: run from <WT>\platform as the brief instructs, the full suite was 840 passed both before and after the rewrite.
- Git prints 'LF will be replaced by CRLF' warnings for the touched files: core.autocrlf=true, the index stores LF (git ls-files --eol: i/lf), so the committed content is LF like the rest of the repo.

### Area `electron-shells`

**`platform/ground/app/windows/src/settingsStore.ts`** — rewritten. Two-layer persistence: `JsonDocumentFile` (lazy locate, async read → discriminated `SettingsDecodeOutcome` loaded/empty/repaired/corrupt, quarantine of an unparsable file to `settings.json.corrupt`, atomic temp-sibling + rename write with plain-overwrite fallback) under `createSettingsStore(locate)` which keeps entries in a `Map` (no prototype keys; `__proto__`/`constructor`/`prototype` dropped at decode) and pushes get/set/all through one serial promise queue (read-your-writes; `set()` resolves after the bytes are on disk; `set(key, undefined)` deletes). Exports `settingsStore` (singleton at <userData>/settings.json), `createSettingsStore`, `decodeSettingsDocument`, `encodeSettingsDocument`, `SETTINGS_SCHEMA`, `SettingsStore`, `SettingsEntries`, `SettingsDecodeOutcome`. Baseline was a module-level cached plain object with sync whole-file rewrites.

- *Preserved:* `settingsStore.get<T>(key) → Promise<T|undefined>`, `.set(key, value) → Promise<void>`, `.all() → Promise<Record<string, unknown>>` (consumed by ipc.ts; UI stores key `eis.settings`); File location `<userData>/settings.json` via `app.getPath('userData')`; On-disk layout unchanged: single flat JSON object, `JSON.stringify(entries, null, 2)`; files written by the old implementation load byte-for-byte (self-check covers this); Missing file → empty; corrupt file → start fresh (now additionally preserved as `*.corrupt`); Directory created on first write
- *Identical-line exceptions:* import lines: `import * as fs from 'fs'`, `import * as path from 'path'`, `import { app } from 'electron'`; the three contract method signatures `get<T = unknown>(key: string): Promise<T | undefined> {`, `set(key: string, value: unknown): Promise<void> {`; comment delimiters, blank lines, closing braces, `try {` / `} catch {` skeleton lines

**`platform/ground/app/windows/src/recorder.ts`** — rewritten. Decomposed into `RecordingCodec` (pattern-driven `sessionId(Date)` from `SESSION_ID_PATTERN='yyyyMMdd-HHmmss-SSS'`, `headerLine` with reserved keys `_header/id/startedAt` winning over meta, `frameLine` returning null for frames with no JSON form, `parseHeader`, CRLF-tolerant `lines`), `RecordingsDirectory` (per-call `EIS_RECORDINGS_DIR` resolution, chunked 4 KiB head-line reader up to 64 KiB, name-sorted `index()` with header+stat), `OpenSession` (one file descriptor per session opened with 'w', `fs.writeSync` per frame, dropped-frame counter, close on stop) and the `createRecorder(fallbackDir)` facade. `load()` validates the id (no path separators/NUL/`..`), resolves by filename and falls back to a header-id lookup; `start()` closes any active session first and suffixes `-n` on a same-millisecond filename collision. Exports `recorder`, `createRecorder`, `RecordingCodec`, `SESSION_ID_PATTERN`, `SESSION_FILE_EXT`, `FlightRecorder`, `SessionMeta`, `LoadedSession`. Baseline used a module-level `_active` and `appendFileSync` (open/close per frame) with a fixed 4096-byte header read.

- *Preserved:* `recorder.start(meta?) → Promise<{sessionId}>`, `stop() → Promise<{sessionId, path}|null>`, `append(frame): void` (fire-and-forget, no-op when idle, write errors swallowed), `list() → Promise<SessionMeta[]>`, `load(id) → Promise<{meta, frames}|null>`; Directory: `EIS_RECORDINGS_DIR` trimmed when non-empty, else `<userData>/recordings`; created on demand; File naming `<sessionId>.ndjson`; session id `yyyyMMdd-HHmmss-mmm` local time; Line 1 header `{"_header":true,"id":…,"startedAt":…, …meta}`, then one JSON document per frame; `load()` returns meta = header minus `_header`, skips malformed lines, null for missing/empty files; `list()` order (ascending by filename), fields id/path/startedAt/durationMs/size with the same fallbacks (id from filename, startedAt from birthtime, durationMs = max(0, mtime − startedAt), size = bytes); unreadable entries skipped; Recordings written by the previous implementation open unchanged (self-check writes a baseline-layout file with a torn line and blank lines and loads it)
- *Identical-line exceptions:* import lines (fs, path, electron app); `SessionMeta` interface members (id/path/startedAt/durationMs/size) — wire type mirrored in the UI; contract method signatures `start(meta: Record<string, unknown> = {}): Promise<{ sessionId: string }> {`, `stop(): Promise<{ sessionId: string; path: string } | null> {`, `append(frame: unknown): void {`, `list(): Promise<SessionMeta[]> {`; trivial statements: `return Promise.resolve({ sessionId: id })`, `return Promise.resolve(sessions)`, `return Promise.resolve({ meta, frames })`, `if (lines.length === 0) return Promise.resolve(null)`, `const sessions: SessionMeta[] = []`, `const frames: unknown[] = []`, `const filePath = path.join(dir, file)`, `const stat = fs.statSync(filePath)`; comment delimiters, blank lines, braces, try/catch skeleton lines

**`platform/ground/app/windows/src/preload.ts`** — rewritten. Bridge assembled from a single `CHANNEL` table and three relay builders — `request(channel)` (ipcRenderer.invoke), `post(channel)` (ipcRenderer.send, used only for recorder.append), `stream(channel)` (ipcRenderer.on with removeListener unsubscribe) — composed into `SettingsBridge`/`RecorderBridge`/`AppBridge` sub-interfaces and the `ElectronBridge` root. Only 'electron' is required (sandboxed preload). Baseline hand-wrote each method as an inline `ipcRenderer.invoke(...) as Promise<…>`.

- *Preserved:* `window.eis` shape exactly as `ground/ui/src/vite-env.d.ts` ElectronBridge: settings.{get,set,all}, recorder.{start,stop,append,list,load}, app.{version,platform}, defaultConfig, loadSiteFile, resolveSiteAsset, plannerPropose, plannerReport, onPlannerEvent, sdrStart, sdrStop, sdrStatus, onSdrEvent — names, argument shapes, return types; Channel names: settings:get/set/all, recorder:start/stop/append/list/load, app:version, app:defaultConfig, site:load, site:resolveAsset, planner:propose/report/event, sdr:start/stop/status/event; recorder.append is one-way (`send`), never acked per frame; `app.platform = process.platform`; `contextBridge.exposeInMainWorld('eis', …)`
- *Identical-line exceptions:* `import { contextBridge, ipcRenderer } from 'electron'`; `ConnectionConfig` and `RecorderSessionMeta` interface bodies (type mirrors of the UI contract); the bridge member signatures (get/set/all, start/stop/append/list/load, version/platform, defaultConfig) — mirrors of vite-env.d.ts; `platform: process.platform`, `const bridge: ElectronBridge = {`, `contextBridge.exposeInMainWorld('eis', bridge);`; comment delimiters and blank lines

**`platform/ground/app/windows/src/ipc.ts`** — rewritten. Rules extracted as exported pure functions — `defaultConnectionConfig(env)`, `selectSiteFile(env, root)`, `siteDirectory(env, root)`, `siteAssetDataUrl(requested, siteDir)` (containment via `path.relative`, MIME lookup table, readFile-try instead of existsSync+regex) — and `registerIpcHandlers()` walks two handler tables (`requests` → ipcMain.handle, `messages` → ipcMain.on) after calling `registerPhase3Handlers(root)`. Teammate behaviour kept: site:load selection (explicit EIS_SITE_FILE never falls back; site.json → site.stub.json), site:resolveAsset guards, FM-148 note (no satellite:loadTiles). Hardening deltas: non-numeric/out-of-range EIS_CONTROL_PORT falls back to 8765 instead of NaN; EIS_SITL compared trimmed+lowercased (superset of true/1/yes); resolveAsset returns null instead of throwing for an unreadable path.

- *Preserved:* Every channel and its semantics as listed in the file header; recorder:append via ipcMain.on (one-way); app:defaultConfig: host default 'sitl', controlPort default 8765, videoUrl default '', sitl = host==='sitl' || EIS_SITL∈{true,1,yes}; assetRoot: packaged → process.resourcesPath, else platform root (dist-electron/../../../..); site:load returns raw JSON text; site:resolveAsset returns `data:<mime>;base64,…` only for png/jpg/jpeg/webp strictly inside the site directory, tolerating a leading `site/` and backslashes; `registerPhase3Handlers(assetRoot())` still called first; phase3Host.ts untouched
- *Identical-line exceptions:* import lines (`ipcMain, app` from electron, settingsStore, recorder, phase3Host); `DefaultConnectionConfig` members + its doc comment; `return { host, controlPort, videoUrl, sitl };`; comment delimiters, blank lines, braces

**`platform/ground/app/windows/src/main.ts`** — rewritten. Split into `describeRuntime(env)` (dev flag + strict EIS_UI_PORT → `ShellRuntime`), `builtUiEntry()`, `looksLikeGroundUi(html)` + `probeDevServer()` (FM-131 identity probe, marker list instead of regex, same operator messages), `isNavigationAllowed(url, runtime)` + `guardNavigation(window)`, `menuFor(runtime)` (role-item builder), a `WINDOW_OPTIONS` constant, `openMainWindow()`/`focusMainWindow()` and `bootstrap()` (single-instance lock → second-instance → whenReady → IPC, menu, window, activate → window-all-closed). Drops the unused `ipcMain` import / `void ipcMain` hack. Pure helpers are exported for the self-check.

- *Preserved:* dotenv loaded from `platform/.env` (same `__dirname/../../../../.env`) before ipc.ts is required; IS_DEV = EIS_DEV==='true' || NODE_ENV==='development'; dev URL `http://localhost:${EIS_UI_PORT||5173}`; Single-instance lock: loser `app.quit(); process.exit(0)`; winner restores+focuses on second-instance; BrowserWindow 1440×900, min 1024×640, title 'Drone Safety Platform — Ground Control', background #09090b, show:false → ready-to-show; webPreferences contextIsolation/sandbox/webSecurity true, nodeIntegration false, allowRunningInsecureContent/experimentalFeatures false, only preload.js; will-navigate blocked (file:// or dev URL allowed) + shell.openExternal; window.open denied + openExternal; no CSP (FM-151 documents this as the accepted state — unchanged); Dev → loadURL(devUrl) + detached DevTools; packaged → resources/ui/dist/index.html; unpackaged → ground/ui/dist/index.html; Menu roles (about/hide/hideOthers/quit; resetZoom/zoomIn/zoomOut/togglefullscreen + reload/forceReload/toggleDevTools in dev; minimize/zoom/close); activate re-creates window; window-all-closed quits off darwin
- *Identical-line exceptions:* `import * as path from 'path'`, `import { registerIpcHandlers } from './ipc'`; BrowserWindow option lines (width/height/minWidth/minHeight and the webPreferences hardening flags) — contract constants; `let mainWindow: BrowserWindow | null = null;`; `shell.openExternal(url).catch(() => undefined);`; `if (mainWindow.isMinimized()) mainWindow.restore();` / `mainWindow.focus();`; `app.whenReady().then(() => {` + `registerIpcHandlers();`, `app.on('activate', () => {`, `app.on('window-all-closed', () => {` + `if (process.platform !== 'darwin') app.quit();`; comment delimiters, blank lines, braces

**`platform/ground/app/linux/src/settingsStore.ts`** — rewritten. Byte-identical mirror of the Windows settingsStore.ts (shared logic; the two src trees are kept in sync per CLAUDE.md).

- *Preserved:* Same as windows/src/settingsStore.ts; XDG userData path via app.getPath('userData')
- *Identical-line exceptions:* Same list as windows/src/settingsStore.ts

**`platform/ground/app/linux/src/recorder.ts`** — rewritten. Byte-identical mirror of the Windows recorder.ts.

- *Preserved:* Same as windows/src/recorder.ts (EIS_RECORDINGS_DIR honoured, PORT_AUDIT.md rows 32/61 still true)
- *Identical-line exceptions:* Same list as windows/src/recorder.ts

**`platform/ground/app/linux/src/preload.ts`** — rewritten. Windows preload.ts plus the Linux delta: `powerInhibit`/`powerRelease` channel entries, a `PowerBridge` interface and `power: { inhibit, release }` built with the same `request` relay. Diff against windows/src/preload.ts is exactly the power additions and a header note.

- *Preserved:* Everything in windows/src/preload.ts plus `window.eis.power.inhibit() → Promise<void>` and `.release() → Promise<void>` on channels power:inhibit / power:release (App.tsx power effect, vite-env.d.ts optional `power`)
- *Identical-line exceptions:* Same list as windows/src/preload.ts

**`platform/ground/app/linux/src/ipc.ts`** — rewritten. Windows ipc.ts plus `createPowerInhibitor(blocker: PowerSaveBlockerLike)` — an injectable, idempotent single-blocker holder (`prevent-display-sleep`) that re-acquires when the blocker was stopped externally — bound to the `power:inhibit` / `power:release` request-table entries. `powerSaveBlocker` imported from electron. Exported for the Linux self-check.

- *Preserved:* Everything in windows/src/ipc.ts plus power:inhibit (start one powerSaveBlocker('prevent-display-sleep') if none live) and power:release (stop it if live, clear id) — LINUX_PRD §7 semantics of the baseline handlers
- *Identical-line exceptions:* Same list as windows/src/ipc.ts (import line now also names powerSaveBlocker)

**`platform/ground/app/linux/src/main.ts`** — rewritten. Mirror of the Windows main.ts; differs only in the header (names the Linux shell and points at ipc/preload for the power delta) and the two path comments (ground/app/linux).

- *Preserved:* Same as windows/src/main.ts
- *Identical-line exceptions:* Same list as windows/src/main.ts

**`platform/ground/app/windows/build-resources/make_icon.py`** — rewritten. Geometry expressed as fractions of the canvas edge (ring 86/256, stroke 11/256, ticks 70→100, brackets at 96 with 22 arms, pupil 32, iris 12); `draw_mark(edge)` renders on a 1024 px master with polar tick placement and a `disc()` helper, then LANCZOS-downsamples to 256 and saves the multi-size ICO; `argparse` `--out`/`--png` preview; `main()` entry. Baseline drew directly on a 256 px canvas with absolute pixel maths at module level. Verified by py_compile and a stub-PIL smoke test asserting call sequence, geometry (ring box 168..856 at 1024, width 44, north tick 512,232→512,112) and the ICO size list.

- *Preserved:* Writes `icon.ico` next to the script by default; sizes 16/24/32/48/64/128/256; Same mark (ring + N/E/S/W ticks + four corner brackets + pupil/iris) in the same brand colours on a transparent ground; Requires Pillow only
- *Identical-line exceptions:* `import os`, `from PIL import Image, ImageDraw`; brand colour tuples (47,129,247), (90,160,255), (11,13,17) and the ICO size list — constants

**`platform/ground/app/linux/build-resources/make-icons.sh`** — rewritten. POSIX sh with `set -eu`, script-dir resolution via `cd "$(dirname "$0")" && pwd`, `die`/`have` helpers, `ICON_SIZE` env (validated integer, default 512) and an optional output-path argument, backend chosen once into a `rasterise()` function (rsvg-convert, then inkscape), non-empty-output assertion and a summary line naming backend and source. Verified with `bash -n`/`sh -n` and functional runs against a stub `rsvg-convert` (default/explicit output, ICON_SIZE=1024 from a foreign cwd, invalid size → exit 1, no backend → exit 1); the committed icon.png was not touched.

- *Preserved:* Reads `../../../../assets/logo-mark.svg` relative to the script = platform/assets/logo-mark.svg (unchanged path); Default output `icon.png` in build-resources at 512×512; rsvg-convert preferred, inkscape fallback; exit 1 with a message when neither is present or the SVG is missing
- *Identical-line exceptions:* `#!/bin/sh`, `else`, `fi`, bare `#` comment lines

**`platform/ground/app/windows/scripts/selfcheck.cjs`** — added. node:test suite (20 tests / 4 suites) that installs a fake `electron` module in `require.cache`, loads the compiled dist-electron modules and exercises them against a temp directory under os.tmpdir(): settings layout/legacy load/serialisation/delete/corrupt-quarantine/decode rules/default path; recorder id format, round-trip, legacy-file load with torn+blank lines, header-id lookup, path-escape ids, restart-closes-previous, long header, default dir and blank env override; ipc pure rules (defaultConfig, resolveAsset guards, site file selection); main runtime rules (dev/packaged, navigation policy, FM-131 markers). Run: `npm run build:electron && node scripts/selfcheck.cjs`.

**`platform/ground/app/linux/scripts/selfcheck.cjs`** — added. Same suite as the Windows script plus a 'power inhibitor' suite (22 tests / 5 suites): single blocker held across repeated inhibits, idempotent release, re-arm after release, re-acquire after an external stop. Run: `npm run build:electron && node scripts/selfcheck.cjs` in platform/ground/app/linux.

Tests added:

- platform/ground/app/windows/scripts/selfcheck.cjs — run: `cd platform/ground/app/windows && npm run build:electron && node scripts/selfcheck.cjs` (node:test, 20 tests: settingsStore ×8, recorder ×6, ipc rules ×3, main runtime rules ×3)
- platform/ground/app/linux/scripts/selfcheck.cjs — run: `cd platform/ground/app/linux && npm run build:electron && node scripts/selfcheck.cjs` (22 tests: the Windows suite + power inhibitor ×2)
- No platform/ground/ui/test/electron-*.test.ts was added: the shell modules import 'electron' at top level, so they cannot be imported by the UI's vitest without a module mock; the compiled-module self-check scripts are the test surface instead (as the task allowed).

Caveats and deliberate deltas:

- No Content-Security-Policy exists anywhere in the baseline shells or ground/ui/index.html; platform/docs/FAILURE_MODES.md FM-151 documents this as the accepted state. None was added (it would require enumerating operator-configured WHEP/tile/font origins) — 'CSP' is preserved as that documented absence plus the unchanged hardening flags and navigation guards.
- Electron itself was not launched (no GUI session): verification is tsc + compiled-module tests with a fake `electron`. An `npm run dev` smoke on a display is still advisable before release.
- Pillow is not installed in any interpreter on this box, so make_icon.py was verified by py_compile and a stub-PIL control-flow/geometry smoke, not a real render; the committed icon.ico is unchanged. Likewise no rsvg-convert/inkscape here: make-icons.sh was exercised with a stub backend; the committed icon.png is unchanged.
- Deliberate hardening deltas (all supersets of the old behaviour, none observable by the current UI): recorder header reserved keys (`_header`/`id`/`startedAt`) cannot be overridden by meta; a frame with no JSON form is dropped instead of writing a literal `undefined` line; `load(id)` returns null for ids containing path separators/NUL/`..`; sessions whose header id differs from the filename are listed and loadable by header id; a header longer than 4 KiB is now indexed (old code truncated at 4096 bytes and skipped the session); same-millisecond id collision gets a `-n` suffix; a corrupt settings.json is copied to `settings.json.corrupt` before being replaced; `EIS_CONTROL_PORT` that is not a valid port falls back to 8765 instead of NaN; `EIS_SITL` is matched trimmed/case-insensitively; `site:resolveAsset` returns null rather than throwing when the target is unreadable/a directory.
- settingsStore.set() now resolves only after the write completes and get/set/all are serialised through one queue; the UI never awaited set() (fire-and-forget with .catch), so no renderer change is needed.
- main.ts now exports pure helpers (`describeRuntime`, `isNavigationAllowed`, `looksLikeGroundUi`) so the self-check can cover them; harmless for an Electron entry module.
- Pre-existing UI observation outside this area (not changed): views/LogBrowserModal.tsx casts the bridge's `{ meta, frames }` load result to `RecordingSession` and reads `startedAt` at the top level, so scrubbing an Electron-loaded session uses `undefined` for startedAt. The bridge shape `{meta, frames}` was preserved exactly per the contract; the integrator may want the ui-views-stores owner to look at it.
- dist-electron/ build outputs from the checks were left in the worktree (gitignored). Git emitted LF→CRLF normalisation warnings on commit (repo autocrlf); the index holds LF, matching the baseline convention (make-icons.sh needs LF on a Linux host, as before).
- phase3Host.ts, both READMEs, electron-builder.yml, package.json and tsconfig.json were not touched; the READMEs' descriptions of settingsStore/recorder remain accurate.

### Area `companion-vision-stream`

**`platform/companion/src/eis_companion/vision/capture.py`** — rewritten. Replaced the single if/elif Capture class (private _open_csi/_open_v4l2/_open_file/_open_sim/_read_sim methods, mutable self._width/_height/_source scalars) with a frame-source strategy family behind a lookup table. New decomposition: an immutable `CaptureSettings` dataclass with a `resolve(config, **overrides)` classmethod that merges a mapping with keyword overrides, normalises types, applies aliases (`file`->`file_path`, `flip_method`->`flip`) and RAISES TypeError on an unknown key; a `_FrameSource` base with open/read/close; a `_CvFrameSource` intermediate that owns the VideoCapture handle, the open/verify/configure sequence and the geometry-mismatch resize; three device subclasses (`_CsiFrameSource`, `_V4l2FrameSource`, `_FileFrameSource`) that differ only in `_acquire`/`_configure`/`_failure_hint`; and a `_SyntheticFrameSource` flagged `needs_cv2 = False`. `_BACKENDS` maps source name -> class, so `open()` is a table lookup plus a cv2-availability gate instead of a chain of branches, and `is_opened()` is derived from whether a backend is held rather than a separate `_opened` flag. Geometry a backend actually delivers (the 'file' source reads it back off the container) is adopted by replacing the frozen settings, so width/height are published rather than mutated in place. Both open() and read() wrap the backend in try/except so a raising backend degrades to False/(False, None) instead of propagating. The CSI pipeline builder moved from a positional-arg `_gstreamer_pipeline(width, height, fps, sensor_id, flip_method)` to `_csi_pipeline(settings)` assembled from an ordered list of stage strings joined on ' ! ' - verified to emit a byte-identical pipeline string.

- *Preserved:* class `Capture` with `open() -> bool`, `read() -> (bool, ndarray|None)`, `release()`, `is_opened() -> bool`; properties `width`, `height`, `fps`, `source`; `__enter__`/`__exit__` context-manager support; positional mapping form `Capture(config_dict, sim_source=...)`; keyword form `Capture(source=..., device=..., width=..., height=..., fps=...)` as called by app.py `_build_vision_source`; config keys source/width/height/fps/device/file_path/flip/sensor_id and their defaults (csi, 1280, 720, 30, 0, '', 0, 0); source names csi | v4l2 | file | mock | sim, with mock/sim delegating to SimTargetSource and needing neither cv2 nor a camera; cv2 imported lazily under try/ImportError so the module stays importable without OpenCV; a failed read returns (False, None), never a blank frame (FM-100 observation-state invariant); the nvarguscamerasrc CSI pipeline string, including `appsink drop=1 max-buffers=1`; file-mode geometry is taken from the container and mismatched frames are cv2.resize'd
- *Identical-line exceptions:* `from __future__ import annotations`, `import logging`, `import numpy as np`, the guarded `import cv2  # type: ignore` / `cv2 = None  # type: ignore` pair, and `log = logging.getLogger(__name__)` - standard module preamble; public method/property signature lines: `def __init__(`, `self,`, `sim_source: Any = None,`, `def open(self) -> bool:`, `def is_opened(self) -> bool:`, `def width/height/fps/source(self)`, `def __enter__(self) -> "Capture":`, `def __exit__(self, *_: Any) -> None:` and the four bare `@property` decorators - these ARE the contract; contract return statements `return False, None` (x3), `return True, frame`, `return False` (x2), `return self`, `self.open()`, `self.release()`; the six CSI GStreamer stage strings (`nvarguscamerasrc sensor-id=0 !`, the NVMM caps, `nvvidconv flip-method=0 !`, the BGRx caps, `videoconvert !`, `video/x-raw,format=BGR !`) - a hardware pipeline contract, verified token-identical; 30 blank lines, 12 `# ---` section rules, 5 docstring delimiters, 2 `====` banner rules

**`platform/companion/src/eis_companion/vision/sim_source.py`** — rewritten. Different scene generator and a different renderer. MOTION: the baseline `_SimPerson` summed two independent sine waves (a Lissajous figure) with numpy-RNG amplitudes/frequencies/phases. Replaced with `_Walker`, which traverses a CLOSED WAYPOINT LOOP: `_patrol_route` lays 5 (person 0) or 7 (person 1) waypoints on a jittered ellipse around a seeded home position; `__post_init__` precomputes cumulative segment arc-lengths; `centre_at(t)` maps `(offset + speed*t) mod perimeter` onto a leg with `bisect`, interpolates with cosine easing so waypoint corners read as a turn rather than a kink, then adds a gait-bob sway term. Layout RNG moved from `numpy.random.default_rng` to stdlib `random.Random`. FIXED A DETERMINISM BUG: baseline confidence jitter was `sin(t*7.3 + id(person) % 10)`, i.e. keyed off a MEMORY ADDRESS, so the same seed produced different confidences run to run; the ripple now uses a seeded per-walker `phase`. Frame-edge clamping factored into a module-level `_clamp_centre` shared by route generation and per-frame positioning. RENDERER: baseline allocated a full HxW boolean ogrid mask PER PERSON PER FRAME to rasterise the head; the new `_draw_walker` works entirely in bbox sub-array views (ground shadow via in-place `//= 2`, torso block, 2px outline, head disc over only the head sub-window), and the static background is built once and cached (`_backdrop_template`: vertical luminance grade plus a horizon line) then `.copy()`-stamped per frame. Timestamp burn-in replaced by `_burn_in_clock`: ten fixed slots counting whole seconds mod 10 plus a sub-second sweep bar, still pure numpy with no cv2. Person scale held at exactly 0.16 x 0.40 and promoted to the module constants `BBOX_WIDTH`/`BBOX_HEIGHT`.

- *Preserved:* class `SimTargetSource(num_targets=2, seed=42, frame_width=1280, frame_height=720, fps=30.0, base_confidence=0.92)`; `ValueError` for num_targets outside 1..2, with the same message; `get_observations() -> list[TargetObservation]`, `observe()` as its alias (the orchestrator's perception-loop interface), `render_frame() -> HxWx3 uint8 BGR`, `advance(dt)`; properties `current_time`, `num_persons`; get_observations() and render_frame() share one clock and each advance it by 1/fps; bbox geometry: width 0.16, height 0.40 of frame, top-left-origin normalised (x, y, w, h), always fully inside [0,1]; patrol speed inside the documented 0.05-0.15 normalised units/s band; confidence centred on base_confidence and clamped to [0.5, 1.0]; deterministic and seedable; numpy + stdlib only, no cv2; downstream behaviour verified unchanged: Tracker locks by frame 2, never hops target, and reports estimated_distance 5.68 m - the exact figure docs/BUILD_SUMMARY.md records for the baseline orchestrator smoke run
- *Identical-line exceptions:* `from __future__ import annotations`, `import math`, `import time`, `import numpy as np`, `from eis_companion.types import TargetObservation` - standard preamble; the whole `__init__` signature block (num_targets/seed/frame_width/frame_height/fps/base_confidence with their defaults) and the `if num_targets < 1 or num_targets > 2: raise ValueError(...)` guard - both are the public contract; `self._fps = fps`, `self._dt = 1.0 / max(fps, 1.0)`, `self._base_conf = float(base_confidence)`, `self._t += dt`, `self._t += self._dt`, `return frame`, `return self.get_observations()`, `return self._t` - contract-fixed state handling; public declaration lines `class SimTargetSource:`, `def advance/get_observations/observe/render_frame`, `def current_time/num_persons` and their `@property` decorators; the `_PALETTE` BGR tuples (60,140,220) and (220,80,60) - renderer appearance constants, deliberately kept so recorded demo footage still looks the same; docstring section headers (`API`, `---`, `::`, the `====` banners), the usage example line `src = SimTargetSource(num_targets=2, seed=42)`, blank lines and `# ---` section rules

**`platform/companion/src/eis_companion/vision/detector.py`** — rewritten. Split a monolithic class into a thin lifecycle object plus two pure functions, so the parts that carry the honesty invariants are testable with ultralytics absent. `resolve_weights(engine_path, model_path, *, environ, exists)` replaces the inline or-chain in `__init__`: it returns a frozen `Weights(path, tensorrt)` whose `load_kwargs` property supplies `task='detect'` only for an engine, and it takes `environ`/`exists` as injectable dependencies so the argument > env > packaged-default precedence can be tested against a fake filesystem. `observations_from_results(results, frame_hw, conf_gate, ts)` replaces the nested result/box loop: class gate, confidence gate, `_normalise_box` (xyxy pixels -> clamped normalised xywh, computed once per box against geometry resolved once per frame rather than per box), then the descending-confidence sort. `_scalar()` unwraps torch 0-d tensors / numpy scalars / plain numbers uniformly instead of hardcoding `.item()`. `_frame_geometry(frame)` replaces the `frame is None or frame.size == 0` guard with one function that returns `(h, w)` or None, tolerating objects without `.size`. `PersonDetector.__init__` is now load-and-warm only, driven by the `Weights` verdict; `_predict()` centralises the ultralytics call so `detect()` and `_warmup()` cannot drift apart (warmup now uses the configured `imgsz` instead of a hardcoded 640). `_require_ultralytics` became `_load_yolo` with the install hint hoisted to the `_INSTALL_HINT` constant. Env-var names, the default weights filename and `__all__` are now explicit module constants.

- *Preserved:* `SUPPORTED_CLASSES = ('person',)` and `PersonDetector.supported_classes` (FM-98 capability declaration consumed by vision/staging.py and test_perception_honesty); `DEFAULT_CONF_THRESHOLD = 0.30` and its <= STUB_MIN_CONFIDENCE relationship (FM-121); `PersonDetector(engine_path=None, model_path=None, conf_threshold=DEFAULT_CONF_THRESHOLD, device='cuda:0', imgsz=640, half=True, *, conf=None)` - test_perception_honesty::test_the_real_detector_is_constructed_with_the_right_keyword asserts both `conf_threshold` and `conf` are in the signature (FM-101); constructor raises `ImportError` when ultralytics is absent, with the pip install hint - staging.py `_resolve_backend` and test_staging::test_missing_ultralytics_falls_back_to_stub catch exactly this; `PersonDetector(**detector_kwargs)` keyword construction as used by StagingObserver; `detect(frame) -> list[TargetObservation]`, never raising, sorted by descending confidence, normalised clamped bboxes, `time.time()` timestamps; `last_inference_failed` distinguishes a failed inference from a healthy empty frame (FM-100); `last_inference_ms` written on every call including failures; `conf_threshold` property with a setter clamping to [0.01, 1.0]; engine/model resolution order: constructor arg > EIS_ENGINE_PATH/EIS_MODEL_PATH > yolo11n.pt; a configured-but-missing engine warns and demotes; module imports without ultralytics/torch/numpy at runtime (numpy stays TYPE_CHECKING-only plus a local import in warmup)
- *Identical-line exceptions:* `from __future__ import annotations`, `import logging`, `import os`, `import time`, the `if TYPE_CHECKING: import numpy as np` block, `from eis_companion.types import TargetObservation`, `log = logging.getLogger(__name__)`; `_PERSON_CLASS_ID = 0` (COCO class id) and the `SUPPORTED_CLASSES` / `DEFAULT_CONF_THRESHOLD` declarations plus their FM-98/FM-121 rationale comments - constants and the comments that justify them; the `_INSTALL_HINT` text (an operator-facing install procedure, not implementation); the full `__init__` parameter list and the FM-101 `conf` alias comment block; the `predict(source=, classes=, conf=, imgsz=, device=, half=, verbose=False)` keyword set - the ultralytics API contract; `conf_threshold` getter/setter bodies (`return self._conf`, `self._conf = max(0.01, min(1.0, float(value)))`) - the clamp is the contract; FM-100 rationale comments on the failure paths

**`platform/companion/src/eis_companion/vision/export_tensorrt.py`** — rewritten. The baseline was one 90-line `main()` with the parser inline, `import shutil`/`import glob` buried inside branches, and a nested if/else engine-location fallback whose failure path was reachable only through two levels of nesting. Decomposed into named units: `build_parser()`, `engine_destination(out_dir, model)`, `_import_yolo()` (returns None after printing rather than calling sys.exit from a helper), `locate_engine(reported, destination, stem)`, `place_engine(found, destination)`, `record_pointer(destination, pointer)` and `main(argv=None) -> int`. Control flow changed from nested branching to an ordered CANDIDATE LIST: the path the export call reported, then the destination itself, then a recursive glob - the first that is actually a file on disk wins, so a reported path that does not exist counts for nothing and success is never claimed on the strength of the export call merely returning. Defaults and the engine-name suffix are module constants (`DEFAULT_MODEL`, `DEFAULT_IMGSZ`, `DEFAULT_WORKSPACE_GIB`, `ENGINE_SUFFIX`, `POINTER_FILE`); imports hoisted to the top. `main()` returns an exit code and the `__main__` guard does `sys.exit(main())`, so the same codes reach the shell while the function becomes callable/testable.

- *Preserved:* CLI flags `--model` (default yolo11n.pt), `--out` (default ~/eis_models), `--imgsz` (default 640), `--workspace` (default 4) and their help text; output file layout `<out>/<model stem>_fp16.engine`; the ultralytics export call: `format='engine', half=True, device='cuda:0', simplify=True, verbose=True` with imgsz/workspace from the CLI; pointer file `~/.config/eis/engine_path.txt` containing the engine path plus a trailing newline, utf-8; exit code 1 when ultralytics is missing or no engine can be located; 0 only when an engine exists at the printed path; the `[export_tensorrt] ...` stdout prefix, the ERROR/WARNING text on stderr, and the SUCCESS block naming EIS_ENGINE_PATH; `main()` still callable with no arguments
- *Identical-line exceptions:* `import argparse`, `import sys`, `from pathlib import Path`; argparse flag names, defaults and help strings (the CLI contract); the `model.export(...)` keyword set (the ultralytics API contract); the ERROR / WARNING / SUCCESS operator-facing message text and the prerequisites section of the module docstring (a JetPack install procedure, not implementation)

**`platform/companion/src/eis_companion/stream/video.py`** — rewritten. Different process supervision and different pipeline construction. SUPERVISION: the baseline held two ad-hoc `Optional[Popen]` slots (`self._mediamtx`, `self._gst`) with `_start_mediamtx`/`_start_gst`/`_kill_all` reaching into them and a hardcoded `(self._gst, self._mediamtx)` teardown tuple. Replaced with a `_Child` handle that owns one binary's whole lifecycle (`spawn`, `alive`, `shutdown(grace)`, with the SIGINT-vs-terminate platform choice and the escalate-to-kill inside it) and an ordered `self._children` list on VideoStream; `_teardown()` pops in reverse launch order, so the publisher is always stopped before the server it feeds - previously correct only because the tuple happened to be written that way. `_launch(name, argv)` is the single guarded spawn path, and argv construction moved to `_mediamtx_argv()` / `_gst_argv()`. Added `child_status()` for health reporting. The mediamtx-config fallback moved out of `_start_mediamtx` onto `StreamConfig.resolved_mediamtx_config()`, and `whep_url` joins `rtsp_url` as a property instead of the WHEP URL being formatted inline in a log call. PIPELINE: `build_gst_pipeline` went from three hand-written flat token lists to composition - `_software_encoder(cfg)` and `_rtsp_sink(cfg)` return stage lists shared across sources, and `_join()` splices stages with the `!` separator. Verified token-identical to the baseline argv for csi, file, v4l2 and the default branch.

- *Preserved:* `StreamConfig` dataclass fields and defaults: source, device, file, width, height, fps, bitrate_kbps, rtsp_port=8554, webrtc_port=8889, mediamtx_bin, gst_bin, mediamtx_config; `StreamConfig.has_video` (False for sim/mock/'') and `StreamConfig.rtsp_url` == rtsp://127.0.0.1:<port>/stream; `STREAM_PATH = 'stream'` and the shipped mediamtx.yml discovered via `Path(__file__).with_name('mediamtx.yml')`; `VideoStream(config)`, `start() -> bool`, `stop()`, `running` property; `build_gst_pipeline(cfg) -> List[str]` producing byte-identical argv for every source branch, including the 200_000 bps floor on the hardware encoder and kbps for x264enc; `__all__ = ['VideoStream', 'StreamConfig', 'build_gst_pipeline', 'STREAM_PATH']`; degrade-never-raise: sim/mock source -> no-op returning False; mediamtx absent -> False; GStreamer absent or failing to spawn -> mediamtx stays up and start() returns True; stop() safe on a stream that never started; stdlib-only imports, so the module is import-safe on a Windows dev box; construction from app.py `_build_video` with source/device/file/width/height/fps/bitrate_kbps/rtsp_port/webrtc_port
- *Identical-line exceptions:* `from __future__ import annotations`, `import logging`, `import shutil`, `import signal`, `import subprocess`, `import sys`, `from dataclasses import dataclass`, `from pathlib import Path`; `log = logging.getLogger('eis.stream')`, `_MEDIAMTX_YML = Path(__file__).with_name('mediamtx.yml')`, `STREAM_PATH = 'stream'` - fixed identifiers/paths; the `StreamConfig` field declarations with their defaults and trailing comments, and the `rtsp_url` f-string - the config contract; `__all__`; every GStreamer element token and property (nvarguscamerasrc, nvvidconv, nvv4l2h264enc with insert-sps-pps/iframeinterval/maxperf-enable, filesrc, decodebin, v4l2src, videoconvert, videoscale, x264enc with tune=zerolatency/speed-preset=ultrafast/key-int-max=15, h264parse, rtspclientsink latency=0) - a pipeline contract, verified token-identical; the operator-facing warning text for a missing mediamtx / missing gst-launch-1.0; `subprocess.Popen(..., stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)` and the terminate/SIGINT/wait(3.0)/kill escalation - the documented shutdown behaviour

**`platform/companion/tests/test_vision_sim_source.py`** — added. 31 tests pinning the synthetic source's acceptance-critical properties: 1-or-2 target validation; seed determinism across 120 frames and non-determinism across seeds; a regression test that confidence no longer depends on object identity (the baseline used id(person), so the same seed did not replay); fixed 0.16 x 0.40 person scale over 400 frames; no bbox ever leaves [0,1] over 1200 frames; confidence inside the detector band; IoU > 0.9 between consecutive frames over 600 frames (the tracker's association requirement); the target actually walks (>0.05 span in 20 simulated seconds, so guidance cannot 'converge' on a parked box); per-frame step < 0.02; the shared clock advancing on both get_observations() and render_frame(); advance(dt); observe() being a true alias; frame shape/dtype/size; each frame being an independent buffer (a cached backdrop handed out by reference would accumulate every person ever drawn); and - the load-bearing one - that the person is PAINTED INSIDE the bbox the observation reports and nowhere else, so overlays and detections agree.

**`platform/companion/tests/test_vision_detector.py`** — added. 29 tests on the detector's fallback and honesty contracts, all runnable with ultralytics absent. Import-time: the module imports without the [detect] extra; SUPPORTED_CLASSES and the conf gate; construction raises ImportError with a pip hint (skipped if ultralytics is ever installed) and any loader failure is still surfaced as ImportError, since callers catch exactly that. Weights policy via resolve_weights with injected environ/exists: an existing engine wins and loads with task='detect', a missing engine demotes to the checkpoint, env vars fill in for absent arguments, arguments beat env, and nothing configured yields yolo11n.pt. Result conversion via observations_from_results with fake ultralytics objects: pixel->normalised xywh, clamping of boxes running off the frame, class and confidence filtering, descending-confidence order, a result with boxes=None being skipped, and cls defaulting to 'person' so nothing else reaches the person-tracking wire. detect() FM-100 matrix on a detector wired to a fake model: healthy-empty vs None-frame vs zero-sized-frame vs raised-inference, the failure flag clearing on recovery, timing recorded even on failure, and the frame geometry driving normalisation. Plus the threshold clamp and the FM-101 conf alias being keyword-only.

**`platform/companion/tests/test_vision_capture_stream.py`** — added. 33 tests over capture backend selection and stream degradation. Capture: the orchestrator's keyword construction form (the FM-101 shape that previously raised TypeError), the mapping form, keyword-beats-mapping, None meaning not-supplied, the YAML `file` alias, an unknown setting raising TypeError rather than being dropped, and documented defaults. Synthetic path with _CV2_AVAILABLE forced False: opens, yields a correctly shaped uint8 frame, releases; both 'sim' and 'mock' names; an injected sim_source used as-is; read before open and after release returning (False, None) rather than a blank frame; a raising renderer degrading to a failed read; idempotent release. Refusals: unknown source, all three device sources without cv2, and the file backend without a path. Plus the CSI pipeline keeping sensor-id/caps/flip and ending at `appsink drop=1 max-buffers=1`. Stream: has_video across sourceless and real sources; rtsp/whep URLs and ports; shipped-vs-overridden mediamtx config; pipeline well-formedness (no dangling `!`, no empty stage, always ending h264parse -> rtspclientsink) across four sources; hardware encoder in bps with the 200 kbps floor vs software encoder in kbps; file decode-before-re-encode; caps geometry. Supervision with a fake Popen: a synthetic source launching nothing, a missing mediamtx disabling the stream, a missing publisher keeping mediamtx up, both children launching with the shipped config and -q, a second start() not double-launching, teardown stopping the publisher before the server, a child that ignores the stop signal being killed, and both spawn-failure paths returning without raising.

Tests added:

- platform/companion/tests/test_vision_sim_source.py (31 tests) - synthetic source determinism, person scale, in-frame invariant, IoU trackability, actual motion, shared clock, observe() alias, frame shape/independence, and frame-vs-observation agreement
- platform/companion/tests/test_vision_detector.py (29 tests) - import without the [detect] extra, ImportError-on-missing-ultralytics fallback contract, weights resolution precedence, result normalisation/filtering/ordering, the FM-100 detect() matrix (healthy-empty vs missing vs zero-sized vs failed inference), timing on failure, threshold clamp, FM-101 conf alias
- platform/companion/tests/test_vision_capture_stream.py (33 tests) - Capture keyword/mapping construction, unknown-setting refusal, synthetic backend without cv2, failed-read contract, backend refusals, CSI pipeline shape, StreamConfig URLs/ports/config resolution, gst pipeline well-formedness per source, and VideoStream degradation + teardown ordering

Caveats and deliberate deltas:

- BEHAVIOUR CHANGE, deliberate, needs integrator awareness: app.py `_build_vision_source` calls `Capture(source=..., device=..., width=..., height=..., fps=...)`, but the baseline `Capture.__init__` only accepted `(config: dict, sim_source)`. Every real-camera build therefore raised TypeError, which app.py's handler logs as 'camera+detector construction is MISWIRED' and returns None - i.e. perception was dead on the real-camera path, the same defect class as FM-101. The new Capture accepts both the mapping and the keyword form, so that call now succeeds. On a dev box the net outcome is unchanged (PersonDetector then raises ImportError and the generic handler still returns None, only the log line differs); on a Jetson with the [detect] extra the real camera path now actually constructs. I did not edit app.py - the fix is entirely inside my file. If the companion-api-app agent also touches that call site, no coordination is needed: both forms work.
- sim_source layout RNG changed from numpy.random.default_rng to stdlib random.Random, so the exact waypoints for a given seed differ from the baseline. Determinism, seedability, bbox scale (0.16 x 0.40), speed band and downstream behaviour are all preserved - the tracker still locks on frame 2 and reports 5.68 m, matching the recorded baseline figure - but any test or fixture that hardcoded specific baseline bbox coordinates for a seed would need regenerating. I found none in the repo.
- Baseline confidence jitter used `id(person) % 10`, a memory address, so 'deterministic and seedable' was not actually true for confidences. The new per-walker seeded phase fixes this. If anything downstream had (accidentally) depended on run-to-run confidence variation, it will now see stable values.
- Private-name changes with no external consumers (grepped the whole platform tree): `_gstreamer_pipeline` -> `_csi_pipeline(settings)`, `_require_ultralytics` -> `_load_yolo`, `_SimPerson` -> `_Walker`, `_PERSON_COLOURS` -> `_PALETTE`, and `VideoStream._mediamtx`/`_gst`/`_kill_all` -> `_children`/`_teardown`. My new tests reference `capture._csi_pipeline`, `capture._CV2_AVAILABLE` and `sim_source._PALETTE`.
- Additive public surface (nothing removed): capture exports `CaptureSettings`, `ReadResult`, `SYNTHETIC_SOURCES` and a `Capture.settings` property; sim_source exports `BBOX_WIDTH`/`BBOX_HEIGHT` and a `frame_size` property; detector exports `Weights`, `resolve_weights`, `observations_from_results`, `ENGINE_PATH_ENV`, `MODEL_PATH_ENV`, `DEFAULT_WEIGHTS` and gains a `weights` attribute; video gains `StreamConfig.whep_url`, `StreamConfig.resolved_mediamtx_config()` and `VideoStream.child_status()`. `vision/__init__.py` and `stream/__init__.py` (owned by companion-config-types) were NOT modified, so none of these are re-exported at package level.
- `export_tensorrt.main()` now returns an int exit code instead of None, with `sys.exit(main())` in the `__main__` guard. Shell exit codes are unchanged. Nothing in the repo imports `main`.
- Capture now RAISES TypeError on an unrecognised setting key rather than ignoring it. This is intentional (a silently-dropped knob is a camera running with the wrong geometry and no evidence why), but it means a caller that forwards a superset of keys from YAML would now fail loudly. app.py's current call passes only known keys. The `file`/`file_path` and `flip`/`flip_method` aliases exist so the config-side spellings are accepted.
- Could not run the SITL acceptance gate (`make e2e` / run-sim-e2e.sh) - ArduCopter SITL does not run natively on Windows and no WSL2 instance was available in this session. As a substitute I drove SimTargetSource through the real `control.Tracker` for 300 frames across three seeds and confirmed lock behaviour and the 5.68 m estimated distance recorded in docs/BUILD_SUMMARY.md for the baseline. The mediamtx/GStreamer subprocess paths are likewise covered only with a fake Popen; no real mediamtx or gst-launch-1.0 binary was executed.
- The pytest summary line ('N passed') is suppressed under `-q` in this venv (some plugin swallows it); exit codes were checked on every run and the counts above come from non-quiet runs.
- The brief's `git blame ... | grep -c '^70c24dbc'` recipe returns 0 for these files because blame renders the baseline as a boundary commit, `^70c24db` (caret prefix, 7 hex chars). I used `grep '70c24db'` instead.
- The salvage patch at the salvage patch kept in the session scratchpad was not used - every module here was rewritten from its consumers and tests rather than from partial fragments.

### Area `sim-clients`

**`platform/sim/headless_client.py`** — rewritten. Rebuilt as a small typed client plus the scaffolding both gates share. New decomposition: _Stream (per-kind bounded history + monotonic sequence number, so readers resume from a cursor instead of rescanning the whole log on every wake), _Signal (edge-triggered broadcast that installs a fresh Event per generation, replacing the old set()/never-clear + clear()-before-wait race that degraded waiting into a 1 Hz poll), _AckGate (per-command-name FIFO of futures; abandons all waiters with ConnectionError on close). Public surface unchanged but reimplemented: connect/close/__aenter__/__aexit__, send_command (FIFO ack by command NAME, CommandTimeout, expect_success -> AssertionError), send_manual_input, stream_manual_input (now scheduled on an absolute tick grid so send latency cannot accumulate into rate droop; returns the frame count), wait_for_telemetry/tracking/status (now one generic wait_for over a new follow() async iterator), collect_telemetry (now returns exactly the frames of the window via cursor arithmetic; the old slice was wrong once the deque wrapped), last_telemetry/last_tracking/*_log now properties over the streams, control_source/estimated_distance. Added: follow(kind, timeout) yielding every published frame exactly once (no sampling gaps), connected, vehicle_id, and every outbound frame now carries vehicleId (api/server.py drops frames with a missing/mismatched vehicleId, so the gates could not drive the current companion without it). Added the shared acceptance scaffolding used by both gates: PhaseMachine (explicit named-state machine with loop guard), drive_acceptance, run_acceptance (exit-code mapping), link_arguments (--ws-url/--vehicle-id), env_float/env_int, EXIT_OK/ASSERT/LINK/ERROR. __main__ smoke entry keeps the positional URL form documented in sim/README.md and adds --ws-url/--seconds.

- *Preserved:* HeadlessClient(url, *, ack_timeout=5.0, history=600) constructor signature and defaults; send_command(command, params=None, *, timeout=None, expect_success=False) -> ack dict; ack correlation by command NAME, first-match FIFO (CommandAck has no requestId); CommandTimeout(TimeoutError) and its message 'No ack for command '<name>' within <n>s'; AssertionError text "Command '<name>' was rejected: <message>" on expect_success; send_manual_input(throttle,yaw,pitch,roll) wire frame: type/throttle/yaw/pitch/roll/ts — fire-and-forget, never acked per frame; stream_manual_input(axes, *, duration, rate_hz=25.0, stop=None) semantics incl. early stop; wait_for_telemetry/wait_for_tracking/wait_for_status(pred, *, timeout=30.0, desc='') incl. matching already-buffered frames and a raising predicate counting as a non-match; last_telemetry/last_tracking/telemetry_log/tracking_log/status_log/ack_log/control_source/estimated_distance; now_ms(), TelemetryPred/TrackingPred/StatusPred aliases; connect(retries=40, retry_delay=0.5) and the 'Could not connect to companion at <url>' ConnectionError; python sim/headless_client.py <url> smoke output (frame counts + one-line state dump)
- *Identical-line exceptions:* 208 of 830 lines still blame to 70c24dbc under `git blame -w -M -C`; 109 of those are blank lines, lone closing parens/braces, `try:`, `self,`, `*,`, `"""`, `@property` and section-rule comments; import lines: `from __future__ import annotations`, `import asyncio/contextlib/json/time`, `from collections import deque`, `import websockets`; the websockets import guard block and its message text (kept verbatim: it is the operator-facing install hint); `def now_ms() -> int: return int(time.time() * 1000)`; type aliases TelemetryPred/TrackingPred/StatusPred and `class CommandTimeout(TimeoutError)` + its docstring (public exports); preserved public method signatures and their parameter lists (send_command, send_manual_input, stream_manual_input, wait_for_*, connect, close, __aenter__/__aexit__, control_source, estimated_distance); the manualInput frame's field literals ("type": "manualInput", "throttle": float(throttle), ...) — that is the wire format itself; websockets.connect kwargs ping_interval=20 / ping_timeout=20 / max_queue=None; the smoke-test format string '  armed=%s mode=%s controlSource=%s relAlt=%.2f'

**`platform/sim/e2e_test.py`** — rewritten. Rebuilt from one linear _run coroutine into an explicit phase machine (connect -> arm -> takeoff -> configure -> engage -> yaw -> standoff -> speed -> disengage -> recover), each phase a method of E2EGate returning its successor, so a failure prints how far the vehicle got. All acceptance criteria extracted into pure, socket-free evaluators: converge_band/breach_floor on a frozen AcceptanceParams, check_standoff_not_breached, ApproachTrace + evaluate_approach, HoldStats + evaluate_hold, evaluate_speed, YawEvidence (folds the two independent yaw signals; verdict() is monotonic so the phase can stop observing the moment it turns True — same final answer as the old end-of-loop evaluation, reached sooner), locked_centre_x, heading_slew. Standoff monitoring changed from polling last_tracking at 5 Hz to consuming EVERY published tracking frame via client.follow(), so a breach lasting a single frame now fails the gate. Added an argparse CLI: --ws-url (which run-sim-e2e.sh/.ps1 have always passed and the old file silently ignored — it read only env), plus --vehicle-id/--standoff/--max-speed/--takeoff-alt/--converge-s, all defaulting to the same env knobs. Exit-code mapping moved into the shared run_acceptance.

- *Preserved:* acceptance sequence: connect -> arm -> takeoff -> setStandoff/setMaxSpeed -> engageTracking -> yaw-toward-target -> approach -> hold at standoff without breaching -> groundspeed cap -> disengageTracking -> rtl (fallback land); standoff is a HARD limit: assertion text 'STANDOFF BREACH during approach/hold: estimatedDistance=%.2f m < standoff %.1f m - eps %s' and the hold suffix 'This violates the hard standoff safety limit.'; thresholds unchanged: STANDOFF_EPSILON=0.6, SPEED_MARGIN=0.5, HEADING_IMPROVE_DEG=5.0, converge band max(1.0, 0.25*standoff), 12 s hold window, >=10 hold samples, mean hold <= standoff+band+1.0, airborne = relAlt >= alt-1.5, speed peak over the last 200 telemetry frames, 12 s yaw observation, yaw factors 0.05/0.6/0.02/0.08; controlSource assertions ('tracking' after engage, 'auto' after disengage) and the tracking.standoffDistance echo check (<1e-6); env knobs EIS_WS_URL / EIS_STANDOFF / EIS_MAXSPEED / EIS_TAKEOFF_ALT / EIS_CONVERGE_S and module constants WS_URL/STANDOFF/MAX_SPEED/TAKEOFF_ALT/CONVERGE_S/STANDOFF_EPSILON/SPEED_MARGIN/HEADING_IMPROVE_DEG; CLI flag --ws-url; exit codes 0 pass / 1 assertion / 2 link-or-timeout / 3 unexpected; pytest entry point test_e2e_tracking_standoff() and standalone main() + `raise SystemExit(main())`; failure message texts quoted by sim/README.md ('did not converge to standoff', 'vehicle never approached', 'too few estimatedDistance samples', 'did not HOLD at standoff', 'exceeded configured maxSpeed', 'vehicle did not yaw toward the target')
- *Identical-line exceptions:* 108 of 627 lines still blame to 70c24dbc; 60 of those are blank lines, lone closing parens, `"""` and section-rule comments; module-docstring blocks that document preserved behaviour verbatim: the two-terminal preconditions, 'Run either way' invocations, and the 'Env knobs' list; `from __future__ import annotations`, `import asyncio/math/os/sys`, and the sys.path.insert line + its comment (required for `python sim/e2e_test.py` from anywhere); the constant declarations STANDOFF_EPSILON / SPEED_MARGIN / HEADING_IMPROVE_DEG with their explanatory comments; preserved literal assertion messages (they are the operator-facing contract and are quoted in sim/README.md); contract predicates used as assertions: lambda t: t.get('controlSource') == 'tracking' / 'auto', lambda tr: tr.get('state') == 'locked' and tr.get('lockedTargetId') is not None, and their desc= strings; `worst = max(speeds) if speeds else 0.0`, `if not ack.get("success"):` and the RTL-fallback comment; entry-point names and wrapper docstring: test_e2e_tracking_standoff, main, `if __name__ == "__main__": raise SystemExit(main())`

**`platform/sim/manual_test.py`** — rewritten. Rebuilt into a phase machine (connect -> reject -> arm -> takeoff -> track -> manual -> sticks -> watchdog -> release -> estop) over a ManualGate class, with all verdicts as pure evaluators: evaluate_stick_response, evaluate_stick_clamps, evaluate_watchdog, evaluate_auto_hold, evaluate_emergency_stop, plus AxisEnvelope, StickOutcome, position_delta, heading_slew. AxisEnvelope replaces the old 10 Hz polling monitor task: it folds every published telemetry frame (via client.follow) and differentiates yaw rate from the frame's own wire `ts` rather than the reader's loop clock, choosing the clock once on the first frame and scaling the delta in milliseconds so the ~1.7e12 stamps keep their resolution; implausible dt (<=1 ms or >5 s) is ignored. The stick script became a declarative STICK_SCHEDULE table (pitch -> yaw -> throttle -> roll, 2.5 s each at 25 Hz) exposed as scripted_sticks()/full_forward(). ManualParams (frozen) derives watchdog_settle_s = max(2.0, 4*period) and release_settle_s = max(1.5, 2*period). Added an argparse CLI: --ws-url (previously accepted by the scripts but ignored by the file), --vehicle-id/--takeoff-alt/--max-speed/--max-climb/--max-yaw/--watchdog-ms. The best-effort disarm on exit is now the on_exit hook of the shared drive_acceptance/run_acceptance.

- *Preserved:* sequence: negative engageManual (refused before armed+airborne) -> arm -> takeoff -> engageTracking -> engageManual (tracking auto-releases, controlSource=='manual') -> streamed manualInput responds within clamps -> stop input, watchdog zeroes and holds -> disengageManual (auto-hold, controlSource=='auto') -> re-engage manual, emergencyStop overrides instantly; exactly one controlSource is active; engage/disengage are acked, manualInput is not; thresholds unchanged: SPEED_MARGIN=0.6, CLIMB_MARGIN=0.6, YAW_MARGIN=20.0, response gates (position 1e-6 deg / gs 0.3, heading 3.0 deg / yaw-rate 3.0, alt 0.5 m / vs 0.2), watchdog groundspeed <= 0.8 m/s, drift < 5e-5 deg over 2 s, safe-stop modes LAND/BRAKE/RTL or disarm; assertion texts preserved: 'engageManual was ACCEPTED while not armed+airborne...', "controlSource became 'manual' despite engageManual being refused.", 'pitch/roll axes appear inactive', 'did not change heading', 'did not change altitude', 'axis not clamped to limits', 'throttle axis not clamped', 'yaw axis not clamped', 'WATCHDOG FAILURE: ... (PRD 11)', 'auto-hold did not zero the setpoint', 'emergencyStop did NOT override manual', 'emergencyStop did not put the vehicle in a safe stop state'; env knobs EIS_WS_URL / EIS_TAKEOFF_ALT / EIS_MAX_SPEED / EIS_MAX_CLIMB / EIS_MAX_YAW / EIS_WATCHDOG_MS and module constants WS_URL/TAKEOFF_ALT/MAX_SPEED/MAX_CLIMB/MAX_YAW/WATCHDOG_MS/SPEED_MARGIN/CLIMB_MARGIN/YAW_MARGIN; best-effort disarm before closing the link; CLI flag --ws-url; exit codes 0/1/2/3; pytest entry point test_manual_piloting() and standalone main() + `raise SystemExit(main())`
- *Identical-line exceptions:* 144 of 694 lines still blame to 70c24dbc; the majority are blank lines, lone closing parens, `try:`, `"""` and section-rule comments; module-docstring blocks documenting preserved behaviour: preconditions, 'Run either way', 'Env knobs'; `from __future__ import annotations`, `import asyncio/os/sys`, the sys.path.insert line; the margin constant declarations SPEED_MARGIN / CLIMB_MARGIN / YAW_MARGIN with their two-line explanatory comment; preserved literal assertion messages (operator-facing contract); entry-point names and wrapper docstring: test_manual_piloting, main, `if __name__ == "__main__": raise SystemExit(main())`

**`platform/sim/test_sim_clients.py`** — added. New 54-test suite for the area, runnable with the companion venv's pytest and no SITL/companion. Provides FakeCompanion, an in-process websockets server speaking the shared contract (records inbound frames, auto-acks per a policy, pushes telemetry/tracking/statusText/ack), plus contract-shaped frame factories. Covers: inbound routing and bounded history; malformed/unknown frames ignored; command frames carrying vehicleId+params; ack matching by name; FIFO for repeated names; ack timeout and late-ack safety; expect_success -> AssertionError; close() failing pending acks; connect retry/ConnectionError; send without a link; manualInput frame shape and that nothing is acked; stream rate/duration/stop; wait_for over buffered and future frames, timeouts, raising predicates; follow() losing no frames; collect_telemetry windowing; PhaseMachine ordering, unknown successor, loop guard; exit-code mapping (1/2/3/0) and the on_exit hook ordering; every e2e and manual pure evaluator including the standoff-breach messages; E2EGate._approach/_hold_for/engage driven against the fake server (a single breaching frame fails); ManualGate.reject_before_airborne both ways; CLI parsing of --ws-url and every knob for both gates; and a guard that none of the three modules import eis_companion.

- *Preserved:* asserts the invocation contract the scripts rely on: --ws-url is honoured and exit codes are 0/1/2/3; asserts the wire contract: vehicleId on every outbound frame, manualInput never acked, acks correlated by command name
- *Identical-line exceptions:* new file; nothing traces to the baseline

Tests added:

- platform/sim/test_sim_clients.py — 54 tests, no new dependencies (pytest + websockets, both already in the companion venv). Run: cd platform && companion/.venv/Scripts/python.exe -m pytest sim/test_sim_clients.py -q

Caveats and deliberate deltas:

- SITL cannot run on this box, so the live gates were NOT executed end to end. Verification was compileall + pyflakes + ruff, 54 unit tests against a fake in-process contract server (including E2EGate._approach/_hold_for/engage and ManualGate.reject_before_airborne driven over a real socket), and CLI/exit-code checks. An integrator with WSL2 should still run `make e2e` once.
- BEHAVIOUR FIX the scripts agent must know about: the old e2e_test.py/manual_test.py had NO argument parsing at all — `--ws-url <url>` was accepted by the shell only because Python ignored sys.argv, and the URL came from EIS_WS_URL. Both files now really parse --ws-url (env remains the default). Consequence: an unknown/misspelled flag now aborts with argparse's exit code 2 instead of being silently ignored. Flags confirmed on my side: e2e --ws-url/--vehicle-id/--standoff/--max-speed/--takeoff-alt/--converge-s; manual --ws-url/--vehicle-id/--takeoff-alt/--max-speed/--max-climb/--max-yaw/--watchdog-ms. Exit codes unchanged: 0/1/2/3.
- CONTRACT GAP FIXED: platform/companion/src/eis_companion/api/server.py:325 drops any inbound frame whose vehicleId is missing or mismatched (post-baseline hardening, FM-40). The old headless_client sent no vehicleId, so the acceptance gate could not have driven the current companion at all — every command and manualInput frame would have been refused with a statusText warning. Every outbound frame now carries vehicleId, defaulting to shared.DEFAULT_VEHICLE_ID ('eis-1'), overridable with EIS_VEHICLE_ID or --vehicle-id. If the companion is run with a non-default vehicle id, the gates need that flag.
- Signed commands: app.py's authorize hook refuses unsigned privileged commands only when config.require_signed_commands is on (off for the loopback/demo posture). The gates send unsigned commands, as before. If a run enables require_signed_commands, both gates will fail at the arm phase with a refusal ack — that is a companion configuration matter, not a client one.
- Minor deliberate text change: the watchdog drift message now reads 'delta lat+lon=' instead of the baseline's 'Δlat+Δlon=' — a literal U+0394 in a failure path raises UnicodeEncodeError on a cp1252 Windows console, which would have masked the real assertion. 'WATCHDOG FAILURE' and every other quoted message are unchanged.
- API additions (nothing removed): HeadlessClient gained vehicle_id, connected, follow(), wait_for(); stream_manual_input now returns the number of frames sent (was None); headless_client.py additionally exports PhaseMachine/drive_acceptance/run_acceptance/link_arguments/env_float/env_int/EXIT_* and the DEFAULT_WS_URL/DEFAULT_VEHICLE_ID constants.
- platform/sim/README.md is not in my ownership list so I left it untouched. It remains accurate (the positional `python sim/headless_client.py <url>` form still works, all quoted failure messages still match), but it does not yet document the new --standoff/--max-speed/--takeoff-alt/--converge-s/--watchdog-ms flags — the docs owner may want to add them.
- pytest prints 'PytestConfigWarning: Unknown config option: asyncio_mode' from the resolved rootdir config. Pre-existing, unrelated to this area (pytest-asyncio is not installed in the venv, which is why every new test drives its coroutine through asyncio.run, matching platform/companion/tests convention).
- Written with LF line endings while the working tree had CRLF; the repo stores LF (core.autocrlf), so git reported 'LF will be replaced by CRLF next time' on add. The committed blobs are LF, consistent with the rest of the repo — no content impact.

### Area `companion-config-types`

**`platform/companion/src/eis_companion/config.py`** — rewritten. Replaced three hand-written per-field passes (_from_yaml / _apply_env_overrides / _enforce_safety_floor + 4 helper floor functions) with two declarative tables. SETTINGS is a tuple of Setting(path, kind, env): 'path' is dotted and doubles as the YAML location AND the AppConfig attribute chain, so the two can never drift; 'kind' is a Kind(from_yaml, from_env) coercion pair (TEXT/REAL/WHOLE/BOOL); 'env' is the documented EIS_* name. load_config now constructs AppConfig() (its dataclass defaults ARE layer 1, so no default literal is repeated anywhere) and runs one loop for YAML and one for env over that same table, replacing ~330 lines of per-field assignment. BOUNDS is a tuple of Bound(path, lo, hi, lo_ref, hi_ref, bad, whole): hard floor/ceiling literals, cross-field references that keep ordered bands (min_standoff<=standoff<=max_standoff, min_speed<=max_speed, peer_stale_s<=peer_hold_s, separation_m<=separation_stale_m, publish_hz<=hz) correct by construction, and the conservative value a non-numeric/non-finite entry degrades to. _enforce_safety_floor now walks BOUNDS then four named guards (_INVERTIBLE_BANDS collapse, _NON_EMPTY_TEXT, _clamp_profile_speeds, _restrict_unattended_profiles, _enforce_bind_policy). Non-scalar overlays are separate functions (_overlay_gains derives each channel's fallback from the dataclass default instead of re-literalising 90/0/4 etc.; _overlay_profile_speeds; _overlay_profiles). Path resolution is now a candidate generator + next(); .env loading is discover -> parse (python-dotenv's dotenv_values when installed, else a built-in KEY=VALUE reader that also strips an 'export ' prefix) -> os.environ.setdefault; the shared-contract mirror load is split into _import_shared_contract() + a memoised _shared_profile_speeds(). Verified equivalent by a differential harness that loaded 30 YAML/env scenarios through both the old and new module and compared all 97 resolved fields: ALL MATCH.

- *Preserved:* every config key in config/default.yaml, config/sitl.yaml, config/vehicle2.yaml loads to identical values (verified field-by-field against the previous implementation); all 54 environment variable names and their coercion rules: EIS_SITL, EIS_VEHICLE_ID, EIS_CONFIG, EIS_CONTROL_HOST, EIS_BIND_ALL, EIS_CONTROL_PORT, EIS_VIDEO_PORT, EIS_WEBRTC_PORT, EIS_VIDEO_BITRATE, EIS_VIDEO_URL, EIS_FC_CONNECTION, EIS_FC_BAUD, EIS_MAVLINK_SYSID, EIS_GCS_SYSID, EIS_CAMERA_SOURCE, EIS_CAMERA_DEVICE, EIS_CAMERA_WIDTH, EIS_CAMERA_HEIGHT, EIS_CAMERA_FPS, EIS_MODEL_PATH, EIS_ENGINE_PATH, EIS_DETECT_CONF, EIS_STANDOFF_M, EIS_MAX_SPEED_MPS, EIS_MAX_ALT_M, EIS_GEOFENCE_RADIUS_M, EIS_MAX_SORTIE_S, EIS_DISPATCH_MIN_SOC_PCT, EIS_CELL_IMBALANCE_MAX_V, EIS_BATT_TEMP_MAX_C, DEMO_CHARGE_SCALE, EIS_ENVELOPE_* (7), EIS_UNATTENDED_* (5), EIS_GIMBAL_* (5), EIS_SESSION_KEY_ENV, EIS_COMMAND_MAX_AGE_MS, EIS_REQUIRE_SIGNED_COMMANDS, EIS_AUDIT_PATH, EIS_SITE_FILE, EIS_STAGING_RADIUS_M, EIS_PLANNER_HEARTBEAT_TIMEOUT_MS; env precedence: blank/whitespace value = not an override; unparseable numeric = not an override; int envs coerce via float then truncate; bools true only for 1/true/yes/on; EIS_BIND_ALL decides the bind after EIS_CONTROL_HOST; load_config(path=None, *, use_dotenv=True, use_env=True) -> AppConfig signature and source_path semantics; public surface: AppConfig, all 14 sub-config dataclasses, GainTriple.as_tuple, AppConfig.video_url, load_config, is_loopback_host, DEFAULT_CONFIG_REL, PROFILE_SPEED_FALLBACK and every safety constant; __all__ unchanged; safety floor still runs LAST, after YAML and env: standoff floor 3 m / ceiling 50 m, max_speed cap 8 m/s, sortie 480 s, dispatch SoC >= 80 %, cell imbalance <= 0.10 V, batt temp <= 60 C, envelope-monitor floors/caps (ADR D21/D22) with no off switch, UNATTENDED_ENVELOPE caps (ADR D23), gimbal -30..90 deg, replay window 1 s..300 s, geofence >= 10 m, watchdogs >= 50/200 ms; FM-40 bind policy: a non-loopback network.host forces security.require_signed_commands = True; config.py's UNATTENDED_* constants stay equal to control/mode.py's (pinned by tests/test_mode.py)
- *Identical-line exceptions:* the module docstring banner delimiters and the `from __future__` / stdlib import block (lines 33-46); the safety constant block MAX_SPEED_CAP / MIN_STANDOFF_FLOOR / MAX_STANDOFF_CEIL_M and their comments (lines 49-56) - required constants, values are the contract; the typed sub-config dataclass declarations: GainTriple, GuidanceGains, CameraConfig, DetectorConfig, NetworkConfig, FcConfig, TrackingConfig, SafetyConfig, BatteryConfig, PlannerConfig, EnvelopeConfig, UnattendedConfig, GimbalConfig, SecurityConfig field lines + docstrings (lines ~199-279, ~244-279) - type declarations and default values are the config contract; AppConfig's field declaration block and source_path line (lines 387-411); the `raise RuntimeError(...)` pyyaml-missing message and the `except ValueError: return None` env-coercion tail; the `def load_config(...)` signature and its Args/Returns docstring (lines 899-918); the `__all__` list (unchanged on purpose - it is the public surface)

**`platform/companion/src/eis_companion/types.py`** — partially-rewritten. Dataclasses/enums retained as declarations (per the brief); every behavioural method reimplemented. Added one module-level _bounded(value, low, high, safe) helper that writes the degradation rule once (non-numeric or non-finite -> the caller's stated safe value; an inverted band resolves to the floor) and backs BOTH Limits.clamp_standoff and Limits.clamp_speed, which previously each carried their own try/except + isfinite + nested min/max. Added Limits.standoff_band() returning the closed (min, max) pair so clamp_standoff no longer recomputes the ceiling inline. VelocitySetpoint.hold() is now `return cls()` - the field defaults ARE the hold setpoint - instead of re-listing the five zeros, and zeroed() delegates through type(self).hold(). TargetObservation geometry is re-derived so width/height are the primitives and cx/cy are expressed in terms of them, instead of four independent bbox index expressions. Behaviour verified identical: clamp_standoff(1.0)=3.0, (999)=50.0, (inf)=5.0, ('x')=5.0, (nan)=5.0; clamp_speed(0.1)=0.5, (99)=2.0, (nan)=2.0, (None)=2.0; cx of (0.1,0.2,0.4,0.6) = 0.30000000000000004 (bit-identical to the old expression).

- *Preserved:* module exports ControlSource, TrackingState, VehicleState, VelocitySetpoint, Limits, TargetObservation, now (unchanged __all__); ControlSource values auto/tracking/manual/planner and TrackingState values idle/searching/locked/lost (contract literals); Limits field names, defaults and units (max_speed 2.0, min_speed 0.5, max_climb_rate 1.5, max_yaw_rate 45.0, max_altitude 30.0, standoff 5.0, min_standoff 3.0, max_standoff 50.0, deadzone 0.09, manual_watchdog_ms 500, ground_link_timeout_ms 2000); VelocitySetpoint BODY-frame semantics and valid=False == hold; hold() returns a FRESH mutable instance (callers mutate what they are handed); clamp_standoff degrades a non-finite request to self.standoff, never to inf (FM-11); clamp_speed degrades to self.max_speed; TargetObservation.bbox stays a plain (x,y,w,h) tuple; cx/cy/width/height remain read-only properties; cls defaults to 'person' (FM-122)
- *Identical-line exceptions:* module docstring header (lines 4-20) and the `from __future__` / import block; the enum declarations ControlSource and TrackingState with their members and docstrings; VehicleState in full (a pure declaration - no methods); VelocitySetpoint's five field declarations and the zeroed() signature+docstring; Limits' eleven field declarations with their inline unit comments, and the clamp_standoff docstring (it states the FM-11 rationale that must not change); TargetObservation's bbox/conf/ts/cls declarations and the cx/cy property signatures+docstrings; the `__all__` list; `def now(): return time.time()` - the whole function is its contract

**`platform/companion/src/eis_companion/__init__.py`** — rewritten. __version__ is no longer a hand-maintained literal: a new _installed_version() reads it from the installed distribution metadata (importlib.metadata.version('eis-companion')), with a FALLBACK_VERSION constant for a source-only checkout (PYTHONPATH on the Jetson). pyproject.toml becomes the single place the number lives. Verified: eis_companion.__version__ == '0.1.0' both from the editable install and from the fallback path.

- *Preserved:* __version__ == '0.1.0'; __all__ == ['__version__']; importing the top-level package still pulls in nothing but the standard library
- *Identical-line exceptions:* the package docstring's sub-package inventory and the SAFETY-FIRST paragraph (documentation, not code)

**`platform/companion/src/eis_companion/api/__init__.py`** — rewritten. Eager `from .server import ApiServer, CommandHandler, ManualHandler` replaced with a PEP 562 lazy re-export: a _EXPORTED_BY map (name -> owning submodule), a module __getattr__ that imports the owner on first read and binds the result into globals() so later reads skip the hook, and a __dir__ that unions globals() with the map. Importing eis_companion.api no longer drags in the websockets stack. `from eis_companion.api import ApiServer` and `from eis_companion.api.server import ...` both still work (verified); an unknown name still raises the standard AttributeError message.

- *Preserved:* ApiServer, CommandHandler, ManualHandler importable from eis_companion.api; __all__ unchanged; eis_companion.api.server remains directly importable (tests/test_api_hardening.py, tests/test_nonfinite_safety.py use it)
- *Identical-line exceptions:* the docstring describing the four outbound / two inbound contract message types and the ack-vs-manualInput rule; the __all__ list

**`platform/companion/src/eis_companion/vision/__init__.py`** — rewritten. Same PEP 562 lazy re-export mechanism, mapping Capture->capture, PersonDetector->detector, SimTargetSource->sim_source, StagingObserver/StagingPoint->staging. This is the sub-package where it matters most: a SITL run that only wants SimTargetSource no longer imports (or fails on) OpenCV/ultralytics via detector.py. app.py's in-function `from .vision import StagingObserver / SimTargetSource / Capture, PersonDetector` imports all resolve through the hook (verified); test files that import eis_companion.vision.detector / .staging directly are unaffected.

- *Preserved:* Capture, PersonDetector, SimTargetSource, StagingObserver, StagingPoint importable from eis_companion.vision; __all__ unchanged; submodules eis_companion.vision.{capture,detector,sim_source,staging,export_tensorrt} remain directly importable
- *Identical-line exceptions:* the docstring's first paragraph and the __all__ list

**`platform/companion/src/eis_companion/stream/__init__.py`** — rewritten. Same PEP 562 lazy re-export, mapping VideoStream and StreamConfig to the video submodule, so the orchestrator only pays for the mediamtx/GStreamer import on the branch that actually starts a stream.

- *Preserved:* VideoStream, StreamConfig importable from eis_companion.stream; __all__ unchanged; eis_companion.stream.video remains directly importable
- *Identical-line exceptions:* the docstring paragraph describing the mediamtx/GStreamer pipeline and its graceful degradation, and the __all__ list

**`platform/companion/tests/test_config_layering.py`** — added. New: 35 tests for layer precedence and the table's own integrity. Table integrity: every SETTINGS path resolves on AppConfig, every BOUNDS path resolves and every lo_ref/hi_ref names a row bounded EARLIER, env names are unique, and every override documented in .env.example is actually wired. Precedence: defaults with no YAML, YAML over defaults (and untouched keys keep their default), env over YAML, use_env=False, blank env is not an override, unparseable env is not an override, numeric env coercion (port truncation, bool token set), EIS_BIND_ALL after EIS_CONTROL_HOST in both directions, EIS_CONFIG file selection, and a .env that fills gaps but never beats an exported variable. Parsing shapes: gain triples as both mapping and sequence with per-term fallbacks, non-mapping sections falling back to defaults, an empty file equalling AppConfig(), a top-level sequence raising ValueError. Shipped files: default/sitl/vehicle2 YAML each load with the expected profile (hardware vs SITL vs second airframe), profile speeds mirror the shared contract, each load gets its own profile-speed dict, and video_url derivation for real vs synthetic cameras.

**`platform/companion/tests/test_config_safety_floor.py`** — added. New: 32 tests, each of the shape 'ask for something dangerous through one layer, assert the conservative value came back'. Covers the speed cap (YAML and env), the standoff floor AND ceiling (FM-11) and band ordering, non-finite limits degrading conservatively, watchdogs that cannot be disabled, positive altitude/climb/yaw, the geofence floor, battery/dispatch gates (widening refused, tightening accepted, env cannot widen), per-profile speed caps including negative->0 and malformed->shared default, planner radii that cannot collapse, the envelope monitor (relaxation refused, tightening accepted, stale separation >= nominal, peer_hold >= peer_stale, no off switch, publish_hz <= hz, env cannot relax), the UNATTENDED_ENVELOPE (no widening, unknown profiles fall back, inverted band collapses, env may tighten only), gimbal travel (no widening, narrowing allowed, inverted band collapses), the replay window bounded at both ends, blank identities falling back, and the FM-40 pairing (loopback does not force signing; 0.0.0.0 / a LAN IP / :: each force require_signed_commands=True, via YAML and via EIS_BIND_ALL).

Tests added:

- platform/companion/tests/test_config_layering.py (35 tests: SETTINGS/BOUNDS table integrity, defaults->YAML->env precedence, blank/unparseable env rejection, numeric+bool env coercion, EIS_BIND_ALL ordering, .env vs exported variable, EIS_CONFIG selection, gain-triple mapping/sequence parsing, non-mapping sections, empty file == AppConfig(), top-level sequence raises, the three shipped YAML profiles, shared-contract profile speeds, per-load dict isolation, video_url derivation)
- platform/companion/tests/test_config_safety_floor.py (32 tests: speed cap via YAML and env, standoff floor+ceiling+band ordering, non-finite degradation, watchdog floors, positive altitude/climb/yaw, geofence floor, battery/dispatch gates both directions, profile-speed caps, planner radii, envelope-monitor floors/caps/ordering/no-off-switch via YAML and env, UNATTENDED_ENVELOPE caps and profile allow-list, gimbal travel and inverted bands, replay window bounds, blank identity fallbacks, FM-40 bind->signing pairing)

Caveats and deliberate deltas:

- DELIBERATE BEHAVIOUR CHANGE (the only divergence the differential harness found, and it only fires on a NON-FINITE YAML value on a field the old code did not route through _safe): the old loader let `.inf` through the bare float()+min/max path, so `limits.max_altitude: .inf` resolved to inf and `limits.max_speed: .inf` resolved to the 8 m/s cap - i.e. an unreadable config bought the most permissive value. The new BOUNDS table degrades every non-finite entry to the conservative end instead: max_speed inf -> 0.1, max_altitude inf -> 1.0, max_yaw_rate inf -> 1.0, max_sortie_s inf -> 1.0, batt_temp_max_c inf -> 1.0, cell_imbalance_max_v inf -> 0.001, staging_arrival_radius_m inf -> 1.0, reserve_pct -inf -> 99.0. All NaN cases and every finite value are bit-identical to before. This tightens the 'no config value can relax a safety limit' invariant; if the integrator wants strict byte-equality here instead, the per-row `bad` values in BOUNDS are the single place to change.
- config.py's `manual_watchdog_ms: .nan` / `ground_link_timeout_ms: .nan` used to raise ValueError from int(nan); they now degrade to the 50 ms / 200 ms floors. No test exercised the crash.
- AppConfig.video_url keeps raw truthiness on network.video_url (a whitespace-only configured URL is still returned verbatim), so nothing there changed.
- New public names added to config.py (additive only, __all__ left byte-identical): Setting, SETTINGS, Bound, BOUNDS, Kind, TEXT/REAL/WHOLE/BOOL, TRUE_TOKENS, BIND_ALL_HOST, SYNTHETIC_CAMERA_SOURCES, RTSP_ADVERTISE_HOST. types.py adds Limits.standoff_band(). eis_companion adds FALLBACK_VERSION. All previously-importable names still resolve from the same module paths.
- _load_dotenv now parses the .env itself via python-dotenv's dotenv_values (or a built-in KEY=VALUE reader when dotenv is absent) and merges with os.environ.setdefault, instead of calling load_dotenv(override=False). Exported-wins semantics are unchanged and verified by a test. There is no .env anywhere in the checkout, so this path is not exercised at runtime today.
- eis_companion.__version__ now reads installed distribution metadata; the venv has eis-companion 0.1.0 installed editable, and the literal fallback is 0.1.0, so the value is unchanged either way. If someone later bumps pyproject without reinstalling, __version__ follows the INSTALL, not the source tree.
- The three sub-package __init__ files are now lazy (PEP 562). Verified that nothing in the repo does `import eis_companion.vision` and then reaches a submodule as an attribute; every consumer uses `from <pkg> import <Name>` or imports the submodule directly. A missing optional backend (cv2/ultralytics/websockets) now surfaces its ImportError at the `from ... import Name` line rather than at package import - same line for every current caller.
- The brief predicted a pre-existing failure in test_resolve_default_is_site_json_at_repo_root; running from <WT>\platform as instructed, it passes, and the baseline run had 0 failures. Nothing was masked.
- No node_modules junctions were created (this area is Python-only), so none needed removing; the main checkout's node_modules trees were never touched.
- Files outside my ownership list were not modified. app.py line ~2959 carries a comment referencing `_enforce_safety_floor` by name and tests/test_app_wiring.py line 626 does too - the function name was deliberately kept so those references stay accurate.

### Area `companion-mavlink`

**`platform/companion/src/eis_companion/mavlink/safety.py`** — rewritten. Baseline attribution 415/500 (83.0%) -> 257/776 (33.1%). NEW SECTION: the FC-egress clamp the area brief asked for, as pure logic that unit-tests with no vehicle -- clamp_body_velocity(setpoint, limits), clamp_speed_for_fc, clamp_altitude_for_fc, clamp_goto_target. All numeric hygiene funnels through one _finite() -> Optional[float] helper so 'unusable' is decided once: a non-finite or non-numeric value on ANY axis collapses the WHOLE setpoint to VelocitySetpoint.hold() (never to a bound -- min(hi, nan) == hi was the FM-05/06/07 trap), an unusable Limit bounds its own axis at zero, and the goto band [0, cap] deliberately skips Limits.min_speed so a profile degraded to 0.0 stays 'no motion'. DEADMAN: rewritten from a two-branch if/else with a bare _deadman_latched bool into a three-outcome resolution (healthy / stale-but-unattended / tripped) over a frozenset of operator-steered sources, with the latch stored as a timestamp (_tripped_since_ms) instead of a flag, exposed through new read-only deadman_latched and deadman_down_ms accessors (the old flag had four writes and zero reads, FM-03); staleness is written 'not (age <= timeout)' so an unusable age reads stale. ARMING: the imperative if-chain became a (applies, failed, message) rule table evaluated in report order, with the 'is this rail even reporting?' predicate named once (reporting_voltage / reporting_soc) instead of repeated 0.0 < x < y comparisons; identical failure strings, identical ordering. PARAM MAP: failsafe_param_map composed from eight per-concern group builders (_fence_params, _battery_params, _ground_link_params, _rc_params, _ekf_params, _rtl_params, _speed_params, _arming_params) merged in a stable order instead of one 50-line literal; _geofence_radius -> _containment_radius_m and _rtl_alt_cm -> _rtl_altitude_cm with the RTL band expressed as named constants (_RTL_ALT_FLOOR_M/_CAP_M/_FENCE_MARGIN_M); module-level `import math` replaces the lazy in-function import. SafetyManager.failsafe_param_map gained a geofence_radius_m kwarg (a superset; existing callers unaffected). Module docstring rewritten.

- *Preserved:* Exported names: SafetyManager, ArmCheckResult, LinkStatus, EmergencyPlan, FailsafeAction, failsafe_param_map, DEFAULT_PACK_CELLS, CELL_LOW_VOLT, CELL_CRT_VOLT, now_ms (all pre-existing) plus new clamp helpers and the two geofence-radius constants; SafetyManager(limits, *, clock_ms=now_ms); .limits property; update_limits; note_ground_heartbeat(ts_ms=None); ground_link_age_ms(); evaluate_link(control_source, *, airborne=True); check_arming(state, **13 keyword defaults unchanged); emergency_stop_plan(state, *, prefer_land=True); failsafe_param_map(*, cell_count, geofence_radius_m); LinkStatus/ArmCheckResult/EmergencyPlan field names, defaults and ArmCheckResult.message wording ('Arming blocked: ', 'Arming preconditions OK', ' (warnings: ...)'); FailsafeAction member names and string values none/hold/rtl/land/disarm; evaluate_link reason strings ('ground link healthy', 'ground link stale (Nms) but source=X; FC GCS failsafe is the backstop', 'DEADMAN: no ground heartbeat for Nms (> Nms) while X active -> stop guidance, hold, ACTION'); failsafe_param_map returns dict[str, float] with the same 26 parameter names and values; only the map's internal ordering is grouped differently (both producer and consumer iterate the same map, so ordering is self-consistent); Pure stdlib: no pymavlink / numpy import, so the module still unit-tests with no hardware
- *Identical-line exceptions:* FailsafeAction enum members and their contract string values; LinkStatus / ArmCheckResult / EmergencyPlan dataclass field declarations and defaults (these ARE the contract shape); DEFAULT_PACK_CELLS = 4, CELL_LOW_VOLT = 3.5, CELL_CRT_VOLT = 3.3; DEFAULT_GEOFENCE_RADIUS_M = 60.0, MIN_GEOFENCE_RADIUS_M = 20.0, LiPo series band 1..12; RTL band 5.0 m floor / 15.0 m cap / 2.0 m fence margin; Every ArduCopter parameter NAME and VALUE in failsafe_param_map: FENCE_ENABLE 1, FENCE_TYPE 3, FENCE_ACTION 1, FENCE_ALT_MAX, FENCE_MARGIN 2, FENCE_RADIUS, BATT_MONITOR 4, BATT_FS_LOW_ACT 2, BATT_FS_CRT_ACT 1, BATT_LOW_VOLT, BATT_CRT_VOLT, BATT_LOW_TIMER 10, FS_GCS_ENABLE 1, FS_GCS_TIMEOUT, FS_THR_ENABLE 1, FS_THR_VALUE 975, FS_EKF_ACTION 1, FS_EKF_THRESH 0.8, RTL_ALT, RTL_ALT_FINAL 0, WPNAV_SPEED, WPNAV_SPEED_UP, WPNAV_SPEED_DN, PILOT_SPEED_UP, ARMING_CHECK 1, GPS_HDOP_GOOD 250; check_arming keyword defaults (min_satellites 6, max_hdop 2.5, min_battery_remaining 20.0, gps_hdop 99.0, 3D-fix threshold 3) and the failure-message strings; import list, `def now_ms(): return time.time() * 1000.0`, class/def headers, __all__ entries

**`platform/companion/src/eis_companion/mavlink/vehicle.py`** — partially-rewritten. Baseline attribution 675/1824 (37.0%) -> 335/2031 (16.5%). Only the baseline regions named in the brief were touched; the diff has clean gaps over teammates' work (health_inputs, sim_truth_inputs, set_ekf_source, gimbal, distance/obstacle/extnav senders, send_raw_global_target, _absorb/_recv/_wait_command_ack/_pending_inbox, _await_mode/_observed_custom_mode, apply_failsafe_params, fence_status/upload_geofence/_note_fence). CONNECTION: connect() is now TRANSACTIONAL -- the transport is opened and handshaken on the side and only a link that produced a heartbeat is installed, a failed handshake closes the half-open transport and leaves prior state untouched; adopting a link runs _adopt_fresh_session (clears _msgs/_msg_ts, _recv_error, _fc_ready, seeds the heartbeat with its timestamp, resets the fence claim) and _load_mode_mapping (also reused by set_mode's lazy refetch). close() now nulls _master and logs instead of swallowing, and is idempotent. TYPE MASKS: built by _ignore_mask() over named bit-group tuples rather than two hand-OR'd literals; the numeric values (1991 / 4088) are unchanged and independently pinned by test_vehicle.py. DATA STREAMS: the message list is a class-level table of NAMES resolved against the dialect at runtime by _streamed_message_ids(), and both protocol requests go through one _try() helper; SET_MESSAGE_INTERVAL now reuses _command_long (identical wire bytes). POLL: rewritten as a budgeted while loop counting messages KEPT; the FM-08 _recv_error semantics preserved exactly. TRANSLATION: introduced _kinematics(), a single unit-conversion boundary (rad->deg, degE7->deg, mm->m, cm/s down -> m/s up, heading %360) that both vehicle_state and read_telemetry consume, ending the duplicated arithmetic that let the two drift; the telemetry blocks split into _battery_report / _gps_report / _link_report with the MAVLink 'not measured' sentinels named as _UNMEASURED. COMMANDS: _command_long validates its parameter count and splats a padded tuple; arm/disarm share _set_motor_state(running, force) with the 21196.0 magic named _FORCE_MAGIC; land/rtl/brake share _enter_mode() which logs an unconfirmed mode; takeoff refuses (and sends nothing) when GUIDED is unconfirmed; set_mode's map lookup extracted to _resolve_mode_id() (the FM-02 verification loop is teammate code and is untouched). EGRESS: send_body_velocity now folds the setpoint through mavlink.safety.clamp_body_velocity against self._limits before the wire and builds both the command frame and the error-fallback zero frame from one _velocity_frame() constructor; goto_global validates coordinates through a new module-level _global_coordinates() -> Optional[tuple] and clamps through clamp_goto_target. PARAMS: set_param/get_param now share _await_param_echo(); set_param's retry policy is spelled out (echo matches -> True; echo DISAGREES -> False immediately; silence or a value-less echo -> retry). The old module-level _finite() was removed -- its job moved into safety.py's clamps, its only two call sites.

- *Preserved:* Every public method name and signature: connect, close, send_heartbeat, request_data_streams, poll, fc_heartbeat_age_s, message_age_s, fc_link_lost, vehicle_state, read_telemetry, get_state, get_telemetry, health_inputs, sim_truth_inputs, set_ekf_source, set_gimbal_pitch, gimbal_pitch_deg, send_distance_sensor, send_obstacle_distance, send_extnav_odometry, send_raw_global_target, arm, disarm, set_mode, takeoff, land, rtl, brake, send_body_velocity, hold, goto_global, set_param, get_param, apply_failsafe_params, fence_status, upload_geofence; properties connected, master, limits; update_limits; Private attributes the tests construct fakes against: _master, _connected, _target_system, _target_component, _msgs, _msg_ts, _mode_mapping, _inv_mode_mapping, _last_heartbeat_ts, _limits; Contract telemetry dict shape (type/ts/armed/mode/controlSource/attitude/position/velocity/heading/battery/gps/home/link/fcLink) and every unit conversion in it; Exact wire frames pinned by test_vehicle.py: DO_CHANGE_SPEED (1, speed, -1) then position-only SET_POSITION_TARGET_GLOBAL_INT in GLOBAL_RELATIVE_ALT_INT with degE7 scaling; MISSION_COUNT / MISSION_ITEM_INT / PARAM_SET FENCE_TYPE=5, FENCE_ENABLE=1; MAV_CMD_DO_MOUNT_CONTROL in MAVLINK_TARGETING with the contract->ArduPilot pitch sign flip; goto_global refusal semantics: nothing on the wire for a bad coordinate, for speed clamping to <= 0, or when not connected; set_param echo verification BY VALUE (FM-14), 3-retry default, never raising; _command_long raising RuntimeError('not connected'); connect raising RuntimeError without pymavlink and TimeoutError on no heartbeat; __all__ = ["Vehicle"]
- *Identical-line exceptions:* Type-mask numeric values 1991 (velocity+yaw-rate) and 4088 (position-only) -- rebuilt from named bit groups, same numbers; _STREAM_RATE_HZ = 10; FC_HEARTBEAT_TIMEOUT_S = 3.0; BATTERY_MAX_AGE_S = 5.0; WIND_MAX_AGE_S = 10.0 (the last two are teammate constants); MAVLink ids and enum references: MAV_FRAME_BODY_NED, MAV_FRAME_GLOBAL_RELATIVE_ALT_INT, MAV_CMD_COMPONENT_ARM_DISARM, MAV_CMD_NAV_TAKEOFF, MAV_CMD_DO_SET_MODE (176), MAV_CMD_DO_CHANGE_SPEED, MAV_CMD_SET_MESSAGE_INTERVAL, MAV_DATA_STREAM_ALL, MAV_PARAM_TYPE_REAL32, MAV_TYPE_GCS, MAV_AUTOPILOT_INVALID, MAV_STATE_ACTIVE, MAV_MODE_FLAG_SAFETY_ARMED, MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, MAV_MISSION_TYPE_FENCE; ArduPilot force-arm magic 21196.0; FS_THR-style literals inside teammate senders; The 0.5 m airborne gate, the 99.0 unusable-HDOP sentinel, the 9999.0 dead-link latency sentinel, the (0, 65535) not-measured sentinels; Import list, the pymavlink import guard's try/except structure, class header, __all__, and the unchanged public signatures listed above

**`platform/companion/src/eis_companion/mavlink/__init__.py`** — rewritten. Baseline attribution 52/58 (89.7%) -> 23/77 (29.9%). Docstring rewritten around the hardware / pure-stdlib split and the new FC-egress clamp. The hand-written `if name == "Vehicle": from .vehicle import Vehicle` lazy hook became a data-driven _LAZY mapping resolved with importlib.import_module, plus a __dir__ that surfaces the lazy names so tooling and REPL completion see Vehicle without importing pymavlink. Vehicle is still deliberately excluded from __all__ (now with the reason stated) so a star-import cannot be what drags pymavlink onto a machine that only wanted SafetyManager.

- *Preserved:* Eager exports SafetyManager, ArmCheckResult, LinkStatus, failsafe_param_map; __all__ unchanged (Vehicle still absent from it); `from eis_companion.mavlink import Vehicle` still works and still imports pymavlink lazily, on first access only; AttributeError message format for an unknown attribute
- *Identical-line exceptions:* The four re-exported names and the __all__ list contents; `from __future__ import annotations`, the `from .safety import (...)` list, and the AttributeError f-string

**`platform/companion/tests/test_mavlink_clamp.py`** — added. 340 lines, 66 tests. Covers the FC-egress clamp end to end: per-axis bounds against Limits, pass-through inside the envelope, that the stage only TIGHTENS (never restores a degraded envelope), valid=False staying the canonical hold; the full non-finite domain (nan/inf/-inf x each of the four axes) collapsing the WHOLE setpoint to the hold and explicitly NOT to the bound; a non-numeric axis; an unusable or negative Limit; the goto speed/altitude bands including the deliberate absence of the min_speed floor; and then the wire itself, against a recording pymavlink double -- clamped axes and the deg/s->rad/s conversion in the SET_POSITION_TARGET_LOCAL_NED frame, a NaN axis arriving as a sent zero-hold frame, an invalid setpoint still being transmitted, silence without a link, the one zero-hold retry after a raising send, update_limits taking effect, and goto_global refusing a non-finite speed / zeroing a non-finite altitude. The velocity type mask is written as the literal wire number, not imported from the module under test.

**`platform/companion/tests/test_mavlink_failsafe_params.py`** — added. 334 lines, 33 tests. Two halves. DERIVATION: the map tracks the same Limits the software clamps use (FENCE_ALT_MAX, the four WPNAV/PILOT cm/s caps), FS_GCS_TIMEOUT tracks the companion deadman and never drops below 1 s, per-cell battery thresholds for every supported series count with a nonsense count (0, -3, 13, 99, None, '4S', 2.5e300) degrading to the BOM pack, a site-sized fence circle with an unusable radius falling back rather than disabling containment and a tiny one raised to the floor, RTL_ALT staying inside [5, 15] m and under FENCE_ALT_MAX across realistic fences, the arming/RC/EKF rungs present and enabled, and the SafetyManager wrapper agreeing with the module function including after update_limits. APPLICATION: every derived parameter reaching the wire with its derived value and as REAL32, cell count following through to BATT_LOW_VOLT/BATT_CRT_VOLT on the wire, a parameter the FC clamped reported as a named failure rather than a success, total silence failing every entry, a link that raises on every send being survivable, and no link reporting everything unapplied with nothing sent. Plus set_param's primitives: a disagreeing echo settling the question without retrying, silence consuming the retry budget, a value-less echo proving nothing, REAL32 round-trip tolerance, and get_param returning None rather than a fabricated default while reading past parameters it did not ask for.

Tests added:

- platform/companion/tests/test_mavlink_clamp.py (66 tests: FC-egress clamp bounds, the non-finite domain on every axis, unusable limits, goto speed/altitude bands, and the clamped values reaching a recording pymavlink double)
- platform/companion/tests/test_mavlink_failsafe_params.py (33 tests: failsafe param derivation -- per-cell battery, site-sized fence circle, RTL under the fence, speed caps -- and its application to the FC with echo-by-value verification, clamped/silent/raising links reported as failures)

Caveats and deliberate deltas:

- DELIBERATE BEHAVIOUR STRENGTHENING in send_body_velocity: it now clamps to the Vehicle's Limits before the wire, where the old docstring said it explicitly did NOT. Rationale: platform/CLAUDE.md and the brief both state 'every setpoint is clamped to Limits twice (in-component and again before the FC)', and the area brief assigns 'the second-stage setpoint clamp before the FC' to this area. It can only tighten. Verified safe: app._build_vehicle passes limits=self.limits (the SAME live object) and _sync_safety_limits keeps it current, self.limits is never reassigned in app.py, and app._clamp_setpoint's _envelope_speed_scale only ever lowers the value further -- so on the real path this second clamp is a no-op. No test called Vehicle.send_body_velocity on a real Vehicle before; all 741 pass.
- RELATED CHANGE: a non-finite value on any axis now collapses the WHOLE velocity frame to the zero hold. The old code zeroed only the offending axis and sent the other three. Strictly safer, matches the FM-05/06/07 policy elsewhere in the tree, and is now pinned by test_mavlink_clamp.py.
- connect() now clears the inbound message cache (_msgs/_msg_ts) and resets the fence claim to 'not attempted' when adopting a link. Previously a reconnect kept the previous session's cached telemetry and its fence verdict. More honest (a fence proven on a dropped link is not proven on this one) and no test covers connect(), which needs real pymavlink -- but an integrator should know the orchestrator must re-run _upload_site_fence after any reconnect. It already does (the fence upload follows connect in app.py).
- close() now sets _master = None, so the .master property returns None after close instead of a closed object. Nothing in the repo reads .master (grepped src, tests, sim).
- The module-level _finite() helper was DELETED from vehicle.py -- not to remove a behaviour, but because its only two call sites now clamp through mavlink.safety, which owns the same non-finite policy. It was private and unexported.
- apply_failsafe_params, upload_geofence/fence_status/_note_fence, health_inputs, sim_truth_inputs, set_ekf_source, the gimbal pair and the distance/obstacle/extnav senders are teammate additions (FM-08/09/13/14/15/16/19/20) and were left behaviourally untouched; only their surroundings changed. They still call the reimplemented set_param / _command_long / _recv.
- SafetyManager.failsafe_param_map gained a geofence_radius_m keyword (previously only the module-level function had it). Additive; no existing caller passes it.
- SafetyManager gained read-only deadman_latched / deadman_down_ms accessors. The old _deadman_latched bool had four writes and zero reads (docs/FAILURE_MODES.md FM-03); the latch is now a timestamp with a readable surface, in case the orchestrator owner wants to consume it. Nothing depends on it yet.
- safety.py, __init__.py and the two new test files were written with LF and then normalised to CRLF to match the rest of the tree (core.autocrlf=true here); vehicle.py was edited in place and kept CRLF throughout.
- `python -m pytest ... -q` gives NO summary line here because pyproject sets addopts='-q' and the extra -q makes it -qq. Run without the extra -q to see the count.

### Area `scripts`

**`platform/sim/run_sitl.sh`** — rewritten. Was a top-to-bottom straight-line script with two re-registered EXIT traps. Now: named constants for the wire facts; backend discovery factored into locate_sim_vehicle/locate_sitl_binary that echo a path or fail; launch_via_sim_vehicle (exec) and launch_via_binary as separate strategies; one teardown() registered once on EXIT/INT/TERM; require_params also absolutises PARAMS so mavproxy/sim_vehicle are cwd-independent; the raw-binary backend runs inside the scratch dir so eeprom/log droppings no longer land in the caller's cwd; new --help and --preflight (leading arg only, everything else still forwarded verbatim to sim_vehicle.py). Baseline attribution after the rewrite: 89/338 lines.

- *Preserved:* udp:127.0.0.1:14550 (companion) and udp:127.0.0.1:14551 (spare GCS) MAVLink outs; tcp:127.0.0.1:5760 as the raw-binary endpoint bridged by mavproxy.py; EIS_SITL_PARAMS default sim/params/eis-sitl.parm; EIS_SITL_SPEEDUP default 1; EIS_SITL_HOME default 14.5995,120.9842,10,0; EIS_SITL_BIN explicit binary override; ARDUPILOT_HOME with ~/ardupilot fallback; backend probe order: sim_vehicle.py (PATH, $ARDUPILOT_HOME/Tools/autotest, ~/ardupilot/Tools/autotest) then arducopter binary (EIS_SITL_BIN, PATH, <ap>/build/sitl/bin, ~/ardupilot/build/sitl/bin); sim_vehicle.py flags: -v ArduCopter -f quad --speedup --custom-location= --add-param-file= --out= --out= --no-mavproxy plus "$@"; binary flags: --model quad --home --speedup --defaults; mavproxy flags: --master=tcp:127.0.0.1:5760 --out= --out= --load-module=param --cmd="param load $PARAMS" --daemon --non-interactive; 3 s settle before bridging; exit 1 params missing, exit 127 no backend; the two operator-facing error blocks verbatim
- *Identical-line exceptions:* #!/usr/bin/env bash and set -euo pipefail; the whole ONE-TIME ArduPilot install / tag-pin / WINDOWS-WSL2 documentation block (operator documentation, deliberately carried over); the two heredoc error messages (no backend; mavproxy missing) — operator-visible copy; the sim_vehicle.py / arducopter / mavproxy.py flag lists and the MAV_OUT_* / SITL_TCP constants (the ArduPilot CLI contract); structural lines: banner rules, blank lines, bare fi

**`platform/scripts/run-sim-e2e.sh`** — rewritten. Was linear with inline background PIDs and an inline python -c readiness heredoc. Now a staged pipeline: parse_args -> check_environment -> write_probes -> start_sitl -> start_companion -> wait_for_companion -> run_acceptance, with a supervised-child registry (CHILD_PIDS/CHILD_LABELS) torn down in reverse order, a RESULTS ledger printed on every path, and named exit-code constants. Readiness probes are two real .py files written to a temp dir, with capability detection at preflight choosing the websockets probe or a TCP fallback instead of failing silently for the whole budget. Added --help, --preflight, --skip-manual, --ws-url, --timeout, --config. Baseline attribution after the rewrite: 66/363 lines.

- *Preserved:* exit 0 pass / 1 test failed / 2 setup failed; EIS_E2E_WS_URL default ws://127.0.0.1:8765; EIS_E2E_TIMEOUT default 60; EIS_CONFIG default <repo>/companion/config/sitl.yaml; EIS_SKIP_MANUAL=1 skips manual_test.py; ARDUPILOT_HOME passes through to sim/run_sitl.sh; companion venv at companion/.venv/bin/python; missing venv is exit 2 with the 'run scripts/setup-sim.sh' hint; SITL started via bash sim/run_sitl.sh in the background with an 8 s settle and a liveness check; companion started from the repo root with EIS_CONFIG set and EIS_CAMERA_SOURCE=mock; 2 s readiness poll interval; sim clients invoked as <python> <repo>/sim/<client> --ws-url <url> (flag kept stable for the concurrent sim-clients rewrite); teardown stops everything it started, including on Ctrl-C and on failure

**`platform/scripts/run-sim-e2e.ps1`** — rewritten. Was one long try/catch with inline job handling. Now decomposed into ConvertTo-WslPath, Split-WsUrl, Register-BackgroundJob/Assert-JobAlive/Stop-BackgroundJobs (a job registry torn down newest-first), Test-Preconditions, Start-Sitl, Start-Companion, Test-WebSocketPort, Wait-ForCompanion, Invoke-SimClient and Show-Ledger. Added -Preflight. The Windows->WSL mapping now lower-cases only the drive letter instead of the whole path. The FM-142 header rationale and the 5.1-compatible default resolution (teammate commit 182dc075, 25 lines) are preserved verbatim and the file is still 5.1-parseable. Baseline attribution after the rewrite: 94/383 lines.

- *Preserved:* parameters -WsUrl, -Timeout, -SkipManual, -UseNativePy; EIS_E2E_WS_URL / EIS_E2E_TIMEOUT / EIS_SKIP_MANUAL / EIS_USE_NATIVE_PY with the same defaults (ws://127.0.0.1:8765, 60); exit 0 pass / 1 failure; SITL always in WSL2: wsl -d Ubuntu -- bash -lc "cd '<wslpath>' && bash sim/run_sitl.sh"; 10 s SITL settle, job-state check afterwards; native placement uses companion\.venv-win\Scripts\python.exe with companion\config\sitl.yaml and EIS_CAMERA_SOURCE=mock; the same 'python -m venv companion\.venv-win ...' remedy text; WSL placement sources companion/.venv/bin/activate and uses companion/config/sitl.yaml; TcpClient readiness probe on the ws:// host/port, default port 8765, 2 s polls; sim clients invoked with --ws-url; Windows PowerShell 5.1 compatibility (FM-142): no ??, ?., ?:, &&/||, -AsHashtable, 3-arg Join-Path
- *Identical-line exceptions:* the FM-142 header block and the four env-default `if` statements (teammate work at commit 182dc075, preserved on purpose); Write-Step/Write-OK/Write-Fail/Write-Info one-liner helper definitions; the ALL E2E TESTS PASSED / E2E TESTS FAILED banner blocks (operator-visible copy)

**`platform/scripts/setup-sim.sh`** — rewritten. Was linear with a helper defined AFTER the early-exit paths that call it (a live bug: under set -e those paths died with 'command not found' instead of printing the manual recipe and exiting 0). Now: print_manual_sitl_recipe is defined first; stages are require_python / ensure_venv / install_companion / ensure_ardupilot / print_next_steps; ArduPilot work is split into locate_sim_vehicle, have_compiler, cpu_count, clone_ardupilot, install_ardupilot_prereqs, build_sitl, persist_autotest_on_path. Version comparison is a pure-bash major/minor test instead of `printf | sort -V | head`. Added --help and --check (reports interpreter, venv, eis_companion importability, sim_vehicle.py, git, compiler; installs nothing). Baseline attribution after the rewrite: 106/355 lines.

- *Preserved:* interpreter search order python3.12, python3.11, python3.10, python3, python; minimum 3.10; exit 1 with the apt/brew hints when none qualifies; venv at companion/.venv, created only when absent; pip install --quiet --upgrade pip wheel, then pip install -e companion[dev]; ArduPilot tag Copter-4.5.7 from https://github.com/ArduPilot/ardupilot.git; ARDUPILOT_HOME with ~/ardupilot fallback; clone flags --branch <tag> --depth 1 --recurse-submodules; prereq scripts install-prereqs-ubuntu.sh / install-prereqs-mac.sh run with -y, non-zero tolerated, then ~/.profile sourced; python3 waf configure --board sitl && python3 waf copter -j<cpus>; export PATH append to ~/.bashrc, guarded against duplicates; ARDUPILOT_HOME exported; missing git or compiler prints the manual recipe and exits 0; the next-steps banner text
- *Identical-line exceptions:* #!/usr/bin/env bash, set -euo pipefail, IFS=$'\n\t'; the pinned ArduPilot tag/repo URL and the 3.10 minimum; the manual-SITL recipe heredoc and the next-steps banner (operator-visible copy); the waf / git clone / prereq command lines (the ArduPilot build contract)

**`platform/scripts/setup-jetson.sh`** — rewritten. Was linear. Now staged into require_docker / probe_gpu_passthrough / build_image / install_service / print_tensorrt_recipe / print_config_reminder, with docker_install_advice and docker_version as separate helpers. docker_version uses a portable sed extraction instead of GNU-only `grep -oP`. install_service samples systemctl is-active BEFORE enabling, so the restart genuinely means 'a live service is being redeployed' rather than depending on enable's side effects. Added --help and --check (Docker, Dockerfile, unit file, installed unit, weights dir, image presence; builds nothing, calls no sudo). Baseline attribution after the rewrite: 84/293 lines.

- *Preserved:* image eis-companion:latest built with --tag/--file/<repo root> as context from companion/Dockerfile; GPU probe against nvcr.io/nvidia/l4t-base:36.2.0 with --gpus all --entrypoint ""; failure warns and continues; systemd unit copied from companion/systemd/eis-companion.service to /etc/systemd/system/eis-companion.service, then daemon-reload + enable, and restart when it was already active; exit 1 when Docker, the Dockerfile or the unit file is missing, with the same remedy text; JetPack 6.x / L4T 36.2.0 pins; the TensorRT-export and network/config reminder sections, including the yolo11n.pt URL, the docker run --gpus all -v <weights>:/app/weights recipe, engine_path, mav_url/camera_source/ws_port 8765/rtsp_port 8554, 192.168.1.42, EIS_HOST/EIS_SITL
- *Identical-line exceptions:* #!/usr/bin/env bash, set -euo pipefail, IFS=$'\n\t'; the Docker-not-found heredoc and the two 'packaging agent should have created it' messages (operator-visible copy); the docker build / docker run / systemctl command lines and the image, service and L4T constants; most of the TensorRT and configuration reminder text

**`platform/scripts/setup-ground.ps1`** — rewritten. Was three copy-pasted Push-Location/npm install blocks, three copy-pasted build blocks and a separate $required artefact array. Now the three workspaces are one table (Get-Workspaces: Name/Path/Script/Artefacts, each artefact paired with what loads it) and Install-Workspaces / Build-Workspaces / Assert-Artefacts / Show-State all walk it, with a single Invoke-Npm doing Push/Pop in a finally. Added -Preflight. Baseline attribution after the rewrite: 68/305 lines.

- *Preserved:* Node >= 20 and npm required; missing/old is exit 1 with the nodejs.org text; npm install --prefer-offline in ground\planner, ground\ui, ground\app\windows, in that order; builds in load order: planner `npm run build`, ui `npm run build`, app `npm run build:electron`; EIS_SKIP_BUILD=1 installs dependencies and skips every build AND the artefact assertions, with the same two warning lines; artefact assertions for planner dist\index.js, ui dist\index.html, app dist-electron\main.js and dist-electron\preload.js, each named by what loads it (FM-83 / FM-132); 'ground/<x> not found at <path>' failure text; every failure exits 1; the next-steps banner; Windows PowerShell 5.1 compatibility
- *Identical-line exceptions:* Write-Step/Write-OK/Write-Fail/Write-Info one-liner helper definitions; $RepoRoot derivation and Set-StrictMode/$ErrorActionPreference preamble; the four artefact 'What' strings and the next-steps banner lines (operator-visible copy)

**`platform/scripts/setup-ground-linux.sh`** — rewritten. Was three copy-pasted install blocks, three copy-pasted build blocks and four hand-written assert_artefact calls. Now a WORKSPACES record table ('label|dir|script|artefacts') with accessor functions (ws_label/ws_dir/ws_script/ws_artefacts/each_artefact) driving install_workspaces, build_workspaces, assert_artefacts and a new report_state; artefact_purpose maps each built path to the thing that loads it. Added --help and --check. Baseline attribution after the rewrite: 41/259 lines.

- *Preserved:* Node >= 20 and npm required; failures exit 1 with the same messages; npm install --prefer-offline in ground/planner, ground/ui, ground/app/linux; builds in load order: planner `npm run build`, ui `npm run build`, app `npm run build:electron`; EIS_SKIP_BUILD=1 installs dependencies and skips every build and every assertion, with the same two lines; artefact assertions for planner dist/index.js, ui dist/index.html, app dist-electron/main.js and dist-electron/preload.js (FM-83 / FM-132); the next-steps banner including make-icons.sh, npm run package:linux and the udev/gamepad note
- *Identical-line exceptions:* #!/usr/bin/env bash and set -euo pipefail; the ANSI cyan/ok/fail printf helper bodies; the four artefact purpose strings and the whole next-steps heredoc (operator-visible copy)

**`platform/scripts/test/scripts-run-sim-e2e.test.sh`** — added. Hermetic behavioural harness for the acceptance gate: builds a throwaway repo-shaped tree per case whose companion/.venv/bin/python is a shim answering every way the gate uses python (the `import websockets` capability probe, probe_ws.py/probe_tcp.py, `-m eis_companion.app`, and the two sim clients), logging each call. Readiness is a flag file, so no port is ever bound and no network is used. 39 assertions over 13 cases covering the exit-code contract, ordering, env/flag propagation, teardown and the probe fallback.

**`platform/scripts/test/scripts-powershell.test.ps1`** — added. Static + unit tests for the two PowerShell scripts with no Pester dependency. Asserts both files parse under the 5.1 parser and carry no 7-only operator TOKENS (tokeniser, not text scan, because `&&` legitimately appears inside the bash strings passed to `wsl -- bash -lc`) — that is FM-142 as a regression test. Then lifts ConvertTo-WslPath and Split-WsUrl out of run-sim-e2e.ps1 by AST and dot-sources only those, so importing them cannot start SITL, and pins the /mnt/<drive> mapping and the ws:// host/port split including the 8765 default. 15 assertions.

Tests added:

- platform/scripts/test/scripts-run-sim-e2e.test.sh — 39 assertions: green run exits 0 and runs both clients; a failing e2e_test.py exits 1 while manual_test.py still runs; a failing manual_test.py exits 1; --skip-manual and EIS_SKIP_MANUAL=1 both skip manual_test.py; missing venv / missing config exit 2 before anything is started; an unready companion exits 2 at the --timeout budget with no client run; a companion that dies is named before the budget expires; SITL dying in the settle window exits 2; the websockets-missing path falls back to the TCP probe and still completes; --preflight starts nothing; an unknown option exits 2; --help exits 0 and documents the exit codes; clients receive both --ws-url and EIS_WS_URL; the companion gets EIS_CONFIG, EIS_CAMERA_SOURCE=mock and the repo root as cwd.
- platform/scripts/test/scripts-powershell.test.ps1 — 15 assertions: run-sim-e2e.ps1 and setup-ground.ps1 both parse under the Windows PowerShell 5.1 parser and contain no 7-only operator tokens (FM-142 regression guard); ConvertTo-WslPath maps C:/ and D:/ paths under /mnt/<drive> and preserves casing below the drive letter; Split-WsUrl returns host+port for ws:// and wss:// URLs with and without an explicit port, defaulting to 8765.

Caveats and deliberate deltas:

- COULD NOT EXECUTE, by design of this box: any real run of the gate or the launcher. There is no ArduPilot checkout, no arducopter binary and no mavproxy (run_sitl.sh --preflight returns 127); no companion/.venv and no companion/.venv-win; SITL cannot run natively on Windows at all. WSL2 was not entered. Docker Desktop is present but no Jetson/L4T, so setup-jetson.sh's docker build, the --gpus probe and every sudo systemctl call are unexecuted. npm install / npm run build were never run (the brief forbids downloads), so the install and build arms of both setup-ground scripts are unexecuted — only their preflight/check arms, which walk the same workspace table and the same artefact list, were run.
- PowerShell 7 is NOT installed on this box (pwsh absent), so the 7+ arm of the dual-version claim is unverified. Both .ps1 files were parsed with the Windows PowerShell 5.1 parser, which is the stricter of the two for this purpose: 7-only syntax fails there and passes under 7. The new PowerShell test also asserts absence of 7-only operator tokens.
- DELIBERATE BEHAVIOUR FIX 1 (run-sim-e2e.sh): the baseline ran under `set -uo pipefail` with NO `-e` and no status checks, so a failing e2e_test.py printed '[OK] e2e_test.py PASSED' and the script still exited 0 — the documented 'exit 1 = one or more tests failed' could not occur. Exit codes are now tracked explicitly. This changes observed exit status only in the case where a test actually failed.
- DELIBERATE BEHAVIOUR FIX 2 (run-sim-e2e.sh and run-sim-e2e.ps1): both launched the companion as `python -m eis_companion`, but there is no platform/companion/src/eis_companion/__main__.py, so that invocation raises 'No module named eis_companion.__main__'. Both now use `-m eis_companion.app`, which is what app.py's own docstring, CLAUDE.md, sim/README.md and pyproject's console entry point (eis_companion.app:main) all name. NOTE FOR THE INTEGRATOR: platform/Makefile (`sim` target) and platform/justfile (`sim` recipe) still carry the broken `-m eis_companion` — both are on the do-not-modify list, so they are reported, not fixed.
- DELIBERATE BEHAVIOUR FIX 3 (both e2e runners): EIS_E2E_WS_URL was documented as the WebSocket URL but only ever reached the sim clients as `--ws-url`, which neither e2e_test.py nor manual_test.py currently parses (they have no argparse; they read EIS_WS_URL). Setting EIS_E2E_WS_URL therefore had no effect on the tests. The runners now export EIS_WS_URL as well as passing --ws-url, so the documented variable works whichever way the concurrent sim-clients rewrite lands. The --ws-url flag is unchanged and still passed first.
- DELIBERATE BEHAVIOUR FIX 4 (setup-sim.sh): the baseline defined _print_manual_sitl_steps at the END of the file but called it from two early-exit paths near the middle. Under `set -euo pipefail` those paths died with 'command not found' instead of printing the recipe and exiting 0. The helper is now defined before any caller.
- DELIBERATE BEHAVIOUR FIX 5 (setup-ground.ps1): `Set-StrictMode -Version Latest` at the top of the script leaks into npm's PowerShell shim, whose `if ($MyInvocation.Statement)` then throws PropertyNotFoundStrict — on this box every npm call failed before npm ran. Reproduced live (the first -Preflight run exited 1). npm is now resolved once, preferring npm.cmd (an external process, immune to the caller's strict mode), falling back to whatever `npm` resolves to. This makes the baseline's install/build path work rather than changing what it does.
- SMALLER DELIBERATE CHANGES: run-sim-e2e.ps1 lower-cases only the drive letter when mapping to /mnt (the baseline lower-cased the entire path, which only survives because WSL drvfs is case-insensitive by default); run_sitl.sh runs the raw SITL binary from its scratch directory so eeprom/log files stop landing in the caller's cwd (PARAMS is absolutised first, so --defaults still resolves); setup-jetson.sh's printed TensorRT command was `python -m eis_companion.vision.export_trt --model ... --output ...` but the module is eis_companion.vision.export_tensorrt and its flags are --model/--out/--imgsz/--workspace — the printed recipe now matches the real CLI.
- NEW SURFACE ADDED (additive only, nothing removed): --help plus --preflight (run_sitl.sh, run-sim-e2e.sh) or --check (setup-sim.sh, setup-jetson.sh, setup-ground-linux.sh) or -Preflight (both .ps1). run-sim-e2e.sh also accepts --skip-manual/--ws-url/--timeout/--config as overrides for the existing env vars. Every script still behaves exactly as before when invoked with no arguments, which is how the Makefile and justfile call them. In run_sitl.sh only a LEADING --help/--preflight is consumed; all other arguments are still forwarded verbatim to sim_vehicle.py.
- The sim clients' CLI was treated as frozen: run-sim-e2e.{sh,ps1} still invoke `sim/e2e_test.py --ws-url <url>` and `sim/manual_test.py --ws-url <url>`. As of this worktree neither file parses argv at all, so the flag is currently inert; it is preserved verbatim for the concurrent sim-clients rewrite.
- Files were written with LF endings. The repo has no .gitattributes and core.autocrlf is on, so the index already stores LF (git ls-files --eol reports i/lf w/crlf); git printed the usual 'LF will be replaced by CRLF' warnings on add. The committed blobs are LF, which is required for the .sh files to run under WSL2/Linux.
- Two bugs in my own drafts were found only by running the new preflight paths, not by bash -n: the file-level IFS breaking `read -r major minor` in setup-sim.sh, and a missing trailing newline dropping the last artefact of every workspace record in setup-ground-linux.sh. Both are fixed and re-verified. This is the argument for keeping the --check/--preflight paths.
- Branch is worktree-wf_ce7573cf-b9c-6 (the pre-existing branch of this assigned worktree, created by the harness) — not opus/scripts, which the isolation instructions only required had I been in the shared main checkout. Nothing was pushed.

### Area `companion-api-app`

**`platform/companion/src/eis_companion/api/server.py`** — rewritten. Reimplemented from platform/shared/shared.py. Baseline-attributed lines 293 -> 171; file 623 -> 837 lines (47.0% -> 20.4% baseline share). FOUR structural changes: (1) inbound handling is an ordered ADMISSION PIPELINE of gate methods returning a _Verdict dataclass (_gate_decode -> _gate_addressed_here -> _gate_authorized -> _credit_liveness) replacing inline sequential ifs, so authorization provably precedes the ground-link liveness credit; (2) message dispatch is a declarative module-level _ROUTES table of _Route(slot, ack_type, broadcast_ack) replacing the if/elif chain in _on_message, with manualInput / planHeartbeat / rfEvent / fleet declared ACK-LESS IN THE TABLE so the fire-and-forget rule is a property of routing data rather than of a branch; _dispatch_command/_dispatch_manual/_dispatch_message/_authorize collapse into _route + _ack_missing_handler + _ack_failure + _reject; (3) broadcast delivery moved from a serial for-loop into a _Fanout helper that fans out concurrently via asyncio.gather with per-client bounded sends -- one stalled reader now costs the telemetry pump ONE timeout instead of one per client, with identical eviction/drop-counter semantics; (4) the audit ring buffer + hash chain + disk replay moved into an _AuditJournal class, with _audit_events and _chain kept as read-only properties for compatibility. Added _resolve() (uniform sync/async hook awaiting), _close_quietly(), _envelope() frame builder, _push_typed(). _dumps() keeps the strict-first/sanitise-on-failure fast path. The __init__ Args docstring was rewritten to document the full parameter set (it previously covered 4 of 18).

- *Preserved:* ApiServer.__init__ keyword signature unchanged (host, port, command_handler, manual_handler, heartbeat_hook, plan_command_handler, plan_heartbeat_handler, rf_event_handler, fleet_handler, connect_messages, client_connected_hook, client_disconnected_hook, vehicle_id, audit_path, max_queue, authorize_hook, max_frame_bytes, send_timeout_s); __all__ = ["ApiServer", "CommandHandler", "ManualHandler"] and the api/__init__.py re-export; Type aliases CommandHandler, ManualHandler, HeartbeatHook, MessageHandler, ConnectMessages, PresenceHook, AuthorizeHook; Module constants LOOPBACK_HOSTS, DEFAULT_MAX_FRAME_BYTES (262144), DEFAULT_SEND_TIMEOUT_S (2.0), _AUDITED_TYPES; Module functions _now_ms, _reject_constant, _finite_json, _dumps, _without_chain, _build_chain, _ack, _status_text (all imported by tests); Public methods/attrs: start, stop, broadcast, push_telemetry, push_tracking, push_status, push_ack, set_command_handler, set_manual_handler, set_heartbeat_hook, client_count, last_inbound_ms, inbound_age_ms, loopback_only, audit_head, verify_audit_chain, dropped_clients, dropped_frames; Private surface the suite pokes: _clients (a plain mutable set of raw sockets), _on_message, _send, _send_initial, _persist_audit, _load_audit, _max_frame_bytes, _send_timeout_s, _audit_events, _chain; Wire shapes: CommandAck (type/ts/vehicleId/command/success/message, correlated by command NAME with no requestId), statusText, planCommandAck (requestId/status/reason), telemetry/tracking envelope defaults; Hardening behaviour: bare NaN/Infinity JSON literals refused at the door (FM-05), non-finite outbound floats serialised as null (FM-36), authorization before liveness and a raising authorizer is a refusal (FM-40), bounded inbound frame size and per-send timeout eviction (FM-112), loopback-by-default bind policy, hash-chained audit + healthEvent replay tail of 100
- *Identical-line exceptions:* Import block (asyncio, json, logging, math, time, pathlib.Path, typing, websockets, websockets.server.WebSocketServerProtocol) -- necessary and unchanged; The seven type-alias declarations and their explanatory comments -- these ARE the module's published interface; The __init__ parameter list itself (names, order, defaults) -- the public constructor contract; The websockets.serve(...) call's keyword arguments (ping_interval=20, ping_timeout=20, max_queue, max_size) -- protocol/config contract; Constant VALUES: 8765, 262144, 2.0, LOOPBACK_HOSTS members, _AUDITED_TYPES members; _reject_constant and _build_chain bodies -- each is a single necessary statement plus its rationale; Section banner comments (# ---- liveness ----, etc.) -- changing them would be pure cosmetics, which the brief excludes; Short standard-syntax fragments (try:/except Exception:/pass/return) that git blame -w -M -C matches across any rewrite

**`platform/companion/src/eis_companion/app.py`** — partially-rewritten. Blame-guided: only the baseline-attributed orchestrator-skeleton regions were touched; every later-added feature region (envelope monitor internals, attendance/mode, planner execution, fusion, failsafe latches, security, staging, health ladder, fence upload) was left byte-identical and is still wired exactly as before. Baseline-attributed lines 890 -> 584; file 4049 -> 4747 lines (22.0% -> 12.3% baseline share). SIX structural changes: (1) LOOP SCHEDULER -- the four hand-rolled `while not self._stop.is_set(): t0=monotonic(); try tick; sleep_remaining` bodies collapse into one `_drive(cadence, tick, on_failure)` driver over a new `_Cadence` clock class that owns the period and the tick delta; each loop supplies its own safe-state reaction (_log_tick_failure, _control_tick_failed, _envelope_tick_failed) via the new _TickFailure alias. (2) CONTROL ARBITRATION -- _control_tick's linear early-return chain becomes an explicit `_ARBITRATION` priority ladder of named gate coroutines (_arb_emergency_stop, _arb_ground_link, _arb_manual, _arb_failsafe, _arb_takeoff_window, _arb_test_override), each returning True when it fully handled the tick, followed by _fly_active_source/_active_setpoint for source election; the failsafe branch split into _failsafe_return / _failsafe_hold / _is_holding_failure / _lidar_recovery_climb. (3) COMMAND TABLE -- _dispatch's ~25-branch if/elif chain becomes a class-level `_COMMANDS` table of (method, takes-params, failsafe-exempt) plus two gate functions (_gate_estop, _gate_failsafe); the previously inline commands became _cmd_disarm/_cmd_takeoff/_cmd_land/_cmd_rtl/_cmd_set_mode/_cmd_select_target/_cmd_set_standoff/_cmd_set_max_speed. (4) TELEMETRY PUMP -- _telemetry_tick decomposed into _pump_fc_heartbeat, _read_fc_telemetry, _stamp_home, _stamp_identity, _stamp_health, _stamp_battery, _stamp_gimbal. (5) PERCEPTION -- _perception_tick decomposed into _observe_live_camera, _camera_rail_failed, _observe_staging_points, _observe_staged_sensors, _person_observations, _publish_tracking. (6) CONSTRUCTION -- __init__ split into _init_authority_state / _init_link_state / _init_health_state / _init_envelope_state / _init_mission_state grouped by WHO WRITES the state, with components created from a declared `_COMPONENT_SLOTS` map and faults from `_FAULT_RAILS`; setup() driven by a `_BUILD_PHASES` tuple (_build_control_core, _build_site_layer, _build_health_layer, _build_supervision_layer, _build_io_layer) with a shared `_optional()` factory guard that distinguishes ImportError (absent dependency, warning) from a construction bug (traceback). Also reimplemented: _clamp (explicit comparisons, NaN decided first), _great_circle_distance_m (+ new _is_geographic, _EARTH_RADIUS_M), _handle_manual_input (+ _usable_sticks, _STICK_AXES), _manual_setpoint (+ _manual_input_stale), _clamp_setpoint (+ _axis_caps), _send_setpoint, _release_all (+ _ENGAGEMENT_FLAGS), _on_deadman (+ _latch_link_lost, _announce_deadman), _assert_rtl (+ _rtl_attempt_throttled), _handle_command, _do_arm, _engage_manual (+ _ensure_guided_for_manual), _emergency_stop (+ _emergency_stop_plan, _command_emergency), _vehicle_action, _maybe_clear_estop, _sync_safety_limits, _status, _vehicle_call, _sleep_remaining, _planner_tick (+ _end_plan), _stream_goto (+ _GOTO_REFRESH_S), _tracking_message (+ _detected_target, module-level _wire_value), _guidance_setpoint, _CameraSource.observe (+ _frame), _safe_call, _telemetry_from_state (+ _DEAD_LINK_LATENCY_MS), run/shutdown (+ _connect_flight_controller, _start_video, _cancel_loops), and the CLI (+ _install_signal_handlers). The module docstring was rewritten around the new structure.

- *Preserved:* Public surface: Companion(config), setup(), run(), shutdown(), request_stop(), main(argv), _parse_args, _amain, module constants TELEMETRY_HZ/TRACKING_HZ/CONTROL_HZ, FrameUnavailable, _CameraSource, _maybe_await, _safe_call, _plan_envelope_shape, _telemetry_from_state, _great_circle_distance_m, _clamp, _now_ms, _test_hook, _test_hooks_enabled; Every private name the suite pins, verified by grep across all 28 pre-existing test files: _vehicle_state, _control_tick, _execute_plan, _planner_engaged, _control_source, _failsafe_decision, _envelope_tick, _handle_command, _telemetry_tick, _perception_tick, _battery_snapshot, _nav_snapshot, _manual_engaged, _handle_fleet, _fc_ready, _estop_latched, _mission_record, _link_lost_latched, _gimbal_tick, _envelope_hold, _envelope_rtl, _envelope_speed_scale, _envelope_decision, _upload_site_fence, _tracking_engaged, _takeoff_deadline_ms, _guidance_override_active, _clamp_setpoint, _test_fault, _peer_sample, _last_fc_heartbeat_sent_s, _faults, _connect_messages, _camera_fixture_valid, _abort_plan, _thermal_observation_valid, _lidar_observation_valid, _site_containment_radius_m, _set_control_source, _rtl_last_attempt_ms, _on_operator_connected/_disconnected, _health_tick, _handle_manual_input, _fence_enforced, _camera_source_valid, _authorize_frame, _audit_path, _actual_datalink_lost, _wind_known, _stop, _sleep_remaining, _site_valid, _sensor_fixture_gaps, _readiness_message, _planner_tracking_tool, _note_ground_heartbeat, _maybe_corrupt_plan, _lidar_clear_reached, _lidar_clear_altitude_m, _last_applied_failsafe, _handle_plan_command, _envelope_loop, _detector_capabilities, _check_unattended_dispatch, _build_vision_source, _auto_gimbal_target, _apply_failsafe_params; Safety invariants: exactly one controlSource (auto|tracking|manual|planner) active and stamped into every telemetry frame; standoff owned by control/guidance.py and never overridden by the orchestrator; every setpoint clamped to Limits in-component AND again in _clamp_setpoint before the FC (goto legs clamped in planner_exec and again in Vehicle.goto_global); manual-input watchdog and ground-link deadman both zero-and-hold; the deadman LATCH survives the release to auto (FM-03) and re-asserts RTL until the FC is observed in RTL (FM-01/FM-02); e-stop latch clears only on an observed disarm on the ground (FM-24); non-finite axis collapses the whole setpoint to hold (FM-06) and _clamp returns 0.0 rather than hi for a non-finite input; envelope speed_scale bounded to [0,1] so it can only tighten; FC GCS heartbeat suppressed while the deadman is latched (FM-03); Command semantics: the full CommandName set from shared.py with unchanged gating order (emergencyStop above the latch gate; _ESTOP_ALLOWED; continueMission/testFault/enterUnattended/exitUnattended/setGimbal exempt from the failsafe gate; _FAILSAFE_SAFE_COMMANDS and the _FAILSAFE_SAFE_MODES setMode recovery exception; unknown commands still answered by the failsafe gate first, then "unknown command"); identical ack messages and (ok, message) strings; MAX_SPEED_CAP applied at setMaxSpeed with a non-finite request falling back to the cap; Wire formats: telemetry (including gpsHealth digest, navSource, failsafeState/Reason, battery compatibility aliases voltage/current/remaining, sortie None when disarmed, optional gimbal.pitchDeg), tracking (DetectedTarget bbox [x,y,w,h], estimatedDistance None not 0, live standoffDistance/maxSpeed), the degraded _telemetry_from_state frame including link.latencyMs 9999 and fcLink (FM-08); All later-added features left wired identically: envelope monitor as its own 20 Hz task with suspend-on-manual, attendance/unattended machine, mission-record verification, planner execution and corridor arming, sensor fusion / staged observations, failsafe latches, signed-command verifier and per-vehicle audit path, staging vision gating, gimbal pointing; CLI: --config / --sitl / --log-level, EIS_CONFIG fallback, SIGINT/SIGTERM graceful stop where supported, KeyboardInterrupt fallback
- *Identical-line exceptions:* Import block and the module logger -- necessary and unchanged; Loop-rate constants TELEMETRY_HZ=10.0, TRACKING_HZ=10.0, CONTROL_HZ=20.0; The four asyncio.create_task(...) lines in run() are spelled out verbatim because test_envelope_wiring.py:213-214 asserts on the LITERAL source text of Companion.run ('_envelope_loop(), name="envelope"' and '_control_loop(), name="control"'). A table-driven launch would fail that test; a comment in run() records why.; The real-camera branch of _build_vision_source keeps 'conf_threshold=cfg.detector.conf' and 'except TypeError' inside that one method because test_perception_honesty.py:156-160 asserts on inspect.getsource(Companion._build_vision_source). I initially extracted it to _build_camera_source and reverted.; Component constructor keyword-argument lists (Tracker, Guidance, BatteryPolicy, EnvelopeLimits, GimbalLimits, UnattendedEnvelope.tightened, PlannerExecutor, StagingObserver, StagedSensorSuite, Vehicle, SafetyManager, StreamConfig, ApiServer) -- these are the cross-module call contracts, and three of those modules are being rewritten concurrently by other agents; Field NAMES and initial VALUES in the _init_*_state helpers -- the suite reads and writes them directly; only their grouping and the surrounding rationale changed; _faults dictionary keys (they are the testFault command's value contract) and the ControlSource/VelocitySetpoint/Limits usages; Small unchanged bodies where the contract leaves one correct form: _observed_mode, _set_control_source, request_stop, _maybe_await, main(), the __main__ guard; Section banner comments and short standard-syntax fragments (try:/except Exception:/pass/return) that git blame -w -M -C matches across any rewrite

**`platform/companion/tests/test_api_ack_semantics.py`** — added. 23 tests driving ApiServer._on_message with a fake socket through the real admission pipeline and routing table, no network. Covers the contract's asymmetric ack promise: every command is acked (handler success, handler failure, handler raising, handler returning None, no handler registered, async handler), every ack carries the full CommandAck envelope and correlates by command NAME with no requestId; manualInput reaches its handler but produces NO outbound frame at all (single frame, 50-frame burst, raising handler, absent handler) while still feeding the ground-link deadman; the planner rails use the requestId/status/reason ack shape (accepted, no-handler rejection, raising-handler rejection) and planHeartbeat/fleet stay unacked; a parametrized structural test asserts the ack-less rails are declared ack-less in _ROUTES itself; plus a wrong-vehicleId frame never reaching dispatch and an unknown wire type being liveness-only.

**`platform/companion/tests/test_app_arbitration.py`** — added. 29 tests against the real Companion orchestrator with a recording fake Vehicle, constant-output guidance/manual stubs and a capturing API. Control-source arbitration: the active source is stamped into every telemetry frame and overrides whatever the FC layer reported; _release_all clears all three engagement flags, the takeoff window and the wound-up controllers at once; tracking flies guidance, manual beats tracking even with a locked track, a plan on a tracking tool uses guidance, no engaged source holds, the armed+airborne+GUIDED preconditions gate every source, and the e-stop latch outranks a hands-on operator and clears only on the ground. Manual-input watchdog: fresh sticks fly, stale sticks zero-and-hold and reset the pilot, the watchdog opens CLOSED, a stray frame in auto records liveness but commands nothing, and a non-finite or non-numeric axis drops the frame WHOLE without refreshing the watchdog. Ground-link deadman: the hold is the first thing sent, the operator is released to auto, an airborne deadman escalates to RTL, the latch survives the release and keeps holding on the next tick even though evaluate_link alone now reports healthy (FM-03), the companion's own FC heartbeat stops while latched, an authorized frame clears latch and timestamp together, and plain auto never trips it. Final clamp: every axis bounded to Limits, one non-finite axis collapses the whole setpoint, and the envelope scale can only tighten (a scale > 1.0 cannot amplify).

Tests added:

- platform/companion/tests/test_api_ack_semantics.py -- 23 tests: ack semantics (success / failure / raising handler / None-returning handler / missing handler / async handler), the full CommandAck envelope, name-based FIFO correlation with no requestId, the manualInput never-acked rule (single frame, 50-frame burst producing zero outbound bytes, raising handler, absent handler) while still crediting the deadman, a structural parametrized check that manualInput/planHeartbeat/fleet/rfEvent are declared ack-less in _ROUTES, planCommandAck requestId/status/reason shape (accepted / no-handler / raising), wrong-vehicleId frames never reaching dispatch, and unknown wire types being liveness-only
- platform/companion/tests/test_app_arbitration.py -- 29 tests: control-source arbitration (source stamped into telemetry and overriding the FC layer, _release_all clearing all engagement flags plus takeoff window plus controller state, tracking flies guidance, manual beats tracking, planner tracking-tool uses guidance, nothing engaged holds, GUIDED/armed/airborne preconditions gate every source, e-stop outranks a hands-on operator and clears only on the ground); manual-input watchdog zero-and-hold (fresh vs stale sticks, watchdog opens closed, stray frame in auto commands nothing, non-finite and non-numeric axes drop the frame whole without refreshing the watchdog); ground-link deadman (hold sent first, release to auto, airborne escalation to RTL, the latch surviving the release and still holding when evaluate_link alone reports healthy, FC heartbeat suppression while latched, an authorized frame clearing latch and timestamp together, plain auto never tripping); and the final clamp (all axes bounded, one non-finite axis collapsing the setpoint, envelope scale able only to tighten)

Caveats and deliberate deltas:

- TWO source-text assertions in the existing suite constrain how far app.py could be restructured, and both are recorded in comments in the code. test_envelope_wiring.py:213-214 asserts the literal strings '_envelope_loop(), name="envelope"' and '_control_loop(), name="control"' appear in inspect.getsource(Companion.run), so the four asyncio.create_task lines must stay spelled out inside run() -- I initially extracted them to a _start_loops() helper and had to revert. test_perception_honesty.py:156-160 asserts 'conf_threshold=cfg.detector.conf' and 'except TypeError' appear in inspect.getsource(Companion._build_vision_source), so the real-camera branch had to stay in that one method -- I initially split out _build_camera_source and had to revert. Both are noted here because a future restructure will hit them again.
- ONE deliberate behaviour-preserving wart: _planner_tick's `self.planner is None` path calls _end_plan(..., disarm=False). Factoring the three plan-teardown paths into one _end_plan() would have added a _disarm_envelope() call the baseline did not make on that specific path. I kept the baseline behaviour exactly and carried the difference as a keyword argument rather than silently changing it. If the integrator prefers, disarming there is arguably strictly safer and the flag can be dropped.
- app.py residual baseline attribution is 584 lines (12.3%), higher than server.py's 20.4%-of-a-smaller-file because app.py is 4047 lines of which only ~890 were ever baseline-attributed and those are spread across ~120 short fragments. Every remaining block of 5+ lines was inspected: they are imports, component-constructor keyword lists (cross-module call contracts, three of whose modules are being rewritten concurrently), state-field names/values the suite reads directly, the create_task block pinned by the test above, docstrings describing preserved contract, and standard-syntax fragments. Each category is enumerated in that file's identical_exceptions.
- Concurrency with the control/, mavlink/ and config.py agents: I coded strictly against the existing public names and did not modify those files. The coupling points, if their surfaces drift, are the constructor keyword lists in Companion._build_control_core / _build_health_layer / _build_supervision_layer / _build_vehicle / _build_planner / _build_envelope_monitor / _build_gimbal / _build_unattended_envelope, plus the method names guidance.update/reset/set_standoff/set_max_speed, manual.update/reset/set_input, planner.update/reset/abort, safety.evaluate_link/check_arming/note_ground_heartbeat/update_limits/emergency_stop_plan, and vehicle.send_body_velocity/goto_global/set_mode/arm/disarm/land/takeoff/send_heartbeat/get_state/get_telemetry/update_limits/apply_failsafe_params/set_gimbal_pitch/gimbal_pitch_deg/close. My tests exercise all of these through the real orchestrator, so a drift will surface as a failure rather than silently.
- No node_modules junctions were created or needed -- this area is Python-only. The main checkout's node_modules trees were never touched.
- SITL end-to-end (platform/sim/e2e_test.py, manual_test.py, headless_client.py) was NOT run: ArduPilot SITL cannot run natively on Windows and WSL2 was out of scope here. Those clients talk only the WebSocket contract, which is unchanged, and the 694-test suite covers the seam they exercise; a WSL2 e2e run before merge would still be worth doing.
- The brief predicted a pre-existing failure in test_resolve_default_is_site_json_at_repo_root. Running from cwd=<WT>\platform as instructed, it passed both before and after my changes -- the suite was fully green at baseline (642 passed) and is fully green now (694 passed).

## 6. Site consolidation

This is separate work, done at the user's request in the same session and
carried on the same branch (commit `b7cb21f`).

### What changed

The platform stack reads one site model, in its own schema, described by
`platform/docs/SITE_CONTRACT.md`. That model was a hand-written stub anchored on
Komati, a real power station in South Africa. The ARGUS side of the repository
models a different, fictional site — Meridian Station, anchored at
lat 41.2000 / lon -98.4000 — authored in `contracts/site.py`, `sim/site/site.json`
and `sim/site/site.geojson`. Two anchors on two continents meant that any plan,
fence or detection crossing the boundary between the two stacks was
geographically meaningless.

The Komati stub was replaced by a Meridian Station stub:

- `platform/site/gen_platform_site.py` is a new one-way converter from the ARGUS
  model to the platform schema. It reads `contracts/site.py`,
  `sim/site/site.json` and `sim/site/site.geojson` and writes
  `platform/site/site.stub.json`, so the stub is reproducible rather than
  hand-typed. `--check` verifies the committed file without writing.
- Everything the platform schema needs that the ARGUS model does not carry — the
  NFZ route buffer (25 m), the LiDAR-degraded clear altitude (45 m), the fixed
  CCTV cameras, the no-image zone and the staging points — is declared in the
  generator in ENU metres from the same anchor, so it stays inside one geometry.
- The stub is marked `image_kind: scripted_placeholder`. It is an integration
  stub, not survey data.
- Satellite tiles and their provenance were regenerated against the new anchor
  (`platform/ground/satellite/data/{before,after}.png`, `anomalies.json`,
  `tiles.json`; `platform/data/tiles/komati/` moved to
  `platform/data/tiles/meridian/`).
- Cue fixtures under `platform/ground/cues/fixtures/` were regenerated, and the
  tests that pin them were updated with them.
- Plant references were removed from the documentation.
- `platform/sim/params/eis-sitl.parm` now documents the Meridian home.

### What was kept, and why

- **Verifier fixture geometry is unchanged.** `platform/verifier_fixtures/` holds
  the `V01`–`V25` mission-verifier fixtures, whose expected verdicts are pinned
  to exact edges of `site.fixture.json`. Moving that geometry would have changed
  the verdicts, which is the opposite of what a fixture is for. The file was
  relabelled only: it is now described as a generic synthetic fixture site with
  an arbitrary anchor, modelling no real place, and its README states explicitly
  that it does not track `site/site.stub.json`. **No fixture coordinate and no
  expected verdict changed.**
- `V36.json` is the exception, and it is not part of the `V01`–`V25` set: it
  pins the deterministic planner's own output against `site/site.stub.json`, so
  it was regenerated with the new geometry.
- The wire contract, the safety envelope and every limit are untouched by this
  work. Only coordinates, labels and the fixtures generated from them moved.

### One follow-up in this commit

`platform/sim/run_sitl.sh` still defaulted `EIS_SITL_HOME` to a Manila location
(`14.5995,120.9842,10,0`), which would spawn the aircraft thousands of
kilometres from the site model. The default is now the Meridian home
`41.1992364,-98.3995821,550,0`. The `EIS_SITL_HOME` override is unchanged, and
the help text and the environment table in the script header were updated to
match. `platform/scripts/run-sim-e2e.sh` and `platform/scripts/run-sim-e2e.ps1`
were checked: neither carries a home default, so neither needed a change.

`platform/docs/FAILURE_MODES.md` FM-165 described that default as a live hazard
("a simulator default home on another continent"). That sentence is no longer
true of `run_sitl.sh`, so the row was updated: the risk is now stated as a home
that does not match the selected site, the new default is named as a mitigation,
and the line citation was corrected. The two remaining site models and the
unfilled decision behind them are unchanged, and the row is still open.

## 7. Verification

The figures below are from the integration run over the merged branch, before
this document was written. Every command was run on Windows 10 with PowerShell
5.1; the companion and sim clients ran on the pinned CPython 3.12 virtual
environment in `platform/companion/.venv`. No package was installed and nothing
was downloaded.

| Check | Command | Result |
|---|---|---|
| Companion unit tests | `python -m pytest companion\tests` | 1151 passed, exit 0 |
| Companion lint | `python -m pyflakes companion\src` | clean, exit 0 |
| Companion lint | `python -m ruff check companion\src companion\tests sim` | all checks passed, exit 0 |
| Sim clients | `python -m pytest sim\test_sim_clients.py` | 54 passed, exit 0 |
| Sim clients | `python -m compileall sim` | exit 0 |
| Ground UI | `npm run typecheck` | clean, exit 0 |
| Ground UI | `npm run lint` | 0 errors, 5 warnings, exit 0 |
| Ground UI | `npm test` | 18 test files, 435 tests passed, exit 0 |
| Ground UI | `npm run build` | built, exit 0 |
| Electron shell (Windows) | `npm run typecheck` / `npm run build:electron` | clean, exit 0 |
| Electron shell (Linux) | `npm run typecheck` / `npm run build:electron` | clean, exit 0 |
| Planner | `npm test` | 22 test files, 463 tests passed, exit 0 |
| Cues | `npm test` | 8 test files, 78 tests passed, exit 0 |
| Satellite | `npm test` | 6 test files, 44 tests passed, exit 0 |
| Shell syntax | `bash -n` over `scripts/*.sh` and `sim/run_sitl.sh` | 5 files, exit 0 |
| PowerShell syntax | `Parser::ParseFile` over every tracked `.ps1` | 4 files, 0 parse errors |
| Script harnesses | `scripts/test/scripts-run-sim-e2e.test.sh` | 39 passed, 0 failed |
| Script harnesses | `scripts/test/scripts-powershell.test.ps1` | 15 passed, 0 failed |
| Rails parity | `python -m pytest rails\test_rails.py` | 101 passed, exit 0 |
| Root test suite | `python -m pytest tests` | 105 passed, 31 warnings, exit 0 |

The planner suite includes the contract-parity tests: `contract-parity.test.ts`
(6), `parity.test.ts` (101), `policy-parity.test.ts` (2) and
`verifier-fixtures.test.ts` (101).

The 5 UI lint warnings are `react-hooks/exhaustive-deps` in
`src/argus/ArgusApp.tsx` (3) and `src/argus/panels/SiteMap.tsx` (2). Both files
are outside the twelve rewrite areas and were not touched. The 31 warnings in
the root suite are library `DeprecationWarning`s from `websockets.legacy` and
uvicorn's websockets implementation.

**Companion boot.** The companion was started against `config/sitl.yaml` on a
free control port. It logged `control WS listening`, then `companion running
(sitl=True)`. A WebSocket client connected and sampled 8 s of traffic:
`telemetry` 73 frames, `tracking` 74, `healthEvent` 81, `readiness` 3, `mode` 5,
`capabilities` 1, `envelope` 1 — the 10 Hz telemetry pump and the perception
tick both running. Every `telemetry` frame carried `"controlSource": "auto"`.
The flight-controller link was the one degraded rail: `sitl.yaml` targets
`udp:127.0.0.1:14550` and nothing on that box served it, so `Vehicle.connect()`
timed out after its 30 s heartbeat wait and the orchestrator continued in its
designed degraded mode.

**One fix during integration.** `platform/companion/src/eis_companion/mavlink/vehicle.py`
derived `_HAVE_PYMAVLINK` from `mavutil` **and** `mavlink2` instead of asserting
`True` behind a `# noqa: F401`. `pyflakes` does not honour `# noqa`, so the
side-effect dialect import was flagged. The flagged line was byte-identical in
the baseline, so this was a pre-existing diagnostic rather than rewrite fallout.
Behaviour is unchanged: both names are non-`None` exactly when the imports
succeed.

**Site stub.** `python platform/site/gen_platform_site.py --check` reports
`site.stub.json is up to date`, exit 0 — the committed stub matches what the
generator produces from the ARGUS model.

**Script edits in this commit.** `bash -n platform/sim/run_sitl.sh` and
`bash -n platform/scripts/run-sim-e2e.sh` both exit 0 after the home-default
change.

### Final verification pass

A second, independent pass re-ran everything on the final merged tree (`56ce6cc`)
and added runtime checks. It changed no file.

**Suites.** Every count above reproduced: companion 1151, sim clients 54, ground
UI 435 across 18 files, planner 463 across 22 files, cues 78 across 8, satellite
44 across 6, rails 101, root suite 105. All typecheck, lint and build gates and
all 9 script-syntax checks exit 0. `gen_platform_site.py --check` reports the
stub up to date. The flaky `httpx.ConnectTimeout` in
`tests/test_autonomy_safety.py` did not occur: 105/105 passed. `bash -n` was
re-run on `platform/sim/run_sitl.sh` after the home-default change and still
passes.

**ARGUS end to end, fully offline.** Hub, fake drone and headless renderer were
started on `127.0.0.1:8000` with no API key set; `GET /autonomy` reported
`llm_mode: "mock"`. The flow ran: scenario reset, three overhead captures, a
detection (`det-verify-074305`), dispatch, mission **`m-20260906-0001`** —
started 07:43:12Z, `phase: complete` 07:46:33Z, verdict approved on attempt 1 —
then the drone returned to its exact home coordinates and went `idle`, and an
incident report was produced with 3 evidence frames. The `/ws/live` stream
carried the full agent trace (`fly_to → look_at → capture → set_camera →
capture → fly_to → look_at → set_camera → capture → return_home`, sequence
1–16) alongside 341 sampled `drone_state`, 10 `mission`, 6 `validation` and 4
`detection` events. Three red-team cases were refused correctly: an
outside-geofence change was logged rather than dispatched, a prompt injection
demanding 200 m altitude produced a mission with the normal 30 m ceiling, and a
bad plan was rejected twice by name (`geofence_containment`) before an accepted
third attempt.

**Dashboard, Hub mode.** At `/gcs/` the rewritten dashboard selected
`HubDataProvider` automatically and showed the `HUB LIVE` chip, `drone-1` in the
fleet selector and dock, advancing telemetry, and a working manual
engage/release whose start and end matched `manual_start` and `manual_end` rows
in the Hub audit log. The mission panel rendered the site map and the triage,
validator and incident cards.

**Dashboard, mock mode.** On the Vite dev server the badge read `MOCK` and the
full flight path worked: pre-flight checklist (6 items), arm, hold-to-confirm
takeoff at 4 m, engage tracking (`PERSON TRACKING · LOCKED`, standoff 4.0 m),
disengage, RTL. Settings written through the modal persisted across a page
reload in `localStorage['eis.settings']`. The log browser and PID tuning modals
opened and rendered. **0 console errors.**

**SITL acceptance gate: refused at `arm`, correctly.** The companion connected
to the running Docker SITL over `tcp:127.0.0.1:5760`, applied failsafe
parameters, and had its 4-vertex inclusion fence and 2 exclusion zones accepted.
`sim/e2e_test.py` then failed at the `arm` phase with `command rejected during
escalate: envelope breach persisted`. That container is homed at the old
coordinates (measured on the telemetry stream: lat −26.0900, lon 29.4719), about
14 000 km outside the Meridian inclusion fence, so containment escalated and
refused to arm. The container was left running as instructed rather than
recreated at the Meridian home. A control run with no site file refused earlier
still, with `command rejected during refuse: site model invalid` — fail-closed.
So the flight itself remains unflown (section 8), but the seam around it was
exercised against a real ArduCopter: MAVLink connect, parameter upload, geofence
upload, an ~6 Hz telemetry pump, the perception tick, and exactly one
`controlSource` (`auto`) on every frame.

**Browser tooling.** The Chrome integration was unavailable (the extension
reported not connected and no Chrome process was running), so the browser checks
were driven with the Playwright Chromium already installed for
`scripts/headless_renderer.py`. Every click above is a real DOM click and every
screenshot a real page render at 1600×950, under software rasterisation.

## 8. Remaining limitations, and checks that were not run here

Nothing in this section is claimed to pass.

- **SITL acceptance gate: never got past `arm`.** As section 7 records, the gate
  was run twice against the Docker SITL and refused both times — once on
  containment, once fail-closed with no site model. Both refusals are correct,
  but they mean the flight the gate exists to prove (take off, engage tracking,
  approach the simulated person, hold at standoff without breaching it,
  disengage, RTL and land) **has not been flown on this branch**. Doing so needs
  a SITL instance homed at the Meridian pad; the one on this machine belongs to
  another session and was left running. `scripts/run-sim-e2e.sh` itself was not
  executed either: it wants WSL2, and no Linux distribution was available.
- **Flight-controller link, above `arm`.** The MAVLink session reached connect,
  parameter upload, geofence upload and steady telemetry against a real
  ArduCopter. Nothing beyond that was demonstrated: no GUIDED setpoint was ever
  sent, because the aircraft never armed.
- **Linux packaging.** `npm run package:linux` (AppImage, `.deb`, `.rpm`)
  requires a Linux host and was not run. The Windows NSIS installer
  (`npm run dist`) was not built either. Only `npm run build:electron`
  (TypeScript compile of the shell) was run, for both shells.
- **Electron at runtime.** The shells were type-checked and compiled and their
  IPC channel tables were audited by hand against the preload bridges. No GUI
  session was driven as part of these checks.
- **Browser rendering.** No jsdom is installed, so the unit suites verify React
  components with `react-dom/server` `renderToStaticMarkup` and pure-logic
  tests. The dashboard was driven in a real Chromium during the final pass
  (section 7), but under software rasterisation and on one viewport, so visual
  appearance and GPU-path behaviour are still unverified.
- **Hardware.** Nothing here touches a real aircraft, Pixhawk, Jetson, camera or
  radio. The physical path — assembly, flashing, wiring, commissioning — is
  documented under `platform/docs/` and remains entirely manual and unverified
  by this work.
- **Real vision and streaming binaries.** No CUDA, TensorRT, real YOLO weights,
  `mediamtx` or GStreamer binary was executed. Those paths are covered with
  fakes and a stub `Popen`. Pillow and `rsvg-convert`/`inkscape` are absent on
  this machine, so the icon generators were exercised against stub backends; the
  committed `icon.ico` and `icon.png` are unchanged.
- **LLM live paths.** No API key was set for any provider. The Hub's LLM layer
  reports `llm_mode: "mock"` and runs deterministic rules; the platform planner
  runs in its scripted mode. `scripts/argus_autonomy.py`, the
  `POST /widearea/vision-detect` endpoint and the platform's `--live-llm` path
  all require a key and were not exercised.
- **Two known environment-bound annoyances, unfixed.** `pytest-asyncio` is not
  installed in the companion virtual environment, so the root `pyproject.toml`'s
  `asyncio_mode` option raises a `PytestConfigWarning` when `sim/` tests run
  under that interpreter (54/54 still pass). `platform/Makefile` and
  `platform/justfile` still invoke `python -m eis_companion`, for which there is
  no `__main__.py`; both files are on the do-not-modify list, so this is
  reported rather than fixed. The e2e runner scripts were corrected to
  `-m eis_companion.app`.

### Pre-existing defects found during verification, not addressed by this commit

All three are outside the rewrite. The files involved are byte-identical to
`origin/main`, so none is rewrite fallout, and none was fixed here.

- **`POST /widearea/detect` returns `[]`.** The Console's asset bundle (HDRI,
  textures, `.gltf` models) is not in the repository, so the overhead render has
  no image-based light and comes back near-black. `widearea/detect.py` gates on
  `DIFF_THRESHOLD = 18` and `MIN_CELLS = 4`; the seeded intruder vehicle produces
  only 3 qualifying cells, so nothing is emitted at any `min_area_m2`. The props
  do render in the main view. The fix is either shipping the asset bundle or
  retuning the detector constants, both on the ARGUS side. Workaround used during
  verification: seed the detection through `POST /detections`.
- **Hub-mode site load always falls back.** `siteFromHub()` in
  `platform/ground/ui/src/site/index.ts` builds a site object with only
  `home`, `perimeter`, `nfz`, `alt_band_m` and `staging`, but
  `@planner/site validateSite` also requires `geofence`, `nfz_buffer_m`,
  `clear_altitude_m` and `clutter`. The call therefore always throws and Hub mode
  silently uses the bundled `platform/site/site.stub.json` instead of the Hub's
  live site. The impact is currently small because both describe Meridian
  Station; it would bite as soon as the two diverge.
- **The fake drone never clears `manual_control`.** `sim/fake_drone/fake_drone.py`
  sets `status = manual_control` on every `SetVelocity` and never resets it;
  `Hover`, which `POST /manual/end` sends, only changes `mode`. On a grounded
  drone the landing branch that would restore `idle` is never reached, and the
  Hub has no manual-session watchdog, so a tab closed mid-session leaves the
  session open. A later dispatch then reports `no eligible Drone: drone-1
  manual_control`. Workaround: `POST /drones/drone-1/command
  {"type":"return_home"}` restores `idle`.
