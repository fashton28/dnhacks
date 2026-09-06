"""
rails/verifier — the oracle's mission trust layer.

Reference of ``platform/ground/planner/src/verifier.ts``. Twenty ordered
checks, every time, including the ones a prior failure has already made moot —
those report *why* they were not evaluated rather than silently passing:

    schema, site_valid, nav_source, readiness, wind, rf_environment, airspace,
    anomaly_proximity, altitude, speed, standoff, geofence, nfz_transit,
    nfz_orbit, terminal, loiter, range, sortie, attended, deconfliction

A corrected plan is fully re-walked and re-checked before release, and a
correction is released only when the corrected plan is itself clean.

Two checks never correct a refusal into a pass:

  * ``attended`` — quietly shrinking a task into ``UNATTENDED_ENVELOPE`` would
    hide the refusal a human is supposed to see (ADR D23);
  * a SHARED ORBIT CENTRE — two vehicles on one observation point is a tasking
    mistake, not a geometry problem (ADR D26).

``deconfliction`` does correct, in the documented order — altitude stagger
first, then a delayed dispatch — and never by moving the route sideways:
lateral geometry answers the anomaly, and it is not the verifier's to
renegotiate.

Every metre of geometry comes from :mod:`rails.geometry`, the same library the
oracle's planner draws with.
"""
from __future__ import annotations

import datetime as _dt
import math
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .geometry import (
    CorridorGeometry, INDEFINITE_HOLD_S, Point, Walk, WalkLeg,
    corridor_geometry_from_walk, distance_point_to_polygon_meters,
    distance_point_to_segment_meters, distance_segment_to_polygon_meters, haversine_meters,
    lateral_separation_m, move_point_across_boundary, move_point_away_from_polygon,
    move_point_inside_polygon, point_in_or_on_polygon, point_in_polygon, policy_for,
    profile_for_tool, range_available_seconds, round6, segment_stays_inside_polygon,
    vertical_separation_m, via_candidates, walk_plan, wind_adjusted_seconds,
)
from .policy import (
    DECONFLICTION_POLICY, UNATTENDED_ENVELOPE, VERIFIER_POLICY, canonical_profile,
)
from .schemas import MissionPlan, SchemaError, VerificationCheck, Verification, validate_mission_plan
from .site import SiteModel

HARD_MIN_STANDOFF_M = VERIFIER_POLICY["hardMinStandoffM"]
HARD_MAX_SPEED_MPS = VERIFIER_POLICY["hardMaxSpeedMps"]
RESERVE_PCT = VERIFIER_POLICY["reservePct"]
MAX_WIND_MPS = VERIFIER_POLICY["maxWindMps"]
ANOMALY_PROXIMITY_M = VERIFIER_POLICY["anomalyProximityM"]
DEFAULT_MAX_SORTIE_S = VERIFIER_POLICY["maxSortieS"]
DEFAULT_DISPATCH_MIN_SOC_PCT = VERIFIER_POLICY["dispatchMinSocPct"]
DEFAULT_CELL_IMBALANCE_MAX_V = VERIFIER_POLICY["cellImbalanceMaxV"]
DEFAULT_BATT_TEMP_MAX_C = VERIFIER_POLICY["battTempMaxC"]
CORRECTION_MARGIN_M = 5.0
MAX_HOLD_S = 60.0
MAX_ORBIT_LAPS = 3
MIN_SEPARATION_M = DECONFLICTION_POLICY["minSeparationM"]
ALTITUDE_STAGGER_M = DECONFLICTION_POLICY["altitudeStaggerM"]

CHECK_ORDER: Tuple[str, ...] = (
    "schema", "site_valid", "nav_source", "readiness", "wind", "rf_environment",
    "airspace", "anomaly_proximity", "altitude", "speed", "standoff", "geofence",
    "nfz_transit", "nfz_orbit", "terminal", "loiter", "range", "sortie",
    "attended", "deconfliction",
)

#: The runtime context is a plain mapping — the same JSON the planner CLI takes
#: as ``verify --context`` and the fixtures merge over ``baseline_context.json``.
Context = Mapping[str, Any]


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _fmt(value: Any) -> str:
    """``fmt`` from verifier.ts: integers bare, everything else to 1 dp."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return str(value)
    if math.isfinite(value) and float(value).is_integer():
        return str(int(value))
    return f"{value:.1f}"


def _iso_ms(epoch_ms: float) -> str:
    """``new Date(ms).toISOString()`` — millisecond precision, UTC, Z-suffixed."""
    stamp = _dt.datetime.fromtimestamp(epoch_ms / 1000.0, tz=_dt.timezone.utc)
    return f"{stamp.strftime('%Y-%m-%dT%H:%M:%S')}.{stamp.microsecond // 1000:03d}Z"


def _ok(name: str, reason: str) -> VerificationCheck:
    return VerificationCheck(name=name, ok=True, reason=reason)


def _fail(name: str, reason: str) -> VerificationCheck:
    return VerificationCheck(name=name, ok=False, reason=reason)


def _get(context: Context, key: str, default: Any = None) -> Any:
    value = context.get(key, default)
    return default if value is None else value


def battery_of(context: Context) -> Optional[Mapping[str, Any]]:
    telemetry = context.get("telemetry")
    if isinstance(telemetry, Mapping) and telemetry.get("battery") is not None:
        return telemetry["battery"]
    return context.get("battery")


def nav_source_of(context: Context) -> Optional[str]:
    if context.get("navSource") is not None:
        return context["navSource"]
    telemetry = context.get("telemetry")
    if isinstance(telemetry, Mapping):
        return telemetry.get("navSource")
    return None


def start_position(context: Context, site: SiteModel) -> Point:
    current = context.get("currentPosition")
    if isinstance(current, Mapping):
        return (current["lat"], current["lon"])
    telemetry = context.get("telemetry")
    if isinstance(telemetry, Mapping) and isinstance(telemetry.get("position"), Mapping):
        position = telemetry["position"]
        return (position["lat"], position["lon"])
    return (site.home.lat, site.home.lon)


def start_altitude(context: Context) -> Optional[float]:
    value = context.get("currentAltitudeM")
    if value is None:
        telemetry = context.get("telemetry")
        if isinstance(telemetry, Mapping) and isinstance(telemetry.get("position"), Mapping):
            value = telemetry["position"].get("relAlt")
    return float(value) if _finite(value) else None


def walk_for(plan: Any, site: SiteModel, context: Context) -> Walk:
    """The plan walk, anchored at the vehicle's reported position and altitude."""
    return walk_plan(plan, site, start=start_position(context, site),
                     start_alt_m=start_altitude(context),
                     capabilities=context.get("profileCapabilities"))


