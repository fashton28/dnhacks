"""Safety Validator: one test per rule, plus the cases the demo depends on.

Coordinates are given in Site-local metres and converted, so a reader can see where a
waypoint sits relative to the reactor exclusion (centred 55 m north, radius 45 m) without
decoding latitudes.
"""
from __future__ import annotations

import pytest

from contracts.models import FlightPlan, LatLon, MissionSpec, Objective, Severity, Verdict, Waypoint
from contracts.site import enu_to_latlon
from hub.safety import validate
from sim.common.site_limits import SiteLimits


@pytest.fixture(scope="module")
def limits() -> SiteLimits:
    return SiteLimits.load()


def wp(x: float, y: float, alt: float = 30.0) -> Waypoint:
    lat, lon = enu_to_latlon(x, y)
    return Waypoint(lat=lat, lon=lon, alt=alt)


def plan(points: list[Waypoint], *, mission_id: str = "msn-t", duration_s: float = 60.0,
         battery_pct: float = 10.0, spec: MissionSpec | None = None) -> FlightPlan:
    return FlightPlan(mission_id=mission_id, drone_id="d1", waypoints=points, pattern="direct",
                      est_duration_s=duration_s, est_battery_pct=battery_pct, spec=spec)


def rules(result) -> list[str]:
    return [v.rule for v in result.violations]


def test_legal_plan_is_accepted(limits: SiteLimits) -> None:
    r = validate(plan([wp(-60, -60), wp(60, -60), wp(60, -100)]), limits)
    assert r.verdict is Verdict.accept
    assert r.violations == []


def test_waypoint_outside_geofence(limits: SiteLimits) -> None:
    r = validate(plan([wp(-60, -60), wp(300, -60)]), limits)
    assert r.verdict is Verdict.reject
    assert "geofence_containment" in rules(r)
    assert any(v.waypoint_index == 1 for v in r.violations)


def test_segment_crossing_the_no_fly_zone_is_rejected(limits: SiteLimits) -> None:
    """Both endpoints are legal; the straight line between them crosses the reactor.

    Checking only waypoints would pass this plan and fly it over the exclusion zone.
    """
    a, b = wp(-120, 55), wp(120, 55)
    assert validate(plan([a]), limits).verdict is Verdict.accept
    assert validate(plan([b]), limits).verdict is Verdict.accept

    r = validate(plan([a, b]), limits)
    assert r.verdict is Verdict.reject
    assert rules(r) == ["no_fly_zone"]
    assert "reactor_exclusion" in r.violations[0].detail


def test_waypoint_inside_the_no_fly_zone(limits: SiteLimits) -> None:
    r = validate(plan([wp(0, 55)]), limits)
    assert r.verdict is Verdict.reject
    assert "no_fly_zone" in rules(r)


def test_altitude_ceiling_and_floor(limits: SiteLimits) -> None:
    high = validate(plan([wp(-60, -60, limits.alt_ceiling_m + 15)]), limits)
    assert high.verdict is Verdict.reject and "altitude_ceiling" in rules(high)

    low = validate(plan([wp(-60, -60, limits.alt_floor_m - 2)]), limits)
    assert low.verdict is Verdict.reject and "altitude_floor" in rules(low)


def test_battery_reserve(limits: SiteLimits) -> None:
    r = validate(plan([wp(-60, -60), wp(60, -60)], battery_pct=90.0), limits)
    assert r.verdict is Verdict.reject
    assert "battery_reserve" in rules(r)


def test_mission_duration_cap(limits: SiteLimits) -> None:
    r = validate(plan([wp(-60, -60), wp(60, -60)], duration_s=1200.0), limits)
    assert r.verdict is Verdict.reject
    assert "mission_duration_cap" in rules(r)


def test_standoff_is_a_warning_and_still_accepts(limits: SiteLimits) -> None:
    """A warning names the rule without refusing the plan."""
    ring = [LatLon(lat=(p := enu_to_latlon(x, y))[0], lon=p[1]) for x, y in
            [(-70, -70), (-50, -70), (-50, -50), (-70, -50)]]
    spec = MissionSpec(detection_id="det-1", objective=Objective.standoff_observe,
                       survey_polygon=ring, max_altitude_m=50.0, standoff_m=25.0,
                       rationale="observe from a distance")
    r = validate(plan([wp(-62, -62)], spec=spec), limits)
    assert r.verdict is Verdict.accept
    assert rules(r) == ["standoff_minimum"]
    assert r.violations[0].severity is Severity.warning


def test_verdict_carries_the_plan_mission_id(limits: SiteLimits) -> None:
    r = validate(plan([wp(0, 55)], mission_id="msn-042"), limits)
    assert r.mission_id == "msn-042"
