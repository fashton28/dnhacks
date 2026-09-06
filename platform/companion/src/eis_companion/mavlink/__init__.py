"""
============================================================================
Drone Safety Platform -- COMPANION MAVLink layer
----------------------------------------------------------------------------
Everything the companion knows about talking to an ArduPilot flight
controller lives behind this package. On one side of it are the pure-logic
controllers (guidance, manual piloting, the tracker, the failsafe ladders);
on the other is a real vehicle. Nothing crosses without going through here.

Two modules, split by whether they touch hardware:

  ``safety``   PURE STDLIB, unit-testable with no vehicle. ``SafetyManager``
               (ground-link deadman, arming preconditions, emergency-stop
               mapping), the FC-egress clamp that forms the second stage of
               "clamped twice" (``clamp_body_velocity``, ``clamp_goto_target``)
               and ``failsafe_param_map`` -- the ArduCopter geofence + failsafe
               PARAM table, returned as a plain dict so ``docs/flashing.md``
               can table it and ``Vehicle.apply_failsafe_params`` can push it.

  ``vehicle``  IMPORTS PYMAVLINK. ``Vehicle`` connects (UDP for SITL, serial on
               the airframe), requests the data streams, translates inbound FC
               MAVLink into the contract ``telemetry`` dict and a
               ``VehicleState`` snapshot, runs the discrete command set
               (arm / disarm / mode / takeoff / land / RTL), streams BODY-frame
               velocity setpoints, flies GUIDED global position targets for the
               mission planner, publishes the LiDAR / extnav rails, and uploads
               the site perimeter as an ArduPilot polygon inclusion fence.

SAFETY (PRD 11): standoff is a hard limit enforced in guidance, not here;
every output is clamped to ``Limits`` in-component and again on the way out of
this layer; the deadman holds then RTLs on ground-link loss; emergencyStop and
disarm override everything; and the FC is configured so RC override ALWAYS
wins -- nothing in this package ever sends an RC override.

``Vehicle`` is resolved LAZILY (see ``__getattr__``) so that importing this
package for the pure-logic safety helpers -- which the orchestrator, the
tests and the docs tooling all do -- never requires pymavlink to be installed.
============================================================================
"""
from __future__ import annotations

from .safety import (
    ArmCheckResult,
    LinkStatus,
    SafetyManager,
    failsafe_param_map,
)

#: Attribute name -> the submodule it is imported from on first access. Only
#: hardware-dependent names belong here; everything else is imported eagerly
#: above.
_LAZY: dict = {"Vehicle": ".vehicle"}

# ``Vehicle`` is deliberately ABSENT from ``__all__``: a star-import must not
# be the thing that drags pymavlink onto a machine that only wanted the
# pure-logic helpers. Reach it by name (``mavlink.Vehicle``), which triggers
# the lazy resolution below.
__all__ = [
    "SafetyManager",
    "ArmCheckResult",
    "LinkStatus",
    "failsafe_param_map",
]


def __getattr__(name: str):
    """Resolve the pymavlink-dependent exports on first use, not at import."""
    module = _LAZY.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    from importlib import import_module

    return getattr(import_module(module, __name__), name)


def __dir__() -> list:
    return sorted(set(globals()) | set(__all__) | set(_LAZY))
