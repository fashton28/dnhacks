# DNHacks session summary

This file records the implemented boundaries and repeatable verification. Git
history is the authority for authorship, timing, and the exact diff; manual
calendar dates are intentionally omitted.

## Current ISR demonstration
The repository now carries the implementation for the full offline path from a
baked site cue through planning, deterministic verification, companion-side
command validation, real ArduCopter SITL, multimodal observation, reporting,
RTL, and simulated charging. Focused component gates are green; the final
single-command live-SITL acceptance remains the release gate.
The stable product label is **DNHacks**. Existing `eis_companion`, `EIS_*`, and
`eis-1` identifiers remain compatibility interfaces on disk and on the wire.
### Phase 0: site and policy foundation

- Komati site geometry, geofence, buffered and ceiling-aware no-fly zones,
  clutter polygons, altitude band, clear altitude, staged RGB and thermal
  observations, and baked satellite tiles.
- Failure catalogue with one explicit response and authority per failure.
- ADRs for receive-only SDR, RF-event correlation, independent GPS-loss source
  switching, sensor fusion, short sorties, and charge readiness.
- Scripted inputs remain the default and require no network.

Relevant history begins at `01faa5d`; `178bf0a` records the Komati and
deterministic-failure documentation update. Inspect the exact lineage with:

```bash
git log --oneline -- site docs verifier_fixtures data/tiles/komati
```
### Phase 1: shared contract and readiness
- The authoritative TypeScript contract and Python/TypeScript mirrors carry
  `vehicleId` and the planner, verification, observation, RF, spectrum,
  readiness, battery, sortie, health, and fleet envelopes.
- Sensor health covers RGB, thermal, and LiDAR. Telemetry exposes GPS health,
  navigation source, battery pack state, and failsafe reason.
- Ground-originated validated RF events can reach the companion's independent
  failsafe path.

The initial planner contract is `99ca61d`; the expanded readiness and sensor
contract is `1713a8b`.

### Phase 2: companion execution and sensing

- Approved plans are independently validated and clamped before GUIDED flight.
- The executor supports site-aware GPS transit, safe orbit entry and standoff,
  hold, RTL, and terminal cleanup.
- Battery readiness, sortie expiry, charge progression, GPS health, EKF source
  selection, wind, hostile-airspace, link, planner-heartbeat, thermal, LiDAR,
  camera, and fence failures have deterministic companion-owned responses.
- RGB, thermal, and LiDAR observations preserve modality evidence and fuse only
  when bearing and range agree.
- SITL-only test hooks are gated by both SITL mode and
  `EIS_ENABLE_TEST_HOOKS=true`.

The first companion planner path is `4ced313`. Use path history for the current
accepted implementation:

```bash
git log --oneline -- companion shared sim
```

### Phase 3: ground trust layer

- The mission verifier executes ordered checks for schema, site validity,
  navigation source, readiness, wind, RF environment, airspace, anomaly
  proximity, altitude, speed, standoff, geofence, NFZ transit, NFZ orbit,
  terminal action, loiter, range, and sortie duration.
- Mission sequences fail closed to the geometrically verifiable and
  sequence-executable `goto_gps`, `orbit_point`, `hold`, and `rtl` subset.
  Moving-track and relative tools remain available only through the typed,
  single-operation `planCommand` path until their complete geometry is known.
- Corrections are conservative and recheck the complete route: altitude and
  speed clamps, safe orbit approach and radius shrink, buffered NFZ routing,
  hold/lap trimming, and terminal RTL.
- Runtime context fails closed when telemetry, pack, sensor, site, or finite
  geometry evidence is missing. Executable speed and battery remaining time
  tighten the planner's budget.
- The scripted planner is deterministic. Live planning uses one schema-bound
  object, a 20-second timeout, at most one verifier-informed retry, and then a
  safe fallback or escalation.
- The report path distinguishes a reviewed high-confidence false alarm from a
  missing or failed observation. Low confidence and absent evidence escalate.
- The SDR sidecar is receive-only, uses 4096-point FFT summaries and a rolling
  60-second baseline, and correlates only GPS-loss edges within the symmetric
  RF window. Satellite change detection uses baked assets and labels synthetic
  SAR fallback provenance explicitly.
- Windows and Linux Electron shells host the same planner, SDR, site asset, and
  renderer interfaces.

The ground trust-layer baseline is `e40513c`. Fixture and path history remains
authoritative for follow-up commits:

