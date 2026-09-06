"""
============================================================================
Drone Safety Platform -- COMPANION FC connection (pymavlink)
----------------------------------------------------------------------------
``Vehicle`` is the companion's whole conversation with the ArduPilot flight
controller, and the ONLY module (packaging aside) allowed to import a hardware
library. The pure-logic core -- guidance, manual, tracker, safety -- never
imports it, which is what keeps that core testable on a laptop.

Everything it does falls into four directions of travel:

  IN   ``poll`` drains the link into a per-type cache that also records WHEN
       each message arrived, and ``read_telemetry`` / ``vehicle_state`` /
       ``health_inputs`` translate that cache into the contract ``telemetry``
       dict, the internal ``VehicleState`` snapshot, and the plain health
       rails the pure-logic ladders consume. Ages travel with the values: a
       cache that never expires answers "the sensor stopped talking" and
       "the sensor says everything is fine" with the same number.

  OUT  the discrete command set (arm / disarm / mode / takeoff / land / RTL /
       brake), the 10-20 Hz BODY-frame velocity stream, and the planner's
       GUIDED global position targets.

  UP   the sensor rails this companion PUBLISHES to the FC -- distance sensor,
       obstacle fan, extnav odometry, EKF source selection, gimbal pitch.

  SET  parameters and the site geofence: echo-verified PARAM_SET, the derived
       failsafe envelope (``apply_failsafe_params``), and the perimeter /
       no-fly polygons uploaded through the fence mission protocol. What the
       FC actually STORED and ENABLED is tracked separately from what we
       asked for, because "we sent it" is not containment.

Frame & unit conventions
  ``VelocitySetpoint`` is BODY frame: vx fwd(+)/back(-), vy right(+)/left(-),
  vz down(+)/up(-) in m/s, yaw_rate in deg/s (clockwise +). That is already
  MAV_FRAME_BODY_NED's convention (x fwd, y right, z down); only yaw_rate is
  converted, deg/s -> rad/s, on the way to the wire. ``valid=False`` means a
  zero-velocity HOLD, and the frame is still sent so the FC's GUIDED
  controller actively holds instead of coasting on a stale target.

SAFETY -- this layer is the SECOND stage of "clamped twice". The guidance and
manual layers own the envelope (including the standoff hard limit) and clamp
first; every command leaving this module is then folded through the pure-logic
clamp in ``mavlink.safety`` immediately before the wire:

  * ``send_body_velocity`` -> ``clamp_body_velocity``: axes bounded by
    ``Limits``, and a non-finite value on ANY axis collapses the WHOLE frame
    to the zero hold rather than to a bound.
  * ``goto_global`` -> ``clamp_goto_target``: speed folded into
    ``[0, max_speed]`` (never raised) and altitude into ``[0, max_altitude]``.
    Global targets bypass the orchestrator's per-tick velocity clamp entirely,
    so for the planner path this IS the second clamp.

Neither stage can raise a value the control core already lowered -- they only
tighten, and they default to "no motion" whenever they cannot understand an
input.
============================================================================
"""
from __future__ import annotations

import logging
import math
import time
from typing import Any, Optional, Sequence, Tuple

from eis_companion.types import (
    ControlSource,
    Limits,
    VehicleState,
    VelocitySetpoint,
    now,
)

from .safety import clamp_body_velocity, clamp_goto_target

log = logging.getLogger("eis.mavlink")

# The pymavlink import is TOLERATED, not required, at module import time: a
# dev box or a CI runner without it should still be able to import this file
# (for its constants, or transitively) and get a clear error only when someone
# actually tries to talk to a flight controller. ``connect()`` is where that
# error is raised.
# The v20 ardupilotmega dialect is imported for its side effect -- it is what
# makes ArduPilot's message set available to mavutil -- so the capability flag
# is derived from BOTH names rather than asserted. That keeps the flag honest
# (it means "the transport AND the dialect are here") and keeps the names used,
# so no linter suppression is needed for either.
try:  # pragma: no cover - import guard
    from pymavlink import mavutil
    from pymavlink.dialects.v20 import ardupilotmega as mavlink2
    _HAVE_PYMAVLINK = mavutil is not None and mavlink2 is not None
except Exception:  # pragma: no cover - import guard
    mavutil = None  # type: ignore
    mavlink2 = None  # type: ignore
    _HAVE_PYMAVLINK = False


# --------------------------------------------------------------------------
# SET_POSITION_TARGET_* type masks
# --------------------------------------------------------------------------
# In both SET_POSITION_TARGET messages a SET bit means "IGNORE this field", so
# a mask is built by naming the field groups we are NOT commanding. Spelling
# the groups out once and OR-ing the named tuples keeps the two masks from
# drifting apart, and makes a wrong bit a readable mistake instead of a magic
# number: MAV_FRAME field groups are, by bit index,
#   0-2 position | 3-5 velocity | 6-8 acceleration | 9 force | 10 yaw | 11 yaw rate
_POSITION_BITS: Tuple[int, ...] = (0, 1, 2)
_VELOCITY_BITS: Tuple[int, ...] = (3, 4, 5)
_ACCEL_BITS: Tuple[int, ...] = (6, 7, 8)
_FORCE_BITS: Tuple[int, ...] = (9,)
_YAW_BITS: Tuple[int, ...] = (10,)
_YAW_RATE_BITS: Tuple[int, ...] = (11,)


def _ignore_mask(*groups: Tuple[int, ...]) -> int:
    """Build a type mask that IGNORES every field group passed in."""
    mask = 0
    for group in groups:
        for bit in group:
            mask |= 1 << bit
    return mask


#: BODY-frame velocity streaming: command velocity + yaw rate, ignore the rest.
_TYPEMASK_VEL_YAWRATE = _ignore_mask(
    _POSITION_BITS, _ACCEL_BITS, _FORCE_BITS, _YAW_BITS
)

#: The planner's GUIDED goto: command position ONLY. A position target's
#: velocity fields are a feed-forward term in ArduPilot, NOT a cruise-speed
#: cap, so the leg speed goes out separately as MAV_CMD_DO_CHANGE_SPEED (which
#: GUIDED honours) and the velocity bits stay ignored here.
_TYPEMASK_POS_ONLY = _ignore_mask(
    _VELOCITY_BITS, _ACCEL_BITS, _FORCE_BITS, _YAW_BITS, _YAW_RATE_BITS
)

#: Inbound telemetry rate, in Hz, requested from the FC. It is deliberately
#: double the 10 Hz telemetry pump and half the 20 Hz control loop: fast
#: enough that a control tick never reasons about a frame it has already
#: reported to the ground, slow enough not to swamp a 57 600 baud radio.
_STREAM_RATE_HZ = 10

# --------------------------------------------------------------------------
# Staleness thresholds (FM-08, FM-19, FM-20)
# --------------------------------------------------------------------------
# The FC heartbeat is nominally 1 Hz. Three missed beats is a dead link, not a
# hiccup. Nothing below re-stamps a cached message as fresh: every rail carries
# its own age so the consumer decides, rather than the cache lying by omission.
FC_HEARTBEAT_TIMEOUT_S: float = 3.0
#: BATTERY_STATUS / SYS_STATUS are streamed at ~10 Hz; 5 s of silence is a dead
#: pack sensor, which must not read as "the last value, forever".
BATTERY_MAX_AGE_S: float = 5.0
#: WIND is low-rate on ArduPilot. Beyond this the estimate is absent, which is
#: NOT the same as calm air.
WIND_MAX_AGE_S: float = 10.0


