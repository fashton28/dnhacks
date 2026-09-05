"""
Vehicle MAVLink-egress tests (planner goto path + geofence upload).

Proves, against a mocked pymavlink connection that records every ``*_send``:
  * goto_global sends DO_CHANGE_SPEED (groundspeed) then a position-only
    SET_POSITION_TARGET_GLOBAL_INT in GLOBAL_RELATIVE_ALT_INT -- exact frames,
    typemask, and 1e7 lat/lon scaling,
  * goto_global CLAMPS at this layer (the second clamp of the "clamped twice"
    rule): speed to [0, Limits.max_speed] (never raised), altitude to
    [0, Limits.max_altitude]; a zero/negative request REFUSES the leg
    outright (ArduPilot denies non-positive DO_CHANGE_SPEED, so the target
    would otherwise fly at the FC's previous guided speed, not hold still),
  * bad coordinates (non-finite / out-of-range) are refused outright --
    nothing is ever coerced toward (0, 0),
  * upload_geofence drives the MAV_MISSION_TYPE_FENCE mission protocol
    (MISSION_COUNT -> answer each MISSION_REQUEST with a
    NAV_FENCE_POLYGON_VERTEX_INCLUSION MISSION_ITEM_INT -> final MISSION_ACK)
    and then best-effort PARAM_SETs FENCE_TYPE=5 / FENCE_ENABLE=1,
  * fence NACKs, timeouts, and unacknowledged params degrade gracefully
    (log + return, never raise -- the connection survives).

The fake master mirrors the injected-dependency idiom used by the other unit
tests (FakeClock in test_manual.py): a scripted inbox for recv_match and a
recording ``mav`` sink, no sockets, no SITL. pymavlink is imported only for
its message/constant definitions.
"""
from __future__ import annotations

import math

import pytest

from pymavlink import mavutil

from eis_companion.mavlink.vehicle import Vehicle
from eis_companion.types import Limits

mav = mavutil.mavlink

# The wire typemask values pinned by the contract with ArduPilot. Independent
# of the module's private constants on purpose: these are the numbers on the
# wire, and the test must fail if the module drifts.
POS_ONLY_TYPEMASK = 0b111111111000  # ignore vel+accel+force+yaw+yaw_rate = 4088


# --------------------------------------------------------------------------
# Mocked pymavlink connection
# --------------------------------------------------------------------------
class Msg:
    """A minimal stand-in for a decoded MAVLink message."""

    def __init__(self, mtype: str, **fields) -> None:
        self._mtype = mtype
        for k, v in fields.items():
            setattr(self, k, v)

    def get_type(self) -> str:
        return self._mtype


class FakeMav:
    """Records every ``<name>_send(*args)`` as ``(name, args)``."""

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
    """Scripted-inbox mock of a mavutil connection (single-threaded)."""

    target_system = 1
    target_component = 1

    def __init__(self, inbox=()) -> None:
        self.sent: list = []
        self.mav = FakeMav(self.sent)
        self.inbox = list(inbox)

    def recv_match(self, type=None, blocking=False, timeout=None):
        want = [type] if isinstance(type, str) else list(type or [])
        while self.inbox:
            msg = self.inbox.pop(0)
            if not want or msg.get_type() in want:
                return msg
            # like mavutil: non-matching messages are consumed, not returned
        return None


def make_vehicle(inbox=(), limits: Limits | None = None) -> Vehicle:
    """A Vehicle wired to a FakeMaster, bypassing connect()."""
    v = Vehicle(limits=limits)
    v._master = FakeMaster(inbox)
    v._connected = True
    v._target_system = 1
    v._target_component = 1
    return v


def sent(v: Vehicle) -> list:
    return v._master.sent


def test_companion_heartbeat_drives_fc_gcs_failsafe_watchdog():
    v = make_vehicle()
    assert v.send_heartbeat() is True
    assert sent(v) == [("heartbeat", (
        mav.MAV_TYPE_GCS,
        mav.MAV_AUTOPILOT_INVALID,
        0,
        0,
        mav.MAV_STATE_ACTIVE,
        3,
    ))]


