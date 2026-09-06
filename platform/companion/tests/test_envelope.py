"""
Runtime envelope monitor -- property + unit tests (control/envelope.py).

The properties the brief asks for, one test each:
  * a breach is detected within ONE tick on random trajectories,
  * no false breach anywhere inside tolerance,
  * actions are monotone in severity (further out is never treated as milder),
  * recovery happens only after the hysteresis window, and
  * separation widens as peer data goes stale, never narrows.

Plus the per-constraint policy from ADR D22 (warning+slow, 2x -> hold,
NFZ/geofence -> rtl, standoff -> hold+back-off, 5 s -> escalate) and the wire
mapping (escalation never becomes a flight state; a seconds margin is never
published in a metres field).

Style matches the existing suite: plain pytest + hypothesis, no hardware.
"""
from __future__ import annotations

import math

import pytest
from hypothesis import given, settings, strategies as st

from eis_companion.control.envelope import (
    ACTIONS,
    STATE_BREACH,
    STATE_IN_ENVELOPE,
    STATE_WARNING,
    WIRE_ACTIONS,
    Corridor,
    CorridorLeg,
    CorridorOrbit,
    EnvelopeLimits,
    EnvelopeMonitor,
    EnvelopeSample,
    MonitoredZone,
    PeerSample,
    SiteGeometry,
    action_rank,
    assess,
    distance_m,
    evaluate,
    point_in_polygon,
    required_separation_m,
    signed_distance_inside_m,
    worst_finding,
)

# Komati stub geometry (site/site.stub.json).
HOME_LAT, HOME_LON = -26.0900, 29.4719
M_PER_DEG_LAT = 111_320.0

TOL_M = 10.0                      # inspect lateral tolerance (ADR D21)
LEG = CorridorLeg(
    start=(HOME_LAT, HOME_LON),
    end=(HOME_LAT, HOME_LON + 0.002),      # ~200 m east
    lateral_tol_m=TOL_M,
)
CORRIDOR = Corridor(legs=(LEG,), alt_min_m=20.0, alt_max_m=60.0)
LIMITS = EnvelopeLimits()


def offset_sample(drift_m: float, *, t_s: float = 0.0, alt: float = 40.0) -> EnvelopeSample:
    """A sample ``drift_m`` metres perpendicular (north) of the leg midpoint."""
    return EnvelopeSample(
        t_s=t_s,
        lat=HOME_LAT + drift_m / M_PER_DEG_LAT,
        lon=HOME_LON + 0.001,
        rel_alt_m=alt,
        airborne=True,
    )


def verdict(sample: EnvelopeSample, **kwargs):
    return evaluate(sample, corridor=CORRIDOR, limits=LIMITS, **kwargs)


# ==========================================================================
# Property: a breach is caught on the FIRST tick that produces it
# ==========================================================================
@settings(max_examples=200, deadline=None)
@given(
    drift=st.floats(min_value=20.01, max_value=400.0),
    sign=st.sampled_from((-1.0, 1.0)),
)
def test_breach_detected_within_one_tick(drift, sign):
    """Past 2x tolerance the very first sample is a breach -- no dwell, no
    averaging, no waiting for a second opinion."""
    monitor = EnvelopeMonitor(LIMITS, corridor=CORRIDOR)
    decision = monitor.update(offset_sample(sign * drift))
    assert decision.state == STATE_BREACH
    assert action_rank(decision.action) >= action_rank("hold")


@settings(max_examples=200, deadline=None)
@given(
    drift=st.floats(min_value=0.0, max_value=9.99),
    sign=st.sampled_from((-1.0, 1.0)),
    alt=st.floats(min_value=20.5, max_value=59.5),
)
def test_no_false_breach_inside_tolerance(drift, sign, alt):
    """Inside the tube and inside the band, nothing trips -- ordinary flight
    must not manufacture warnings, or nobody will believe a real one."""
    monitor = EnvelopeMonitor(LIMITS, corridor=CORRIDOR)
    decision = monitor.update(offset_sample(sign * drift, alt=alt))
    assert decision.state == STATE_IN_ENVELOPE
    assert decision.action == "none"
    assert decision.speed_scale == 1.0


