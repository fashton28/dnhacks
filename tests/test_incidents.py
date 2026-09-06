"""Incident Reports: the agent's assessment becomes a contract IncidentReport that survives a reload."""
from __future__ import annotations

import pytest

from contracts.models import IncidentVerdict
from hub.incidents import IncidentStore, from_agent_outcome


def outcome(decision: str, *, flown: bool = True, observations=None, evidence=None) -> dict:
    o = {
        "anomaly_id": "det-1",
        "mission_id": "msn-1",
        "flown": flown,
        "attempts": 1,
        "drone_id": "drone-1",
        "plan": {},
        "verdict": {},
        "triage": {
            "decision": decision,
            "confidence": 0.86,
            "severity": "high",
            "event_type": "security",
            "title": "Vehicle against the east perimeter fence",
            "body_markdown": "A light vehicle is parked against the fence line.",
            "recommended_action": "Dispatch a patrol to the east fence.",
        },
    }
    if flown:
        o["result"] = {
            "mission_id": "msn-1",
            "status": "success",
            "observations": observations if observations is not None else [],
            "telemetry": {"drone_id": "drone-1", "evidence": evidence or []},
        }
    else:
        o["result"] = None
    return o


@pytest.mark.parametrize(
    "decision,expected",
    [
        ("false_alarm", IncidentVerdict.false_alarm),
        ("log_only", IncidentVerdict.log),      # the one name that differs between the two vocabularies
        ("log", IncidentVerdict.log),
        ("escalate", IncidentVerdict.escalate),
    ],
)
def test_agent_decisions_map_onto_the_contract_verdict(decision: str, expected: IncidentVerdict) -> None:
    assert from_agent_outcome(outcome(decision)).verdict is expected


def test_an_unknown_decision_falls_back_to_log_rather_than_escalating() -> None:
    """An unrecognised decision must not silently become an escalation."""
    assert from_agent_outcome(outcome("something_new")).verdict is IncidentVerdict.log


def test_narrative_carries_title_severity_desk_and_action() -> None:
    r = from_agent_outcome(outcome("escalate"))
    for fragment in ("Vehicle against the east perimeter fence", "high", "security", "Dispatch a patrol"):
        assert fragment in r.narrative


def test_observations_and_evidence_are_attached() -> None:
    obs = [
        {"waypoint_index": 0, "frame_ref": "evidence/msn-1/wp0.jpg", "caption": "empty apron", "detections": []},
        {"waypoint_index": 2, "frame_ref": "evidence/msn-1/wp2.jpg", "caption": "vehicle at fence",
         "detections": [{"label": "vehicle", "confidence": 0.9}]},
    ]
    r = from_agent_outcome(outcome("escalate", observations=obs, evidence=["evidence/msn-1/wp0.jpg"]))

    assert [o.waypoint_index for o in r.observations] == [0, 2]
    # `salient` marks the frame carrying a detection, i.e. the one the verdict rests on.
    assert [o.salient for o in r.observations] == [False, True]
    # A frame named by an Observation is evidence even if the Mission did not list it.
    assert set(r.evidence_refs) == {"evidence/msn-1/wp0.jpg", "evidence/msn-1/wp2.jpg"}


def test_a_mission_that_never_flew_still_produces_an_honest_report() -> None:
    """When no plan could be verified there is no evidence, and the report must say so."""
    r = from_agent_outcome(outcome("escalate", flown=False))
    assert r.observations == []
    assert r.evidence_refs == []
    assert r.mission_id == "msn-1"


def test_store_replaces_by_mission_id_and_keeps_insertion_order() -> None:
    store = IncidentStore()
    store.add(from_agent_outcome(outcome("log_only")))
    store.add(from_agent_outcome(outcome("escalate")))  # same mission_id: replaces
    assert len(store) == 1
    assert store.get("msn-1").verdict is IncidentVerdict.escalate
    assert store.all()[0].mission_id == "msn-1"


@pytest.mark.asyncio
async def test_incidents_endpoints(hub) -> None:
    import httpx

    report = from_agent_outcome(outcome("escalate"))
    hub.app.state.incidents.add(report)

    async with httpx.AsyncClient(base_url=hub.http) as c:
        listed = (await c.get("/incidents")).json()
        assert [r["mission_id"] for r in listed] == ["msn-1"]
        assert listed[0]["verdict"] == "escalate"

        one = await c.get("/incidents/msn-1")
        assert one.status_code == 200 and one.json()["verdict"] == "escalate"

        assert (await c.get("/incidents/nope")).status_code == 404
