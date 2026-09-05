"""
============================================================================
Eye in the Sky -- COMPANION FC connection (pymavlink)
----------------------------------------------------------------------------
``Vehicle`` is a thin, defensive wrapper over ``pymavlink.mavutil`` that the
orchestrator uses to talk to the ArduPilot flight controller:

  * connect over UDP (SITL: ``udp:127.0.0.1:14550``) or serial (hardware:
    ``/dev/ttyTHS1``), wait for the heartbeat, and request the data streams we
    need at ~10 Hz;
  * cache the latest of each interesting MAVLink message and translate them
    into the contract ``telemetry`` dict (shared.py shapes) plus a
    ``VehicleState`` snapshot the control core reasons about;
  * run the discrete command set (arm/disarm/setMode/takeoff/land/rtl); and
  * stream BODY-frame velocity setpoints (``VelocitySetpoint``) as
    SET_POSITION_TARGET_LOCAL_NED at 10-20 Hz.

This is the ONLY companion module (besides packaging) allowed to import
hardware libraries. Pure-logic guidance/manual/safety never import this.

Frame & unit conventions
  VelocitySetpoint is BODY frame: vx fwd(+)/back(-), vy right(+)/left(-),
  vz down(+)/up(-) m/s, yaw_rate deg/s (clockwise +). We send it in
  MAV_FRAME_BODY_NED which already matches (x fwd, y right, z down); yaw_rate is
  converted deg/s -> rad/s for the wire. valid=False -> zero-velocity hold.

SAFETY: ``send_body_velocity`` does NOT itself clamp to ``Limits`` -- clamping
is the guidance/manual layer's job (it owns the envelope and the standoff hard
limit). This layer simply refuses to send a non-finite or absurd value and
treats ``valid=False`` as a hard zero hold. Defaults to the safe (zero) command
on any error.
============================================================================
"""
from __future__ import annotations

import math
import time
from typing import Any, Optional

from eis_companion.types import (
    ControlSource,
    VehicleState,
    VelocitySetpoint,
    now,
)

# pymavlink is hardware-facing; import lazily-tolerant so that merely importing
# this module on a dev box without it gives a clear error only when used.
try:  # pragma: no cover - import guard
    from pymavlink import mavutil
    from pymavlink.dialects.v20 import ardupilotmega as mavlink2  # noqa: F401
    _HAVE_PYMAVLINK = True
except Exception:  # pragma: no cover - import guard
    mavutil = None  # type: ignore
    _HAVE_PYMAVLINK = False


# Sentinel for "no SET_POSITION_TARGET_LOCAL_NED for position/accel": all the
# position + acceleration + yaw(angle) bits set to ignore, leaving only the
# velocity components and yaw_rate active.
#   bit0..2  = x,y,z position    (ignore)
#   bit3..5  = vx,vy,vz velocity (USE)
#   bit6..8  = ax,ay,az accel    (ignore)
#   bit9     = force
#   bit10    = yaw   (angle)     (ignore)
#   bit11    = yaw_rate          (USE)
# So mask = position(0b111) | accel(0b111000000) | yaw(0b10000000000)
#         leaving velocity + yaw_rate active.
_TYPEMASK_VEL_YAWRATE = (
    (1 << 0) | (1 << 1) | (1 << 2)          # ignore position
    | (1 << 6) | (1 << 7) | (1 << 8)        # ignore acceleration
    | (1 << 9)                              # ignore force
    | (1 << 10)                             # ignore yaw angle
    # bit 3,4,5 (velocity) and bit 11 (yaw_rate) are left ENABLED (0)
)

# Data streams we ask the FC to emit, and the rate (Hz). ArduPilot honours
# REQUEST_DATA_STREAM; on newer firmware SET_MESSAGE_INTERVAL is preferred, so
# we send both for robustness.
_STREAM_RATE_HZ = 10