def test_foreign_vicon_heartbeat_does_not_replace_fc_state():
    class ForeignHeartbeat(Msg):
        def get_srcSystem(self):
            return 2

    v = make_vehicle([ForeignHeartbeat(
        "HEARTBEAT", base_mode=0, custom_mode=0,
    )])
    v._msgs["HEARTBEAT"] = Msg(
        "HEARTBEAT",
        base_mode=mav.MAV_MODE_FLAG_SAFETY_ARMED,
        custom_mode=4,
    )
    assert v.poll() == 0
    assert v.vehicle_state().armed is True


PERIMETER = [
    (-35.360761, 149.16223),
    (-35.360761, 149.16823),
    (-35.365761, 149.16823),
    (-35.365761, 149.16223),
]


def _fence_inbox(n: int = 4, *, accept: bool = True, with_params: bool = True):
    inbox = [Msg("MISSION_REQUEST", seq=i) for i in range(n)]
    inbox.append(
        Msg(
            "MISSION_ACK",
            type=mav.MAV_MISSION_ACCEPTED if accept else mav.MAV_MISSION_ERROR,
        )
    )
    if with_params:
        inbox.append(Msg("PARAM_VALUE", param_id="FENCE_TYPE", param_value=5.0))
        inbox.append(Msg("PARAM_VALUE", param_id="FENCE_ENABLE", param_value=1.0))
    return inbox


# --------------------------------------------------------------------------
# goto_global: exact wire frames
# --------------------------------------------------------------------------
def test_goto_sends_change_speed_then_position_target():
    lim = Limits(max_speed=8.0, max_altitude=60.0)
    v = make_vehicle(limits=lim)
    assert v.goto_global(-35.363261, 149.16523, 40.0, 6.0) is True

    assert [name for name, _ in sent(v)] == [
        "command_long",
        "set_position_target_global_int",
    ]

    # 1. DO_CHANGE_SPEED: type=1 (groundspeed), speed, throttle unchanged.
    _, args = sent(v)[0]
    assert args == (
        1, 1, mav.MAV_CMD_DO_CHANGE_SPEED, 0,
        1.0, 6.0, -1.0, 0.0, 0.0, 0.0, 0.0,
    )

    # 2. Position-only global-int target, relative-alt frame, degE7 scaling.
    _, args = sent(v)[1]
    assert args == (
        0, 1, 1,
        mav.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
        POS_ONLY_TYPEMASK,
        int(round(-35.363261 * 1e7)),
        int(round(149.16523 * 1e7)),
        40.0,
        0.0, 0.0, 0.0,       # velocity (ignored by typemask)
        0.0, 0.0, 0.0,       # accel (ignored)
        0.0, 0.0,            # yaw, yaw_rate (ignored)
    )


def test_goto_clamps_speed_to_max():
    lim = Limits(max_speed=8.0, max_altitude=60.0)
    v = make_vehicle(limits=lim)
    assert v.goto_global(-35.36, 149.16, 40.0, 12.0) is True
    _, args = sent(v)[0]
    assert args[5] == 8.0  # param2 = clamped speed


def test_goto_clamps_speed_with_default_limits():
    # Stock Limits: max_speed 2.0 -- the conservative default tightens, never
    # relaxes, when the orchestrator forgot to pass its configured envelope.
    v = make_vehicle()
    assert v.goto_global(-35.36, 149.16, 10.0, 6.0) is True
    _, args = sent(v)[0]
    assert args[5] == 2.0


def test_goto_never_raises_requested_speed():
    # Sub-min_speed positive requests pass through UN-floored: clamp_speed's
    # min_speed floor is a guidance-usability floor, not a goto floor.
    lim = Limits(max_speed=8.0, min_speed=0.5)
    v = make_vehicle(limits=lim)
    assert v.goto_global(-35.36, 149.16, 10.0, 0.3) is True
    _, args = sent(v)[0]
    assert args[5] == pytest.approx(0.3)


