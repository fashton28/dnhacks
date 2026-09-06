"""
rails/deterministic — the oracle's ONLY source of flight plans.

Reference of ``platform/ground/planner/src/deterministic.ts``. A task (what to
look for and why) plus the site model, the vehicle's capabilities and its live
state produce exactly one plan, or ``infeasible``. No model, no cue and no
operator text influences a coordinate, an altitude, a radius or a speed: this
is the rule table of ADR D20, and it is the defence against the luring attack
in ``platform/docs/THREAT_MODEL.md`` § A6.2.

| Rule         | Definition |
|---|---|
| Profile      | person/vehicle/fence_gap -> inspect; structure -> survey; unknown -> inspect |
| Dispatch     | The state gates the verifier would refuse on are refused HERE, before a plan exists |
| Altitude     | Middle of (profile band n site band n unattended band when unattended); empty -> infeasible |
| Route        | Straight leg, else the shortest via-point detour around buffered NFZs, else infeasible |
| Orbit        | Profile radius shrunk to clear NFZ + geofence, NEVER below standoff; else infeasible |
| Laps         | Exactly 1 |
| Hold         | 15 s, and only for ``fence_gap`` |
| Terminal     | ``rtl`` |
| Time budget  | min(live-SoC range time, sortie cap); over budget -> trim holds/laps, else infeasible |
| Separation   | Altitude chosen clear of any peer corridor it would cross |
| Tie-break    | Lowest total detour, then the northernmost via-point |

The planner NEVER emits a plan that violates a limit. A ``corrected`` verdict
on this planner's output is a bug in the planner, not a save by the verifier —
:mod:`rails.eval_planner` asserts ``pass`` or ``infeasible`` over every fixture
state, never ``corrected``.

``planTrace`` carries the RULES THAT FIRED, never geometry: a trace entry is
reason-for-record only, so no entry below prints a coordinate, an altitude or a
radius. The plan itself is the geometry.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .geometry import (
    CorridorGeometry, Point, corridor_geometry_from_walk, haversine_meters, lateral_separation_m,
    lateral_tolerance_m, leg_needs_lidar, orbit_entry_point, point_in_or_on_polygon, policy_for,
    round6, route_vias, shrink_orbit_radius, time_budget_seconds, trim_to_budget,
    vertical_separation_m, walk_plan, wind_adjusted_seconds,
)
from .policy import (
    CORRIDOR_POLICY, DECONFLICTION_POLICY, PLANNER_POLICY, UNATTENDED_ENVELOPE, VERIFIER_POLICY,
)
from .schemas import Anomaly, Corridor, MissionPlan, PlanTraceEntry, Task
from .site import SiteModel
from .verifier import (
    Context, battery_of, nav_source_of, peer_geometry, required_separation_m, site_validity,
    start_altitude, start_position,
)


@dataclass
class PlannedMission:
    infeasible: bool
    plan: Optional[MissionPlan] = None
    planTrace: List[PlanTraceEntry] = field(default_factory=list)
    corridor: Optional[Corridor] = None
    #: min(range time, sortie cap), seconds.
    timeBudgetS: float = 0.0
    #: Wind-adjusted flight time of the emitted plan, seconds.
    estimatedFlightS: float = 0.0
    #: Why no plan exists, when ``infeasible``.
    reason: Optional[str] = None

    @property
    def trace_rules(self) -> List[str]:
        return [entry.rule for entry in self.planTrace]


def profile_for_look_for(look_for: str) -> str:
    """``lookFor`` -> mission profile (ADR D20). Unknown looks are inspected."""
    return "survey" if look_for == "structure" else "inspect"


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def dispatch_refusals(context: Context, unattended: bool) -> List[str]:
    """The dispatch gates, in the verifier's own terms.

    The planner refuses HERE so the refusal is a reason a human can read,
    instead of a plan that exists only to be rejected.
    """
    refusals: List[str] = []
    nav_source = nav_source_of(context)
    if nav_source is None:
        refusals.append("runtime navigation source is unknown")
    elif nav_source != "gps":
        refusals.append(f"navigation source is {nav_source}")

    readiness = context.get("readiness")
    if readiness is None:
        refusals.append("readiness envelope is unknown")
    elif not readiness.get("ready"):
        reasons = readiness.get("reasons") or []
        refusals.extend(reasons if reasons else ["vehicle not ready"])

    battery = battery_of(context)
    min_soc = max(VERIFIER_POLICY["dispatchMinSocPct"],
                  context.get("dispatchMinSocPct") if context.get("dispatchMinSocPct") is not None else 0)
    max_delta = min(VERIFIER_POLICY["cellImbalanceMaxV"],
                    context.get("cellImbalanceMaxV") if context.get("cellImbalanceMaxV") is not None else math.inf)
    max_temp = min(VERIFIER_POLICY["battTempMaxC"],
                   context.get("battTempMaxC") if context.get("battTempMaxC") is not None else math.inf)
    if battery is None:
        refusals.append("battery telemetry is unknown")
    else:
        soc = battery.get("soc_pct")
        if not _finite(soc):
            refusals.append("battery SoC is non-finite")
        elif soc < min_soc:
            refusals.append(f"battery SoC {_number(soc)}% is below {_number(min_soc)}%")
        if battery.get("charge_state") != "charged":
            refusals.append(f"charge_state is {battery.get('charge_state') or 'unknown'}")
        if battery.get("fault"):
            refusals.append(f"battery fault: {battery['fault']}")
        if _finite(battery.get("cell_delta_v")) and battery["cell_delta_v"] > max_delta:
            refusals.append(
                f"cell delta {_number(battery['cell_delta_v'])} V exceeds {_number(max_delta)} V")
        if _finite(battery.get("temp_c")) and battery["temp_c"] > max_temp:
            refusals.append(
                f"battery temperature {_number(battery['temp_c'])} C exceeds {_number(max_temp)} C")

    wind_limit = UNATTENDED_ENVELOPE["maxWindMps"] if unattended else VERIFIER_POLICY["maxWindMps"]
    wind = context.get("windMps")
    if not _finite(wind) or wind < 0:
        refusals.append("wind speed is unknown")
    elif wind > wind_limit:
        refusals.append(f"wind {_number(wind)} m/s exceeds {_number(wind_limit)} m/s")

    events = context.get("rfEvents")
    if not isinstance(events, list) or context.get("sdrState") is None:
        refusals.append("RF environment is unknown")
    else:
        if any(event.get("kind") == "gnss_interference" for event in events) and not context.get("rfOverride"):
            refusals.append("GNSS interference is present")
        if any(event.get("kind") == "hostile_drone" for event in events):
            refusals.append("a hostile drone is detected")

    if context.get("sensors") is None:
        refusals.append("sensor health is unknown")
    if context.get("isNight") is None:
        refusals.append("day/night state is unknown")
    if context.get("isNight") and (context.get("sensors") or {}).get("thermal") != "ok":
        refusals.append("a night mission needs a healthy thermal sensor")

    if unattended:
        if context.get("requiresOperator"):
            reason = context.get("requiresOperatorReason")
            refusals.append("task is flagged for operator review" + (f": {reason}" if reason else ""))
        sorties = context.get("unattendedSortiesLastHour")
        sorties = sorties if sorties is not None else 0
        if sorties >= UNATTENDED_ENVELOPE["maxSortiesPerHour"]:
            refusals.append(
                f"{sorties} unattended sorties in the trailing hour reaches the "
                f"{UNATTENDED_ENVELOPE['maxSortiesPerHour']}/h cap"
            )
        if context.get("escalationUndelivered"):
            refusals.append("an escalation is still undelivered")
    return refusals


def _altitude_band(site: SiteModel, profile: str, context: Context,
                   unattended: bool) -> Optional[Tuple[float, float]]:
    """The altitude band a plan may occupy: site n profile n (unattended)."""
    limits = policy_for(profile, context.get("profileCapabilities"))
    minimum = max(site.altBandMin, UNATTENDED_ENVELOPE["altBandM"]["min"] if unattended else -math.inf)
    maximum = min(site.altBandMax, limits.maxAltitudeM,
                  UNATTENDED_ENVELOPE["altBandM"]["max"] if unattended else math.inf)
    return (minimum, maximum) if minimum <= maximum else None


def _choose_altitude(band: Tuple[float, float],
                     conflicts: Sequence[Tuple[float, float]]) -> Tuple[float, bool]:
    """Middle of ``band``, moved only to keep the documented 10 m stagger."""
    middle = (band[0] + band[1]) / 2.0

    def clears(altitude: float) -> bool:
        return band[0] <= altitude <= band[1] and all(
            vertical_separation_m((altitude, altitude), peer) >= DECONFLICTION_POLICY["altitudeStaggerM"]
            for peer in conflicts
        )

    if not conflicts or clears(middle):
        return (middle, False)
    above = max(peer[1] for peer in conflicts) + DECONFLICTION_POLICY["altitudeStaggerM"]
    below = min(peer[0] for peer in conflicts) - DECONFLICTION_POLICY["altitudeStaggerM"]
    if clears(above):
        return (above, True)
    if clears(below):
        return (below, True)
    return (middle, False)


def corridor_for_plan(plan: MissionPlan, site: SiteModel, context: Context,
                      band: Tuple[float, float]) -> Corridor:
    """The corridor a verified plan is allowed to occupy (ADR D21)."""
    walk = walk_plan(plan, site, start=start_position(context, site),
                     start_alt_m=start_altitude(context),
                     capabilities=context.get("profileCapabilities"))
    tolerance = lateral_tolerance_m(plan.profile)
    return Corridor.model_validate({
        "legs": [{
            "from": {"lat": round6(leg.from_p[0]), "lon": round6(leg.from_p[1])},
            "to": {"lat": round6(leg.to_p[0]), "lon": round6(leg.to_p[1])},
            "lateral_tol_m": tolerance,
        } for leg in walk.legs if leg.lengthM > 0],
        "orbits": [{
            "center": {"lat": round6(target.pos[0]), "lon": round6(target.pos[1])},
            "radius_m": target.radiusM if target.radiusM is not None else 0.0,
            "radial_tol_m": CORRIDOR_POLICY["radialTolM"],
        } for target in walk.targets if target.kind == "orbit_point"],
        "alt_band_m": {"min": band[0], "max": band[1]},
        "generated_from": plan.requestId,
    })


def plan_mission(*, task: Task, anomaly: Anomaly, site: SiteModel, context: Context,
                 request_id: Optional[str] = None) -> PlannedMission:
    """Task + site + capabilities + vehicle state -> one MissionPlan, or infeasible."""
    trace: List[PlanTraceEntry] = []

    def note(rule: str, effect: str) -> None:
        trace.append(PlanTraceEntry(rule=rule, effect=effect))

    def refuse(reason: str) -> PlannedMission:
        note("infeasible", reason)
        return PlannedMission(infeasible=True, reason=reason, planTrace=trace)

    request = request_id if request_id is not None else f"plan-{task.taskId}"
    mode = context.get("mode")
    unattended = (mode if mode is not None else "attended") == "unattended"
    note("mode", "unattended: UNATTENDED_ENVELOPE applies" if unattended
         else "attended: full site envelope")

    profile = profile_for_look_for(task.lookFor)
    note("profile", f"lookFor={task.lookFor} selects the {profile} profile")

    site_check = site_validity(site)
    if not site_check.ok:
        return refuse(f"site model is not usable: {site_check.reason}")
    note("site_valid", "site geometry and safety policy are valid")

    refusals = dispatch_refusals(context, unattended)
    if refusals:
        return refuse("vehicle state refuses dispatch: " + "; ".join(refusals))
    note("dispatch_state", "nav, readiness, battery, wind, RF and sensor gates all pass")

    target: Point = (anomaly.lat, anomaly.lon)
    if not point_in_or_on_polygon(target, site.geofence):
        return refuse("the cue lies outside the operational geofence")
    if unattended and not point_in_or_on_polygon(target, site.perimeter):
        return refuse("the cue lies outside the site perimeter, which unattended flight may not leave")
    note("containment", "the cue is inside the operational geofence")

    band = _altitude_band(site, profile, context, unattended)
    if band is None:
        return refuse("the profile altitude band does not intersect the site altitude band")

    peers = peer_geometry(context)
    start = start_position(context, site)
    start_alt_m = start_altitude(context)

    # Two vehicles never share an orbit centre (ADR D21/D26): a peer already
    # turning around this cue is a tasking mistake, and the fleet layer must
    # not answer it by sending a second aircraft to the same point.
    for peer in peers:
        if any(haversine_meters(orbit[0], target) <= DECONFLICTION_POLICY["sharedOrbitCentreM"]
               for orbit in peer.geometry.orbits):
            return refuse(f"{peer.vehicleId} is already orbiting this observation point")

    conflict_bands = [peer.geometry.altBandM for peer in peers if peer.geometry.altBandM is not None]
    altitude_m, staggered = _choose_altitude(band, conflict_bands if peers else [])
    note("altitude", "mid-point of the profile band intersected with the site band"
         + (" and the unattended band" if unattended else "")
         + (", staggered clear of a peer corridor" if staggered else ""))

    floor_m = max(VERIFIER_POLICY["hardMinStandoffM"],
                  policy_for(profile, context.get("profileCapabilities")).standoffM)
    requested_radius_m = PLANNER_POLICY["orbitRadiusM"][profile]
    radius_m = shrink_orbit_radius(target, requested_radius_m, altitude_m, site, floor_m)
    if radius_m is None:
        return refuse("the observation orbit cannot clear the buffered no-fly zones and the "
                      "geofence without breaching standoff")
    note("orbit", "orbit radius shrunk to clear the buffered no-fly zones and the geofence, "
         "never below standoff" if radius_m < requested_radius_m
         else "profile orbit radius clears the buffered no-fly zones and the geofence")
    note("laps", f"exactly {PLANNER_POLICY['laps']} lap")

    approach = orbit_entry_point(target, start, radius_m)
    # Departure: climb vertically to cruise altitude before translating, the
    # way the aircraft actually flies. Without it every route is judged at the
    # site band floor (the verifier's conservative min-altitude leg model),
    # which would forbid the legal overflight of a low-ceiling NFZ.
    climb = start_alt_m is None or start_alt_m < altitude_m
    route_min_alt_m = altitude_m if climb else min(start_alt_m, altitude_m)
    if climb:
        note("departure", "vertical climb to cruise altitude before the first translating leg")

    vias = route_vias(start, approach, route_min_alt_m, site)
    if vias is None:
        return refuse("no route to the observation point clears the buffered no-fly zones "
                      "inside the geofence")
    note("route", f"straight leg blocked; shortest via-point detour around {len(vias)} "
         "buffered no-fly zone(s)" if vias
         else "straight leg clears every buffered no-fly zone and stays inside the geofence")

    # The return leg is flown too, so it is planned too: `rtl` goes straight
    # home from the orbit entry, and a straight line home can cross a buffered
    # NFZ that the outbound detour avoided.
    home: Point = (site.home.lat, site.home.lon)
    return_vias = route_vias(approach, home, altitude_m, site)
    if return_vias is None:
        return refuse("no return route from the observation point clears the buffered no-fly "
                      "zones inside the geofence")
    note("return", f"direct return blocked; shortest via-point detour around {len(return_vias)} "
         "buffered no-fly zone(s)" if return_vias
         else "direct return clears every buffered no-fly zone and stays inside the geofence")

    hold: List[Dict[str, Any]] = ([{"tool": "hold", "durationS": PLANNER_POLICY["fenceGapHoldS"]}]
                                  if task.lookFor == "fence_gap" else [])
    note("hold", f"{PLANNER_POLICY['fenceGapHoldS']} s hold, the only hold case"
         if task.lookFor == "fence_gap" else "no hold: holds exist only for fence_gap")

    leg_points: List[Point] = ([start] if climb else []) + list(vias) + [approach]
    leg_tools = [{"tool": "goto_gps", "lat": round6(p[0]), "lon": round6(p[1]),
                  "alt": altitude_m, "profile": profile} for p in leg_points]
    return_tools = [{"tool": "goto_gps", "lat": round6(p[0]), "lon": round6(p[1]),
                     "alt": altitude_m, "profile": profile} for p in return_vias]
    tools: List[Dict[str, Any]] = [
        *leg_tools,
        {"tool": "orbit_point", "lat": round6(target[0]), "lon": round6(target[1]),
         "radius": radius_m, "laps": PLANNER_POLICY["laps"]},
        *hold,
        *return_tools,
        {"tool": "rtl"},
    ]
    note("terminal", "mission terminates with one rtl")

    # Clutter transit requires healthy LiDAR AT DISPATCH (ADR D15): refuse,
    # never fly it low.
    lidar = (context.get("sensors") or {}).get("lidar")
    if lidar != "ok":
        probe = MissionPlan(requestId=request, anomalyId=anomaly.id, tools=tools,
                            profile=profile, rationale="")
        clutter_walk = walk_plan(probe, site, start=start, start_alt_m=start_alt_m,
                                 capabilities=context.get("profileCapabilities"))
        if any(leg_needs_lidar(leg.from_p, leg.to_p, leg.minAltM, site) for leg in clutter_walk.legs):
            return refuse(
                f"the route transits clutter below {site.clearAltitudeM} m and LiDAR is "
                f"{lidar if lidar is not None else 'unknown'}"
            )
        note("clutter", "route avoids clutter, so degraded LiDAR does not block dispatch")

    battery = battery_of(context) or {}
    time_budget_s = time_budget_seconds(
        soc_pct=battery.get("soc_pct"), remaining_s=battery.get("remaining_s"),
        max_sortie_s=context.get("maxSortieS"), profile=profile,
        capabilities=context.get("profileCapabilities"),
    )

    def flight_seconds(candidate: Sequence[Mapping[str, Any]]) -> float:
        probe = MissionPlan(requestId=request, anomalyId=anomaly.id, tools=list(candidate),
                            profile=profile, rationale="")
        walk = walk_plan(probe, site, start=start, start_alt_m=start_alt_m,
                         capabilities=context.get("profileCapabilities"))
        wind = context.get("windMps")
        return wind_adjusted_seconds(walk.totalFlightS, wind if wind is not None else 0.0)

    estimated_flight_s = flight_seconds(tools)
    if estimated_flight_s > time_budget_s:
        trimmed, notes = trim_to_budget(tools)
        if notes:
            tools = trimmed
            estimated_flight_s = flight_seconds(tools)
            note("time_budget", "trimmed the hold and any extra lap to fit min(range, sortie cap)")
    if estimated_flight_s > time_budget_s:
        return refuse(
            f"the mission needs {estimated_flight_s:.0f} s but only {time_budget_s:.0f} s "
            "of range and sortie budget is available"
        )
    note("time_budget", "mission fits min(live-SoC range time, sortie cap)")

    plan = MissionPlan(
        requestId=request,
        anomalyId=anomaly.id,
        profile=profile,
        rationale=(
            f"Deterministic {profile} of {task.lookFor} at cue {anomaly.id} for task "
            f"{task.taskId}: {task.question} Route, altitude, radius and duration come from "
            "the rule table, not from the cue."
        ),
        tools=tools,
        planTrace=trace,
    )
    corridor = corridor_for_plan(plan, site, context, band)
    plan.corridor = corridor
    note("corridor", f"lateral tolerance {_number(lateral_tolerance_m(profile))} m, "
         f"radial tolerance {_number(CORRIDOR_POLICY['radialTolM'])} m")

    # Last guard: a plan that would cross a peer corridor with neither lateral
    # separation nor stagger is refused here rather than handed to the verifier
    # for a correction the planner should have made itself.
    ours: CorridorGeometry = corridor_geometry_from_walk(
        walk_plan(plan, site, start=start, start_alt_m=start_alt_m,
                  capabilities=context.get("profileCapabilities"))
    )
    unresolved = [peer for peer in peers
                  if lateral_separation_m(ours, peer.geometry) < required_separation_m(peer) and
                  vertical_separation_m(ours.altBandM, peer.geometry.altBandM)
                  < DECONFLICTION_POLICY["altitudeStaggerM"]]
    if unresolved:
        return refuse("no altitude inside the band separates this mission from "
                      + ", ".join(peer.vehicleId for peer in unresolved))
    if peers:
        note("deconfliction", "separation holds against every airborne peer")

    # The plan and the result share ONE trace list, the way the TypeScript's
    # `plan.planTrace = trace` aliases one array: every rule that fired after
    # the plan object was built — the corridor, the deconfliction guard — is in
    # the record the mission carries, not only in the one the caller sees.
    plan.planTrace = trace

    return PlannedMission(
        infeasible=False, plan=plan, planTrace=trace, corridor=corridor,
        timeBudgetS=time_budget_s, estimatedFlightS=estimated_flight_s,
    )


def _number(value: float) -> str:
    """Render a number the way a JavaScript template literal would.

    ``${80}`` prints ``80``, not ``80.0``; refusal reasons go in front of an
    operator, so the oracle should not read differently from the port over a
    trailing zero. Only prose depends on this — the parity surface compares
    rule NAMES, never reason text.
    """
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        return str(value)
    return str(int(value)) if float(value).is_integer() else str(value)


__all__ = ["PlannedMission", "corridor_for_plan", "dispatch_refusals", "plan_mission",
           "profile_for_look_for"]
