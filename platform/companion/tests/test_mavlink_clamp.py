"""The FC-egress clamp: the second stage of "clamped twice".

Guidance and manual own the envelope and clamp first. This file covers what
happens on the way OUT of the companion, in the last few microseconds before a
command becomes bytes on a MAVLink link:

  * ``mavlink.safety.clamp_body_velocity`` bounds every axis of a BODY-frame
    setpoint to ``Limits`` and can only ever TIGHTEN;
  * ``clamp_speed_for_fc`` / ``clamp_altitude_for_fc`` / ``clamp_goto_target``
    do the same for the planner's GUIDED position targets, which bypass the
    orchestrator's per-tick velocity clamp entirely;
  * a NON-FINITE value on any axis collapses the whole command to the zero
    hold. This is the load-bearing case: under CPython ``min(hi, nan)`` is
    ``hi``, so the obvious ``max(lo, min(hi, v))`` clamp turns every unusable
    number into the POSITIVE MAXIMUM -- one NaN becoming full forward + full
    right + full descent + max yaw at the same instant;
  * and the wire actually carries the clamped values, checked against a
    recording pymavlink double rather than against the clamp's own return.

No sockets and no SITL: a scripted-inbox fake master, the same idiom the other
Vehicle tests use. pymavlink is imported only for its constants.
"""
from __future__ import annotations

import math

import pytest
from pymavlink import mavutil

from eis_companion.mavlink.safety import (
    clamp_altitude_for_fc,
    clamp_body_velocity,
    clamp_goto_target,
    clamp_speed_for_fc,
)
from eis_companion.mavlink.vehicle import Vehicle
from eis_companion.types import Limits, VelocitySetpoint

mav = mavutil.mavlink

# The wire type mask for a velocity + yaw-rate setpoint, spelled out here as
# the NUMBER on the wire rather than imported from the module under test:
# ignore position (bits 0-2), acceleration (6-8), force (9) and yaw angle (10).
VEL_YAWRATE_TYPEMASK = 0b011111000111       # 1991

#: Every way a JSON frame or a degenerate filter can produce "not a number".
NON_FINITE = (float("nan"), float("inf"), float("-inf"))

AXES = ("vx", "vy", "vz", "yaw_rate")


# --------------------------------------------------------------------------
# Recording pymavlink double
# --------------------------------------------------------------------------
class FakeMav:
    def __init__(self, sent: list) -> None:
        self._sent = sent

    def __getattr__(self, name: str):
        if not name.endswith("_send"):
            raise AttributeError(name)
        stripped = name[: -len("_send")]

        def _send(*args):
            self._sent.append((stripped, args))
        return _send


class FakeMaster:
    target_system = 1
    target_component = 1

    def __init__(self) -> None:
        self.sent: list = []
        self.mav = FakeMav(self.sent)
        self.inbox: list = []

    def recv_match(self, type=None, blocking=False, timeout=None):
        return None


def make_vehicle(limits: Limits | None = None) -> Vehicle:
    v = Vehicle(limits=limits)
    v._master = FakeMaster()
    v._connected = True
    v._target_system = 1
    v._target_component = 1
    return v


def velocity_frames(v: Vehicle) -> list:
    return [
        args for name, args in v._master.sent
        if name == "set_position_target_local_ned"
    ]


def commanded(frame: tuple) -> tuple:
    """``(vx, vy, vz, yaw_rate_rad)`` out of a LOCAL_NED target tuple."""
    return frame[8], frame[9], frame[10], frame[15]


# ==========================================================================
# clamp_body_velocity: bounds
# ==========================================================================
def test_each_axis_is_bounded_by_its_own_limit():
    limits = Limits(max_speed=2.0, max_climb_rate=1.5, max_yaw_rate=45.0)
    out = clamp_body_velocity(
        VelocitySetpoint(vx=99.0, vy=-99.0, vz=99.0, yaw_rate=999.0, valid=True),
        limits,
    )
    assert out.valid is True
    assert out.vx == pytest.approx(2.0)
    assert out.vy == pytest.approx(-2.0)
    assert out.vz == pytest.approx(1.5)
    assert out.yaw_rate == pytest.approx(45.0)


def test_a_setpoint_inside_the_envelope_passes_through_untouched():
    limits = Limits(max_speed=8.0, max_climb_rate=3.0, max_yaw_rate=90.0)
    wanted = VelocitySetpoint(vx=1.25, vy=-0.5, vz=0.75, yaw_rate=-12.0, valid=True)
    out = clamp_body_velocity(wanted, limits)
    assert (out.vx, out.vy, out.vz, out.yaw_rate) == (1.25, -0.5, 0.75, -12.0)