# ---------------------------------------------------------------------------
# The checks, in CHECK_ORDER
# ---------------------------------------------------------------------------
def check_site(site: SiteModel) -> VerificationCheck:
    try:
        if (site is None or site.home is None or not _finite(site.home.lat) or
                not _finite(site.home.lon) or not _finite(site.home.altM) or
                len(site.perimeter) < 3 or len(site.geofence) < 3 or
                not _finite(site.nfzBufferM) or site.nfzBufferM < 0 or
                not _finite(site.altBandMin) or not _finite(site.altBandMax) or
                not _finite(site.clearAltitudeM) or
                site.clearAltitudeM < site.altBandMin or site.clearAltitudeM > site.altBandMax):
            return _fail("site_valid", "site model is missing required finite geometry or policy fields")
        rings = [site.perimeter, site.geofence]
        rings.extend(zone.polygon for zone in site.nfz)
        rings.extend(area.polygon for area in site.clutter)
        for ring in rings:
            if len(ring) < 3:
                return _fail("site_valid", "site model contains an invalid polygon coordinate")
            for point in ring:
                if (not _finite(point[0]) or not _finite(point[1]) or
                        point[0] < -90 or point[0] > 90 or point[1] < -180 or point[1] > 180):
                    return _fail("site_valid", "site model contains an invalid polygon coordinate")
        if any(not point_in_or_on_polygon(point, site.perimeter) for point in site.geofence):
            return _fail("site_valid", "operational geofence escapes the site perimeter")
        if not point_in_or_on_polygon((site.home.lat, site.home.lon), site.geofence):
            return _fail("site_valid", "home is outside the operational geofence")
        return _ok("site_valid", "site geometry and safety policy are valid")
    except Exception as error:       # noqa: BLE001 — a broken site model must fail, not raise
        return _fail("site_valid", f"site validation failed: {error}")


def site_validity(site: SiteModel) -> VerificationCheck:
    """Exported so the deterministic planner refuses an unusable site model."""
    return check_site(site)


def check_nav_source(context: Context) -> VerificationCheck:
    source = nav_source_of(context)
    if source is None:
        return _fail("nav_source", "runtime navigation source is required before execution")
    if source == "gps":
        return _ok("nav_source", "GPS navigation source is healthy")
    return _fail("nav_source", f"new missions are refused while navigation source is {source}")


def route_uses_clutter(walk: Walk, site: SiteModel) -> bool:
    return any(
        distance_segment_to_polygon_meters(leg.from_p, leg.to_p, area.polygon) == 0 and
        leg.minAltM < site.clearAltitudeM
        for leg in walk.legs for area in site.clutter
    )


def check_readiness(walk: Walk, site: SiteModel, context: Context) -> VerificationCheck:
    failures: List[str] = []
    readiness = context.get("readiness")
    if readiness is None:
        failures.append("readiness envelope is required")
    elif not readiness.get("ready"):
        reasons = readiness.get("reasons") or []
        failures.extend(reasons if reasons else ["vehicle not ready"])
    battery = battery_of(context)
    if battery is None:
        failures.append("battery telemetry is required")
    else:
        min_soc = max(DEFAULT_DISPATCH_MIN_SOC_PCT, _get(context, "dispatchMinSocPct", 0))
        max_delta = min(DEFAULT_CELL_IMBALANCE_MAX_V, _get(context, "cellImbalanceMaxV", math.inf))
        max_temp = min(DEFAULT_BATT_TEMP_MAX_C, _get(context, "battTempMaxC", math.inf))
        soc = battery.get("soc_pct")
        if not _finite(soc):
            failures.append("battery SoC is non-finite")
        elif soc < min_soc:
            failures.append(f"battery SoC {_fmt(soc)}% is below {_fmt(min_soc)}%")
        if battery.get("charge_state") != "charged":
            failures.append(f"charge_state is {battery.get('charge_state') or 'unknown'}, expected charged")
        if battery.get("fault"):
            failures.append(f"battery fault: {battery['fault']}")
        delta = battery.get("cell_delta_v")
        if not _finite(delta):
            failures.append("cell delta is non-finite")
        elif delta > max_delta:
            failures.append(f"cell delta {delta} V exceeds {max_delta} V")
        temp = battery.get("temp_c")
        if not _finite(temp):
            failures.append("battery temperature is non-finite")
        elif temp > max_temp:
            failures.append(f"battery temperature {temp} C exceeds {max_temp} C")
    sensors = context.get("sensors")
    if sensors is None:
        failures.append("sensor health is required")
    if context.get("isNight") is None:
        failures.append("day/night state is required")
    if context.get("isNight") and (sensors or {}).get("thermal") != "ok":
        failures.append("night mission requires a healthy thermal sensor")
    if (sensors or {}).get("lidar") != "ok" and route_uses_clutter(walk, site):
        failures.append(f"clutter transit requires healthy LiDAR or altitude >= {site.clearAltitudeM} m")
    return (_fail("readiness", "; ".join(failures)) if failures
            else _ok("readiness", "battery, dispatch, and required sensor checks pass"))


def check_wind(context: Context) -> VerificationCheck:
    wind = context.get("windMps")
    if not _finite(wind) or wind < 0:
        return _fail("wind", "wind speed must be a finite non-negative number")
    if wind <= MAX_WIND_MPS:
        return _ok("wind", f"wind {_fmt(wind)} m/s is within {_fmt(MAX_WIND_MPS)} m/s")
    return _fail("wind", f"wind {_fmt(wind)} m/s exceeds {_fmt(MAX_WIND_MPS)} m/s; hold then RTL")


