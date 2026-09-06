"""
rails/geometry — THE one geometry library of the oracle.

Reference of ``platform/ground/planner/src/geometry.ts``. Both the oracle's
deterministic planner and its verifier compute geometry HERE, for the same
reason the TypeScript keeps one library: a plan must be drawn with exactly the
arithmetic that later judges it, or the planner starts arguing with its own
verifier about what clears a buffered NFZ.

Contents, in order:
  1. Local frame        — equirectangular metres east/north of an origin.
  2. Polygon primitives — containment, segment intersection, distances and the
                          "move a point clear" repairs.
  3. Site geometry      — buffered NFZs and geofence containment.
  4. Route search       — via-points around a buffered NFZ; shortest detour
                          first, northernmost via-point on a tie.
  5. Orbit geometry     — entry point, and a radius shrink that never goes
                          below the standoff floor.
  6. Mission model      — the plan walk, the flight-time model, the range and
                          sortie budget, and the budget trim order.
  7. Separation         — corridor-to-corridor geometry (ADR D21).

Units: DEGREES for coordinates (``(lat, lon)`` tuples), METRES for distances,
SECONDS for durations, m/s for speeds. Altitudes are metres AGL above home.

PORTING NOTE. Two JavaScript behaviours are reproduced explicitly rather than
approximated, because the fixtures sit on boundaries:

  * ``Math.round`` rounds HALF UP toward +Infinity, where Python's ``round``
    is banker's rounding — :func:`round6` uses ``floor(x + 0.5)``.
  * ``Array.prototype.sort`` with a comparator that treats near-equal detours
    as ties is reproduced with ``functools.cmp_to_key`` over the identical
    comparator, so the tie-break (northernmost) resolves the same way.
"""
from __future__ import annotations

import functools
import math
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .policy import (
    CORRIDOR_POLICY, PROFILE_POLICY, PROFILE_SPEED_MPS, VERIFIER_POLICY, canonical_profile,
)
from .site import SiteModel, SiteNfz

Point = Tuple[float, float]        # (lat, lon), degrees
XY = Tuple[float, float]           # (east, north), metres

# ---------------------------------------------------------------------------
# 1. Local frame
# ---------------------------------------------------------------------------
#: Mean earth radius, metres (WGS84 mean radius).
EARTH_RADIUS_M = 6371000.0
#: Metres per degree of latitude (near-constant over the globe).
M_PER_DEG_LAT = 111320.0

_DEG = math.pi / 180.0


def haversine_meters(a: Point, b: Point) -> float:
    """Great-circle distance between two WGS84 points, metres."""
    d_lat = (b[0] - a[0]) * _DEG
    d_lon = (b[1] - a[1]) * _DEG
    sin_lat = math.sin(d_lat / 2.0)
    sin_lon = math.sin(d_lon / 2.0)
    h = sin_lat * sin_lat + math.cos(a[0] * _DEG) * math.cos(b[0] * _DEG) * sin_lon * sin_lon
    return 2.0 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def to_local(p: Point, origin: Point) -> XY:
    """Project a point to local metres (equirectangular, anchored at origin)."""
    return (
        (p[1] - origin[1]) * M_PER_DEG_LAT * math.cos(origin[0] * _DEG),
        (p[0] - origin[0]) * M_PER_DEG_LAT,
    )


def from_local(p: XY, origin: Point) -> Point:
    """Inverse of :func:`to_local`."""
    return (
        origin[0] + p[1] / M_PER_DEG_LAT,
        origin[1] + p[0] / (M_PER_DEG_LAT * math.cos(origin[0] * _DEG)),
    )


def translate_meters(origin: Point, east_m: float, north_m: float) -> Point:
    """Offset a point by metres east/north (the frame the site fixtures use)."""
    return (
        origin[0] + north_m / 111320.0,
        origin[1] + east_m / (111320.0 * math.cos(origin[0] * math.pi / 180.0)),
    )


def round6(value: float) -> float:
    """Round to 6 decimal places (~0.1 m) so plans are byte-stable.

    Uses ``floor(x + 0.5)`` to match JavaScript's ``Math.round`` (half UP,
    toward +Infinity), not Python's half-to-even ``round``.
    """
    return math.floor(value * 1e6 + 0.5) / 1e6


# ---------------------------------------------------------------------------
# 2. Polygon primitives
# ---------------------------------------------------------------------------
def point_in_polygon(p: Point, polygon: Sequence[Point]) -> bool:
    """Ray-cast containment for an OPEN ring, winding-agnostic.

    Points exactly on an edge are implementation-defined; every caller that
    cares applies a margin, so an exact-boundary point never decides a verdict.
    """
    origin = polygon[0]
    pt = to_local(p, origin)
    ring = [to_local(v, origin) for v in polygon]
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        a = ring[i]
        b = ring[j]
        if (a[1] > pt[1]) != (b[1] > pt[1]):
            x_at_y = a[0] + ((pt[1] - a[1]) / (b[1] - a[1])) * (b[0] - a[0])
            if pt[0] < x_at_y:
                inside = not inside
        j = i
    return inside