def test_the_clamp_only_ever_tightens():
    """It must never RAISE a value the control core already lowered.

    The orchestrator scales the envelope down when it degrades (wind, sensor
    health). If this stage restored the setpoint to the full ``Limits`` the
    degradation would be undone at the last possible moment.
    """
    limits = Limits(max_speed=8.0, max_climb_rate=3.0, max_yaw_rate=90.0)
    scaled = VelocitySetpoint(vx=0.4, vy=0.0, vz=0.1, yaw_rate=5.0, valid=True)
    out = clamp_body_velocity(scaled, limits)
    assert out.vx == pytest.approx(0.4)
    assert out.vz == pytest.approx(0.1)


def test_an_invalid_setpoint_stays_the_canonical_hold():
    out = clamp_body_velocity(
        VelocitySetpoint(vx=5.0, vy=5.0, vz=5.0, yaw_rate=50.0, valid=False),
        Limits(),
    )
    assert out.valid is False
    assert (out.vx, out.vy, out.vz, out.yaw_rate) == (0.0, 0.0, 0.0, 0.0)


# ==========================================================================
# clamp_body_velocity: the non-finite domain
# ==========================================================================
@pytest.mark.parametrize("bad", NON_FINITE)
@pytest.mark.parametrize("axis", AXES)
def test_one_non_finite_axis_collapses_the_whole_setpoint_to_hold(bad, axis):
    """Not to a bound, and not axis-by-axis.

    Three good axes plus one NaN is not a command worth trusting, and the
    naive clamp would have answered "maximum" on the bad axis while keeping
    the other three -- the worst possible reading of the worst input.
    """
    limits = Limits(max_speed=2.0, max_climb_rate=1.5, max_yaw_rate=45.0)
    values = {"vx": 0.5, "vy": 0.5, "vz": 0.5, "yaw_rate": 5.0}
    values[axis] = bad
    out = clamp_body_velocity(VelocitySetpoint(valid=True, **values), limits)

    assert out.valid is False
    assert (out.vx, out.vy, out.vz, out.yaw_rate) == (0.0, 0.0, 0.0, 0.0)
    # Explicitly NOT the bound: max(lo, min(hi, nan)) would have been hi.
    assert out.vx != limits.max_speed
    assert out.vz != limits.max_climb_rate


def test_a_non_numeric_axis_is_treated_like_a_non_finite_one():
    out = clamp_body_velocity(
        VelocitySetpoint(vx="fast", vy=0.0, vz=0.0, yaw_rate=0.0, valid=True),
        Limits(),
    )
    assert out.valid is False
    assert out.vx == 0.0


@pytest.mark.parametrize("bad", NON_FINITE)
def test_an_unusable_LIMIT_bounds_its_axis_at_zero(bad):
    """A limit we cannot read means "no motion", not "any motion"."""
    out = clamp_body_velocity(
        VelocitySetpoint(vx=5.0, vy=5.0, vz=5.0, yaw_rate=50.0, valid=True),
        Limits(max_speed=bad, max_climb_rate=1.5, max_yaw_rate=45.0),
    )
    assert out.vx == 0.0
    assert out.vy == 0.0
    # ...and the axes whose limits ARE readable still work normally.
    assert out.vz == pytest.approx(1.5)
    assert out.yaw_rate == pytest.approx(45.0)


def test_a_negative_limit_is_read_as_its_magnitude():
    out = clamp_body_velocity(
        VelocitySetpoint(vx=9.0, vy=0.0, vz=0.0, yaw_rate=0.0, valid=True),
        Limits(max_speed=-3.0),
    )
    assert out.vx == pytest.approx(3.0)


# ==========================================================================
# The goto path: speed and altitude bands
# ==========================================================================
def test_leg_speed_is_folded_into_the_speed_band():
    limits = Limits(max_speed=8.0, min_speed=0.5)
    assert clamp_speed_for_fc(12.0, limits) == pytest.approx(8.0)
    assert clamp_speed_for_fc(6.0, limits) == pytest.approx(6.0)
    assert clamp_speed_for_fc(-4.0, limits) == 0.0


def test_leg_speed_is_not_floored_at_min_speed():
    """``min_speed`` is a guidance-usability floor, not a goto floor.

    Applying it here would turn a profile the config floor degraded to 0.0
    ("no motion, safe direction") into real motion at ``min_speed``.
    """
    limits = Limits(max_speed=8.0, min_speed=0.5)
    assert clamp_speed_for_fc(0.3, limits) == pytest.approx(0.3)
    assert clamp_speed_for_fc(0.0, limits) == 0.0


@pytest.mark.parametrize("bad", NON_FINITE)
def test_a_non_finite_leg_speed_becomes_zero_not_the_maximum(bad):
    assert clamp_speed_for_fc(bad, Limits(max_speed=8.0)) == 0.0


def test_target_altitude_is_folded_into_the_altitude_band():
    limits = Limits(max_altitude=30.0)
    assert clamp_altitude_for_fc(120.0, limits) == pytest.approx(30.0)
    assert clamp_altitude_for_fc(-5.0, limits) == 0.0
    assert clamp_altitude_for_fc(12.0, limits) == pytest.approx(12.0)


@pytest.mark.parametrize("bad", NON_FINITE)
def test_a_non_finite_altitude_becomes_zero_not_the_ceiling(bad):
    assert clamp_altitude_for_fc(bad, Limits(max_altitude=30.0)) == 0.0