def check_rf_environment(context: Context) -> VerificationCheck:
    events = context.get("rfEvents")
    if not isinstance(events, list) or context.get("sdrState") is None:
        return _fail("rf_environment", "RF events and SDR health state are required before execution")
    interference = [e for e in events if e.get("kind") == "gnss_interference"]
    if interference and not context.get("rfOverride"):
        return _fail("rf_environment", "GNSS interference detected; operator override required")
    if context.get("sdrState") == "no_device":
        return _ok("rf_environment", "SDR unavailable; RF environment unknown (no override required)")
    return _ok("rf_environment",
               "operator accepted RF override" if interference else "no blocking RF interference")


def check_airspace(walk: Walk, site: SiteModel, context: Context) -> VerificationCheck:
    conflicts: List[str] = []
    for event in context.get("rfEvents") or ():
        if event.get("kind") != "hostile_drone":
            continue
        if not _finite(event.get("lat")) or not _finite(event.get("lon")):
            conflicts.append("hostile drone has no trusted position")
            continue
        point = (event["lat"], event["lon"])
        if point_in_or_on_polygon(point, site.geofence) or any(
                distance_point_to_segment_meters(point, leg.from_p, leg.to_p) <= site.nfzBufferM
                for leg in walk.legs):
            conflicts.append(
                f"hostile drone at {event['lat']:.5f},{event['lon']:.5f} conflicts with mission airspace"
            )
    return _fail("airspace", "; ".join(conflicts)) if conflicts else _ok("airspace", "no hostile-drone conflict")


def check_anomaly_proximity(walk: Walk, context: Context) -> VerificationCheck:
    anomaly = context.get("anomaly")
    if anomaly is None:
        return _fail("anomaly_proximity", "anomaly location is required before execution")
    target = (anomaly["lat"], anomaly["lon"])
    nearest = min((haversine_meters(t.pos, target) for t in walk.targets), default=math.inf)
    if nearest <= ANOMALY_PROXIMITY_M:
        return _ok("anomaly_proximity", f"nearest mission target is {_fmt(nearest)} m from the anomaly")
    return _fail("anomaly_proximity", f"no mission target is within {_fmt(ANOMALY_PROXIMITY_M)} m of the anomaly")


def check_altitude(walk: Walk, plan: MissionPlan, site: SiteModel, context: Context) -> VerificationCheck:
    failures: List[str] = []
    for target in walk.targets:
        profile = profile_for_tool(plan.tools[target.toolIndex], plan.profile)
        maximum = min(site.altBandMax, policy_for(profile, context.get("profileCapabilities")).maxAltitudeM)
        if not _finite(target.altM) or target.altM < site.altBandMin or target.altM > maximum:
            failures.append(
                f"tool {target.toolIndex} altitude {_fmt(target.altM)} m is outside "
                f"[{_fmt(site.altBandMin)}, {_fmt(maximum)}] m"
            )
    return (_fail("altitude", "; ".join(failures)) if failures
            else _ok("altitude", "all target altitudes satisfy site and profile bounds"))


def check_speed(walk: Walk, plan: MissionPlan, context: Context) -> VerificationCheck:
    failures: List[str] = []
    for leg in walk.legs:
        profile = profile_for_tool(plan.tools[leg.toolIndex], plan.profile)
        maximum = min(HARD_MAX_SPEED_MPS, policy_for(profile, context.get("profileCapabilities")).maxSpeedMps)
        if not _finite(leg.speedMps) or leg.speedMps <= 0 or leg.speedMps > maximum:
            failures.append(
                f"tool {leg.toolIndex} speed {_fmt(leg.speedMps)} m/s exceeds valid (0, {_fmt(maximum)}] m/s"
            )
    return (_fail("speed", "; ".join(failures)) if failures
            else _ok("speed", "all leg speeds satisfy profile and hard bounds"))


def check_standoff(plan: MissionPlan, context: Context) -> VerificationCheck:
    failures: List[str] = []
    minimum = max(HARD_MIN_STANDOFF_M, policy_for(plan.profile, context.get("profileCapabilities")).standoffM)
    for index, tool in enumerate(plan.tools):
        if tool["tool"] != "orbit_point":
            continue
        if not _finite(tool.get("radius")) or tool["radius"] < minimum:
            failures.append(
                f"tool {index} orbit radius {_fmt(tool.get('radius'))} m is below {_fmt(minimum)} m standoff"
            )
    return (_fail("standoff", "; ".join(failures)) if failures
            else _ok("standoff", "all explicit standoffs satisfy profile and hard floors"))


def check_geofence(walk: Walk, site: SiteModel) -> VerificationCheck:
    failures: List[str] = []
    for target in walk.targets:
        if not point_in_or_on_polygon(target.pos, site.geofence):
            failures.append(f"tool {target.toolIndex} target is outside geofence")
        if (target.kind == "orbit_point" and
                distance_point_to_polygon_meters(target.pos, site.geofence) < (target.radiusM or 0.0) - 0.05):
            failures.append(f"tool {target.toolIndex} orbit circumference leaves geofence")
    for leg in walk.legs:
        if leg.lengthM > 0 and not segment_stays_inside_polygon(leg.from_p, leg.to_p, site.geofence):
            failures.append(f"leg to tool {leg.toolIndex} leaves geofence")
    return (_fail("geofence", "; ".join(failures)) if failures
            else _ok("geofence", "all targets and complete legs stay inside operational geofence"))


def check_nfz_transit(walk: Walk, site: SiteModel) -> VerificationCheck:
    failures: List[str] = []
    for zone in site.nfz:
        for leg in walk.legs:
            if leg.minAltM > zone.ceilingM:
                continue
            clearance = distance_segment_to_polygon_meters(leg.from_p, leg.to_p, zone.polygon)
            if clearance < site.nfzBufferM - 0.05:
                failures.append(
                    f'leg to tool {leg.toolIndex} is {_fmt(clearance)} m from NFZ "{zone.name}"; '
                    f"{_fmt(site.nfzBufferM)} m required"
                )
    return (_fail("nfz_transit", "; ".join(failures)) if failures
            else _ok("nfz_transit", f"all legs clear buffered NFZs by {_fmt(site.nfzBufferM)} m"))


