"""
Manual-piloting tests (PRD 11 manual-control safety).

Proves:
  * axis mapping + signs (throttle->vz climb, yaw->yaw_rate, pitch->vx, roll->vy),
  * every axis is clamped to the SAME limits as guidance,
  * deadzone suppresses small inputs,
  * the watchdog zeroes-and-holds after manual_watchdog_ms with no input,
  * a ground-link drop (deadman) zeroes-and-holds immediately,
  * release() reverts to a safe hold,
  * a disengaged pilot always emits hold.

A fake clock is injected so the watchdog is deterministic.
numpy + stdlib only.
"""
from __future__ import annotations

import pytest

from eis_companion.control.manual import ManualPilot
from eis_companion.types import Limits, VelocitySetpoint


class FakeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


class Stick:
    """Minimal ManualInput-shaped object."""
    def __init__(self, throttle=0.0, yaw=0.0, pitch=0.0, roll=0.0) -> None:
        self.throttle = throttle
        self.yaw = yaw
        self.pitch = pitch
        self.roll = roll


def _limits() -> Limits:
    return Limits(
        max_speed=2.0,
        min_speed=0.5,
        max_climb_rate=1.5,
        max_yaw_rate=45.0,
        deadzone=0.09,
        manual_watchdog_ms=500,
    )


def _settle(mp: ManualPilot, stick: Stick, lim: Limits, n: int = 20) -> VelocitySetpoint:
    sp = VelocitySetpoint.hold()
    for _ in range(n):
        sp = mp.feed(stick, lim, dt=0.05)
    return sp


# --------------------------------------------------------------------------
# Axis mapping + signs
# --------------------------------------------------------------------------
def test_full_deflection_hits_limits_no_smoothing():
    clk = FakeClock()
    mp = ManualPilot(smoothing=1.0, clock=clk)
    mp.engage()
    lim = _limits()
    sp = mp.feed(Stick(throttle=1, yaw=1, pitch=1, roll=1), lim, dt=0.05)
    assert sp.vx == pytest.approx(lim.max_speed)
    assert sp.vy == pytest.approx(lim.max_speed)
    assert sp.vz == pytest.approx(-lim.max_climb_rate)  # climb = up = NED negative
    assert sp.yaw_rate == pytest.approx(lim.max_yaw_rate)
    assert sp.valid is True


def test_throttle_up_climbs():
    clk = FakeClock()
    mp = ManualPilot(smoothing=1.0, clock=clk)
    mp.engage()
    lim = _limits()
    sp = mp.feed(Stick(throttle=1.0), lim, dt=0.05)
    assert sp.vz < 0.0  # NED up


def test_pitch_forward_positive_vx():
    clk = FakeClock()
    mp = ManualPilot(smoothing=1.0, clock=clk)
    mp.engage()
    lim = _limits()
    sp = mp.feed(Stick(pitch=1.0), lim, dt=0.05)
    assert sp.vx > 0.0


def test_roll_right_positive_vy():
    clk = FakeClock()
    mp = ManualPilot(smoothing=1.0, clock=clk)
    mp.engage()
    lim = _limits()
    sp = mp.feed(Stick(roll=1.0), lim, dt=0.05)
    assert sp.vy > 0.0


# --------------------------------------------------------------------------
# Clamping -- every axis within the SAME limits as guidance, even past 1.0
# --------------------------------------------------------------------------
def test_every_axis_within_limits_even_overdriven():
    clk = FakeClock()
    mp = ManualPilot(smoothing=1.0, clock=clk)
    mp.engage()
    lim = _limits()
    # overdrive beyond the legal -1..1 range; clamp must still hold
    sp = _settle(mp, Stick(throttle=5, yaw=-5, pitch=5, roll=-5), lim)
    assert abs(sp.vx) <= lim.max_speed + 1e-9
    assert abs(sp.vy) <= lim.max_speed + 1e-9
    assert abs(sp.vz) <= lim.max_climb_rate + 1e-9
    assert abs(sp.yaw_rate) <= lim.max_yaw_rate + 1e-9