def _orient(a: XY, b: XY, c: XY) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _on_segment(a: XY, b: XY, p: XY) -> bool:
    return (min(a[0], b[0]) - 1e-9 <= p[0] <= max(a[0], b[0]) + 1e-9 and
            min(a[1], b[1]) - 1e-9 <= p[1] <= max(a[1], b[1]) + 1e-9)


def _segments_intersect(p1: XY, p2: XY, p3: XY, p4: XY) -> bool:
    d1 = _orient(p3, p4, p1)
    d2 = _orient(p3, p4, p2)
    d3 = _orient(p1, p2, p3)
    d4 = _orient(p1, p2, p4)
    if (((d1 > 0 and d2 < 0) or (d1 < 0 and d2 > 0)) and
            ((d3 > 0 and d4 < 0) or (d3 < 0 and d4 > 0))):
        return True
    if d1 == 0 and _on_segment(p3, p4, p1):
        return True
    if d2 == 0 and _on_segment(p3, p4, p2):
        return True
    if d3 == 0 and _on_segment(p1, p2, p3):
        return True
    if d4 == 0 and _on_segment(p1, p2, p4):
        return True
    return False


def segment_intersects_polygon(a: Point, b: Point, polygon: Sequence[Point]) -> bool:
    """True when a->b crosses ANY edge of the open ring, closing edge included."""
    origin = polygon[0]
    pa = to_local(a, origin)
    pb = to_local(b, origin)
    ring = [to_local(v, origin) for v in polygon]
    n = len(ring)
    for i in range(n):
        if _segments_intersect(pa, pb, ring[i], ring[(i + 1) % n]):
            return True
    return False


def segment_stays_inside_polygon(a: Point, b: Point, polygon: Sequence[Point]) -> bool:
    """True when the WHOLE segment stays strictly inside a simple polygon."""
    return (point_in_polygon(a, polygon) and point_in_polygon(b, polygon) and
            not segment_intersects_polygon(a, b, polygon))


def segment_enters_polygon(a: Point, b: Point, polygon: Sequence[Point]) -> bool:
    """True when the segment enters the polygon at all (pass-through counts)."""
    return (point_in_polygon(a, polygon) or point_in_polygon(b, polygon) or
            segment_intersects_polygon(a, b, polygon))


def _nearest_point_on_segment_xy(p: XY, a: XY, b: XY) -> XY:
    abx = b[0] - a[0]
    aby = b[1] - a[1]
    len2 = abx * abx + aby * aby
    if len2 == 0:
        return (a[0], a[1])
    t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2
    t = max(0.0, min(1.0, t))
    return (a[0] + t * abx, a[1] + t * aby)


def nearest_point_on_polygon_boundary(p: Point, polygon: Sequence[Point]) -> Point:
    """Closest point on the ring's boundary, closing edge included."""
    origin = polygon[0]
    pt = to_local(p, origin)
    ring = [to_local(v, origin) for v in polygon]
    best = ring[0]
    best_d2 = math.inf
    n = len(ring)
    for i in range(n):
        cand = _nearest_point_on_segment_xy(pt, ring[i], ring[(i + 1) % n])
        dx = cand[0] - pt[0]
        dy = cand[1] - pt[1]
        d2 = dx * dx + dy * dy
        if d2 < best_d2:
            best_d2 = d2
            best = cand
    return from_local(best, origin)


def distance_point_to_polygon_meters(p: Point, polygon: Sequence[Point]) -> float:
    """Minimum horizontal distance from a point to a polygon boundary, metres."""
    return haversine_meters(p, nearest_point_on_polygon_boundary(p, polygon))


def point_in_or_on_polygon(p: Point, polygon: Sequence[Point]) -> bool:
    """Containment that treats the polygon edge as inside."""
    return point_in_polygon(p, polygon) or distance_point_to_polygon_meters(p, polygon) <= 0.02


def _distance_point_to_segment_xy(p: XY, s1: XY, s2: XY) -> float:
    nearest = _nearest_point_on_segment_xy(p, s1, s2)
    return math.hypot(p[0] - nearest[0], p[1] - nearest[1])


