"""The trust layer: a deterministic gate between the LLM and the airframe.

No model runs in this file. Every rule is plain arithmetic against
`config/facility_riverbend.json`, which means a reviewer can audit exactly what
the system will and will not permit — something you cannot do with a prompt.

Nothing reaches the drone-control layer without `verify(...).approved` being
True. Violations are returned in a machine-readable form so the planner can be
given a second chance with the specific reason it failed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from . import geo
from .facility import Facility
from .types import ContractError, validate_mission_plan

# How finely a leg is sampled when checking it against no-fly zones. 10 m is well
# under the smallest zone radius in the config, so a leg cannot skip over one.
LEG_SAMPLE_M = 10.0


@dataclass(frozen=True)
class Violation:
    code: str
    message: str
    waypoint_index: int | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "message": self.message,
            "waypoint_index": self.waypoint_index,
        }


@dataclass
class Verdict:
    approved: bool
    violations: list[Violation] = field(default_factory=list)
    checks_passed: int = 0
    flight_time_s: float = 0.0
    path_length_m: float = 0.0
    battery_needed_pct: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "approved": self.approved,
            "violations": [v.as_dict() for v in self.violations],
            "checks_passed": self.checks_passed,
            "flight_time_s": round(self.flight_time_s, 1),
            "path_length_m": round(self.path_length_m, 1),
            "battery_needed_pct": round(self.battery_needed_pct, 1),
        }

    def feedback(self) -> str:
        """The rejection, written for the planner to act on."""
        lines = [
            f"- [{v.code}] {v.message}"
            + (f" (waypoint index {v.waypoint_index})" if v.waypoint_index is not None else "")
            for v in self.violations
        ]
        return "\n".join(lines)


def estimate_flight(facility: Facility, waypoints: list[dict[str, Any]]) -> tuple[float, float]:
    """Return (flight_time_s, path_length_m) for base -> waypoints -> base.

    Climb/descent time is folded in as vertical distance at cruise speed, which
    is pessimistic for a multirotor — pessimistic is the right direction for a
    safety check.
    """
    lim = facility.limits
    path = [facility.base] + [(wp["lat"], wp["lon"]) for wp in waypoints] + [facility.base]
    horizontal = geo.path_length_m(path)

    alts = [0.0] + [wp["alt_m"] for wp in waypoints] + [0.0]
    vertical = sum(abs(alts[i + 1] - alts[i]) for i in range(len(alts) - 1))

    hover = sum(wp["duration_s"] for wp in waypoints)
    transit = (horizontal + vertical) / max(lim.cruise_speed_mps, 0.1)
    return transit + hover, horizontal


def _leg_enters_zone(a: tuple[float, float], b: tuple[float, float], zone) -> bool:
    """Sample along a leg and test each sample against a circular no-fly zone."""
    leg_m = geo.haversine_m(a, b)
    steps = max(int(leg_m / LEG_SAMPLE_M), 1)
    for i in range(steps + 1):
        t = i / steps
        point = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
        if geo.haversine_m(point, zone.center) < zone.radius_m:
            return True
    return False


def verify(
    plan: dict[str, Any],
    facility: Facility,
    *,
    battery_pct: float,
    anomaly: dict[str, Any] | None = None,
) -> Verdict:
    """Check a mission plan against every hard constraint. Never raises."""
    violations: list[Violation] = []
    checks = 0
    lim = facility.limits

    # ---- 0. The plan is even shaped like a plan -------------------------------
    checks += 1
    try:
        plan = validate_mission_plan(plan)
    except ContractError as exc:
        return Verdict(
            approved=False,
            violations=[Violation("MALFORMED_PLAN", str(exc))],
            checks_passed=0,
        )

    waypoints = plan["waypoints"]

    # ---- 1. Waypoint count ----------------------------------------------------
    checks += 1
    if len(waypoints) > lim.max_waypoints:
        violations.append(
            Violation(
                "TOO_MANY_WAYPOINTS",
                f"plan has {len(waypoints)} waypoints; limit is {lim.max_waypoints}",
            )
        )

    # ---- 2. Geofence containment ----------------------------------------------
    checks += 1
    for i, wp in enumerate(waypoints):
        if not geo.point_in_polygon((wp["lat"], wp["lon"]), facility.geofence):
            violations.append(
                Violation(
                    "OUTSIDE_GEOFENCE",
                    f"({wp['lat']:.6f}, {wp['lon']:.6f}) lies outside the facility geofence",
                    i,
                )
            )

    # ---- 3. Altitude envelope -------------------------------------------------
    checks += 1
    for i, wp in enumerate(waypoints):
        if wp["alt_m"] < lim.min_alt_m:
            violations.append(
                Violation(
                    "BELOW_MIN_ALTITUDE",
                    f"altitude {wp['alt_m']:.1f} m is below the {lim.min_alt_m:.0f} m floor",
                    i,
                )
            )
        elif wp["alt_m"] > lim.max_alt_m:
            violations.append(
                Violation(
                    "ABOVE_MAX_ALTITUDE",
                    f"altitude {wp['alt_m']:.1f} m exceeds the {lim.max_alt_m:.0f} m ceiling",
                    i,
                )
            )

    # ---- 4. No-fly zones: waypoints -------------------------------------------
    checks += 1
    for i, wp in enumerate(waypoints):
        for zone in facility.no_fly_zones:
            d = geo.haversine_m((wp["lat"], wp["lon"]), zone.center)
            if d < zone.radius_m:
                violations.append(
                    Violation(
                        "IN_NO_FLY_ZONE",
                        f"waypoint is {d:.0f} m from the centre of no-fly zone "
                        f"'{zone.id}' (radius {zone.radius_m:.0f} m): {zone.description}",
                        i,
                    )
                )

    # ---- 5. No-fly zones: transit legs ----------------------------------------
    # An LLM will happily put two legal waypoints on opposite sides of a hazard.
    checks += 1
    route = [facility.base] + [(wp["lat"], wp["lon"]) for wp in waypoints] + [facility.base]
    for leg_index in range(len(route) - 1):
        a, b = route[leg_index], route[leg_index + 1]
        for zone in facility.no_fly_zones:
            if _leg_enters_zone(a, b, zone):
                violations.append(
                    Violation(
                        "LEG_CROSSES_NO_FLY_ZONE",
                        f"the transit leg from point {leg_index} to {leg_index + 1} passes "
                        f"through no-fly zone '{zone.id}': {zone.description}. Insert an "
                        f"intermediate waypoint that routes around it.",
                        min(leg_index, len(waypoints) - 1),
                    )
                )

    # ---- 6. Leg length sanity -------------------------------------------------
    checks += 1
    for leg_index in range(len(route) - 1):
        leg_m = geo.haversine_m(route[leg_index], route[leg_index + 1])
        if leg_m > lim.max_leg_m:
            violations.append(
                Violation(
                    "LEG_TOO_LONG",
                    f"leg {leg_index}->{leg_index + 1} is {leg_m:.0f} m; limit is "
                    f"{lim.max_leg_m:.0f} m (likely a bad coordinate)",
                    min(leg_index, len(waypoints) - 1),
                )
            )

    # ---- 7. Hover duration ----------------------------------------------------
    checks += 1
    for i, wp in enumerate(waypoints):
        if wp["duration_s"] > lim.max_hover_s:
            violations.append(
                Violation(
                    "HOVER_TOO_LONG",
                    f"hover of {wp['duration_s']:.0f} s exceeds the {lim.max_hover_s:.0f} s limit",
                    i,
                )
            )

    # ---- 8. Range and battery -------------------------------------------------
    checks += 1
    flight_time_s, path_length_m = estimate_flight(facility, waypoints)
    battery_needed = (flight_time_s / 60.0) * lim.battery_drain_pct_per_min

    if path_length_m > lim.max_mission_range_m:
        violations.append(
            Violation(
                "EXCEEDS_RANGE",
                f"total path is {path_length_m:.0f} m; limit is {lim.max_mission_range_m:.0f} m",
            )
        )

    checks += 1
    available = battery_pct - lim.min_battery_reserve_pct
    if battery_needed > available:
        violations.append(
            Violation(
                "INSUFFICIENT_BATTERY",
                f"mission needs {battery_needed:.1f}% battery but only {available:.1f}% is "
                f"usable ({battery_pct:.0f}% charge minus a {lim.min_battery_reserve_pct:.0f}% "
                f"reserve). Shorten the route or reduce hover time.",
            )
        )

    # ---- 9. Does the mission actually observe the anomaly? --------------------
    # Catches a plan that is perfectly legal and completely useless.
    checks += 1
    if anomaly is not None:
        target = (anomaly["lat"], anomaly["lon"])
        observing = [
            geo.haversine_m((wp["lat"], wp["lon"]), target)
            for wp in waypoints
            if wp["action"] == "hover"
        ]
        closest = min(observing) if observing else None
        if closest is None:
            violations.append(
                Violation(
                    "NO_OBSERVATION_WAYPOINT",
                    "the plan contains no 'hover' waypoint, so it collects no observations",
                )
            )
        elif closest > lim.anomaly_proximity_m:
            violations.append(
                Violation(
                    "ANOMALY_NOT_OBSERVED",
                    f"the closest hover waypoint is {closest:.0f} m from the reported anomaly; "
                    f"it must be within {lim.anomaly_proximity_m:.0f} m to observe it",
                )
            )

    return Verdict(
        approved=not violations,
        violations=violations,
        checks_passed=checks - len({v.code for v in violations}),
        flight_time_s=flight_time_s,
        path_length_m=path_length_m,
        battery_needed_pct=battery_needed,
    )
