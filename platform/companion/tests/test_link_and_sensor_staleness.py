"""Staleness is not health (FM-08/09/10/19/20).

A cache that never expires answers every question with the last good value, so
"the sensor stopped talking" and "the sensor says everything is fine" become
the same reading. Each rail below now carries its own AGE, and the consumers
act on it.
"""
from __future__ import annotations

import math

import pytest

from eis_companion.control.battery_health import (
    BatteryHealth,
    BatteryPolicy,
    BatterySample,
)
from eis_companion.control.failsafe import FailsafeSignals, decide
from eis_companion.control.nav_health import NavHealth, NavPolicy, NavSample
from eis_companion.mavlink.vehicle import Vehicle
from eis_companion.types import Limits


# ==========================================================================
# Fake MAVLink connection
# ==========================================================================
class Msg:
    def __init__(self, mtype: str, **fields) -> None:
        self._mtype = mtype
        for k, v in fields.items():
            setattr(self, k, v)

    def get_type(self) -> str:
        return self._mtype

    def get_srcSystem(self) -> int:
        return getattr(self, "_src", 1)


class FakeMav:
    def __init__(self, sent: list) -> None:
        self._sent = sent

    def __getattr__(self, name: str):
        if not name.endswith("_send"):
            raise AttributeError(name)
        stripped = name[: -len("_send")]

        def _send(*args):
            self._sent.append((stripped, args))
        return _send


class FakeMaster:
    target_system = 1
    target_component = 1

    def __init__(self, inbox=(), raises: bool = False) -> None:
        self.sent: list = []
        self.mav = FakeMav(self.sent)
        self.inbox = list(inbox)
        self.raises = raises

    def recv_match(self, type=None, blocking=False, timeout=None):
        if self.raises:
            raise OSError("socket is gone")
        want = [type] if isinstance(type, str) else list(type or [])
        while self.inbox:
            msg = self.inbox.pop(0)
            if not want or msg.get_type() in want:
                return msg
        return None


def make_vehicle(inbox=(), raises: bool = False) -> Vehicle:
    v = Vehicle(limits=Limits())
    v._master = FakeMaster(inbox, raises=raises)
    v._connected = True
    v._target_system = 1
    v._target_component = 1
    return v


# ==========================================================================
# FM-08: the companion detects FC link loss
# ==========================================================================
def test_fc_link_is_lost_when_no_heartbeat_has_ever_arrived():
    v = make_vehicle()
    assert math.isinf(v.fc_heartbeat_age_s())
    assert v.fc_link_lost() is True


def test_fc_link_is_healthy_right_after_a_heartbeat_and_lost_once_stale():
    v = make_vehicle(inbox=[Msg("HEARTBEAT", base_mode=0, custom_mode=4)])
    v.poll()
    assert v.fc_link_lost() is False
    v._last_heartbeat_ts -= 10.0
    assert v.fc_link_lost() is True


def test_a_raising_socket_is_recorded_as_link_loss_not_swallowed():
    """poll() used to `except Exception: break` and keep serving the cache."""
    v = make_vehicle(inbox=[Msg("HEARTBEAT", base_mode=0, custom_mode=4)])
    v.poll()
    assert v.fc_link_lost() is False
    v._master.raises = True
    v.poll()
    assert v.fc_link_lost() is True


def test_a_foreign_heartbeat_with_an_unreadable_source_is_not_accepted():
    """The except branch used to FALL THROUGH and accept the message."""
    class Broken(Msg):
        def get_srcSystem(self):
            raise ValueError("no source id")

    v = make_vehicle(inbox=[Broken("HEARTBEAT", base_mode=0, custom_mode=4)])
    assert v.poll() == 0
    assert v.fc_link_lost() is True


def test_telemetry_carries_the_fc_link_state():
    v = make_vehicle(inbox=[Msg("HEARTBEAT", base_mode=0, custom_mode=4)])
    v.poll()
    telem = v.read_telemetry()
    assert telem["fcLink"]["lost"] is False
    v._last_heartbeat_ts -= 30.0
    stale = v.read_telemetry()
    assert stale["fcLink"]["lost"] is True
    assert stale["fcLink"]["telemetryStale"] is True


