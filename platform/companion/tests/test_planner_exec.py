"""
PlannerExecutor tests (hackathon mission planner, Phase 2).

Plain unit tests prove:
  * plan loading validates/normalises tools and rejects malformed ones,
  * goto legs emit clamped absolute targets and advance on arrival,
  * hold legs advance on duration expiry (indefinite hold never advances),
  * orbit legs respect the standoff-derived radius floor and advance after a
    full revolution (closed-loop kinematic sim),
  * rtl signals the orchestrator and is terminal,
  * abort()/link-loss zero-and-hold,
  * live limit tightening applies on the next emit.

Hypothesis property tests generate random plans (valid AND out-of-range
values), random vehicle states, and assert NO output ever breaches:
  * horizontal speed  <= min(profile speed, limits.max_speed),
  * altitude          inside the site band intersected with [0, max_altitude],
  * orbit radius      >= the hard standoff floor (and no approach inside it),
  * |vz| <= max_climb_rate, |yaw_rate| <= max_yaw_rate.

numpy + stdlib + hypothesis only -- no hardware.
"""
from __future__ import annotations

import math

import pytest
from hypothesis import given, settings, strategies as st

from eis_companion.control.planner_exec import (
    MAX_PLAN_TOOLS,
    GotoTarget,
    PlanOutputKind,
    PlannerExecutor,
    _bearing_deg,
    _haversine_m,
)
from eis_companion.types import Limits, VehicleState, VelocitySetpoint

EPS = 1e-6
CENTER_LAT, CENTER_LON = 47.0, 8.0
M_PER_DEG_LAT = 111194.9  # good enough for test-local offsets


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def _state(lat=CENTER_LAT, lon=CENTER_LON, alt=10.0, heading=0.0) -> VehicleState:
    return VehicleState(
        armed=True, mode="GUIDED", relAlt=alt, lat=lat, lon=lon,
        heading=heading, airborne=True,
    )


def _offset(lat: float, lon: float, north_m: float, east_m: float):
    """Offset a lat/lon by meters (flat-earth, fine at test scale)."""
    dlat = north_m / M_PER_DEG_LAT
    dlon = east_m / (M_PER_DEG_LAT * math.cos(math.radians(lat)))
    return lat + dlat, lon + dlon


def _step_state(state: VehicleState, sp: VelocitySetpoint, dt: float) -> VehicleState:
    """Integrate BODY-frame velocities into the next VehicleState (Euler)."""
    h = math.radians(state.heading)
    vn = sp.vx * math.cos(h) - sp.vy * math.sin(h)
    ve = sp.vx * math.sin(h) + sp.vy * math.cos(h)
    lat, lon = _offset(state.lat, state.lon, vn * dt, ve * dt)
    return _state(
        lat=lat,
        lon=lon,
        alt=state.relAlt - sp.vz * dt,  # vz is NED down+
        heading=(state.heading + sp.yaw_rate * dt) % 360.0,
    )


def _plan(*tools, profile="standard", request_id="req-1", anomaly_id="anom-1"):
    return {
        "requestId": request_id,
        "anomalyId": anomaly_id,
        "tools": list(tools),
        "profile": profile,
        "rationale": "test",
    }


def _executor(limits=None, profile_speed=4.0, band=(5.0, 25.0), **kw) -> PlannerExecutor:
    return PlannerExecutor(
        limits or Limits(),
        profile_speed,
        alt_band_min=band[0],
        alt_band_max=band[1],
        **kw,
    )


def _assert_hold(sp: VelocitySetpoint) -> None:
    assert sp.valid is False
    assert sp.vx == sp.vy == sp.vz == sp.yaw_rate == 0.0


# --------------------------------------------------------------------------
# idle / load validation
# --------------------------------------------------------------------------
def test_no_plan_is_idle_hold():
    ex = _executor()
    out = ex.update(_state(), 0.05)
    assert out.kind is PlanOutputKind.IDLE
    _assert_hold(out.setpoint)
    assert not ex.active and not ex.done


