"""ARGUS shared contracts.

Frozen in the first two hours. Every workstream codes against these models and
the fixtures in `contracts/fixtures/`. Vocabulary follows CONTEXT.md.

Conventions that everything depends on:

* Positions are WGS84 latitude/longitude in decimal degrees, altitude in metres
  above the Site's ground plane (AGL, not MSL).
* Polygons are a single closed-ish ring of LatLon in order. Do not repeat the
  first point at the end; consumers close the ring themselves.
* Velocities are NED: +vx north, +vy east, **+vz down**. A climb is negative vz.
  Webots' own axes are not NED; the drone controller converts at its boundary.
* All distance, containment and intersection math happens in a local projected
  frame via pyproj. Never in degrees.
* Timestamps are timezone-aware UTC.

`extra="forbid"` is set on every model so Pydantic emits
`additionalProperties: false` in its JSON schema, which is what Anthropic strict
tool use requires. Note that `model_json_schema()` also emits `$defs`/`$ref` for
nested models; for the MissionSpec tool definition, hand-write the flattened
schema in `agent/triage.py` and use these models only to validate the result.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class Base(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --------------------------------------------------------------------------
# Geometry primitives
# --------------------------------------------------------------------------


class LatLon(Base):
    lat: Annotated[float, Field(ge=-90.0, le=90.0)]
    lon: Annotated[float, Field(ge=-180.0, le=180.0)]


class Waypoint(Base):
    lat: Annotated[float, Field(ge=-90.0, le=90.0)]
    lon: Annotated[float, Field(ge=-180.0, le=180.0)]
    alt: Annotated[float, Field(ge=0.0, description="metres AGL")]


class VelocityNED(Base):
    """+vx north, +vy east, +vz DOWN. A climb is negative vz."""

    vx: float
    vy: float
    vz: float


# A polygon is an ordered ring; minimum three points, first point not repeated.
Ring = Annotated[list[LatLon], Field(min_length=3)]


# --------------------------------------------------------------------------
# Site context  (authored by hand, read by the Triage Agent)
# --------------------------------------------------------------------------

ZoneClass = Literal["protected_area", "service_yard", "exclusion_zone", "open_ground"]


class Zone(Base):
    zone_id: str
    name: str
    zone_class: ZoneClass
    ring: Ring
    normally_present: str = Field(
        description="What an operator expects to see here on a normal day. "
        "The Triage Agent reads this; keep it plain prose."
    )


class MaintenanceWindow(Base):
    zone_id: str
    description: str
    starts_at: datetime
    ends_at: datetime


class SiteContext(Base):
    """The Site as the Triage Agent understands it. No imagery, no geometry math."""

    site_id: str
    name: str
    anchor: LatLon
    perimeter: Ring
    zones: list[Zone]
    maintenance_windows: list[MaintenanceWindow] = []
    notes: str = ""


# --------------------------------------------------------------------------
# Wide-area layer
# --------------------------------------------------------------------------

ChangeType = Literal[
    "vehicle",
    "object",
    "structure",
    "ground_disturbance",
    "unknown",
]


class Detection(Base):
    """A candidate change. Unconfirmed; may never become an Incident.

    `change_type` is NOT derived from pixel differencing, which yields a blob and
    not a label. It comes from a vision classification of the cropped overhead
    region, and is `"unknown"` until that runs.
    """

    id: str
    polygon: Ring
    confidence: Annotated[float, Field(ge=0.0, le=1.0)]
    change_type: ChangeType = "unknown"
    before_ref: str = Field(description="stored overhead render, before the Scenario")
    after_ref: str = Field(description="stored overhead render, after the Scenario")
    detected_at: datetime
    area_m2: float | None = Field(
        default=None, description="projected area; feeds confidence and the min-area gate"
    )


# --------------------------------------------------------------------------
# Triage
# --------------------------------------------------------------------------

Objective = Literal["inspect", "perimeter_sweep", "standoff_observe"]


class MissionSpec(Base):
    """The Triage Agent's intent for one Detection. Contains NO waypoints."""

    detection_id: str
    objective: Objective
    survey_polygon: Ring
    max_altitude_m: Annotated[float, Field(gt=0.0)]
    standoff_m: Annotated[float, Field(ge=0.0)]
    rationale: str


class TriageDecision(Base):
    """Triage may decline. Scenario 4's correct outcome is no dispatch at all,
    so the declining path needs to exist as a first-class result."""

    detection_id: str
    action: Literal["dispatch", "log_only", "ignore"]
    rationale: str
    spec: MissionSpec | None = Field(
        default=None, description="present if and only if action == 'dispatch'"
    )


# --------------------------------------------------------------------------
# Planning
# --------------------------------------------------------------------------


