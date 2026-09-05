"""MissionSpec -> simple FlightPlan for the simulator.

This is intentionally a compact, predictable bbox inspection pattern. Replace
it with a Shapely/pyproj coverage planner later without changing its input or
output contract.
"""
from __future__ import annotations

import math
from typing import Any

from contracts.models import flight_plan, mission_spec


def _distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat_scale = 111_111.0
    lon_scale = lat_scale * math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot((a[0] - b[0]) * lat_scale, (a[1] - b[1]) * lon_scale)


def make_flight_plan(spec_raw: dict[str, Any], drone: dict[str, Any], policy: dict[str, Any]) -> dict[str, Any]:
    spec = mission_spec(spec_raw)
    points = spec["survey_polygon"]
    lats, lons = [p[0] for p in points], [p[1] for p in points]
    # Four corners make a visible, explainable inspection loop in Webots.
    corners = [(min(lats), min(lons)), (min(lats), max(lons)), (max(lats), max(lons)), (max(lats), min(lons))]
    altitude = min(spec["max_altitude_m"], policy["limits"]["max_altitude_m"])
    route = [(float(drone["lat"]), float(drone["lon"]))] + corners + [(float(drone["lat"]), float(drone["lon"]))]
    distance = sum(_distance_m(route[i], route[i + 1]) for i in range(len(route) - 1))
    speed = policy["limits"]["cruise_speed_mps"]
    duration = distance / speed + len(corners) * policy["limits"]["capture_dwell_s"]
    battery = duration / 60 * policy["limits"]["battery_drain_pct_per_min"]
    return flight_plan({
        "mission_id": f"mission-{spec['detection_id']}",
        "drone_id": drone["drone_id"],
        "waypoints": [{"lat": lat, "lon": lon, "alt_m": altitude, "action": "capture"} for lat, lon in corners],
        "pattern": "bbox_inspection_loop",
        "est_duration_s": round(duration, 1),
        "est_battery_pct": round(battery, 1),
    })
