"""The one gate between a candidate plan and dispatch."""
from __future__ import annotations

from typing import Any

from contracts.models import flight_plan
from safety import rules


def validate(plan_raw: dict[str, Any], drone: dict[str, Any], policy: dict[str, Any]) -> dict[str, Any]:
    plan = flight_plan(plan_raw)
    violations = []
    for check in (rules.communications,):
        result = check(drone)
        if result:
            violations.append(result)
    for check in (rules.geofence, rules.altitude):
        result = check(plan, policy)
        if result:
            violations.append(result)
    result = rules.battery(plan, drone, policy)
    if result:
        violations.append(result)
    return {"mission_id": plan["mission_id"], "verdict": "reject" if violations else "accept", "violations": violations}