def distance_segment_to_polygon_meters(a: Point, b: Point, polygon: Sequence[Point]) -> float:
    """Minimum distance between a line segment and a polygon, metres (0 inside)."""
    if segment_enters_polygon(a, b, polygon):
        return 0.0
    origin = polygon[0]
    pa = to_local(a, origin)
    pb = to_local(b, origin)
    ring = [to_local(v, origin) for v in polygon]
    best = math.inf
    n = len(ring)
    for i in range(n):
        e1 = ring[i]
        e2 = ring[(i + 1) % n]
        best = min(best,
                   _distance_point_to_segment_xy(pa, e1, e2),
                   _distance_point_to_segment_xy(pb, e1, e2),
                   _distance_point_to_segment_xy(e1, pa, pb),
                   _distance_point_to_segment_xy(e2, pa, pb))
    return best


def distance_point_to_segment_meters(point: Point, a: Point, b: Point) -> float:
    """Perpendicular distance from a point to a line SEGMENT, metres."""
    lat_scale = 111320.0
    lon_scale = lat_scale * math.cos(a[0] * math.pi / 180.0)
    bx = (b[1] - a[1]) * lon_scale
    by = (b[0] - a[0]) * lat_scale
    px = (point[1] - a[1]) * lon_scale
    py = (point[0] - a[0]) * lat_scale
    denom = bx * bx + by * by
    t = 0.0 if denom == 0 else max(0.0, min(1.0, (px * bx + py * by) / denom))
    return math.hypot(px - t * bx, py - t * by)


def distance_segment_to_segment_meters(a1: Point, a2: Point, b1: Point, b2: Point) -> float:
    """Minimum distance between two line SEGMENTS, metres."""
    return min(
        distance_point_to_segment_meters(a1, b1, b2),
        distance_point_to_segment_meters(a2, b1, b2),
        distance_point_to_segment_meters(b1, a1, a2),
        distance_point_to_segment_meters(b2, a1, a2),
    )


def move_point_across_boundary(p: Point, polygon: Sequence[Point], margin_m: float) -> Point:
    """Move ``p`` to the nearest boundary point and ``margin_m`` further along.

    Inside -> outside by ~margin (an NFZ push-out); outside -> inside by
    ~margin (a perimeter pull-in). A point exactly on the boundary falls back
    to the vertex-centroid direction, which points outward for a convex ring.
    """
    origin = polygon[0]
    pt = to_local(p, origin)
    boundary = to_local(nearest_point_on_polygon_boundary(p, polygon), origin)
    dx = boundary[0] - pt[0]
    dy = boundary[1] - pt[1]
    length = math.hypot(dx, dy)
    if length < 1e-9:
        ring = [to_local(v, origin) for v in polygon]
        cx = sum(v[0] for v in ring) / len(ring)
        cy = sum(v[1] for v in ring) / len(ring)
        dx = pt[0] - cx
        dy = pt[1] - cy
        length = math.hypot(dx, dy)
        if length < 1e-9:
            dx, dy, length = 1.0, 0.0, 1.0
    scale = margin_m / length
    return from_local((boundary[0] + dx * scale, boundary[1] + dy * scale), origin)


def move_point_away_from_polygon(p: Point, polygon: Sequence[Point], clearance_m: float) -> Point:
    """Move a point to a requested clearance OUTSIDE a polygon boundary."""
    origin = polygon[0]
    pt = to_local(p, origin)
    boundary = to_local(nearest_point_on_polygon_boundary(p, polygon), origin)
    ring = [to_local(v, origin) for v in polygon]
    cx = sum(v[0] for v in ring) / len(ring)
    cy = sum(v[1] for v in ring) / len(ring)
    if point_in_polygon(p, polygon):
        dx = boundary[0] - pt[0]
        dy = boundary[1] - pt[1]
    else:
        dx = pt[0] - boundary[0]
        dy = pt[1] - boundary[1]
    length = math.hypot(dx, dy)
    if length < 1e-9:
        dx = boundary[0] - cx
        dy = boundary[1] - cy
        length = math.hypot(dx, dy)
    if length < 1e-9:
        dx, dy, length = 1.0, 0.0, 1.0
    return from_local(
        (boundary[0] + dx / length * clearance_m, boundary[1] + dy / length * clearance_m),
        origin,
    )


def polygon_centroid(polygon: Sequence[Point]) -> Point:
    """Vertex centroid (adequate for target placement, not for area maths)."""
    return (sum(v[0] for v in polygon) / len(polygon),
            sum(v[1] for v in polygon) / len(polygon))


