from hypothesis import given, strategies as st

from eis_companion.control.battery_health import BatteryHealth, BatteryPolicy, BatterySample


def sample(ts, *, soc=100.0, voltage=12.6, current=0.0, armed=False, airborne=False, **kw):
    return BatterySample(
        voltage_v=voltage, current_a=current, temp_c=25.0,
        reported_soc_pct=soc, armed=armed, airborne=airborne,
        landed=not airborne, timestamp_s=ts, **kw,
    )


@given(st.lists(st.floats(min_value=0.0, max_value=40.0), min_size=1, max_size=30))
def test_flight_soc_never_increases(currents):
    health = BatteryHealth(BatteryPolicy(cell_count=3))
    previous = health.update(sample(0.0, armed=True, airborne=True)).soc_pct
    for index, current in enumerate(currents, 1):
        current_soc = health.update(sample(
            float(index), soc=100.0, current=current, armed=True, airborne=True
        )).soc_pct
        assert current_soc <= previous
        previous = current_soc


def test_full_pack_requires_stable_confirmation_then_is_ready():
    health = BatteryHealth(BatteryPolicy(cell_count=3, charge_confirm_s=10.0))
    assert not health.update(sample(0.0)).ready
    snapshot = health.update(sample(10.0))
    assert snapshot.ready
    assert snapshot.charge_state == "charged"


def test_pack_fault_latches_and_sortie_cap_includes_return():
    health = BatteryHealth(BatteryPolicy(cell_count=3, max_sortie_s=480.0))
    bad = health.update(sample(
        0.0, armed=True, airborne=True, pack_fault="injected pack fault"
    ), estimated_return_s=35.0)
    recovered_input = health.update(sample(1.0, armed=False, airborne=False))
    assert bad.should_rtl
    assert bad.must_rtl_by_s == 445.0
    assert recovered_input.fault == "injected pack fault"
    assert health.clear_fault(disarmed=True, inspected=True)


def test_reserve_is_full_pack_percentage_points():
    health = BatteryHealth(BatteryPolicy(cell_count=3, nominal_endurance_s=1500, reserve_pct=25))
    snapshot = health.update(sample(0.0, soc=80.0, voltage=12.06, armed=True, airborne=True))
    assert snapshot.remaining_s == 825.0


def test_sortie_clock_accepts_zero_as_real_start_time():
    health = BatteryHealth(BatteryPolicy(cell_count=3))
    health.update(sample(0.0, armed=True, airborne=True))
    snapshot = health.update(sample(12.0, armed=True, airborne=True))
    assert snapshot.elapsed_sortie_s == 12.0


def test_remaining_time_uses_lower_current_based_estimate():
    health = BatteryHealth(BatteryPolicy(cell_count=3, capacity_mah=5000))
    snapshot = health.update(sample(
        0.0, soc=80.0, voltage=12.06, current=20.0, armed=True, airborne=True
    ))
    assert snapshot.remaining_s < 500.0
