# Site contract

The topology/site simulation (plant terrain, perimeter, structures, SITL world,
home location) is owned by another teammate. Everything else in this repo
consumes it **only** through a single JSON file with the schema below. Nothing
outside `site/` may hardcode plant geometry.

## File selection

- `EIS_SITE_FILE` — path to the site JSON, relative to the repo root.
  **Default: `site/site.json`** (the teammate's real deliverable).
- Until the real file lands, demo scripts and tests set
  `EIS_SITE_FILE=site/site.stub.json`. When `site/site.json` appears, the only
  change needed is deleting that env var.

Both the ground station (`ground/planner`, `ground/satellite`, UI map) and the
companion (fence load, staging-image lookup) read the same file via this var.

## Schema

```json
{
  "home":      { "lat": 0.0, "lon": 0.0, "alt_m": 0.0 },
  "perimeter": [[lat, lon], ...],
  "nfz":       [{ "name": "", "polygon": [[lat, lon], ...], "ceiling_m": 0 }],
  "alt_band_m": { "min": 0, "max": 0 },
  "staging":   [{ "id": "", "lat": 0.0, "lon": 0.0, "image": "path", "truth": "vehicle|breach|structure|false_alarm" }]
}
```

## Semantics

These clarifications bind both sides; if the site owner needs different
semantics, change them **here** first.

- **Coordinates** are WGS84, always ordered `[lat, lon]` (never lon-first).
- **Polygons** (`perimeter`, `nfz[].polygon`) are open rings — the closing edge
  from last vertex back to first is implicit. Vertex order (CW/CCW) does not
  matter; consumers must handle either winding.
- `home.alt_m` is the terrain elevation of the home point in meters AMSL.
  It is also the SITL home altitude.
- `alt_band_m` is the permitted flight band in meters **AGL relative to home**.
  `min ≥` the hard safety floor; the band may only tighten, never relax,
  the limits asserted in `companion/src/eis_companion/config.py`.
- `nfz[].ceiling_m`: flight **inside the polygon at or below `ceiling_m` AGL is
  forbidden**; overflight above the ceiling is permitted. A ceiling at or above
  `alt_band_m.max` therefore makes the zone a full no-go for this system.
- `perimeter` is the outer geofence: the vehicle must never leave it. It is
  loaded into ArduPilot's native polygon fence on companion connect and checked
  independently by the ground MissionVerifier.
- `staging[]` are pre-surveyed observation points. `image` is a repo-root-
  relative path to the still the companion's vision runs on when the vehicle
  arrives within standoff of `(lat, lon)`. `truth` is the ground-truth label
  used by scripted/demo paths and test assertions, not by live inference.

## Additions log

Anything a consumer needs from the site model that is not in the schema above
gets added to the schema, to `site/site.stub.json`, and to a row here — never
hardcoded elsewhere.

| Date | Field | Added by | Why |
|------|-------|----------|-----|
| —    | —     | —        | (none yet) |
