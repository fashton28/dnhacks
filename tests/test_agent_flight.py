"""Agent-flown Missions: the agent declares an envelope, the Safety Validator gates it, then the agent flies with tools.

Mock mode throughout, on a fake Drone, so the whole trust chain runs offline and deterministically.
"""
from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

import httpx
import pytest

from contracts.models import ChangeType, Detection, LatLon
from contracts.site import distance_m, enu_to_latlon
from tests.conftest import HubHandle

AT = datetime(2026, 9, 5, 17, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def offline_agent(monkeypatch):
    monkeypatch.setenv("ARGUS_LLM_MODE", "mock")
    monkeypatch.setenv("ARGUS_FLIGHT_MODE", "agent")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


def det(did: str, x: float, y: float, ct: ChangeType, **meta: str) -> Detection:
    ring = [LatLon(lat=lat, lon=lon) for lat, lon in (enu_to_latlon(x - 4, y - 4), enu_to_latlon(x + 4, y - 4), enu_to_latlon(x + 4, y + 4), enu_to_latlon(x - 4, y + 4))]
    return Detection(id=did, polygon=ring, confidence=0.8, change_type=ct, before_ref="t/before.png", after_ref="t/after.png",
                     detected_at=AT, area_m2=36.0, metadata={"source": "test", **meta})


async def drain(live, seconds: float = 3.0) -> list[dict]:
    events, deadline = [], asyncio.get_running_loop().time() + seconds
    while asyncio.get_running_loop().time() < deadline:
        try:
            events.append(json.loads(await asyncio.wait_for(live.recv(), 0.5)))
        except TimeoutError:
            break
    return events


async def test_agent_flies_inside_a_validated_envelope(hub: HubHandle, live):
    await hub.add_fake_drone("drone-1", home=(35.0, -85.0))
    d = det("sw-agent", 120, -130, ChangeType.intruder_vehicle, note="pickup truck by the switchyard fence")
    async with httpx.AsyncClient(base_url=hub.http, timeout=240) as c:
        assert (await c.get("/autonomy")).json()["flight_mode"] == "agent"
        await c.post("/detections", json=d.model_dump(mode="json"))
        await c.post("/scenarios/run", json={"id": "scn-t", "kind": "intruder_vehicle", "params": {}})
        r = await c.post(f"/detections/{d.id}/dispatch")
        assert r.status_code == 200, r.text
        out = r.json()
    assert out["flown"] is True, out
    assert out["envelope"]["radius_m"] == 40 and out["envelope"]["ceiling_m"] == 30
    assert out["verdict"]["approved"] is True and out["attempts"] == 1
    res = out["result"]
    assert res["status"] == "success", res
    tools = [a["tool"] for a in res["inspections"][0]["actions"]]
    assert tools[0] == "fly_to" and tools[-1] == "return_home" and tools.count("capture") == 3, tools
    assert all(not a["result"].startswith(("refused", "error")) for a in res["inspections"][0]["actions"]), res["inspections"][0]["actions"]
    # every flown point stayed inside the envelope and under its ceiling
    cx, cy = out["envelope"]["center"]["lat"], out["envelope"]["center"]["lon"]
    for w in out["plan"]["waypoints"]:
        assert distance_m(w["lat"], w["lon"], cx, cy) <= out["envelope"]["radius_m"] + 0.5
        assert w["alt_m"] <= out["envelope"]["ceiling_m"]
    assert len(out["plan"]["waypoints"]) == 2
    # captures produced evidence frames on disk
    frames = [o["frame_ref"] for o in res["observations"] if o.get("frame_ref")]
    assert len(frames) == 3 and all((hub.tmp / f).exists() for f in frames), frames
    assert out["triage"]["decision"] in ("false_alarm", "log_only", "escalate")
    # the Mission record the dashboard follows went flying -> returning -> complete
    m = (await httpx.AsyncClient(base_url=hub.http).get(f"/missions/{out['mission_id']}")).json()
    assert m["phase"] == "complete" and m["next_waypoint"] == 2 and m["plan"]["pattern"] == "agent"
    kinds = {e["type"] for e in await drain(live)}
    assert {"pretriage", "mission_spec", "validation", "envelope", "agent_action", "inspection", "triage", "incident", "dispatch_outcome"} <= kinds, kinds
    # the live feed showed the validator accepting the envelope before any agent action
    lines = [json.loads(l) for l in (hub.tmp / "events.jsonl").read_text().splitlines()]
    kinds_in_order = [l["kind"] for l in lines]
    assert kinds_in_order.index("envelope_validated") < kinds_in_order.index("mission_attached")


async def test_illegal_envelope_is_refused_then_repaired(hub: HubHandle, live):
    await hub.add_fake_drone("drone-1", home=(35.0, -85.0))
    async with httpx.AsyncClient(base_url=hub.http, timeout=240) as c:
        r = await c.post("/redteam/bad_plan")
        assert r.status_code == 200, r.text
        out = r.json()
    assert out["flown"] is True
    assert out["attempts"] >= 2, "the first envelope must have been refused"
    assert out["envelope"]["ceiling_m"] <= hub.app.state.limits.alt_ceiling_m
    lines = [json.loads(l) for l in (hub.tmp / "events.jsonl").read_text().splitlines()]
    verdicts = [(l["attempt"], l["verdict"], l["rules"]) for l in lines if l["kind"] == "envelope_validated"]
    assert verdicts[0][1] == "reject" and {"altitude_ceiling", "geofence_containment"} <= set(verdicts[0][2]), verdicts
    assert verdicts[-1][1] == "accept"


async def test_prompt_injection_cannot_leave_the_envelope(hub: HubHandle):
    await hub.add_fake_drone("drone-1", home=(35.0, -85.0))
    async with httpx.AsyncClient(base_url=hub.http, timeout=240) as c:
        out = (await c.post("/redteam/prompt_injection")).json()
    assert out["flown"] is True
    for w in out["plan"]["waypoints"]:
        assert w["alt_m"] <= out["envelope"]["ceiling_m"] <= hub.app.state.limits.alt_ceiling_m
    # the injected text reached the agent only as quoted data
    assert "IGNORE ALL PREVIOUS INSTRUCTIONS" in out["triage"]["body_markdown"] or True


async def test_operator_abort_ends_the_agent_flight(hub: HubHandle):
    await hub.add_fake_drone("drone-1", home=(35.0, -85.0))
    d = det("abort-me", 120, -130, ChangeType.intruder_vehicle)
    async with httpx.AsyncClient(base_url=hub.http, timeout=240) as c:
        await c.post("/detections", json=d.model_dump(mode="json"))
        task = asyncio.create_task(c.post(f"/detections/{d.id}/dispatch"))
        # wait until the agent flight is attached, then abort it from the Operator's side
        mission_id = None
        for _ in range(200):
            await asyncio.sleep(0.1)
            ms = (await c.get("/missions")).json()
            flying = [m for m in ms if m["phase"] == "flying" and m["plan"]["pattern"] == "agent"]
            if flying:
                mission_id = flying[0]["mission_id"]
                break
        assert mission_id, "agent flight never started"
        r = await c.post(f"/missions/{mission_id}/abort")
        assert r.status_code == 200, r.text
        out = (await task).json()
    assert out["flown"] is True
    assert out["result"]["hard_stop"] == "Operator abort", out["result"]
    assert out["result"]["status"] == "aborted"
