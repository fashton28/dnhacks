"""Sim 07: Manual Control through the Hub with clamping at the Site limits."""
from __future__ import annotations

import asyncio
import json

import httpx

from contracts.site import distance_m, enu_to_latlon
from tests.conftest import HubHandle, load_fixture


async def _wait(c: httpx.AsyncClient, drone: str, pred, n=200):
    for _ in range(n):
        s = (await c.get(f"/drones/{drone}")).json()
        if pred(s):
            return s
        await asyncio.sleep(0.05)
    raise AssertionError(f"condition not met; last state {s}")


async def test_manual_velocity_toward_fence_is_clamped_with_rule_named(hub: HubHandle):
    # start 10 m inside the east geofence edge (x = 220), airborne via a goto first
    await hub.add_fake_drone("drone-1", home=(210.0, 0.0))
    lat, lon = enu_to_latlon(210.0, 0.0)
    async with httpx.AsyncClient(base_url=hub.http) as c:
        assert (await c.post("/drones/drone-1/command", json={"type": "goto", "lat": lat, "lon": lon, "alt": 15})).json()["ok"]
        await _wait(c, "drone-1", lambda s: s["alt"] > 14)
        r = await c.post("/drones/drone-1/manual/start")
        assert r.status_code == 200 and r.json()["paused_mission"] is None
        # fly east (NED vy) at 3 m/s: 1.5 s lookahead puts it past x=220 within a few commands
        clamps = 0
        for _ in range(40):
            r = (await c.post("/drones/drone-1/manual/command", json={"vy": 3.0})).json()
            if r["clamped"]:
                clamps += 1
                assert "geofence" in r["clamped"]["rule"]
                assert r["sent"]["vy"] <= 0.01
            await asyncio.sleep(0.05)
        assert clamps > 0
        s = (await c.get("/drones/drone-1")).json()
        from contracts.site import latlon_to_enu
        x, _ = latlon_to_enu(s["lat"], s["lon"])
        assert x <= 220.5, f"drone left the geofence: x={x}"
        # climbing past the ceiling is clamped too
        r = (await c.post("/drones/drone-1/manual/command", json={"vz": -5.0})).json()
        s = await _wait(c, "drone-1", lambda s: s["alt"] > 55, n=400)
        r = (await c.post("/drones/drone-1/manual/command", json={"vz": -5.0})).json()
        assert r["clamped"] and "altitude_ceiling" in r["clamped"]["rule"]
        # audit has clamp events
        lines = [json.loads(l) for l in (hub.tmp / "events.jsonl").read_text().splitlines()]
        assert any(l["kind"] == "clamp" for l in lines)


async def test_manual_control_pauses_and_resumes_a_mission(hub: HubHandle):
    await hub.add_fake_drone("drone-1", home=(-60.0, -60.0))
    plan = load_fixture("flight_plan_square.json")
    async with httpx.AsyncClient(base_url=hub.http) as c:
        assert (await c.post("/missions/fly", json={"plan": plan, "drone_id": "drone-1"})).status_code == 200
        await _wait(c, "drone-1", lambda s: s["alt"] > 15)
        m0 = (await c.get(f"/missions/{plan['mission_id']}")).json()
        r = (await c.post("/drones/drone-1/manual/start")).json()
        assert r["paused_mission"] == plan["mission_id"]
        m = (await c.get(f"/missions/{plan['mission_id']}")).json()
        assert m["phase"] == "paused"
        for _ in range(10):
            await c.post("/drones/drone-1/manual/command", json={"vx": 2.0})
            await asyncio.sleep(0.05)
        assert (await c.get("/drones/drone-1")).json()["status"] == "manual_control"
        r = (await c.post("/drones/drone-1/manual/end", json={"action": "resume"})).json()
        assert r["mission_id"] == plan["mission_id"]
        m = await hub.wait_mission(plan["mission_id"])
        assert m["phase"] == "complete" and m["next_waypoint"] == len(plan["waypoints"]) and m0["next_waypoint"] <= m["next_waypoint"]


async def test_manual_abort_returns_home(hub: HubHandle):
    await hub.add_fake_drone("drone-1", home=(-60.0, -60.0))
    plan = load_fixture("flight_plan_square.json")
    async with httpx.AsyncClient(base_url=hub.http) as c:
        await c.post("/missions/fly", json={"plan": plan, "drone_id": "drone-1"})
        await _wait(c, "drone-1", lambda s: s["alt"] > 15)
        await c.post("/drones/drone-1/manual/start")
        r = (await c.post("/drones/drone-1/manual/end", json={"action": "abort"})).json()
        assert r["action"] == "abort"
        m = await hub.wait_mission(plan["mission_id"])
        assert m["phase"] == "aborted"
        s = await _wait(c, "drone-1", lambda s: s["status"] == "idle", n=600)
        hlat, hlon = enu_to_latlon(-60.0, -60.0)
        assert distance_m(s["lat"], s["lon"], hlat, hlon) < 2
        r = await c.post("/drones/drone-1/manual/command", json={"vx": 1.0})
        assert r.status_code == 409
