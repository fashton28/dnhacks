"""
============================================================================
Drone Safety Platform -- Vision sub-package
----------------------------------------------------------------------------
Provides camera capture, person detection, synthetic simulation source, and
TensorRT engine export for the Jetson.

Public re-exports make ``from eis_companion.vision import Capture, ...``
work cleanly from the rest of the companion. Each one is resolved on first
use (PEP 562) rather than at package import, because the backends behind them
are not all installable on every box: a SITL run that only wants
``SimTargetSource`` must not pay for -- or fail on -- OpenCV and ultralytics.
============================================================================
"""
from __future__ import annotations

from importlib import import_module
from typing import Any, Dict, List

#: exported name -> the module inside this package that defines it
_EXPORTED_BY: Dict[str, str] = {
    "Capture": "capture",
    "PersonDetector": "detector",
    "SimTargetSource": "sim_source",
    "StagingObserver": "staging",
    "StagingPoint": "staging",
}


def __getattr__(name: str) -> Any:
    """Import the owning module on the first read of a re-exported name."""
    origin = _EXPORTED_BY.get(name)
    if origin is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(f".{origin}", __name__), name)
    globals()[name] = value      # bind it, so later reads skip this hook
    return value


def __dir__() -> List[str]:
    return sorted(set(globals()) | set(_EXPORTED_BY))


__all__ = [
    "Capture",
    "PersonDetector",
    "SimTargetSource",
    "StagingObserver",
    "StagingPoint",
]
