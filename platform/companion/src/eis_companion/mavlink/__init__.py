"""
============================================================================
Drone Safety Platform -- COMPANION MAVLink layer
----------------------------------------------------------------------------
The vehicle-facing seam between the companion's pure-logic control core
(guidance / manual / safety) and the ArduPilot flight controller.

Modules
  vehicle.py  -- ``Vehicle``: a thin pymavlink wrapper. Connect, request data
                 streams, translate FC MAVLink into the contract ``telemetry``
                 dict + a ``VehicleState`` snapshot, run the command set
                 (arm/disarm/mode/takeoff/land/rtl), stream BODY-frame
                 velocity setpoints via SET_POSITION_TARGET_LOCAL_NED, fly
                 GUIDED global position targets (``goto_global``), and upload
                 the site perimeter as an ArduPilot polygon inclusion fence
                 (``upload_geofence``, called by the orchestrator post-connect).
  safety.py   -- ``SafetyManager``: ground-link deadman, arming preconditions,
                 emergency-stop mapping, and the ArduCopter geofence + failsafe
                 PARAM map (returned as a plain dict so docs/flashing.md and a
                 ``set_params`` helper can apply them).

SAFETY (PRD 11): standoff is a hard limit (enforced in guidance, not here);
every output is clamped to ``Limits``; the deadman holds/RTLs on link loss;
emergencyStop/disarm override everything; the FC is configured so RC override
ALWAYS wins -- this layer never sends an RC override.

``vehicle.py`` imports ``pymavlink`` (hardware-facing) and is NOT pure-logic.
``safety.py`` is pure stdlib so it unit-tests with no hardware.
============================================================================
"""
from __future__ import annotations

from .safety import (
    SafetyManager,
    ArmCheckResult,
    LinkStatus,
    failsafe_param_map,
)

__all__ = [
    "SafetyManager",
    "ArmCheckResult",
    "LinkStatus",
    "failsafe_param_map",
    # Vehicle is exported lazily (see __getattr__) so importing the safety
    # helpers does not require pymavlink to be installed.
]


def __getattr__(name: str):
    # Lazy re-export of the pymavlink-dependent ``Vehicle`` so that importing
    # ``eis_companion.mavlink`` for the (pure-stdlib) SafetyManager does not
    # drag in pymavlink on machines / CI that don't have it.
    if name == "Vehicle":
        from .vehicle import Vehicle

        return Vehicle
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
