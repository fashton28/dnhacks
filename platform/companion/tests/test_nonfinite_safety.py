"""Non-finite inputs must never become MAXIMUM commands (FM-05/06/07).

Under CPython ``min(hi, NaN)`` returns ``hi``, so a naive ``max(lo, min(hi, v))``
clamp converts every unusable number into the POSITIVE MAXIMUM. Four independent
copies of that clamp existed (app, guidance, manual, pid) and each one turned a
single NaN into full forward + full right + full descent + max yaw at once.

These are property tests because the finding is about an INPUT DOMAIN, not a
single value: every non-finite float, on every axis, through every clamp.

Every test here fails on the pre-fix tree:
  * FM-05 ``_clamp01(nan) == 1.0`` -> full stick deflection from one wire frame;
  * FM-06 ``app._clamp_setpoint`` gated only on ``sp.valid``;
  * FM-07 the three guidance standoff re-assertions are comparisons, and a
    comparison against NaN is False, so a NaN distance both bypassed the hard
    standoff AND was clamped to +max_speed -- a commanded full-speed approach
    THROUGH the floor.
"""
from __future__ import annotations

import asyncio
import json
import math

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from eis_companion.app import Companion, _clamp
from eis_companion.config import AppConfig
from eis_companion.control.distance import estimate_distance
from eis_companion.control.guidance import Guidance
from eis_companion.control.manual import ManualPilot, _clamp01
from eis_companion.control.pid import PID
from eis_companion.control.tracker import Tracker
from eis_companion.types import (
    Limits,
    TargetObservation,
    TrackingState,
    VelocitySetpoint,
)

# The whole non-finite domain a JSON frame or a degenerate filter can produce.
NON_FINITE = st.sampled_from([float("nan"), float("inf"), float("-inf")])
FINITE = st.floats(
    min_value=-1e6, max_value=1e6, allow_nan=False, allow_infinity=False
)

LOCKED = TrackingState.LOCKED.value
BBOX = (0.45, 0.40, 0.10, 0.20)


def companion() -> Companion:
    cfg = AppConfig()
    cfg.sitl = True
    cfg.camera.source = "sim"
    cfg.planner.site_file = "site/does-not-exist.json"
    c = Companion(cfg)
    c.setup()
    c.vehicle = None
    return c


# ==========================================================================
# The clamp primitives themselves
# ==========================================================================
@given(v=NON_FINITE, lo=FINITE, hi=FINITE)
def test_app_clamp_never_returns_a_bound_for_a_non_finite_input(v, lo, hi):
    """max(lo, min(hi, NaN)) == hi. Zero is the only safe answer."""
    assert _clamp(v, min(lo, hi), max(lo, hi)) == 0.0


@given(v=NON_FINITE)
def test_manual_clamp01_treats_a_non_finite_axis_as_centred(v):
    """_clamp01(nan) used to be 1.0 -- FULL stick deflection (FM-05)."""
    assert _clamp01(v) == 0.0


@given(v=NON_FINITE)
def test_pid_refuses_a_non_finite_error_instead_of_saturating(v):
    pid = PID(1.0, 0.5, 0.1, out_min=-10.0, out_max=10.0)
    assert pid.update(v, 0.05) == 0.0
    # ...and the controller is not poisoned for the next, valid sample.
    assert math.isfinite(pid.update(1.0, 0.05))


# ==========================================================================
# FM-06: the orchestrator's final clamp
# ==========================================================================
@given(bad=NON_FINITE, axis=st.integers(min_value=0, max_value=3))
@settings(max_examples=40, deadline=None)
def test_orchestrator_clamp_collapses_any_non_finite_axis_to_hold(bad, axis):
    c = companion()
    values = [0.5, 0.5, 0.5, 5.0]
    values[axis] = bad
    sp = VelocitySetpoint(
        vx=values[0], vy=values[1], vz=values[2], yaw_rate=values[3], valid=True
    )
    out = c._clamp_setpoint(sp)
    assert out.valid is False
    assert (out.vx, out.vy, out.vz, out.yaw_rate) == (0.0, 0.0, 0.0, 0.0)


def test_orchestrator_clamp_still_passes_a_normal_setpoint_through():
    c = companion()
    L = c.limits
    out = c._clamp_setpoint(
        VelocitySetpoint(vx=999.0, vy=-999.0, vz=999.0, yaw_rate=999.0, valid=True)
    )
    assert out.valid is True
    assert out.vx == pytest.approx(L.max_speed)
    assert out.vy == pytest.approx(-L.max_speed)
    assert out.vz == pytest.approx(L.max_climb_rate)
    assert out.yaw_rate == pytest.approx(L.max_yaw_rate)


# ==========================================================================
# FM-05: manualInput
# ==========================================================================
@given(bad=NON_FINITE, name=st.sampled_from(["throttle", "yaw", "pitch", "roll"]))
@settings(max_examples=40, deadline=None)
def test_manual_input_frame_with_a_non_finite_axis_is_dropped_whole(bad, name):
    c = companion()
    c._manual_engaged = True
    before = c._last_manual_input_ms
    frame = {"type": "manualInput", "throttle": 0.0, "yaw": 0.0, "pitch": 0.0, "roll": 0.0}
    frame[name] = bad
    c._handle_manual_input(frame)
    # Not stored, and -- critically -- the watchdog was NOT refreshed, so a
    # stream of these ages out into the zero-and-hold like a dead link.
    assert c._last_manual_input_ms == before
    sp = c.manual.update(c.limits, 0.05)
    assert (sp.vx, sp.vy, sp.vz, sp.yaw_rate) == (0.0, 0.0, 0.0, 0.0)


