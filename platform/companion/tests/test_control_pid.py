"""
PID controller: output band, anti-windup, dt handling, refusal of bad samples.

The controller is a facade over a pure ``pid_step``; the step is tested
directly where the state matters, the facade where the API matters.
"""
from __future__ import annotations

import math

import pytest

from eis_companion.control.pid import PID, PIDGains, PIDState, pid_step

NON_FINITE = [float("nan"), float("inf"), float("-inf")]


# --------------------------------------------------------------------------
# Output band
# --------------------------------------------------------------------------
@pytest.mark.parametrize("error", [-1e6, -50.0, -1.0, 0.0, 0.7, 12.0, 1e6])
def test_output_never_leaves_the_band(error):
    pid = PID(kp=100.0, ki=10.0, kd=1.0, out_min=-2.0, out_max=3.0)
    for _ in range(5):
        assert -2.0 <= pid.update(error, 0.05) <= 3.0


def test_swapped_band_is_tolerated():
    pid = PID(kp=1.0, out_min=1.0, out_max=-1.0)
    assert pid.update(5.0, 0.1) == 1.0
    assert pid.update(-5.0, 0.1) == -1.0


def test_proportional_only_is_linear_in_the_error():
    pid = PID(kp=2.5)
    assert pid.update(2.0, 0.1) == pytest.approx(5.0)
    assert pid.update(-1.0, 0.1) == pytest.approx(-2.5)


# --------------------------------------------------------------------------
# Anti-windup
# --------------------------------------------------------------------------
def test_integrator_cannot_store_more_than_the_band_can_spend():
    pid = PID(kp=0.0, ki=1.0, kd=0.0, out_min=-1.0, out_max=1.0)
    for _ in range(100):
        assert pid.update(10.0, 0.1) == 1.0              # saturated high
    assert pid.state.integral == pytest.approx(1.0)      # exactly the band, not 100

    # The error reverses: a wound-up integrator would stay pinned at +1 for
    # ~99 steps. Tracking anti-windup answers on the very next step.
    assert pid.update(-10.0, 0.1) == pytest.approx(0.0)


def test_explicit_integral_limit_caps_the_sum():
    pid = PID(kp=0.0, ki=1.0, integral_limit=0.5)
    out = 0.0
    for _ in range(10):
        out = pid.update(1.0, 0.1)                         # would reach 1.0 uncapped
    assert out == pytest.approx(0.5)
    assert pid.state.integral == pytest.approx(0.5)


def test_integrator_is_idle_while_ki_is_zero():
    pid = PID(kp=1.0, ki=0.0)
    for _ in range(20):
        pid.update(3.0, 0.1)
    assert pid.state.integral == 0.0


# --------------------------------------------------------------------------
# dt handling
# --------------------------------------------------------------------------
def test_zero_dt_advances_nothing_but_remembers_the_sample():
    pid = PID(kp=1.0, ki=1.0, kd=1.0)
    pid.update(1.0, 0.1)                                  # integral = 0.1
    frozen = pid.update(2.0, 0.0)                         # no I advance, no D
    assert frozen == pytest.approx(2.0 + 0.1)
    assert pid.state.integral == pytest.approx(0.1)
    assert pid.state.prev_error == 2.0
    # the next real step differentiates against the remembered 2.0 -> D = 0,
    # and integrates once more: P 2.0 + I (0.1 + 0.2) + D 0
    assert pid.update(2.0, 0.1) == pytest.approx(2.0 + 0.3)


def test_negative_dt_is_no_time_elapsed():
    pid = PID(kp=1.0, ki=1.0, kd=1.0)
    pid.update(1.0, 0.1)
    assert pid.update(1.0, -0.5) == pytest.approx(1.0 + 0.1)
    assert pid.state.integral == pytest.approx(0.1)


def test_first_step_forms_no_derivative():
    pid = PID(kp=0.0, kd=100.0)
    assert pid.update(1.0, 0.01) == 0.0


def test_derivative_follows_the_error_rate():
    pid = PID(kp=0.0, kd=1.0)
    pid.update(0.0, 0.1)
    assert pid.update(1.0, 0.1) == pytest.approx(10.0)
    assert pid.update(1.0, 0.1) == pytest.approx(0.0)


# --------------------------------------------------------------------------
# Refusal of unusable samples
# --------------------------------------------------------------------------
@pytest.mark.parametrize("bad", NON_FINITE)
def test_non_finite_error_is_refused_and_leaves_memory_alone(bad):
    pid = PID(kp=1.0, ki=0.5, kd=0.1, out_min=-10.0, out_max=10.0)
    pid.update(1.0, 0.05)
    before = pid.state
    assert pid.update(bad, 0.05) == 0.0
    assert pid.state == before
    assert math.isfinite(pid.update(1.0, 0.05))


@pytest.mark.parametrize("bad", NON_FINITE)
def test_non_finite_dt_is_refused(bad):
    pid = PID(kp=1.0, ki=0.5, kd=0.1)
    pid.update(1.0, 0.05)
    before = pid.state
    assert pid.update(1.0, bad) == 0.0
    assert pid.state == before


def test_garbage_error_type_is_refused():
    pid = PID(kp=1.0)
    assert pid.update("wat", 0.1) == 0.0
    assert pid.update(None, 0.1) == 0.0


# --------------------------------------------------------------------------
# Facade API
# --------------------------------------------------------------------------
def test_positional_construction_matches_the_gain_triple_convention():
    pid = PID(*(90.0, 0.5, 4.0))
    assert (pid.kp, pid.ki, pid.kd) == (90.0, 0.5, 4.0)
    assert pid.gains == PIDGains(90.0, 0.5, 4.0, -1e9, 1e9, None)


def test_set_gains_retunes_without_touching_memory():
    pid = PID(kp=1.0, ki=1.0)
    pid.update(1.0, 0.1)
    memory = pid.state
    pid.set_gains(kp=5.0, kd=0.25)
    assert (pid.kp, pid.ki, pid.kd) == (5.0, 1.0, 0.25)
    assert pid.state == memory


def test_reset_clears_memory():
    pid = PID(kp=1.0, ki=1.0, kd=1.0)
    pid.update(1.0, 0.1)
    pid.update(2.0, 0.1)
    pid.reset()
    assert pid.state == PIDState()
    assert pid.update(1.0, 0.1) == pytest.approx(1.0 + 0.1)   # no derivative kick


def test_pid_step_is_pure():
    gains = PIDGains(kp=1.0, ki=1.0, kd=0.0, out_min=-10.0, out_max=10.0, integral_limit=None)
    state = PIDState(integral=0.5, prev_error=0.0)
    out, after = pid_step(gains, state, 1.0, 0.1)
    assert out == pytest.approx(1.0 + 0.6)
    assert state == PIDState(integral=0.5, prev_error=0.0)   # untouched
    assert after == PIDState(integral=0.6, prev_error=1.0)