@pytest.mark.parametrize(
    "plan",
    [
        {"tools": []},
        {"tools": "nope"},
        {},
        _plan({"tool": "teleport"}),
        _plan({"tool": "goto_gps", "lon": 8.0}),                       # missing lat
        _plan({"tool": "goto_gps", "lat": 999.0, "lon": 8.0}),         # lat out of range
        _plan({"tool": "goto_gps", "lat": float("nan"), "lon": 8.0}),
        _plan({"tool": "goto_gps", "lat": 47.0, "lon": 8.0, "alt": float("inf")}),
        _plan({"tool": "orbit_point", "lat": 47.0, "lon": 8.0, "radius": float("nan")}),
        _plan({"tool": "orbit_point", "lat": 47.0, "lon": 8.0}),       # missing radius
        _plan({"tool": "hold", "durationS": float("inf")}),
        _plan("not-a-mapping"),
    ],
)
def test_load_rejects_malformed_plans(plan):
    ex = _executor()
    ok, msg = ex.load_plan(plan)
    assert ok is False
    assert msg
    assert not ex.active


def test_load_rejects_oversized_plan():
    # tool-count cap: bounds per-tick advance work in the 20 Hz loop and
    # rejects absurd plans outright (robustness, safe failure direction).
    ex = _executor()
    tools = [{"tool": "hold", "durationS": 0.0}] * (MAX_PLAN_TOOLS + 1)
    ok, msg = ex.load_plan(_plan(*tools))
    assert ok is False
    assert "too large" in msg
    assert not ex.active


def test_max_instant_legs_advance_in_one_tick_without_recursion():
    # Regression: the per-leg advance used to recurse via update(state, 0.0),
    # so a plan of instantly-completing legs raised RecursionError every tick
    # (wedging the planner in a hover with the log spamming). The bounded
    # loop must walk ALL of them in a single tick and complete the plan.
    ex = _executor()
    tools = [{"tool": "hold", "durationS": 0.0}] * MAX_PLAN_TOOLS
    ok, msg = ex.load_plan(_plan(*tools))
    assert ok, msg
    out = ex.update(_state(), 0.05)   # must not raise
    assert out.kind is PlanOutputKind.DONE
    assert out.done and ex.done
    _assert_hold(out.setpoint)


def test_rejected_load_preserves_previous_plan():
    ex = _executor()
    ok, _ = ex.load_plan(_plan({"tool": "hold"}))
    assert ok
    ok2, _ = ex.load_plan(_plan({"tool": "teleport"}))
    assert not ok2
    assert ex.active and ex.tool_count == 1  # old plan still armed


# --------------------------------------------------------------------------
# goto legs
# --------------------------------------------------------------------------
def test_goto_emits_clamped_target():
    lim = Limits()  # max_speed 2.0, max_altitude 30
    ex = _executor(lim, profile_speed=6.0, band=(10.0, 20.0))
    tlat, tlon = _offset(CENTER_LAT, CENTER_LON, 200.0, 0.0)
    ok, _ = ex.load_plan(_plan({"tool": "goto_gps", "lat": tlat, "lon": tlon, "alt": 100.0}))
    assert ok
    out = ex.update(_state(), 0.05)
    assert out.kind is PlanOutputKind.GOTO
    assert out.goto == GotoTarget(lat=tlat, lon=tlon, alt=20.0, speed=2.0)
    _assert_hold(out.setpoint)  # goto flavor carries no velocity
    assert out.tool_index == 0 and out.tool_count == 1 and not out.done


def test_goto_low_alt_clamped_up_to_band_floor():
    ex = _executor(band=(10.0, 20.0))
    tlat, tlon = _offset(CENTER_LAT, CENTER_LON, 200.0, 0.0)
    ex.load_plan(_plan({"tool": "goto_gps", "lat": tlat, "lon": tlon, "alt": -5.0}))
    out = ex.update(_state(), 0.05)
    assert out.goto.alt == 10.0


def test_goto_missing_alt_freezes_current_clamped():
    ex = _executor(band=(10.0, 20.0))
    tlat, tlon = _offset(CENTER_LAT, CENTER_LON, 200.0, 0.0)
    ex.load_plan(_plan({"tool": "goto_gps", "lat": tlat, "lon": tlon}))
    out = ex.update(_state(alt=50.0), 0.05)
    assert out.goto.alt == 20.0
    # frozen: a later altitude change does not move the target
    out2 = ex.update(_state(alt=15.0), 0.05)
    assert out2.goto.alt == 20.0