class FlightPlan(Base):
    """Deterministic expansion of a MissionSpec. Produced by the Coverage
    Planner, never by the LLM."""

    mission_id: str
    drone_id: str
    waypoints: Annotated[list[Waypoint], Field(min_length=1)]
    pattern: Literal["lawnmower", "orbit", "direct"]
    est_duration_s: float
    est_battery_pct: Annotated[float, Field(ge=0.0, le=100.0)]
    spec: MissionSpec | None = None


# --------------------------------------------------------------------------
# Safety
# --------------------------------------------------------------------------

Severity = Literal["warning", "hard"]

RuleId = Literal[
    "geofence_containment",
    "no_fly_intersection",
    "altitude_ceiling",
    "altitude_floor",
    "battery_reserve",
    "standoff_minimum",
    "mission_duration_cap",
]


class Violation(Base):
    rule: RuleId
    detail: str = Field(description="human-readable, shown verbatim in the Console")
    severity: Severity
    waypoint_index: int | None = None


class ValidationResult(Base):
    mission_id: str
    verdict: Literal["accept", "reject"]
    violations: list[Violation] = []
    attempt: int = Field(default=1, description="repair attempts are capped at 3")


# --------------------------------------------------------------------------
# Drones and Manual Control
# --------------------------------------------------------------------------

DroneStateKind = Literal[
    "idle", "on_mission", "manual_control", "returning", "offline"
]


class DroneState(Base):
    drone_id: str
    lat: float
    lon: float
    alt: float = Field(description="metres AGL")
    heading: Annotated[float, Field(ge=0.0, lt=360.0)]
    velocity_ned: VelocityNED
    battery_pct: Annotated[float, Field(ge=0.0, le=100.0)]
    state: DroneStateKind
    mission_id: str | None = None
    ts: datetime


class ManualCommand(Base):
    """One velocity command from the Operator, at about 10 Hz.

    `seq` is monotonic per drone: the Hub drops out-of-order commands and
    ClampEvents reference it, so the Console can show which keypress was
    clamped rather than just that something was.
    """

    drone_id: str
    seq: int
    velocity_ned: VelocityNED
    yaw_rate: float = Field(description="deg/s, positive clockwise from above")
    ts: datetime


class ClampEvent(Base):
    """Emitted whenever the Safety Validator modifies an Operator command.

    `distance_to_boundary_m` is what lets the Drone view draw the wall the
    Operator just hit, instead of only reporting that they hit one.
    """

    drone_id: str
    seq: int
    original: ManualCommand
    clamped: ManualCommand
    rule: RuleId
    detail: str
    distance_to_boundary_m: float | None = None
    ts: datetime


class ControlHandover(Base):
    """Manual Control is a session, not a mode flag: it pauses a Mission and
    ends in resume or abort. Making the transition explicit keeps the Hub's
    state machine honest and gives the audit log something to record."""

    drone_id: str
    action: Literal["take", "release_resume", "release_abort"]
    operator: str
    ts: datetime


# --------------------------------------------------------------------------
# Observation and reporting
# --------------------------------------------------------------------------


class Observation(Base):
    """One frame plus the vision model's reading of it."""

    mission_id: str
    drone_id: str
    frame_ref: str
    waypoint_index: int
    captured_at: datetime
    description: str
    salient: bool = Field(description="True if this frame drove the verdict")


class IncidentReport(Base):
    mission_id: str
    verdict: Literal["false_alarm", "log", "escalate"]
    narrative: str
    evidence_refs: list[str] = []
    observations: list[Observation] = []
    created_at: datetime


# --------------------------------------------------------------------------
# Scenarios
# --------------------------------------------------------------------------

ScenarioKind = Literal[
    "intruder_vehicle",
    "unattended_object",
    "unattended_object_benign",
    "authorized_activity",
    "perimeter_opening",
]


class Scenario(Base):
    id: str
    kind: ScenarioKind
    params: dict[str, object] = {}
    run_at: datetime | None = None


# --------------------------------------------------------------------------
# Hub to Console envelope
# --------------------------------------------------------------------------


class FramePayload(Base):
    drone_id: str
    jpeg_b64: str
    ts: datetime


class HubEvent(Base):
    """Everything the Console receives arrives in this envelope on one
    WebSocket. `type` is the discriminator the Console switches on; exactly one
    payload field is set. Adding a field here is a contract change: announce it.
    """

    type: Literal[
        "drone_state",
        "frame",
        "detection",
        "triage_decision",
        "flight_plan",
        "validation_result",
        "clamp",
        "handover",
        "observation",
        "incident_report",
        "scenario_started",
        "log",
    ]
    ts: datetime

    drone_state: DroneState | None = None
    frame: FramePayload | None = None
    detection: Detection | None = None
    triage_decision: TriageDecision | None = None
    flight_plan: FlightPlan | None = None
    validation_result: ValidationResult | None = None
    clamp: ClampEvent | None = None
    handover: ControlHandover | None = None
    observation: Observation | None = None
    incident_report: IncidentReport | None = None
    scenario: Scenario | None = None
    message: str | None = None
