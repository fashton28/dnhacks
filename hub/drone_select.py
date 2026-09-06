"""Which Drone flies a Mission, and why: one place for the rule, published so the Console can explain it.

Eligible: connected, idle, battery above the reserve plus a margin. Among the eligible, the most battery wins.
Every candidate is reported with its reason, so the Operator sees why the others were passed over.
"""
from __future__ import annotations

from typing import Any

from contracts.site import distance_m
from hub.safety import BATTERY_RESERVE_PCT

MARGIN_PCT = 5.0


def select_drone(app, mission_id: str, detection_id: str | None, target: tuple[float, float] | None) -> tuple[str | None, list[dict[str, Any]]]:
    reg = app.state.registry
    candidates: list[dict[str, Any]] = []
    for s in sorted(reg.states(), key=lambda s: s.drone_id):
        conn = reg.drones.get(s.drone_id)
        dist = round(distance_m(s.lat, s.lon, target[0], target[1])) if target else None
        if conn is None or conn.ws is None or s.status.value == "offline":
            eligible, reason = False, "offline"
        elif s.status.value != "idle":
            eligible, reason = False, s.status.value.replace("_", " ")
        elif s.battery_pct < BATTERY_RESERVE_PCT + MARGIN_PCT:
            eligible, reason = False, f"battery {s.battery_pct:.0f}% is at the reserve"
        else:
            eligible, reason = True, f"idle, {s.battery_pct:.0f}% battery"
        candidates.append({"drone_id": s.drone_id, "status": s.status.value, "battery_pct": round(s.battery_pct, 1), "distance_m": dist, "eligible": eligible, "reason": reason})
    eligible = [c for c in candidates if c["eligible"]]
    chosen = max(eligible, key=lambda c: c["battery_pct"]) if eligible else None
    reason = f"idle with the most battery ({chosen['battery_pct']:.0f}%)" if chosen else "no eligible Drone: " + "; ".join(f"{c['drone_id']} {c['reason']}" for c in candidates)
    event = {"type": "drone_selected", "mission_id": mission_id, "detection_id": detection_id, "drone_id": chosen["drone_id"] if chosen else None, "reason": reason, "candidates": candidates}
    reg.publish(event)
    app.state.audit.append("drone_selected", mission_id=mission_id, detection_id=detection_id, drone_id=event["drone_id"], reason=reason,
                           candidates=[(c["drone_id"], c["eligible"], c["reason"]) for c in candidates])
    return (chosen["drone_id"] if chosen else None), candidates