def test_goto_refuses_zero_or_negative_speed():
    # A profile the config floor degraded to 0.0 means "no motion, safe
    # direction". ArduPilot DENIES non-positive DO_CHANGE_SPEED, so sending
    # the position target anyway would fly the leg at the FC's previous /
    # default guided speed (SITL WPNAV_SPEED 10 m/s > the 8 m/s hard cap)
    # instead of not moving -- the leg is refused: NOTHING on the wire.
    lim = Limits(max_speed=8.0, min_speed=0.5)
    v = make_vehicle(limits=lim)
    assert v.goto_global(-35.36, 149.16, 10.0, 0.0) is False
    assert sent(v) == []

    v2 = make_vehicle(limits=lim)
    assert v2.goto_global(-35.36, 149.16, 10.0, -3.0) is False
    assert sent(v2) == []


def test_goto_clamps_altitude_to_envelope():
    lim = Limits(max_speed=8.0, max_altitude=30.0)
    v = make_vehicle(limits=lim)
    assert v.goto_global(-35.36, 149.16, 120.0, 4.0) is True
    _, args = sent(v)[1]
    assert args[7] == 30.0

    v2 = make_vehicle(limits=lim)
    assert v2.goto_global(-35.36, 149.16, -5.0, 4.0) is True
    _, args2 = sent(v2)[1]
    assert args2[7] == 0.0


def test_goto_per_call_limits_override():
    v = make_vehicle(limits=Limits(max_speed=8.0))
    tighter = Limits(max_speed=3.0, max_altitude=25.0)
    assert v.goto_global(-35.36, 149.16, 40.0, 6.0, limits=tighter) is True
    assert sent(v)[0][1][5] == 3.0
    assert sent(v)[1][1][7] == 25.0


@pytest.mark.parametrize(
    "lat,lon",
    [
        (float("nan"), 149.16),
        (-35.36, float("inf")),
        (91.0, 149.16),
        (-35.36, 181.0),
        (None, 149.16),
    ],
)
def test_goto_refuses_bad_coordinates(lat, lon):
    v = make_vehicle(limits=Limits(max_speed=8.0))
    assert v.goto_global(lat, lon, 10.0, 2.0) is False
    assert sent(v) == []  # nothing on the wire -- never coerced toward (0, 0)


def test_goto_refuses_when_not_connected():
    v = make_vehicle()
    v._connected = False
    assert v.goto_global(-35.36, 149.16, 10.0, 2.0) is False
    assert sent(v) == []


def test_arm_and_ekf_source_report_flight_controller_ack_result():
    arm_command = mav.MAV_CMD_COMPONENT_ARM_DISARM
    v = make_vehicle(inbox=[Msg("COMMAND_ACK", command=arm_command, result=mav.MAV_RESULT_DENIED)])
    assert v.arm() is False
    assert sent(v)[0][0] == "command_long"

    source_command = getattr(mav, "MAV_CMD_SET_EKF_SOURCE_SET", 42007)
    v = make_vehicle(inbox=[Msg(
        "COMMAND_ACK", command=source_command, result=mav.MAV_RESULT_ACCEPTED,
    )])
    assert v.set_ekf_source("extnav") is True
    assert sent(v)[0][1][4] == 2.0


