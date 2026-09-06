"""
The standoff hard floor and the Limits clamp stage (PRD 11).

  * ``Limits`` floors the standoff at 3 m and bands the speed,
  * ``Guidance.set_standoff`` cannot undercut the floor, whatever is asked,
  * no forward command at or inside ANY standoff, on any tick, including the
    tick a range drops out or jumps inside mid-approach (no smoothing leak),
  * every axis is clamped even under absurd or non-finite gains / limits.
"""
from __future__ import annotations

import math

import pytest

from eis_companion.control.guidance import Guidance
from eis_companion.types import Limits, TrackingState

LOCKED = TrackingState.LOCKED
BOX = (0.45, 0.40, 0.10, 0.20)
DT = 0.1


def limits(**overrides) -> Limits:
    base = dict(max_speed=2.0, min_speed=0.5, max_climb_rate=1.5, max_yaw_rate=45.0,
                standoff=5.0, min_standoff=3.0)
    base.update(overrides)
    return Limits(**base)


# --------------------------------------------------------------------------
# Limits
# --------------------------------------------------------------------------
def test_default_floor_is_three_metres():
    assert Limits().min_standoff == 3.0


@pytest.mark.parametrize("asked, expected", [(0.0, 3.0), (-5.0, 3.0), (2.999, 3.0), (3.0, 3.0),
                                             (7.5, 7.5), (50.0, 50.0), (1e9, 50.0)])
def test_clamp_standoff_is_closed_at_both_ends(asked, expected):
    assert Limits().clamp_standoff(asked) == expected


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf"), "far", None])
def test_clamp_standoff_keeps_the_current_value_for_garbage(bad):
    lim = Limits(standoff=6.0)
    assert lim.clamp_standoff(bad) == 6.0


@pytest.mark.parametrize("asked, expected", [(0.0, 0.5), (0.5, 0.5), (1.2, 1.2), (2.0, 2.0), (9.0, 2.0)])
def test_clamp_speed_band(asked, expected):
    assert limits().clamp_speed(asked) == expected


# --------------------------------------------------------------------------
# set_standoff through guidance
# --------------------------------------------------------------------------
@pytest.mark.parametrize("asked", [-5.0, 0.0, 1.0, 2.999, float("nan"), float("-inf")])
def test_set_standoff_never_undercuts_the_floor(asked):
    lim = limits()
    applied = Guidance().set_standoff(asked, lim)
    assert applied == lim.standoff
    assert lim.standoff >= lim.min_standoff


def test_set_standoff_returns_what_it_applied():
    lim = limits()
    assert Guidance().set_standoff(8.0, lim) == 8.0 == lim.standoff


def test_set_max_speed_floors_at_min_speed_and_ignores_garbage():
    lim = limits()
    g = Guidance()
    assert g.set_max_speed(0.0, lim) == lim.min_speed
    assert g.set_max_speed(1.7, lim) == 1.7
    assert g.set_max_speed(float("nan"), lim) == 1.7     # unchanged


# --------------------------------------------------------------------------
# The floor in the loop
# --------------------------------------------------------------------------
@pytest.mark.parametrize("standoff", [3.0, 5.0, 10.0, 50.0])
@pytest.mark.parametrize("offset", [-2.0, -0.01, 0.0])
def test_no_forward_command_at_or_inside_any_standoff(standoff, offset):
    lim = limits(standoff=standoff)
    g = Guidance()
    for _ in range(30):
        sp = g.update(LOCKED, BOX, standoff + offset, lim, DT)
        assert sp.vx <= 0.0


@pytest.mark.parametrize("distance", [5.5, 6.0, 8.0, 20.0, 100.0])
def test_forward_command_beyond_the_standoff_is_positive_and_bounded(distance):
    lim = limits()
    g = Guidance()
    sp = None
    for _ in range(10):
        sp = g.update(LOCKED, BOX, distance, lim, DT)
    assert 0.0 < sp.vx <= lim.max_speed


