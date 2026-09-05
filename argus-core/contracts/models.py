"""Minimal, dependency-free contract validation.

Keep these objects deliberately small. New optional fields may be added later;
renaming or changing the meaning of required fields needs a version bump.
"""
from __future__ import annotations

from typing import Any

CONTRACT_VERSION = "0.1"


class ContractError(ValueError):
    pass


def _need(obj: dict[str, Any], key: str, kind: type | tuple[type, ...]) -> Any:
    value = obj.get(key)
    if not isinstance(value, kind):
        raise ContractError(f"{key!r} must be a {getattr(kind, '__name__', kind)}")
    return value


def _point(point: Any) -> list[float]:
    if not isinstance(point, (list, tuple)) or len(point) != 2:
        raise ContractError("each coordinate must be [lat, lon]")
    lat, lon = point
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        raise ContractError("coordinate values must be numbers")
    if not -90 <= lat <= 90 or not -180 <= lon <= 180:
        raise ContractError("coordinate is outside latitude/longitude bounds")
    return [float(lat), float(lon)]


def detection(value: dict[str, Any]) -> dict[str, Any]:
    """Validate the only input Person B/the Hub needs to supply."""
    polygon = _need(value, "polygon", list)
    if len(polygon) < 3:
        raise ContractError("Detection.polygon needs at least three points")
    confidence = _need(value, "confidence", (int, float))
    if not 0 <= confidence <= 1:
        raise ContractError("Detection.confidence must be between 0 and 1")
    return {
        "contract_version": value.get("contract_version", CONTRACT_VERSION),
        "id": _need(value, "id", str),
        "polygon": [_point(p) for p in polygon],
        "confidence": float(confidence),
        "change_type": _need(value, "change_type", str),
        "detected_at": _need(value, "detected_at", str),
        "before_ref": value.get("before_ref"),
        "after_ref": value.get("after_ref"),
    }


def mission_spec(value: dict[str, Any]) -> dict[str, Any]:
    polygon = _need(value, "survey_polygon", list)
    objective = _need(value, "objective", str)
    if objective not in {"inspect", "perimeter_sweep", "standoff_observe"}:
        raise ContractError("MissionSpec.objective is not recognised")
    return {
        "contract_version": value.get("contract_version", CONTRACT_VERSION),
        "detection_id": _need(value, "detection_id", str),
        "objective": objective,
        "survey_polygon": [_point(p) for p in polygon],
        "max_altitude_m": float(_need(value, "max_altitude_m", (int, float))),
        "standoff_m": float(_need(value, "standoff_m", (int, float))),
        "rationale": _need(value, "rationale", str),
    }


def flight_plan(value: dict[str, Any]) -> dict[str, Any]:
    waypoints = _need(value, "waypoints", list)
    if not waypoints:
        raise ContractError("FlightPlan.waypoints cannot be empty")
    clean = []
    for wp in waypoints:
        if not isinstance(wp, dict):
            raise ContractError("each waypoint must be an object")
        lat, lon = _point([wp.get("lat"), wp.get("lon")])
        alt = wp.get("alt_m")
        if not isinstance(alt, (int, float)):
            raise ContractError("waypoint alt_m must be numeric")
        clean.append({"lat": lat, "lon": lon, "alt_m": float(alt), "action": wp.get("action", "capture")})
    return {
        "contract_version": value.get("contract_version", CONTRACT_VERSION),
        "mission_id": _need(value, "mission_id", str),
        "drone_id": _need(value, "drone_id", str),
        "waypoints": clean,
        "pattern": _need(value, "pattern", str),
        "est_duration_s": float(_need(value, "est_duration_s", (int, float))),
        "est_battery_pct": float(_need(value, "est_battery_pct", (int, float))),
    }
