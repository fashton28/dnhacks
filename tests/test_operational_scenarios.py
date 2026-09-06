"""Operational anomalies: a transformer fire escalates, a relief-vent steam release is logged.

Same shape of Detection (a rising column seen from above), opposite outcome, decided on station with the thermal camera.
Mock mode on a fake Drone, agent-flown.
"""
from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest

from contracts.models import ChangeType, Detection, LatLon
from contracts.site import enu_to_latlon
from tests.conftest import HubHandle

AT = datetime(2026, 9, 5, 17, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def offline_agent(monkeypatch):
    monkeypatch.setenv("ARGUS_LLM_MODE", "mock")
    monkeypatch.setenv("ARGUS_FLIGHT_MODE", "agent")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


def plume_detection(did: str, x: float, y: float, note: str) -> Detection:
    ring = [LatLon(lat=lat, lon=lon) for lat, lon in (enu_to_latlon(x - 6, y - 5), enu_to_latlon(x + 9, y - 5), enu_to_latlon(x + 9, y + 7), enu_to_latlon(x - 6, y + 7))]
    return Detection(id=did, polygon=ring, confidence=0.84, change_type=ChangeType.smoke_plume, before_ref="t/before.png", after_ref="t/after.png",
                     detected_at=AT, area_m2=180.0, metadata={"source": "test", "note": note})


async def dispatch(hub: HubHandle, scenario: str, det: Detection) -> dict:
    async with httpx.AsyncClient(base_url=hub.http, timeout=240) as c:
        r = await c.post("/scenarios/run", json={"id": f"scn-{scenario}", "kind": scenario, "params": {}})
        assert r.status_code == 200, r.text
        kinds = [p["kind"] for p in (await c.get("/scene")).json()["props"]] if (await c.get("/scene")).status_code == 200 else None
        await c.post("/detections", json=det.model_dump(mode="json"))
        r = await c.post(f"/detections/{det.id}/dispatch")
        assert r.status_code == 200, r.text
        out = r.json()
    out["_scene_kinds"] = kinds
    return out


async def test_transformer_fire_is_confirmed_by_thermal_and_escalated(hub: HubHandle):
    await hub.add_fake_drone("drone-1", home=(35.0, -85.0))
    out = await dispatch(hub, "transformer_fire", plume_detection("det-fire", 75, 82, "dark column rising from the switchyard"))
    assert out["pretriage"]["action"] == "dispatch"
    assert out["flown"] is True and out["result"]["status"] == "success", out.get("result")
    labels = {d["label"] for o in out["result"]["observations"] for d in o["detections"]}
    assert {"fire", "smoke"} <= labels, labels
    thermal = [o for o in out["result"]["observations"] if o.get("camera_mode") == "thermal"]
    assert thermal and max(o["thermal_max_c"] for o in thermal) > 500
    assert out["triage"]["decision"] == "escalate" and out["triage"]["severity"] == "high", out["triage"]
    assert out["result"]["threat_assessment"] in ("suspicious", "hostile", "benign")  # the mock sweep's own reading; triage is what decides


async def test_steam_release_reads_cool_and_is_logged(hub: HubHandle):
    await hub.add_fake_drone("drone-1", home=(35.0, -85.0))
    out = await dispatch(hub, "steam_release", plume_detection("det-steam", 60, -40, "white column rising from the auxiliary building roof"))
    assert out["pretriage"]["action"] == "dispatch"  # nothing was declared, so the Drone goes and looks
    assert out["flown"] is True and out["result"]["status"] == "success", out.get("result")
    labels = {d["label"] for o in out["result"]["observations"] for d in o["detections"]}
    assert "steam_plume" in labels and "fire" not in labels, labels
    thermal = [o for o in out["result"]["observations"] if o.get("camera_mode") == "thermal"]
    assert thermal and max(o["thermal_max_c"] for o in thermal) < 75
    assert out["triage"]["decision"] == "log_only", out["triage"]


async def test_scenarios_place_their_props(hub: HubHandle):
    async with httpx.AsyncClient(base_url=hub.http, timeout=30) as c:
        await c.post("/scenarios/run", json={"id": "s6", "kind": "transformer_fire", "params": {}})
        await c.post("/scenarios/run", json={"id": "s7", "kind": "steam_release", "params": {}})
        snap = (await c.get("/scenarios")).json() if (await c.get("/scenarios")).status_code == 200 else None
    st = hub.app.state.registry.scene
    kinds = {p.kind: p for p in st.props}
    assert "fire" in kinds and "steam" in kinds
    assert kinds["steam"].z > 5, "the vent sits on the auxiliary building roof"
    assert snap is None or isinstance(snap, (list, dict))
