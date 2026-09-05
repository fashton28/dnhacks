"""Single, stable entry point for the Hub integration."""
from __future__ import annotations

from typing import Any

from agent.triage import propose_mission_spec
from planner.coverage import make_flight_plan
from safety.validator import validate


def run_pipeline(
    detection: dict[str, Any], drone_state: dict[str, Any], policy: dict[str, Any]
) -> dict[str, Any]:
    """Return JSON-ready planning artefacts; never dispatches a drone."""
    spec = propose_mission_spec(detection, policy)
    plan = make_flight_plan(spec, drone_state, policy)
    verdict = validate(plan, drone_state, policy)
    return {"mission_spec": spec, "flight_plan": plan, "validation": verdict}
