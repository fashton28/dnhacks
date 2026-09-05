"""
eis_companion.control -- the safety-critical control core.

Pure-logic modules (numpy + stdlib only, no hardware) so the whole control loop
unit-tests with no FC, camera, or detector:

  pid       PID controller (clamp + anti-windup, dt-aware, reset)
  distance  monocular distance-from-bbox-height (pinhole geometry)
  tracker   single-target multi-object tracker (IoU + Kalman, stable ids, lock)
  guidance  visual-servoing -> BODY-frame VelocitySetpoint (HARD standoff)
  manual    manual stick -> BODY-frame VelocitySetpoint (deadzone + watchdog)
"""
from __future__ import annotations

from .distance import (
    estimate_distance,
    estimate_distance_px,
    focal_px_from_vfov,
    DEFAULT_PERSON_HEIGHT_M,
)
from .guidance import Guidance
from .manual import ManualPilot
from .pid import PID
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
]
