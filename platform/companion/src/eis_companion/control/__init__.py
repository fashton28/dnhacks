"""
eis_companion.control -- the safety-critical control core.

Every module here is pure logic (numpy + stdlib, no I/O, no hardware), so the
whole loop unit-tests without a flight controller, camera or detector. The
orchestrator (``eis_companion.app``) composes these pieces; none of them
schedules, sleeps or talks to a socket.

Servo core (person following)
  pid        PIDGains / PIDState records around a pure ``pid_step``; the
             ``PID`` facade adds tracking anti-windup, dt awareness and
             refusal of non-finite samples
  distance   pinhole range from a normalised bbox height (``PinholeCamera``)
  tracker    generic matrix ``KalmanFilter`` -> constant-velocity ``BoxFilter``,
             vectorised IoU association, table-driven idle/searching/locked/lost
  guidance   image-plane error vector -> three servo channels -> one body
             setpoint through clamp -> standoff gate -> smooth -> gate -> clamp
             (the standoff is a HARD floor, PRD 11)
  manual     stick frame -> body setpoint via a fixed mapping matrix, behind a
             deadman that zeroes-and-holds on input or link loss

Mission and assurance
  planner_exec MissionPlan executor -> GotoTarget / VelocitySetpoint per tick
  failsafe     failure catalogue -> exactly one of none/hold/rtl/escalate/refuse
  envelope     runtime envelope monitor -> state + constraint + action request
  mode         attended/unattended state machine + UNATTENDED_ENVELOPE
  gimbal       mount pitch: clamp, slew limit, deterministic auto-pointing

``envelope`` and ``guidance`` deliberately know nothing about each other: the
monitor constrains and never guides, and its verdict reaches the flight state
only through ``failsafe``, routed by the orchestrator.
"""
from __future__ import annotations

from .distance import (
    estimate_distance,
    estimate_distance_px,
    focal_px_from_vfov,
    DEFAULT_PERSON_HEIGHT_M,
)
from .envelope import (
    Corridor,
    EnvelopeDecision,
    EnvelopeLimits,
    EnvelopeMonitor,
    EnvelopeSample,
    PeerSample,
    SiteGeometry,
)
from .failsafe import FailsafeDecision, FailsafeMachine, FailsafeSignals
from .gimbal import GimbalController, GimbalLimits
from .guidance import Guidance
from .manual import ManualPilot
from .mode import (
    AttendanceMachine,
    DispatchRequest,
    UnattendedEnvelope,
    check_unattended,
)
from .pid import PID
from .planner_exec import (
    GotoTarget,
    PlanOutputKind,
    PlannerExecutor,
    PlannerOutput,
)
from .tracker import (
    DetectedTargetView,
    Track,
    Tracker,
    TrackingResult,
    iou,
)

__all__ = [
    "PID",
    "estimate_distance",
    "estimate_distance_px",
    "focal_px_from_vfov",
    "DEFAULT_PERSON_HEIGHT_M",
    "Tracker",
    "Track",
    "TrackingResult",
    "DetectedTargetView",
    "iou",
    "Guidance",
    "ManualPilot",
    "PlannerExecutor",
    "PlannerOutput",
    "PlanOutputKind",
    "GotoTarget",
    "FailsafeDecision",
    "FailsafeMachine",
    "FailsafeSignals",
    "Corridor",
    "EnvelopeDecision",
    "EnvelopeLimits",
    "EnvelopeMonitor",
    "EnvelopeSample",
    "PeerSample",
    "SiteGeometry",
    "AttendanceMachine",
    "DispatchRequest",
    "UnattendedEnvelope",
    "check_unattended",
    "GimbalController",
    "GimbalLimits",
]
