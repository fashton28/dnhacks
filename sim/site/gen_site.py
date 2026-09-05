"""Generate the Meridian Station Site: a scene layout for the Three.js Renderer and the matching GeoJSON.

Both files come from the same numbers, so the fences the Renderer draws, the pads the Drones start on,
the fence ArduPilot enforces, and the polygons the Safety Validator checks can never drift apart.

Run:  uv run python sim/site/gen_site.py [--fleet N]
Writes: sim/site/site.json, sim/site/site.geojson, console/public/site.json (copy for the Renderer)
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shutil
from pathlib import Path

from contracts.site import ORIGIN_LAT, ORIGIN_LON, SITE_NAME, enu_to_latlon

ROOT = Path(__file__).resolve().parent.parent.parent
OUT = ROOT / "sim" / "site"
CONSOLE_PUBLIC = ROOT / "console" / "public"

# ---- Site geometry (ENU metres from the anchor: x east, y north, z up) --------------------------
GROUND = 600.0
OUTER = 140.0          # outer fence half-width
INNER = 110.0          # inner fence half-width
GEOFENCE = 220.0       # hard flight boundary half-width (Safety Validator and ArduPilot fence), 80 m beyond the outer fence
SECTION = 10.0         # fence section length
FENCE_H = 2.5
GATE_X = 0.0           # gate on the south side, one section removed from each fence
REACTOR = (0.0, 55.0)  # containment centre; the no-fly zone is centred here
NO_FLY_R = 45.0
TURBINE_HALL = (0.0, 5.0)
TOWERS = [(-65.0, 60.0), (-65.0, 20.0)]
CONTROL_BLDG = (55.0, -45.0)
SHED = (-60.0, -60.0)
SWITCHYARD = (45.0, 95.0, 15.0, 75.0)  # x0, x1, y0, y1
PADS = [(35.0, -85.0), (47.0, -85.0), (59.0, -85.0), (71.0, -85.0), (83.0, -85.0), (95.0, -85.0)]
OVERHEAD_HALF = 170.0
OVERHEAD_PX = 1024
ALT_CEILING_M = 60.0
ALT_FLOOR_M = 5.0
HOME_ALT_MSL = 550.0   # ArduPilot home altitude (metres above sea level) for the SITL home


def fence_sections(half: float, prefix: str) -> list[dict]:
    """Every section of a square fence with a gate gap on the south side. yaw 0 runs along x."""
    out = []
    n = int(round(2 * half / SECTION))
    for i in range(n):
        c = -half + SECTION / 2 + i * SECTION
        for side, cx, cy, yaw in (("s", c, -half, 0.0), ("n", c, half, 0.0), ("w", -half, c, math.pi / 2), ("e", half, c, math.pi / 2)):
            if side == "s" and abs(c - GATE_X) < SECTION / 2:
                continue
            out.append({"id": f"{prefix}_{side}_{i:02d}", "x": cx, "y": cy, "yaw": yaw, "length": SECTION, "height": FENCE_H})
    return out


def scene(fleet: int) -> dict:
    x0, x1, y0, y1 = SWITCHYARD
    stacks = [{"x": gx, "y": gy, "size": [1.2, 1.2, 3.5]} for gx in range(int(x0), int(x1) + 1, 10) for gy in range(int(y0), int(y1) + 1, 10)]
    return {
        "name": SITE_NAME,
        "anchor": {"lat": ORIGIN_LAT, "lon": ORIGIN_LON, "alt_msl": HOME_ALT_MSL},
        "frame": "ENU metres from anchor; x east, y north, z up",
        "ground": {"size": GROUND},
        "buildings": [
            {"id": "reactor_containment", "kind": "cylinder", "x": REACTOR[0], "y": REACTOR[1], "radius": 17, "height": 30, "dome": 9},
            {"id": "turbine_hall", "kind": "box", "x": TURBINE_HALL[0], "y": TURBINE_HALL[1], "size": [48, 24, 16], "material": "factory"},
            {"id": "cooling_tower_1", "kind": "cylinder", "x": TOWERS[0][0], "y": TOWERS[0][1], "radius": 10, "height": 46, "dome": 0},
            {"id": "cooling_tower_2", "kind": "cylinder", "x": TOWERS[1][0], "y": TOWERS[1][1], "radius": 10, "height": 46, "dome": 0},
            {"id": "control_building", "kind": "box", "x": CONTROL_BLDG[0], "y": CONTROL_BLDG[1], "size": [28, 18, 6.4], "material": "concrete"},
            {"id": "maintenance_shed", "kind": "box", "x": SHED[0], "y": SHED[1], "size": [8, 20, 5], "material": "metal"},
            {"id": "transformer_1", "kind": "box", "x": x0 + 10, "y": y1 + 12, "size": [6, 4, 4], "material": "steel"},
            {"id": "transformer_2", "kind": "box", "x": x0 + 30, "y": y1 + 12, "size": [6, 4, 4], "material": "steel"},
        ],
        "switchyard": {"stacks": stacks},
        "fences": {
            "outer": {"half": OUTER, "sections": fence_sections(OUTER, "fence_outer")},
            "inner": {"half": INNER, "sections": fence_sections(INNER, "fence_inner")},
            "gate": {"x": GATE_X, "outer_y": -OUTER, "inner_y": -INNER, "width": SECTION},
        },
        "road": {"x": GATE_X, "y0": -300.0, "y1": -60.0, "width": 7},
        "pads": [{"id": f"pad_{i}", "x": px, "y": py, "size": 5, "drone_id": f"drone-{i}" if i <= fleet else None} for i, (px, py) in enumerate(PADS, 1)],
        "fleet": [{"drone_id": f"drone-{i}", "x": px, "y": py, **dict(zip(("lat", "lon"), enu_to_latlon(px, py)))} for i, (px, py) in enumerate(PADS[:fleet], 1)],
        "trees": {"bands": [[-260, 160, 260, 220], [-260, -220, -160, 160], [160, -220, 260, 160]], "density": 0.008, "seed": 7},
        "overhead": {"half": OVERHEAD_HALF, "px": OVERHEAD_PX},
        "limits": {"geofence_half": GEOFENCE, "alt_ceiling_m": ALT_CEILING_M, "alt_floor_m": ALT_FLOOR_M, "no_fly": {"x": REACTOR[0], "y": REACTOR[1], "r": NO_FLY_R}},
    }


def geojson(fleet: int) -> dict:
    def lonlat(x, y):
        lat, lon = enu_to_latlon(x, y)
        return [round(lon, 7), round(lat, 7)]

    def ring(pts):
        return [lonlat(*p) for p in pts] + [lonlat(*pts[0])]

    def square(h):
        return [(-h, -h), (h, -h), (h, h), (-h, h)]

    def circle(cx, cy, r, n=32):
        return [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]

    def feat(kind, geom_type, coords, **props):
        return {"type": "Feature", "properties": {"kind": kind, **props}, "geometry": {"type": geom_type, "coordinates": coords}}

    features = [
        feat("site_footprint", "Polygon", [ring(square(GROUND / 2))], name=SITE_NAME),
        feat("geofence", "Polygon", [ring(square(GEOFENCE))], alt_ceiling_m=ALT_CEILING_M, alt_floor_m=ALT_FLOOR_M),
        feat("fence_outer", "Polygon", [ring(square(OUTER))]),
        feat("fence_inner", "Polygon", [ring(square(INNER))]),
        feat("protected_area", "Polygon", [ring(square(INNER))]),
        feat("no_fly_zone", "Polygon", [ring(circle(*REACTOR, NO_FLY_R))], name="reactor_exclusion"),
        feat("gate", "Point", lonlat(GATE_X, -OUTER), name="south_gate"),
        feat("overhead_footprint", "Polygon", [ring(square(OVERHEAD_HALF))], width_px=OVERHEAD_PX, height_px=OVERHEAD_PX),
    ]
    for i, (px, py) in enumerate(PADS, 1):
        features.append(feat("helipad", "Point", lonlat(px, py), name=f"pad_{i}", drone_id=f"drone-{i}" if i <= fleet else None))
    for prefix, half in (("fence_outer", OUTER), ("fence_inner", INNER)):
        for s in fence_sections(half, prefix):
            dx, dy = (SECTION / 2, 0) if s["yaw"] == 0 else (0, SECTION / 2)
            features.append(feat("fence_section", "LineString", [lonlat(s["x"] - dx, s["y"] - dy), lonlat(s["x"] + dx, s["y"] + dy)], name=s["id"]))
    return {"type": "FeatureCollection", "name": SITE_NAME, "anchor": {"lat": ORIGIN_LAT, "lon": ORIGIN_LON, "alt_msl": HOME_ALT_MSL}, "features": features}


def facility(fleet: int) -> dict:
    """The Site in the mock-drone-agent Facility format: what its verifier checks plans against."""
    def ll(x, y):
        lat, lon = enu_to_latlon(x, y)
        return [round(lat, 7), round(lon, 7)]
    pad = PADS[0]
    return {
        "facility_id": "meridian-station",
        "name": f"{SITE_NAME} (simulated)",
        "base": dict(zip(("lat", "lon"), ll(*pad))),
        "geofence": [ll(-GEOFENCE, -GEOFENCE), ll(GEOFENCE, -GEOFENCE), ll(GEOFENCE, GEOFENCE), ll(-GEOFENCE, GEOFENCE)],
        "no_fly_zones": [
            {"id": "reactor_exclusion", "description": "Reactor containment exclusion zone, no overflight", "center": dict(zip(("lat", "lon"), ll(*REACTOR))), "radius_m": NO_FLY_R},
        ],
        "limits": {
            "min_alt_m": ALT_FLOOR_M,
            "max_alt_m": ALT_CEILING_M - 10.0,   # planner ceiling sits 10 m under the onboard fence so a transit overshoot never breaches it
            "max_waypoints": 12,
            "max_hover_s": 60,
            "max_mission_range_m": 1500,
            "max_leg_m": 400,
            "min_battery_reserve_pct": 20,
            "cruise_speed_mps": 5.0,
            "battery_drain_pct_per_min": 4.0,
            "anomaly_proximity_m": 60,
        },
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fleet", type=int, default=int(os.environ.get("FLEET", "3")))
    fleet = max(1, min(len(PADS), ap.parse_args().fleet))
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "site.json").write_text(json.dumps(scene(fleet), indent=1) + "\n")
    (OUT / "site.geojson").write_text(json.dumps(geojson(fleet), indent=1) + "\n")
    (OUT / "facility_meridian.json").write_text(json.dumps(facility(fleet), indent=1) + "\n")
    if CONSOLE_PUBLIC.exists():
        shutil.copy(OUT / "site.json", CONSOLE_PUBLIC / "site.json")
        shutil.copy(OUT / "site.geojson", CONSOLE_PUBLIC / "site.geojson")
    print(f"wrote site.json and site.geojson for a fleet of {fleet}")


if __name__ == "__main__":
    main()