```bash
git log --oneline -- ground verifier_fixtures PORT_AUDIT.md
```

### Phase 4: real SITL demonstration

- The local runtime uses the official modern ArduCopter binary mounted from
  `dnhacks-phase4-sitl-runtime`; its heartbeat reports official ArduCopter
  4.7.1. The older cached image entrypoint firmware is not used.
- The runtime is `quad`, uses native Vicon on serial 5, retains EEPROM in the
  named state volume, and omits `--wipe` on normal restarts.
- Required frame, battery monitor, accelerometer calibration, EKF3 source,
  Vicon, GPS, and battery parameters are set and confirmed over MAVLink before
  the companion starts.
- `scripts/demo.ps1` and `scripts/demo.sh` derive home from the selected site,
  wait for the public readiness envelope, launch the live Electron provider,
  provide guarded fault flags, and clean up only their owned resources.
- Default planner, satellite, RF/SDR, and sensor sources are offline. A live LLM
  requires both `--live-llm` and `OPENAI_API_KEY`.

Use path history after the Phase 4 integration commit:

```bash
git log --oneline -- scripts/demo.ps1 scripts/demo.sh README.md SESSION_SUMMARY.md sim
```

## Repeatable verification

The focused gates are:

```powershell
companion\.venv\Scripts\python.exe -m pytest companion\tests
Push-Location ground\planner; npm test; Pop-Location
Push-Location ground\satellite; npm test; Pop-Location
companion\.venv\Scripts\python.exe -m pytest ground\sdr\tests
Push-Location ground\ui; npm run lint; npm run typecheck; npm run build; Pop-Location
Push-Location ground\app\windows; npm run typecheck; Pop-Location
.\scripts\demo.ps1 --preflight
```

The Linux shell source is typechecked against the same pinned TypeScript graph.
Native AppImage/deb/rpm packaging and display-server behavior still require a
Linux host. The real-flight acceptance gate is the ArduCopter SITL gauntlet,
which uses the public WebSocket contract and verifies safe terminal behavior.

## Repository boundaries

- `ground/ui/src/contract/index.ts` is the contract authority; changes must be
  mirrored in `shared/shared.ts` and `shared/shared.py`.
- `ground/app/windows/src` and `ground/app/linux/src` stay in lockstep except
  for the documented Linux power integration.
- Site geometry comes from the selected site JSON. Runtime code does not embed
  a substitute location.
- SDR code has no transmit path.
- Design-handoff reference directories are inputs only and are not modified by
  the implementation phases.

## Earlier: `CLAUDE.md` initialization and Windows-to-Linux GCS port

**Work done, in order:**
1. **`PORT_AUDIT.md`** (PRD §0, mandatory first). Audited Electron main/preload/IPC
   + the renderer seam → **source is already cross-platform-clean** (`app.getPath`,
   `process.platform` guards; no `%APPDATA%`/registry/COM/DirectShow). Coupling was
   confined to packaging + the PowerShell bootstrap.
2. **Moved** `ground/app/*` → `ground/app/windows/`, and fixed the relative paths
   that descended a level (`../ui`→`../../ui`; `.env`/UI-dist depths in `main.ts`).
3. **Created `ground/app/linux/`** — shared `src/` + Linux additions:
   `electron-builder.yml` (AppImage/.deb/.rpm + GTK/libnotify/nss/xss/alsa deps),
   `.desktop` (app-id `com.dnhacks.platform.gcs`), gamepad **udev rule** +
   `post(install|remove).sh`, placeholder `icon.png` + `make-icons.sh`, and a
   **`powerSaveBlocker`** inhibit IPC (PRD §7).
4. **Two safety features in the SHARED renderer** (surfaced in PORT_AUDIT per §1,
   implemented once so both OSes benefit, both Windows-safe via optional chaining):
   - controller-disconnect → position-hold failsafe in `panels/ManualControl.tsx`
     (PRD §5; placed in the gamepad owner rather than `LiveDataProvider` — noted);
   - power-inhibit effect in `App.tsx` + optional `power` on the `ElectronBridge`
     type (`vite-env.d.ts`).
5. **Plumbing & docs:** `setup-ground.ps1` retargeted to `ground/app/windows`; new
   `scripts/setup-ground-linux.sh`; `Makefile`/`justfile` gained
   `setup-ground-linux` / `build-ground-linux` / `package-linux`; updated root
   `README.md`, `CLAUDE.md`, and the moved Windows `README.md`.