def move_point_inside_polygon(p: Point, polygon: Sequence[Point], clearance_m: float) -> Point:
    """Move an inside point away from its nearest boundary, staying inward."""
    origin = polygon[0]
    pt = to_local(p, origin)
    boundary = to_local(nearest_point_on_polygon_boundary(p, polygon), origin)
    dx = pt[0] - boundary[0]
    dy = pt[1] - boundary[1]
    length = math.hypot(dx, dy)
    if length < 1e-9:
        ring = [to_local(v, origin) for v in polygon]
        dx = sum(v[0] for v in ring) / len(ring) - boundary[0]
        dy = sum(v[1] for v in ring) / len(ring) - boundary[1]
        length = math.hypot(dx, dy)
    if length < 1e-9:
        raise ValueError("cannot derive inward direction for degenerate polygon")
    return from_local(
        (boundary[0] + dx / length * clearance_m, boundary[1] + dy / length * clearance_m),
        origin,
    )


# ---------------------------------------------------------------------------
# 3. Site geometry — buffered NFZs and geofence containment
# ---------------------------------------------------------------------------
#: Slack applied to buffer comparisons, metres (absorbs 6-dp rounding noise).
BUFFER_EPSILON_M = 0.05


def nfz_applies_at_altitude(zone: SiteNfz, min_alt_m: float) -> bool:
    """True when a zone constrains a leg whose LOWEST altitude is ``min_alt_m``."""
    return min_alt_m <= zone.ceilingM


def point_nfz_clearance_m(p: Point, zone: SiteNfz) -> float:
    return 0.0 if point_in_polygon(p, zone.polygon) else distance_point_to_polygon_meters(p, zone.polygon)


def segment_nfz_clearance_m(a: Point, b: Point, zone: SiteNfz) -> float:
    return distance_segment_to_polygon_meters(a, b, zone.polygon)


def nfz_transit_violations(a: Point, b: Point, min_alt_m: float, site: SiteModel) -> List[Tuple[SiteNfz, float]]:
    """The NFZs a leg at ``min_alt_m`` fails to clear by ``nfz_buffer_m``."""
    out: List[Tuple[SiteNfz, float]] = []
    for zone in site.nfz:
        if not nfz_applies_at_altitude(zone, min_alt_m):
            continue
        clearance = segment_nfz_clearance_m(a, b, zone)
        if clearance < site.nfzBufferM - BUFFER_EPSILON_M:
            out.append((zone, clearance))
    return out


def segment_clears_buffered_nfzs(a: Point, b: Point, min_alt_m: float, site: SiteModel) -> bool:
    return not nfz_transit_violations(a, b, min_alt_m, site)


def nfz_orbit_violations(center: Point, radius_m: float, alt_m: float, site: SiteModel) -> List[Tuple[SiteNfz, float]]:
    out: List[Tuple[SiteNfz, float]] = []
    for zone in site.nfz:
        if not nfz_applies_at_altitude(zone, alt_m):
            continue
        clearance = point_nfz_clearance_m(center, zone)
        if clearance < site.nfzBufferM + radius_m - BUFFER_EPSILON_M:
            out.append((zone, clearance))
    return out


def orbit_clears_buffered_nfzs(center: Point, radius_m: float, alt_m: float, site: SiteModel) -> bool:
    return not nfz_orbit_violations(center, radius_m, alt_m, site)


def point_inside_geofence(p: Point, site: SiteModel) -> bool:
    return point_in_or_on_polygon(p, site.geofence)


def point_inside_perimeter(p: Point, site: SiteModel) -> bool:
    return point_in_or_on_polygon(p, site.perimeter)


def segment_inside_geofence(a: Point, b: Point, site: SiteModel) -> bool:
    if haversine_meters(a, b) == 0:
        return point_inside_geofence(a, site)
    return segment_stays_inside_polygon(a, b, site.geofence)


def orbit_inside_geofence(center: Point, radius_m: float, site: SiteModel) -> bool:
    return (point_inside_geofence(center, site) and
            distance_point_to_polygon_meters(center, site.geofence) >= radius_m - BUFFER_EPSILON_M)


def leg_needs_lidar(a: Point, b: Point, min_alt_m: float, site: SiteModel) -> bool:
    """True when a leg transits clutter below the LiDAR-degraded clear altitude."""
    return any(distance_segment_to_polygon_meters(a, b, area.polygon) == 0 and
               min_alt_m < site.clearAltitudeM for area in site.clutter)


# ---------------------------------------------------------------------------
# 4. Route search — via-points around a buffered NFZ
# ---------------------------------------------------------------------------
#: Detour ordering slack, metres: below this, two detours are a tie.
DETOUR_TIE_EPSILON_M = 1e-6


@dataclass(frozen=True)
class ViaCandidate:
    point: Point
    detour_m: float


