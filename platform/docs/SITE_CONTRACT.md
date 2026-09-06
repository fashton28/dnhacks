# Site contract

Runtime paths in this document are relative to [`platform/`](..), this file's
parent directory.

The topology/site simulation (site terrain, perimeter, structures, SITL world,
home location) is owned by another teammate. Everything else consumes it only
through one JSON file. Nothing outside `site/` may hardcode site geometry.

## File selection and cutover

- `EIS_SITE_FILE` is a repo-root-relative or absolute path. Its production
  default is `site/site.json`.
- Until the teammate-owned Meridian Station model lands, demo scripts and tests
  explicitly select `site/site.stub.json`. That stub is GENERATED from the ARGUS
  Meridian Station sources (`contracts/site.py`, `sim/site/site.json`,
  `sim/site/site.geojson`, `sim/common/site_limits.py`) by
  [`site/gen_platform_site.py`](../site/gen_platform_site.py) — edit the
  generator and re-run it, never the JSON.
- An explicitly selected missing file is an error. The packaged UI may use the
  stub only when the default `site/site.json` is absent.
- Cutting over consists of removing the stub override. Do not copy, generate, or
  edit `site/site.json` in another workstream.

The ground planner, satellite layer, UI map, companion fence loader, staging
sensor adapter, and simulator all consume the same selected file.

## Schema

```json
{
  "home": { "lat": 41.1992364, "lon": -98.3995821, "alt_m": 550.0 },
  "perimeter": [[41.1, -98.4], [41.1, -98.3], [41.2, -98.3]],
  "geofence": [[41.1, -98.4], [41.1, -98.3], [41.2, -98.3]],
  "nfz_buffer_m": 25,
  "nfz": [
    {
      "name": "reactor-exclusion",
      "polygon": [[41.1, -98.4], [41.1, -98.3], [41.2, -98.3]],
      "ceiling_m": 60
    }
  ],
  "alt_band_m": { "min": 5, "max": 60 },
  "clear_altitude_m": 45,
  "clutter": [
    {
      "name": "turbine-hall",
      "polygon": [[41.1, -98.4], [41.1, -98.3], [41.2, -98.3]]
    }
  ],
  "cameras": [
    {
      "id": "cam-east-north",
      "lat": 41.2006288,
      "lon": -98.3964183,
      "heading_deg": 270,
      "fov_deg": 90,
      "range_m": 250,
      "fov_polygon": [[41.1, -98.4], [41.1, -98.3], [41.2, -98.3]],
      "zones": [
        {
          "name": "east-fence-north",
          "polygon": [[41.1, -98.4], [41.1, -98.3], [41.2, -98.3]]
        }
      ]
    }
  ],
  "pads": [
    { "id": "pad-1", "lat": 41.1992364, "lon": -98.3995821 }
  ],
  "no_image_zones": [
    {
      "name": "control-building",
      "polygon": [[41.1, -98.4], [41.1, -98.3], [41.2, -98.3]]
    }
  ],
  "staging": [
    {
      "id": "meridian-south-service-road",
      "lat": 41.198383,
      "lon": -98.4,
      "image": "site/staging/stage-a.png",
      "thermal_image": "site/staging/stage-a-thermal.png",
      "image_kind": "scripted_placeholder",
      "required_sensors": ["rgb", "thermal", "lidar"],
      "truth": "vehicle"
    }
  ]
}
```

Required fields are `home`, `perimeter`, `geofence`, `nfz_buffer_m`, `nfz`,
`alt_band_m`, `clear_altitude_m`, `clutter`, and `staging`. Each staging entry
requires both image paths, `image_kind`, `required_sensors`, and `truth`.

`cameras`, `pads`, and `no_image_zones` are OPTIONAL: a site file without them
is valid and every consumer must treat an absent array as empty. A file that
declares one must declare it completely — the per-entry fields below are all
required.

## Coordinate, polygon, and altitude semantics