@settings(max_examples=100, deadline=None)
@given(
    a=st.floats(min_value=0.0, max_value=200.0),
    b=st.floats(min_value=0.0, max_value=200.0),
)
def test_actions_are_monotone_in_severity(a, b):
    """Drifting further out never produces a MILDER action. The stateless
    assessment is the thing under test: hysteresis is a separate property."""
    lo, hi = (a, b) if a <= b else (b, a)
    near = worst_finding(assess(offset_sample(lo), corridor=CORRIDOR, limits=LIMITS))
    far = worst_finding(assess(offset_sample(hi), corridor=CORRIDOR, limits=LIMITS))
    assert action_rank(far.action) >= action_rank(near.action)


@settings(max_examples=50, deadline=None)
@given(dwell=st.floats(min_value=0.0, max_value=1.9))
def test_recovery_only_after_the_hysteresis_window(dwell):
    """A vehicle riding the tolerance edge must not flap: returning inside the
    tube clears the latch only after it has STAYED there for recovery_s."""
    monitor = EnvelopeMonitor(LIMITS, corridor=CORRIDOR)
    assert monitor.update(offset_sample(40.0, t_s=0.0)).state == STATE_BREACH

    # Comfortably back inside (margin 8 m > the 2 m hysteresis margin): this
    # sample opens the recovery window but does not close it.
    monitor.update(offset_sample(2.0, t_s=0.05))
    held = monitor.update(offset_sample(2.0, t_s=0.05 + dwell))
    assert held.state == STATE_BREACH
    assert action_rank(held.action) >= action_rank("hold")

    cleared = monitor.update(offset_sample(2.0, t_s=0.05 + LIMITS.recovery_s + 0.01))
    assert cleared.state == STATE_IN_ENVELOPE
    assert cleared.action == "none"


@settings(max_examples=200, deadline=None)
@given(
    younger=st.floats(min_value=0.0, max_value=60.0),
    older=st.floats(min_value=0.0, max_value=60.0),
)
def test_separation_widens_and_never_narrows_with_staleness(younger, older):
    """A stale peer position is an UNKNOWN peer position, so the requirement
    only ever grows with age (ADR D21: 40 m -> 80 m)."""
    lo, hi = (younger, older) if younger <= older else (older, younger)
    assert required_separation_m(hi, LIMITS) >= required_separation_m(lo, LIMITS)
    assert required_separation_m(0.0, LIMITS) == LIMITS.separation_m
    assert required_separation_m(math.inf, LIMITS) == LIMITS.separation_stale_m


# ==========================================================================
# Corridor policy (ADR D22)
# ==========================================================================
def test_drift_beyond_tolerance_warns_and_asks_for_slow():
    decision = verdict(offset_sample(15.0))
    assert decision.state == STATE_WARNING
    assert decision.action == "slow"
    assert decision.speed_scale < 1.0
    assert decision.margin_m == pytest.approx(TOL_M - 15.0, abs=0.5)


def test_drift_beyond_twice_tolerance_holds():
    decision = verdict(offset_sample(25.0))
    assert decision.state == STATE_BREACH
    assert decision.action == "hold"
    assert decision.speed_scale == 0.0


def test_altitude_outside_the_band_holds():
    below = verdict(offset_sample(0.0, alt=10.0))
    above = verdict(offset_sample(0.0, alt=70.0))
    assert below.constraint == "altitude" and below.action == "hold"
    assert above.constraint == "altitude" and above.action == "hold"
    assert below.margin_m == pytest.approx(-10.0)


def test_orbit_ring_is_measured_radially():
    corridor = Corridor(
        orbits=(CorridorOrbit(center=(HOME_LAT, HOME_LON), radius_m=30.0,
                              radial_tol_m=5.0),),
        alt_min_m=20.0, alt_max_m=60.0,
    )
    on_ring = EnvelopeSample(
        lat=HOME_LAT + 30.0 / M_PER_DEG_LAT, lon=HOME_LON, rel_alt_m=40.0
    )
    way_off = EnvelopeSample(
        lat=HOME_LAT + 50.0 / M_PER_DEG_LAT, lon=HOME_LON, rel_alt_m=40.0
    )
    assert evaluate(on_ring, corridor=corridor).state == STATE_IN_ENVELOPE
    off = evaluate(way_off, corridor=corridor)
    assert off.state == STATE_BREACH and off.constraint == "corridor"