def test_health_inputs_report_the_fc_link():
    v = make_vehicle()
    raw = v.health_inputs()
    assert raw["fc_link_lost"] is True
    assert math.isinf(raw["fc_heartbeat_age_s"])


def test_the_degraded_telemetry_fallback_does_not_advertise_a_perfect_link():
    """`_telemetry_from_state` hardcoded latencyMs 0.0 -- a PERFECT link
    readout on the path taken when the FC link is dead."""
    from eis_companion.app import _telemetry_from_state
    from eis_companion.types import VehicleState

    telem = _telemetry_from_state(VehicleState())
    assert telem["link"]["latencyMs"] > 1000.0
    assert telem["fcLink"]["lost"] is True


def test_a_lost_fc_link_reaches_the_failsafe_ladder():
    decision = decide(FailsafeSignals(airborne=True, fc_link_lost=True))
    assert decision.state == "hold"
    assert "flight controller link" in decision.reason


# ==========================================================================
# FM-09: blocking waits must not DISCARD telemetry
# ==========================================================================
def test_a_command_ack_wait_caches_the_frames_it_consumes():
    """recv_match consumes what it does not return; those frames used to be
    dropped on the floor, so state went stale during every ack wait."""
    from pymavlink import mavutil

    inbox = [
        Msg("ATTITUDE", roll=0.1, pitch=0.2, yaw=0.3),
        Msg("GLOBAL_POSITION_INT", lat=-260900000, lon=294719000,
            relative_alt=25000, alt=25000, vz=0, hdg=0),
        Msg("COMMAND_ACK",
            command=mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
            result=mavutil.mavlink.MAV_RESULT_ACCEPTED),
    ]
    v = make_vehicle(inbox=inbox)
    assert v.arm() is True
    assert "ATTITUDE" in v._msgs, "the attitude frame must be cached, not discarded"
    assert "GLOBAL_POSITION_INT" in v._msgs
    assert v.vehicle_state().relAlt == pytest.approx(25.0)


# ==========================================================================
# FM-10: no EKF-source request storm
# ==========================================================================
def _denied_sample(t: float) -> NavSample:
    return NavSample(
        timestamp_s=t, gps_fix=0, gps_sats=0, gps_hdop=math.inf,
        gps_speed_accuracy_mps=math.inf, ekf_ok=False,
        extnav_fresh=True, extnav_age_s=0.1, extnav_position_variance_m2=0.04,
    )


def test_a_refused_source_switch_backs_off_instead_of_re_issuing_every_tick():
    nav = NavHealth(NavPolicy(vote_s=0.0, source_retry_backoff_s=2.0))
    requests = []
    t = 0.0
    for _ in range(30):
        snap = nav.evaluate(_denied_sample(t))
        if snap.requested_source:
            requests.append(t)
            nav.confirm_source(snap.requested_source, accepted=False)
        t += 0.1
    assert len(requests) <= 2, (
        f"a refused switch must back off, not re-issue every tick: {requests}"
    )


def test_the_companion_eventually_gives_up_and_says_so():
    nav = NavHealth(NavPolicy(vote_s=0.0, source_retry_backoff_s=0.0,
                              source_retry_give_up=3))
    t = 0.0
    for _ in range(200):
        snap = nav.evaluate(_denied_sample(t))
        if snap.requested_source:
            nav.confirm_source(snap.requested_source, accepted=False)
        t += 0.1
    assert "extnav" in nav.source_unavailable
    assert nav.evaluate(_denied_sample(t)).requested_source is None


def test_an_accepted_switch_clears_the_backoff_and_commits():
    nav = NavHealth(NavPolicy(vote_s=0.0))
    snap = nav.evaluate(_denied_sample(0.0))
    assert snap.requested_source == "extnav"
    assert nav.confirm_source("extnav", accepted=True) is True
    assert nav.source == "extnav"
    assert nav.source_unavailable == ()