def check_nfz_orbit(walk: Walk, site: SiteModel) -> VerificationCheck:
    failures: List[str] = []
    for target in walk.targets:
        if target.kind != "orbit_point":
            continue
        for zone in site.nfz:
            if target.altM > zone.ceilingM:
                continue
            clearance = (0.0 if point_in_polygon(target.pos, zone.polygon)
                         else distance_point_to_polygon_meters(target.pos, zone.polygon))
            if clearance < site.nfzBufferM + (target.radiusM or 0.0) - 0.05:
                failures.append(f'tool {target.toolIndex} orbit intersects buffered NFZ "{zone.name}"')
    return (_fail("nfz_orbit", "; ".join(failures)) if failures
            else _ok("nfz_orbit", "all orbit circumferences clear buffered NFZs"))


def check_terminal(plan: MissionPlan) -> VerificationCheck:
    rtl = [i for i, tool in enumerate(plan.tools) if tool["tool"] == "rtl"]
    if not plan.tools or plan.tools[-1]["tool"] != "rtl":
        return _fail("terminal", "mission must terminate with rtl")
    if len(rtl) != 1:
        return _fail("terminal", "rtl may appear only once, as the terminal tool")
    return _ok("terminal", "mission terminates with one rtl")


def check_loiter(plan: MissionPlan) -> VerificationCheck:
    failures: List[str] = []
    for index, tool in enumerate(plan.tools):
        if tool["tool"] == "hold":
            duration = tool.get("durationS")
            if (duration if duration is not None else INDEFINITE_HOLD_S) > MAX_HOLD_S:
                failures.append(f"tool {index} hold exceeds {_fmt(MAX_HOLD_S)} s")
        if tool["tool"] == "orbit_point":
            laps = tool.get("laps")
            if (laps if laps is not None else 1) > MAX_ORBIT_LAPS:
                failures.append(f"tool {index} orbit exceeds {MAX_ORBIT_LAPS} laps")
    return (_fail("loiter", "; ".join(failures)) if failures
            else _ok("loiter", "hold durations and orbit laps are bounded"))


def _live_soc(context: Context) -> float:
    battery = battery_of(context)
    value = (battery or {}).get("soc_pct")
    return float(value) if _finite(value) else math.nan


def _wind_adjusted(walk: Walk, context: Context) -> float:
    return wind_adjusted_seconds(walk.totalFlightS, _get(context, "windMps", 0.0))


def check_range(walk: Walk, context: Context) -> VerificationCheck:
    soc = _live_soc(context)
    if not _finite(soc) or soc < 0 or soc > 100:
        return _fail("range", "live battery SoC must be finite and in [0, 100]")
    available = range_available_seconds(soc, (battery_of(context) or {}).get("remaining_s"))
    required = _wind_adjusted(walk, context)
    reason = (f"wind-adjusted {_fmt(required)} s required vs {_fmt(available)} s available "
              f"at {_fmt(soc)}% SoC with {_fmt(RESERVE_PCT)}% reserve")
    return (_ok("range", reason) if required <= available
            else _fail("range", f"insufficient live-SoC range: {reason}"))


def _max_sortie(plan: MissionPlan, context: Context) -> float:
    return min(DEFAULT_MAX_SORTIE_S,
               policy_for(plan.profile, context.get("profileCapabilities")).maxSortieS,
               _get(context, "maxSortieS", math.inf))


def check_sortie(walk: Walk, plan: MissionPlan, context: Context) -> VerificationCheck:
    cap = _max_sortie(plan, context)
    required = _wind_adjusted(walk, context)
    if required <= cap:
        return _ok("sortie", f"sortie {_fmt(required)} s fits {_fmt(cap)} s cap")
    return _fail("sortie", f"sortie {_fmt(required)} s exceeds {_fmt(cap)} s cap; split into two sorties")


# ---------------------------------------------------------------------------
# attended — the UNATTENDED_ENVELOPE gate (ADR D23)
# ---------------------------------------------------------------------------
def unattended_failures(walk: Walk, plan: MissionPlan, site: SiteModel, context: Context) -> List[str]:
    failures: List[str] = []
    envelope = UNATTENDED_ENVELOPE
    if context.get("requiresOperator"):
        reason = context.get("requiresOperatorReason")
        failures.append("task is flagged for operator review" + (f": {reason}" if reason else ""))
    if canonical_profile(plan.profile) != "inspect":
        failures.append(f"profile {plan.profile} is outside the unattended envelope (inspect only)")
    for target in walk.targets:
        if not point_in_or_on_polygon(target.pos, site.perimeter):
            failures.append(f"tool {target.toolIndex} target is outside the site perimeter")
        if (not _finite(target.altM) or target.altM < envelope["altBandM"]["min"] or
                target.altM > envelope["altBandM"]["max"]):
            failures.append(
                f"tool {target.toolIndex} altitude {_fmt(target.altM)} m is outside the unattended band "
                f"[{_fmt(envelope['altBandM']['min'])}, {_fmt(envelope['altBandM']['max'])}] m"
            )
    for index, tool in enumerate(plan.tools):
        if tool["tool"] == "orbit_point":
            laps = tool.get("laps")
            if (laps if laps is not None else 1) > envelope["maxLaps"]:
                failures.append(f"tool {index} orbit exceeds {envelope['maxLaps']} unattended lap")
        if tool["tool"] == "hold":
            duration = tool.get("durationS")
            if (duration if duration is not None else INDEFINITE_HOLD_S) > envelope["maxHoldS"]:
                failures.append(
                    f"tool {index} hold exceeds the {_fmt(envelope['maxHoldS'])} s unattended limit"
                )
    wind = context.get("windMps")
    if not _finite(wind) or wind > envelope["maxWindMps"]:
        failures.append(
            f"wind {_fmt(wind) if _finite(wind) else 'unknown'} m/s exceeds the "
            f"{_fmt(envelope['maxWindMps'])} m/s unattended limit"
        )
    if nav_source_of(context) != "gps":
        failures.append("unattended dispatch requires a GPS navigation source")
    events = context.get("rfEvents") or ()
    if any(event.get("kind") == "gnss_interference" for event in events):
        failures.append("RF interference is present; GNSS integrity is unverifiable")
    if any(event.get("kind") == "hostile_drone" for event in events):
        failures.append("a hostile drone is detected; airspace is yielded, never contested")
    if context.get("isNight") and (context.get("sensors") or {}).get("thermal") != "ok":
        failures.append("a night mission with no healthy thermal produces no observation worth flying for")
    sorties = _get(context, "unattendedSortiesLastHour", 0)
    if sorties >= envelope["maxSortiesPerHour"]:
        failures.append(
            f"{sorties} unattended sorties in the trailing hour reaches the "
            f"{envelope['maxSortiesPerHour']}/h cap"
        )
    if context.get("escalationUndelivered"):
        failures.append("an escalation is still undelivered; unattended dispatch stays refused")
    return failures