def test_vehicle_only_has_to_be_inside_one_corridor_element():
    """A dog-leg plan has two legs; being on the second is not a breach of the
    first. The element with the smallest normalised excursion wins."""
    second = CorridorLeg(
        start=(HOME_LAT + 0.002, HOME_LON),
        end=(HOME_LAT + 0.002, HOME_LON + 0.002),
        lateral_tol_m=TOL_M,
    )
    corridor = Corridor(legs=(LEG, second), alt_min_m=20.0, alt_max_m=60.0)
    on_second = EnvelopeSample(
        lat=HOME_LAT + 0.002, lon=HOME_LON + 0.001, rel_alt_m=40.0
    )
    assert evaluate(on_second, corridor=corridor).state == STATE_IN_ENVELOPE


# ==========================================================================
# Containment: geofence + NFZ -> rtl
# ==========================================================================
FENCE = (
    (-26.0871, 29.4677), (-26.0871, 29.4765),
    (-26.0936, 29.4765), (-26.0936, 29.4677),
)
NFZ = MonitoredZone(
    name="switchyard",
    polygon=((-26.09135, 29.47365), (-26.09135, 29.47575),
             (-26.09275, 29.47575), (-26.09275, 29.47365)),
    ceiling_m=80.0,
)


def test_geofence_margin_intrusion_returns_to_launch():
    geometry = SiteGeometry(geofence=FENCE, nfz=(), nfz_buffer_m=25.0)
    # 1 m inside the northern fence edge: inside the polygon, inside the margin.
    sample = EnvelopeSample(
        lat=-26.0871 - 1.0 / M_PER_DEG_LAT, lon=29.472, rel_alt_m=40.0
    )
    decision = evaluate(sample, geometry=geometry, limits=LIMITS)
    assert decision.constraint == "geofence"
    assert decision.action == "rtl"
    assert decision.margin_m < 0.0


def test_nfz_buffer_intrusion_returns_to_launch():
    geometry = SiteGeometry(geofence=FENCE, nfz=(NFZ,), nfz_buffer_m=25.0)
    # 10 m north of the switchyard's northern edge: outside the polygon but
    # well inside the 25 m buffer.
    sample = EnvelopeSample(
        lat=-26.09135 + 10.0 / M_PER_DEG_LAT, lon=29.4747, rel_alt_m=40.0
    )
    decision = evaluate(sample, geometry=geometry, limits=LIMITS)
    assert decision.constraint == "nfz"
    assert decision.action == "rtl"


def test_overflight_above_the_nfz_ceiling_is_permitted():
    """ADR D3: inside the polygon at or below the ceiling is forbidden;
    overflight above it is allowed."""
    geometry = SiteGeometry(geofence=FENCE, nfz=(NFZ,), nfz_buffer_m=25.0)
    inside = EnvelopeSample(lat=-26.0920, lon=29.4747, rel_alt_m=40.0)
    over = EnvelopeSample(lat=-26.0920, lon=29.4747, rel_alt_m=100.0)
    assert evaluate(inside, geometry=geometry).action == "rtl"
    assert evaluate(over, geometry=geometry).action == "none"


# ==========================================================================
# Standoff, sortie, separation
# ==========================================================================
def test_standoff_below_the_floor_holds_and_asks_to_back_off():
    sample = EnvelopeSample(lat=HOME_LAT, lon=HOME_LON, rel_alt_m=40.0, standoff_m=1.5)
    decision = evaluate(sample, limits=LIMITS)
    assert decision.constraint == "standoff"
    assert decision.action == "hold"
    assert decision.back_off_m == pytest.approx(1.5)


def test_no_observed_subject_is_not_a_standoff_breach():
    """``inf`` means "nothing observed this tick", not "zero metres away" --
    losing tracker lock must not read as flying into someone."""
    sample = EnvelopeSample(lat=HOME_LAT, lon=HOME_LON, rel_alt_m=40.0)
    assert evaluate(sample, limits=LIMITS).action == "none"


def test_exhausted_sortie_budget_returns_and_reports_seconds_not_metres():
    sample = EnvelopeSample(
        lat=HOME_LAT, lon=HOME_LON, rel_alt_m=40.0,
        sortie_elapsed_s=500.0, sortie_cap_s=480.0,
    )
    decision = evaluate(sample, limits=LIMITS)
    assert decision.constraint == "sortie"
    assert decision.action == "rtl"
    assert decision.margin_unit == "s"
    # The contract's margin_m is METRES, so a time margin is omitted entirely
    # rather than published in the wrong unit.
    assert decision.wire_margin_m is None
    assert "margin_m" not in decision.to_message("eis-1", 0)