def test_goto_arrival_advances_to_next_tool():
    ex = _executor()
    ex.load_plan(_plan(
        {"tool": "goto_gps", "lat": CENTER_LAT, "lon": CENTER_LON, "alt": 10.0},
        {"tool": "hold"},
    ))
    out = ex.update(_state(lat=CENTER_LAT, lon=CENTER_LON, alt=10.0), 0.05)
    assert out.kind is PlanOutputKind.VELOCITY  # now on the hold leg
    assert out.tool_index == 1


def test_goto_single_tool_arrival_completes_plan():
    ex = _executor()
    ex.load_plan(_plan({"tool": "goto_gps", "lat": CENTER_LAT, "lon": CENTER_LON, "alt": 10.0}))
    out = ex.update(_state(alt=10.0), 0.05)
    assert out.kind is PlanOutputKind.DONE
    assert out.done and ex.done
    _assert_hold(out.setpoint)


def test_goto_not_arrived_when_alt_off():
    ex = _executor(band=(5.0, 25.0))
    ex.load_plan(_plan({"tool": "goto_gps", "lat": CENTER_LAT, "lon": CENTER_LON, "alt": 20.0}))
    out = ex.update(_state(alt=5.0), 0.05)  # right spot, wrong altitude
    assert out.kind is PlanOutputKind.GOTO
    assert out.tool_index == 0


def test_goto_speed_respects_live_limit_tightening():
    lim = Limits(max_speed=8.0)
    ex = _executor(lim, profile_speed=6.0)
    tlat, tlon = _offset(CENTER_LAT, CENTER_LON, 500.0, 0.0)
    ex.load_plan(_plan({"tool": "goto_gps", "lat": tlat, "lon": tlon, "alt": 10.0}))
    assert ex.update(_state(), 0.05).goto.speed == 6.0
    lim.max_speed = 1.0  # orchestrator tightened the envelope live
    assert ex.update(_state(), 0.05).goto.speed == 1.0


def test_per_leg_profile_only_tightens():
    lim = Limits(max_speed=8.0)
    speeds = {"slow": 2.0, "standard": 4.0, "fast": 6.0}
    ex = _executor(lim, profile_speed=4.0, profile_speeds=speeds)
    tlat, tlon = _offset(CENTER_LAT, CENTER_LON, 500.0, 0.0)
    ex.load_plan(_plan(
        {"tool": "goto_gps", "lat": tlat, "lon": tlon, "alt": 10.0, "profile": "fast"},
        {"tool": "goto_gps", "lat": tlat, "lon": tlon, "alt": 10.0, "profile": "slow"},
    ))
    summary = ex.plan_summary()
    assert summary[0]["speed"] == 4.0  # 'fast' may not raise the plan cap
    assert summary[1]["speed"] == 2.0  # 'slow' tightens it


# --------------------------------------------------------------------------
# hold legs
# --------------------------------------------------------------------------
def test_hold_emits_zero_velocity_hover():
    ex = _executor()
    ex.load_plan(_plan({"tool": "hold", "durationS": 10.0}))
    out = ex.update(_state(), 0.05)
    assert out.kind is PlanOutputKind.VELOCITY
    _assert_hold(out.setpoint)


def test_hold_duration_expiry_advances():
    ex = _executor()
    ex.load_plan(_plan({"tool": "hold", "durationS": 1.0}, {"tool": "rtl"}))
    out = ex.update(_state(), 0.6)
    assert out.kind is PlanOutputKind.VELOCITY and out.tool_index == 0
    out = ex.update(_state(), 0.6)  # 1.2 s elapsed >= 1.0 -> advance to rtl
    assert out.kind is PlanOutputKind.RTL


def test_hold_indefinite_never_advances():
    ex = _executor()
    ex.load_plan(_plan({"tool": "hold"}))
    for _ in range(200):
        out = ex.update(_state(), 0.5)
    assert out.kind is PlanOutputKind.VELOCITY
    assert out.tool_index == 0 and not ex.done


def test_hold_negative_duration_treated_as_zero():
    ex = _executor()
    ex.load_plan(_plan({"tool": "hold", "durationS": -5.0}, {"tool": "hold"}))
    out = ex.update(_state(), 0.05)
    assert out.tool_index == 1  # advanced immediately