def check_attended(walk: Walk, plan: MissionPlan, site: SiteModel, context: Context) -> VerificationCheck:
    if _get(context, "mode", "attended") == "attended":
        if context.get("requiresOperator"):
            reason = context.get("requiresOperatorReason")
            return _ok("attended", "attended operation; operator review flagged" + (f": {reason}" if reason else ""))
        return _ok("attended", "attended operation; the unattended envelope does not apply")
    failures = unattended_failures(walk, plan, site, context)
    return (_fail("attended", "needs_operator: " + "; ".join(failures)) if failures
            else _ok("attended", "plan is inside UNATTENDED_ENVELOPE"))


# ---------------------------------------------------------------------------
# deconfliction — two vehicles, star topology (ADR D21 / D26)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class PeerGeometry:
    vehicleId: str
    geometry: CorridorGeometry
    #: Epoch ms the peer's sortie must end by; ``inf`` when it has no cap.
    endsAt: float
    #: Age of this peer's data, seconds (D21: > 3 s doubles the separation).
    ageS: float


def peer_geometry(context: Context) -> List[PeerGeometry]:
    """Peers built ONLY from the hub-relayed fleet message (ADR D26).

    A vehicle on the pad with no committed corridor is not a separation
    problem; one that is airborne, or committed to the air, is.

    ``now`` defaults to 0 here where the TypeScript defaults to ``Date.now()``.
    That is deliberate: a fixture carrying a ``fleet`` must also carry ``now``
    and ``dispatchAt``, because a time-overlap test that depends on when it is
    run is not a fixture. A fixture that forgets them should produce an obvious
    disagreement, not a quietly clock-dependent pass.
    """
    fleet_ts = context.get("fleetTs")
    if fleet_ts is None:
        age_s = 0.0
    else:
        now = _get(context, "now", 0)
        age_s = max(0.0, (now - fleet_ts) / 1000.0)
    out: List[PeerGeometry] = []
    for vehicle in context.get("fleet") or ():
        if vehicle.get("vehicleId") == _get(context, "vehicleId", ""):
            continue
        position = vehicle.get("position") or {}
        rel_alt = position.get("relAlt")
        # `vehicle.sortie !== null` in TypeScript: an ABSENT sortie key reads
        # as airborne, only an explicit null says "on the pad".
        sortie_says_airborne = ("sortie" not in vehicle) or (vehicle.get("sortie") is not None)
        airborne = (sortie_says_airborne or (rel_alt if _finite(rel_alt) else 0) > 1 or
                    vehicle.get("plannedCorridor") is not None)
        if not airborne:
            continue
        corridor = vehicle.get("plannedCorridor")
        points: Tuple[Point, ...] = ()
        if _finite(position.get("lat")) and _finite(position.get("lon")):
            points = ((position["lat"], position["lon"]),)
        legs = tuple(((leg["from"]["lat"], leg["from"]["lon"]), (leg["to"]["lat"], leg["to"]["lon"]))
                     for leg in ((corridor or {}).get("legs") or ()))
        orbits = tuple(((orbit["center"]["lat"], orbit["center"]["lon"]), orbit["radius_m"])
                       for orbit in ((corridor or {}).get("orbits") or ()))
        band = (corridor or {}).get("alt_band_m")
        if band is not None:
            alt_band = (band["min"], band["max"])
        elif _finite(rel_alt):
            alt_band = (rel_alt, rel_alt)
        else:
            alt_band = None
        sortie = vehicle.get("sortie")
        out.append(PeerGeometry(
            vehicleId=vehicle.get("vehicleId", ""),
            geometry=CorridorGeometry(points=points, legs=legs, orbits=orbits, altBandM=alt_band),
            endsAt=sortie["must_rtl_by"] if sortie else math.inf,
            ageS=age_s,
        ))
    return out


def required_separation_m(peer: PeerGeometry) -> float:
    """Lateral separation required from one peer, metres (doubled when stale)."""
    return (DECONFLICTION_POLICY["staleSeparationM"] if peer.ageS > DECONFLICTION_POLICY["stalePeerS"]
            else DECONFLICTION_POLICY["minSeparationM"])


