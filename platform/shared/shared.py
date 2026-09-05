"""
============================================================================
Drone Safety Platform -- SHARED CONTRACT (Python)
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
from typing import Literal, Optional, TypedDict, Union

Mode = Literal[
    "STABILIZE", "ALT_HOLD", "LOITER", "GUIDED",
    "AUTO", "RTL", "LAND", "POSHOLD", "BRAKE",
]

ControlSource = Literal["auto", "tracking", "manual", "planner"]
DEFAULT_VEHICLE_ID = "eis-1"
NavSource = Literal["gps", "optflow", "extnav"]
FailsafeState = Literal["none", "hold", "rtl", "escalate", "refuse"]
ChargeState = Literal["charging", "charged", "discharging", "fault", "unknown"]
TrackingState = Literal["idle", "searching", "locked", "lost"]
Severity = Literal["info", "warning", "error", "critical"]
ConnectionState = Literal["disconnected", "connecting", "connected", "error"]

# Mission planner enums (mirror shared.ts inline literal unions)
MissionProfile = Literal[
    "follow", "inspect", "survey", "slow", "standard", "fast",
]
VerificationVerdict = Literal["pass", "corrected", "rejected"]
IncidentVerdict = Literal["false_alarm", "log", "escalate"]

# Tasking enums (mirror shared.ts inline literal unions).
TaskLookFor = Literal["person", "vehicle", "fence_gap", "structure", "unknown"]
TaskUrgency = Literal["immediate", "next_sortie", "defer"]
TaskSource = Literal["llm", "operator", "scripted"]

# Envelope-monitoring / attendance enums.
EnvelopeState = Literal["in_envelope", "warning", "breach"]
EnvelopeConstraint = Literal[
    "corridor", "altitude", "geofence", "nfz", "standoff", "sortie", "separation",
]
# Never "continue": a breach resolves to hold | rtl (or an escalation).
EnvelopeAction = Literal["none", "slow", "hold", "rtl"]
AttendanceMode = Literal["attended", "unattended"]

# Check names the verifier and the mirrors agree on. VerificationCheck["name"]
# stays a plain str (the shape is unchanged) so a verifier may still report a
# check this list does not know yet.
#   attended      -- the mission's attendance mode permits this dispatch
#   deconfliction -- no other vehicle's corridor conflicts in space and time
VerificationCheckName = Literal[
    "geofence", "nfz", "altitude", "battery", "attended", "deconfliction",
]
VERIFICATION_CHECK_NAMES: list[VerificationCheckName] = [
    "geofence", "nfz", "altitude", "battery", "attended", "deconfliction",
]

# Hard cap on Task["question"] so an operator card never has to truncate it.
TASK_QUESTION_MAX_CHARS = 120

# Gimbal pitch limits, degrees. -30 looks UP, 0 is level, 90 is straight DOWN --
# the same convention the ARGUS console reports (gimbal_pitch_deg).
GIMBAL_PITCH_MIN_DEG = -30.0
GIMBAL_PITCH_MAX_DEG = 90.0

# Base PRD 4 command set + the manual-piloting extension (engageManual /
# disengageManual). High-rate stick input is the `manualInput` wire message,
# NOT a command, and bypasses the ack path.
#
# CODE_PRD 5.2 names map onto the UI's authoritative names used here:
#   takeManualControl    === engageManual      (acked command)
#   releaseManualControl === disengageManual    (acked command)
#   manualInput          === the `manualInput` wire message (fire-and-forget)
#
# setGimbal / enterUnattended / exitUnattended travel the ordinary acked
# command path like every other command; params carry {"pitchDeg": float} and
# {"operatorId": str} respectively.
CommandName = Literal[
    "arm", "disarm", "takeoff", "land", "rtl", "setMode",
    "engageTracking", "disengageTracking", "selectTarget",
    "setStandoff", "setMaxSpeed", "emergencyStop",
    "engageManual", "disengageManual",
    "executePlan", "abortPlan", "continueMission", "testFault",
    "setGimbal", "enterUnattended", "exitUnattended",
]

# SITL-only: reject unless config.sitl and EIS_ENABLE_TEST_HOOKS=true.
# This command is never available to the LLM planner.
TestFaultName = Literal[
    "gps_loss", "rf_interference", "hostile_drone", "link_loss",
    "planner_heartbeat", "camera", "thermal", "lidar",
    "battery_fault", "battery_drain", "sortie_expiry", "charge",
    "wind", "raw_out_of_fence",
]


class CommandParams(TypedDict, total=False):
    altitude: float
    mode: Mode
    targetId: int
    meters: float
    mps: float
    plan: MissionPlan
    fault: TestFaultName
    enabled: bool
    value: float
    # setGimbal, degrees, GIMBAL_PITCH_MIN_DEG..GIMBAL_PITCH_MAX_DEG.
    pitchDeg: float
    # enterUnattended / exitUnattended: the operator making the change. Both
    # travel the ordinary acked command path like every other command.
    operatorId: str


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


class BatteryRequired(TypedDict):
    soc_pct: float
    voltage_v: float
    current_a: float
    cell_delta_v: float
    temp_c: float
    remaining_s: float
    charge_state: ChargeState
    # Compatibility aliases retained while existing panels migrate.
    voltage: float
    current: float
    remaining: float


class Battery(BatteryRequired, total=False):
    fault: str


class Gps(TypedDict):
    fixType: int
    satellites: int
    hdop: float


class GpsHealth(TypedDict):
    fix: int
    sats: int
    hdop: float


class SortieState(TypedDict):
    elapsed_s: float
    cap_s: float
    must_rtl_by_s: float


class Home(TypedDict):
    lat: float
    lon: float
    distance: float


class Link(TypedDict):
    rssi: float
    latencyMs: float


class GimbalState(TypedDict):
    """Reported gimbal attitude, degrees. Optional on Telemetry: airframes
    without a commandable gimbal omit it rather than reporting a fictional 0."""
    pitchDeg: float  # GIMBAL_PITCH_MIN_DEG..GIMBAL_PITCH_MAX_DEG


class TelemetryRequired(TypedDict):
    type: Literal["telemetry"]
    ts: int
    vehicleId: str
    armed: bool
    mode: Mode
    controlSource: ControlSource
    navSource: NavSource
    gpsHealth: GpsHealth
    failsafeState: FailsafeState
    failsafeReason: str
    attitude: Attitude
    position: Position
    velocity: Velocity
    heading: float
    battery: Battery
    gps: Gps
    sortie: Optional[SortieState]
    home: Home
    link: Link


class Telemetry(TelemetryRequired, total=False):
    # Present only when the airframe carries a commandable gimbal.
    gimbal: GimbalState


class DetectedTarget(TypedDict):
    id: int
    bbox: list  # [x, y, w, h] normalised 0..1
    confidence: float
    isLocked: bool


class TrackingStatus(TypedDict):
    type: Literal["tracking"]
    ts: int
    vehicleId: str
    state: TrackingState
    targets: list
    lockedTargetId: Optional[int]
    standoffDistance: float
    estimatedDistance: Optional[float]
    maxSpeed: float


class StatusTextMsg(TypedDict):
    type: Literal["statusText"]
    ts: int
    vehicleId: str
    severity: Severity
    text: str


# --- Mission planner types (anomaly -> plan -> verification -> report) ------

class GotoGpsTool(TypedDict, total=False):
    tool: Literal["goto_gps"]
    lat: float
    lon: float
    alt: float                 # m, relative
    alt_m: float               # canonical wire alias
    profile: MissionProfile    # optional speed override for this leg
    speed_mps: float


class OrbitPointTool(TypedDict, total=False):
    tool: Literal["orbit_point"]
    lat: float
    lon: float
    radius: float              # m
    radius_m: float            # canonical wire alias
    laps: float


class HoldTool(TypedDict, total=False):
    tool: Literal["hold"]
    durationS: float           # seconds; omitted = indefinite
    duration_s: float          # canonical wire alias


class RtlTool(TypedDict):
    tool: Literal["rtl"]


# One step of a mission plan, discriminated on "tool".
class FollowTool(TypedDict, total=False):
    tool: Literal["follow"]
    track_id: int
    profile: MissionProfile
    trackId: int               # compatibility alias


class OrbitTool(TypedDict, total=False):
    tool: Literal["orbit"]
    track_id: int
    profile: MissionProfile
    trackId: int               # compatibility alias


class GotoRelativeTool(TypedDict):
    tool: Literal["goto_relative"]
    dx: float
    dy: float
    dz: float


PlanTool = Union[
    FollowTool, OrbitTool, GotoRelativeTool,
    GotoGpsTool, OrbitPointTool, HoldTool, RtlTool,
]
# Where a cue came from. "cctv" and "fence_sensor" are the fixed-infrastructure
# "cue rails": they observe continuously and their cues expire (see ttl_s).
AnomalySource = Literal[
    "sentinel2", "sar", "sdr", "rf_drone", "drone_survey",
    "cctv", "fence_sensor",
]


class AnomalyRequired(TypedDict):
    """A detected site anomaly. ``type`` here is the anomaly KIND (e.g.
    'change'), NOT a message discriminant -- the wire wrapper nests the
    payload precisely to avoid that collision (see AnomalyMessage)."""
    id: str
    lat: float
    lon: float
    type: str          # anomaly kind, e.g. "change"
    confidence: float  # 0..1
    thumbnail: str     # repo-relative path or data URL
    source: AnomalySource


class Anomaly(AnomalyRequired, total=False):
    # Epoch ms the cue was OBSERVED -- earlier than the ``ts`` of the wire
    # message that carries it. Optional while the satellite/SAR rails still
    # emit undated cues; the cue rails (cctv / fence_sensor) always set it.
    observedAt: int
    # Cue lifetime in seconds from observedAt. Past it the cue is stale and
    # must not be dispatched on. Optional for the same reason.
    ttl_s: float
    # Fixed camera that raised the cue (site.cameras[].id), when any.
    cameraId: str


class PlanTraceEntry(TypedDict):
    """One decision the planner made, in the order it was made. A trace is a
    reason-for-record only: it never carries coordinates, tools or altitudes."""
    rule: str
    effect: str


class LatLon(TypedDict):
    lat: float
    lon: float


class LatLonAlt(TypedDict):
    lat: float
    lon: float
    relAlt: float   # m above home


# One straight segment of the flight tube a verified plan may fly inside.
# Declared functionally because "from" is a Python keyword.
CorridorLeg = TypedDict("CorridorLeg", {
    "from": LatLon,
    "to": LatLon,
    "lateral_tol_m": float,   # half-width of the tube about the leg, m
})


class CorridorOrbit(TypedDict):
    """One orbit the flight tube permits."""
    center: LatLon
    radius_m: float
    radial_tol_m: float       # permitted radial error about radius_m, m


class AltBand(TypedDict):
    min: float
    max: float


class Corridor(TypedDict):
    """The geometric envelope a verified plan is allowed to occupy. The envelope
    monitor checks the vehicle against THIS rather than re-running the planner."""
    legs: list                # list[CorridorLeg]
    orbits: list              # list[CorridorOrbit]
    alt_band_m: AltBand       # m AGL, relative to home
    generated_from: str       # requestId of the MissionPlan it came from


class MissionPlanRequired(TypedDict):
    requestId: str   # ground-side correlation only -- never used by the ack path
    anomalyId: str
    tools: list      # list[PlanTool]
    profile: MissionProfile
    rationale: str


class MissionPlan(MissionPlanRequired, total=False):
    # Ordered record of the rules that shaped this plan. Optional for now --
    # the planner does not emit it yet.
    planTrace: list  # list[PlanTraceEntry]
    # Flight tube derived from ``tools``. Optional for now -- same reason.
    corridor: Corridor


class VerificationCheck(TypedDict, total=False):
    name: str        # see VERIFICATION_CHECK_NAMES for the agreed names
    ok: bool
    reason: str
    edit: str        # optional: human-readable description of an applied correction


class Verification(TypedDict, total=False):
    requestId: str   # matches MissionPlan["requestId"] (ground-side correlation only)
    verdict: VerificationVerdict
    checks: list     # list[VerificationCheck]
    correctedPlan: MissionPlan  # present when verdict == "corrected"
    # Delayed-dispatch correction: epoch ms before which this plan must NOT be
    # dispatched (an attended window that has not opened, a deconfliction wait).
    holdUntil: int


class IncidentReport(TypedDict):
    missionId: str
    verdict: IncidentVerdict
    markdown: str


# --- Tasking ---------------------------------------------------------------
# A task says WHAT to look for and WHY -- never where, how high, or with which
# tool. It carries no coordinates of its own: the only geometry it may
# reference is ``anomalyId``. This is exactly the surface an LLM is allowed to
# emit as schema-bound JSON.

class TaskRequired(TypedDict):
    taskId: str
    anomalyId: str
    lookFor: TaskLookFor
    question: str      # <= TASK_QUESTION_MAX_CHARS characters
    urgency: TaskUrgency
    priority: float    # 0..1
    rationale: str
    source: TaskSource


class Task(TaskRequired, total=False):
    assignedTo: str    # vehicleId this task is assigned to, if any


class TaskMessage(TypedDict):
    type: Literal["task"]
    ts: int
    vehicleId: str
    task: Task


class CommandRequired(TypedDict):
    type: Literal["command"]
    vehicleId: str
    command: CommandName


class Command(CommandRequired, total=False):
    params: CommandParams


class CommandAck(TypedDict):
    """Acks correlate by command NAME (first-match FIFO) -- there is no
    requestId on the ack path. The ``requestId`` inside MissionPlan /
    Verification exists for ground-side correlation only and never
    participates in ack matching."""
    type: Literal["ack"]
    ts: int
    vehicleId: str
    command: CommandName
    success: bool
    message: str


class ManualInputMessage(TypedDict):
    type: Literal["manualInput"]
    ts: int
    vehicleId: str
    throttle: float  # climb/descend, -1..1
    yaw: float       # yaw rate,     -1..1
    pitch: float     # forward/back, -1..1
    roll: float      # left/right,   -1..1


# Planner wire/event messages. Payloads are NESTED (e.g. anomaly["type"] is
# the anomaly kind) so payload fields never collide with the message "type"
# discriminant. They flow ground-internally through the UI DataSource today
# and may later cross the socket unchanged.

class AnomalyMessage(TypedDict):
    type: Literal["anomaly"]
    ts: int
    vehicleId: str
    anomaly: Anomaly


class MissionPlanMessage(TypedDict):
    type: Literal["missionPlan"]
    ts: int
    vehicleId: str
    plan: MissionPlan


class VerificationMessage(TypedDict):
    type: Literal["verification"]
    ts: int
    vehicleId: str
    verification: Verification


class IncidentReportMessage(TypedDict):
    type: Literal["incidentReport"]
    ts: int
    vehicleId: str
    report: IncidentReport


# --- Sensor, RF, readiness, health, fleet, and planner messages -----------

SensorModality = Literal["rgb", "thermal", "lidar", "fused"]
SensorHealth = Literal["ok", "degraded", "failed"]


ObservationTrackRequired = TypedDict("ObservationTrackRequired", {
    "id": int,
    "class": str,
    "bearing_deg": float,
    "range_m": float,
    "conf": float,
    "modality": SensorModality,
})


class ObservationTrack(ObservationTrackRequired, total=False):
    thermal_delta_c: float


class FenceGap(TypedDict):
    lat: float
    lon: float
    width_m: float


class NewStructure(TypedDict):
    lat: float
    lon: float
    footprint_m2: float
    height_m: float


class ObservationGeometry(TypedDict):
    fence_gaps: list
    new_structures: list


class ObservationSensors(TypedDict):
    rgb: SensorHealth
    thermal: SensorHealth
    lidar: SensorHealth


class ObservationMessageRequired(TypedDict):
    type: Literal["observation"]
    ts: int
    vehicleId: str
    tracks: list
    scene: str
    sensors: ObservationSensors
    geometry: ObservationGeometry


class ObservationFrames(TypedDict, total=False):
    # Values are data URLs or repo-relative staged-image paths.
    rgb: str
    thermal: str


class ObservationMessage(ObservationMessageRequired, total=False):
    frames: ObservationFrames
    missionId: str
    stagingId: str


class CapabilityProfile(TypedDict):
    profile: MissionProfile
    min_standoff_m: float
    max_standoff_m: float
    max_speed_mps: float
    max_altitude_m: float


class CapabilitiesMessage(TypedDict):
    type: Literal["capabilities"]
    ts: int
    vehicleId: str
    profiles: list
    sensors: list
    night_capable: bool
    max_sortie_s: float
    dispatch_min_soc_pct: float


PlannerToolName = Literal[
    "follow", "orbit", "goto_relative", "goto_gps", "orbit_point", "hold", "rtl",
]
PlanCommandStatus = Literal["accepted", "rejected", "clamped"]


class PlanCommandMessage(TypedDict):
    type: Literal["planCommand"]
    ts: int
    vehicleId: str
    requestId: str
    tool: PlannerToolName
    args: dict
    profile: MissionProfile


class PlanCommandAckMessage(TypedDict):
    type: Literal["planCommandAck"]
    ts: int
    vehicleId: str
    requestId: str
    status: PlanCommandStatus
    reason: str


class PlanHeartbeatMessage(TypedDict):
    type: Literal["planHeartbeat"]
    ts: int
    vehicleId: str


class ReadinessMessage(TypedDict):
    type: Literal["readiness"]
    ts: int
    vehicleId: str
    ready: bool
    reasons: list
    eta_ready_s: float


HealthComponent = Literal[
    "link", "planner", "gps", "battery", "wind", "camera", "thermal", "lidar",
    "site_model", "mesh", "sdr", "envelope",
]


class HealthEventMessage(TypedDict):
    type: Literal["healthEvent"]
    ts: int
    vehicleId: str
    component: HealthComponent
    state: str
    detail: str


RfSource = Literal["sdr", "rf_drone"]
RfEventKind = Literal[
    "gnss_interference", "drone_link", "remote_id", "hostile_drone",
]


class RfEventRequired(TypedDict):
    type: Literal["rfEvent"]
    ts: int
    vehicleId: str
    source: RfSource
    kind: RfEventKind
    band: str
    confidence: float


class RfEventMessage(RfEventRequired, total=False):
    power_delta_db: float
    lat: float
    lon: float
    pilot_lat: float
    pilot_lon: float


class SpectrumBand(TypedDict):
    name: str
    floor_db: float
    p95_db: float
    peak_mhz: float
    occ_bw_mhz: float


class SpectrumMessage(TypedDict):
    type: Literal["spectrum"]
    ts: int
    vehicleId: str
    bands: list
    state: Literal["warming", "nominal", "degraded"]


class FleetReadiness(TypedDict):
    ready: bool
    reasons: list
    eta_ready_s: float


class FleetFailsafe(TypedDict):
    state: FailsafeState
    reason: str


# --- Envelope monitoring, attendance mode, escalation, cue rails -----------

class EnvelopeMessageRequired(TypedDict):
    type: Literal["envelope"]
    ts: int
    vehicleId: str
    state: EnvelopeState


class EnvelopeMessage(EnvelopeMessageRequired, total=False):
    # The limit this report is about -- omitted only when state is
    # "in_envelope" with nothing notable nearby.
    constraint: EnvelopeConstraint
    # Signed metres of margin to ``constraint``: positive is inside the
    # envelope, negative is how far past the limit the vehicle is.
    margin_m: float
    action: EnvelopeAction


class ModeMessage(TypedDict):
    type: Literal["mode"]
    ts: int
    vehicleId: str
    mode: AttendanceMode
    since: int              # epoch ms this attendance mode began
    operatorPresent: bool   # the liveness signal behind ``mode``


class EscalationMessageRequired(TypedDict):
    type: Literal["escalation"]
    ts: int
    vehicleId: str
    missionId: str
    channel: str            # delivery channel id, e.g. "console"
    payload: dict           # channel-specific body, kept verbatim for audit


class EscalationMessage(EscalationMessageRequired, total=False):
    deliveredAt: int        # epoch ms the channel confirmed delivery


class CctvEventRequired(TypedDict):
    """A fixed-camera cue. Audit/provenance ONLY: it never carries a dispatch,
    a route or an altitude. The dispatchable form of a camera cue is an
    Anomaly with source "cctv"."""
    type: Literal["cctvEvent"]
    ts: int
    vehicleId: str
    cameraId: str           # site.cameras[].id
    zone: str               # site.cameras[].zones[].name


# "class" is a Python keyword, so the optional half is declared functionally.
CctvEventOptional = TypedDict("CctvEventOptional", {
    "class": str,           # coarse classifier label, when the camera reports one
    "thumbnail": str,       # repo-relative path or data URL
}, total=False)


class CctvEventMessage(CctvEventRequired, CctvEventOptional):
    pass


class FleetSortie(TypedDict):
    """Sortie budget as the fleet view reports it. Deliberately distinct from
    SortieState: ``must_rtl_by`` is an EPOCH-MS deadline, not seconds into the
    sortie, so a fleet row is comparable across vehicles."""
    elapsed_s: float
    must_rtl_by: int


class FleetVehicleRequired(TypedDict):
    vehicleId: str
    battery: Battery
    controlSource: ControlSource
    failsafe: FleetFailsafe
    readiness: FleetReadiness
    position: LatLonAlt
    sortie: Optional[FleetSortie]   # None when the vehicle is not on a sortie


class FleetVehicle(FleetVehicleRequired, total=False):
    # The corridor this vehicle is currently cleared to fly, when any -- the
    # input a deconfliction check needs from every other vehicle.
    plannedCorridor: Corridor


class FleetMessage(TypedDict):
    type: Literal["fleet"]
    ts: int
    vehicleId: str
    vehicles: list


class MissionRecordRequired(TypedDict):
    """The durable per-mission audit record: everything needed to reconstruct
    why a mission flew, what it was allowed to do, and what it actually did.
    Carries ``vehicleId`` like every other audit entry."""
    missionId: str
    vehicleId: str
    anomalyId: str
    plan: MissionPlan
    verification: Verification
    startedAt: int
    mode: AttendanceMode        # attendance in force when it was dispatched
    planTrace: list             # list[PlanTraceEntry]; [] when none was emitted
    envelopeEvents: list        # list[EnvelopeMessage], in order; [] if none


class MissionRecord(MissionRecordRequired, total=False):
    report: IncidentReport
    endedAt: int
    # The task this mission answered, when one drove it.
    task: Task
    # The corridor the mission was cleared for, when one was generated.
    corridor: Corridor
    # vehicleId that handed this mission over, when it was a handoff.
    handoffFrom: str


class SimulationToggles(TypedDict):
    simulateGpsLoss: bool
    simulateRfInterference: bool
    simulateHostileDrone: bool
    simulateLinkLoss: bool
    simulateCameraFail: bool
    simulateCharging: bool
    simulateBatteryFault: bool
    simulateSortieExpiry: bool
    simulateThermalFail: bool
    simulateLidarFail: bool
    simulateNight: bool


InboundMessage = Union[
    Telemetry, TrackingStatus, StatusTextMsg, CommandAck,
    AnomalyMessage, MissionPlanMessage, VerificationMessage, IncidentReportMessage,
    ObservationMessage, CapabilitiesMessage, PlanCommandAckMessage, ReadinessMessage,
    HealthEventMessage, RfEventMessage, SpectrumMessage, FleetMessage,
    TaskMessage, EnvelopeMessage, ModeMessage, EscalationMessage, CctvEventMessage,
]
OutboundMessage = Union[
    Command, ManualInputMessage, PlanCommandMessage, PlanHeartbeatMessage, RfEventMessage,
]


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
    vehicle_id: str = DEFAULT_VEHICLE_ID


DEFAULTS = Defaults()

# Cruise speed per mission profile, m/s (mirror of shared.ts PROFILE_SPEED_MPS,
# keys are wire values shared with the TS mirrors). These MUST stay under the
# config.py hard max-speed cap (8.0 m/s -- Defaults.max_speed_cap).
PROFILE_SPEED_MPS: dict[MissionProfile, float] = {
    "follow": 2.0,
    "inspect": 4.0,
    "survey": 6.0,
    "slow": 2.0,
    "standard": 4.0,
    "fast": 6.0,
}