def _via_comparator(a: ViaCandidate, b: ViaCandidate) -> int:
    """The TypeScript comparator, verbatim: shortest detour, then northernmost."""
    delta = a.detour_m - b.detour_m
    if abs(delta) > DETOUR_TIE_EPSILON_M:
        return -1 if delta < 0 else 1
    lat_delta = b.point[0] - a.point[0]
    if lat_delta < 0:
        return -1
    if lat_delta > 0:
        return 1
    return 0


def via_candidates(from_p: Point, to_p: Point, zone: SiteNfz, site: SiteModel,
                   clearance_m: Optional[float] = None,
                   require_exit_leg: bool = True) -> List[ViaCandidate]:
    """Candidates that route ``from -> via -> to`` around ``zone``.

    Ordered by lowest total detour, then northernmost. Every candidate is
    inside the geofence and clears every buffered NFZ on the legs it is
    responsible for.
    """
    if clearance_m is None:
        clearance_m = site.nfzBufferM * 2 + 5
    candidates: List[ViaCandidate] = []
    for vertex in zone.polygon:
        point = move_point_away_from_polygon(vertex, zone.polygon, clearance_m)
        if not point_in_or_on_polygon(point, site.geofence):
            continue
        legal = True
        for other in site.nfz:
            if distance_segment_to_polygon_meters(from_p, point, other.polygon) < site.nfzBufferM - BUFFER_EPSILON_M:
                legal = False
                break
            if require_exit_leg and distance_segment_to_polygon_meters(point, to_p, other.polygon) < site.nfzBufferM - BUFFER_EPSILON_M:
                legal = False
                break
        if not legal:
            continue
        candidates.append(ViaCandidate(
            point=point,
            detour_m=haversine_meters(from_p, point) + haversine_meters(point, to_p),
        ))
    return sorted(candidates, key=functools.cmp_to_key(_via_comparator))


def find_via_point(from_p: Point, to_p: Point, min_alt_m: float,
                   site: SiteModel) -> Optional[Tuple[Point, SiteNfz, float]]:
    """Shortest legal via-point for the FIRST blocking NFZ on ``from -> to``."""
    for zone in site.nfz:
        if not nfz_applies_at_altitude(zone, min_alt_m):
            continue
        if segment_nfz_clearance_m(from_p, to_p, zone) >= site.nfzBufferM - BUFFER_EPSILON_M:
            continue
        clearance = site.nfzBufferM * 2 + 5
        entry_only = [c for c in via_candidates(from_p, to_p, zone, site, clearance, False)
                      if segment_inside_geofence(from_p, c.point, site)]
        # Prefer a via that also clears the exit leg; otherwise take the
        # shortest one that clears the entry leg and let the caller route on.
        complete = [c for c in entry_only
                    if segment_clears_buffered_nfzs(c.point, to_p, min_alt_m, site) and
                    segment_inside_geofence(c.point, to_p, site)]
        candidates = complete if complete else entry_only
        if not candidates:
            return None
        return (candidates[0].point, zone, candidates[0].detour_m)
    return None


def route_vias(from_p: Point, to_p: Point, min_alt_m: float, site: SiteModel,
               max_vias: int = 4) -> Optional[List[Point]]:
    """The intermediate points of a complete route, or ``None`` (infeasible).

    ``to`` is never included. An empty list means the straight leg is legal.
    """
    vias: List[Point] = []
    cursor = from_p
    for _ in range(max_vias + 1):
        if segment_inside_geofence(cursor, to_p, site) and segment_clears_buffered_nfzs(cursor, to_p, min_alt_m, site):
            return vias
        via = find_via_point(cursor, to_p, min_alt_m, site)
        if via is None:
            return None
        vias.append(via[0])
        cursor = via[0]
    return None


# ---------------------------------------------------------------------------
# 5. Orbit geometry
# ---------------------------------------------------------------------------
def orbit_entry_point(center: Point, from_p: Point, radius_m: float) -> Point:
    """The ring point facing ``from``, so the approach never breaches standoff."""
    distance = haversine_meters(center, from_p)
    if distance < 0.01:
        return translate_meters(center, 0.0, radius_m)
    scale = radius_m / distance
    return (center[0] + (from_p[0] - center[0]) * scale,
            center[1] + (from_p[1] - center[1]) * scale)


