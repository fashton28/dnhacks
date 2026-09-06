"""
Guidance behaviour -- the safety-critical visual-servoing core (PRD 11).

Pinned here:
  * the standoff is never breached while the range converges onto it, from
    any starting distance (the headline acceptance gate),
  * approach when far, rest at the standoff, back off inside it, and never
    approach on an unknown range,
  * any non-locked state, or a lock without a box, yields a hold,
  * every emitted axis stays inside the configured Limits,
  * the yaw and climb channels servo the target back toward frame centre,
  * the tuning hooks respect the Limits floors and retune live.

numpy + stdlib only (no hardware, no FC).
"""
from __future__ import annotations

from typing import Iterator, Tuple

import pytest

from eis_companion.control.guidance import Guidance
from eis_companion.types import Limits, TrackingState

DT = 0.1


def centred_box(height: float = 0.2) -> Tuple[float, float, float, float]:
    """A box of the given normalised height sitting on the frame centre."""
    width = 0.4 * height
    return (0.5 - width / 2.0, 0.5 - height / 2.0, width, height)


@pytest.fixture
def limits() -> Limits:
    return Limits(
        max_speed=2.0,
        min_speed=0.5,
        max_climb_rate=1.5,
        max_yaw_rate=45.0,
        standoff=5.0,
        min_standoff=3.0,
    )


def closed_loop(guidance: Guidance, limits: Limits, start: float, ticks: int) -> Iterator[float]:
    """Integrate the forward command one-to-one into the range; yield it each tick."""
    distance = start
    for _ in range(ticks):
        sp = guidance.update(TrackingState.LOCKED, centred_box(), distance, limits, dt=DT)
        distance -= sp.vx * DT
        yield distance


def last_of(guidance: Guidance, limits: Limits, distance, ticks: int):
    sp = None
    for _ in range(ticks):
        sp = guidance.update(TrackingState.LOCKED, centred_box(), distance, limits, dt=DT)
    return sp


# --------------------------------------------------------------------------
# HARD STANDOFF -- the primary acceptance gate
# --------------------------------------------------------------------------
@pytest.mark.parametrize("start", [20.0, 12.0, 8.0, 6.0, 5.5])
def test_standoff_holds_from_any_start(limits, start):
    """The range must converge onto the standoff and never dip below it."""
    guidance = Guidance()
    guidance.reset()
    closest = start
    distance = start
    for distance in closed_loop(guidance, limits, start, ticks=600):
        closest = min(closest, distance)
        assert distance >= limits.standoff - 1e-6, f"standoff breached from {start}: {distance}"
    assert abs(distance - limits.standoff) < 0.1, f"did not settle on the standoff: {distance}"
    assert closest >= limits.standoff - 1e-6


def test_forward_command_is_positive_when_far(limits):
    sp = last_of(Guidance(), limits, 15.0, ticks=10)
    assert sp.vx > 0.0
    assert sp.valid is True


def test_forward_command_rests_at_the_standoff(limits):
    sp = last_of(Guidance(), limits, limits.standoff, ticks=50)
    assert sp.vx <= 1e-6


def test_backs_off_inside_the_standoff(limits):
    sp = last_of(Guidance(), limits, 3.0, ticks=20)
    assert sp.vx <= 0.0


def test_unknown_range_never_approaches(limits):
    guidance = Guidance()
    for _ in range(50):
        sp = guidance.update(TrackingState.LOCKED, centred_box(), None, limits, dt=DT)
        assert sp.vx <= 0.0


# --------------------------------------------------------------------------
# HOLD without a lock
# --------------------------------------------------------------------------
@pytest.mark.parametrize("state", ["lost", "searching", "idle"])
def test_non_locked_state_holds(limits, state):
    sp = Guidance().update(state, None, 10.0, limits, dt=DT)
    assert sp.valid is False
    assert (sp.vx, sp.vy, sp.vz, sp.yaw_rate) == (0.0, 0.0, 0.0, 0.0)


def test_locked_without_a_box_holds(limits):
    sp = Guidance().update(TrackingState.LOCKED, None, 10.0, limits, dt=DT)
    assert sp.valid is False
    assert sp.vx == 0.0


# --------------------------------------------------------------------------
# Clamping to Limits
# --------------------------------------------------------------------------
def test_every_axis_stays_inside_limits(limits):
    """Target far to the side, high in frame and far away: every axis clamps."""
    guidance = Guidance()
    extreme = (0.9, 0.05, 0.05, 0.05)
    for _ in range(200):
        sp = guidance.update(TrackingState.LOCKED, extreme, 50.0, limits, dt=DT)
        assert -limits.max_speed - 1e-9 <= sp.vx <= limits.max_speed + 1e-9
        assert -limits.max_climb_rate - 1e-9 <= sp.vz <= limits.max_climb_rate + 1e-9
        assert -limits.max_yaw_rate - 1e-9 <= sp.yaw_rate <= limits.max_yaw_rate + 1e-9


# --------------------------------------------------------------------------
# Servo signs
# --------------------------------------------------------------------------
def test_target_right_of_centre_turns_right(limits):
    right = (0.8, 0.45, 0.1, 0.1)      # cx = 0.85
    sp = Guidance().update(TrackingState.LOCKED, right, limits.standoff, limits, dt=DT)
    assert sp.yaw_rate > 0.0


def test_target_above_centre_climbs(limits):
    high = (0.45, 0.1, 0.1, 0.1)       # cy = 0.15 -> climb -> NED up -> vz < 0
    sp = Guidance().update(TrackingState.LOCKED, high, limits.standoff, limits, dt=DT)
    assert sp.vz < 0.0


# --------------------------------------------------------------------------
# Tuning hooks
# --------------------------------------------------------------------------
def test_set_standoff_cannot_go_below_the_floor(limits):
    Guidance().set_standoff(1.0, limits)          # below min_standoff = 3
    assert limits.standoff == limits.min_standoff


def test_set_max_speed_cannot_go_below_min_speed(limits):
    Guidance().set_max_speed(0.1, limits)         # below min_speed = 0.5
    assert limits.max_speed == limits.min_speed


def test_higher_yaw_gain_gives_a_larger_first_response(limits):
    box = (0.7, 0.45, 0.1, 0.1)
    soft = Guidance(yaw_gains=(10.0, 0.0, 0.0), smoothing=1.0)
    stiff = Guidance(yaw_gains=(10.0, 0.0, 0.0), smoothing=1.0)
    stiff.set_gains(yaw=(80.0, 0.0, 0.0))
    lo = soft.update(TrackingState.LOCKED, box, limits.standoff, limits, dt=DT)
    hi = stiff.update(TrackingState.LOCKED, box, limits.standoff, limits, dt=DT)
    assert abs(hi.yaw_rate) > abs(lo.yaw_rate)
