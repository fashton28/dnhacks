"""
============================================================================
Eye in the Sky -- SHARED CONTRACT (Python)
----------------------------------------------------------------------------
Mirror of `shared/shared.ts`, kept byte-for-byte semantically in sync. This is
the companion-side definition of every message that crosses the control
WebSocket between the Jetson and the ground control center.

Wire transport (PRD 5.1):
  - Control + telemetry: a WebSocket (default port 8765), JSON messages.
      companion -> ground:  telemetry (~10 Hz), tracking (~10 Hz), statusText, ack
      ground -> companion:  command, manualInput
  - manualInput is HIGH-RATE and FIRE-AND-FORGET (never acked per frame).
    Only engageManual / disengageManual (and every other command) are acked.
  - Video: RTSP or WebRTC from the Jetson (default rtsp://<host>:8554/stream).

These are plain TypedDict / dataclass shapes; messages are serialised to JSON.
Field names match the TS contract exactly.
============================================================================
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Literal, Optional, TypedDict

Mode = Literal[
    "STABILIZE", "ALT_HOLD", "LOITER", "GUIDED",
    "AUTO", "RTL", "LAND", "POSHOLD", "BRAKE",
]

ControlSource = Literal["auto", "tracking", "manual"]
TrackingState = Literal["idle", "searching", "locked", "lost"]
Severity = Literal["info", "warning", "error", "critical"]
ConnectionState = Literal["disconnected", "connecting", "connected", "error"]

# Base PRD 4 command set + the manual-piloting extension (engageManual /
# disengageManual). High-rate stick input is the `manualInput` wire message,
# NOT a command, and bypasses the ack path.
#
# CODE_PRD 5.2 names map onto the UI's authoritative names used here:
#   takeManualControl    === engageManual      (acked command)
#   releaseManualControl === disengageManual    (acked command)
#   manualInput          === the `manualInput` wire message (fire-and-forget)
CommandName = Literal[
    "arm", "disarm", "takeoff", "land", "rtl", "setMode",
    "engageTracking", "disengageTracking", "selectTarget",
    "setStandoff", "setMaxSpeed", "emergencyStop",
    "engageManual", "disengageManual",
]


# --- TypedDicts for the JSON messages (what goes over the wire) -------------

class Attitude(TypedDict):
    roll: float
    pitch: float
    yaw: float


class Position(TypedDict):
    lat: float
    lon: float
    relAlt: float
    absAlt: float


class Velocity(TypedDict):
    groundspeed: float
    verticalSpeed: float


class Battery(TypedDict):
    voltage: float
    current: float
    remaining: float


class Gps(TypedDict):
    fixType: int
    satellites: int
    hdop: float


class Home(TypedDict):
    lat: float
    lon: float
    distance: float


class Link(TypedDict):
    rssi: float
    latencyMs: float


class Telemetry(TypedDict, total=False):
    type: Literal["telemetry"]
    ts: int
    armed: bool
    mode: Mode
    controlSource: ControlSource  # optional / additive
    attitude: Attitude
    position: Position
    velocity: Velocity
    heading: float
    battery: Battery
    gps: Gps
    home: Home
    link: Link


class DetectedTarget(TypedDict):
    id: int
    bbox: list  # [x, y, w, h] normalised 0..1
    confidence: float
    isLocked: bool


class TrackingStatus(TypedDict):
    type: Literal["tracking"]
    ts: int
    state: TrackingState
    targets: list
    lockedTargetId: Optional[int]
    standoffDistance: float
    estimatedDistance: Optional[float]
    maxSpeed: float


class StatusTextMsg(TypedDict):
    type: Literal["statusText"]
    ts: int
    severity: Severity
    text: str


class Command(TypedDict, total=False):
    type: Literal["command"]
    command: CommandName
    params: dict


class CommandAck(TypedDict):
    type: Literal["ack"]
    ts: int
    command: CommandName
    success: bool
    message: str


class ManualInputMessage(TypedDict, total=False):
    type: Literal["manualInput"]
    ts: int
    throttle: float  # climb/descend, -1..1
    yaw: float       # yaw rate,     -1..1
    pitch: float     # forward/back, -1..1
    roll: float      # left/right,   -1..1


def now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class ManualInput:
    throttle: float = 0.0
    yaw: float = 0.0
    pitch: float = 0.0
    roll: float = 0.0

    def clamp(self) -> "ManualInput":
        c = lambda v: max(-1.0, min(1.0, v))
        return ManualInput(c(self.throttle), c(self.yaw), c(self.pitch), c(self.roll))


@dataclass
class ConnectionConfig:
    host: str = "sitl"
    controlPort: int = 8765
    videoUrl: str = ""
    sitl: bool = True


@dataclass(frozen=True)
class Defaults:
    """Shared connection + tuning constants. Must match shared.ts DEFAULTS."""
    control_port: int = 8765
    video_port: int = 8554
    standoff_distance: float = 5.0   # m  (PRD 9)
    min_standoff: float = 3.0        # m  (hard floor)
    max_standoff: float = 15.0       # m
    max_speed: float = 2.0           # m/s (PRD 9 conservative default)
    max_speed_cap: float = 8.0       # m/s
    min_speed: float = 0.5           # m/s
    max_climb_rate: float = 1.5      # m/s
    max_yaw_rate: float = 45.0       # deg/s
    max_altitude: float = 30.0       # m  (geofence altitude cap)
    geofence_radius: float = 60.0    # m
    manual_watchdog_ms: int = 500    # zero setpoint + hold if no stick frame
    ground_link_timeout_ms: int = 2000  # deadman
    deadzone: float = 0.09


DEFAULTS = Defaults()