def shrink_orbit_radius(center: Point, requested_m: float, alt_m: float,
                        site: SiteModel, floor_m: float) -> Optional[float]:
    """Shrink an orbit until it clears the NFZ buffers and the geofence.

    NEVER below ``floor_m``. Returns ``None`` when clearing would require going
    below the standoff floor: that is an infeasible task, not a plan flown
    closer than standoff.
    """
    if not point_inside_geofence(center, site):
        return None
    geofence_room = distance_point_to_polygon_meters(center, site.geofence)
    nfz_room = [point_nfz_clearance_m(center, zone) - site.nfzBufferM
                for zone in site.nfz if nfz_applies_at_altitude(zone, alt_m)]
    room = min([requested_m, geofence_room] + nfz_room)
    if not math.isfinite(room) or room < floor_m:
        return None
    # Round DOWN to 0.1 m so the emitted radius is stable and still clears.
    radius = max(floor_m, math.floor(room * 10) / 10)
    if (radius >= floor_m and orbit_clears_buffered_nfzs(center, radius, alt_m, site) and
            orbit_inside_geofence(center, radius, site)):
        return radius
    return None


# ---------------------------------------------------------------------------
# 6. Mission model — the walk, the flight-time model and the budget
# ---------------------------------------------------------------------------
#: Climb/descent rate used for conservative flight-time estimates, m/s.
CONSERVATIVE_VERTICAL_SPEED_MPS = 2.0
#: Seconds allowed for the descent-and-land tail of an ``rtl``.
RTL_LANDING_ALLOWANCE_S = 15.0
#: Flight seconds charged to a hold with no declared duration.
INDEFINITE_HOLD_S = 30.0


@dataclass(frozen=True)
class ProfileLimits:
    maxSpeedMps: float
    maxAltitudeM: float
    standoffM: float
    maxSortieS: float


def policy_for(profile: str, capabilities: Optional[Sequence[Mapping[str, Any]]] = None) -> ProfileLimits:
    """Profile policy, TIGHTENED (never relaxed) by reported vehicle capabilities."""
    base = PROFILE_POLICY[profile]
    effective = None
    for entry in capabilities or ():
        if entry.get("profile") == profile:
            effective = entry
            break
    if effective is None:
        return ProfileLimits(base["maxSpeedMps"], base["maxAltitudeM"], base["standoffM"], base["maxSortieS"])
    return ProfileLimits(
        maxSpeedMps=min(base["maxSpeedMps"], effective["max_speed_mps"]),
        maxAltitudeM=min(base["maxAltitudeM"], effective["max_altitude_m"]),
        standoffM=max(base["standoffM"], effective["min_standoff_m"]),
        maxSortieS=base["maxSortieS"],
    )


def profile_for_tool(tool: Mapping[str, Any], plan_profile: str) -> str:
    """The profile that governs one tool: its own override, else the plan's."""
    if tool["tool"] == "goto_gps" and tool.get("profile") is not None:
        return tool["profile"]
    if tool["tool"] in ("follow", "orbit"):
        return tool["profile"]
    return plan_profile


@dataclass(frozen=True)
class WalkTarget:
    toolIndex: int
    kind: str                       # goto_gps | goto_relative | orbit_point
    pos: Point
    altM: float
    radiusM: Optional[float] = None


@dataclass(frozen=True)
class WalkLeg:
    toolIndex: int
    from_p: Point
    to_p: Point
    fromAltM: float
    toAltM: float
    minAltM: float
    maxAltM: float
    lengthM: float
    speedMps: float


@dataclass(frozen=True)
class Walk:
    targets: Tuple[WalkTarget, ...]
    legs: Tuple[WalkLeg, ...]
    totalPathM: float
    totalFlightS: float


