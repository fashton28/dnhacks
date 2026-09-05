"""Pure failure-catalogue state machine.

Every evaluated signal set returns exactly one of none/hold/rtl/escalate/refuse
with a reason and authority.  The orchestrator maps decisions to I/O.
"""
from __future__ import annotations

from dataclasses import dataclass, replace


@dataclass(frozen=True)
class FailsafeSignals:
    airborne: bool = False
    site_valid: bool = True
    readiness_ok: bool = True
    battery_fault: bool = False
    battery_should_rtl: bool = False
    sortie_should_rtl: bool = False
    datalink_lost: bool = False
    planner_heartbeat_lost: bool = False
    gps_healthy: bool = True
    rf_interference_recent: bool = False
    hostile_drone: bool = False
    wind_above_limit: bool = False
    wind_persistent: bool = False
    camera_failed: bool = False
    thermal_failed: bool = False
    night_mission: bool = False
    lidar_failed: bool = False
    route_through_clutter: bool = False
    charge_stalled: bool = False
    soc_degraded: bool = False
    manual_engaged: bool = False


@dataclass(frozen=True)
class FailsafeDecision:
    state: str
    reason: str
    authority: str

    @property
    def command_allowed(self) -> bool:
        return self.state == "none"


def decide(signals: FailsafeSignals) -> FailsafeDecision:
    s = signals
    # Immediate independent return authorities win over every planner outcome.
    if s.airborne and s.battery_fault:
        return FailsafeDecision("rtl", "battery fault in flight", "companion")
    if s.airborne and s.battery_should_rtl:
        return FailsafeDecision("rtl", "battery reserve reached", "companion")
    if s.airborne and s.sortie_should_rtl:
        return FailsafeDecision("rtl", "sortie must-RTL time reached", "companion")
    if s.airborne and s.wind_persistent:
        return FailsafeDecision("rtl", "wind above limit persists", "companion")

    if not s.site_valid:
        return FailsafeDecision("refuse", "site model invalid", "companion")
    if not s.airborne and s.charge_stalled:
        return FailsafeDecision("refuse", "battery charge_stalled", "companion")
    if not s.airborne and (s.battery_fault or not s.readiness_ok):
        return FailsafeDecision("refuse", "battery not ready", "companion")
    if not s.airborne and s.hostile_drone:
        return FailsafeDecision("refuse", "hostile drone in geofence", "companion")
    if not s.airborne and not s.gps_healthy:
        return FailsafeDecision("refuse", "GPS unavailable for mission", "companion")
    if not s.airborne and s.night_mission and s.thermal_failed:
        return FailsafeDecision("refuse", "healthy thermal required at night", "companion")
    if not s.airborne and s.route_through_clutter and s.lidar_failed:
        return FailsafeDecision("refuse", "healthy LiDAR required through clutter", "companion")

    if not s.gps_healthy and s.rf_interference_recent:
        return FailsafeDecision("escalate", "probable interference", "companion")
    if s.airborne and s.hostile_drone:
        return FailsafeDecision("hold", "hostile drone; operator continue or RTL required", "companion")
    if s.datalink_lost:
        return FailsafeDecision("hold", "vehicle datalink lost", "companion")
    if s.planner_heartbeat_lost:
        return FailsafeDecision("hold", "planner heartbeat lost", "companion")
    if not s.gps_healthy:
        return FailsafeDecision("hold", "GPS denied; source vote in progress", "companion")
    if s.wind_above_limit:
        return FailsafeDecision("hold", "wind above limit", "companion")
    if s.airborne and s.lidar_failed:
        return FailsafeDecision("hold", "LiDAR failed; climb to clear altitude", "companion")
    if s.camera_failed:
        return FailsafeDecision("escalate", "no observation: camera failed", "companion")
    if s.airborne and s.thermal_failed:
        return FailsafeDecision("escalate", "thermal failed; observation degraded", "companion")
    if s.soc_degraded:
        return FailsafeDecision("escalate", "battery degraded_estimate", "companion")
    if s.manual_engaged:
        return FailsafeDecision("hold", "manual takeover transition", "companion")
    return FailsafeDecision("none", "", "companion")


class FailsafeMachine:
    """Stateful wrapper for hostile-drone operator-decision latching."""

    def __init__(self) -> None:
        self._hostile_latched = False

    @property
    def hostile_latched(self) -> bool:
        return self._hostile_latched

    def evaluate(self, signals: FailsafeSignals) -> FailsafeDecision:
        if signals.airborne and signals.hostile_drone:
            self._hostile_latched = True
        effective = replace(
            signals,
            hostile_drone=signals.hostile_drone or self._hostile_latched,
        )
        return decide(effective)

    def resolve_hostile(self, action: str) -> FailsafeDecision:
        action = action.strip().lower()
        if action == "continue":
            self._hostile_latched = False
            return FailsafeDecision("none", "hostile-drone hold cleared by operator", "operator")
        if action == "rtl":
            self._hostile_latched = False
            return FailsafeDecision("rtl", "operator chose RTL after hostile drone", "operator")
        return FailsafeDecision("hold", "operator continue or RTL required", "companion")


__all__ = [
    "FailsafeDecision",
    "FailsafeMachine",
    "FailsafeSignals",
    "decide",
]
