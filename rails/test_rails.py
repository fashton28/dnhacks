"""
rails/test_rails — the oracle's own tests.

These do not compare the oracle against the port; that is what the parity
harnesses do (``platform/ground/planner/test/parity.test.ts`` and
``platform/companion/tests/test_envelope_parity.py``). These pin the ORACLE
against the checked-in specification, so that a parity failure is unambiguous:
if these pass and parity fails, the port is what moved.

Run::

    python -m pytest rails/test_rails.py -q
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rails import eval_envelope, eval_planner
from rails.deterministic import plan_mission, profile_for_look_for
from rails.envelope import (
    STATE_BREACH, STATE_IN_ENVELOPE, STATE_WARNING, Corridor, CorridorLeg, EnvelopeLimits,
    EnvelopeMonitor, EnvelopeSample, MonitoredZone, SiteGeometry, evaluate,
    required_separation_m,
)
from rails.geometry import round6, shrink_orbit_radius, via_candidates
from rails.policy import PLANNER_POLICY, UNATTENDED_ENVELOPE, VERIFIER_POLICY
from rails.schemas import Anomaly, SchemaError, Task, validate_mission_plan
from rails.scripted import ScriptedPlanner
from rails.triage import (
    LURE_REPEAT_COUNT, TriageCueBudget, TriageInput, TriageVehicle, TriageZone, is_fresh,
    scripted_triage, triage_prompt,
)
from rails.verifier import CHECK_ORDER, verify_mission

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURE_IDS = eval_planner.fixture_ids()
FIXTURES = [eval_planner.read_json(f"{fixture_id}.json") for fixture_id in FIXTURE_IDS]


def _fixture(fixture_id: str):
    return next(entry for entry in FIXTURES if entry["id"] == fixture_id)


# ---------------------------------------------------------------------------
# The fixture set is the specification the oracle is pinned against
# ---------------------------------------------------------------------------
def test_every_fixture_carries_the_inputs_the_oracle_needs():
    for fixture in FIXTURES:
        assert fixture.get("site"), f"{fixture['id']} names no site"
        assert fixture.get("plan"), f"{fixture['id']} carries no plan"
        assert fixture.get("probeTask"), f"{fixture['id']} carries no probeTask"
        assert fixture.get("probeRequestId"), f"{fixture['id']} carries no probeRequestId"
        Task.model_validate(fixture["probeTask"])
        context = eval_planner.build_context(fixture.get("telemetry"))
        Anomaly.model_validate(context["anomaly"])
        # mode and fleet are optional per case, but when present they must be
        # the shapes the verifier reads.
        assert context.get("mode", "attended") in ("attended", "unattended")
        assert isinstance(context.get("fleet", []), list)


@pytest.mark.parametrize("fixture", FIXTURES, ids=FIXTURE_IDS)
def test_oracle_reproduces_the_fixture_verdict(fixture):
    site = eval_planner.site_for(fixture)
    context = eval_planner.build_context(fixture.get("telemetry"))
    result = verify_mission(fixture["plan"], site, context)
    assert [check.name for check in result.checks] == list(CHECK_ORDER)
    assert result.failing_checks == fixture["expected"]["failingChecks"]
    assert result.verdict == fixture["expected"]["verdict"]


@pytest.mark.parametrize("fixture", FIXTURES, ids=FIXTURE_IDS)
def test_a_corrected_plan_is_itself_clean(fixture):
    site = eval_planner.site_for(fixture)
    context = eval_planner.build_context(fixture.get("telemetry"))
    result = verify_mission(fixture["plan"], site, context)
    if result.verdict != "corrected":
        assert result.correctedPlan is None
        return
    assert result.correctedPlan is not None
    rechecked = verify_mission(result.correctedPlan, site, context)
    assert rechecked.failing_checks == []
    assert rechecked.verdict == "pass"


def test_planner_emits_pass_or_infeasible_never_corrected():
    """THE assertion. A `corrected` verdict on planner output is a planner bug."""
    document = eval_planner.evaluate()
    assert document["summary"]["violations"] == []
    assert document["summary"]["count"] == len(FIXTURE_IDS)


def test_refused_states_are_the_documented_ones():
    document = eval_planner.evaluate()
    assert sorted(document["summary"]["plannerInfeasible"]) == [
        "V03", "V04", "V09", "V15", "V16", "V17", "V19", "V21", "V22", "V24", "V31", "V34", "V35",
    ]


# ---------------------------------------------------------------------------
# The rule table (ADR D20)
# ---------------------------------------------------------------------------
def _rule_table_inputs(**context_overrides):
    fixture = _fixture("V01")
    site = eval_planner.site_for(fixture)
    context = eval_planner.build_context(fixture.get("telemetry"))
    context.update(context_overrides)
    anomaly = Anomaly.model_validate(context["anomaly"])
    return site, context, anomaly


def _plan(look_for: str, **context_overrides):
    site, context, anomaly = _rule_table_inputs(**context_overrides)
    task = Task.model_validate({**_fixture("V01")["probeTask"], "lookFor": look_for})
    return plan_mission(task=task, anomaly=anomaly, site=site, context=context,
                        request_id="rule-table")


def test_look_for_maps_to_a_profile():
    assert profile_for_look_for("structure") == "survey"
    for look_for in ("person", "vehicle", "fence_gap", "unknown"):
        assert profile_for_look_for(look_for) == "inspect"
    assert _plan("person").plan.profile == "inspect"
    assert _plan("structure").plan.profile == "survey"


def test_holds_for_fifteen_seconds_only_on_a_fence_gap():
    gap = _plan("fence_gap").plan
    person = _plan("person").plan
    assert any(tool["tool"] == "hold" and tool["durationS"] == PLANNER_POLICY["fenceGapHoldS"]
               for tool in gap.tools)
    assert not any(tool["tool"] == "hold" for tool in person.tools)


def test_exactly_one_lap_and_one_terminal_rtl():
    plan = _plan("vehicle").plan
    orbits = [tool for tool in plan.tools if tool["tool"] == "orbit_point"]
    assert len(orbits) == 1 and orbits[0]["laps"] == 1
    assert [tool["tool"] for tool in plan.tools].count("rtl") == 1
    assert plan.tools[-1]["tool"] == "rtl"


def test_orbit_never_shrinks_below_the_standoff_floor():
    orbit = next(tool for tool in _plan("vehicle").plan.tools if tool["tool"] == "orbit_point")
    assert orbit["radius"] >= VERIFIER_POLICY["hardMinStandoffM"]
    assert orbit["radius"] >= 5.0          # the inspect profile's own floor


def test_shrink_refuses_rather_than_breaching_standoff():
    site, _, _ = _rule_table_inputs()
    centre = (site.home.lat, site.home.lon)
    assert shrink_orbit_radius(centre, 25.0, 45.0, site, 1_000_000.0) is None


def test_plans_are_byte_for_byte_reproducible():
    first = _plan("fence_gap").plan.dump()
    second = _plan("fence_gap").plan.dump()
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)


def test_the_trace_carries_rules_not_geometry():
    result = _plan("fence_gap")
    for entry in result.planTrace:
        assert "m AGL" not in entry.effect
        assert not any(part.count(".") == 1 and len(part.split(".")[-1]) >= 4
                       for part in entry.effect.replace(",", " ").split())
    assert result.plan.planTrace == result.planTrace


def test_the_corridor_carries_the_documented_tolerances():
    inspect = _plan("vehicle")
    survey = _plan("structure")
    assert all(leg.lateral_tol_m == 10.0 for leg in inspect.corridor.legs)
    assert all(leg.lateral_tol_m == 15.0 for leg in survey.corridor.legs)
    assert all(orbit.radial_tol_m == 5.0 for orbit in inspect.corridor.orbits)
    assert inspect.corridor.generated_from == inspect.plan.requestId


def test_budget_is_min_range_and_sortie_cap():
    result = _plan("vehicle")
    assert result.timeBudgetS <= VERIFIER_POLICY["maxSortieS"]
    assert result.estimatedFlightS <= result.timeBudgetS


def test_unattended_band_applies_and_the_hourly_cap_refuses():
    unattended = _plan("vehicle", mode="unattended")
    assert not unattended.infeasible
    altitudes = [tool["alt"] for tool in unattended.plan.tools if tool["tool"] == "goto_gps"]
    assert min(altitudes) >= UNATTENDED_ENVELOPE["altBandM"]["min"]
    assert max(altitudes) <= UNATTENDED_ENVELOPE["altBandM"]["max"]

    capped = _plan("vehicle", mode="unattended",
                   unattendedSortiesLastHour=UNATTENDED_ENVELOPE["maxSortiesPerHour"])
    assert capped.infeasible and "unattended sorties" in capped.reason


def test_v36_planner_output_matches_the_checked_in_plan():
    fixture = _fixture("V36")
    site = eval_planner.site_for(fixture)
    context = eval_planner.build_context(fixture.get("telemetry"))
    task = Task.model_validate(fixture["task"]["task"])
    anomaly = Anomaly.model_validate(fixture["task"]["anomaly"])
    result = plan_mission(task=task, anomaly=anomaly, site=site, context=context,
                          request_id=fixture["plan"]["requestId"])
    assert not result.infeasible, result.reason
    emitted = result.plan.dump()
    expected = fixture["plan"]
    assert emitted["profile"] == expected["profile"]
    assert eval_planner.normalise_tools(emitted["tools"]) == \
        eval_planner.normalise_tools(expected["tools"])


# ---------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------
def test_round6_rounds_half_up_the_way_javascript_does():
    assert round6(0.0000005) == 0.000001
    assert round6(-0.0000005) == -0.0        # Math.round(-0.5) === -0
    assert round6(1.23456749) == 1.234567


def test_via_candidates_break_ties_northernmost():
    site, _, _ = _rule_table_inputs()
    zone = site.nfz[0]
    home = (site.home.lat, site.home.lon)
    candidates = via_candidates(home, home, zone, site)
    if len(candidates) >= 2:
        first, second = candidates[0], candidates[1]
        if abs(first.detour_m - second.detour_m) <= 1e-6:
            assert first.point[0] >= second.point[0]


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------
def test_schema_refuses_a_moving_track_tool_in_a_sequence():
    with pytest.raises(SchemaError):
        validate_mission_plan({
            "requestId": "x", "anomalyId": "a", "profile": "inspect", "rationale": "",
            "tools": [{"tool": "follow", "track_id": 1, "profile": "inspect"}, {"tool": "rtl"}],
        })


def test_schema_refuses_conflicting_wire_aliases():
    with pytest.raises(SchemaError):
        validate_mission_plan({
            "requestId": "x", "anomalyId": "a", "profile": "inspect", "rationale": "",
            "tools": [{"tool": "goto_gps", "lat": 0, "lon": 0, "alt": 30, "alt_m": 40},
                      {"tool": "rtl"}],
        })


# ---------------------------------------------------------------------------
# Triage — the scripted ranking, which is the default path
# ---------------------------------------------------------------------------
def _cue(cue_id: str, *, source="cctv", type_="motion", confidence=0.8, lat=-26.09, lon=29.4719,
         observed_at=None, ttl_s=None) -> Anomaly:
    return Anomaly.model_validate({
        "id": cue_id, "lat": lat, "lon": lon, "type": type_, "confidence": confidence,
        "thumbnail": "", "source": source,
        **({"observedAt": observed_at} if observed_at is not None else {}),
        **({"ttl_s": ttl_s} if ttl_s is not None else {}),
    })


def _triage(anomalies, **kwargs):
    return scripted_triage(TriageInput(
        anomalies=anomalies, fleet=[TriageVehicle("eis-1", True)],
        cueBudget=TriageCueBudget(used=0, cap=2), now=1_757_116_800_000, **kwargs))


def test_scripted_triage_ranks_by_reliability_confidence_and_recency():
    result = _triage([_cue("low", source="sentinel2", confidence=0.4),
                      _cue("high", source="fence_sensor", confidence=0.95)])
    assert [task.anomalyId for task in result.tasks] == ["high", "low"]
    assert all(task.source == "scripted" for task in result.tasks)
    assert all(len(task.question) <= 120 for task in result.tasks)


def test_scripted_triage_is_stable_for_equal_scores():
    cues = [_cue("b-cue"), _cue("a-cue"), _cue("c-cue")]
    assert [task.anomalyId for task in _triage(cues).tasks] == ["a-cue", "b-cue", "c-cue"]


def test_the_lure_rule_flags_repeats_at_one_place():
    cues = [_cue(f"cue-{i}", observed_at=1_757_116_800_000) for i in range(LURE_REPEAT_COUNT)]
    result = _triage(cues)
    assert set(result.requiresOperator) == {cue.id for cue in cues}


def test_a_stale_cue_cannot_dispatch():
    stale = _cue("stale", observed_at=1_757_116_800_000 - 10_000, ttl_s=5)
    assert not is_fresh(stale, 1_757_116_800_000)
    assert _triage([stale]).tasks == []


def test_rf_plus_fence_motion_correlates_and_rf_plus_interference_escalates():
    zone = TriageZone(name="north fence",
                      polygon=[{"lat": -26.10, "lon": 29.46}, {"lat": -26.10, "lon": 29.48},
                               {"lat": -26.08, "lon": 29.48}, {"lat": -26.08, "lon": 29.46}],
                      fenceLine=True)
    rf = [{"ts": 1_757_116_800_000, "kind": "drone_link", "source": "rf_drone",
           "band": "2.4GHz", "confidence": 0.9}]
    correlated = _triage([_cue("motion-1")], zones=[zone], rfEvents=rf)
    assert correlated.tasks[0].lookFor == "fence_gap"
    assert correlated.tasks[0].urgency == "immediate"

    jammed = _triage([_cue("motion-1")], zones=[zone], rfEvents=rf + [
        {"ts": 1_757_116_800_000, "kind": "gnss_interference", "source": "sdr",
         "band": "GPS L1", "confidence": 0.9}])
    assert jammed.escalateWithoutFlying == ["motion-1"]
    assert jammed.tasks[0].urgency == "defer"


def test_the_triage_prompt_is_the_reviewable_copy_of_the_port_prompt():
    ported = (REPO_ROOT / "platform" / "ground" / "planner" / "prompts" / "triage.md")
    assert triage_prompt() == ported.read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# The EIS_TEST_BAD_PLAN rail
# ---------------------------------------------------------------------------
def test_the_scripted_failing_plan_is_what_the_demo_needs_it_to_be():
    fixture = _fixture("V01")
    site = eval_planner.site_for(fixture)
    context = eval_planner.build_context(fixture.get("telemetry"))
    anomaly = Anomaly.model_validate(context["anomaly"])
    bad = ScriptedPlanner().plan(site, anomaly, failing=True)
    verdict = verify_mission(bad, site, context)
    assert verdict.verdict != "pass"
    assert "altitude" in verdict.failing_checks


# ---------------------------------------------------------------------------
# The envelope monitor's policy (ADR D22 / D21)
# ---------------------------------------------------------------------------
CORRIDOR = Corridor(
    legs=(CorridorLeg(start=eval_envelope.LEG_START, end=eval_envelope.LEG_END,
                      lateral_tol_m=10.0),),
    alt_min_m=30.0, alt_max_m=50.0,
)
GEOMETRY = SiteGeometry(
    geofence=tuple((p[0], p[1]) for p in eval_envelope.GEOFENCE),
    nfz=(MonitoredZone(name="east switchyard",
                       polygon=tuple((p[0], p[1]) for p in eval_envelope.NFZ["polygon"]),
                       ceiling_m=30.0),),
    nfz_buffer_m=25.0,
)


def _tick(east_m, north_m=200.0, **kwargs):
    lat, lon = eval_envelope.offset(east_m, north_m)
    return EnvelopeSample(lat=lat, lon=lon, rel_alt_m=kwargs.pop("alt_m", 40.0), **kwargs)


def test_drift_beyond_tolerance_warns_and_slows():
    decision = evaluate(_tick(15.0), corridor=CORRIDOR, geometry=GEOMETRY)
    assert (decision.state, decision.action) == (STATE_WARNING, "slow")
    assert decision.speed_scale == 0.5


def test_drift_beyond_twice_tolerance_holds():
    decision = evaluate(_tick(25.0), corridor=CORRIDOR, geometry=GEOMETRY)
    assert (decision.state, decision.constraint, decision.action) == (STATE_BREACH, "corridor", "hold")


def test_geofence_and_nfz_go_straight_to_rtl():
    outside = evaluate(_tick(720.0, 0.0), corridor=CORRIDOR, geometry=GEOMETRY)
    assert (outside.constraint, outside.action) == ("geofence", "rtl")
    inside_nfz = evaluate(_tick(300.0, 0.0, alt_m=25.0), corridor=CORRIDOR, geometry=GEOMETRY)
    assert (inside_nfz.constraint, inside_nfz.action) == ("nfz", "rtl")
    overflight = evaluate(_tick(300.0, 0.0, alt_m=45.0), corridor=CORRIDOR, geometry=GEOMETRY)
    assert overflight.constraint != "nfz"


def test_standoff_below_the_floor_holds_and_asks_to_back_off():
    decision = evaluate(_tick(0.0, standoff_m=1.0), corridor=CORRIDOR, geometry=GEOMETRY)
    assert (decision.constraint, decision.action) == ("standoff", "hold")
    assert decision.back_off_m == pytest.approx(2.0)


def test_separation_doubles_when_the_peer_view_is_stale():
    limits = EnvelopeLimits()
    assert required_separation_m(1.0, limits) == 40.0
    assert required_separation_m(5.0, limits) == 80.0
    assert required_separation_m(math.inf, limits) == 80.0


def test_a_breach_that_persists_escalates_without_changing_the_flight_state():
    monitor = EnvelopeMonitor(corridor=CORRIDOR, geometry=GEOMETRY)
    monitor.arm(CORRIDOR)
    decision = None
    for index in range(140):
        decision = monitor.update(_tick(25.0, t_s=index / 20.0))
    assert decision.action == "escalate"
    assert decision.base_action == "hold"
    assert decision.wire_action == "hold"      # escalation is never a flight state
    assert decision.wire_action in ("none", "slow", "hold", "rtl")


def test_recovery_is_hysteretic_and_never_flappy():
    monitor = EnvelopeMonitor(corridor=CORRIDOR, geometry=GEOMETRY)
    monitor.arm(CORRIDOR)
    for index in range(20):
        monitor.update(_tick(25.0, t_s=index / 20.0))
    assert monitor.last.state == STATE_BREACH
    # Just inside the tolerance is NOT enough: recovery needs the hysteresis
    # margin, held for the recovery window.
    monitor.update(_tick(9.5, t_s=1.05))
    assert monitor.last.state == STATE_BREACH
    decision = None
    for index in range(21, 120):
        decision = monitor.update(_tick(0.0, t_s=index / 20.0))
    assert decision.state == STATE_IN_ENVELOPE
    assert monitor.latched is None


def test_a_suspended_decision_still_latches_and_logs():
    monitor = EnvelopeMonitor(corridor=CORRIDOR, geometry=GEOMETRY)
    monitor.arm(CORRIDOR)
    decision = monitor.update(_tick(25.0, t_s=0.0), suspended=True)
    assert decision.suspended is True
    assert decision.state == STATE_BREACH
    assert monitor.latched is not None


def test_the_trajectory_set_is_twenty_and_deterministic():
    first = eval_envelope.evaluate()
    second = eval_envelope.evaluate()
    assert first["trajectoryCount"] == eval_envelope.TRAJECTORY_COUNT == 20
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)
    for entry in first["trajectories"]:
        assert len(entry["states"]) == eval_envelope.SAMPLE_COUNT
        for state in entry["states"]:
            assert state["wire_action"] in ("none", "slow", "hold", "rtl")
            assert state["state"] in (STATE_IN_ENVELOPE, STATE_WARNING, STATE_BREACH)


def test_the_trajectory_set_covers_every_constraint():
    covered = {state["constraint"]
               for entry in eval_envelope.evaluate()["trajectories"]
               for state in entry["states"] if state["constraint"]}
    assert {"corridor", "altitude", "geofence", "nfz", "standoff", "separation", "sortie"} <= covered
