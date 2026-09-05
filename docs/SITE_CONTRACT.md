# Site contract

The topology/site simulation (plant terrain, perimeter, structures, SITL world,
home location) is owned by another teammate. Everything else consumes it only
through one JSON file. Nothing outside `site/` may hardcode plant geometry.

## File selection and cutover

- `EIS_SITE_FILE` is a repo-root-relative or absolute path. Its production
  default is `site/site.json`.
- Until the teammate-owned Komati model lands, demo scripts and tests explicitly
  select `site/site.stub.json`.
- An explicitly selected missing file is an error. The packaged UI may use the
  stub only when the default `site/site.json` is absent.
- Cutting over consists of removing the stub override. Do not copy, generate, or
  edit `site/site.json` in another workstream.

The ground planner, satellite layer, UI map, companion fence loader, staging
sensor adapter, and simulator all consume the same selected file.

## Schema

```json
{
  "home": { "lat": -26.09, "lon": 29.4719, "alt_m": 1600.0 },
  "perimeter": [[-26.0, 29.0], [-26.0, 29.1], [-26.1, 29.1]],
  "geofence": [[-26.0, 29.0], [-26.0, 29.1], [-26.1, 29.1]],
  "nfz_buffer_m": 25,
  "nfz": [
    {
      "name": "chimney",
      "polygon": [[-26.0, 29.0], [-26.0, 29.1], [-26.1, 29.1]],
      "ceiling_m": 80
    }
  ],
  "alt_band_m": { "min": 20, "max": 80 },
  "clear_altitude_m": 45,
  "clutter": [
    {
      "name": "boiler-house",
      "polygon": [[-26.0, 29.0], [-26.0, 29.1], [-26.1, 29.1]]
    }
  ],
  "staging": [
    {
      "id": "komati-west-service-road",
      "lat": -26.09,
      "lon": 29.47,
      "image": "site/staging/stage-a.png",
      "thermal_image": "site/staging/stage-a.png",
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

## Coordinate, polygon, and altitude semantics

- Coordinates are WGS84 decimal degrees ordered `[lat, lon]`.
- All polygons are open rings with at least three vertices. The final edge back
  to the first vertex is implicit. Consumers accept either winding.
- `home.alt_m` is terrain elevation at the launch point in metres AMSL and is
  the SITL home altitude. Komati's stub uses 1600 m AMSL.
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

## Staging semantics

- Staging coordinates are pre-surveyed observation points inside `geofence` and
  outside buffered NFZs.
- `image` and `thermal_image` are repo-root-relative paths to paired RGB and
  thermal frames. A scripted fixture may point both fields to the same generated
  placeholder. `image_kind: scripted_placeholder` makes that provenance explicit;
  such a file is not real optical, thermal, Sentinel-2, or Umbra imagery.
  The interim stub aliases the two existing placeholder files; the sensing phase
  must replace `thermal_image` with distinct scripted thermal variants before the
  paired-modality demo is considered complete.
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

The Komati stub's 45 m clear altitude intentionally exceeds the baseline
companion's 30 m configured maximum. Until the companion/SITL profile is safely
configured for the site's 80 m band, the effective intersection is invalid and
LiDAR-degraded missions must be refused; consumers must never silently clamp the
clear altitude down to an unsafe value.

## Additions log

| Date | Fields | Decision |
|---|---|---|
| 2026-09-06 | `geofence`, `nfz_buffer_m` | Separate the physical site boundary from the operational ArduPilot fence and apply one 25 m NFZ route buffer. |
| 2026-09-06 | `clear_altitude_m`, `clutter` | Make the LiDAR-degraded climb altitude and clutter readiness geometry site-owned. |
| 2026-09-06 | `thermal_image`, `image_kind`, `required_sensors` | Support paired staged modalities while identifying generated demo placeholders honestly. |