# --------------------------------------------------------------------------
# rtl / completion / abort / link loss
# --------------------------------------------------------------------------
def test_rtl_signals_and_is_terminal():
    ex = _executor()
    ex.load_plan(_plan({"tool": "rtl"}))
    out = ex.update(_state(), 0.05)
    assert out.kind is PlanOutputKind.RTL
    assert out.done and ex.done
    _assert_hold(out.setpoint)
    # keeps signalling until the orchestrator releases us
    assert ex.update(_state(), 0.05).kind is PlanOutputKind.RTL


def test_abort_zero_and_holds():
    ex = _executor()
    ex.load_plan(_plan({"tool": "hold"}))
    ex.update(_state(), 0.05)
    sp = ex.abort()
    _assert_hold(sp)
    assert not ex.active
    out = ex.update(_state(), 0.05)
    assert out.kind is PlanOutputKind.IDLE
    _assert_hold(out.setpoint)
    assert ex.progress()["aborted"] is True


def test_link_loss_zero_and_holds_without_advancing():
    ex = _executor()
    ex.load_plan(_plan({"tool": "hold", "durationS": 0.1}, {"tool": "rtl"}))
    for _ in range(50):
        out = ex.update(_state(), 0.5, link_ok=False)
        assert out.kind is PlanOutputKind.VELOCITY
        _assert_hold(out.setpoint)
    assert out.tool_index == 0  # plan froze while the link was down


def test_nonfinite_state_holds():
    ex = _executor()
    ex.load_plan(_plan({"tool": "rtl"}))
    out = ex.update(_state(lat=float("nan")), 0.05)
    assert out.kind is PlanOutputKind.VELOCITY
    _assert_hold(out.setpoint)


def test_reset_returns_to_pristine_idle():
    ex = _executor()
    ex.load_plan(_plan({"tool": "hold"}))
    ex.update(_state(), 0.05)
    ex.reset()
    p = ex.progress()
    assert p == {
        "active": False, "done": False, "aborted": False,
        "toolIndex": 0, "toolCount": 0, "tool": None,
        "requestId": "", "anomalyId": "",
    }


def test_progress_reports_plan_state():
    ex = _executor()
    ex.load_plan(_plan({"tool": "hold"}, {"tool": "rtl"}))
    p = ex.progress()
    assert p["active"] and not p["done"]
    assert p["toolIndex"] == 0 and p["toolCount"] == 2 and p["tool"] == "hold"
    assert p["requestId"] == "req-1" and p["anomalyId"] == "anom-1"


# --------------------------------------------------------------------------
# orbit legs
# --------------------------------------------------------------------------
def test_orbit_radius_floored_at_standoff():
    ex = _executor()
    ex.load_plan(_plan({"tool": "orbit_point", "lat": CENTER_LAT, "lon": CENTER_LON, "radius": 0.5}))
    assert ex.plan_summary()[0]["radius"] == Limits().min_standoff  # 3.0


def test_orbit_never_approaches_inside_floor():
    ex = _executor()
    ex.load_plan(_plan({"tool": "orbit_point", "lat": CENTER_LAT, "lon": CENTER_LON, "radius": 1.0}))
    # at the center and 2 m off it (both inside the 3 m floor): vx must be <= 0
    for north in (0.0, 2.0):
        lat, lon = _offset(CENTER_LAT, CENTER_LON, -north, 0.0)
        out = ex.update(_state(lat=lat, lon=lon), 0.05)
        assert out.kind is PlanOutputKind.VELOCITY
        assert out.setpoint.vx <= EPS


def test_orbit_velocity_axes_clamped():
    lim = Limits()
    ex = _executor(lim, profile_speed=50.0, band=(5.0, 25.0))
    ex.load_plan(_plan({"tool": "orbit_point", "lat": CENTER_LAT, "lon": CENTER_LON, "radius": 8.0}))
    lat, lon = _offset(CENTER_LAT, CENTER_LON, -100.0, 40.0)
    out = ex.update(_state(lat=lat, lon=lon, alt=200.0, heading=123.0), 0.05)
    sp = out.setpoint
    assert math.hypot(sp.vx, sp.vy) <= lim.max_speed + EPS
    assert abs(sp.vz) <= lim.max_climb_rate + EPS
    assert abs(sp.yaw_rate) <= lim.max_yaw_rate + EPS