def walk_plan(plan: Any, site: SiteModel, *, start: Optional[Point] = None,
              start_alt_m: Optional[float] = None,
              capabilities: Optional[Sequence[Mapping[str, Any]]] = None) -> Walk:
    """Walk a plan into targets, legs, path length and flight seconds.

    The single source of mission geometry: the verifier checks these legs and
    the planner sizes its budget from this walk.
    """
    tools = plan.tools if hasattr(plan, "tools") else plan["tools"]
    plan_profile = plan.profile if hasattr(plan, "profile") else plan["profile"]

    targets: List[WalkTarget] = []
    legs: List[WalkLeg] = []
    total_path_m = 0.0
    total_flight_s = 0.0
    home = (site.home.lat, site.home.lon)
    current: Point = start if start is not None else home
    current_alt: Optional[float] = start_alt_m

    def add_leg(tool_index: int, to_p: Point, altitude_m: float, speed_mps: float) -> None:
        nonlocal current, current_alt, total_path_m, total_flight_s
        length_m = haversine_meters(current, to_p)
        from_alt_m = current_alt if current_alt is not None else site.altBandMin
        legs.append(WalkLeg(
            toolIndex=tool_index, from_p=current, to_p=to_p, fromAltM=from_alt_m,
            toAltM=altitude_m, minAltM=min(from_alt_m, altitude_m),
            maxAltM=max(from_alt_m, altitude_m), lengthM=length_m, speedMps=speed_mps,
        ))
        total_path_m += length_m
        total_flight_s += (length_m / speed_mps) if speed_mps > 0 else math.inf
        total_flight_s += abs(altitude_m - from_alt_m) / CONSERVATIVE_VERTICAL_SPEED_MPS
        current = to_p
        current_alt = altitude_m

    for index, tool in enumerate(tools):
        profile = profile_for_tool(tool, plan_profile)
        speed = min(PROFILE_SPEED_MPS[profile], policy_for(profile, capabilities).maxSpeedMps)
        kind = tool["tool"]
        if kind == "goto_gps":
            to_p = (tool["lat"], tool["lon"])
            declared = tool.get("speed_mps")
            add_leg(index, to_p, tool["alt"], declared if declared is not None else speed)
            targets.append(WalkTarget(index, "goto_gps", to_p, tool["alt"]))
        elif kind == "goto_relative":
            to_p = translate_meters(current, tool["dx"], tool["dy"])
            altitude = (current_alt if current_alt is not None else site.altBandMin) + tool["dz"]
            add_leg(index, to_p, altitude, speed)
            targets.append(WalkTarget(index, "goto_relative", to_p, altitude))
        elif kind == "orbit_point":
            altitude = current_alt if current_alt is not None else site.altBandMin
            center = (tool["lat"], tool["lon"])
            entry = orbit_entry_point(center, current, tool["radius"])
            add_leg(index, entry, altitude, speed)
            laps = tool.get("laps")
            orbit_length = 2 * math.pi * tool["radius"] * (laps if laps is not None else 1)
            total_path_m += orbit_length
            total_flight_s += (orbit_length / speed) if speed > 0 else math.inf
            targets.append(WalkTarget(index, "orbit_point", center, altitude, tool["radius"]))
        elif kind == "hold":
            duration = tool.get("durationS")
            total_flight_s += duration if duration is not None else INDEFINITE_HOLD_S
        elif kind == "follow":
            total_flight_s += INDEFINITE_HOLD_S
        elif kind == "orbit":
            total_flight_s += 2 * math.pi * policy_for(profile, capabilities).standoffM / speed
        elif kind == "rtl":
            altitude = current_alt if current_alt is not None else site.altBandMin
            add_leg(index, home, altitude, speed)
            total_flight_s += altitude / CONSERVATIVE_VERTICAL_SPEED_MPS + RTL_LANDING_ALLOWANCE_S
            current_alt = None

    return Walk(tuple(targets), tuple(legs), total_path_m, total_flight_s)


def wind_adjusted_seconds(flight_s: float, wind_mps: float = 0.0) -> float:
    """Flight seconds inflated for wind: ``t x (1 + 0.05 x wind)`` (ADR D16)."""
    return flight_s * (1 + VERIFIER_POLICY["windTimeFactorPerMps"] * wind_mps)


def range_available_seconds(soc_pct: float, remaining_s: Optional[float] = None) -> float:
    """Flight seconds available from the live pack, honouring the 25 % reserve.

    The vehicle's own ``remaining_s`` estimate TIGHTENS the model, never
    relaxes it.
    """
    if not (isinstance(soc_pct, (int, float)) and not isinstance(soc_pct, bool) and math.isfinite(soc_pct)):
        return 0.0
    usable = max(0.0, (soc_pct - VERIFIER_POLICY["reservePct"]) / 100.0)
    model_available = VERIFIER_POLICY["nominalEnduranceS"] * usable
    if remaining_s is not None and isinstance(remaining_s, (int, float)) and math.isfinite(remaining_s):
        live_available = remaining_s * max(
            0.0, (soc_pct - VERIFIER_POLICY["reservePct"]) / max(soc_pct, 1)
        )
    else:
        live_available = math.inf
    return min(model_available, live_available)


def time_budget_seconds(*, soc_pct: float, remaining_s: Optional[float] = None,
                        max_sortie_s: Optional[float] = None, profile: Optional[str] = None,
                        capabilities: Optional[Sequence[Mapping[str, Any]]] = None) -> float:
    """The planner's time budget: ``min(range time, sortie cap)`` (ADR D16/D20)."""
    profile_cap = policy_for(profile, capabilities).maxSortieS if profile else math.inf
    return min(
        range_available_seconds(soc_pct, remaining_s),
        VERIFIER_POLICY["maxSortieS"],
        profile_cap,
        max_sortie_s if max_sortie_s is not None else math.inf,
    )


# ---------------------------------------------------------------------------
# 7. Separation — corridor-to-corridor geometry (ADR D21)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class CorridorGeometry:
    """The airspace a corridor occupies: points, swept legs and rings."""
    points: Tuple[Point, ...] = ()
    legs: Tuple[Tuple[Point, Point], ...] = ()
    orbits: Tuple[Tuple[Point, float], ...] = ()
    #: Metres AGL; ``None`` when unknown (never treated as clear).
    altBandM: Optional[Tuple[float, float]] = None


