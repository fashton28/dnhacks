"""
eis_companion.control -- the safety-critical control core.

Pure-logic modules (numpy + stdlib only, no hardware) so the whole control loop
unit-tests with no FC, camera, or detector:

  pid          PID controller (clamp + anti-windup, dt-aware, reset)
  distance     monocular distance-from-bbox-height (pinhole geometry)
  tracker      single-target multi-object tracker (IoU + Kalman, stable ids, lock)
  guidance     visual-servoing -> BODY-frame VelocitySetpoint (HARD standoff)
  manual       manual stick -> BODY-frame VelocitySetpoint (deadzone + watchdog)
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