class Vehicle:
    """The companion's pymavlink connection to one ArduPilot flight controller.

    SINGLE OWNER. Nothing here is synchronised, and it is not meant to be: the
    receive path mutates a shared cache and the blocking waits consume from
    the same socket the control loop polls, so two callers racing would give
    each other each other's messages. Drive it from one loop -- the
    orchestrator's -- and put your own lock in front if you ever fan out.

    Every method degrades toward "do nothing" rather than raising, with two
    deliberate exceptions: ``connect()`` raises when there is no pymavlink or
    no heartbeat, and ``_command_long`` raises on a missing link, because a
    discrete command that silently evaporates would be reported as success.
    """

    def __init__(
        self,
        connection: str = "udp:127.0.0.1:14550",
        *,
        baud: int = 115200,
        source_system: int = 255,
        target_system: int = 1,
        limits: Optional[Limits] = None,
    ) -> None:
        # --- how to dial, remembered so connect() can be called with no args.
        # The orchestrator builds Vehicle(connection=, baud=, source_system=,
        # target_system=); any of them can still be overridden per connect().
        self._connection = connection
        self._init_baud = baud
        self._init_source_system = source_system

        # --- the envelope this layer clamps its egress to. Defaults to the
        # conservative stock Limits so a caller that forgets to pass one gets
        # TIGHTER bounds, never looser; the orchestrator shares its live copy
        # so runtime edits (setMaxSpeed) apply on the next frame.
        self._limits: Limits = limits if limits is not None else Limits()

        # --- link identity + state
        self._master: Any = None
        self._connected: bool = False
        self._target_system: int = target_system
        self._target_component: int = 1
        self._mode_mapping: dict[str, int] = {}
        self._inv_mode_mapping: dict[int, str] = {}

        # --- inbound cache. Two parallel dicts, keyed by MAVLink type name:
        # the newest message, and WHEN it landed. The timestamps are what let
        # every consumer ask "how old is this?" instead of trusting a value
        # that may not have moved in a minute (FM-08 / FM-19 / FM-20).
        self._msgs: dict[str, Any] = {}
        self._msg_ts: dict[str, float] = {}
        self._last_heartbeat_ts: float = 0.0
        self._link_latency_ms: float = 0.0
        self._fc_ready: bool = False
        # Raised by a wedged / closed socket, cleared by the next message that
        # actually arrives. Without it a dead link keeps serving the cache as
        # though it were live (FM-08).
        self._recv_error: bool = False

        # --- what the FC actually holds for the geofence, as far as we can
        # PROVE. 'stored' = the polygon transfer was accepted; 'enabled' =
        # FENCE_ENABLE was read back as 1. Both start unknown, and unknown is
        # not the same as false (FM-14 / FM-15).
        self._fence_stored: Optional[bool] = None
        self._fence_enabled: Optional[bool] = None
        self._fence_detail: str = "geofence upload not attempted"

    # ----------------------------------------------------------------------
    # Connection lifecycle
    # ----------------------------------------------------------------------
    def connect(
        self,
        connection_string: Optional[str] = None,
        *,
        baud: Optional[int] = None,
        source_system: Optional[int] = None,
        wait_heartbeat_timeout: float = 30.0,
    ) -> None:
        """Open the link, prove it with a heartbeat, then adopt it.

        Acquisition is TRANSACTIONAL: the transport is opened and handshaken
        on the side, and only a link that actually produced a heartbeat is
        installed as ``self._master``. A handshake that times out or raises
        closes the half-open transport and leaves the previous state exactly
        as it was, instead of leaving a live socket dangling behind an object
        that believes it is disconnected.

        Adopting a link also RESETS the inbound cache and the fence claim: a
        new session must not answer questions with the previous session's
        telemetry, and a fence proven on a link that has since dropped is not
        proven on this one.

        Args:
          connection_string: ``udp:127.0.0.1:14550`` (SITL) or a serial device
            such as ``/dev/ttyTHS1``. pymavlink infers the transport from the
            scheme; a bare device path is treated as serial. Defaults to the
            construction-time connection.
          baud: serial baud (ignored for UDP/TCP).
          source_system: our MAVLink system id. 255 is a GCS-style id, so we
            cannot collide with the autopilot (1) or another companion.
          wait_heartbeat_timeout: seconds to wait for the first heartbeat.
        """
        if not _HAVE_PYMAVLINK:
            raise RuntimeError(
                "pymavlink is not installed; Vehicle requires it. "
                "(Pure-logic modules must not import this layer.)"
            )

        address = connection_string or self._connection
        transport = mavutil.mavlink_connection(
            address,
            baud=self._init_baud if baud is None else baud,
            source_system=(
                self._init_source_system if source_system is None else source_system
            ),
            autoreconnect=True,
        )
        try:
            heartbeat = transport.wait_heartbeat(timeout=wait_heartbeat_timeout)
            if heartbeat is None:
                raise TimeoutError(
                    f"no heartbeat from FC on {address} within "
                    f"{wait_heartbeat_timeout:.0f}s"
                )
        except BaseException:
            # Never leave a half-open transport behind a failed connect().
            try:
                transport.close()
            except Exception:
                pass
            raise

        self.close()                       # drop any previous link first
        self._master = transport
        self._connected = True
        self._target_system = transport.target_system
        self._target_component = transport.target_component
        self._adopt_fresh_session(heartbeat)
        self._load_mode_mapping()
        self.request_data_streams(rate_hz=_STREAM_RATE_HZ)

    def _adopt_fresh_session(self, heartbeat: Any) -> None:
        """Clear last session's cache and seed this one with its heartbeat."""
        self._msgs.clear()
        self._msg_ts.clear()
        self._recv_error = False
        self._fc_ready = False
        stamp = now()
        self._msgs["HEARTBEAT"] = heartbeat
        self._msg_ts["HEARTBEAT"] = stamp
        self._last_heartbeat_ts = stamp
        self._note_fence(None, None, "geofence upload not attempted")

    def _load_mode_mapping(self) -> None:
        """Cache ``{mode name -> number}`` and its inverse, tolerating silence."""
        try:
            mapping = self._master.mode_mapping() or {}
        except Exception:
            mapping = {}
        self._mode_mapping = mapping
        self._inv_mode_mapping = {number: name for name, number in mapping.items()}

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def master(self) -> Any:
        """The raw pymavlink connection (for callers that need extras)."""
        return self._master

    @property
    def limits(self) -> Limits:
        """The hard safety envelope this layer clamps ``goto_global`` to."""
        return self._limits

    def update_limits(self, limits: Limits) -> None:
        """Swap the safety envelope (operator edits at runtime, like SafetyManager)."""
        self._limits = limits

    def close(self) -> None:
        """Close the link and mark us disconnected. Safe when never connected.

        Idempotent by design: teardown paths call it from ``finally`` blocks
        and from ``connect()`` itself, so a close that raises must not become
        the reason a reconnect fails.
        """
        master, self._master = self._master, None
        self._connected = False
        if master is None:
            return
        try:
            master.close()
        except Exception:
            log.debug("closing the FC link raised; link dropped anyway", exc_info=True)

    def send_heartbeat(self) -> bool:
        """Send the 1 Hz GCS heartbeat the FC's link-loss backstop watches for.

        This is the companion half of FS_GCS_*: the firmware RTLs when OUR
        heartbeat stops. It says nothing about whether we can still HEAR the
        FC -- that asymmetric failure is ``fc_link_lost()``'s job.
        """
        if not self._connected or self._master is None:
            return False
        try:
            self._master.mav.heartbeat_send(
                mavutil.mavlink.MAV_TYPE_GCS,
                mavutil.mavlink.MAV_AUTOPILOT_INVALID,
                0,                                     # base_mode
                0,                                     # custom_mode
                mavutil.mavlink.MAV_STATE_ACTIVE,
                3,                                     # mavlink_version
            )
            return True
        except Exception:
            log.exception("companion heartbeat send failed")
            return False

    # ----------------------------------------------------------------------
    # Data-stream setup
    # ----------------------------------------------------------------------
    #: The MAVLink messages this module actually TRANSLATES, by name. Every
    #: one is looked up on the dialect at runtime rather than hard-coded,
    #: because the second half of the list only exists on newer firmware and a
    #: missing id must be a message we skip, not an AttributeError that aborts
    #: the whole stream request. Grouped by the consumer that needs it.
    _STREAMED_MESSAGES: Tuple[str, ...] = (
        # contract telemetry + VehicleState
        "HEARTBEAT", "ATTITUDE", "GLOBAL_POSITION_INT", "VFR_HUD",
        "SYS_STATUS", "GPS_RAW_INT",
        # health rails (battery / estimator / wind ladders)
        "BATTERY_STATUS", "EKF_STATUS_REPORT", "ESTIMATOR_STATUS", "WIND",
        # navigation-source rails (optical flow + external odometry)
        "OPTICAL_FLOW_RAD", "ODOMETRY",
        # SITL ground truth, and the camera mount
        "SIMSTATE", "MOUNT_STATUS", "GIMBAL_DEVICE_ATTITUDE_STATUS",
    )

    def _streamed_message_ids(self) -> Tuple[int, ...]:
        """Resolve ``_STREAMED_MESSAGES`` to the ids this dialect knows."""
        resolved = []
        for name in self._STREAMED_MESSAGES:
            msg_id = getattr(mavutil.mavlink, f"MAVLINK_MSG_ID_{name}", None)
            if isinstance(msg_id, int) and msg_id >= 0:
                resolved.append(msg_id)
        return tuple(resolved)

    def request_data_streams(self, rate_hz: int = _STREAM_RATE_HZ) -> None:
        """Ask the FC to emit the telemetry we translate, at ~``rate_hz``.

        Both protocols are used, deliberately: the legacy REQUEST_DATA_STREAM
        works on every ArduPilot build ever shipped, and the modern
        SET_MESSAGE_INTERVAL pins the exact messages we consume so a firmware
        that has retired the stream groups still feeds us. Every send is
        best-effort -- a firmware that refuses one of them must not stop the
        others, and none of this is worth losing the link over.
        """
        if not self._connected or self._master is None:
            return
        rate_hz = max(1, int(rate_hz))
        interval_us = float(int(1_000_000 / rate_hz))

        def _try(what: str, send) -> None:
            try:
                send()
            except Exception:
                log.debug("data-stream request (%s) refused", what, exc_info=True)

        # Legacy, one shot: every stream group at the requested rate.
        _try("REQUEST_DATA_STREAM", lambda: self._master.mav.request_data_stream_send(
            self._target_system,
            self._target_component,
            mavutil.mavlink.MAV_DATA_STREAM_ALL,
            rate_hz,
            1,                                   # 1 = start streaming
        ))

        # Modern, one per message: interval in MICROseconds.
        for msg_id in self._streamed_message_ids():
            _try(f"SET_MESSAGE_INTERVAL {msg_id}", lambda mid=msg_id: self._command_long(
                mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL,
                float(mid),
                interval_us,
            ))

    # ----------------------------------------------------------------------
    # Receive / cache
    # ----------------------------------------------------------------------
    def poll(self, *, max_msgs: int = 50) -> int:
        """Drain what the link has waiting into the cache; return the count kept.

        Non-blocking, and bounded by ``max_msgs`` so a backed-up socket can
        never starve the control loop it is called from. Run it once per tick
        before ``read_telemetry`` / ``vehicle_state``.

        The count is of messages KEPT, not received: BAD_DATA and heartbeats
        from a system that is not our FC are drained and discarded.
        """
        if not self._connected or self._master is None:
            return 0
        kept = 0
        budget = max(0, int(max_msgs))
        while budget > 0:
            budget -= 1
            try:
                msg = self._master.recv_match(blocking=False)
            except Exception:
                # A dead socket raises here, and goes on raising. Recording it
                # is the difference between a visible link failure and a cache
                # that keeps being served as though it were live (FM-08).
                self._recv_error = True
                break
            if msg is None:
                break                       # nothing more waiting right now
            kept += int(self._absorb(msg))
        return kept

    def _absorb(self, msg: Any) -> bool:
        """Cache one received message. Returns True when it was kept.

        Every blocking wait in this module funnels its non-matching traffic
        through here instead of dropping it on the floor: ``recv_match``
        CONSUMES what it does not return, so a 2 s COMMAND_ACK wait used to
        silently discard the attitude/battery/GPS frames that arrived during
        it -- state went stale exactly while a failsafe was being handled
        (FM-09).
        """
        try:
            mtype = msg.get_type()
        except Exception:
            return False
        if mtype == "BAD_DATA":
            return False
        if mtype == "HEARTBEAT":
            # A heartbeat from a NON-target system (a second FC, a router, a
            # GCS sharing the UDP port) must never refresh our FC link health.
            # An unreadable source id is treated as foreign -- "we could not
            # tell" is not "it was ours" (FM-08).
            try:
                if int(msg.get_srcSystem()) != int(self._target_system):
                    return False
            except (AttributeError, TypeError, ValueError):
                return False
        self._msgs[mtype] = msg
        self._msg_ts[mtype] = now()
        self._recv_error = False
        if mtype == "STATUSTEXT" and "ArduPilot Ready" in str(getattr(msg, "text", "")):
            self._fc_ready = True
        if mtype == "HEARTBEAT":
            self._last_heartbeat_ts = now()
        return True

    def _recv(self, *, type=None, timeout: float = 0.25) -> Any:
        """One blocking receive that CACHES everything it consumes.

        Deliberately does NOT pass ``type=`` down to ``recv_match``: mavutil
        consumes the messages its filter rejects and returns them to nobody, so
        a 2 s COMMAND_ACK wait silently dropped every attitude / battery / GPS
        frame that arrived during it -- state went stale exactly while a
        failsafe was being handled (FM-09). We take everything, cache it, and
        do the matching ourselves.

        Returns the matching message, or ``None`` when nothing matching arrived
        inside ``timeout``.
        """
        want = (
            () if type is None
            else ((type,) if isinstance(type, str) else tuple(type))
        )
        deadline = time.monotonic() + max(0.0, float(timeout))
        while True:
            try:
                msg = self._master.recv_match(blocking=True, timeout=timeout)
            except Exception:
                self._recv_error = True
                return None
            if msg is None:
                return None
            self._absorb(msg)
            try:
                mtype = msg.get_type()
            except Exception:
                mtype = ""
            if not want or mtype in want:
                return msg
            if time.monotonic() >= deadline:
                return None

    def fc_heartbeat_age_s(self) -> float:
        """Seconds since the last FC heartbeat (link-health for telemetry)."""
        if self._last_heartbeat_ts <= 0.0:
            return math.inf
        return now() - self._last_heartbeat_ts

    def message_age_s(self, mtype: str) -> float:
        """Seconds since ``mtype`` was last received (``inf`` if never)."""
        received_at = self._msg_ts.get(mtype)
        if received_at is None:
            return math.inf
        return max(0.0, now() - received_at)

    def fc_link_lost(self, *, timeout_s: float = FC_HEARTBEAT_TIMEOUT_S) -> bool:
        """True when the FC link is dead: no heartbeat inside ``timeout_s``.

        ``_connected`` only records that a socket was opened once; it is never
        cleared by a link that stops delivering. This is the companion-side
        detector the failsafe ladder consumes, and it also covers the
        asymmetric RX-only failure the FC's own FS_GCS backstop cannot see
        (the FC still hears our heartbeat; we hear nothing) (FM-08).
        """
        if not self._connected:
            return True
        if self._recv_error:
            return True
        return self.fc_heartbeat_age_s() > max(0.1, float(timeout_s))

    # ----------------------------------------------------------------------
    # Translation -> contract telemetry + VehicleState
    # ----------------------------------------------------------------------
    #: What we report when the FC has told us nothing about its mode. The
    #: safest possible lie is the least capable mode, never GUIDED.
    _UNKNOWN_MODE = "STABILIZE"

    def _mode_name(self) -> str:
        """The current flight-mode NAME, decoded from the cached heartbeat.

        Three sources, in order of how much we trust them: this FC's own mode
        map, pymavlink's decoded ``flightmode`` string, and finally the
        unknown-mode placeholder.
        """
        heartbeat = self._msgs.get("HEARTBEAT")
        if heartbeat is None:
            return self._UNKNOWN_MODE
        name = self._inv_mode_mapping.get(getattr(heartbeat, "custom_mode", 0))
        if name:
            return str(name).upper()
        try:
            decoded = self._master.flightmode
        except Exception:
            decoded = None
        return str(decoded).upper() if decoded else self._UNKNOWN_MODE

    def _is_armed(self) -> bool:
        """Armed flag: the SAFETY_ARMED bit of the cached heartbeat's base_mode.

        No heartbeat means NOT armed -- the conservative answer, since the
        callers use this to decide whether the aircraft can be flying.
        """
        heartbeat = self._msgs.get("HEARTBEAT")
        if heartbeat is None:
            return False
        armed_bit = mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED
        return bool(getattr(heartbeat, "base_mode", 0) & armed_bit)

    #: How each position field is decoded: contract key, MAVLink field on
    #: GLOBAL_POSITION_INT, and the integer scale it arrives in (1e7 for
    #: degE7, 1000 for millimetres).
    _POSITION_FIELDS: Tuple[Tuple[str, str, float], ...] = (
        ("lat", "lat", 1e7),
        ("lon", "lon", 1e7),
        ("relAlt", "relative_alt", 1000.0),
        ("absAlt", "alt", 1000.0),
    )

    #: A MAVLink field carrying either of these is saying "not measured",
    #: not "measured as zero" / "measured as 65535".
    _UNMEASURED = (0, 65535)

    def _kinematics(self) -> Tuple[dict, dict, dict, float]:
        """The ONE unit-conversion boundary for attitude / position / velocity.

        ``vehicle_state`` and ``read_telemetry`` both need the same numbers in
        the same units, and having each do its own radians-to-degrees and
        degE7-to-degrees arithmetic is how the two drift apart. Returns
        ``(attitude_deg, position, velocity, heading_deg)``; every missing
        message degrades to a zero rather than raising, because a partial
        telemetry frame must still reach the ground.
        """
        attitude_msg = self._msgs.get("ATTITUDE")
        position_msg = self._msgs.get("GLOBAL_POSITION_INT")
        hud = self._msgs.get("VFR_HUD")

        attitude = {
            axis: (
                math.degrees(float(getattr(attitude_msg, axis, 0.0)))
                if attitude_msg is not None else 0.0
            )
            for axis in ("roll", "pitch", "yaw")
        }
        position = {
            key: (
                float(getattr(position_msg, field, 0)) / scale
                if position_msg is not None else 0.0
            )
            for key, field, scale in self._POSITION_FIELDS
        }

        # GLOBAL_POSITION_INT.vz is cm/s and points DOWN; the contract reports
        # vertical speed as +UP. VFR_HUD.climb is already +up and is preferred
        # when the FC sends it.
        climb = (
            -float(getattr(position_msg, "vz", 0)) / 100.0
            if position_msg is not None else 0.0
        )
        velocity = {
            "groundspeed": (
                float(getattr(hud, "groundspeed", 0.0)) if hud is not None else 0.0
            ),
            "verticalSpeed": (
                float(getattr(hud, "climb", climb)) if hud is not None else climb
            ),
        }

        if hud is not None:
            heading = float(getattr(hud, "heading", 0.0))
        elif position_msg is not None:
            heading = float(getattr(position_msg, "hdg", 0)) / 100.0
        else:
            heading = 0.0
        return attitude, position, velocity, heading % 360.0

    def vehicle_state(
        self, control_source: str = ControlSource.AUTO.value
    ) -> VehicleState:
        """The internal ``VehicleState`` snapshot the control core reasons about.

        ``control_source`` is stamped by the caller: the orchestrator owns the
        authoritative active source, and this layer only records what it is
        told.
        """
        attitude, position, velocity, heading = self._kinematics()
        armed = self._is_armed()
        rel_alt = position["relAlt"]
        return VehicleState(
            armed=armed,
            mode=self._mode_name(),
            control_source=control_source,
            relAlt=rel_alt,
            groundspeed=velocity["groundspeed"],
            vspeed=velocity["verticalSpeed"],
            heading=heading,
            lat=position["lat"],
            lon=position["lon"],
            roll=attitude["roll"],
            pitch=attitude["pitch"],
            # AIRBORNE = armed AND meaningfully off the ground. The 0.5 m gate
            # keeps ground noise from reading as flight, which matters because
            # this is what enables manual control.
            airborne=bool(armed and rel_alt > 0.5),
            ts=now(),
        )

    def _battery_report(self) -> dict:
        """Contract ``battery`` block from SYS_STATUS (mV / cA / percent).

        The MAVLink "not measured" sentinels are honoured: they become 0.0
        here (the contract has no null), and the health rails in
        ``health_inputs`` carry the richer, age-aware version for anything
        that has to reason about a dead pack sensor.
        """
        status = self._msgs.get("SYS_STATUS")
        if status is None:
            return {"voltage": 0.0, "current": 0.0, "remaining": 0.0}
        millivolts = getattr(status, "voltage_battery", 0)
        centiamps = getattr(status, "current_battery", -1)
        percent = getattr(status, "battery_remaining", -1)
        return {
            "voltage": (
                millivolts / 1000.0 if millivolts not in self._UNMEASURED else 0.0
            ),
            "current": centiamps / 100.0 if centiamps >= 0 else 0.0,
            "remaining": float(percent) if percent >= 0 else 0.0,
        }

    def _gps_report(self) -> dict:
        """Contract ``gps`` block from GPS_RAW_INT (eph is HDOP x100)."""
        gps = self._msgs.get("GPS_RAW_INT")
        if gps is None:
            return {"fixType": 0, "satellites": 0, "hdop": 99.0}
        eph = getattr(gps, "eph", 65535)
        return {
            "fixType": int(getattr(gps, "fix_type", 0)),
            "satellites": int(getattr(gps, "satellites_visible", 0)),
            # 99.0 is the contract's "unusable", not a measured dilution.
            "hdop": eph / 100.0 if eph not in self._UNMEASURED else 99.0,
        }

    def _link_report(self, age_s: float) -> dict:
        """Contract ``link`` block: radio RSSI + FC heartbeat freshness."""
        radio = self._msgs.get("RADIO_STATUS") or self._msgs.get("RADIO")
        age_ms = age_s * 1000.0
        return {
            "rssi": float(getattr(radio, "rssi", 0)) if radio is not None else 0.0,
            "latencyMs": float(age_ms if math.isfinite(age_ms) else 9999.0),
        }

    def read_telemetry(
        self,
        control_source: str = ControlSource.AUTO.value,
        *,
        home_distance: Optional[float] = None,
    ) -> dict:
        """Build a contract ``telemetry`` frame from the cached FC messages.

        Mirrors ``shared.shared.Telemetry`` exactly: degrees for attitude and
        heading, decimal degrees for lat/lon, metres for altitude, m/s for
        velocity, milliseconds for the frame timestamp. ``controlSource`` is
        stamped by the caller; ``home.distance`` is filled in by the caller
        once it knows home, and is 0 until then.

        Never raises. A missing message degrades to a safe default so the
        ground link stays up on partial telemetry -- but the frame also
        carries ``fcLink``, because a cache being served after the FC went
        quiet must SAY so rather than presenting last-known values under a
        moving timestamp (FM-08).
        """
        attitude, position, velocity, heading = self._kinematics()
        age_s = self.fc_heartbeat_age_s()
        stale = bool(self.fc_link_lost())

        return {
            "type": "telemetry",
            "ts": int(time.time() * 1000),
            "armed": self._is_armed(),
            "mode": self._mode_name(),
            "controlSource": control_source,
            "attitude": attitude,
            "position": position,
            "velocity": velocity,
            "heading": heading,
            "battery": self._battery_report(),
            "gps": self._gps_report(),
            "home": {
                "lat": 0.0,
                "lon": 0.0,
                "distance": (
                    float(home_distance) if home_distance is not None else 0.0
                ),
            },
            "link": self._link_report(age_s),
            # Companion-side FC-link health. The orchestrator turns this into
            # a failsafe signal and a healthEvent; it is deliberately NOT a
            # decorative latency number nobody thresholds (FM-08).
            "fcLink": {
                "lost": stale,
                "heartbeatAgeS": float(age_s if math.isfinite(age_s) else 9999.0),
                "telemetryStale": stale,
            },
        }

    # -- orchestrator-facing accessors (poll + translate in one call) -------
    def get_state(self, control_source: str = ControlSource.AUTO.value) -> VehicleState:
        """Drain pending MAVLink and return a fresh ``VehicleState`` snapshot.

        Convenience for the orchestrator's telemetry loop so it doesn't have to
        call ``poll()`` separately. ``control_source`` is stamped by the caller
        (the orchestrator owns the authoritative active control source).
        """
        self.poll()
        return self.vehicle_state(control_source)

    def get_telemetry(
        self,
        control_source: str = ControlSource.AUTO.value,
        *,
        home_distance: Optional[float] = None,
    ) -> dict:
        """Drain pending MAVLink and return a fresh contract ``telemetry`` dict."""
        self.poll()
        return self.read_telemetry(control_source, home_distance=home_distance)

    def health_inputs(self) -> dict[str, Any]:
        """Translate cached MAVLink health rails to plain data for pure logic."""
        sysst = self._msgs.get("SYS_STATUS")
        batt = self._msgs.get("BATTERY_STATUS")
        gps = self._msgs.get("GPS_RAW_INT")
        ekf = self._msgs.get("EKF_STATUS_REPORT") or self._msgs.get("ESTIMATOR_STATUS")
        flow = self._msgs.get("OPTICAL_FLOW_RAD")
        odom = self._msgs.get("ODOMETRY") or self._msgs.get("VISION_POSITION_ESTIMATE")
        wind = self._msgs.get("WIND")

        voltages = []
        if batt is not None:
            for raw in getattr(batt, "voltages", ()):
                if raw not in (0, 65535):
                    voltages.append(float(raw) / 1000.0)
        voltage_v = sum(voltages)
        if voltage_v <= 0.0 and sysst is not None:
            raw_v = getattr(sysst, "voltage_battery", 0)
            voltage_v = float(raw_v) / 1000.0 if raw_v not in (0, 65535) else 0.0
        raw_current = getattr(batt, "current_battery", -1) if batt is not None else (
            getattr(sysst, "current_battery", -1) if sysst is not None else -1
        )
        # -1 is the MAVLink "not measured" sentinel. Collapsing it to 0.0 A
        # made a dead pack sensor look like a vehicle drawing no current, which
        # freezes the coulomb integrator at the last healthy SoC forever
        # (FM-19). Report it as UNKNOWN and let the estimator refuse to
        # integrate.
        current_a: Optional[float] = (
            float(raw_current) / 100.0 if raw_current != -1 else None
        )
        remaining_raw = getattr(batt, "battery_remaining", -1) if batt is not None else (
            getattr(sysst, "battery_remaining", -1) if sysst is not None else -1
        )
        temperature_raw = getattr(batt, "temperature", 0) if batt is not None else 0
        temperature_c = (
            float(temperature_raw) / 100.0
            if temperature_raw not in (0, 32767) else math.nan
        )

        hdop_raw = getattr(gps, "eph", 65535) if gps is not None else 65535
        speed_accuracy_raw = (
            getattr(gps, "vel_acc", getattr(gps, "s_acc", 0xFFFFFFFF))
            if gps is not None else 0xFFFFFFFF
        )
        ekf_flags = int(getattr(ekf, "flags", 0)) if ekf is not None else 0
        attitude_flag = getattr(mavutil.mavlink, "EKF_ATTITUDE", 1) if mavutil else 1
        velocity_flag = getattr(mavutil.mavlink, "EKF_VELOCITY_HORIZ", 2) if mavutil else 2
        relative_flag = getattr(mavutil.mavlink, "EKF_POS_HORIZ_REL", 8) if mavutil else 8
        absolute_flag = getattr(mavutil.mavlink, "EKF_POS_HORIZ_ABS", 16) if mavutil else 16
        ekf_ok = bool(
            ekf_flags & attitude_flag
            and ekf_flags & velocity_flag
            and ekf_flags & (relative_flag | absolute_flag)
        )
        odom_age = math.inf
        if odom is not None:
            odom_type = "ODOMETRY" if self._msgs.get("ODOMETRY") is odom else "VISION_POSITION_ESTIMATE"
            received_at = self._msg_ts.get(odom_type)
            if received_at is not None:
                odom_age = max(0.0, now() - received_at)
        covariance = (
            getattr(odom, "pose_covariance", getattr(odom, "covariance", ()))
            if odom is not None else ()
        )
        position_variance = float(covariance[0]) if covariance else math.inf
        extnav_pose_valid = bool(
            odom is not None
            and all(math.isfinite(float(getattr(odom, axis, math.nan))) for axis in ("x", "y", "z"))
        )
        prearm_bit = getattr(mavutil.mavlink, "MAV_SYS_STATUS_PREARM_CHECK", 1 << 28)
        prearm_healthy = bool(
            sysst is not None
            and int(getattr(sysst, "onboard_control_sensors_present", 0)) & prearm_bit
            and int(getattr(sysst, "onboard_control_sensors_enabled", 0)) & prearm_bit
            and int(getattr(sysst, "onboard_control_sensors_health", 0)) & prearm_bit
        )
        # Battery rail AGE, from the same _msg_ts the nav rails already use. Its
        # absence was the whole of FM-19: the nav dict carried gps/ekf/extnav
        # ages while its sibling battery dict carried none, so a frozen pack
        # sensor was indistinguishable from a live one.
        battery_age_s = min(
            self.message_age_s("BATTERY_STATUS"),
            self.message_age_s("SYS_STATUS"),
        )
        wind_age_s = self.message_age_s("WIND")
        wind_present = wind is not None and wind_age_s <= WIND_MAX_AGE_S
        return {
            "fc_ready": self._fc_ready or prearm_healthy,
            "fc_link_lost": self.fc_link_lost(),
            "fc_heartbeat_age_s": self.fc_heartbeat_age_s(),
            "battery": {
                "voltage_v": voltage_v,
                "current_a": current_a,
                "temp_c": temperature_c,
                "reported_soc_pct": float(remaining_raw) if remaining_raw >= 0 else None,
                "cell_voltages_v": tuple(voltages),
                "age_s": battery_age_s,
                "max_age_s": BATTERY_MAX_AGE_S,
            },
            "nav": {
                "gps_fix": int(getattr(gps, "fix_type", 0)) if gps is not None else 0,
                "gps_sats": int(getattr(gps, "satellites_visible", 0)) if gps is not None else 0,
                "gps_hdop": (
                    float(hdop_raw) / 100.0 if hdop_raw not in (0, 65535) else math.inf
                ),
                "gps_speed_accuracy_mps": (
                    float(speed_accuracy_raw) / 1000.0
                    if speed_accuracy_raw != 0xFFFFFFFF else math.inf
                ),
                "ekf_ok": ekf_ok,
                "gps_age_s": max(0.0, now() - self._msg_ts.get("GPS_RAW_INT", 0.0))
                if "GPS_RAW_INT" in self._msg_ts else math.inf,
                "ekf_age_s": max(0.0, now() - max(
                    self._msg_ts.get("EKF_STATUS_REPORT", 0.0),
                    self._msg_ts.get("ESTIMATOR_STATUS", 0.0),
                )) if (
                    "EKF_STATUS_REPORT" in self._msg_ts
                    or "ESTIMATOR_STATUS" in self._msg_ts
                ) else math.inf,
                "extnav_fresh": extnav_pose_valid and odom_age <= 0.5,
                "extnav_age_s": odom_age,
                "extnav_position_variance_m2": position_variance,
                "optflow_quality": float(getattr(flow, "quality", 0.0)) if flow is not None else 0.0,
                "optflow_innovation_mps": float(
                    getattr(flow, "innovation_mps", math.inf)
                ) if flow is not None else math.inf,
            },
            # A MISSING or STALE wind estimate is NOT calm air (FM-20). None
            # means "no measurement"; the orchestrator refuses to treat it as
            # 0 m/s and says so, instead of silently disabling the wind ladder.
            "wind_mps": (
                float(getattr(wind, "speed", 0.0)) if wind_present else None
            ),
            "wind_age_s": wind_age_s,
            "wind_present": bool(wind_present),
        }

    def sim_truth_inputs(self) -> dict[str, float] | None:
        """Return fresh SITL ground truth, never the EKF position estimate."""
        msg = self._msgs.get("SIMSTATE") or self._msgs.get("SIM_STATE")
        msg_type = "SIMSTATE" if self._msgs.get("SIMSTATE") is msg else "SIM_STATE"
        received_at = self._msg_ts.get(msg_type)
        if msg is None or received_at is None or now() - received_at > 0.5:
            return None
        lat_raw = getattr(msg, "lat", None)
        lon_raw = getattr(msg, "lng", getattr(msg, "lon", None))
        alt_raw = getattr(msg, "alt", None)
        if lat_raw is None or lon_raw is None or alt_raw is None:
            return None
        lat = float(lat_raw) / 1e7 if abs(float(lat_raw)) > 180.0 else float(lat_raw)
        lon = float(lon_raw) / 1e7 if abs(float(lon_raw)) > 180.0 else float(lon_raw)
        alt = float(alt_raw) / 1000.0 if abs(float(alt_raw)) > 10_000.0 else float(alt_raw)
        if not all(math.isfinite(value) for value in (lat, lon, alt)):
            return None
        return {"lat": lat, "lon": lon, "alt_amsl_m": alt, "age_s": now() - received_at}

    def set_ekf_source(self, source: str) -> bool:
        """Issue companion-owned MAV_CMD_SET_EKF_SOURCE_SET (42007)."""
        source_sets = {"gps": 1, "extnav": 2, "optflow": 3}
        if source not in source_sets or not self._connected:
            return False
        command = getattr(mavutil.mavlink, "MAV_CMD_SET_EKF_SOURCE_SET", 42007)
        try:
            self._command_long(command, float(source_sets[source]))
            # Absorbs every non-matching frame it consumes rather than
            # discarding telemetry during the wait (FM-09).
            if self._wait_command_ack(command, timeout_s=1.5):
                return True
            log.warning("EKF source switch to %s not acknowledged", source)
            return False
        except Exception:
            log.exception("EKF source switch to %s failed", source)
            return False

    # ----------------------------------------------------------------------
    # Camera mount (gimbal)
    # ----------------------------------------------------------------------
    # SIGN CONVENTION. The shared contract (and the ARGUS console) report
    # gimbal pitch as -30 = up, 0 = level, +90 = straight DOWN. ArduPilot's
    # mount uses the opposite sign for the same physical angle: 0 = forward,
    # -90 = straight down. So every angle crossing this seam is NEGATED, in
    # both directions. Getting this wrong points the camera at the sky, which
    # is exactly the kind of silent failure a comment is cheaper than.
    def set_gimbal_pitch(
        self, pitch_deg: float, *, use_gimbal_manager: bool = False
    ) -> bool:
        """Command mount pitch, in CONTRACT degrees (+90 = straight down).

        Uses MAV_CMD_DO_MOUNT_CONTROL in MAVLink-targeting mode by default --
        the form the demo airframe answers. ``use_gimbal_manager`` selects the
        newer MAV_CMD_DO_GIMBAL_MANAGER_PITCHYAW instead; the two are not
        interchangeable across firmware, which is why it is a config flag and
        not an autodetect.
        """
        if not self._connected or self._master is None:
            return False
        if not math.isfinite(pitch_deg):
            return False
        mav_pitch = -float(pitch_deg)          # contract -> ArduPilot mount sign
        try:
            if use_gimbal_manager:
                command = getattr(
                    mavutil.mavlink, "MAV_CMD_DO_GIMBAL_MANAGER_PITCHYAW", 1000
                )
                # pitch, yaw, pitch-rate, yaw-rate, flags, _, gimbal device id.
                # NaN rate = "hold this angle" rather than "slew at 0 deg/s".
                self._command_long(
                    command, mav_pitch, 0.0, float("nan"), float("nan"), 0.0, 0.0, 0.0
                )
            else:
                command = getattr(mavutil.mavlink, "MAV_CMD_DO_MOUNT_CONTROL", 205)
                mode = getattr(
                    mavutil.mavlink, "MAV_MOUNT_MODE_MAVLINK_TARGETING", 2
                )
                # pitch, roll, yaw, _, _, _, mount mode
                self._command_long(
                    command, mav_pitch, 0.0, 0.0, 0.0, 0.0, 0.0, float(mode)
                )
            return True
        except Exception:
            log.exception("gimbal pitch command failed")
            return False

    def gimbal_pitch_deg(self) -> Optional[float]:
        """Reported mount pitch in CONTRACT degrees, or ``None`` if unreported.

        Prefers MOUNT_STATUS (centidegrees, ArduPilot sign) and falls back to
        GIMBAL_DEVICE_ATTITUDE_STATUS's quaternion. ``None`` means the mount
        told us nothing -- the caller falls back to the commanded angle rather
        than reporting a fictional 0.
        """
        status = self._msgs.get("MOUNT_STATUS")
        if status is not None:
            raw = getattr(status, "pointing_a", None)
            if raw is not None:
                try:
                    value = -float(raw) / 100.0    # centideg, ArduPilot sign
                except (TypeError, ValueError):
                    value = None
                if value is not None and math.isfinite(value):
                    return value
        attitude = self._msgs.get("GIMBAL_DEVICE_ATTITUDE_STATUS")
        if attitude is not None:
            q = getattr(attitude, "q", None)
            if isinstance(q, (list, tuple)) and len(q) == 4:
                try:
                    w, x, y, z = (float(v) for v in q)
                except (TypeError, ValueError):
                    return None
                sin_pitch = max(-1.0, min(1.0, 2.0 * (w * y - z * x)))
                pitch = math.degrees(math.asin(sin_pitch))
                if math.isfinite(pitch):
                    return -pitch                  # same negation as above
        return None

    def send_distance_sensor(self, distance_m: float, *, sensor_id: int = 0) -> bool:
        """Publish a LiDAR range through DISTANCE_SENSOR."""
        if not self._connected or self._master is None or not math.isfinite(distance_m):
            return False
        cm = int(max(1, min(65534, distance_m * 100.0)))
        try:
            self._master.mav.distance_sensor_send(
                int(time.time() * 1000) & 0xFFFFFFFF,
                20,
                12000,
                cm,
                getattr(mavutil.mavlink, "MAV_DISTANCE_SENSOR_LASER", 0),
                int(sensor_id),
                getattr(mavutil.mavlink, "MAV_SENSOR_ROTATION_NONE", 0),
                0,
            )
            return True
        except Exception:
            log.exception("DISTANCE_SENSOR send failed")
            return False

    def send_obstacle_distance(self, distances_cm: Sequence[int]) -> bool:
        """Publish a 72-bin LiDAR fan for BendyRuler avoidance."""
        if not self._connected or self._master is None:
            return False
        values = [int(max(1, min(65535, value))) for value in distances_cm[:72]]
        values.extend([65535] * (72 - len(values)))
        try:
            self._master.mav.obstacle_distance_send(
                int(time.time() * 1_000_000),
                getattr(mavutil.mavlink, "MAV_DISTANCE_SENSOR_LASER", 0),
                values,
                5,
                20,
                12000,
                0.0,
                getattr(mavutil.mavlink, "MAV_FRAME_BODY_FRD", 12),
            )
            return True
        except Exception:
            log.exception("OBSTACLE_DISTANCE send failed")
            return False

    def send_extnav_odometry(
        self,
        x: float,
        y: float,
        z: float,
        *,
        vx: float = 0.0,
        vy: float = 0.0,
        vz: float = 0.0,
        quality: int = 100,
    ) -> bool:
        """Publish LiDAR-inertial odometry to ArduPilot's extnav rail."""
        values = (x, y, z, vx, vy, vz)
        if not self._connected or self._master is None or not all(map(math.isfinite, values)):
            return False
        try:
            nan_cov = [float("nan")] * 21
            self._master.mav.odometry_send(
                int(time.time() * 1_000_000),
                getattr(mavutil.mavlink, "MAV_FRAME_LOCAL_FRD", 20),
                getattr(mavutil.mavlink, "MAV_FRAME_BODY_FRD", 12),
                float(x), float(y), float(z),
                (1.0, 0.0, 0.0, 0.0),
                float(vx), float(vy), float(vz),
                0.0, 0.0, 0.0,
                nan_cov, nan_cov,
                0,
                max(0, min(100, int(quality))),
            )
            return True
        except Exception:
            log.exception("ODOMETRY send failed")
            return False

    def send_raw_global_target(self, lat: float, lon: float, alt_m: float) -> bool:
        """UNCLAMPED target used only by the orchestrator's gated SITL hook."""
        if not self._connected or self._master is None:
            return False
        if not all(math.isfinite(v) for v in (lat, lon, alt_m)):
            return False
        try:
            self._master.mav.set_position_target_global_int_send(
                int(time.time() * 1000) & 0xFFFFFFFF,
                self._target_system,
                self._target_component,
                mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
                _TYPEMASK_POS_ONLY,
                int(round(lat * 1e7)),
                int(round(lon * 1e7)),
                float(alt_m),
                0.0, 0.0, 0.0,
                0.0, 0.0, 0.0,
                0.0, 0.0,
            )
            return True
        except Exception:
            log.exception("raw out-of-fence target send failed")
            return False

    # ----------------------------------------------------------------------
    # Discrete commands
    # ----------------------------------------------------------------------
    #: COMMAND_LONG carries exactly seven float parameters. Callers pass only
    #: the leading ones they mean; the rest are zero-filled.
    _COMMAND_PARAMS = 7

    def _command_long(self, command: int, *params: float) -> None:
        """Send one COMMAND_LONG, zero-filling the parameters not supplied.

        Raises ``RuntimeError`` when there is no link: a discrete command that
        silently evaporates is worse than one that fails loudly, because the
        caller would report success for a vehicle that never heard it.
        """
        if not self._connected or self._master is None:
            raise RuntimeError("not connected")
        if len(params) > self._COMMAND_PARAMS:
            raise ValueError(
                f"COMMAND_LONG takes at most {self._COMMAND_PARAMS} params, "
                f"got {len(params)}"
            )
        padded = tuple(params) + (0.0,) * (self._COMMAND_PARAMS - len(params))
        self._master.mav.command_long_send(
            self._target_system,
            self._target_component,
            command,
            0,                                  # confirmation
            *padded,
        )

    def _wait_command_ack(self, command: int, timeout_s: float = 2.0) -> bool:
        deadline = time.monotonic() + max(0.0, timeout_s)
        while time.monotonic() < deadline:
            ack = self._recv(type="COMMAND_ACK", timeout=0.25)
            if ack is None:
                if not self._pending_inbox():
                    break        # the fake/real link has nothing more to give
                continue
            if int(getattr(ack, "command", -1)) != int(command):
                continue
            accepted = getattr(mavutil.mavlink, "MAV_RESULT_ACCEPTED", 0)
            return int(getattr(ack, "result", -1)) == int(accepted)
        return False

    def _pending_inbox(self) -> bool:
        """Whether the link might still deliver (True for a real connection).

        A real ``recv_match`` blocks for its timeout, so a ``None`` genuinely
        means "nothing arrived in that window" and we keep waiting until the
        deadline. Test doubles return ``None`` instantly, which would otherwise
        spin this loop for the whole timeout.
        """
        inbox = getattr(self._master, "inbox", None)
        if inbox is None:
            return True
        return bool(inbox)

    #: ArduPilot's "yes, I really mean it" magic number in param2 of
    #: MAV_CMD_COMPONENT_ARM_DISARM. It bypasses prearm checks when arming and
    #: permits an in-flight kill when disarming, so it is never a default.
    _FORCE_MAGIC: float = 21196.0

    def _set_motor_state(self, running: bool, *, force: bool) -> bool:
        """Arm (``running``) or disarm, and report the FC's ACTUAL verdict.

        One command with one parameter of difference, so the arm and disarm
        paths cannot drift: a fix to the ack handling of one is a fix to both.
        """
        command = mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM
        self._command_long(
            command,
            1.0 if running else 0.0,
            self._FORCE_MAGIC if force else 0.0,
        )
        return self._wait_command_ack(command)

    def arm(self, *, force: bool = False) -> bool:
        """Arm the motors; ``force=True`` bypasses prearm checks (emergency).

        SAFETY: run the SafetyManager arming checklist BEFORE calling this.
        ``force`` exists for the emergency path only -- it is the operator
        asserting that the FC's own refusal is the wrong answer.
        """
        return self._set_motor_state(True, force=force)

    def disarm(self, *, force: bool = False) -> bool:
        """Disarm the motors; ``force=True`` cuts them even when airborne.

        emergencyStop on the ground uses ``force=True``: no confirmation, and
        it overrides everything else in flight.
        """
        return self._set_motor_state(False, force=force)

    def set_mode(
        self,
        mode: str,
        *,
        verify: bool = True,
        timeout_s: float = 1.5,
        attempts: int = 3,
    ) -> bool:
        """Set the flight mode by ArduCopter name and VERIFY it actually took.

        Returns True only when the FC is OBSERVED in ``mode``: either it
        already was, or a COMMAND_ACK accepted our DO_SET_MODE, or a HEARTBEAT
        came back carrying the requested ``custom_mode``. Returns False if the
        mode name is unknown to this FC's mapping, or if every attempt went
        unconfirmed.

        Why the readback exists (FM-02): ``set_mode_send`` is fire-and-forget.
        Returning True unconditionally made every rung of the failsafe ladder,
        plus engageManual and executePlan, believe a refused or dropped mode
        change had succeeded -- the vehicle stays in GUIDED while telemetry
        reports ``failsafeState=rtl``. ArduCopter refuses RTL without a home
        position, GUIDED with an unhealthy EKF, and LAND while disarmed; all
        three used to read as success.

        ``verify=False`` restores the old fire-and-forget behaviour for callers
        that genuinely cannot block. Nothing on the failsafe path uses it.
        """
        if not self._connected or self._master is None:
            raise RuntimeError("not connected")
        mode_id = self._resolve_mode_id(mode)
        if mode_id is None:
            return False
        mode = str(mode).upper()

        if self._observed_custom_mode() == mode_id:
            return True

        do_set_mode = getattr(mavutil.mavlink, "MAV_CMD_DO_SET_MODE", 176)
        custom_flag = mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED
        for attempt in range(max(1, int(attempts))):
            try:
                self._master.mav.set_mode_send(
                    self._target_system, custom_flag, mode_id,
                )
            except Exception:
                log.exception("set_mode(%s) send failed", mode)
                return False
            if not verify:
                return True
            if self._await_mode(mode_id, do_set_mode, timeout_s):
                return True
            # Escalate to the COMMAND_LONG form, which some firmware answers
            # when the legacy SET_MODE is ignored, and which yields an ACK.
            try:
                self._command_long(
                    do_set_mode, float(custom_flag), float(mode_id),
                )
            except Exception:
                log.exception("set_mode(%s) DO_SET_MODE send failed", mode)
                break
            if self._await_mode(mode_id, do_set_mode, timeout_s):
                return True
            log.warning(
                "set_mode(%s) unconfirmed after attempt %d/%d",
                mode, attempt + 1, max(1, int(attempts)),
            )
        log.error("set_mode(%s) NOT confirmed by the flight controller", mode)
        return False

    def _resolve_mode_id(self, mode: str) -> Optional[int]:
        """This FC's ``custom_mode`` number for ``mode``, or ``None``.

        The map is fetched at connect; a link that came up before pymavlink
        could decode it leaves us with an empty map, so one lazy refetch is
        attempted here. ``None`` -- a name this firmware does not have -- is
        REFUSED rather than guessed: sending a fabricated mode number is how a
        failsafe rung silently becomes a different mode.
        """
        name = str(mode).upper()
        if not self._mode_mapping:
            self._load_mode_mapping()
        number = self._mode_mapping.get(name)
        if number is None:
            log.warning("set_mode(%s) refused: unknown to this FC's mode map", name)
            return None
        return int(number)

    def _observed_custom_mode(self) -> Optional[int]:
        """The custom_mode from the newest cached HEARTBEAT, or None."""
        hb = self._msgs.get("HEARTBEAT")
        if hb is None:
            return None
        try:
            return int(getattr(hb, "custom_mode", -1))
        except (TypeError, ValueError):
            return None

    def _await_mode(self, mode_id: int, command: int, timeout_s: float) -> bool:
        """Wait for a HEARTBEAT carrying ``mode_id`` (or an accepted ACK)."""
        accepted = getattr(mavutil.mavlink, "MAV_RESULT_ACCEPTED", 0)
        deadline = time.monotonic() + max(0.0, float(timeout_s))
        while True:
            msg = self._recv(type=["HEARTBEAT", "COMMAND_ACK"], timeout=0.2)
            if msg is not None:
                mtype = msg.get_type()
                if mtype == "HEARTBEAT" and self._observed_custom_mode() == mode_id:
                    return True
                if (
                    mtype == "COMMAND_ACK"
                    and int(getattr(msg, "command", -1)) == int(command)
                    and int(getattr(msg, "result", -1)) == int(accepted)
                ):
                    return True
            elif not self._pending_inbox():
                return self._observed_custom_mode() == mode_id
            if time.monotonic() >= deadline:
                return self._observed_custom_mode() == mode_id

    def takeoff(self, alt: float) -> bool:
        """Ensure GUIDED, then NAV_TAKEOFF to ``alt`` metres above home.

        Returns False when GUIDED could not be CONFIRMED -- and in that case
        nothing is sent at all, because a NAV_TAKEOFF issued from an
        unconfirmed mode is a climb command aimed at a vehicle that may not be
        listening. Arming is the caller's job; ArduCopter refuses takeoff on a
        disarmed vehicle anyway.
        """
        if not self.set_mode("GUIDED"):
            log.warning("takeoff refused: GUIDED was not confirmed")
            return False
        command = mavutil.mavlink.MAV_CMD_NAV_TAKEOFF
        # param7 is the only one NAV_TAKEOFF reads for a copter: altitude.
        self._command_long(command, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, float(alt))
        return self._wait_command_ack(command)

    def _enter_mode(self, mode: str) -> bool:
        """A discrete mode command, reported as OBSERVED rather than as sent."""
        if self.set_mode(mode):
            return True
        log.warning("%s command failed: the FC never confirmed the mode", mode)
        return False

    def land(self) -> bool:
        """LAND: descend and disarm where we are."""
        return self._enter_mode("LAND")

    def rtl(self) -> bool:
        """RTL: climb to RTL_ALT, return to launch, land."""
        return self._enter_mode("RTL")

    def brake(self) -> bool:
        """BRAKE: stop and hold position aggressively."""
        return self._enter_mode("BRAKE")

    # ----------------------------------------------------------------------
    # Velocity setpoint streaming (the guidance + manual output path)
    # ----------------------------------------------------------------------
    def _velocity_frame(self, setpoint: VelocitySetpoint) -> tuple:
        """The SET_POSITION_TARGET_LOCAL_NED argument tuple for one setpoint.

        Built in one place so the commanded frame and the zero-hold fallback
        below cannot disagree about field order, frame or type mask.
        """
        return (
            0,                                  # time_boot_ms (0 = now)
            self._target_system,
            self._target_component,
            mavutil.mavlink.MAV_FRAME_BODY_NED,
            _TYPEMASK_VEL_YAWRATE,
            0.0, 0.0, 0.0,                      # x, y, z position (ignored)
            setpoint.vx, setpoint.vy, setpoint.vz,        # velocity (m/s)
            0.0, 0.0, 0.0,                      # ax, ay, az accel (ignored)
            0.0,                                # yaw angle (ignored)
            math.radians(setpoint.yaw_rate),    # yaw_rate: deg/s -> rad/s
        )

    def send_body_velocity(
        self,
        vx: "float | VelocitySetpoint" = 0.0,
        vy: float = 0.0,
        vz: float = 0.0,
        yaw_rate: float = 0.0,
        *,
        valid: bool = True,
    ) -> None:
        """Stream one BODY-frame velocity setpoint to the FC.

        Accepts EITHER component arguments ``(vx, vy, vz, yaw_rate, valid=)``
        -- the orchestrator's call form -- OR a single ``VelocitySetpoint`` as
        the first positional argument, which is how ``hold()`` calls it.

        Axes are MAV_FRAME_BODY_NED: vx forward, vy right, vz down, in m/s,
        with yaw_rate in deg/s clockwise-positive (converted to rad/s on the
        way out). ``valid=False`` is a zero-velocity HOLD, and it is still
        SENT: ArduPilot's GUIDED controller holds actively when it keeps
        receiving zeros, and coasts on the last target when the stream stops.
        Call it at 10-20 Hz for that reason.

        SAFETY -- this is the FC-egress half of "clamped twice". The setpoint
        is folded through ``mavlink.safety.clamp_body_velocity`` against this
        Vehicle's ``Limits`` immediately before the wire: bounds can only be
        tightened, never raised above what guidance/manual already produced,
        and a non-finite value on ANY axis collapses the whole frame to the
        zero hold rather than to a bound. A send that raises falls back to one
        zero-hold frame, because "stop" is the only safe default here.
        """
        if not self._connected or self._master is None:
            return

        requested = vx if hasattr(vx, "vx") else VelocitySetpoint(
            vx=float(vx), vy=float(vy), vz=float(vz),
            yaw_rate=float(yaw_rate), valid=bool(valid),
        )
        bounded = clamp_body_velocity(requested, self._limits)

        send = self._master.mav.set_position_target_local_ned_send
        try:
            send(*self._velocity_frame(bounded))
        except Exception:
            try:
                send(*self._velocity_frame(VelocitySetpoint.hold()))
            except Exception:
                log.debug(
                    "velocity setpoint and its zero-hold retry both failed",
                    exc_info=True,
                )

    def hold(self) -> None:
        """Send a single zero-velocity hold frame (the canonical safe output)."""
        self.send_body_velocity(VelocitySetpoint.hold())

    # ----------------------------------------------------------------------
    # GUIDED global position targets (the mission-planner output path)
    # ----------------------------------------------------------------------
    def goto_global(
        self,
        lat: float,
        lon: float,
        rel_alt: float,
        speed: float,
        *,
        limits: Optional[Limits] = None,
    ) -> bool:
        """Fly to a global position in GUIDED: SET_POSITION_TARGET_GLOBAL_INT.

        Sends a position-only target in MAV_FRAME_GLOBAL_RELATIVE_ALT_INT
        (lat/lon 1e7-scaled ints, altitude metres relative to home). The
        groundspeed for the leg is set FIRST via MAV_CMD_DO_CHANGE_SPEED
        (param1=1 groundspeed, param3=-1 throttle unchanged): ArduPilot GUIDED
        honours DO_CHANGE_SPEED as the horizontal speed limit for subsequent
        position targets, whereas the velocity fields of a position target are
        a feed-forward term, not a cruise-speed cap -- so those stay masked out
        (``_TYPEMASK_POS_ONLY``).

        SAFETY -- this is the FC-egress clamp for the planner path, which
        bypasses the orchestrator's per-tick body-velocity clamp entirely, so
        for global targets this IS the second stage of "clamped twice".
        ``mavlink.safety.clamp_goto_target`` folds ``speed`` into
        ``[0, Limits.max_speed]`` (never raised) and ``rel_alt`` into
        ``[0, Limits.max_altitude]``.

        A clamped speed of <= 0 REFUSES THE WHOLE LEG rather than sending a
        "correct" zero: ArduPilot DENIES a non-positive DO_CHANGE_SPEED, so
        the position target that followed would fly at the FC's previous or
        default guided speed (SITL's WPNAV_SPEED is 10 m/s, above the 8 m/s
        hard cap) instead of not moving. Nothing goes on the wire and the
        caller should hold.

        Bad coordinates -- non-numeric, non-finite or out of range -- are
        likewise refused with nothing sent, never coerced toward (0, 0).

        Mode and preconditions stay the caller's business, and repeating a
        target is harmless: ArduPilot latches the last one.

        Returns True when the target was sent, False otherwise. Never raises.
        """
        if not self._connected or self._master is None:
            log.warning("goto_global refused: not connected")
            return False

        fix = _global_coordinates(lat, lon)
        if fix is None:
            log.warning("goto_global refused: unusable lat/lon %r/%r", lat, lon)
            return False
        lat_f, lon_f = fix

        envelope = limits if limits is not None else self._limits
        speed_c, alt_c = clamp_goto_target(speed, rel_alt, envelope)

        if speed_c <= 0.0:
            log.warning(
                "goto_global refused: leg speed %r clamps to %.3f <= 0 "
                "(no motion) -- position target not sent", speed, speed_c,
            )
            return False

        try:
            # 1. Leg groundspeed (GUIDED honours DO_CHANGE_SPEED).
            self._command_long(
                mavutil.mavlink.MAV_CMD_DO_CHANGE_SPEED,
                1.0,          # param1: speed type 1 = groundspeed
                speed_c,      # param2: speed m/s (already clamped)
                -1.0,         # param3: throttle unchanged
            )
            # 2. The position target itself.
            self._master.mav.set_position_target_global_int_send(
                0,                              # time_boot_ms (0 = now)
                self._target_system,
                self._target_component,
                mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
                _TYPEMASK_POS_ONLY,
                int(round(lat_f * 1e7)),        # lat_int (degE7)
                int(round(lon_f * 1e7)),        # lon_int (degE7)
                float(alt_c),                   # alt (m, relative to home)
                0.0, 0.0, 0.0,                  # vx, vy, vz (ignored)
                0.0, 0.0, 0.0,                  # ax, ay, az (ignored)
                0.0,                            # yaw (ignored)
                0.0,                            # yaw_rate (ignored)
            )
        except Exception:
            log.exception("goto_global send failed")
            return False
        return True

    # ----------------------------------------------------------------------
    # Parameter writes (best-effort, never fatal)
    # ----------------------------------------------------------------------
    def _await_param_echo(self, name: str, timeout: float) -> Any:
        """Wait for the PARAM_VALUE the FC sends for ``name``; ``None`` on silence.

        The FC streams PARAM_VALUE for parameters nobody asked about, so this
        keeps reading -- caching everything it consumes, like every other
        blocking wait in this module (FM-09) -- until the named one arrives or
        the window closes. It returns the MESSAGE, not a value: the two
        callers disagree about what an echo without a value means.
        """
        deadline = time.monotonic() + max(0.0, float(timeout))
        while True:
            msg = self._recv(type="PARAM_VALUE", timeout=timeout)
            if msg is None:
                # Nothing arrived. A real link may still deliver until the
                # deadline; a drained test double never will.
                if not self._pending_inbox() or time.monotonic() >= deadline:
                    return None
                continue
            if _param_name(msg) == name:
                return msg
            if time.monotonic() >= deadline:
                return None

    def set_param(
        self,
        name: str,
        value: float,
        *,
        retries: int = 3,
        timeout: float = 1.0,
    ) -> bool:
        """PARAM_SET ``name`` = ``value``, and VERIFY the echo BY VALUE.

        The echo is matched on param_id AND param_value (FM-14). ArduPilot
        echoes the value it ACTUALLY STORED, so a write it refused or clamped
        comes back carrying the OLD number. Matching on the name alone reports
        success for a parameter that never changed -- which is exactly how a
        geofence can read as "enabled" while the firmware still holds
        FENCE_ENABLE=0.

        The three outcomes are deliberately different:
          * echo matches      -> True, immediately;
          * echo DISAGREES    -> False, immediately. The FC has answered; a
            retry would only ask a settled question again;
          * silence, or an echo with no value at all -> retry, then False.

        Best-effort and NEVER raises: a SITL build missing some parameter must
        not take the FC connection down with it.
        """
        if not self._connected or self._master is None:
            log.warning("set_param(%s) skipped: not connected", name)
            return False
        want = float(value)
        try:
            for _ in range(max(1, int(retries))):
                self._master.mav.param_set_send(
                    self._target_system,
                    self._target_component,
                    name.encode("ascii"),
                    want,
                    mavutil.mavlink.MAV_PARAM_TYPE_REAL32,
                )
                echo = self._await_param_echo(name, timeout)
                if echo is None:
                    continue                    # silence: write again
                stored = getattr(echo, "param_value", None)
                if stored is None:
                    # An echo with no value proves nothing, so we claim
                    # nothing -- and ask again.
                    log.warning(
                        "set_param(%s) echo carried no value; treating as "
                        "unverified", name,
                    )
                    continue
                if _close(float(stored), want):
                    return True
                log.warning(
                    "set_param(%s=%s) REFUSED/CLAMPED by the FC: it stored %s",
                    name, want, stored,
                )
                return False
        except Exception:
            log.exception("set_param(%s) failed", name)
            return False
        log.warning("set_param(%s=%s) not acknowledged; continuing", name, value)
        return False

    def get_param(self, name: str, *, timeout: float = 1.0) -> Optional[float]:
        """PARAM_REQUEST_READ ``name``; return the value the FC reports.

        ``None`` means "the FC did not tell us" -- a silence, a malformed
        echo, or no link. It is never a fabricated default, because a caller
        that cannot tell those apart will treat an unset parameter as a
        configured one.
        """
        if not self._connected or self._master is None:
            return None
        try:
            self._master.mav.param_request_read_send(
                self._target_system,
                self._target_component,
                name.encode("ascii"),
                -1,                             # -1 = look the name up, not an index
            )
        except Exception:
            log.exception("get_param(%s) request failed", name)
            return None
        echo = self._await_param_echo(name, timeout)
        if echo is None:
            return None
        try:
            return float(getattr(echo, "param_value"))
        except (AttributeError, TypeError, ValueError):
            return None

    def apply_failsafe_params(
        self,
        *,
        cell_count: int = 4,
        geofence_radius_m: Optional[float] = None,
    ) -> Tuple[int, int, list]:
        """Push the derived safety envelope to the FLIGHT CONTROLLER.

        ``mavlink.safety.failsafe_param_map`` derives FENCE_*, BATT_FS_*,
        FS_GCS_*, RTL_ALT and the WPNAV speed caps from the SAME ``Limits`` the
        software clamps use. Until this method existed nothing called it: the
        map was a documentation table, the FC kept its ``.parm`` defaults, and
        the "clamped twice" invariant had no firmware half (FM-16).

        Returns ``(applied, attempted, failures)``. Never raises: a param this
        firmware does not have is a failure to report, not a reason to drop the
        FC connection.
        """
        from .safety import failsafe_param_map

        params = failsafe_param_map(
            self._limits,
            cell_count=cell_count,
            geofence_radius_m=geofence_radius_m,
        )
        failures: list = []
        applied = 0
        for name, value in params.items():
            try:
                ok = self.set_param(name, float(value))
            except Exception:
                ok = False
            if ok:
                applied += 1
            else:
                failures.append(name)
        if failures:
            log.warning(
                "failsafe params: %d/%d applied; unconfirmed: %s",
                applied, len(params), ", ".join(failures),
            )
        else:
            log.info("failsafe params: all %d applied and verified", applied)
        return applied, len(params), failures

    # ----------------------------------------------------------------------
    # Geofence upload (site perimeter -> ArduPilot polygon inclusion fence)
    # ----------------------------------------------------------------------
    def fence_status(self) -> dict:
        """What we can PROVE about the FC's fence, not what we hoped.

        ``stored``/``enabled`` are tri-state: ``None`` means "unknown / not
        attempted". ``enforced`` is True only when the polygon transfer was
        accepted AND FENCE_ENABLE was read back as 1. The orchestrator gates
        dispatch on this instead of on an unread boolean (FM-14 / FM-15).
        """
        return {
            "stored": self._fence_stored,
            "enabled": self._fence_enabled,
            "enforced": bool(self._fence_stored and self._fence_enabled),
            "detail": self._fence_detail,
        }

    def upload_geofence(
        self,
        perimeter: Sequence[Tuple[float, float]],
        *,
        item_timeout: float = 2.0,
        exclusions: Sequence[Sequence[Tuple[float, float]]] = (),
    ) -> bool:
        """Upload ``perimeter`` as an ArduPilot polygon INCLUSION fence.

        The orchestrator calls this once after ``connect()`` with the loaded
        site perimeter (list of ``(lat, lon)`` tuples, open ring) -- this
        module never reads the site file itself.

        Uses the MAVLink mission protocol with MAV_MISSION_TYPE_FENCE:
        MISSION_COUNT, answer each MISSION_REQUEST(_INT) with a
        MISSION_ITEM_INT of MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION
        (param1 = total vertex count, x/y = degE7), then wait for the final
        MISSION_ACK. On success, best-effort PARAM_SET of FENCE_TYPE=5
        (bit0 max-altitude + bit2 polygon; the circle bit is deliberately
        dropped -- a 60 m circle would fight a plant-scale polygon) and
        FENCE_ENABLE=1.

        Graceful on SITL quirks: a NACK, a timeout, or an unacknowledged param
        logs and returns False (or True with a warning when only the params
        went unanswered) -- it NEVER raises, so a fence hiccup cannot take the
        FC connection down.

        Returns True when the FC accepted the fence upload.
        """
        try:
            if not self._connected or self._master is None:
                log.warning("upload_geofence skipped: not connected")
                self._note_fence(False, False, "no FC link; no fence uploaded")
                return False

            ring = list(perimeter)
            if len(ring) < 3:
                log.warning(
                    "upload_geofence refused: perimeter needs >= 3 vertices, got %d",
                    len(ring),
                )
                self._note_fence(
                    False, False,
                    f"perimeter needs >= 3 vertices, got {len(ring)}",
                )
                return False
            for latlon in ring:
                lat_f, lon_f = float(latlon[0]), float(latlon[1])
                if not (math.isfinite(lat_f) and math.isfinite(lon_f)):
                    log.warning("upload_geofence refused: non-finite vertex %r", latlon)
                    self._note_fence(False, False, "perimeter has a non-finite vertex")
                    return False
                if not (-90.0 <= lat_f <= 90.0 and -180.0 <= lon_f <= 180.0):
                    log.warning("upload_geofence refused: vertex out of range %r", latlon)
                    self._note_fence(
                        False, False, "perimeter has an out-of-range vertex"
                    )
                    return False

            inclusion = getattr(
                mavutil.mavlink, "MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION", 5001
            )
            exclusion = getattr(
                mavutil.mavlink, "MAV_CMD_NAV_FENCE_POLYGON_VERTEX_EXCLUSION", 5002
            )
            # One flat item list: the inclusion perimeter first, then every
            # NFZ as its own EXCLUSION polygon. NFZs used to reach the firmware
            # nowhere at all -- a breach INSIDE the perimeter triggered nothing
            # (FM-13).
            items: list = [
                (inclusion, float(len(ring)), latlon) for latlon in ring
            ]
            zones = 0
            for zone in exclusions or ():
                poly = [tuple(v) for v in zone]
                if len(poly) < 3 or not all(
                    math.isfinite(float(v[0])) and math.isfinite(float(v[1]))
                    and -90.0 <= float(v[0]) <= 90.0 and -180.0 <= float(v[1]) <= 180.0
                    for v in poly
                ):
                    log.warning(
                        "upload_geofence: skipping malformed exclusion polygon %r", poly
                    )
                    continue
                zones += 1
                items.extend((exclusion, float(len(poly)), latlon) for latlon in poly)

            count = len(items)
            self._master.mav.mission_count_send(
                self._target_system,
                self._target_component,
                count,
                mavutil.mavlink.MAV_MISSION_TYPE_FENCE,
            )

            sent = 0
            while sent < count:
                msg = self._recv(
                    type=["MISSION_REQUEST", "MISSION_REQUEST_INT", "MISSION_ACK"],
                    timeout=item_timeout,
                )
                if msg is None:
                    log.warning(
                        "upload_geofence: no MISSION_REQUEST after item %d/%d; "
                        "giving up (fence NOT loaded)", sent, count,
                    )
                    self._note_fence(False, None, "no MISSION_REQUEST from the FC")
                    return False
                if msg.get_type() == "MISSION_ACK":
                    # An early ack mid-transfer is a rejection.
                    log.warning(
                        "upload_geofence: FC rejected transfer early (MISSION_ACK "
                        "type=%s)", getattr(msg, "type", "?"),
                    )
                    self._note_fence(False, None, "FC rejected the fence transfer")
                    return False
                seq = int(getattr(msg, "seq", sent))
                if not 0 <= seq < count:
                    log.warning("upload_geofence: FC requested bad seq %d", seq)
                    self._note_fence(False, None, f"FC requested bad seq {seq}")
                    return False
                command, vertex_count, latlon = items[seq]
                lat_f, lon_f = float(latlon[0]), float(latlon[1])
                # ArduPilot accepts MISSION_ITEM_INT replies to either request
                # flavour (it speaks the INT protocol).
                self._master.mav.mission_item_int_send(
                    self._target_system,
                    self._target_component,
                    seq,
                    mavutil.mavlink.MAV_FRAME_GLOBAL,
                    command,
                    0,                          # current
                    0,                          # autocontinue
                    vertex_count,               # param1: polygon vertex count
                    0.0, 0.0, 0.0,              # param2..4 (unused)
                    int(round(lat_f * 1e7)),    # x: lat degE7
                    int(round(lon_f * 1e7)),    # y: lon degE7
                    0.0,                        # z (unused for fence vertices)
                    mavutil.mavlink.MAV_MISSION_TYPE_FENCE,
                )
                sent += 1

            ack = self._recv(type="MISSION_ACK", timeout=item_timeout)
            if ack is None:
                log.warning("upload_geofence: no final MISSION_ACK; fence state unknown")
                self._note_fence(None, None, "no final MISSION_ACK; fence state unknown")
                return False
            if int(getattr(ack, "type", -1)) != int(
                mavutil.mavlink.MAV_MISSION_ACCEPTED
            ):
                log.warning(
                    "upload_geofence: FC NACKed fence (MISSION_ACK type=%s)",
                    getattr(ack, "type", "?"),
                )
                self._note_fence(False, None, "FC NACKed the fence")
                return False

            log.info(
                "upload_geofence: %d-vertex inclusion fence + %d exclusion zone(s) "
                "accepted", len(ring), zones,
            )

            # STORED is not ENFORCED. FENCE_TYPE selects which fences are armed
            # and FENCE_ENABLE arms them; both echoes are now VERIFIED, and the
            # outcome is recorded so the orchestrator can gate on it instead of
            # discarding it (FM-14 / FM-15).
            # FENCE_TYPE bit0=max-alt(1) | bit2=polygon(4) -> 5.
            type_ok = self.set_param("FENCE_TYPE", 5.0)
            enable_ok = self.set_param("FENCE_ENABLE", 1.0)
            if type_ok and enable_ok:
                self._note_fence(
                    True, True,
                    f"{len(ring)}-vertex inclusion fence + {zones} exclusion "
                    f"zone(s) stored and ENABLED",
                )
            else:
                unverified = ", ".join(
                    name for name, ok in
                    (("FENCE_TYPE", type_ok), ("FENCE_ENABLE", enable_ok)) if not ok
                )
                self._note_fence(
                    True, False,
                    f"fence STORED but NOT verified as enabled ({unverified} "
                    f"unconfirmed) -- the FC may not enforce it",
                )
            # The polygon reached the FC; whether it is ARMED is fence_status().
            return True
        except Exception:
            log.exception("upload_geofence failed; continuing without FC fence")
            self._note_fence(False, None, "geofence upload raised")
            return False

    def _note_fence(
        self, stored: Optional[bool], enabled: Optional[bool], detail: str
    ) -> None:
        self._fence_stored = stored
        self._fence_enabled = enabled
        self._fence_detail = detail


