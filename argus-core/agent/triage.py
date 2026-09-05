"""Detection -> MissionSpec.

This fallback is intentionally deterministic so integration works without an
API key. A future Claude adapter must return the exact same MissionSpec shape.
"""
from __future__ import annotations

from typing import Any

from contracts.models import detection, mission_spec


def propose_mission_spec(raw_detection: dict[str, Any], policy: dict[str, Any]) -> dict[str, Any]:
    event = detection(raw_detection)
    limits = policy["limits"]
    # Intent only: preserve the detected area. The geometry module, not this
    # function and not an LLM, decides where individual aircraft turns occur.
    return mission_spec({
        "detection_id": event["id"],
        "objective": "standoff_observe" if event["confidence"] < 0.5 else "inspect",
        "survey_polygon": event["polygon"],
        "max_altitude_m": limits["default_inspection_altitude_m"],
        "standoff_m": limits["default_standoff_m"],
        "rationale": f"Inspect simulated {event['change_type']} detection (confidence {event['confidence']:.0%}).",
    })
