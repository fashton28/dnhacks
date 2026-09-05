from dataclasses import fields

from hypothesis import given, strategies as st

from eis_companion.control.failsafe import FailsafeMachine, FailsafeSignals, decide


_SIGNALS = st.builds(
    FailsafeSignals,
    **{field.name: st.booleans() for field in fields(FailsafeSignals)},
)


@given(_SIGNALS)
def test_every_signal_set_has_exactly_one_allowed_state(signals):
    assert decide(signals).state in {"none", "hold", "rtl", "escalate", "refuse"}


@given(st.lists(_SIGNALS, min_size=1, max_size=30))
def test_state_machine_has_defined_output_for_every_input_sequence(sequence):
    machine = FailsafeMachine()
    for signals in sequence:
        assert machine.evaluate(signals).state in {"none", "hold", "rtl", "escalate", "refuse"}


def test_lidar_climb_hold_releases_when_clear_band_is_reached():
    assert decide(FailsafeSignals(airborne=True, lidar_failed=True)).state == "hold"
    assert decide(FailsafeSignals(airborne=True, lidar_failed=False)).state == "none"


def test_thermal_failure_allows_degraded_inflight_policy():
    decision = decide(FailsafeSignals(airborne=True, thermal_failed=True))
    assert decision.state == "escalate"
    assert "degraded" in decision.reason


def test_hostile_hold_is_latched_until_operator_action():
    machine = FailsafeMachine()
    assert machine.evaluate(FailsafeSignals(airborne=True, hostile_drone=True)).state == "hold"
    assert machine.evaluate(FailsafeSignals(airborne=True)).state == "hold"
    assert machine.resolve_hostile("continue").state == "none"
    assert machine.evaluate(FailsafeSignals(airborne=True)).state == "none"


def test_charge_stall_has_specific_pad_reason():
    decision = decide(FailsafeSignals(airborne=False, readiness_ok=False, charge_stalled=True))
    assert decision.state == "refuse"
    assert decision.reason == "battery charge_stalled"
