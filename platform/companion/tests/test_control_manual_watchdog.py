"""
Manual pilot: deadman zero-and-hold, frame admission, mapping, deadzone.

The orchestrator path is ``set_input`` (high-rate, fire-and-forget) plus
``update`` (per control tick). Only an admitted stick frame refreshes the
deadman; ``update`` replays the stored frame but never extends the window.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from eis_companion.control.manual import ManualPilot, _clamp01
from eis_companion.types import Limits, VelocitySetpoint

NON_FINITE = [float("nan"), float("inf"), float("-inf")]
AXES = ["throttle", "yaw", "pitch", "roll"]


class StepClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def tick(self, seconds: float) -> None:
        self.now += seconds


def stick(**axes) -> SimpleNamespace:
    frame = {"throttle": 0.0, "yaw": 0.0, "pitch": 0.0, "roll": 0.0}
    frame.update(axes)
    return SimpleNamespace(**frame)


def is_hold(sp: VelocitySetpoint) -> bool:
    return sp.valid is False and (sp.vx, sp.vy, sp.vz, sp.yaw_rate) == (0.0, 0.0, 0.0, 0.0)


@pytest.fixture
def clock() -> StepClock:
    return StepClock()


@pytest.fixture
def lim() -> Limits:
    return Limits(max_speed=2.0, min_speed=0.5, max_climb_rate=1.5, max_yaw_rate=45.0,
                  deadzone=0.09, manual_watchdog_ms=500)


# --------------------------------------------------------------------------
# Deadman through the orchestrator path
# --------------------------------------------------------------------------
def test_update_does_not_extend_the_window(clock, lim):
    pilot = ManualPilot(smoothing=1.0, clock=clock)
    assert pilot.set_input(pitch=1.0) is True
    assert pilot.update(lim, 0.05).vx == pytest.approx(lim.max_speed)
    for _ in range(12):                       # 0.6 s of ticks, no new frame
        clock.tick(0.05)
        pilot.update(lim, 0.05)
    assert is_hold(pilot.update(lim, 0.05))


def test_a_new_frame_inside_the_window_keeps_it_live(clock, lim):
    pilot = ManualPilot(smoothing=1.0, clock=clock)
    pilot.set_input(pitch=1.0)
    for _ in range(20):                       # 1.0 s, refreshed every 50 ms
        clock.tick(0.05)
        pilot.set_input(pitch=1.0)
        assert pilot.update(lim, 0.05).valid is True


def test_update_replays_the_stored_frame_and_smooths_toward_it(clock, lim):
    pilot = ManualPilot(smoothing=0.5, clock=clock)
    pilot.set_input(pitch=1.0)
    previous = 0.0
    for _ in range(6):
        vx = pilot.update(lim, 0.05).vx
        assert previous < vx <= lim.max_speed
        previous = vx
    assert previous == pytest.approx(lim.max_speed * (1 - 0.5 ** 6))


def test_a_fresh_frame_after_expiry_ramps_from_zero(clock, lim):
    pilot = ManualPilot(smoothing=0.5, clock=clock)
    pilot.set_input(pitch=1.0)
    for _ in range(12):
        pilot.update(lim, 0.05)
    clock.tick(0.6)
    assert is_hold(pilot.update(lim, 0.05))
    pilot.set_input(pitch=1.0)
    assert pilot.update(lim, 0.05).vx == pytest.approx(0.5 * lim.max_speed)


def test_link_loss_drops_the_smoothing_memory(clock, lim):
    pilot = ManualPilot(smoothing=0.5, clock=clock)
    pilot.set_input(pitch=1.0)
    for _ in range(12):
        pilot.update(lim, 0.05)
    assert is_hold(pilot.update(lim, 0.05, link_ok=False))
    assert pilot.update(lim, 0.05).vx == pytest.approx(0.5 * lim.max_speed)


def test_reset_forgets_the_stored_frame(clock, lim):
    pilot = ManualPilot(smoothing=1.0, clock=clock)
    pilot.set_input(pitch=1.0)
    pilot.reset()
    assert pilot.engaged is False
    pilot.engage()
    assert is_hold(pilot.update(lim, 0.05))     # nothing to replay


def test_set_input_engages_on_the_first_frame(clock, lim):
    pilot = ManualPilot(clock=clock)
    assert pilot.engaged is False
    pilot.set_input(roll=0.5)
    assert pilot.engaged is True


# --------------------------------------------------------------------------
# Frame admission
# --------------------------------------------------------------------------
@pytest.mark.parametrize("axis", AXES)
@pytest.mark.parametrize("bad", NON_FINITE)
def test_a_non_finite_axis_rejects_the_frame_and_does_not_refresh(clock, lim, axis, bad):
    pilot = ManualPilot(smoothing=1.0, clock=clock)
    pilot.set_input(pitch=1.0)
    clock.tick(0.4)
    assert pilot.set_input(**{axis: bad}) is False
    assert pilot.update(lim, 0.05).vx == pytest.approx(lim.max_speed)   # old frame, in window
    clock.tick(0.2)                                                       # 0.6 s since the good one
    assert is_hold(pilot.update(lim, 0.05))


def test_feed_rejects_a_non_finite_frame_whole_without_refresh(clock, lim):
    pilot = ManualPilot(smoothing=1.0, clock=clock)
    pilot.engage()
    live = pilot.feed(stick(pitch=1.0), lim, 0.05)
    clock.tick(0.4)
    replay = pilot.feed(stick(pitch=float("nan"), roll=1.0), lim, 0.05)
    assert replay == live                            # not applied, not centred
    clock.tick(0.2)
    assert is_hold(pilot.feed(None, lim, 0.05))


def test_feed_rejects_an_object_missing_an_axis(clock, lim):
    pilot = ManualPilot(smoothing=1.0, clock=clock)
    pilot.engage()
    assert is_hold(pilot.feed(SimpleNamespace(pitch=1.0), lim, 0.05))


@pytest.mark.parametrize("value, expected", [(2.0, 1.0), (-3.0, -1.0), (0.25, 0.25), (-1.0, -1.0),
                                             (float("nan"), 0.0), (float("inf"), 0.0), ("x", 0.0), (None, 0.0)])
def test_clamp01_saturates_and_centres_garbage(value, expected):
    assert _clamp01(value) == expected


# --------------------------------------------------------------------------
# Mapping
# --------------------------------------------------------------------------
def test_negative_deflection_signs(clock, lim):
    pilot = ManualPilot(smoothing=1.0, clock=clock)
    pilot.engage()
    sp = pilot.feed(stick(throttle=-1, yaw=-1, pitch=-1, roll=-1), lim, 0.05)
    assert sp.vz == pytest.approx(+lim.max_climb_rate)     # descend = NED down
    assert sp.yaw_rate == pytest.approx(-lim.max_yaw_rate)
    assert sp.vx == pytest.approx(-lim.max_speed)
    assert sp.vy == pytest.approx(-lim.max_speed)


def test_each_stick_drives_exactly_one_body_axis(clock, lim):
    pilot = ManualPilot(smoothing=1.0, clock=clock)
    pilot.engage()
    for axis, field in zip(AXES, ("vz", "yaw_rate", "vx", "vy")):
        sp = pilot.feed(stick(**{axis: 1.0}), lim, 0.05)
        others = {f: getattr(sp, f) for f in ("vx", "vy", "vz", "yaw_rate") if f != field}
        assert getattr(sp, field) != 0.0
        assert all(v == 0.0 for v in others.values()), others


def test_rescaled_limits_rescale_the_output(clock):
    pilot = ManualPilot(smoothing=1.0, clock=clock)
    pilot.engage()
    tight = Limits(max_speed=0.5, max_climb_rate=0.2, max_yaw_rate=10.0, deadzone=0.0)
    sp = pilot.feed(stick(throttle=0.5, yaw=0.5, pitch=0.5, roll=0.5), tight, 0.05)
    assert (sp.vx, sp.vy, sp.vz, sp.yaw_rate) == pytest.approx((0.25, 0.25, -0.1, 5.0))


# --------------------------------------------------------------------------
# Deadzone
# --------------------------------------------------------------------------
def test_deadzone_edge_is_continuous(clock, lim):
    pilot = ManualPilot(smoothing=1.0, clock=clock)
    pilot.engage()
    at_edge = pilot.feed(stick(pitch=0.09), lim, 0.05).vx
    just_past = pilot.feed(stick(pitch=0.0901), lim, 0.05).vx
    further = pilot.feed(stick(pitch=0.20), lim, 0.05).vx
    assert at_edge == 0.0
    assert 0.0 < just_past < 0.01
    assert just_past < further < lim.max_speed


def test_zero_deadzone_is_passthrough(clock):
    pilot = ManualPilot(smoothing=1.0, clock=clock)
    pilot.engage()
    lim = Limits(max_speed=2.0, deadzone=0.0)
    assert pilot.feed(stick(pitch=0.05), lim, 0.05).vx == pytest.approx(0.1)


def test_full_deflection_still_reaches_the_limit_past_the_deadzone(clock, lim):
    pilot = ManualPilot(smoothing=1.0, clock=clock)
    pilot.engage()
    assert pilot.feed(stick(pitch=1.0), lim, 0.05).vx == pytest.approx(lim.max_speed)


@pytest.mark.parametrize("dz", [1.0, 1.5, float("nan")])
def test_a_deadzone_that_swallows_the_travel_reads_centred(clock, dz):
    pilot = ManualPilot(smoothing=1.0, clock=clock)
    pilot.engage()
    lim = Limits(deadzone=dz)
    sp = pilot.feed(stick(throttle=1, yaw=1, pitch=1, roll=1), lim, 0.05)
    assert (sp.vx, sp.vy, sp.vz, sp.yaw_rate) == (0.0, 0.0, 0.0, 0.0)