# ==========================================================================
# FM-19: a frozen pack sensor is not a healthy pack
# ==========================================================================
def fresh_sample(t: float, **kwargs) -> BatterySample:
    base = dict(
        voltage_v=24.9, current_a=8.0, temp_c=31.0, reported_soc_pct=87.0,
        cell_voltages_v=(4.15, 4.15, 4.15, 4.15),
        armed=True, airborne=True, landed=False, timestamp_s=t, age_s=0.0,
    )
    base.update(kwargs)
    return BatterySample(**base)


def test_stale_pack_telemetry_latches_a_fault_that_reaches_the_ladder():
    """The exact FM-19 scenario: the smart pack dies at 87 %, 24.9 V, 31 C,
    current_battery = -1. Every existing check tests ABSENCE, which a frozen
    frame never exhibits, so the pack read as healthy to 0 %."""
    health = BatteryHealth(BatteryPolicy(batt_max_age_s=5.0))
    snap = health.update(fresh_sample(100.0))
    assert snap.fault == ""

    stale = health.update(fresh_sample(120.0, current_a=None, age_s=30.0))
    assert stale.fault, "stale pack telemetry must latch a FAULT"
    assert "stale" in stale.fault
    assert any("stale" in reason for reason in stale.reasons)

    # ...and the fault is what the in-flight ladder consumes.
    decision = decide(FailsafeSignals(airborne=True, battery_fault=True))
    assert decision.state == "rtl"


def test_an_unmeasured_current_does_not_freeze_the_coulomb_integrator():
    """current_battery == -1 became 0.0 A, so `integrated == self._soc` and
    the monotonic rule was satisfied vacuously, forever."""
    health = BatteryHealth(BatteryPolicy(batt_max_age_s=5.0))
    health.update(fresh_sample(0.0))
    snap = health.update(fresh_sample(1.0, current_a=None, age_s=0.0))
    assert any("current" in reason for reason in snap.reasons)


def test_fresh_pack_telemetry_stays_healthy():
    """Control: the staleness gate must not fire on a live pack."""
    health = BatteryHealth(BatteryPolicy(batt_max_age_s=5.0))
    snap = health.update(fresh_sample(0.0))
    for t in range(1, 10):
        snap = health.update(fresh_sample(float(t)))
    assert snap.fault == ""
    assert not any("stale" in reason for reason in snap.reasons)


def test_health_inputs_emit_a_battery_age_like_the_nav_rails_do():
    v = make_vehicle(inbox=[
        Msg("SYS_STATUS", voltage_battery=24900, current_battery=800,
            battery_remaining=87, onboard_control_sensors_present=0,
            onboard_control_sensors_enabled=0, onboard_control_sensors_health=0),
    ])
    v.poll()
    raw = v.health_inputs()
    assert "age_s" in raw["battery"]
    assert raw["battery"]["age_s"] < 1.0
    v._msg_ts["SYS_STATUS"] -= 60.0
    assert v.health_inputs()["battery"]["age_s"] > 30.0


# ==========================================================================
# FM-20: a missing WIND estimate is not calm air
# ==========================================================================
def test_a_missing_wind_message_is_reported_as_absent_not_as_zero():
    v = make_vehicle()
    raw = v.health_inputs()
    assert raw["wind_present"] is False
    assert raw["wind_mps"] is None, "absent must not degrade to 0.0 m/s (calm)"


def test_a_fresh_wind_message_is_reported_with_its_value():
    v = make_vehicle(inbox=[Msg("WIND", speed=7.5)])
    v.poll()
    raw = v.health_inputs()
    assert raw["wind_present"] is True
    assert raw["wind_mps"] == pytest.approx(7.5)


def test_a_stale_wind_message_stops_counting_as_an_estimate():
    v = make_vehicle(inbox=[Msg("WIND", speed=7.5)])
    v.poll()
    v._msg_ts["WIND"] -= 3600.0
    raw = v.health_inputs()
    assert raw["wind_present"] is False
    assert raw["wind_mps"] is None
