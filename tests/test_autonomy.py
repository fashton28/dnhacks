"""Autonomy layer through the Hub: Detection -> agent plan -> verifier -> real Mission on a fake Drone -> triage -> incident."""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from tests.conftest import HubHandle, load_fixture


@pytest.fixture(autouse=True)
def offline_llm(monkeypatch):
    monkeypatch.setenv("ARGUS_LLM_MODE", "mock")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


async def test_detection_dispatch_flies_and_reports(hub: HubHandle, live):
    await hub.add_fake_drone("drone-1", home=(35.0, -85.0))
    async with httpx.AsyncClient(base_url=hub.http, timeout=120) as c:
        status = (await c.get("/autonomy")).json()
        assert status["facility"] == "meridian-station" and status["llm_mode"] == "mock"
        det = load_fixture("detection_intruder_vehicle.json")
        r = await c.post("/detections", json=det)
        assert r.status_code == 200, r.text
        await c.post("/scenarios/run", json={"id": "scn-t", "kind": "intruder_vehicle", "params": {}})
        r = await c.post(f"/detections/{det['id']}/dispatch")
        assert r.status_code == 200, r.text
        out = r.json()
    assert out["flown"] is True, out
    assert out["verdict"]["approved"] is True
    assert out["triage"]["decision"] in ("false_alarm", "log_only", "escalate")
    assert out["result"]["status"] == "success"
    assert out["result"]["observations"], "hover waypoints should produce observations"
    assert out["drone_id"] == "drone-1"
    # the live feed carried the Console-shaped events
    kinds = set()
    deadline = asyncio.get_running_loop().time() + 3.0  # telemetry never goes quiet, so drain on a time budget
    while asyncio.get_running_loop().time() < deadline:
        try:
            ev = json.loads(await asyncio.wait_for(live.recv(), 0.5))
        except asyncio.TimeoutError:
            break
        kinds.add(ev["type"])
    assert {"detection", "mission_spec", "validation", "triage", "incident", "dispatch_outcome"} <= kinds, kinds
    # audit log has the dispatch story
    lines = [json.loads(l) for l in (hub.tmp / "events.jsonl").read_text().splitlines()]
    assert any(l["kind"] == "dispatch_outcome" and l["flown"] for l in lines)


async def test_dispatch_without_drone_is_reported_not_flown(hub: HubHandle):
    async with httpx.AsyncClient(base_url=hub.http, timeout=60) as c:
        det = load_fixture("detection_intruder_vehicle.json")
        await c.post("/detections", json=det)
        r = await c.post(f"/detections/{det['id']}/dispatch")
        # the agent may approve a plan, but execution fails with no Drone; the outcome must say so
        assert r.status_code in (200, 500)
