"""Autonomy from plant signals: the plant reports a transformer over temperature and ARGUS decides, counts down and flies.

Supervised mode on a fake Drone, mock agent: a fire Scenario raises the signal, the Hub dispatches with no request from
the test, the flight completes and the triage escalates; a hold inside the veto window stops it; the asset cooldown
refuses a second automatic dispatch.
"""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from tests.conftest import HubHandle


@pytest.fixture(autouse=True)
def offline_agent(monkeypatch):
    monkeypatch.setenv("ARGUS_LLM_MODE", "mock")
    monkeypatch.setenv("ARGUS_FLIGHT_MODE", "agent")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


async def collect(live, until, timeout: float) -> list[dict]:
    """Read live events until `until(event)` is true or the timeout passes."""
    events, deadline = [], asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        try:
            ev = json.loads(await asyncio.wait_for(live.recv(), 0.5))
        except TimeoutError:
            continue
        events.append(ev)
        if until(ev):
            break
    return events


def decisions(events: list[dict], **match) -> list[dict]:
    return [e for e in events if e["type"] == "decision" and all(e.get(k) == v for k, v in match.items())]


async def set_mode(hub: HubHandle, mode: str, **policy) -> dict:
    async with httpx.AsyncClient(base_url=hub.http) as c:
        r = await c.post("/autonomy/mode", json={"mode": mode, **policy})
        assert r.status_code == 200, r.text
        return r.json()


async def run_fire(hub: HubHandle, scenario_id: str) -> None:
    async with httpx.AsyncClient(base_url=hub.http, timeout=30) as c:
        r = await c.post("/scenarios/run", json={"id": scenario_id, "kind": "transformer_fire", "params": {}})
        assert r.status_code == 200, r.text


async def test_supervised_fire_signal_dispatches_itself_and_escalates(hub: HubHandle, live):
    await hub.add_fake_drone("drone-1", home=(35.0, -85.0))
    status = await set_mode(hub, "supervised", veto_window_s=1)
    assert status["policy"]["veto_window_s"] == 1 and status["mode"] == "supervised"
    await run_fire(hub, "scn-fire")

    events = await collect(live, lambda e: e["type"] == "decision" and e.get("status") == "dispatched", timeout=240)
    signals = [e for e in events if e["type"] == "plant_signal"]
    assert signals and signals[0]["sensor_id"] == "TE-T2-W1" and signals[0]["value"] == 142 and signals[0]["severity"] == "alarm"
    dets = [e for e in events if e["type"] == "detection"]
    assert dets and dets[0]["id"] == f"det-{signals[0]['id']}" and dets[0]["change_type"] == "thermal_anomaly"
    assert dets[0]["metadata"]["value"] == "142" and dets[0]["metadata"]["asset"] == "transformer T2"

    pending = decisions(events, action="dispatch", status="pending")
    assert len(pending) == 1 and pending[0]["detection_id"] == dets[0]["id"] and pending[0]["mode"] == "supervised"
    assert pending[0]["id"].startswith("dec-") and pending[0]["deadline_ts"].endswith("+00:00") and pending[0]["rationale"]
    fired = decisions(events, action="dispatch", status="dispatching")
    done = decisions(events, action="dispatch", status="dispatched")
    assert fired and done and done[0]["id"] == pending[0]["id"] and done[0]["flown"] is True and done[0]["triage"] == "escalate", done
    assert [e for e in events if e["type"] == "dispatch_outcome"], "the ordinary dispatch pipeline ran"

    async with httpx.AsyncClient(base_url=hub.http) as c:
        auto = (await c.get("/autonomy")).json()
        assert auto["mode"] == "supervised" and auto["policy"]["max_concurrent_flights"] == 1
        assert [d for d in auto["decisions"] if d["id"] == pending[0]["id"]][0]["status"] == "dispatched"
        assert (await c.get("/plant/signals")).json()[0]["id"] == signals[0]["id"]
        report = (await c.get(f"/incidents/{done[0]['mission_id']}")).json()
        assert report["detection_id"] == dets[0]["id"]


async def test_hold_inside_the_veto_window_prevents_the_dispatch(hub: HubHandle, live):
    await hub.add_fake_drone("drone-1", home=(35.0, -85.0))
    await set_mode(hub, "supervised", veto_window_s=4)
    await run_fire(hub, "scn-fire")
    events = await collect(live, lambda e: e["type"] == "decision" and e.get("status") == "pending", timeout=20)
    pending = decisions(events, status="pending")
    assert len(pending) == 1
    async with httpx.AsyncClient(base_url=hub.http) as c:
        r = await c.post(f"/decisions/{pending[0]['id']}/hold")
        assert r.status_code == 200 and r.json()["status"] == "held", r.text
        events = await collect(live, lambda e: e["type"] == "dispatch_outcome", timeout=6)
        assert decisions(events, id=pending[0]["id"], action="held")
        assert not [e for e in events if e["type"] in ("dispatch_outcome", "pretriage")], "nothing flew"
        assert (await c.get("/missions")).json() == []
        assert (await c.post(f"/decisions/{pending[0]['id']}/hold")).status_code == 409


async def test_release_fires_the_dispatch_at_once(hub: HubHandle, live):
    await hub.add_fake_drone("drone-1", home=(35.0, -85.0))
    await set_mode(hub, "supervised", veto_window_s=60)
    await run_fire(hub, "scn-fire")
    events = await collect(live, lambda e: e["type"] == "decision" and e.get("status") == "pending", timeout=20)
    pending = decisions(events, status="pending")[0]
    async with httpx.AsyncClient(base_url=hub.http) as c:
        assert (await c.post(f"/decisions/{pending['id']}/release")).status_code == 200
    events = await collect(live, lambda e: e["type"] == "decision" and e.get("status") == "dispatched", timeout=240)
    assert decisions(events, id=pending["id"], action="released")
    assert decisions(events, id=pending["id"], status="dispatched")[0]["flown"] is True


async def test_asset_cooldown_refuses_a_second_automatic_dispatch(hub: HubHandle, live):
    await hub.add_fake_drone("drone-1", home=(35.0, -85.0))
    await set_mode(hub, "autonomous", asset_cooldown_s=600)
    await run_fire(hub, "scn-fire-1")
    events = await collect(live, lambda e: e["type"] == "decision" and e.get("status") == "dispatched", timeout=240)
    first = decisions(events, status="dispatched")
    assert len(first) == 1 and first[0]["mode"] == "autonomous" and first[0]["veto_window_s"] == 0
    await run_fire(hub, "scn-fire-2")
    events = await collect(live, lambda e: e["type"] == "decision", timeout=20)
    refused = decisions(events, action="refused")
    assert len(refused) == 1 and refused[0]["asset"] == "transformer T2" and "cooldown" in refused[0]["rationale"], refused
    async with httpx.AsyncClient(base_url=hub.http) as c:
        assert len((await c.get("/missions")).json()) == 1, "the second signal did not fly"


async def test_manual_mode_leaves_the_detection_to_the_operator(hub: HubHandle, live):
    await hub.add_fake_drone("drone-1", home=(35.0, -85.0))
    await run_fire(hub, "scn-fire")
    events = await collect(live, lambda e: e["type"] == "decision", timeout=3)
    assert [e for e in events if e["type"] == "plant_signal"] and [e for e in events if e["type"] == "detection"]
    assert not decisions(events)
    async with httpx.AsyncClient(base_url=hub.http) as c:
        assert (await c.get("/autonomy")).json()["mode"] == "manual"
        assert (await c.get("/missions")).json() == []