def test_clamp_goto_target_returns_the_pair_ready_for_the_wire():
    speed, alt = clamp_goto_target(12.0, 120.0, Limits(max_speed=8.0, max_altitude=30.0))
    assert (speed, alt) == (pytest.approx(8.0), pytest.approx(30.0))


# ==========================================================================
# ...and it is the CLAMPED values that reach the wire
# ==========================================================================
def test_send_body_velocity_puts_the_clamped_axes_on_the_wire():
    v = make_vehicle(Limits(max_speed=2.0, max_climb_rate=1.5, max_yaw_rate=45.0))
    v.send_body_velocity(99.0, -99.0, 99.0, 999.0)

    frame = velocity_frames(v)[0]
    assert frame[3] == mav.MAV_FRAME_BODY_NED
    assert frame[4] == VEL_YAWRATE_TYPEMASK
    vx, vy, vz, yaw_rad = commanded(frame)
    assert (vx, vy, vz) == (pytest.approx(2.0), pytest.approx(-2.0), pytest.approx(1.5))
    # yaw_rate crosses the seam in RADIANS per second, not degrees.
    assert yaw_rad == pytest.approx(math.radians(45.0))


def test_the_setpoint_object_call_form_is_clamped_the_same_way():
    v = make_vehicle(Limits(max_speed=2.0))
    v.send_body_velocity(
        VelocitySetpoint(vx=99.0, vy=0.0, vz=0.0, yaw_rate=0.0, valid=True)
    )
    assert commanded(velocity_frames(v)[0])[0] == pytest.approx(2.0)


@pytest.mark.parametrize("axis", AXES)
def test_a_nan_axis_reaches_the_flight_controller_as_a_zero_hold(axis):
    """The whole point: one hostile number must not become a maximum command."""
    v = make_vehicle(Limits(max_speed=2.0, max_climb_rate=1.5, max_yaw_rate=45.0))
    values = {"vx": 1.0, "vy": 1.0, "vz": 1.0, "yaw_rate": 10.0}
    values[axis] = float("nan")
    v.send_body_velocity(**values)

    frames = velocity_frames(v)
    assert len(frames) == 1, "the hold frame is still SENT, not skipped"
    assert commanded(frames[0]) == (0.0, 0.0, 0.0, 0.0)


def test_an_invalid_setpoint_is_still_transmitted_as_zeros():
    """ArduPilot GUIDED holds actively while zeros keep arriving, and coasts
    on the last target when the stream stops -- so a hold must be SENT."""
    v = make_vehicle()
    v.send_body_velocity(1.0, 1.0, 1.0, 10.0, valid=False)
    assert commanded(velocity_frames(v)[0]) == (0.0, 0.0, 0.0, 0.0)

    v.hold()
    assert len(velocity_frames(v)) == 2


def test_nothing_is_sent_without_a_link():
    v = make_vehicle()
    v._connected = False
    v.send_body_velocity(1.0, 0.0, 0.0, 0.0)
    assert velocity_frames(v) == []


def test_a_send_that_raises_falls_back_to_one_zero_hold_frame():
    v = make_vehicle(Limits(max_speed=2.0))
    calls: list = []

    def _explode_once(*args):
        calls.append(args)
        if len(calls) == 1:
            raise OSError("radio buffer full")

    v._master.mav.set_position_target_local_ned_send = _explode_once
    v.send_body_velocity(1.0, 1.0, 1.0, 10.0)

    assert len(calls) == 2, "the failed frame is retried as a hold"
    assert (calls[1][8], calls[1][9], calls[1][10], calls[1][15]) == (0.0,) * 4


def test_the_vehicle_clamps_to_the_envelope_it_was_last_given():
    v = make_vehicle(Limits(max_speed=8.0))
    v.update_limits(Limits(max_speed=1.0))
    v.send_body_velocity(5.0, 0.0, 0.0, 0.0)
    assert commanded(velocity_frames(v)[0])[0] == pytest.approx(1.0)


@pytest.mark.parametrize("bad", NON_FINITE)
def test_goto_global_refuses_a_leg_whose_speed_clamps_to_zero(bad):
    """ArduPilot DENIES a non-positive DO_CHANGE_SPEED, so a "correct" zero on
    the wire would fly the leg at the FC's previous guided speed. Refuse."""
    v = make_vehicle(Limits(max_speed=8.0))
    assert v.goto_global(-35.36, 149.16, 10.0, bad) is False
    assert v._master.sent == []


@pytest.mark.parametrize("bad", NON_FINITE)
def test_goto_global_sends_a_non_finite_altitude_as_zero(bad):
    v = make_vehicle(Limits(max_speed=8.0, max_altitude=30.0))
    assert v.goto_global(-35.36, 149.16, bad, 4.0) is True
    target = [args for name, args in v._master.sent
              if name == "set_position_target_global_int"][0]
    assert target[7] == 0.0
