"""Every committed fixture validates against its contract, and the protocol round-trips."""
import json
from pathlib import Path

import pytest

from contracts import models as m
from contracts import protocol as p

FIXTURES = Path(__file__).resolve().parent.parent / "contracts" / "fixtures"

MODEL_BY_PREFIX = {
    "detection_": m.Detection,
    "mission_spec_": m.MissionSpec,
    "flight_plan_": m.FlightPlan,
    "validation_result_": m.ValidationResult,
    "incident_report_": m.IncidentReport,
    "drone_state_": m.DroneState,
    "manual_command": m.ManualCommand,
    "clamp_event_": m.ClampEvent,
    "scenario_": m.Scenario,
    "scene_state_": m.SceneState,
}


def _model_for(name: str):
    for prefix, model in MODEL_BY_PREFIX.items():
        if name.startswith(prefix):
            return model
    raise AssertionError(f"no model mapping for fixture {name}")


domain_fixtures = sorted(f for f in FIXTURES.glob("*.json") if not f.name.startswith("proto_"))
proto_fixtures = sorted(FIXTURES.glob("proto_*.json"))


@pytest.mark.parametrize("path", domain_fixtures, ids=lambda f: f.name)
def test_domain_fixture_validates(path: Path):
    model = _model_for(path.name)
    obj = model.model_validate_json(path.read_text())
    assert model.model_validate(obj.model_dump(mode="json")) == obj


@pytest.mark.parametrize("path", proto_fixtures, ids=lambda f: f.name)
def test_protocol_fixture_round_trips(path: Path):
    raw = json.loads(path.read_text())
    if raw["type"] in {"hello", "telemetry", "frame", "ack", "overhead"}:
        adapter = p.controller_message
    else:
        adapter = p.hub_message
    obj = adapter.validate_python(raw)
    assert obj.type == raw["type"]
    assert adapter.validate_json(adapter.dump_json(obj)) == obj


def test_square_flight_plan_is_a_closed_square_over_the_site():
    plan = m.FlightPlan.model_validate_json((FIXTURES / "flight_plan_square.json").read_text())
    assert plan.waypoints[0] == plan.waypoints[-1]
    assert len(plan.waypoints) == 5
    assert all(w.alt == 20 for w in plan.waypoints)


def test_extra_fields_are_rejected():
    with pytest.raises(Exception):
        m.MissionSpec.model_validate({**json.loads((FIXTURES / "mission_spec_inspect.json").read_text()), "waypoints": []})


def test_site_frame_round_trip():
    from contracts.site import enu_to_latlon, latlon_to_enu, distance_m
    lat, lon = enu_to_latlon(123.4, -56.7)
    x, y = latlon_to_enu(lat, lon)
    assert abs(x - 123.4) < 1e-3 and abs(y + 56.7) < 1e-3
    assert abs(distance_m(*enu_to_latlon(0, 0), *enu_to_latlon(30, 40)) - 50) < 0.01
