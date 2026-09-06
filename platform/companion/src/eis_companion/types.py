"""
============================================================================
Drone Safety Platform -- COMPANION shared internal types
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

Every clamp in this module routes through one helper, ``_bounded``, so the
degradation rule is written once: a value that is not a finite number is not
argued with, it becomes the caller's stated safe value. Guidance, manual,
the planner and the MAVLink layer all clamp through these methods, so that
one rule is the one the aircraft flies.
============================================================================
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Tuple


# --------------------------------------------------------------------------
# Enums (string-valued so they serialise straight onto the contract literals)
# --------------------------------------------------------------------------
class ControlSource(str, Enum):
    """Authoritative active control source -- exactly one is ever active."""
    AUTO = "auto"
    TRACKING = "tracking"
    MANUAL = "manual"
    PLANNER = "planner"  # mission planner (contract 'planner'; behavior wired in Phase 2)


class TrackingState(str, Enum):
    """Lifecycle of the single-target lock (mirrors contract TrackingState)."""
    IDLE = "idle"
    SEARCHING = "searching"
    LOCKED = "locked"
    LOST = "lost"


def now() -> float:
    """Monotonic-ish wall clock in *seconds* (float). Used as the default ts."""
    return time.time()


def _bounded(value: Any, low: float, high: float, safe: float) -> float:
    """``value`` forced into [low, high], degrading to ``safe``.

    Anything that is not a finite number -- a string, None, NaN, and the
    ``inf`` a spec-legal JSON literal like ``1e400`` parses into (FM-11) --
    resolves to ``safe`` untouched, because the caller has already decided
    what its conservative answer is. An inverted band (low above high) is
    read as "the floor wins": a band that cannot be satisfied must not
    silently authorise the ceiling.
    """
    try:
        number = float(value)
    except (TypeError, ValueError):
        return float(safe)
    if not math.isfinite(number):
        return float(safe)
    return min(max(number, low), max(low, high))


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

    The field defaults ARE the hold setpoint, deliberately: the cheapest thing
    to construct is the safe thing, so a partially-built setpoint is a hold
    rather than a stale command.
    """
    vx: float = 0.0
    vy: float = 0.0
    vz: float = 0.0
    yaw_rate: float = 0.0
    valid: bool = False

    @classmethod
    def hold(cls) -> "VelocitySetpoint":
        """The canonical safe setpoint: all-zero, valid=False (hold position).

        A fresh instance every call -- consumers mutate what they are handed,
        and a shared singleton would let one caller's edit reach every other.
        """
        return cls()

    def zeroed(self) -> "VelocitySetpoint":
        """Return an all-zero copy preserving nothing -- a hard stop / hold."""
        return type(self).hold()


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
    max_standoff: float = 50.0        # m, hard CEILING (FM-11)
    deadzone: float = 0.09            # normalised stick deadzone
    manual_watchdog_ms: int = 500     # zero+hold if no stick frame within this
    ground_link_timeout_ms: int = 2000  # deadman on the ground link

    def standoff_band(self) -> Tuple[float, float]:
        """The closed band a requested standoff must land in, (min, max)."""
        floor = float(self.min_standoff)
        return floor, max(floor, float(self.max_standoff))

    def clamp_standoff(self, meters: float) -> float:
        """Clamp a requested standoff to [min_standoff, max_standoff].

        The band is CLOSED at BOTH ends. An unbounded standoff is not a
        conservative setting: guidance computes ``est_distance - standoff``, so
        a huge value drives sustained full-speed RETREAT that no clamp catches
        (the three standoff re-assertions only ever forbid POSITIVE vx), and it
        leaks into the advertised ``capabilities.max_standoff_m`` (FM-11).
        A non-finite request degrades to the configured value, never to inf.
        """
        floor, ceiling = self.standoff_band()
        return _bounded(meters, floor, ceiling, self.standoff)

    def clamp_speed(self, mps: float) -> float:
        """Clamp a requested max-speed to [min_speed, max_speed].

        An unreadable request degrades to the configured cap, which is the
        value already sitting in the envelope -- never to a faster one.
        """
        return _bounded(mps, float(self.min_speed), float(self.max_speed), self.max_speed)


# --------------------------------------------------------------------------
# Target observation -- one detection from the vision layer for one frame
# --------------------------------------------------------------------------
@dataclass
class TargetObservation:
    """A single person detection for one frame.

    bbox is (x, y, w, h) NORMALISED 0..1 of the video frame (top-left origin).
    conf is the detector confidence 0..1. ts is the capture wall-clock (s).

    ``cls`` is the detected object class. It defaults to ``"person"`` because
    the person-following tracker is the only consumer that existed first, but
    the staging rails also emit ``vehicle``/``structure`` boxes -- and those
    must NOT ride the person-tracking wire as classless targets (FM-122). The
    orchestrator routes by this field; it is internal, not a wire type.
    """
    bbox: tuple                       # (x, y, w, h) normalised 0..1
    conf: float
    ts: float = field(default_factory=now)
    cls: str = "person"

    # --- convenience geometry (all normalised 0..1) -----------------------
    # Derived from bbox on every read rather than cached: the tracker mutates
    # nothing here, and a cached centroid that drifts from its box is the kind
    # of disagreement guidance would servo on.
    @property
    def width(self) -> float:
        """bbox width (normalised)."""
        return float(self.bbox[2])

    @property
    def height(self) -> float:
        """bbox height (normalised)."""
        return float(self.bbox[3])

    @property
    def cx(self) -> float:
        """Centre x of the bbox (normalised)."""
        return float(self.bbox[0]) + self.width / 2.0

    @property
    def cy(self) -> float:
        """Centre y of the bbox (normalised)."""
        return float(self.bbox[1]) + self.height / 2.0


__all__ = [
    "ControlSource",
    "TrackingState",
    "VehicleState",
    "VelocitySetpoint",
    "Limits",
    "TargetObservation",
    "now",
]
