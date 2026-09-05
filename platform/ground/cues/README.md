# eis-cues — cue rails behind one adapter

Seven sensing rails, one `CueAdapter`, one output channel. Every rail emits the
contract's existing `anomaly` message (plus `healthEvent`, and `cctvEvent` for
CCTV audit provenance) and **no rail adds a wire message, a command, or a plan**.
Turning a cue into a task, and a task into a flight, happens downstream in the
deterministic planner behind the verifier.

Binding detail: [`docs/CUE_RAILS_SPEC.md`](../../docs/CUE_RAILS_SPEC.md) and ADR
D25 in [`docs/ADR-hackathon.md`](../../docs/ADR-hackathon.md). Failure
behaviour: the "Cue ingest" rows in
[`docs/FAILURE_MODES.md`](../../docs/FAILURE_MODES.md).

```
sentinel2 ─┐
sar       ─┤  wrap ground/satellite (not moved)
sdr       ─┤  consumes ground/sdr sidecar NDJSON (not moved)
rf_drone  ─┼─► CueAdapter ─► CueBus ─► contract `anomaly` ─► existing UI channel
cctv      ─┤     start/stop · onAnomaly · health · whitelist
fence_… ──┤
drone_sur…┘
```

## The rails

| Rail | Source | Default TTL | Notes |
|---|---|---|---|
| `cctv` | VMS event (primary) or one calibrated RTSP stream (fallback) | 180 s | Zone centroid from `site.cameras[].zones`; confidence by class; normalcy whitelist; **per-camera** rate limit |
| `fence_sensor` | fixture only | 300 s | No PIDS is integrated; without a fixture the rail reports `failed` |
| `rf_drone` | Guardian-shaped passive records | 120 s | Blue-force whitelist from **authenticated own-vehicle telemetry only** |
| `sdr` | `ground/sdr/sidecar.py` NDJSON | 300 s | Unlocated interference is health, never a cue |
| `sentinel2` | `ground/satellite` optical change detection | 24 h | Wrapped through `sentinel2Source()` |
| `sar` | `ground/satellite` SAR log-ratio | 12 h | Wrapped through `sarSource()` |
| `drone_survey` | stub | 1 h | No survey source is wired; without a fixture the rail reports `failed` |

## Pipeline

One observation, in this order:

```
decode → validate → TTL expiry → blind-zone → whitelist → per-source rate limit
       → emit anomaly → [CueBus] expiry → duplicate → shared cue budget → out
```

The order is load-bearing. Expiry first, because a stale cue is not a cue. The
whitelist before the rate limit, so a suppressed cue never consumes a slot. The
rail's own limit before the shared budget, so one noisy camera cannot starve the
other rails.

`CUE_BUDGET_CEILING` (12 cues/hour, all rails) follows the same rule as the
companion's safety floors: **configuration may tighten it and may never loosen
it**. `resolveCueBudget()` clamps rather than throws, so a bad config degrades
toward safety.

## Health

`RailHealthState` is `stopped | starting | healthy | degraded | failed`. There is
deliberately no `unknown`: a rail that is not working must not look like a rail
that is working, and a failed rail reports `failed` — never `healthy`, never
silence.

- **VMS down** → the `cctv` rail is `failed`, a health event names it, every
  other rail keeps producing, and no cue is synthesised for the failed rail.
- **Camera offline** → that camera's zones appear in `health().blindZones`, cues
  from them are refused, and coverage elsewhere is unchanged.
- **Miscalibrated camera** → the pixel cue is refused with a calibration warning
  naming the camera; the invalid projection never reaches triage.

**Contract gap:** the contract's `HealthComponent` has no cue-rail value, and
rails may not widen a published union. Each rail therefore maps onto the closest
existing component (`RAIL_HEALTH_COMPONENT`: cctv → `camera`, sdr/rf_drone →
`sdr`, the rest → `site_model`) and always names itself in `detail` as
`cue rail <id>: …`. The rail-precise state stays on `health()`.

## CCTV: event mode first

A VMS event is `{ cameraId, zone, ts, class?, thumbnail?, id?, confidence? }`.
An ONVIF bridge maps its notifications onto exactly that shape
(`mapOnvifNotification`); authentication and vendor transport stay outside the
generic parser. A class label ranks a cue for triage and **never establishes
identity, intent or authorisation**.

Pixel mode is the fallback, one stream, enabled with `EIS_CCTV_MODE=pixel`:

- bearing = `heading_deg + (column/width − 0.5) × fov_deg`
- range = `refRangeM × refBoxHeightPx / boxHeightPx`, clamped to `range_m`
- the projection is clamped into `fov_polygon` — a cue may not claim ground the
  camera cannot see
- a cue that still lands outside `geofence` is **refused** with a calibration
  warning

`scripts/cctv-loop.sh` / `.ps1` serve a looping **synthetic** clip over RTSP
(ffmpeg's own `-rtsp_flags listen`, no separate RTSP server). The clip is
generated from lavfi sources: nothing was filmed and no site was observed. Both
scripts preflight ffmpeg and exit 127 with a clear message when it is absent —
**ffmpeg is not installed on the machine this package was written on, so the
RTSP path has not been run end to end here.** Event mode is unaffected either
way.

## Normalcy and whitelists

`fixtures/normalcy.json` supplies staffed hours, active gates and delivery
windows. Suppression is a **noise** control, never authorisation: every
suppression is delivered on `onSuppression` so the audit can see it, because
widening a window is exactly the insider attack in `docs/THREAT_MODEL.md` A3.

Blue-force RF whitelisting requires `registerOwnVehicle({ …, authenticated:
true })` — an unauthenticated fingerprint throws, a stale one whitelists
nothing, and a model assertion can never create one.

**Contract gap:** `docs/SITE_CONTRACT.md` defines neither a normalcy block nor
per-camera pixel calibration, so `fixtures/normalcy.json` and
`fixtures/cctv_calibration.json` are cues-owned. Both move onto site fields
unchanged if the site contract grows them.

## Fixtures

`fixtures/<rail>_events.json`, one per rail, replayed by scheduling each event
at its `atMs`. Payloads are **rail-native** — a VMS event, a sidecar NDJSON
record, a Guardian-shaped RF record — so a fixture stays an honest sample and the
real decoder is exercised rather than bypassed. `timebase: "relative"` (the
default) rebases payload `ts`/`observedAt` onto the clock at `start()`, so a
replay next month does not produce cues that expired last year.

Every fixture carries a `provenance` string that says what it is not.

## Usage

```ts
import { createCueBus } from 'eis-cues/node';

const bus = createCueBus({ useSatellite: true });   // EIS_SITE_FILE selects the site
bus.onAnomaly((m) => dataSource.emitAnomaly(m));    // the existing anomaly channel
bus.onHealth((m) => dataSource.emitHealth(m));
await bus.start();
```

Deterministic tests drive a `ManualScheduler` instead of wall-clock timers:

```ts
const scheduler = new ManualScheduler(Date.UTC(2024, 0, 10, 22, 0, 0));
const rail = new CctvRail({ scheduler, site, fixture: loadFixture('cctv') });
await rail.start();
scheduler.advance(10_000);
```

## Commands

```powershell
npm --prefix ground/cues test        # typecheck + vitest
npm --prefix ground/cues run build   # dist/ (browser core + node entry)
```

The satellite bridge resolves `ground/satellite` at runtime —
`EIS_SATELLITE_ENTRY`, then `../satellite/dist/node/index.js`, then
`../satellite/src/node/index.ts` — so the satellite package stays optional and a
missing build degrades the two satellite rails instead of breaking the bus.
