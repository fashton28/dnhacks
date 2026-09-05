"""Shared types + validation for anything crossing a team boundary.

Plans move between layers as plain dicts (that is the contract in
`contracts/mission_plan.schema.json`), because the dashboard and the simulation
are not necessarily Python. `validate_mission_plan` is the gate that stops a
malformed plan — from the LLM or from anywhere else — reaching the drone.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

WAYPOINT_ACTIONS = ("flyto", "hover")
PRIORITIES = ("low", "medium", "high")
TRIAGE_DECISIONS = ("false_alarm", "log_only", "escalate")


class ContractError(ValueError):
    """A payload did not match the interface contract."""


def utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _require(cond: bool, msg: str) -> None:
    if not cond:
        raise ContractError(msg)


def _number(obj: dict[str, Any], key: str, where: str) -> float:
    val = obj.get(key)
    _require(
        isinstance(val, (int, float)) and not isinstance(val, bool),
        f"{where}: '{key}' must be a number, got {val!r}",
    )
    return float(val)


def validate_waypoint(wp: Any, index: int) -> dict[str, Any]:
    where = f"waypoint[{index}]"
    _require(isinstance(wp, dict), f"{where}: must be an object, got {type(wp).__name__}")

    lat = _number(wp, "lat", where)
    lon = _number(wp, "lon", where)
    alt_m = _number(wp, "alt_m", where)
    _require(-90 <= lat <= 90, f"{where}: lat {lat} is not a valid latitude")
    _require(-180 <= lon <= 180, f"{where}: lon {lon} is not a valid longitude")

    action = wp.get("action")
    _require(
        action in WAYPOINT_ACTIONS,
        f"{where}: 'action' must be one of {WAYPOINT_ACTIONS}, got {action!r}",
    )

    duration_s = _number(wp, "duration_s", where) if "duration_s" in wp else 0.0
    _require(duration_s >= 0, f"{where}: 'duration_s' must be >= 0")
    if action == "flyto":
        duration_s = 0.0

    purpose = wp.get("purpose", "")
    _require(isinstance(purpose, str), f"{where}: 'purpose' must be a string")

    return {
        "lat": lat,
        "lon": lon,
        "alt_m": alt_m,
        "action": action,
        "duration_s": duration_s,
        "purpose": purpose.strip(),
    }


def validate_mission_plan(plan: Any) -> dict[str, Any]:
    """Normalise and validate a mission plan. Raises ContractError on anything wrong.

    Returns a fresh dict with exactly the contract's fields — extra keys are
    dropped rather than silently forwarded to the drone.
    """
    _require(isinstance(plan, dict), f"plan must be an object, got {type(plan).__name__}")

    waypoints = plan.get("waypoints")
    _require(isinstance(waypoints, list), "plan: 'waypoints' must be an array")
    _require(len(waypoints) >= 1, "plan: 'waypoints' must contain at least one waypoint")

    priority = plan.get("priority", "medium")
    _require(
        priority in PRIORITIES, f"plan: 'priority' must be one of {PRIORITIES}, got {priority!r}"
    )

    reasoning = plan.get("reasoning", "")
    _require(isinstance(reasoning, str), "plan: 'reasoning' must be a string")

    return {
        "mission_id": str(plan.get("mission_id", "")),
        "anomaly_id": str(plan.get("anomaly_id", "")),
        "created_at": str(plan.get("created_at") or utc_now_iso()),
        "planner": str(plan.get("planner", "unknown")),
        "priority": priority,
        "reasoning": reasoning.strip(),
        "waypoints": [validate_waypoint(wp, i) for i, wp in enumerate(waypoints)],
    }


def make_anomaly(
    anomaly_id: str,
    lat: float,
    lon: float,
    description: str,
    confidence: float = 0.7,
    source: str = "sentinel2-change-detection",
    ground_truth: str | None = None,
) -> dict[str, Any]:
    """Build an anomaly event.

    `ground_truth` is what is *actually* there. It exists only so the simulation
    can generate consistent sensor readings — it is stripped before anything
    reaches the LLM (see `anomaly.for_llm`).
    """
    return {
        "anomaly_id": anomaly_id,
        "lat": lat,
        "lon": lon,
        "detected_at": utc_now_iso(),
        "source": source,
        "confidence": confidence,
        "description": description,
        "ground_truth": ground_truth,
    }