def corridor_geometry_from_walk(walk: Walk) -> CorridorGeometry:
    altitudes = [t.altM for t in walk.targets]
    for leg in walk.legs:
        altitudes.extend((leg.minAltM, leg.maxAltM))
    altitudes = [a for a in altitudes if math.isfinite(a)]
    return CorridorGeometry(
        points=(),
        legs=tuple((leg.from_p, leg.to_p) for leg in walk.legs if leg.lengthM > 0),
        orbits=tuple((t.pos, t.radiusM if t.radiusM is not None else 0.0)
                     for t in walk.targets if t.kind == "orbit_point"),
        altBandM=(min(altitudes), max(altitudes)) if altitudes else None,
    )


def _ring_to_point_m(ring: Tuple[Point, float], point: Point) -> float:
    return abs(haversine_meters(ring[0], point) - ring[1])


def _ring_to_ring_m(a: Tuple[Point, float], b: Tuple[Point, float]) -> float:
    d = haversine_meters(a[0], b[0])
    if d >= a[1] + b[1]:
        return d - (a[1] + b[1])
    inner = max(a[1], b[1]) - (d + min(a[1], b[1]))
    return inner if inner > 0 else 0.0


def _ring_to_segment_m(ring: Tuple[Point, float], from_p: Point, to_p: Point) -> float:
    return max(0.0, distance_point_to_segment_meters(ring[0], from_p, to_p) - ring[1])


def lateral_separation_m(ours: CorridorGeometry, peer: CorridorGeometry) -> float:
    """Minimum lateral distance between two corridors, metres (inf when disjoint)."""
    distances: List[float] = []

    def pair_point_with(point: Point) -> None:
        for leg in ours.legs:
            distances.append(distance_point_to_segment_meters(point, leg[0], leg[1]))
        for orbit in ours.orbits:
            distances.append(_ring_to_point_m(orbit, point))
        if not ours.legs and not ours.orbits:
            for our_point in ours.points:
                distances.append(haversine_meters(our_point, point))

    for point in peer.points:
        pair_point_with(point)
    for peer_leg in peer.legs:
        for leg in ours.legs:
            distances.append(distance_segment_to_segment_meters(leg[0], leg[1], peer_leg[0], peer_leg[1]))
        for orbit in ours.orbits:
            distances.append(_ring_to_segment_m(orbit, peer_leg[0], peer_leg[1]))
        for point in ours.points:
            distances.append(distance_point_to_segment_meters(point, peer_leg[0], peer_leg[1]))
    for peer_orbit in peer.orbits:
        for leg in ours.legs:
            distances.append(_ring_to_segment_m(peer_orbit, leg[0], leg[1]))
        for orbit in ours.orbits:
            distances.append(_ring_to_ring_m(orbit, peer_orbit))
        for point in ours.points:
            distances.append(_ring_to_point_m(peer_orbit, point))
    return min(distances) if distances else math.inf


def vertical_separation_m(ours: Optional[Tuple[float, float]],
                          peer: Optional[Tuple[float, float]]) -> float:
    """Vertical gap between two altitude bands, metres; 0 when either is unknown."""
    if ours is None or peer is None:
        return 0.0
    return max(0.0, ours[0] - peer[1], peer[0] - ours[1])


def trim_to_budget(tools: Sequence[Mapping[str, Any]]) -> Tuple[List[Dict[str, Any]], List[str]]:
    """The budget trim, in the verifier's order: drop holds, then extra laps.

    Nothing here shortens a route or lowers an altitude — a mission that still
    does not fit is infeasible, not squeezed.
    """
    notes: List[str] = []
    trimmed: List[Dict[str, Any]] = []
    for index, tool in enumerate(tools):
        if tool["tool"] == "hold":
            notes.append(f"dropped hold tool {index} to fit budget")
            continue
        laps = tool.get("laps")
        if tool["tool"] == "orbit_point" and (laps if laps is not None else 1) > 1:
            notes.append(f"trimmed orbit tool {index} to one lap")
            copy = dict(tool)
            copy["laps"] = 1
            trimmed.append(copy)
            continue
        trimmed.append(dict(tool))
    return trimmed, notes


def lateral_tolerance_m(profile: str) -> float:
    """Corridor half-width for a profile (ADR D21)."""
    return (CORRIDOR_POLICY["lateralTolSurveyM"] if canonical_profile(profile) == "survey"
            else CORRIDOR_POLICY["lateralTolInspectM"])
