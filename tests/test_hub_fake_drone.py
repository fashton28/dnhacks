"""Sim 03: the Hub and a fake Drone, driven exactly as the Console drives them."""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from contracts.site import distance_m
from tests.conftest import HubHandle, load_fixture


async def test_fake_drone_registers_idle_on_the_site(hub: HubHandle):
    await hub.add_fake_drone("drone-1")
    async with httpx.AsyncClient(base_url=hub.http) as c:
        drones = (await c.get("/drones")).json()
    assert [d["drone_id"] for d in drones] == ["drone-1"]
    d = drones[0]
    assert d["status"] == "idle" and d["alt"] == 0 and d["battery_pct"] == 100
    assert abs(d["lat"] - 41.2) < 0.01 and abs(d["lon"] + 98.4) < 0.01


async def test_square_flight_plan_visits_every_waypoint_and_returns_home(hub: HubHandle):
    await hub.add_fake_drone("drone-1", home=(-60.0, -60.0))
    plan = load_fixture("flight_plan_square.json")
    async with httpx.AsyncClient(base_url=hub.http) as c:
        r = await c.post("/missions/fly", json={"plan": plan, "drone_id": "drone-1"})
        assert r.status_code == 200, r.text
        assert r.json()["phase"] in ("pending", "flying")
        # in flight, the drone reports on_mission
        await asyncio.sleep(0.3)
        assert (await c.get("/drones/drone-1")).json()["status"] == "on_mission"
    m = await hub.wait_mission(plan["mission_id"])
    assert m["phase"] == "complete", m
    assert m["next_waypoint"] == len(plan["waypoints"])
    assert len(m["evidence"]) == len(plan["waypoints"])
    # evidence frames were written with metadata
    for ref in m["evidence"]:
        path = hub.tmp / ref
        assert path.exists() and path.stat().st_size > 500
        meta = json.loads(path.with_suffix(".json").read_text())
        assert meta["drone_id"] == "drone-1" and meta["alt"] > 18
    # and it came home and landed
    async with httpx.AsyncClient(base_url=hub.http) as c:
        for _ in range(200):
            d = (await c.get("/drones/drone-1")).json()
            if d["status"] == "idle":
                break
            await asyncio.sleep(0.05)
    home = hub.drones["drone-1"][0].home
    from contracts.site import enu_to_latlon
    hlat, hlon = enu_to_latlon(*home)
    assert d["status"] == "idle" and d["alt"] < 0.1 and distance_m(d["lat"], d["lon"], hlat, hlon) < 2
    assert d["battery_pct"] < 100
    # audit log has the story
    lines = [json.loads(l) for l in (hub.tmp / "events.jsonl").read_text().splitlines()]
    kinds = [l["kind"] for l in lines]
    assert "mission_started" in kinds and kinds.count("goto") == len(plan["waypoints"]) and "mission_complete" in kinds


async def test_telemetry_streams_live_at_about_10hz(hub: HubHandle, live):
    await hub.add_fake_drone("drone-1")
    states = []
    end = asyncio.get_running_loop().time() + 1.0
    while asyncio.get_running_loop().time() < end:
        ev = json.loads(await asyncio.wait_for(live.recv(), 1.0))
        if ev["type"] == "drone_state":
            states.append(ev["state"])
    assert 6 <= len(states) <= 14, len(states)
    assert all(s["drone_id"] == "drone-1" for s in states)


async def test_direct_goto_command_moves_the_drone(hub: HubHandle):
    d = await hub.add_fake_drone("drone-1", home=(0.0, 0.0))
    from contracts.site import enu_to_latlon
    lat, lon = enu_to_latlon(20.0, 0.0)
    async with httpx.AsyncClient(base_url=hub.http) as c:
        ack = (await c.post("/drones/drone-1/command", json={"type": "goto", "lat": lat, "lon": lon, "alt": 10})).json()
        assert ack["ok"]
        for _ in range(100):
            s = (await c.get("/drones/drone-1")).json()
            if distance_m(s["lat"], s["lon"], lat, lon) < 1 and abs(s["alt"] - 10) < 0.5:
                break
            await asyncio.sleep(0.05)
        assert distance_m(s["lat"], s["lon"], lat, lon) < 1 and abs(s["alt"] - 10) < 0.5
        assert 80 < s["heading_deg"] < 100  # flew east
        ack = (await c.post("/drones/drone-1/command", json={"type": "capture_frame"})).json()
        assert ack["ok"]
        r = await c.post("/drones/drone-1/command", json={"type": "bogus"})
        assert r.status_code == 422


async def test_disconnected_drone_shows_offline_within_two_seconds(hub: HubHandle):
    await hub.add_fake_drone("drone-1")
    await hub.drop_drone("drone-1")
    async with httpx.AsyncClient(base_url=hub.http) as c:
        for _ in range(50):
            s = (await c.get("/drones/drone-1")).json()
            if s["status"] == "offline":
                break
            await asyncio.sleep(0.05)
        assert s["status"] == "offline"
        r = await c.post("/drones/drone-1/command", json={"type": "hover"})
        assert r.status_code == 404


async def test_fly_refuses_when_no_idle_drone(hub: HubHandle):
    plan = load_fixture("flight_plan_square.json")
    async with httpx.AsyncClient(base_url=hub.http) as c:
        r = await c.post("/missions/fly", json={"plan": plan})
        assert r.status_code == 409
        await hub.add_fake_drone("drone-1")
        r = await c.post("/missions/fly", json={"plan": plan})
        assert r.status_code == 200
        r = await c.post("/missions/fly", json={"plan": {**plan, "mission_id": "msn-2"}})
        assert r.status_code == 409  # only drone is busy
    await hub.wait_mission(plan["mission_id"])