def check_deconfliction(walk: Walk, plan: MissionPlan, context: Context) -> VerificationCheck:
    peers = peer_geometry(context)
    if not peers:
        return _ok("deconfliction", "no peer vehicle is airborne or committed to the air")
    now = _get(context, "now", 0)
    dispatch_at = _get(context, "dispatchAt", now)
    ends_at = dispatch_at + _wind_adjusted(walk, context) * 1000.0
    ours = corridor_geometry_from_walk(walk)
    conflicts: List[str] = []
    cleared: List[str] = []
    for peer in peers:
        if not (dispatch_at < peer.endsAt and now < ends_at):
            cleared.append(f"{peer.vehicleId} (no time overlap)")
            continue
        shared_centre = any(
            haversine_meters(orbit[0], peer_orbit[0]) <= DECONFLICTION_POLICY["sharedOrbitCentreM"]
            for orbit in ours.orbits for peer_orbit in peer.geometry.orbits
        )
        if shared_centre:
            conflicts.append(
                f"{peer.vehicleId} already orbits this observation point; "
                "two vehicles never share an orbit centre"
            )
            continue
        required = required_separation_m(peer)
        lateral = lateral_separation_m(ours, peer.geometry)
        if lateral >= required:
            cleared.append(f"{peer.vehicleId} at {_fmt(lateral)} m")
            continue
        vertical = vertical_separation_m(ours.altBandM, peer.geometry.altBandM)
        if vertical >= DECONFLICTION_POLICY["altitudeStaggerM"]:
            cleared.append(f"{peer.vehicleId} crossing at {_fmt(lateral)} m lateral with {_fmt(vertical)} m stagger")
            continue
        conflicts.append(
            f"{peer.vehicleId} is {_fmt(lateral)} m away with {_fmt(vertical)} m altitude stagger; "
            f"{_fmt(required)} m lateral or {_fmt(DECONFLICTION_POLICY['altitudeStaggerM'])} m stagger required"
        )
    return (_fail("deconfliction", "; ".join(conflicts)) if conflicts
            else _ok("deconfliction", f"separation holds against {', '.join(cleared)}"))


# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------
def run_checks(plan: MissionPlan, site: SiteModel, context: Context,
               schema: Optional[VerificationCheck] = None,
               site_check: Optional[VerificationCheck] = None) -> List[VerificationCheck]:
    walk = walk_for(plan, site, context)
    schema = schema if schema is not None else _ok("schema", "MissionPlan schema is valid and finite")
    site_check = site_check if site_check is not None else check_site(site)
    return [
        schema, site_check, check_nav_source(context), check_readiness(walk, site, context),
        check_wind(context), check_rf_environment(context), check_airspace(walk, site, context),
        check_anomaly_proximity(walk, context), check_altitude(walk, plan, site, context),
        check_speed(walk, plan, context), check_standoff(plan, context), check_geofence(walk, site),
        check_nfz_transit(walk, site), check_nfz_orbit(walk, site), check_terminal(plan),
        check_loiter(plan), check_range(walk, context), check_sortie(walk, plan, context),
        check_attended(walk, plan, site, context), check_deconfliction(walk, plan, context),
    ]


def _blocked_checks(schema: VerificationCheck, site_check: VerificationCheck) -> List[VerificationCheck]:
    blocker = schema.reason if not schema.ok else site_check.reason
    out: List[VerificationCheck] = []
    for name in CHECK_ORDER:
        if name == "schema":
            out.append(schema)
        elif name == "site_valid":
            out.append(site_check)
        else:
            out.append(_fail(name, f"not evaluated: {blocker}"))
    return out


@dataclass
class CorrectionResult:
    plan: MissionPlan
    edits: Dict[str, List[str]]
    holdUntil: Optional[float] = None


def _shares_orbit_centre(plan: MissionPlan, site: SiteModel, context: Context) -> bool:
    """A shared orbit centre skips correction entirely: a tasking mistake is not
    a geometry problem, so the verdict stays ``rejected``."""
    ours = corridor_geometry_from_walk(walk_for(plan, site, context))
    return any(
        haversine_meters(orbit[0], peer_orbit[0]) <= DECONFLICTION_POLICY["sharedOrbitCentreM"]
        for peer in peer_geometry(context)
        for orbit in ours.orbits for peer_orbit in peer.geometry.orbits
    )


def conflicting_peers(plan: MissionPlan, site: SiteModel, context: Context) -> List[PeerGeometry]:
    """Peers this candidate would actually share airspace with."""
    walk = walk_for(plan, site, context)
    now = _get(context, "now", 0)
    dispatch_at = _get(context, "dispatchAt", now)
    ends_at = dispatch_at + _wind_adjusted(walk, context) * 1000.0
    ours = corridor_geometry_from_walk(walk)
    return [peer for peer in peer_geometry(context)
            if dispatch_at < peer.endsAt and now < ends_at and
            lateral_separation_m(ours, peer.geometry) < required_separation_m(peer)]


def _stagger_for_separation(plan: MissionPlan, site: SiteModel,
                            context: Context) -> Optional[Tuple[MissionPlan, float]]:
    """Raise (preferred) or lower the whole mission by at least the 10 m stagger."""
    peers = [p for p in conflicting_peers(plan, site, context) if p.geometry.altBandM is not None]
    if not peers:
        return None
    floor = site.altBandMin
    ceiling = min(site.altBandMax, policy_for(plan.profile, context.get("profileCapabilities")).maxAltitudeM)
    bands = [p.geometry.altBandM for p in peers]
    above = max(band[1] for band in bands) + ALTITUDE_STAGGER_M
    below = min(band[0] for band in bands) - ALTITUDE_STAGGER_M
    # The band a staggered mission OCCUPIES includes the altitude it starts
    # from: a vehicle that descends through the peer's band has not staggered.
    start_alt = start_altitude(context)
    start_alt = start_alt if start_alt is not None else site.altBandMin

    def clears(altitude: float) -> bool:
        return floor <= altitude <= ceiling and all(
            vertical_separation_m((min(start_alt, altitude), max(start_alt, altitude)),
                                  peer.geometry.altBandM) >= ALTITUDE_STAGGER_M
            for peer in peers
        )

    altitude = above if clears(above) else (below if clears(below) else None)
    if altitude is None:
        return None
    tools = []
    for tool in plan.tools:
        if tool["tool"] == "goto_gps":
            copy = dict(tool)
            copy["alt"] = altitude
            if tool.get("alt_m") is not None:
                copy["alt_m"] = altitude
            tools.append(copy)
        else:
            tools.append(dict(tool))
    return (plan.model_copy(update={"tools": tools}), altitude)


def _delayed_dispatch_at(plan: MissionPlan, site: SiteModel, context: Context) -> Optional[float]:
    """The epoch-ms dispatch time at which every conflicting peer has gone home."""
    peers = conflicting_peers(plan, site, context)
    if not peers:
        return None
    latest = max(peer.endsAt for peer in peers)
    if not math.isfinite(latest):
        return None
    return latest + DECONFLICTION_POLICY["dispatchDelayMarginS"] * 1000.0