class Vehicle:
    """Pymavlink connection to the ArduPilot FC.

    Not thread-safe by itself: call ``poll()`` / ``read_telemetry()`` /
    ``send_body_velocity()`` from a single control loop. If you fan out, guard
    with your own lock.
    """

    def __init__(
        self,
        connection: str = "udp:127.0.0.1:14550",
        *,
        baud: int = 115200,
        source_system: int = 255,
        target_system: int = 1,
    ) -> None:
        # Connection parameters may be supplied at construction (the orchestrator
        # builds Vehicle(connection=..., baud=..., source_system=..., target_system=...))
        # and reused by a no-arg connect(); they can still be overridden per-call.
        self._connection = connection
        self._init_baud = baud
        self._init_source_system = source_system
        self._master: Any = None
        self._connected: bool = False
        self._target_system: int = target_system
        self._target_component: int = 1
        # Latest cached message of each type we care about (raw mavlink objs).
        self._msgs: dict[str, Any] = {}
        self._mode_mapping: dict[str, int] = {}
        self._inv_mode_mapping: dict[int, str] = {}
        self._last_heartbeat_ts: float = 0.0
        self._link_latency_ms: float = 0.0

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
        """Open the link, wait for the first heartbeat, request data streams.

        Args:
          connection_string: ``udp:127.0.0.1:14550`` (SITL) or a serial device
            like ``/dev/ttyTHS1`` (hardware). pymavlink infers the type from the
            scheme; a bare device path is treated as serial.
          baud: serial baud (ignored for UDP/TCP).
          source_system: our MAVLink system id. 255 = a GCS-style id so we don't
            collide with the autopilot (1) or another companion.
          wait_heartbeat_timeout: seconds to wait for the first heartbeat.
        """
        if not _HAVE_PYMAVLINK:
            raise RuntimeError(
                "pymavlink is not installed; Vehicle requires it. "
                "(Pure-logic modules must not import this layer.)"
            )

        # Fall back to the construction-time connection params when not given.
        conn = connection_string or self._connection
        baud = self._init_baud if baud is None else baud
        source_system = self._init_source_system if source_system is None else source_system

        self._master = mavutil.mavlink_connection(
            conn,
            baud=baud,
            source_system=source_system,
            autoreconnect=True,
        )

        hb = self._master.wait_heartbeat(timeout=wait_heartbeat_timeout)
        if hb is None:
            raise TimeoutError(
                f"no heartbeat from FC on {conn} within "
                f"{wait_heartbeat_timeout:.0f}s"
            )

        self._target_system = self._master.target_system
        self._target_component = self._master.target_component
        self._connected = True
        self._last_heartbeat_ts = now()
        self._msgs["HEARTBEAT"] = hb

        # mode_mapping(): {name -> number}; build the inverse for translation.
        try:
            self._mode_mapping = self._master.mode_mapping() or {}
        except Exception:
            self._mode_mapping = {}
        self._inv_mode_mapping = {v: k for k, v in self._mode_mapping.items()}

        self.request_data_streams(rate_hz=_STREAM_RATE_HZ)

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def master(self) -> Any:
        """The raw pymavlink connection (for callers that need extras)."""
        return self._master

    def close(self) -> None:
        """Close the link. Safe to call when never connected."""
        try:
            if self._master is not None:
                self._master.close()
        except Exception:
            pass
        finally:
            self._connected = False

    # ----------------------------------------------------------------------
    # Data-stream setup
    # ----------------------------------------------------------------------
    def request_data_streams(self, rate_hz: int = _STREAM_RATE_HZ) -> None:
        """Ask the FC to stream the telemetry we translate, at ~rate_hz.

        Sends the legacy REQUEST_DATA_STREAM (works on every ArduPilot build)
        and, best-effort, per-message SET_MESSAGE_INTERVAL for the specific
        messages we translate (ATTITUDE, GLOBAL_POSITION_INT, VFR_HUD,
        SYS_STATUS, GPS_RAW_INT, HEARTBEAT).
        """
        if not self._connected or self._master is None:
            return
        rate_hz = max(1, int(rate_hz))

        # Legacy: request the relevant stream groups.
        for stream_id in (
            mavutil.mavlink.MAV_DATA_STREAM_ALL,
        ):
            try:
                self._master.mav.request_data_stream_send(
                    self._target_system,
                    self._target_component,
                    stream_id,
                    rate_hz,
                    1,  # start
                )
            except Exception:
                pass

        # Modern: pin the exact messages we consume (interval in microseconds).
        interval_us = int(1_000_000 / rate_hz)
        wanted = (
            mavutil.mavlink.MAVLINK_MSG_ID_ATTITUDE,
            mavutil.mavlink.MAVLINK_MSG_ID_GLOBAL_POSITION_INT,
            mavutil.mavlink.MAVLINK_MSG_ID_VFR_HUD,
            mavutil.mavlink.MAVLINK_MSG_ID_SYS_STATUS,
            mavutil.mavlink.MAVLINK_MSG_ID_GPS_RAW_INT,
            mavutil.mavlink.MAVLINK_MSG_ID_HEARTBEAT,
        )
        for msg_id in wanted:
            try:
                self._master.mav.command_long_send(
                    self._target_system,
                    self._target_component,
                    mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL,
                    0,
                    float(msg_id),
                    float(interval_us),
                    0, 0, 0, 0, 0,
                )
            except Exception:
                pass

    # ----------------------------------------------------------------------
    # Receive / cache
    # ----------------------------------------------------------------------
    def poll(self, *, max_msgs: int = 50) -> int:
        """Drain pending MAVLink messages into the cache. Returns count read.

        Non-blocking. Call this once per control-loop tick before
        ``read_telemetry``. Caches the latest of each interesting type.
        """
        if not self._connected or self._master is None:
            return 0
        count = 0
        for _ in range(max_msgs):
            try:
                msg = self._master.recv_match(blocking=False)
            except Exception:
                break
            if msg is None:
                break
            mtype = msg.get_type()
            if mtype == "BAD_DATA":
                continue
            self._msgs[mtype] = msg
            if mtype == "HEARTBEAT":
                self._last_heartbeat_ts = now()
            count += 1
        return count

    def fc_heartbeat_age_s(self) -> float:
        """Seconds since the last FC heartbeat (link-health for telemetry)."""
        if self._last_heartbeat_ts <= 0.0:
            return math.inf
        return now() - self._last_heartbeat_ts

    # ----------------------------------------------------------------------
    # Translation -> contract telemetry + VehicleState
    # ----------------------------------------------------------------------
    def _mode_name(self) -> str:
        """Decode the current flight mode name from the cached heartbeat."""
        hb = self._msgs.get("HEARTBEAT")
        if hb is None:
            return "STABILIZE"
        custom = getattr(hb, "custom_mode", 0)
        name = self._inv_mode_mapping.get(custom)
        if name:
            return str(name).upper()
        # Fallback to pymavlink's flightmode string if available.
        try:
            fm = self._master.flightmode
            if fm:
                return str(fm).upper()
        except Exception:
            pass
        return "STABILIZE"

    def _is_armed(self) -> bool:
        """Armed flag from the heartbeat base_mode SAFETY_ARMED bit."""
        hb = self._msgs.get("HEARTBEAT")
        if hb is None:
            return False
        base = getattr(hb, "base_mode", 0)
        return bool(base & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)

    def vehicle_state(
        self, control_source: str = ControlSource.AUTO.value
    ) -> VehicleState:
        """Build the internal ``VehicleState`` snapshot from cached messages.

        ``control_source`` is supplied by the caller (the orchestrator owns the
        authoritative control source); we just stamp it onto the snapshot.
        """
        att = self._msgs.get("ATTITUDE")
        gpi = self._msgs.get("GLOBAL_POSITION_INT")
        vfr = self._msgs.get("VFR_HUD")

        roll = math.degrees(getattr(att, "roll", 0.0)) if att else 0.0
        pitch = math.degrees(getattr(att, "pitch", 0.0)) if att else 0.0

        rel_alt = (getattr(gpi, "relative_alt", 0) / 1000.0) if gpi else 0.0
        lat = (getattr(gpi, "lat", 0) / 1e7) if gpi else 0.0
        lon = (getattr(gpi, "lon", 0) / 1e7) if gpi else 0.0
        # GLOBAL_POSITION_INT.vz is cm/s, +down -> vspeed is +up.
        vspeed = (-getattr(gpi, "vz", 0) / 100.0) if gpi else 0.0
        if vfr is not None:
            vspeed = float(getattr(vfr, "climb", vspeed))

        groundspeed = float(getattr(vfr, "groundspeed", 0.0)) if vfr else 0.0
        heading = float(getattr(vfr, "heading", 0.0)) if vfr else (
            (getattr(gpi, "hdg", 0) / 100.0) if gpi else 0.0
        )

        armed = self._is_armed()
        # "airborne": armed AND meaningfully above home. Conservative 0.5 m gate
        # so we don't treat ground noise as flight (gates manual-control enable).
        airborne = bool(armed and rel_alt > 0.5)

        return VehicleState(
            armed=armed,
            mode=self._mode_name(),
            control_source=control_source,
            relAlt=float(rel_alt),
            groundspeed=groundspeed,
            vspeed=float(vspeed),
            heading=float(heading) % 360.0,
            lat=float(lat),
            lon=float(lon),
            roll=float(roll),
            pitch=float(pitch),
            airborne=airborne,
            ts=now(),
        )

    def read_telemetry(
        self,
        control_source: str = ControlSource.AUTO.value,
        *,
        home_distance: Optional[float] = None,
    ) -> dict:
        """Build a contract ``telemetry`` dict from the cached FC messages.

        Mirrors ``shared.shared.Telemetry`` exactly (degrees for attitude,
        1e-7 for lat/lon, metres for altitude, etc.). ``controlSource`` is
        filled from the caller; ``home.distance`` may be supplied (the caller
        usually computes it once it knows home), else best-effort 0.

        This never raises -- any missing message degrades to a safe default so
        the link to the ground stays up even with partial telemetry.
        """
        att = self._msgs.get("ATTITUDE")
        gpi = self._msgs.get("GLOBAL_POSITION_INT")
        vfr = self._msgs.get("VFR_HUD")
        sysst = self._msgs.get("SYS_STATUS")
        gps = self._msgs.get("GPS_RAW_INT")

        # --- attitude (rad -> deg) ----------------------------------------
        attitude = {
            "roll": math.degrees(getattr(att, "roll", 0.0)) if att else 0.0,
            "pitch": math.degrees(getattr(att, "pitch", 0.0)) if att else 0.0,
            "yaw": math.degrees(getattr(att, "yaw", 0.0)) if att else 0.0,
        }

        # --- position -----------------------------------------------------
        position = {
            "lat": (getattr(gpi, "lat", 0) / 1e7) if gpi else 0.0,
            "lon": (getattr(gpi, "lon", 0) / 1e7) if gpi else 0.0,
            "relAlt": (getattr(gpi, "relative_alt", 0) / 1000.0) if gpi else 0.0,
            "absAlt": (getattr(gpi, "alt", 0) / 1000.0) if gpi else 0.0,
        }

        # --- velocity -----------------------------------------------------
        vspeed = (-getattr(gpi, "vz", 0) / 100.0) if gpi else 0.0
        if vfr is not None:
            vspeed = float(getattr(vfr, "climb", vspeed))
        velocity = {
            "groundspeed": float(getattr(vfr, "groundspeed", 0.0)) if vfr else 0.0,
            "verticalSpeed": float(vspeed),
        }

        heading = float(getattr(vfr, "heading", 0.0)) if vfr else (
            (getattr(gpi, "hdg", 0) / 100.0) if gpi else 0.0
        )

        # --- battery (SYS_STATUS: voltage mV, current cA, remaining %) -----
        if sysst is not None:
            v_raw = getattr(sysst, "voltage_battery", 0)
            c_raw = getattr(sysst, "current_battery", -1)
            rem_raw = getattr(sysst, "battery_remaining", -1)
            battery = {
                "voltage": (v_raw / 1000.0) if v_raw not in (0, 65535) else 0.0,
                "current": (c_raw / 100.0) if c_raw >= 0 else 0.0,
                "remaining": float(rem_raw) if rem_raw >= 0 else 0.0,
            }
        else:
            battery = {"voltage": 0.0, "current": 0.0, "remaining": 0.0}

        # --- gps (GPS_RAW_INT) --------------------------------------------
        if gps is not None:
            hdop_raw = getattr(gps, "eph", 65535)
            gps_dict = {
                "fixType": int(getattr(gps, "fix_type", 0)),
                "satellites": int(getattr(gps, "satellites_visible", 0)),
                "hdop": (hdop_raw / 100.0) if hdop_raw not in (0, 65535) else 99.0,
            }
        else:
            gps_dict = {"fixType": 0, "satellites": 0, "hdop": 99.0}

        # --- home ----------------------------------------------------------
        home = {
            "lat": 0.0,
            "lon": 0.0,
            "distance": float(home_distance) if home_distance is not None else 0.0,
        }

        # --- link (best-effort: FC heartbeat freshness + radio RSSI) -------
        rssi = 0.0
        radio = self._msgs.get("RADIO_STATUS") or self._msgs.get("RADIO")
        if radio is not None:
            rssi = float(getattr(radio, "rssi", 0))
        age_ms = self.fc_heartbeat_age_s() * 1000.0
        link = {
            "rssi": rssi,
            "latencyMs": float(age_ms if math.isfinite(age_ms) else 9999.0),
        }

        return {
            "type": "telemetry",
            "ts": int(time.time() * 1000),
            "armed": self._is_armed(),
            "mode": self._mode_name(),
            "controlSource": control_source,
            "attitude": attitude,
            "position": position,
            "velocity": velocity,
            "heading": float(heading) % 360.0,
            "battery": battery,
            "gps": gps_dict,
            "home": home,
            "link": link,
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

    # ----------------------------------------------------------------------
    # Discrete commands
    # ----------------------------------------------------------------------
    def _command_long(self, command: int, *params: float) -> None:
        """Send a COMMAND_LONG with up to 7 float params (rest zero-filled)."""
        if not self._connected or self._master is None:
            raise RuntimeError("not connected")
        p = list(params) + [0.0] * (7 - len(params))
        self._master.mav.command_long_send(
            self._target_system,
            self._target_component,
            command,
            0,  # confirmation
            p[0], p[1], p[2], p[3], p[4], p[5], p[6],
        )

    def arm(self, *, force: bool = False) -> None:
        """Arm the motors. ``force=True`` bypasses some prearm checks (emergency).

        SAFETY: prefer the SafetyManager arming checklist *before* calling this;
        ``force`` is for the emergency path only.
        """
        magic = 21196.0 if force else 0.0  # ArduPilot force-arm magic number
        self._command_long(
            mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM, 1.0, magic,
        )

    def disarm(self, *, force: bool = False) -> None:
        """Disarm the motors. ``force=True`` disarms even when airborne (kill).

        emergencyStop uses ``force=True`` -- no confirmation, overrides all.
        """
        magic = 21196.0 if force else 0.0
        self._command_long(
            mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM, 0.0, magic,
        )

    def set_mode(self, mode: str) -> bool:
        """Set the flight mode by ArduCopter name (e.g. 'GUIDED', 'LOITER').

        Returns False if the mode name is unknown to this FC's mapping.
        """
        if not self._connected or self._master is None:
            raise RuntimeError("not connected")
        mode = str(mode).upper()
        if not self._mode_mapping:
            try:
                self._mode_mapping = self._master.mode_mapping() or {}
                self._inv_mode_mapping = {v: k for k, v in self._mode_mapping.items()}
            except Exception:
                self._mode_mapping = {}
        if mode not in self._mode_mapping:
            return False
        mode_id = self._mode_mapping[mode]
        self._master.mav.set_mode_send(
            self._target_system,
            mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
            mode_id,
        )
        return True

    def takeoff(self, alt: float) -> bool:
        """Ensure GUIDED, then command NAV_TAKEOFF to ``alt`` metres (rel home).

        Returns False if GUIDED couldn't be set. The caller is responsible for
        having armed first; ArduCopter will also refuse takeoff if not armed.
        """
        if not self.set_mode("GUIDED"):
            return False
        self._command_long(
            mavutil.mavlink.MAV_CMD_NAV_TAKEOFF,
            0.0, 0.0, 0.0, 0.0, 0.0, 0.0, float(alt),
        )
        return True

    def land(self) -> bool:
        """Switch to LAND mode (descend and disarm where we are)."""
        return self.set_mode("LAND")

    def rtl(self) -> bool:
        """Switch to RTL mode (return to launch)."""
        return self.set_mode("RTL")

    def brake(self) -> bool:
        """Switch to BRAKE mode (stop and hold position aggressively)."""
        return self.set_mode("BRAKE")

    # ----------------------------------------------------------------------
    # Velocity setpoint streaming (the guidance + manual output path)
    # ----------------------------------------------------------------------
    def send_body_velocity(
        self,
        vx: "float | VelocitySetpoint" = 0.0,
        vy: float = 0.0,
        vz: float = 0.0,
        yaw_rate: float = 0.0,
        *,
        valid: bool = True,
    ) -> None:
        """Send a BODY-frame velocity setpoint via SET_POSITION_TARGET_LOCAL_NED.

        Accepts EITHER component args ``(vx, vy, vz, yaw_rate, valid=)`` (the
        orchestrator's call form) OR a single ``VelocitySetpoint`` as the first
        positional arg (the internal ``hold()`` call form).

        Axes are MAV_FRAME_BODY_NED (vx fwd, vy right, vz down, m/s; yaw_rate
        deg/s clockwise+). ``valid=False`` -> a zero-velocity hold (we still send
        it so the FC's GUIDED controller actively holds rather than coasting on a
        stale setpoint).

        SAFETY: this method does not clamp to Limits (that is the guidance/manual
        layer's responsibility and is done upstream). It defends only against
        non-finite values, defaulting to a zero hold on any anomaly. Call at
        10-20 Hz from the orchestrator -- ArduPilot expects regular setpoints
        and will fall back to its own failsafe if they stop.
        """
        # Normalise to a VelocitySetpoint whether called with components or a sp.
        if hasattr(vx, "vx"):
            sp = vx  # type: ignore[assignment]
        else:
            sp = VelocitySetpoint(
                vx=float(vx), vy=float(vy), vz=float(vz),
                yaw_rate=float(yaw_rate), valid=bool(valid),
            )

        if not self._connected or self._master is None:
            return

        if not sp.valid:
            vx = vy = vz = 0.0
            yaw_rate_rad = 0.0
        else:
            vx = _finite(sp.vx)
            vy = _finite(sp.vy)
            vz = _finite(sp.vz)
            yaw_rate_rad = math.radians(_finite(sp.yaw_rate))

        try:
            self._master.mav.set_position_target_local_ned_send(
                0,                              # time_boot_ms (0 = now)
                self._target_system,
                self._target_component,
                mavutil.mavlink.MAV_FRAME_BODY_NED,
                _TYPEMASK_VEL_YAWRATE,
                0.0, 0.0, 0.0,                  # x, y, z position (ignored)
                vx, vy, vz,                     # vx, vy, vz velocity (m/s)
                0.0, 0.0, 0.0,                  # ax, ay, az accel (ignored)
                0.0,                            # yaw angle (ignored)
                yaw_rate_rad,                   # yaw_rate (rad/s)
            )
        except Exception:
            # Default to the safe state on error: try a single zero-hold frame.
            try:
                self._master.mav.set_position_target_local_ned_send(
                    0, self._target_system, self._target_component,
                    mavutil.mavlink.MAV_FRAME_BODY_NED,
                    _TYPEMASK_VEL_YAWRATE,
                    0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                )
            except Exception:
                pass

    def hold(self) -> None:
        """Convenience: send a single zero-velocity hold frame."""
        self.send_body_velocity(VelocitySetpoint.hold())


def _finite(v: float) -> float:
    """Coerce to a finite float; non-finite (nan/inf) -> 0.0 (safe)."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(f):
        return 0.0
    return f


__all__ = ["Vehicle"]