def test_peer_inside_nominal_separation_holds():
    sample = EnvelopeSample(lat=HOME_LAT, lon=HOME_LON, rel_alt_m=40.0)
    peer = PeerSample(
        vehicle_id="eis-2", lat=HOME_LAT + 20.0 / M_PER_DEG_LAT, lon=HOME_LON,
        age_s=0.5, valid=True,
    )
    decision = evaluate(sample, peer=peer, limits=LIMITS)
    assert decision.constraint == "separation"
    assert decision.action == "hold"


def test_stale_peer_widens_separation_and_then_holds_unconditionally():
    sample = EnvelopeSample(lat=HOME_LAT, lon=HOME_LON, rel_alt_m=40.0)
    at_50m = {"lat": HOME_LAT + 50.0 / M_PER_DEG_LAT, "lon": HOME_LON}

    fresh = evaluate(sample, peer=PeerSample(
        vehicle_id="eis-2", age_s=1.0, valid=True, **at_50m), limits=LIMITS)
    assert fresh.action == "none"                 # 50 m clears the 40 m rule

    stale = evaluate(sample, peer=PeerSample(
        vehicle_id="eis-2", age_s=5.0, valid=True, **at_50m), limits=LIMITS)
    assert stale.action == "hold"                 # ...but not the 80 m rule

    far_and_ancient = evaluate(sample, peer=PeerSample(
        vehicle_id="eis-2", lat=HOME_LAT + 0.01, lon=HOME_LON,
        age_s=12.0, valid=True), limits=LIMITS)
    assert far_and_ancient.action == "hold"       # geometry no longer matters
    assert "older than" in far_and_ancient.detail


def test_no_peer_means_no_separation_constraint():
    sample = EnvelopeSample(lat=HOME_LAT, lon=HOME_LON, rel_alt_m=40.0)
    assert evaluate(sample, peer=None, limits=LIMITS).action == "none"
    assert evaluate(sample, peer=PeerSample(valid=False), limits=LIMITS).action == "none"


# ==========================================================================
# Escalation: additive, never a flight-state change
# ==========================================================================
def test_persistent_breach_escalates_after_five_seconds():
    monitor = EnvelopeMonitor(LIMITS, corridor=CORRIDOR)
    monitor.update(offset_sample(40.0, t_s=0.0))
    mid = monitor.update(offset_sample(40.0, t_s=4.0))
    assert mid.action == "hold" and not mid.escalated

    late = monitor.update(offset_sample(40.0, t_s=5.1))
    assert late.escalated
    assert late.action == "escalate"
    # The escalation rides ON TOP of the hold; the flight state is unchanged.
    assert late.base_action == "hold"
    assert late.wire_action == "hold"
    assert late.breach_duration_s == pytest.approx(5.1, abs=0.01)


def test_wire_action_is_always_contract_legal():
    monitor = EnvelopeMonitor(LIMITS, corridor=CORRIDOR)
    for t in (0.0, 2.0, 6.0, 12.0):
        decision = monitor.update(offset_sample(40.0, t_s=t))
        assert decision.wire_action in WIRE_ACTIONS
        assert decision.action in ACTIONS


def test_wire_message_shape_matches_the_contract():
    monitor = EnvelopeMonitor(LIMITS, corridor=CORRIDOR)
    message = monitor.update(offset_sample(25.0)).to_message("eis-2", 1234)
    assert message["type"] == "envelope"
    assert message["vehicleId"] == "eis-2"
    assert message["ts"] == 1234
    assert message["state"] == STATE_BREACH
    assert message["constraint"] == "corridor"
    assert message["action"] == "hold"
    assert message["margin_m"] < 0.0


