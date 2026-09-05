"""
Guidance tests -- the safety-critical visual-servoing core.

Proves (PRD 11):
  * standoff is NEVER breached as distance converges (the headline gate),
  * the drone approaches when far and holds at the standoff,
  * unknown distance never commands forward motion,
  * 'lost'/no-lock returns a hold (zero, valid=False),
  * every output stays inside the configured Limits,
  * yaw / climb signs servo the target back toward frame centre.

numpy + stdlib only (no hardware, no FC).
"""
from __future__ import annotations

import math

import pytest

from eis_companion.control.guidance import Guidance
from eis_companion.types import Limits, TrackingState, VelocitySetpoint


def _centered_bbox(h: float = 0.2) -> tuple:
    """A bbox centred in the frame with the given (normalised) height."""
    w = h * 0.4
    return (0.5 - w / 2.0, 0.5 - h / 2.0, w, h)


def _limits() -> Limits:
    return Limits(
        max_speed=2.0,
        min_speed=0.5,
        max_climb_rate=1.5,
        max_yaw_rate=45.0,
        standoff=5.0,
        min_standoff=3.0,
    )


# --------------------------------------------------------------------------
# HARD STANDOFF -- the primary acceptance gate
# --------------------------------------------------------------------------
def test_standoff_never_breached_during_convergence():
    """Simulate closed-loop approach; distance must converge to standoff and
    never dip below it, no matter the starting distance."""
    g = Guidance()
    lim = _limits()
    bbox = _centered_bbox()

    for start in (20.0, 12.0, 8.0, 6.0, 5.5):
        g.reset()
        dist = start
        min_dist = dist
        for _ in range(600):
            sp = g.update(TrackingState.LOCKED, bbox, dist, lim, dt=0.1)
            # one-to-one kinematic integration of the forward command
            dist -= sp.vx * 0.1
            min_dist = min(min_dist, dist)
            # HARD invariant, checked every single tick
            assert dist >= lim.standoff - 1e-6, (
                f"standoff breached: start={start} dist={dist}"
            )
        # converged to the standoff (within a few cm)
        assert abs(dist - lim.standoff) < 0.1, f"did not hold standoff: {dist}"
        assert min_dist >= lim.standoff - 1e-6


def test_approaches_when_far():
    """When well beyond standoff the forward command is positive (approach)."""
    g = Guidance()
    lim = _limits()
    bbox = _centered_bbox()
    sp = None
    for _ in range(10):
        sp = g.update(TrackingState.LOCKED, bbox, 15.0, lim, dt=0.1)
    assert sp.vx > 0.0
    assert sp.valid is True


def test_holds_at_standoff():
    """At exactly the standoff the forward command settles to ~0 (no approach)."""
    g = Guidance()
    lim = _limits()
    bbox = _centered_bbox()
    sp = None
    for _ in range(50):
        sp = g.update(TrackingState.LOCKED, bbox, lim.standoff, lim, dt=0.1)
    assert sp.vx <= 1e-6  # never forward at the standoff


def test_backs_off_when_too_close():
    """Inside the standoff, back-off (vx<0) is allowed but never approach."""
    g = Guidance()
    lim = _limits()
    bbox = _centered_bbox()
    sp = None
    for _ in range(20):
        sp = g.update(TrackingState.LOCKED, bbox, 3.0, lim, dt=0.1)
    assert sp.vx <= 0.0


def test_unknown_distance_never_approaches():
    """est_distance=None must never produce forward motion."""
    g = Guidance()
    lim = _limits()
    bbox = _centered_bbox()
    for _ in range(50):
        sp = g.update(TrackingState.LOCKED, bbox, None, lim, dt=0.1)
        assert sp.vx <= 0.0


# --------------------------------------------------------------------------
# HOLD on lost / no lock
# --------------------------------------------------------------------------
@pytest.mark.parametrize("state", ["lost", "searching", "idle"])
def test_non_locked_states_hold(state):
    g = Guidance()
    lim = _limits()
    sp = g.update(state, None, 10.0, lim, dt=0.1)
    assert sp.valid is False
    assert (sp.vx, sp.vy, sp.vz, sp.yaw_rate) == (0.0, 0.0, 0.0, 0.0)


def test_lock_with_none_bbox_holds():
    g = Guidance()
    lim = _limits()
    sp = g.update(TrackingState.LOCKED, None, 10.0, lim, dt=0.1)
    assert sp.valid is False
    assert sp.vx == 0.0


# --------------------------------------------------------------------------
# Clamping to Limits
# --------------------------------------------------------------------------
def test_all_outputs_within_limits():
    """Drive large errors and confirm every axis stays clamped."""
    g = Guidance()
    lim = _limits()
    # target far to the side, high in frame, and very far away
    bbox = (0.9, 0.05, 0.05, 0.05)
    for _ in range(200):
        sp = g.update(TrackingState.LOCKED, bbox, 50.0, lim, dt=0.1)
        assert -lim.max_speed - 1e-9 <= sp.vx <= lim.max_speed + 1e-9
        assert -lim.max_climb_rate - 1e-9 <= sp.vz <= lim.max_climb_rate + 1e-9
        assert -lim.max_yaw_rate - 1e-9 <= sp.yaw_rate <= lim.max_yaw_rate + 1e-9


# --------------------------------------------------------------------------
# Servo signs
# --------------------------------------------------------------------------
def test_yaw_sign_target_right_turns_right():
    """Target right of centre (cx>0.5) -> yaw_rate>0 (turn clockwise/right)."""
    g = Guidance()
    lim = _limits()
    bbox = (0.8, 0.45, 0.1, 0.1)  # cx=0.85
    sp = g.update(TrackingState.LOCKED, bbox, lim.standoff, lim, dt=0.1)
    assert sp.yaw_rate > 0.0


def test_vz_sign_target_high_climbs():
    """Target high in frame (cy<0.5) -> climb -> vz<0 (NED up)."""
    g = Guidance()
    lim = _limits()
    bbox = (0.45, 0.1, 0.1, 0.1)  # cy=0.15
    sp = g.update(TrackingState.LOCKED, bbox, lim.standoff, lim, dt=0.1)
    assert sp.vz < 0.0


# --------------------------------------------------------------------------
# Tuning hooks
# --------------------------------------------------------------------------
def test_set_standoff_respects_floor():
    g = Guidance()
    lim = _limits()
    g.set_standoff(1.0, lim)  # below min_standoff=3
    assert lim.standoff == lim.min_standoff


def test_set_max_speed_respects_floor():
    g = Guidance()
    lim = _limits()
    g.set_max_speed(0.1, lim)  # below min_speed=0.5
    assert lim.max_speed == lim.min_speed


def test_set_gains_changes_response():
    """Higher yaw gain -> larger yaw command for the same error (first tick)."""
    lim = _limits()
    bbox = (0.7, 0.45, 0.1, 0.1)

    g_lo = Guidance(yaw_gains=(10.0, 0.0, 0.0), smoothing=1.0)
    g_hi = Guidance(yaw_gains=(10.0, 0.0, 0.0), smoothing=1.0)
    g_hi.set_gains(yaw=(80.0, 0.0, 0.0))

    lo = g_lo.update(TrackingState.LOCKED, bbox, lim.standoff, lim, dt=0.1)
    hi = g_hi.update(TrackingState.LOCKED, bbox, lim.standoff, lim, dt=0.1)
    assert abs(hi.yaw_rate) > abs(lo.yaw_rate)
