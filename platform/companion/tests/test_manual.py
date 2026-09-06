"""
Manual-piloting behaviour (PRD 11 manual-control safety).

Pinned here:
  * axis mapping + signs: throttle -> vz (climb is NED up), yaw -> yaw_rate,
    pitch -> vx, roll -> vy,
  * every axis is bounded by the SAME Limits guidance uses, even overdriven,
  * the deadzone swallows small inputs and is continuous at its edge,
  * the input watchdog zeroes-and-holds once manual_watchdog_ms elapses,
  * a ground-link drop zeroes-and-holds immediately,
  * release() reverts to a safe hold and a disengaged pilot only ever holds,
  * engage() opens a fresh watchdog window.

The clock is injected so every timing assertion is deterministic.
numpy + stdlib only.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from eis_companion.control.manual import ManualPilot
from eis_companion.types import Limits, VelocitySetpoint


class StepClock:
    """A clock that only moves when the test says so."""

    def __init__(self, start: float = 0.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def tick(self, seconds: float) -> None:
        self.now += seconds


def stick(**axes) -> SimpleNamespace:
    """A ManualInput-shaped frame; unspecified axes are centred."""
    frame = {"throttle": 0.0, "yaw": 0.0, "pitch": 0.0, "roll": 0.0}
    frame.update(axes)
    return SimpleNamespace(**frame)


def is_hold(sp: VelocitySetpoint) -> bool:
    return sp.valid is False and (sp.vx, sp.vy, sp.vz, sp.yaw_rate) == (0.0, 0.0, 0.0, 0.0)


@pytest.fixture
def limits() -> Limits:
    return Limits(
        max_speed=2.0,
        min_speed=0.5,
        max_climb_rate=1.5,
        max_yaw_rate=45.0,
        deadzone=0.09,
        manual_watchdog_ms=500,
    )


@pytest.fixture
def clock() -> StepClock:
    return StepClock()


@pytest.fixture
def pilot(clock: StepClock) -> ManualPilot:
    """An engaged, unsmoothed pilot: what you feed is what you get."""
    p = ManualPilot(smoothing=1.0, clock=clock)
    p.engage()
    return p


# --------------------------------------------------------------------------
# Mapping + signs
# --------------------------------------------------------------------------
def test_full_deflection_lands_exactly_on_every_limit(pilot, limits):
    sp = pilot.feed(stick(throttle=1, yaw=1, pitch=1, roll=1), limits, dt=0.05)
    assert sp.valid is True
    assert sp.vx == pytest.approx(limits.max_speed)
    assert sp.vy == pytest.approx(limits.max_speed)
    assert sp.vz == pytest.approx(-limits.max_climb_rate)   # climb = NED up
    assert sp.yaw_rate == pytest.approx(limits.max_yaw_rate)


@pytest.mark.parametrize(
    "axis, field, sign",
    [
        ("throttle", "vz", -1.0),     # throttle up -> climb -> vz negative
        ("yaw", "yaw_rate", +1.0),    # yaw right -> clockwise
        ("pitch", "vx", +1.0),        # pitch forward -> forward
        ("roll", "vy", +1.0),         # roll right -> right
    ],
)
def test_axis_sign_convention(pilot, limits, axis, field, sign):
    sp = pilot.feed(stick(**{axis: 1.0}), limits, dt=0.05)
    assert sign * getattr(sp, field) > 0.0


# --------------------------------------------------------------------------
# Clamping -- the SAME limits as guidance, even past the legal range
# --------------------------------------------------------------------------
def test_overdriven_sticks_stay_inside_limits(pilot, limits):
    overdriven = stick(throttle=5, yaw=-5, pitch=5, roll=-5)
    sp = VelocitySetpoint.hold()
    for _ in range(20):
        sp = pilot.feed(overdriven, limits, dt=0.05)
    assert abs(sp.vx) <= limits.max_speed + 1e-9
    assert abs(sp.vy) <= limits.max_speed + 1e-9
    assert abs(sp.vz) <= limits.max_climb_rate + 1e-9
    assert abs(sp.yaw_rate) <= limits.max_yaw_rate + 1e-9


# --------------------------------------------------------------------------
# Deadzone
# --------------------------------------------------------------------------
def test_deadzone_swallows_small_deflection(pilot, limits):
    sp = pilot.feed(stick(throttle=0.05, yaw=0.05, pitch=0.05, roll=0.05), limits, dt=0.05)
    assert (sp.vx, sp.vy, sp.vz, sp.yaw_rate) == (0.0, 0.0, 0.0, 0.0)


def test_deadzone_is_continuous_at_its_edge(pilot, limits):
    """Just past the deadzone the command is small but present -- no jump."""
    sp = pilot.feed(stick(pitch=0.10), limits, dt=0.05)   # 0.10 > 0.09
    assert 0.0 < sp.vx < limits.max_speed * 0.2


# --------------------------------------------------------------------------
# Input watchdog -- the headline manual-safety gate
# --------------------------------------------------------------------------
def test_watchdog_expiry_zeroes_and_holds(pilot, limits, clock):
    live = pilot.feed(stick(pitch=1.0), limits, dt=0.05)
    assert live.valid is True and live.vx > 0.0

    clock.tick((limits.manual_watchdog_ms + 50) / 1000.0)
    assert is_hold(pilot.feed(None, limits, dt=0.05))


def test_inside_window_replays_then_trips(pilot, limits, clock):
    pilot.feed(stick(pitch=1.0), limits, dt=0.05)

    clock.tick(0.3)                     # 0.3 s < 0.5 s: still live
    assert pilot.feed(None, limits, dt=0.05).valid is True

    clock.tick(0.3)                     # 0.6 s > 0.5 s: tripped
    sp = pilot.feed(None, limits, dt=0.05)
    assert sp.valid is False
    assert sp.vx == 0.0


# --------------------------------------------------------------------------
# Deadman -- ground link
# --------------------------------------------------------------------------
def test_link_loss_holds_immediately(pilot, limits):
    sp = pilot.feed(stick(pitch=1.0), limits, dt=0.05, link_ok=False)
    assert sp.valid is False
    assert sp.vx == 0.0


# --------------------------------------------------------------------------
# Engage / release lifecycle
# --------------------------------------------------------------------------
def test_disengaged_pilot_only_holds(clock, limits):
    idle = ManualPilot(smoothing=1.0, clock=clock)
    sp = idle.feed(stick(pitch=1.0), limits, dt=0.05)
    assert sp.valid is False
    assert idle.engaged is False


def test_release_returns_hold_and_stays_disengaged(pilot, limits):
    pilot.feed(stick(pitch=1.0), limits, dt=0.05)
    assert is_hold(pilot.release())
    assert pilot.engaged is False
    assert pilot.feed(stick(pitch=1.0), limits, dt=0.05).valid is False


def test_engage_opens_a_fresh_window(clock, limits):
    """However long ago the pilot was built, engage() makes the first frame live."""
    p = ManualPilot(smoothing=1.0, clock=clock)
    clock.tick(10.0)
    p.engage()
    sp = p.feed(stick(pitch=1.0), limits, dt=0.05)
    assert sp.valid is True
    assert sp.vx > 0.0