def test_range_dropout_mid_approach_cuts_forward_motion_on_that_tick():
    lim = limits()
    g = Guidance()
    for _ in range(20):
        assert g.update(LOCKED, BOX, 15.0, lim, DT).vx > 0.0
    assert g.update(LOCKED, BOX, None, lim, DT).vx <= 0.0


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_range_mid_approach_cuts_forward_motion_on_that_tick(bad):
    lim = limits()
    g = Guidance()
    for _ in range(20):
        g.update(LOCKED, BOX, 15.0, lim, DT)
    sp = g.update(LOCKED, BOX, bad, lim, DT)
    assert math.isfinite(sp.vx) and sp.vx <= 0.0


def test_jump_inside_the_standoff_mid_approach_cuts_forward_motion_on_that_tick():
    lim = limits()
    g = Guidance()
    for _ in range(20):
        g.update(LOCKED, BOX, 15.0, lim, DT)
    assert g.update(LOCKED, BOX, lim.standoff, lim, DT).vx <= 0.0
    assert g.update(LOCKED, BOX, lim.standoff - 1.0, lim, DT).vx <= 0.0


def test_raising_the_standoff_under_an_approach_is_honoured_immediately():
    lim = limits()
    g = Guidance()
    for _ in range(20):
        g.update(LOCKED, BOX, 9.0, lim, DT)
    g.set_standoff(9.0, lim)
    assert g.update(LOCKED, BOX, 9.0, lim, DT).vx <= 0.0


def test_lock_loss_clears_the_smoothing_memory():
    lim = limits()
    g = Guidance()
    for _ in range(20):
        g.update(LOCKED, BOX, 15.0, lim, DT)
    assert g.update("lost", None, 15.0, lim, DT).valid is False
    relocked = g.update(LOCKED, BOX, lim.standoff, lim, DT)
    assert relocked.vx == 0.0        # nothing coasted through the hold


# --------------------------------------------------------------------------
# Clamp stage
# --------------------------------------------------------------------------
def test_every_axis_is_clamped_under_absurd_gains():
    lim = limits()
    g = Guidance(yaw_gains=(1e6, 0.0, 0.0), vz_gains=(1e6, 0.0, 0.0),
                 vx_gains=(1e6, 0.0, 0.0), smoothing=1.0)
    sp = g.update(LOCKED, (0.9, 0.05, 0.05, 0.05), 80.0, lim, DT)
    assert sp.vx == pytest.approx(lim.max_speed)
    assert sp.vz == pytest.approx(-lim.max_climb_rate)
    assert sp.yaw_rate == pytest.approx(lim.max_yaw_rate)
    assert sp.vy == 0.0


@pytest.mark.parametrize("bad", [float("nan"), float("inf")])
def test_non_finite_gains_cannot_leak_into_the_setpoint(bad):
    lim = limits()
    g = Guidance(yaw_gains=(bad, 0.0, 0.0), vz_gains=(bad, 0.0, 0.0), vx_gains=(bad, 0.0, 0.0))
    sp = g.update(LOCKED, (0.9, 0.05, 0.05, 0.05), 80.0, lim, DT)
    assert (sp.vx, sp.vz, sp.yaw_rate) == (0.0, 0.0, 0.0)


def test_non_finite_limit_grants_zero_authority_on_that_axis():
    lim = limits(max_yaw_rate=float("nan"))
    sp = Guidance(smoothing=1.0).update(LOCKED, (0.9, 0.45, 0.05, 0.1), 80.0, lim, DT)
    assert sp.yaw_rate == 0.0
    assert sp.vx > 0.0               # the other axes are unaffected


def test_vy_is_never_commanded_by_guidance():
    lim = limits()
    g = Guidance(smoothing=1.0)
    for distance in (2.0, 5.0, 40.0):
        assert g.update(LOCKED, (0.9, 0.05, 0.05, 0.05), distance, lim, DT).vy == 0.0