- Coordinates are WGS84 decimal degrees ordered `[lat, lon]`.
- All polygons are open rings with at least three vertices. The final edge back
  to the first vertex is implicit. Consumers accept either winding.
- `home.alt_m` is terrain elevation at the launch point in metres AMSL and is
  the SITL home altitude. The Meridian Station stub uses 550 m AMSL.
- `alt_band_m`, `clear_altitude_m`, and `nfz[].ceiling_m` are metres AGL relative
  to home. The permitted band may tighten companion limits but never relax the
  hard safety envelope.
- `perimeter` describes the surveyed site boundary. `geofence` is the operational
  containment polygon independently checked by the ground verifier and uploaded
  to ArduPilot. It must be wholly inside or equal to `perimeter`.
- `nfz_buffer_m` is a horizontal stand-off around every NFZ polygon for route and
  orbit checks. The stub and verifier default is exactly 25 m.
- Flight inside an NFZ polygon at or below its `ceiling_m` is forbidden. Flight
  above the ceiling still has to satisfy the route buffer and altitude band.
- `clear_altitude_m` is the minimum AGL used after loss or degradation of LiDAR
  obstacle avoidance. It must fall inside `alt_band_m`.
- `clutter[].polygon` identifies areas requiring healthy LiDAR before dispatch.
  A LiDAR failure in flight causes a climb to `clear_altitude_m` before the route
  continues. These polygons also seed deterministic synthetic LiDAR geometry.

## Camera semantics (`cameras`)

- A camera entry is fixed ground infrastructure: `id`, `lat`, `lon`,
  `heading_deg`, `fov_deg`, `range_m`, `fov_polygon`, and `zones`.
- `id` is unique across the file and is the value carried by
  `cctvEvent.cameraId` and by `anomaly.cameraId` for a cue this camera raised.
- `heading_deg` is the true bearing of the optical axis, 0 = north, clockwise.
  `fov_deg` is the total horizontal field of view (the axis ± `fov_deg / 2`).
  `range_m` is the useful detection range along the axis.
- `fov_polygon` is the ground footprint of that cone, as `[lat, lon]` vertices
  in the same open-ring form as every other polygon here, first vertex at the
  camera. It is derived from the other four fields and is provided so the map
  and the verifier do not each re-derive it; a consumer that recomputes it must
  match within a metre.
- `zones[].name` is unique WITHIN a camera and is the value carried by
  `cctvEvent.zone`. A zone polygon names a watched area inside the footprint.
- **Camera geometry is not a flight constraint.** A camera may sit on the
  perimeter outside `geofence`, and its footprint and zones may cover ground the
  drone is not permitted to enter. Nothing may derive a route, an orbit or an
  altitude from `cameras`; it exists for cue provenance and for drawing what a
  camera can see.

## Pad semantics (`pads`)

- A pad entry is `{ id, lat, lon }` and must lie inside `geofence` and outside
  every buffered NFZ. `id` is unique across the file.
- `pads[0]` is the home pad and its coordinates equal `home.lat` / `home.lon`.
  Consumers read the launch point from `home`, never from `pads`; the duplicate
  exists so a multi-pad site can be drawn without special-casing home.
- Pads carry no altitude: a pad is at terrain, and `home.alt_m` remains the one
  elevation reference.

## No-image zone semantics (`no_image_zones`)

- Each entry is `{ name, polygon }` with a unique `name`, in the same open-ring
  `[lat, lon]` form as `nfz` and `clutter`.
- A no-image zone is an IMAGING restriction, not a flight restriction: transit
  over it is permitted, and it never widens or narrows `geofence`, `nfz` or the
  altitude band. Capture, retention and display of imagery whose footprint
  intersects a no-image zone is prohibited — a mission that can only answer its
  task by imaging inside one must be refused, not flown and redacted.
- A no-image zone is unrelated to `nfz`: the two may overlap, abut, or be
  disjoint, and neither implies the other.