@given(bad=NON_FINITE)
@settings(max_examples=20, deadline=None)
def test_manual_pilot_rejects_a_non_finite_stick_frame(bad):
    pilot = ManualPilot()
    assert pilot.set_input(throttle=bad, yaw=0.0, pitch=0.0, roll=0.0) is False
    out = pilot.update(Limits(), 0.05)
    assert (out.vx, out.vy, out.vz, out.yaw_rate) == (0.0, 0.0, 0.0, 0.0)


def test_a_full_pitch_stick_still_commands_full_forward():
    """The guard must not blunt a legitimate full-deflection input."""
    pilot = ManualPilot(smoothing=1.0)
    limits = Limits()
    assert pilot.set_input(throttle=0.0, yaw=0.0, pitch=1.0, roll=0.0) is True
    out = pilot.update(limits, 0.05)
    assert out.vx == pytest.approx(limits.max_speed)


def test_wire_parser_refuses_the_bare_nan_and_infinity_literals():
    """json.loads accepts NaN/Infinity by default; the contract does not."""
    from eis_companion.api.server import _reject_constant

    for token in ('{"a": NaN}', '{"a": Infinity}', '{"a": -Infinity}'):
        with pytest.raises(ValueError):
            json.loads(token, parse_constant=_reject_constant)
    # ...and 1e400, which is spec-legal JSON that parses to inf, is caught by
    # the per-axis isfinite check rather than the parser.
    assert math.isinf(json.loads('{"a": 1e400}')["a"])


# ==========================================================================
# FM-07: a non-finite distance must never approach
# ==========================================================================
@given(bad=NON_FINITE)
@settings(max_examples=20, deadline=None)
def test_estimate_distance_reports_no_measurement_for_a_non_finite_bbox(bad):
    assert estimate_distance(bad) is None


@given(bad=NON_FINITE)
@settings(max_examples=20, deadline=None)
def test_guidance_never_commands_approach_on_a_non_finite_distance(bad):
    """The single worst input used to produce the single worst output.

    Pre-fix, ten ticks of NaN distance asymptoted to vx = +max_speed: a
    commanded full-speed approach through the standoff floor, while the UI
    rendered a normal bbox.
    """
    g = Guidance()
    limits = Limits()
    for _ in range(10):
        out = g.update(LOCKED, BBOX, bad, limits, 0.05)
        assert math.isfinite(out.vx)
        assert out.vx <= 0.0, "non-finite distance must never command approach"


def test_guidance_still_approaches_a_target_beyond_the_standoff():
    """Control: the guard did not simply disable forward motion."""
    g = Guidance()
    limits = Limits()
    out = None
    for _ in range(5):
        out = g.update(LOCKED, BBOX, limits.standoff + 10.0, limits, 0.05)
    assert out is not None and out.vx > 0.0


def test_guidance_still_backs_off_inside_the_standoff():
    g = Guidance()
    limits = Limits()
    out = None
    for _ in range(3):
        out = g.update(LOCKED, BBOX, limits.standoff - 3.0, limits, 0.05)
    assert out is not None and out.vx < 0.0


@given(bad=NON_FINITE)
@settings(max_examples=20, deadline=None)
def test_tracker_drops_a_non_finite_detection_instead_of_latching_it(bad):
    """One NaN in the Kalman state used to latch for the life of the track."""
    tracker = Tracker(min_hits=1)
    tracker.update([TargetObservation(bbox=(0.4, 0.4, 0.1, bad), conf=0.9)], ts=1.0)
    result = tracker.update(
        [TargetObservation(bbox=(0.4, 0.4, 0.1, bad), conf=0.9)], ts=1.1
    )
    assert result.estimated_distance is None
    for target in result.targets:
        assert all(math.isfinite(v) for v in target.bbox)


def test_tracker_still_tracks_a_healthy_detection():
    tracker = Tracker(min_hits=1)
    obs = TargetObservation(bbox=(0.4, 0.4, 0.1, 0.25), conf=0.9)
    tracker.update([obs], ts=1.0)
    result = tracker.update([obs], ts=1.1)
    assert result.locked_target_id is not None
    assert result.estimated_distance is not None
    assert math.isfinite(result.estimated_distance)


# ==========================================================================
# End to end: one hostile wire frame must not move the aircraft
# ==========================================================================
def test_a_nan_manual_frame_cannot_command_motion_through_the_control_tick():
    from eis_companion.types import VehicleState

    c = companion()
    sent: list = []

    class Recorder:
        limits = Limits()

        def send_body_velocity(self, vx, vy, vz, yaw_rate, valid=True):
            sent.append((vx, vy, vz, yaw_rate, valid))

        def update_limits(self, limits):
            pass

    c.vehicle = Recorder()
    c._vehicle_state = VehicleState(armed=True, airborne=True, mode="GUIDED")
    c._manual_engaged = True
    c._set_control_source("manual")
    c._handle_manual_input({
        "type": "manualInput",
        "throttle": float("nan"), "yaw": float("nan"),
        "pitch": float("nan"), "roll": float("nan"),
    })
    asyncio.run(c._control_tick(0.05))
    assert sent, "the tick must emit something"
    for vx, vy, vz, yaw_rate, valid in sent:
        assert (vx, vy, vz, yaw_rate) == (0.0, 0.0, 0.0, 0.0)
        assert valid is False