def build_corrected_plan(plan: MissionPlan, site: SiteModel, context: Context,
                         original_checks: Sequence[VerificationCheck]) -> CorrectionResult:
    edits: Dict[str, List[str]] = {}

    def note(name: str, detail: str) -> None:
        edits.setdefault(name, []).append(detail)

    capabilities = context.get("profileCapabilities")

    # --- clamp scalars ----------------------------------------------------
    tools: List[Dict[str, Any]] = []
    for index, tool in enumerate(plan.tools):
        kind = tool["tool"]
        if kind == "goto_gps":
            profile = profile_for_tool(tool, plan.profile)
            max_altitude = min(site.altBandMax, policy_for(profile, capabilities).maxAltitudeM)
            altitude = min(max_altitude, max(site.altBandMin, tool["alt"]))
            max_speed = min(HARD_MAX_SPEED_MPS, policy_for(profile, capabilities).maxSpeedMps)
            speed = None if tool.get("speed_mps") is None else min(max_speed, tool["speed_mps"])
            if altitude != tool["alt"]:
                note("altitude", f"clamped tool {index} altitude to {_fmt(altitude)} m")
            if speed != tool.get("speed_mps"):
                note("speed", f"clamped tool {index} speed to {_fmt(speed)} m/s")
            copy = dict(tool)
            copy["alt"] = altitude
            if tool.get("alt_m") is not None:
                copy["alt_m"] = altitude
            if speed is not None:
                copy["speed_mps"] = speed
            tools.append(copy)
        elif kind == "orbit_point":
            minimum = max(HARD_MIN_STANDOFF_M, policy_for(plan.profile, capabilities).standoffM)
            radius = max(minimum, tool["radius"])
            declared_laps = tool.get("laps")
            laps = min(MAX_ORBIT_LAPS, declared_laps if declared_laps is not None else 1)
            if radius != tool["radius"]:
                note("standoff", f"raised tool {index} orbit radius to {_fmt(radius)} m")
            if laps != (declared_laps if declared_laps is not None else 1):
                note("loiter", f"trimmed tool {index} orbit to {_fmt(laps)} laps")
            copy = dict(tool)
            copy["radius"] = radius
            if tool.get("radius_m") is not None:
                copy["radius_m"] = radius
            if declared_laps is not None:
                copy["laps"] = laps
            tools.append(copy)
        elif kind == "hold":
            declared = tool.get("durationS")
            duration = min(MAX_HOLD_S, declared if declared is not None else INDEFINITE_HOLD_S)
            if duration != (declared if declared is not None else INDEFINITE_HOLD_S):
                note("loiter", f"clamped tool {index} hold to {_fmt(duration)} s")
            if declared is None:
                tools.append(dict(tool))
            else:
                copy = dict(tool)
                copy["durationS"] = duration
                if tool.get("duration_s") is not None:
                    copy["duration_s"] = duration
                tools.append(copy)
        else:
            tools.append(dict(tool))

    # --- move points clear ------------------------------------------------
    moved: List[Dict[str, Any]] = []
    for index, tool in enumerate(tools):
        if tool["tool"] not in ("goto_gps", "orbit_point"):
            moved.append(tool)
            continue
        position: Point = (tool["lat"], tool["lon"])
        if not point_in_or_on_polygon(position, site.geofence):
            position = move_point_across_boundary(position, site.geofence, CORRECTION_MARGIN_M)
            note("geofence", f"moved tool {index} target inside operational geofence")
        orbit_radius = tool["radius"] if tool["tool"] == "orbit_point" else 0.0
        if tool["tool"] == "orbit_point" and point_in_or_on_polygon(position, site.geofence):
            clearance = distance_point_to_polygon_meters(position, site.geofence)
            required = orbit_radius + CORRECTION_MARGIN_M
            if clearance < required:
                position = move_point_inside_polygon(position, site.geofence, required)
                note("geofence", f"moved tool {index} orbit center inward to contain its circumference")
        for zone in site.nfz:
            clearance = (0.0 if point_in_polygon(position, zone.polygon)
                         else distance_point_to_polygon_meters(position, zone.polygon))
            required = site.nfzBufferM + orbit_radius + CORRECTION_MARGIN_M
            if clearance < required:
                position = move_point_away_from_polygon(position, zone.polygon, required)
                note("nfz_orbit" if tool["tool"] == "orbit_point" else "nfz_transit",
                     f'moved tool {index} clear of buffered NFZ "{zone.name}"')
        copy = dict(tool)
        copy["lat"] = round6(position[0])
        copy["lon"] = round6(position[1])
        moved.append(copy)
    candidate = plan.model_copy(update={"tools": moved})

    # --- clutter: climb outside it before transiting ----------------------
    if (context.get("sensors") or {}).get("lidar") != "ok":
        walk = walk_for(candidate, site, context)
        violations = [leg for leg in walk.legs if any(
            distance_segment_to_polygon_meters(leg.from_p, leg.to_p, area.polygon) == 0 and
            leg.minAltM < site.clearAltitudeM for area in site.clutter)]
        tools = [dict(tool) for tool in candidate.tools]
        for leg in sorted(violations, key=lambda entry: entry.toolIndex, reverse=True):
            target = tools[leg.toolIndex] if 0 <= leg.toolIndex < len(tools) else None
            if target is None or target["tool"] != "goto_gps":
                continue
            if any(point_in_or_on_polygon(leg.from_p, area.polygon) for area in site.clutter):
                continue
            altitude = max(target["alt"], site.clearAltitudeM)
            climbed = dict(target)
            climbed["alt"] = altitude
            if target.get("alt_m") is not None:
                climbed["alt_m"] = altitude
            tools[leg.toolIndex] = climbed
            tools.insert(leg.toolIndex, {
                "tool": "goto_gps", "lat": round6(leg.from_p[0]), "lon": round6(leg.from_p[1]),
                "alt": site.clearAltitudeM, "profile": candidate.profile,
            })
            note("readiness", f"inserted a vertical climb outside clutter before tool {leg.toolIndex}")
        candidate = candidate.model_copy(update={"tools": tools})

    # --- route around buffered NFZs ---------------------------------------
    for _ in range(12):
        walk = walk_for(candidate, site, context)
        violation: Optional[Tuple[WalkLeg, Any]] = None
        for zone in site.nfz:
            for leg in walk.legs:
                if (leg.minAltM <= zone.ceilingM and
                        distance_segment_to_polygon_meters(leg.from_p, leg.to_p, zone.polygon)
                        < site.nfzBufferM - 0.05):
                    violation = (leg, zone)
                    break
            if violation is not None:
                break
        if violation is None:
            break
        leg, zone = violation
        # Corner routes need enough radial room for BOTH adjacent legs to stay
        # outside the buffered polygon after coordinate rounding.
        via_clearance = site.nfzBufferM * 2 + CORRECTION_MARGIN_M
        points = via_candidates(leg.from_p, leg.to_p, zone, site, via_clearance)
        if not points:
            break
        via = points[0].point
        altitude = min(site.altBandMax,
                       policy_for(plan.profile, capabilities).maxAltitudeM,
                       max(site.altBandMin, leg.maxAltM))
        tools = [dict(tool) for tool in candidate.tools]
        tools.insert(leg.toolIndex, {
            "tool": "goto_gps", "lat": round6(via[0]), "lon": round6(via[1]),
            "alt": altitude, "profile": plan.profile,
        })
        candidate = candidate.model_copy(update={"tools": tools})
        note("nfz_transit", f'inserted safe via-point around buffered NFZ "{zone.name}"')

    # --- terminal ---------------------------------------------------------
    terminal_valid = (candidate.tools and candidate.tools[-1]["tool"] == "rtl" and
                      sum(1 for tool in candidate.tools if tool["tool"] == "rtl") == 1)
    if not terminal_valid:
        tools = [dict(tool) for tool in candidate.tools if tool["tool"] != "rtl"]
        tools.append({"tool": "rtl"})
        candidate = candidate.model_copy(update={"tools": tools})
        note("terminal", "normalized mission to one terminal rtl")

    # --- budget -----------------------------------------------------------
    failed = {check.name for check in original_checks if not check.ok}
    if "range" in failed or "sortie" in failed:
        budget_check = "sortie" if "sortie" in failed else "range"
        tools = []
        for index, tool in enumerate(candidate.tools):
            if tool["tool"] == "hold":
                note(budget_check, f"dropped hold tool {index} to fit budget")
                continue
            laps = tool.get("laps")
            if tool["tool"] == "orbit_point" and (laps if laps is not None else 1) > 1:
                note(budget_check, f"trimmed orbit tool {index} to one lap")
                copy = dict(tool)
                copy["laps"] = 1
                tools.append(copy)
                continue
            tools.append(dict(tool))
        candidate = candidate.model_copy(update={"tools": tools})

    # --- deconfliction: stagger, then delay, then nothing ------------------
    hold_until: Optional[float] = None
    if "deconfliction" in failed and not _shares_orbit_centre(candidate, site, context):
        staggered = _stagger_for_separation(candidate, site, context)
        if staggered is not None:
            candidate, altitude_m = staggered
            note("deconfliction", f"staggered mission altitude to {_fmt(altitude_m)} m for peer separation")
        else:
            delay = _delayed_dispatch_at(candidate, site, context)
            if delay is not None:
                hold_until = delay
                note("deconfliction",
                     f"delayed dispatch until {_iso_ms(delay)} for peer separation")
    return CorrectionResult(plan=candidate, edits=edits, holdUntil=hold_until)


