"""Applying the derived failsafe envelope to the flight controller.

``failsafe_param_map`` is the firmware half of "clamped twice": the same
``Limits`` the software clamps use, expressed as the ArduCopter parameters
that make the vehicle safe by construction. A map nobody pushes is a
documentation table, and a push nobody verifies is a claim -- so this file
covers the whole path:

  * the derivation (per-cell battery thresholds, a site-sized fence circle, an
    RTL altitude that stays under that fence, speed caps that match the
    runtime clamp, and a nonsense input degrading to the documented pack);
  * the application: ``Vehicle.apply_failsafe_params`` PARAM_SETs every entry,
    verifies each echo BY VALUE, and reports ``(applied, attempted, failures)``
    rather than swallowing what the FC refused;
  * and the ways it can fail -- silence, a clamped write, a raising link --
    none of which may take the FC connection down with them.

Scripted-inbox fake master, no sockets, no SITL.
"""
from __future__ import annotations

import pytest
from pymavlink import mavutil

from eis_companion.mavlink.safety import (
    CELL_CRT_VOLT,
    CELL_LOW_VOLT,
    DEFAULT_GEOFENCE_RADIUS_M,
    DEFAULT_PACK_CELLS,
    MIN_GEOFENCE_RADIUS_M,
    SafetyManager,
    failsafe_param_map,
)
from eis_companion.mavlink.vehicle import Vehicle
from eis_companion.types import Limits

mav = mavutil.mavlink


# --------------------------------------------------------------------------
# Fake MAVLink link
# --------------------------------------------------------------------------
class Msg:
    def __init__(self, mtype: str, **fields) -> None:
        self._mtype = mtype
        for key, value in fields.items():
            setattr(self, key, value)

    def get_type(self) -> str:
        return self._mtype

    def get_srcSystem(self) -> int:
        return 1


class FakeMav:
    def __init__(self, sent: list, *, raises: bool = False) -> None:
        self._sent = sent
        self.raises = raises

    def __getattr__(self, name: str):
        if not name.endswith("_send"):
            raise AttributeError(name)
        stripped = name[: -len("_send")]

        def _send(*args):
            if self.raises:
                raise OSError("link is gone")
            self._sent.append((stripped, args))
        return _send


class FakeMaster:
    target_system = 1
    target_component = 1

    def __init__(self, inbox=(), *, raises: bool = False) -> None:
        self.sent: list = []
        self.mav = FakeMav(self.sent, raises=raises)
        self.inbox = list(inbox)

    def recv_match(self, type=None, blocking=False, timeout=None):
        want = [type] if isinstance(type, str) else list(type or [])
        while self.inbox:
            msg = self.inbox.pop(0)
            if not want or msg.get_type() in want:
                return msg
        return None


def make_vehicle(inbox=(), limits: Limits | None = None, *, raises: bool = False):
    v = Vehicle(limits=limits if limits is not None else Limits())
    v._master = FakeMaster(inbox, raises=raises)
    v._connected = True
    v._target_system = 1
    v._target_component = 1
    return v


def echo_inbox(params: dict, *, override: dict | None = None):
    """One PARAM_VALUE per entry, IN MAP ORDER, echoing what was asked for.

    ``override`` replaces the echoed value for named parameters -- an FC that
    clamped or refused the write and echoed back what it actually stored.
    """
    stored = dict(params)
    stored.update(override or {})
    return [
        Msg("PARAM_VALUE", param_id=name, param_value=float(stored[name]))
        for name in params
    ]


def written(v: Vehicle) -> dict:
    """``{param name: value}`` actually PARAM_SET on the wire."""
    out = {}
    for name, args in v._master.sent:
        if name != "param_set":
            continue
        param_id = args[2]
        key = param_id.decode() if isinstance(param_id, bytes) else str(param_id)
        out[key] = args[3]
    return out


# ==========================================================================
# The derivation
# ==========================================================================
def test_the_map_is_derived_from_the_same_limits_the_software_clamps_use():
    limits = Limits(max_altitude=42.0, max_speed=6.0, max_climb_rate=2.0)
    params = failsafe_param_map(limits)
    assert params["FENCE_ALT_MAX"] == pytest.approx(42.0)
    assert params["WPNAV_SPEED"] == pytest.approx(600.0)        # cm/s
    assert params["WPNAV_SPEED_UP"] == pytest.approx(200.0)
    assert params["WPNAV_SPEED_DN"] == pytest.approx(200.0)
    assert params["PILOT_SPEED_UP"] == pytest.approx(200.0)


def test_the_gcs_failsafe_timeout_tracks_the_companion_deadman():
    params = failsafe_param_map(Limits(ground_link_timeout_ms=4500))
    assert params["FS_GCS_ENABLE"] == 1.0
    assert params["FS_GCS_TIMEOUT"] == pytest.approx(4.5)