def test_orbit_climbs_back_into_band():
    ex = _executor(band=(10.0, 20.0))
    ex.load_plan(_plan({"tool": "orbit_point", "lat": CENTER_LAT, "lon": CENTER_LON, "radius": 8.0}))
    lat, lon = _offset(CENTER_LAT, CENTER_LON, -8.0, 0.0)
    below = ex.update(_state(lat=lat, lon=lon, alt=2.0), 0.05)
    assert below.setpoint.vz < 0.0  # NED: climb
    above = ex.update(_state(lat=lat, lon=lon, alt=40.0), 0.05)
    assert above.setpoint.vz > 0.0  # NED: descend


def test_orbit_completes_revolution_and_advances():
    lim = Limits()  # max_speed 2.0
    ex = _executor(lim, profile_speed=4.0, band=(5.0, 25.0))
    radius = 8.0
    ex.load_plan(_plan({"tool": "orbit_point", "lat": CENTER_LAT, "lon": CENTER_LON, "radius": radius}))
    lat, lon = _offset(CENTER_LAT, CENTER_LON, -radius, 0.0)  # on the ring, south
    state = _state(lat=lat, lon=lon, alt=10.0, heading=0.0)   # nose on center
    dt = 0.05
    done = False
    for _ in range(4000):  # generous: ~1 revolution needs ~500 ticks at 2 m/s
        out = ex.update(state, dt)
        if out.kind is PlanOutputKind.DONE:
            done = True
            break
        assert out.kind is PlanOutputKind.VELOCITY
        dist = _haversine_m(state.lat, state.lon, CENTER_LAT, CENTER_LON)
        assert 2.5 <= dist <= 20.0  # stays on a sane ring the whole way round
        state = _step_state(state, out.setpoint, dt)
    assert done, "orbit leg never completed a revolution"


# --------------------------------------------------------------------------
# property tests (hypothesis)
# --------------------------------------------------------------------------
def _tool_strategy():
    lat = st.floats(-90.0, 90.0)
    lon = st.floats(-180.0, 180.0)
    goto = st.fixed_dictionaries(
        {"tool": st.just("goto_gps"), "lat": lat, "lon": lon},
        optional={
            "alt": st.floats(-500.0, 500.0),
            "profile": st.sampled_from(["slow", "standard", "fast", "bogus"]),
        },
    )
    orbit = st.fixed_dictionaries(
        {"tool": st.just("orbit_point"), "lat": lat, "lon": lon,
         "radius": st.floats(-50.0, 500.0)},
    )
    hold = st.fixed_dictionaries(
        {"tool": st.just("hold")},
        optional={"durationS": st.floats(-10.0, 30.0)},
    )
    rtl = st.fixed_dictionaries({"tool": st.just("rtl")})
    return st.one_of(goto, orbit, hold, rtl)


_states = st.builds(
    _state,
    lat=st.floats(-90.0, 90.0),
    lon=st.floats(-180.0, 180.0),
    alt=st.floats(-10.0, 200.0),
    heading=st.floats(0.0, 360.0),
)


@settings(max_examples=120, deadline=None)
@given(
    tools=st.lists(_tool_strategy(), min_size=1, max_size=5),
    profile_speed=st.floats(-5.0, 50.0),
    band_min=st.floats(-10.0, 100.0),
    band_max=st.floats(-10.0, 100.0),
    states=st.lists(_states, min_size=1, max_size=25),
    dt=st.floats(0.0, 0.5),
)
def test_property_no_output_ever_breaches(tools, profile_speed, band_min, band_max, states, dt):
    lim = Limits()
    ex = PlannerExecutor(lim, profile_speed, alt_band_min=band_min, alt_band_max=band_max)
    ok, msg = ex.load_plan(_plan(*tools))
    assert ok, msg  # every generated tool is well-formed (values may be wild)

    # invariants mirrored from the spec (NOT from the implementation):
    speed_cap = max(0.0, min(profile_speed, lim.max_speed))
    band_hi = max(0.0, min(band_max, lim.max_altitude))
    band_lo = max(0.0, min(band_min, band_hi))

    # normalised plan itself must already respect the floors/caps
    for leg in ex.plan_summary():
        if leg["tool"] == "orbit_point":
            assert leg["radius"] >= lim.min_standoff
        if "speed" in leg:
            assert 0.0 <= leg["speed"] <= speed_cap + EPS
        if leg.get("alt") is not None:
            assert band_lo - EPS <= leg["alt"] <= band_hi + EPS

    for s in states:
        out = ex.update(s, dt)
        sp = out.setpoint
        assert math.hypot(sp.vx, sp.vy) <= speed_cap + EPS
        assert abs(sp.vz) <= lim.max_climb_rate + EPS
        assert abs(sp.yaw_rate) <= lim.max_yaw_rate + EPS
        assert all(math.isfinite(v) for v in (sp.vx, sp.vy, sp.vz, sp.yaw_rate))
        if out.kind is PlanOutputKind.GOTO:
            assert band_lo - EPS <= out.goto.alt <= band_hi + EPS
            assert 0.0 <= out.goto.speed <= speed_cap + EPS