# --------------------------------------------------------------------------
# Wire-level helpers
# --------------------------------------------------------------------------
#: MAVLink pads a param_id to 16 bytes with NULs; pymavlink may hand it back
#: as bytes or as an already-decoded str depending on the dialect build.
_PARAM_ID_PAD = "\x00"

#: Closed WGS-84 bounds. A coordinate outside them is a bug upstream, not a
#: place, and is refused rather than wrapped.
_LAT_RANGE = (-90.0, 90.0)
_LON_RANGE = (-180.0, 180.0)


def _param_name(msg: Any) -> str:
    """A PARAM_VALUE's param_id as a plain, unpadded ``str``."""
    raw = getattr(msg, "param_id", "")
    if isinstance(raw, (bytes, bytearray)):
        raw = bytes(raw).decode("ascii", errors="replace")
    return str(raw).rstrip(_PARAM_ID_PAD)


def _close(a: float, b: float, *, rel: float = 1e-3, abs_tol: float = 1e-3) -> bool:
    """Equality for a PARAM_VALUE echo, at REAL32 round-trip tolerance."""
    try:
        return math.isclose(float(a), float(b), rel_tol=rel, abs_tol=abs_tol)
    except (TypeError, ValueError):
        return False


def _in_range(value: float, bounds: Tuple[float, float]) -> bool:
    low, high = bounds
    return low <= value <= high


def _global_coordinates(lat: Any, lon: Any) -> Optional[Tuple[float, float]]:
    """``(lat, lon)`` as finite, in-range degrees, or ``None`` if unusable.

    ``None`` is the only safe answer for a coordinate we cannot read: the
    numeric alternative is (0, 0), a real place in the Gulf of Guinea, and
    "fly to the null island" is not a degraded version of "do not fly".
    """
    try:
        lat_f, lon_f = float(lat), float(lon)
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(lat_f) and math.isfinite(lon_f)):
        return None
    if not (_in_range(lat_f, _LAT_RANGE) and _in_range(lon_f, _LON_RANGE)):
        return None
    return lat_f, lon_f


__all__ = ["Vehicle"]
