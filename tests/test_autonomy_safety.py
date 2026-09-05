"""The Hub's Safety Validator gates the autonomy layer's plans, not only the REST endpoint.

The agent's Orchestrator hands approved plans to HubExecutor, which starts a Mission on the
runner directly rather than through /missions/fly. Without this gate an agent plan would
reach a Drone having been checked only against the agent's own Facility model, which is
separate geometry with separate rules (docs/REPOSITORY_REVIEW.md).
"""
from __future__ import annotations

import asyncio

import pytest

from contracts.site import enu_to_latlon


def waypoint(x: float, y: float, alt_m: float = 30.0, action: str = "flyto") -> dict:
    lat, lon = enu_to_latlon(x, y)
    return {"lat": lat, "lon": lon, "alt_m": alt_m, "action": action}


def agent_plan(waypoints: list[dict], mission_id: str) -> dict:
    return {"mission_id": mission_id, "waypoints": waypoints, "flight_time_s": 60.0, "battery_needed_pct": 10.0}


@pytest.mark.asyncio
async def test_executor_refuses_a_plan_crossing_the_no_fly_zone(hub) -> None:
    """Both waypoints are legal on their own; the segment between them crosses the reactor."""
    await hub.add_fake_drone("drone-1", home=(-60.0, -60.0))
    executor = hub.app.state.autonomy.executor
    plan = agent_plan([waypoint(-120.0, 55.0), waypoint(120.0, 55.0)], "agent-nofly")

    with pytest.raises(RuntimeError, match="Safety Validator refused"):
        await asyncio.to_thread(executor.execute_mission, plan)

    # Refused before dispatch: no Mission was ever created.
    assert "agent-nofly" not in hub.app.state.missions.missions


@pytest.mark.asyncio
async def test_executor_refuses_a_plan_above_the_altitude_ceiling(hub) -> None:
    await hub.add_fake_drone("drone-1", home=(-60.0, -60.0))
    executor = hub.app.state.autonomy.executor
    ceiling = hub.app.state.limits.alt_ceiling_m
    plan = agent_plan([waypoint(-60.0, -60.0, ceiling + 20.0)], "agent-high")

    with pytest.raises(RuntimeError, match="altitude_ceiling"):
        await asyncio.to_thread(executor.execute_mission, plan)

    assert "agent-high" not in hub.app.state.missions.missions


@pytest.mark.asyncio
async def test_executor_accepts_a_legal_plan(hub) -> None:
    """The gate admits a compliant plan: a Mission is created and reaches a terminal phase."""
    await hub.add_fake_drone("drone-1", home=(-60.0, -60.0))
    executor = hub.app.state.autonomy.executor
    plan = agent_plan([waypoint(-60.0, -60.0), waypoint(-20.0, -60.0, action="hover")], "agent-ok")

    result = await asyncio.to_thread(executor.execute_mission, plan)
    assert result["mission_id"] == "agent-ok"
    assert "agent-ok" in hub.app.state.missions.missions