@settings(max_examples=150, deadline=None)
@given(
    radius=st.floats(-10.0, 100.0),
    profile_speed=st.floats(0.0, 20.0),
    north=st.floats(-60.0, 60.0),
    east=st.floats(-60.0, 60.0),
    alt=st.floats(-10.0, 200.0),
    heading=st.floats(0.0, 360.0),
)
def test_property_orbit_never_commands_approach_inside_floor(
    radius, profile_speed, north, east, alt, heading
):
    lim = Limits()
    ex = _executor(lim, profile_speed=profile_speed)
    ok, _ = ex.load_plan(_plan(
        {"tool": "orbit_point", "lat": CENTER_LAT, "lon": CENTER_LON, "radius": radius},
    ))
    assert ok
    lat, lon = _offset(CENTER_LAT, CENTER_LON, north, east)
    out = ex.update(_state(lat=lat, lon=lon, alt=alt, heading=heading), 0.05)
    assert out.kind is PlanOutputKind.VELOCITY
    r_eff = max(radius, lim.min_standoff)
    dist = _haversine_m(lat, lon, CENTER_LAT, CENTER_LON)
    if dist <= r_eff:
        assert out.setpoint.vx <= EPS  # never close on the center inside the floor


@settings(max_examples=100, deadline=None)
@given(
    lat=st.floats(-90.0, 90.0),
    lon=st.floats(-180.0, 180.0),
    alt=st.floats(-1000.0, 1000.0),
    profile_speed=st.floats(-5.0, 50.0),
    band_min=st.floats(-10.0, 100.0),
    band_max=st.floats(-10.0, 100.0),
    state=_states,
)
def test_property_goto_target_always_inside_envelope(
    lat, lon, alt, profile_speed, band_min, band_max, state
):
    lim = Limits()
    ex = PlannerExecutor(lim, profile_speed, alt_band_min=band_min, alt_band_max=band_max)
    ok, _ = ex.load_plan(_plan({"tool": "goto_gps", "lat": lat, "lon": lon, "alt": alt}))
    assert ok
    out = ex.update(state, 0.05)
    band_hi = max(0.0, min(band_max, lim.max_altitude))
    band_lo = max(0.0, min(band_min, band_hi))
    if out.kind is PlanOutputKind.GOTO:
        assert band_lo - EPS <= out.goto.alt <= band_hi + EPS
        assert 0.0 <= out.goto.speed <= max(0.0, min(profile_speed, lim.max_speed)) + EPS
        assert out.goto.lat == lat and out.goto.lon == lon
    else:
        # arrived instantly -> plan complete, safe hold
        assert out.kind is PlanOutputKind.DONE
        _assert_hold(out.setpoint)


# --------------------------------------------------------------------------
# geo helper sanity (they underpin the safety math)
# --------------------------------------------------------------------------
def test_geo_helpers_sanity():
    lat2, lon2 = _offset(CENTER_LAT, CENTER_LON, 100.0, 0.0)
    assert _haversine_m(CENTER_LAT, CENTER_LON, lat2, lon2) == pytest.approx(100.0, rel=0.01)
    assert _bearing_deg(CENTER_LAT, CENTER_LON, lat2, lon2) == pytest.approx(0.0, abs=0.5)
    lat3, lon3 = _offset(CENTER_LAT, CENTER_LON, 0.0, 100.0)
    assert _bearing_deg(CENTER_LAT, CENTER_LON, lat3, lon3) == pytest.approx(90.0, abs=0.5)