def verify_mission(input_plan: Any, site: SiteModel, context: Optional[Context] = None) -> Verification:
    """Judge a plan. Returns ``pass`` | ``corrected`` | ``rejected``."""
    context = context if context is not None else {}
    try:
        plan = validate_mission_plan(input_plan)
        schema_check = _ok("schema", "MissionPlan schema is valid and finite")
    except SchemaError as error:
        schema_check = _fail("schema", str(error))
        site_check = check_site(site)
        raw_request = None
        if isinstance(input_plan, Mapping):
            raw_request = input_plan.get("requestId")
        elif isinstance(input_plan, MissionPlan):
            raw_request = input_plan.requestId
        return Verification(
            requestId=raw_request if isinstance(raw_request, str) else "invalid",
            verdict="rejected", checks=_blocked_checks(schema_check, site_check),
        )

    site_check = check_site(site)
    if not site_check.ok:
        return Verification(requestId=plan.requestId, verdict="rejected",
                            checks=_blocked_checks(schema_check, site_check))

    original = run_checks(plan, site, context, schema_check, site_check)
    if all(check.ok for check in original):
        return Verification(requestId=plan.requestId, verdict="pass", checks=original)

    correction = build_corrected_plan(plan, site, context, original)
    checks_with_edits: List[VerificationCheck] = []
    for check in original:
        details = correction.edits.get(check.name)
        if details:
            checks_with_edits.append(check.model_copy(update={"edit": "; ".join(details)}))
        else:
            checks_with_edits.append(check)
    # A delayed dispatch corrects WHEN, so the re-walk is judged at the
    # held-until time — otherwise the peer it waits out is still in the way.
    corrected_context: Context = (context if correction.holdUntil is None
                                  else {**dict(context), "dispatchAt": correction.holdUntil})
    corrected_checks = run_checks(correction.plan, site, corrected_context)
    if correction.edits and all(check.ok for check in corrected_checks):
        return Verification(
            requestId=plan.requestId, verdict="corrected", checks=checks_with_edits,
            correctedPlan=correction.plan,
            holdUntil=int(correction.holdUntil) if correction.holdUntil is not None else None,
        )
    return Verification(requestId=plan.requestId, verdict="rejected", checks=checks_with_edits)


__all__ = [
    "CHECK_ORDER", "PeerGeometry", "build_corrected_plan", "check_site", "conflicting_peers",
    "peer_geometry", "required_separation_m", "run_checks", "site_validity", "start_altitude",
    "start_position", "unattended_failures", "verify_mission", "walk_for",
]
