"""The demo must fly distinct drones concurrently and keep their evidence separate."""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from contracts.models import FlightPlan, Waypoint
from contracts.site import enu_to_latlon
from hub.drone_select import select_drone
from hub.missions import Mission, MissionPhase
from scripts.demo_response import build_preset, run_preset


@pytest.fixture(autouse=True)
def offline_agent(monkeypatch):
    monkeypatch.setenv("ARGUS_LLM_MODE", "mock")
    monkeypatch.setenv("ARGUS_FLIGHT_MODE", "agent")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


async def test_demo_flies_two_drones_concurrently_and_keeps_one_in_reserve(hub):
    for index in range(3):
        await hub.add_fake_drone(f"drone-{index + 1}", home=(35 + 8 * index, -85))
    preset = build_preset()
    async with httpx.AsyncClient(base_url=hub.http, timeout=240) as client:
        result = await run_preset(client, preset)
        assert result["multi_drone_success"], result
        assert result["overlapping_missions"]
        fire, steam = result["outcomes"]
        assert fire["drone_id"] != steam["drone_id"]
        assert fire["mission_id"] != steam["mission_id"]
        assert fire["triage"]["decision"] == "escalate"
        assert fire["triage"]["severity"] == "critical"
        assert steam["triage"]["decision"] == "log_only"
        for outcome, incident in zip(result["outcomes"], preset["incidents"]):
            assert outcome["verdict"]["approved"]
            assert outcome["result"]["hard_stop"] is None
            observations = outcome["result"]["observations"]
            assert {o["camera_mode"] for o in observations} >= {"rgb", "thermal"}
            assert all(outcome["mission_id"] in o["frame_ref"] for o in observations)
            assert all((hub.tmp / o["frame_ref"]).is_file() for o in observations)
            report = (await client.get(f"/incidents/{outcome['mission_id']}")).json()
            assert report["detection_id"] == incident["detection"]["id"]
            assert report["drone_id"] == outcome["drone_id"]

        # Completion of the inspection sends RTL; wait separately for landing.
        for _ in range(150):
            states = (await client.get("/drones")).json()
            if all(s["status"] == "idle" and s["alt"] < 1 for s in states):
                break
            await asyncio.sleep(0.1)
        else:
            pytest.fail(f"fleet did not land: {states}")

    audit = [json.loads(line) for line in (hub.tmp / "events.jsonl").read_text().splitlines()]
    attached = [i for i, e in enumerate(audit) if e["kind"] == "mission_attached"]
    finished = [i for i, e in enumerate(audit) if e["kind"] == "agent_flight_finished"]
    assert len(attached) == len(finished) == 2
    assert max(attached) < min(finished), "both missions must be active before either finishes"
    assert {e["drone_id"] for e in audit if e["kind"] == "mission_attached"} == {"drone-1", "drone-2"}
    assert not any(e.get("drone_id") == "drone-3" and e["kind"] == "mission_attached" for e in audit)
    events = [json.loads(line) for line in (hub.tmp / "runs/agent_events.jsonl").read_text().splitlines()]
    sequences = [e["seq"] for e in events]
    assert sequences == sorted(set(sequences)), "concurrent flights must preserve unique ordered events"


async def test_preset_refuses_insufficient_fleet_without_changing_scene(hub):
    await hub.add_fake_drone("drone-1", home=(35, -85))
    async with httpx.AsyncClient(base_url=hub.http) as client:
        with pytest.raises(RuntimeError, match="two idle drones"):
            await run_preset(client, build_preset())
    assert not hub.app.state.registry.scene.scenario_ids
    assert not hub.app.state.missions.missions


async def test_selection_respects_reservations_before_telemetry_changes(hub):
    for i in range(2):
        await hub.add_fake_drone(f"drone-{i + 1}", home=(35 + 8 * i, -85))
    lat, lon = enu_to_latlon(75, 82)
    plan = FlightPlan(mission_id="reserved", drone_id="drone-1",
                      waypoints=[Waypoint(lat=lat, lon=lon, alt=30)],
                      pattern="agent", est_duration_s=120, est_battery_pct=10)
    mission = Mission(mission_id=plan.mission_id, drone_id="drone-1", plan=plan, phase=MissionPhase.flying)
    hub.app.state.missions.attach(mission)
    assert hub.app.state.registry.drones["drone-1"].state.status.value == "idle"
    chosen, candidates = select_drone(hub.app, "next", "alert", (lat, lon))
    assert chosen == "drone-2"
    assert candidates[0]["reason"] == "assigned to an active mission"
    hub.app.state.manual.begin("drone-2", None)
    chosen, candidates = select_drone(hub.app, "no-free-drone", "alert", (lat, lon))
    assert chosen is None
    assert candidates[1]["reason"] == "operator manual control"
    hub.app.state.manual.end("drone-2")
    mission.phase = MissionPhase.complete
    assert select_drone(hub.app, "released", "alert", (lat, lon))[0] == "drone-1"


@pytest.mark.parametrize("hard_stop", [None, "battery at the reserve"])
async def test_serial_or_hard_stopped_flights_do_not_pass_the_concurrent_demo(hard_stop):
    preset = build_preset()
    published = []
    dispatched = []
    missions = [
        {"mission_id": "first", "drone_id": "drone-1", "phase": "complete",
         "started_at": "2026-09-06T10:00:00Z", "finished_at": "2026-09-06T10:01:00Z"},
        {"mission_id": "second", "drone_id": "drone-2", "phase": "complete",
         "started_at": "2026-09-06T10:00:30Z" if hard_stop else "2026-09-06T10:01:00Z",
         "finished_at": "2026-09-06T10:02:00Z"},
    ]

    def respond(request):
        path = request.url.path
        if path == "/autonomy":
            body = {"flight_mode": "agent", "llm_mode": "mock"}
        elif path == "/drones":
            body = [{"drone_id": f"drone-{i + 1}", "status": "idle", "battery_pct": 100} for i in range(3)]
        elif path == "/missions":
            body = missions if dispatched else []
        elif path == "/scene":
            body = {"props": [], "open_fences": [], "scenario_ids": []}
        elif path.endswith("/dispatch"):
            assert len(published) == 4, "both scenarios and alerts must precede dispatch"
            mission = missions[len(dispatched)]
            dispatched.append(path)
            body = {"mission_id": mission["mission_id"], "drone_id": mission["drone_id"],
                    "flown": True, "result": {"status": "success", "hard_stop": hard_stop}}
        else:
            assert path in {"/scenarios/run", "/detections"}
            published.append(path)
            body = {}
        return httpx.Response(200, json=body)

    async with httpx.AsyncClient(base_url="http://demo.test", transport=httpx.MockTransport(respond)) as client:
        result = await run_preset(client, preset)
    assert len(result["outcomes"]) == 2
    assert not result["overlapping_missions"]
    assert not result["multi_drone_success"]
