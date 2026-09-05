"""
============================================================================
Eye in the Sky -- Vision sub-package
----------------------------------------------------------------------------
Provides camera capture, person detection, synthetic simulation source, and
TensorRT engine export for the Jetson.

Public re-exports make ``from eis_companion.vision import Capture, ...``
work cleanly from the rest of the companion.
============================================================================
"""
from .capture import Capture
from .detector import PersonDetector
from .sim_source import SimTargetSource

__all__ = [
    "Capture",
    "PersonDetector",
    "SimTargetSource",
]