# ==========================================================================
# Latching, arming, suspension
# ==========================================================================
def test_a_worse_constraint_supersedes_a_milder_latch():
    geometry = SiteGeometry(geofence=FENCE, nfz=(NFZ,), nfz_buffer_m=25.0)
    monitor = EnvelopeMonitor(LIMITS, corridor=CORRIDOR, geometry=geometry)
    warned = monitor.update(offset_sample(15.0, t_s=0.0))
    assert warned.action == "slow"

    into_nfz = EnvelopeSample(
        t_s=0.05, lat=-26.0920, lon=29.4747, rel_alt_m=40.0, airborne=True
    )
    assert monitor.update(into_nfz).action == "rtl"


def test_suspension_keeps_evaluating_but_marks_the_decision():
    """Manual engage suspends ACTIONS, never evaluation: the record must not
    go dark the moment an operator takes the sticks."""
    monitor = EnvelopeMonitor(LIMITS, corridor=CORRIDOR)
    decision = monitor.update(offset_sample(40.0), suspended=True)
    assert decision.suspended is True
    assert decision.state == STATE_BREACH          # still measured
    assert monitor.latched is not None             # still latched


def test_disarm_drops_the_corridor_but_not_the_site_geometry():
    geometry = SiteGeometry(geofence=FENCE, nfz=(NFZ,), nfz_buffer_m=25.0)
    monitor = EnvelopeMonitor(LIMITS, geometry=geometry)
    monitor.arm(CORRIDOR)
    assert monitor.armed is True
    assert monitor.update(offset_sample(40.0)).state == STATE_BREACH

    monitor.disarm()
    assert monitor.armed is False
    assert monitor.update(offset_sample(40.0, t_s=1.0)).state == STATE_IN_ENVELOPE
    # Containment still applies with no plan loaded.
    into_nfz = EnvelopeSample(t_s=2.0, lat=-26.0920, lon=29.4747, rel_alt_m=40.0)
    assert monitor.update(into_nfz).action == "rtl"


# ==========================================================================
# Corridor parsing from the wire contract
# ==========================================================================
def test_corridor_parses_the_contract_shape():
    corridor = Corridor.from_wire({
        "legs": [{
            "from": {"lat": HOME_LAT, "lon": HOME_LON},
            "to": {"lat": HOME_LAT, "lon": HOME_LON + 0.002},
            "lateral_tol_m": 15.0,
        }],
        "orbits": [{
            "center": {"lat": HOME_LAT, "lon": HOME_LON},
            "radius_m": 30.0, "radial_tol_m": 5.0,
        }],
        "alt_band_m": {"min": 30.0, "max": 50.0},
        "generated_from": "req-1",
    })
    assert len(corridor.legs) == 1 and corridor.legs[0].lateral_tol_m == 15.0
    assert len(corridor.orbits) == 1 and corridor.orbits[0].radius_m == 30.0
    assert (corridor.alt_min_m, corridor.alt_max_m) == (30.0, 50.0)
    assert corridor.generated_from == "req-1"
    assert corridor.has_shape


@pytest.mark.parametrize("raw", [
    None, "not-a-dict", {}, {"legs": [{"from": {"lat": 200, "lon": 0}}]},
    {"legs": [{"from": {"lat": 0, "lon": 0}}]},               # no 'to'
    {"orbits": [{"center": {"lat": 0, "lon": 0}, "radius_m": 0}]},
])
def test_malformed_corridor_parts_are_dropped_not_guessed(raw):
    corridor = Corridor.from_wire(raw)
    assert not corridor.has_shape


# ==========================================================================
# Geometry helpers
# ==========================================================================
def test_signed_distance_is_positive_inside_and_negative_outside():
    inside = signed_distance_inside_m((-26.0900, 29.4719), FENCE)
    outside = signed_distance_inside_m((-26.0800, 29.4719), FENCE)
    assert inside > 0.0
    assert outside < 0.0
    assert point_in_polygon((-26.0900, 29.4719), FENCE)
    assert not point_in_polygon((-26.0800, 29.4719), FENCE)


def test_degenerate_polygon_constrains_nothing_rather_than_faking_a_breach():
    assert math.isinf(signed_distance_inside_m((0.0, 0.0), ((0.0, 0.0),)))


def test_distance_is_infinite_for_malformed_positions():
    assert math.isinf(distance_m(math.nan, 0.0, 0.0, 0.0))
    assert math.isinf(distance_m(200.0, 0.0, 0.0, 0.0))
    assert distance_m(HOME_LAT, HOME_LON, HOME_LAT, HOME_LON) == pytest.approx(0.0)