## Staging semantics

- Staging coordinates are pre-surveyed observation points inside `geofence` and
  outside buffered NFZs.
- `image` and `thermal_image` are repo-root-relative paths to paired RGB and
  thermal frames. `image_kind: scripted_placeholder` makes that provenance
  explicit; such a file is not real optical, thermal, Sentinel-2, or Umbra
  imagery. The stub now names DISTINCT thermal variants
  (`stage-a-thermal.png`, `stage-b-thermal.png`), and the aliasing described by
  earlier revisions of this document is gone — a reader who implemented the
  aliased form got a paired-modality observation that could never disagree
  (`FM-169`).
- Every referenced fixture MUST exist in the checkout and MUST carry PNG or
  JPEG magic bytes. A missing or non-image file surfaces only on arrival, as
  "no observation", in the middle of a flight;
  `companion/tests/test_perception_honesty.py::test_every_site_fixture_referenced_by_the_stub_actually_exists`
  turns that into a build-time failure instead.
- `required_sensors` declares which rails the staging adapter prepares. It is not
  a blanket mission readiness rule: night missions require healthy thermal, and
  clutter transit requires healthy LiDAR. RGB, thermal, and LiDAR observations
  may still be reported independently when a mission remains safe.
- LiDAR staging data is generated deterministically from the site geometry rather
  than named by an image path.
- `truth` is one of `vehicle`, `breach`, `structure`, or `false_alarm`. Scripted
  tests may use it; live inference must not.

## Validation invariants

Consumers refuse the selected site file when required fields are absent, values
are non-finite, coordinates are out of range, a polygon has fewer than three
vertices, staging IDs are duplicated, the geofence escapes the perimeter, an
NFZ buffer is negative, or `clear_altitude_m` is outside the altitude band.
Unknown fields may be preserved for forward compatibility but cannot replace
validation of the fields above.

When present, `cameras`, `pads` and `no_image_zones` are refused when an `id` or
`name` is duplicated, a polygon has fewer than three vertices, `fov_deg` is
outside `(0, 360]`, `range_m` is not positive, `heading_deg` is outside
`[0, 360)`, a pad falls outside `geofence` or inside a buffered NFZ, or
`pads[0]` disagrees with `home`. A camera outside `geofence` is valid.

The Meridian Station stub's 45 m clear altitude intentionally exceeds the
baseline companion's 30 m configured maximum. Until the companion/SITL profile
is safely configured for the site's 60 m band, the effective intersection is
invalid and LiDAR-degraded missions must be refused; consumers must never
silently clamp the clear altitude down to an unsafe value.

## Additions log

Rows landed with the change that introduced them name the phase rather than a
short SHA, because the SHA does not exist until the commit is written.

| Git commit | Fields | Decision |
|---|---|---|
| `178bf0a` | `geofence`, `nfz_buffer_m` | Separate the physical site boundary from the operational ArduPilot fence and apply one 25 m NFZ route buffer. |
| `178bf0a` | `clear_altitude_m`, `clutter` | Make the LiDAR-degraded climb altitude and clutter readiness geometry site-owned. |
| `178bf0a` | `thermal_image`, `image_kind`, `required_sensors` | Support paired staged modalities while identifying generated demo placeholders honestly. |
| `phase-1` | `cameras` | Give the CCTV cue rail a site-owned provenance source: `cctvEvent.cameraId` / `.zone` and `anomaly.cameraId` resolve here, so no consumer hardcodes camera geometry. Footprints are observation-only and never a flight constraint. |
| `phase-1` | `pads` | Name the launch/recovery points so a multi-vehicle fleet view can be drawn without inventing pad geometry. `pads[0]` restates `home`; `home` stays the single launch reference. |
| `phase-1` | `no_image_zones` | Make the imaging restriction site-owned and explicitly distinct from `nfz`: transit is allowed, imaging is not, and a task answerable only by imaging inside one is refused rather than flown. |