def test_the_gcs_timeout_never_drops_below_one_second():
    """A sub-second firmware failsafe nuisance-trips on ordinary radio jitter."""
    params = failsafe_param_map(Limits(ground_link_timeout_ms=200))
    assert params["FS_GCS_TIMEOUT"] == pytest.approx(1.0)


@pytest.mark.parametrize("cells", range(1, 13))
def test_the_battery_thresholds_are_derived_per_cell(cells):
    params = failsafe_param_map(Limits(), cell_count=cells)
    assert params["BATT_LOW_VOLT"] == round(CELL_LOW_VOLT * cells, 2)
    assert params["BATT_CRT_VOLT"] == round(CELL_CRT_VOLT * cells, 2)
    assert params["BATT_LOW_VOLT"] > params["BATT_CRT_VOLT"]


@pytest.mark.parametrize("bad", [0, -3, 13, 99, None, "4S", 2.5e300])
def test_a_nonsense_cell_count_degrades_to_the_documented_pack(bad):
    params = failsafe_param_map(Limits(), cell_count=bad)  # type: ignore[arg-type]
    assert params["BATT_LOW_VOLT"] == round(CELL_LOW_VOLT * DEFAULT_PACK_CELLS, 2)


def test_the_fence_circle_is_the_site_radius_when_one_is_known():
    params = failsafe_param_map(Limits(), geofence_radius_m=512.0)
    assert params["FENCE_RADIUS"] == pytest.approx(512.0)


@pytest.mark.parametrize(
    "unusable", [None, 0.0, -40.0, float("nan"), float("inf"), "big"]
)
def test_an_unusable_radius_falls_back_instead_of_disabling_containment(unusable):
    params = failsafe_param_map(Limits(), geofence_radius_m=unusable)
    assert params["FENCE_RADIUS"] == pytest.approx(DEFAULT_GEOFENCE_RADIUS_M)


def test_a_tiny_radius_is_raised_to_the_containment_floor():
    params = failsafe_param_map(Limits(), geofence_radius_m=3.0)
    assert params["FENCE_RADIUS"] == pytest.approx(MIN_GEOFENCE_RADIUS_M)


@pytest.mark.parametrize("fence_alt", [10.0, 15.0, 20.0, 30.0, 60.0, 120.0])
def test_rtl_climbs_high_enough_to_come_home_without_breaching_the_fence(fence_alt):
    params = failsafe_param_map(Limits(max_altitude=fence_alt))
    rtl_m = params["RTL_ALT"] / 100.0                    # RTL_ALT is centimetres
    assert 5.0 <= rtl_m <= 15.0
    assert rtl_m <= params["FENCE_ALT_MAX"]
    assert params["RTL_ALT_FINAL"] == 0.0                # land at home


def test_the_arming_and_rc_rungs_are_present_and_never_disabled():
    params = failsafe_param_map(Limits())
    assert params["ARMING_CHECK"] == 1.0
    assert params["FENCE_ENABLE"] == 1.0
    assert params["FENCE_ACTION"] == 1.0
    # RC OVERRIDE PRIMACY: the throttle failsafe is enabled so a genuinely
    # lost transmitter acts, NOT so the firmware stops listening to a live one.
    assert params["FS_THR_ENABLE"] == 1.0
    assert params["FS_EKF_ACTION"] == 1.0


def test_the_manager_wrapper_returns_the_same_table_as_the_function():
    limits = Limits(max_altitude=55.0)
    manager = SafetyManager(limits)
    assert manager.failsafe_param_map(cell_count=3, geofence_radius_m=300.0) == (
        failsafe_param_map(limits, cell_count=3, geofence_radius_m=300.0)
    )


def test_the_manager_uses_whatever_limits_it_currently_holds():
    manager = SafetyManager(Limits(max_altitude=30.0))
    manager.update_limits(Limits(max_altitude=90.0))
    assert manager.failsafe_param_map()["FENCE_ALT_MAX"] == pytest.approx(90.0)


# ==========================================================================
# The application
# ==========================================================================
def test_every_derived_parameter_reaches_the_wire_with_its_derived_value():
    limits = Limits(max_altitude=42.0, max_speed=6.0)
    params = failsafe_param_map(limits, cell_count=4, geofence_radius_m=500.0)
    v = make_vehicle(echo_inbox(params), limits=limits)

    applied, attempted, failures = v.apply_failsafe_params(
        cell_count=4, geofence_radius_m=500.0
    )
    assert (applied, attempted, failures) == (len(params), len(params), [])

    on_the_wire = written(v)
    assert set(on_the_wire) == set(params)
    for name, value in params.items():
        assert on_the_wire[name] == pytest.approx(value), name


