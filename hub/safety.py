"""The Safety Validator: the deterministic gate between a FlightPlan and a Drone.

Contains no LLM and does no I/O. Geometry and limits in, ValidationResult out, so a
verdict is reproducible and testable without a Hub, a renderer or a network.

Two things it must get right, because both are easy to get wrong:

* **Segments, not just waypoints.** A plan whose vertices are all legal can still fly
  straight through the reactor exclusion. Every check that can be violated between two
  waypoints is run on the segment, not the endpoints.
* **One rule table, two enforcement points.** `validate()` gates a FlightPlan before
  dispatch and `clamp()` gates each Manual Control command in flight. They read the same
  `SiteLimits`, so the Operator cannot reach anywhere a Mission could not.

ArduPilot's own polygon fence sits beneath both as an independent third layer that
nothing here can disable.
"""
from __future__ import annotations

from shapely.geometry import LineString, Point, Polygon

from contracts.models import (
    DroneState,
    FlightPlan,
    Objective,
    Severity,
    ValidationResult,
    Verdict,
    Violation,
    Waypoint,
)
from contracts.site import latlon_to_enu
from sim.common.site_limits import SiteLimits

# Defaults. A profile or config may tighten these; nothing may relax them.
BATTERY_RESERVE_PCT = 25.0
MAX_MISSION_DURATION_S = 480.0


def _enu(wp: Waypoint) -> tuple[float, float]:
    return latlon_to_enu(wp.lat, wp.lon)


def _segments(waypoints: list[Waypoint]) -> list[tuple[int, int, LineString]]:
    """Consecutive waypoint pairs as ENU lines, with their indices for the violation detail."""
    out: list[tuple[int, int, LineString]] = []
    for i in range(len(waypoints) - 1):
        a, b = _enu(waypoints[i]), _enu(waypoints[i + 1])
        if a != b:
            out.append((i, i + 1, LineString([a, b])))
    return out


def _zone_applies(polygon: Polygon, ceiling_m: float | None, alt_a: float, alt_b: float) -> bool:
    """A zone with a ceiling is only closed at or below it; a zone without one is always closed."""
    return ceiling_m is None or min(alt_a, alt_b) <= ceiling_m


def validate(
    plan: FlightPlan,
    limits: SiteLimits | None = None,
    state: DroneState | None = None,
    *,
    reserve_pct: float = BATTERY_RESERVE_PCT,
    max_duration_s: float = MAX_MISSION_DURATION_S,
) -> ValidationResult:
    """Admit or refuse one FlightPlan. Every violation names the rule that produced it."""
    limits = limits or SiteLimits.load()
    v: list[Violation] = []
    wps = plan.waypoints

    # --- geofence containment: every waypoint, and every segment between them -----------
    for i, wp in enumerate(wps):
        x, y = _enu(wp)
        if not limits.inside(x, y):
            v.append(Violation(rule="geofence_containment", severity=Severity.hard, waypoint_index=i,
                               detail=f"waypoint {i} ({wp.lat:.6f}, {wp.lon:.6f}) is outside the geofence"))
    for i, j, line in _segments(wps):
        if not limits.geofence_enu.covers(line):
            v.append(Violation(rule="geofence_containment", severity=Severity.hard, waypoint_index=i,
                               detail=f"segment {i}-{j} leaves the geofence between waypoints"))

    # --- no-fly zones: a legal pair of waypoints can still cross one --------------------
    for zone in limits.no_fly:
        for i, wp in enumerate(wps):
            if zone.polygon_enu.covers(Point(_enu(wp))) and _zone_applies(zone.polygon_enu, zone.ceiling_m, wp.alt, wp.alt):
                v.append(Violation(rule="no_fly_zone", severity=Severity.hard, waypoint_index=i,
                                   detail=f"waypoint {i} is inside no-fly zone '{zone.name}'"))
        for i, j, line in _segments(wps):
            if line.intersects(zone.polygon_enu) and _zone_applies(zone.polygon_enu, zone.ceiling_m, wps[i].alt, wps[j].alt):
                v.append(Violation(rule="no_fly_zone", severity=Severity.hard, waypoint_index=i,
                                   detail=f"segment {i}-{j} crosses no-fly zone '{zone.name}'"))

    # --- altitude band -----------------------------------------------------------------
    for i, wp in enumerate(wps):
        if wp.alt > limits.alt_ceiling_m:
            v.append(Violation(rule="altitude_ceiling", severity=Severity.hard, waypoint_index=i,
                               detail=f"waypoint {i} at {wp.alt} m exceeds the {limits.alt_ceiling_m} m ceiling"))
        if wp.alt < limits.alt_floor_m:
            v.append(Violation(rule="altitude_floor", severity=Severity.hard, waypoint_index=i,
                               detail=f"waypoint {i} at {wp.alt} m is below the {limits.alt_floor_m} m floor"))

    # --- endurance ---------------------------------------------------------------------
    available = (state.battery_pct if state is not None else 100.0) - reserve_pct
    if plan.est_battery_pct > available:
        v.append(Violation(rule="battery_reserve", severity=Severity.violation,
                           detail=f"plan needs {plan.est_battery_pct}% but only {available:.1f}% is available "
                                  f"above the {reserve_pct}% reserve"))
    if plan.est_duration_s > max_duration_s:
        v.append(Violation(rule="mission_duration_cap", severity=Severity.violation,
                           detail=f"plan runs {plan.est_duration_s:.0f} s, over the {max_duration_s:.0f} s cap"))

    # --- standoff: only meaningful when the MissionSpec asked to observe from a distance --
    if plan.spec is not None and plan.spec.objective == Objective.standoff_observe and plan.spec.standoff_m > 0:
        target = Polygon([latlon_to_enu(p.lat, p.lon) for p in plan.spec.survey_polygon])
        for i, wp in enumerate(wps):
            d = Point(_enu(wp)).distance(target)
            if d < plan.spec.standoff_m:
                v.append(Violation(rule="standoff_minimum", severity=Severity.warning, waypoint_index=i,
                                   detail=f"waypoint {i} is {d:.1f} m from the survey area, inside the "
                                          f"{plan.spec.standoff_m} m standoff"))

    blocking = any(x.severity in (Severity.hard, Severity.violation) for x in v)
    return ValidationResult(
        mission_id=plan.mission_id,
        verdict=Verdict.reject if blocking else Verdict.accept,
        violations=v,
    )
