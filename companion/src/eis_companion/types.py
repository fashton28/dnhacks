"""
============================================================================
Eye in the Sky -- COMPANION shared internal types
----------------------------------------------------------------------------
These are the *internal* dataclasses the companion's control core, MAVLink
layer, vision layer and API server pass around in-process. They are distinct
from the on-the-wire contract types in ``shared/shared.py`` (those are the JSON
shapes that cross the WebSocket). This module is the single source of truth for
the in-process shapes; everything else imports from ``eis_companion.types``.

Pure stdlib only -- importable on any machine with no hardware / numpy needed.

Frame conventions (match the MAVLink BODY-NED setpoint path, PRD 6.1):
  VelocitySetpoint is in the vehicle BODY frame:
    vx = forward(+) / back(-)      [m/s]
    vy = right(+)   / left(-)      [m/s]
    vz = down(+)    / up(-)        [m/s]   (NED: +z points down)
    yaw_rate                        [deg/s], positive = turn right (clockwise)
  ``valid=False`` means "hold position / zero setpoint" -- the consumer must
  send a zero-velocity hold, never re-use the last commanded velocity.
============================================================================
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


# --------------------------------------------------------------------------
# Enums (string-valued so they serialise straight onto the contract literals)
# --------------------------------------------------------------------------
class ControlSource(str, Enum):
    """Authoritative active control source -- exactly one is ever active."""
    AUTO = "auto"
    TRACKING = "tracking"
    MANUAL = "manual"


class TrackingState(str, Enum):
    """Lifecycle of the single-target lock (mirrors contract TrackingState)."""
    IDLE = "idle"
    SEARCHING = "searching"
    LOCKED = "locked"
    LOST = "lost"


def now() -> float:
    """Monotonic-ish wall clock in *seconds* (float). Used as the default ts."""
    return time.time()


# --------------------------------------------------------------------------
# Vehicle state (a digest of FC MAVLink telemetry the control core needs)
# --------------------------------------------------------------------------
@dataclass
class VehicleState:
    """Snapshot of the flight controller state the control core reasons about.

    Only the fields the guidance / manual / safety logic actually consult are
    promoted to first-class attributes; the MAVLink layer fills these in.
    """
    armed: bool = False
    mode: str = "STABILIZE"
    control_source: str = ControlSource.AUTO.value
    relAlt: float = 0.0          # m above home/takeoff
    groundspeed: float = 0.0     # m/s
    vspeed: float = 0.0          # m/s, +up
    heading: float = 0.0         # deg 0..360
    lat: float = 0.0
    lon: float = 0.0
    roll: float = 0.0            # deg
    pitch: float = 0.0           # deg
    airborne: bool = False
    ts: float = field(default_factory=now)


# --------------------------------------------------------------------------
# Velocity setpoint -- the single output type of guidance AND manual piloting
# --------------------------------------------------------------------------
@dataclass
class VelocitySetpoint:
    """BODY-frame velocity setpoint sent to the FC as SET_POSITION_TARGET_LOCAL_NED.

    vx = forward(+)/back(-) m/s, vy = right(+)/left(-) m/s,
    vz = down(+)/up(-) m/s, yaw_rate deg/s (positive = clockwise / turn right).
    valid=False  ==>  hold position / zero setpoint (do NOT reuse last command).
    """
    vx: float = 0.0
    vy: float = 0.0
    vz: float = 0.0
    yaw_rate: float = 0.0
    valid: bool = False

    @classmethod
    def hold(cls) -> "VelocitySetpoint":
        """The canonical safe setpoint: all-zero, valid=False (hold position)."""
        return cls(0.0, 0.0, 0.0, 0.0, False)

    def zeroed(self) -> "VelocitySetpoint":
        """Return an all-zero copy preserving nothing -- a hard stop / hold."""
        return VelocitySetpoint.hold()


# --------------------------------------------------------------------------
# Limits -- the hard safety envelope. Every control output is clamped to this.
# --------------------------------------------------------------------------
@dataclass
class Limits:
    """Hard safety + tuning envelope (mirrors shared DEFAULTS, PRD 9).

    standoff is a HARD limit: guidance must never command forward motion that
    closes inside it. min_standoff is the floor standoff may be set to.
    """
    max_speed: float = 2.0            # m/s, horizontal (PRD 9 conservative)
    min_speed: float = 0.5            # m/s
    max_climb_rate: float = 1.5       # m/s
    max_yaw_rate: float = 45.0        # deg/s
    max_altitude: float = 30.0        # m, geofence altitude cap
    standoff: float = 5.0             # m, configured target distance
    min_standoff: float = 3.0         # m, hard floor
    deadzone: float = 0.09            # normalised stick deadzone
    manual_watchdog_ms: int = 500     # zero+hold if no stick frame within this
    ground_link_timeout_ms: int = 2000  # deadman on the ground link

    def clamp_standoff(self, meters: float) -> float:
        """Clamp a requested standoff to [min_standoff, +inf), never below floor."""
        return max(self.min_standoff, float(meters))

    def clamp_speed(self, mps: float) -> float:
        """Clamp a requested max-speed to [min_speed, max_speed]."""
        return max(self.min_speed, min(self.max_speed, float(mps)))


# --------------------------------------------------------------------------
# Target observation -- one detection from the vision layer for one frame
# --------------------------------------------------------------------------
@dataclass
class TargetObservation:
    """A single person detection for one frame.

    bbox is (x, y, w, h) NORMALISED 0..1 of the video frame (top-left origin).
    conf is the detector confidence 0..1. ts is the capture wall-clock (s).
    """
    bbox: tuple                       # (x, y, w, h) normalised 0..1
    conf: float
    ts: float = field(default_factory=now)

    # --- convenience geometry (all normalised 0..1) -----------------------
    @property
    def cx(self) -> float:
        """Centre x of the bbox (normalised)."""
        return self.bbox[0] + self.bbox[2] / 2.0

    @property
    def cy(self) -> float:
        """Centre y of the bbox (normalised)."""
        return self.bbox[1] + self.bbox[3] / 2.0

    @property
    def height(self) -> float:
        """bbox height (normalised)."""
        return self.bbox[3]

    @property
    def width(self) -> float:
        """bbox width (normalised)."""
        return self.bbox[2]


__all__ = [
    "ControlSource",
    "TrackingState",
    "VehicleState",
    "VelocitySetpoint",
    "Limits",
    "TargetObservation",
    "now",
]