def test_each_write_declares_itself_as_a_real32():
    params = failsafe_param_map(Limits())
    v = make_vehicle(echo_inbox(params))
    v.apply_failsafe_params()
    types = {args[4] for name, args in v._master.sent if name == "param_set"}
    assert types == {mav.MAV_PARAM_TYPE_REAL32}


def test_the_pushed_battery_thresholds_follow_the_configured_cell_count():
    params = failsafe_param_map(Limits(), cell_count=3)
    v = make_vehicle(echo_inbox(params))
    v.apply_failsafe_params(cell_count=3)
    assert written(v)["BATT_LOW_VOLT"] == pytest.approx(10.5)
    assert written(v)["BATT_CRT_VOLT"] == pytest.approx(9.9)


def test_a_parameter_the_fc_clamped_is_reported_as_a_failure():
    """ArduPilot echoes what it ACTUALLY STORED, so a refused write comes back
    as the OLD value. Matching the echo on name alone reported success for a
    fence that was never enabled."""
    params = failsafe_param_map(Limits())
    v = make_vehicle(echo_inbox(params, override={"FENCE_ENABLE": 0.0}))

    applied, attempted, failures = v.apply_failsafe_params()
    assert failures == ["FENCE_ENABLE"]
    assert applied == attempted - 1


def test_total_silence_is_every_parameter_failing_not_a_silent_pass():
    params = failsafe_param_map(Limits())
    v = make_vehicle([])                      # the FC never echoes anything
    applied, attempted, failures = v.apply_failsafe_params()
    assert applied == 0
    assert attempted == len(params)
    assert sorted(failures) == sorted(params)


def test_a_link_that_raises_on_every_send_is_survivable():
    """A parameter this firmware does not have -- or a radio that has just
    gone -- is a failure to REPORT, not a reason to drop the FC connection."""
    v = make_vehicle([], raises=True)
    applied, attempted, failures = v.apply_failsafe_params()
    assert applied == 0
    assert len(failures) == attempted > 0


def test_applying_without_a_link_reports_every_parameter_as_unapplied():
    v = make_vehicle([])
    v._connected = False
    applied, attempted, failures = v.apply_failsafe_params()
    assert applied == 0
    assert len(failures) == attempted
    assert v._master.sent == []


# ==========================================================================
# set_param, the primitive underneath
# ==========================================================================
def test_a_disagreeing_echo_settles_the_question_without_retrying():
    """The FC has answered. Asking again only re-asks a settled question."""
    v = make_vehicle([Msg("PARAM_VALUE", param_id="FENCE_ENABLE", param_value=0.0)])
    assert v.set_param("FENCE_ENABLE", 1.0, retries=3, timeout=0.01) is False
    assert [name for name, _ in v._master.sent] == ["param_set"]


def test_silence_is_retried_up_to_the_retry_budget():
    v = make_vehicle([])
    assert v.set_param("RTL_ALT", 1500.0, retries=4, timeout=0.01) is False
    assert [name for name, _ in v._master.sent] == ["param_set"] * 4


def test_an_echo_without_a_value_proves_nothing_and_is_retried():
    v = make_vehicle([Msg("PARAM_VALUE", param_id="FENCE_RADIUS")])
    assert v.set_param("FENCE_RADIUS", 500.0, retries=2, timeout=0.01) is False
    assert [name for name, _ in v._master.sent] == ["param_set"] * 2


def test_an_echo_within_real32_round_trip_tolerance_counts_as_stored():
    """The FC stores a REAL32; the exact float will not survive unchanged."""
    v = make_vehicle(
        [Msg("PARAM_VALUE", param_id="BATT_LOW_VOLT", param_value=14.000001)]
    )
    assert v.set_param("BATT_LOW_VOLT", 14.0, retries=1, timeout=0.01) is True


def test_get_param_returns_none_rather_than_a_fabricated_default():
    assert make_vehicle([]).get_param("FENCE_RADIUS", timeout=0.01) is None
    unreadable = make_vehicle(
        [Msg("PARAM_VALUE", param_id="FENCE_RADIUS", param_value="?")]
    )
    assert unreadable.get_param("FENCE_RADIUS", timeout=0.01) is None


def test_get_param_reads_past_parameters_it_did_not_ask_for():
    v = make_vehicle([
        Msg("PARAM_VALUE", param_id="SOMETHING_ELSE", param_value=1.0),
        Msg("PARAM_VALUE", param_id=b"FENCE_RADIUS\x00\x00\x00\x00", param_value=500.0),
    ])
    assert v.get_param("FENCE_RADIUS", timeout=0.5) == pytest.approx(500.0)
