"""Small, auditable policy rules. All return a violation or None."""
from __future__ import annotations

from typing import Any


def _inside(point: tuple[float, float], polygon: list[list[float]]) -> bool:
    x, y = point[1], point[0]
    inside = False
    for i, current in enumerate(polygon):
        previous = polygon[i - 1]
        x1, y1, x2, y2 = previous[1], previous[0], current[1], current[0]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def geofence(plan: dict[str, Any], policy: dict[str, Any]) -> dict[str, str] | None:
    for index, wp in enumerate(plan["waypoints"]):
        if not _inside((wp["lat"], wp["lon"]), policy["geofence"]):
            return {"rule": "GEOFENCE", "detail": f"waypoint {index} is outside the authorised boundary", "severity": "critical"}
    return None


def altitude(plan: dict[str, Any], policy: dict[str, Any]) -> dict[str, str] | None:
    limits = policy["limits"]
    for index, wp in enumerate(plan["waypoints"]):
        if not limits["min_altitude_m"] <= wp["alt_m"] <= limits["max_altitude_m"]:
            return {"rule": "ALTITUDE", "detail": f"waypoint {index} violates altitude limits", "severity": "critical"}
    return None


def battery(plan: dict[str, Any], drone: dict[str, Any], policy: dict[str, Any]) -> dict[str, str] | None:
    usable = float(drone["battery_pct"]) - policy["limits"]["battery_reserve_pct"]
    if plan["est_battery_pct"] > usable:
        return {"rule": "BATTERY_RESERVE", "detail": "mission would consume protected battery reserve", "severity": "critical"}
    return None


def communications(drone: dict[str, Any]) -> dict[str, str] | None:
    # A radio failure is a controller/autopilot failsafe event; this dispatch
    # rule simply refuses to begin a new mission from an unhealthy link.
    if drone.get("link_state", "healthy") != "healthy":
        return {"rule": "LINK_HEALTH", "detail": "drone link is not healthy; dispatch denied", "severity": "high"}
    return None