# --------------------------------------------------------------------------
# upload_geofence: mission protocol + params
# --------------------------------------------------------------------------
def test_fence_upload_exact_messages():
    v = make_vehicle(inbox=_fence_inbox(4))
    assert v.upload_geofence(PERIMETER) is True

    names = [name for name, _ in sent(v)]
    assert names == (
        ["mission_count"]
        + ["mission_item_int"] * 4
        + ["param_set", "param_set"]
    )

    assert sent(v)[0][1] == (1, 1, 4, mav.MAV_MISSION_TYPE_FENCE)

    for i in range(4):
        lat, lon = PERIMETER[i]
        _, args = sent(v)[1 + i]
        assert args == (
            1, 1, i,
            mav.MAV_FRAME_GLOBAL,
            mav.MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION,
            0, 0,                       # current, autocontinue
            4.0, 0.0, 0.0, 0.0,         # param1 = vertex count
            int(round(lat * 1e7)),
            int(round(lon * 1e7)),
            0.0,
            mav.MAV_MISSION_TYPE_FENCE,
        )

    # FENCE_TYPE = 5 (max-alt | polygon), FENCE_ENABLE = 1, both REAL32.
    assert sent(v)[5][1] == (1, 1, b"FENCE_TYPE", 5.0, mav.MAV_PARAM_TYPE_REAL32)
    assert sent(v)[6][1] == (1, 1, b"FENCE_ENABLE", 1.0, mav.MAV_PARAM_TYPE_REAL32)


def test_fence_answers_request_int_and_out_of_order():
    inbox = [
        Msg("MISSION_REQUEST_INT", seq=0),
        Msg("MISSION_REQUEST", seq=2),      # FC re-orders; answer what it asks
        Msg("MISSION_REQUEST_INT", seq=1),
        Msg("MISSION_REQUEST", seq=3),
        Msg("MISSION_ACK", type=mav.MAV_MISSION_ACCEPTED),
        Msg("PARAM_VALUE", param_id="FENCE_TYPE", param_value=5.0),
        Msg("PARAM_VALUE", param_id="FENCE_ENABLE", param_value=1.0),
    ]
    v = make_vehicle(inbox=inbox)
    assert v.upload_geofence(PERIMETER) is True
    seqs = [args[2] for name, args in sent(v) if name == "mission_item_int"]
    assert seqs == [0, 2, 1, 3]


def test_fence_rejected_by_nack_returns_false_no_params():
    v = make_vehicle(inbox=_fence_inbox(4, accept=False, with_params=False))
    assert v.upload_geofence(PERIMETER) is False
    assert all(name != "param_set" for name, _ in sent(v))


def test_fence_early_nack_aborts_transfer():
    v = make_vehicle(inbox=[Msg("MISSION_ACK", type=mav.MAV_MISSION_ERROR)])
    assert v.upload_geofence(PERIMETER) is False
    assert [name for name, _ in sent(v)] == ["mission_count"]


def test_fence_request_timeout_returns_false():
    v = make_vehicle(inbox=[])  # FC never answers
    assert v.upload_geofence(PERIMETER, item_timeout=0.01) is False
    assert [name for name, _ in sent(v)] == ["mission_count"]


def test_fence_param_silence_still_succeeds():
    # Fence accepted but the FC never echoes PARAM_VALUE: log + continue.
    v = make_vehicle(inbox=_fence_inbox(4, with_params=False))
    assert v.upload_geofence(PERIMETER, item_timeout=0.01) is True
    # set_param retried 3x per param, but the fence upload still reports OK.
    assert [name for name, _ in sent(v)].count("param_set") == 6


def test_fence_refuses_degenerate_perimeter():
    v = make_vehicle()
    assert v.upload_geofence(PERIMETER[:2]) is False
    assert sent(v) == []


def test_fence_refuses_out_of_range_vertex():
    bad = PERIMETER[:3] + [(91.0, 149.16)]
    v = make_vehicle()
    assert v.upload_geofence(bad) is False
    assert sent(v) == []


def test_fence_not_connected_is_graceful():
    v = make_vehicle()
    v._connected = False
    assert v.upload_geofence(PERIMETER) is False
    assert sent(v) == []


# --------------------------------------------------------------------------
# set_param: best-effort, never raises
# --------------------------------------------------------------------------
def test_set_param_matches_null_padded_bytes_echo():
    inbox = [Msg("PARAM_VALUE", param_id=b"FENCE_ENABLE\x00\x00", param_value=1.0)]
    v = make_vehicle(inbox=inbox)
    assert v.set_param("FENCE_ENABLE", 1.0) is True
    assert sent(v) == [
        ("param_set", (1, 1, b"FENCE_ENABLE", 1.0, mav.MAV_PARAM_TYPE_REAL32)),
    ]