# --------------------------------------------------------------------------
# Deadzone
# --------------------------------------------------------------------------
def test_deadzone_suppresses_small_input():
    clk = FakeClock()
    mp = ManualPilot(smoothing=1.0, clock=clk)
    mp.engage()
    lim = _limits()
    sp = mp.feed(Stick(throttle=0.05, yaw=0.05, pitch=0.05, roll=0.05), lim, dt=0.05)
    assert sp.vx == 0.0 and sp.vy == 0.0 and sp.vz == 0.0 and sp.yaw_rate == 0.0


def test_deadzone_continuous_past_threshold():
    """Just past the deadzone the output is small but nonzero (no jump)."""
    clk = FakeClock()
    mp = ManualPilot(smoothing=1.0, clock=clk)
    mp.engage()
    lim = _limits()
    sp = mp.feed(Stick(pitch=0.10), lim, dt=0.05)  # 0.10 > 0.09
    assert 0.0 < sp.vx < lim.max_speed * 0.2


# --------------------------------------------------------------------------
# Watchdog (input timeout) -- the headline manual-safety gate
# --------------------------------------------------------------------------
def test_watchdog_zeroes_and_holds_after_timeout():
    clk = FakeClock()
    mp = ManualPilot(smoothing=1.0, clock=clk)
    mp.engage()
    lim = _limits()

    # active input -> live command
    sp = mp.feed(Stick(pitch=1.0), lim, dt=0.05)
    assert sp.vx > 0.0 and sp.valid is True

    # let the watchdog window elapse with no new frames
    clk.advance((lim.manual_watchdog_ms + 50) / 1000.0)
    sp = mp.feed(None, lim, dt=0.05)
    assert sp.valid is False
    assert (sp.vx, sp.vy, sp.vz, sp.yaw_rate) == (0.0, 0.0, 0.0, 0.0)


def test_within_window_holds_last_then_trips():
    clk = FakeClock()
    mp = ManualPilot(smoothing=1.0, clock=clk)
    mp.engage()
    lim = _limits()
    mp.feed(Stick(pitch=1.0), lim, dt=0.05)

    # 0.3s < 0.5s window: still valid (no new frame, inside window)
    clk.advance(0.3)
    sp = mp.feed(None, lim, dt=0.05)
    assert sp.valid is True

    # now cross the threshold
    clk.advance(0.3)  # total 0.6s > 0.5s
    sp = mp.feed(None, lim, dt=0.05)
    assert sp.valid is False
    assert sp.vx == 0.0


# --------------------------------------------------------------------------
# Deadman -- link loss
# --------------------------------------------------------------------------
def test_link_loss_holds_immediately():
    clk = FakeClock()
    mp = ManualPilot(smoothing=1.0, clock=clk)
    mp.engage()
    lim = _limits()
    sp = mp.feed(Stick(pitch=1.0), lim, dt=0.05, link_ok=False)
    assert sp.valid is False
    assert sp.vx == 0.0


# --------------------------------------------------------------------------
# Engage / release lifecycle
# --------------------------------------------------------------------------
def test_disengaged_always_holds():
    clk = FakeClock()
    mp = ManualPilot(smoothing=1.0, clock=clk)
    lim = _limits()
    sp = mp.feed(Stick(pitch=1.0), lim, dt=0.05)
    assert sp.valid is False
    assert mp.engaged is False


def test_release_reverts_to_hold():
    clk = FakeClock()
    mp = ManualPilot(smoothing=1.0, clock=clk)
    mp.engage()
    lim = _limits()
    mp.feed(Stick(pitch=1.0), lim, dt=0.05)
    hold = mp.release()
    assert hold.valid is False
    assert (hold.vx, hold.vy, hold.vz, hold.yaw_rate) == (0.0, 0.0, 0.0, 0.0)
    assert mp.engaged is False
    # subsequent feeds keep holding while disengaged
    sp = mp.feed(Stick(pitch=1.0), lim, dt=0.05)
    assert sp.valid is False


def test_engage_resets_watchdog():
    """Re-engaging starts a fresh watchdog window so the first frame is live."""
    clk = FakeClock()
    mp = ManualPilot(smoothing=1.0, clock=clk)
    lim = _limits()
    clk.advance(10.0)  # lots of time passes before engage
    mp.engage()
    sp = mp.feed(Stick(pitch=1.0), lim, dt=0.05)
    assert sp.valid is True
    assert sp.vx > 0.0
