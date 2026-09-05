from eis_companion.control.nav_health import NavHealth, NavSample


def nav(ts, **kw):
    values = dict(
        timestamp_s=ts, gps_fix=3, gps_sats=10, gps_hdop=1.0,
        gps_speed_accuracy_mps=0.2, ekf_ok=True, gps_age_s=0.1, ekf_age_s=0.1,
    )
    values.update(kw)
    return NavSample(**values)


def test_negative_sentinel_and_stale_data_are_not_healthy():
    health = NavHealth()
    assert not health.evaluate(nav(0.0, gps_hdop=-1.0)).gps_healthy
    assert not health.evaluate(nav(1.0, gps_age_s=1.1)).gps_healthy
    assert not health.evaluate(nav(2.0, gps_speed_accuracy_mps=-1.0)).gps_healthy


def test_source_switch_requires_two_second_vote_and_ack():
    health = NavHealth()
    denied = dict(
        gps_fix=0, gps_sats=0, gps_hdop=99.0, gps_speed_accuracy_mps=99.0,
        ekf_ok=False, extnav_fresh=True, extnav_age_s=0.1,
        extnav_position_variance_m2=0.2,
    )
    assert health.evaluate(nav(0.0, **denied)).requested_source is None
    request = health.evaluate(nav(2.0, **denied))
    assert request.requested_source == "extnav"
    assert not health.confirm_source("extnav", False)
    assert health.source == "gps"
    request = health.evaluate(nav(4.1, **denied))
    assert request.requested_source == "extnav"
    assert health.confirm_source("extnav", True)
    assert health.source == "extnav"


def test_recovery_remains_held_until_stable_vote_and_ack():
    health = NavHealth()
    denied = nav(
        0.0, gps_fix=0, gps_sats=0, gps_hdop=99.0,
        gps_speed_accuracy_mps=99.0, ekf_ok=False, extnav_fresh=True,
        extnav_age_s=0.1, extnav_position_variance_m2=0.2,
    )
    health.evaluate(denied)
    health.evaluate(nav(2.0, **{k: getattr(denied, k) for k in (
        "gps_fix", "gps_sats", "gps_hdop", "gps_speed_accuracy_mps", "ekf_ok",
        "extnav_fresh", "extnav_age_s", "extnav_position_variance_m2"
    )}))
    health.confirm_source("extnav", True)
    assert health.evaluate(nav(3.0)).hold
    request = health.evaluate(nav(5.0))
    assert request.requested_source == "gps"
    assert health.confirm_source("gps", True)
    assert not health.evaluate(nav(5.1)).hold