def test_set_param_skips_unrelated_echoes():
    inbox = [
        Msg("PARAM_VALUE", param_id="SOME_OTHER", param_value=0.0),
        Msg("PARAM_VALUE", param_id="FENCE_TYPE", param_value=5.0),
    ]
    v = make_vehicle(inbox=inbox)
    assert v.set_param("FENCE_TYPE", 5.0) is True


def test_set_param_silence_retries_then_false():
    v = make_vehicle(inbox=[])
    assert v.set_param("FENCE_TYPE", 5.0, retries=3, timeout=0.01) is False
    assert [name for name, _ in sent(v)] == ["param_set"] * 3


# --------------------------------------------------------------------------
# Gimbal: MAV_CMD_DO_MOUNT_CONTROL, the manager variant, and the SIGN FLIP
# --------------------------------------------------------------------------
# The contract reports pitch as -30 = up, 0 = level, +90 = straight DOWN.
# ArduPilot's mount uses the opposite sign for the same physical angle. Every
# angle crossing this seam is negated, in both directions -- getting it wrong
# points the camera at the sky, so it is pinned here on the wire values.
DO_MOUNT_CONTROL = getattr(mav, "MAV_CMD_DO_MOUNT_CONTROL", 205)
MAVLINK_TARGETING = getattr(mav, "MAV_MOUNT_MODE_MAVLINK_TARGETING", 2)
GIMBAL_MANAGER_PITCHYAW = getattr(mav, "MAV_CMD_DO_GIMBAL_MANAGER_PITCHYAW", 1000)


def test_gimbal_pitch_uses_mount_control_in_mavlink_targeting_mode():
    v = make_vehicle()
    assert v.set_gimbal_pitch(45.0) is True
    name, args = sent(v)[0]
    assert name == "command_long"
    # (target_system, target_component, command, confirmation, p1..p7)
    assert args[2] == DO_MOUNT_CONTROL
    assert args[4] == pytest.approx(-45.0)          # contract +down -> mount -down
    assert args[10] == pytest.approx(float(MAVLINK_TARGETING))


def test_gimbal_manager_variant_is_selected_by_the_config_flag():
    v = make_vehicle()
    assert v.set_gimbal_pitch(30.0, use_gimbal_manager=True) is True
    name, args = sent(v)[0]
    assert name == "command_long"
    assert args[2] == GIMBAL_MANAGER_PITCHYAW
    assert args[4] == pytest.approx(-30.0)


def test_gimbal_command_refuses_non_finite_and_disconnected():
    v = make_vehicle()
    assert v.set_gimbal_pitch(float("nan")) is False
    assert sent(v) == []
    v._connected = False
    assert v.set_gimbal_pitch(10.0) is False


def test_reported_gimbal_pitch_comes_from_mount_status_in_contract_sign():
    v = make_vehicle()
    v._msgs["MOUNT_STATUS"] = Msg("MOUNT_STATUS", pointing_a=-4500)   # centideg
    assert v.gimbal_pitch_deg() == pytest.approx(45.0)


def test_reported_gimbal_pitch_falls_back_to_the_gimbal_device_quaternion():
    v = make_vehicle()
    # 45 deg nose-down in the ArduPilot sign: q = (cos(-22.5), 0, sin(-22.5), 0)
    half = math.radians(-45.0) / 2.0
    v._msgs["GIMBAL_DEVICE_ATTITUDE_STATUS"] = Msg(
        "GIMBAL_DEVICE_ATTITUDE_STATUS",
        q=(math.cos(half), 0.0, math.sin(half), 0.0),
    )
    assert v.gimbal_pitch_deg() == pytest.approx(45.0, abs=1e-6)


def test_an_unreported_mount_returns_none_not_a_fictional_zero():
    assert make_vehicle().gimbal_pitch_deg() is None
