"""
rails/envelope — the runtime envelope monitor's POLICY, independently written.

Reference of ``platform/companion/src/eis_companion/control/envelope.py``. The
monitor answers ONE question, 20 times a second: *is the vehicle still inside
the envelope it was cleared for?* It observes and constrains; it never guides.
Nothing here produces a trajectory, a waypoint or a relaxed limit. Its only
output is a state, the constraint that decided it, a signed margin and an
action request for the failsafe machine (ADR D22).

The policy, verbatim (ADR D22 / D21):

    lateral drift > tolerance                      -> warning + slow
    drift > 2x tolerance, or altitude outside band -> hold
    NFZ buffer or geofence margin intrusion        -> rtl
    standoff below the floor                       -> hold + back off
    sortie budget exhausted                        -> rtl
    separation: 40 m; peer data > 3 s stale: 80 m  -> hold
    peer data > 10 s stale                         -> hold, whatever the range
    any breach persisting >= 5 s                   -> escalate
    recovery                                       -> hysteretic, never flappy

The monitor is INDEPENDENT of guidance by construction: it shares no state with
the planner, the ground station or the LLM, and it cannot be disabled by
anything it watches. The oracle preserves that shape — this module imports
nothing from ``rails.geometry`` either, because the companion's monitor carries
its own arithmetic and a shared library would hide a divergence rather than
expose it.

STRUCTURE NOTE. This is a re-derivation, not a transcription: the constraints
are a declarative table evaluated in one pass, where the companion writes one
function per constraint. The NUMBERS and the ORDER are identical, which is the
whole point of running both over the same trajectories.

UNITS. ``margin_m`` is signed metres for every geometric constraint (positive =
inside the envelope, negative = how far past the limit). ``sortie`` is a time
budget, so it reports ``margin_unit == "s"`` and the wire message omits the
optional ``margin_m`` field rather than publishing seconds in a metres slot.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Any, Dict, Mapping, Optional, Sequence, Tuple

# ---------------------------------------------------------------------------
# Vocabulary (mirrors shared.py EnvelopeState / EnvelopeConstraint)
# ---------------------------------------------------------------------------
STATE_IN_ENVELOPE = "in_envelope"
STATE_WARNING = "warning"
STATE_BREACH = "breach"
ENVELOPE_STATES: Tuple[str, ...] = (STATE_IN_ENVELOPE, STATE_WARNING, STATE_BREACH)

#: The internal severity ladder, least severe first. ``escalate`` sits on top
#: of the sustained ``base_action`` and never replaces it.
ACTIONS: Tuple[str, ...] = ("none", "slow", "hold", "rtl", "escalate")
_ACTION_RANK = {name: index for index, name in enumerate(ACTIONS)}

#: The contract's EnvelopeAction subset. An escalation is a message to humans,
#: never a change of flight state.
WIRE_ACTIONS: Tuple[str, ...] = ("none", "slow", "hold", "rtl")

#: Evaluation order, and the deterministic tie-break when two constraints
#: produce the same action rank.
CONSTRAINTS: Tuple[str, ...] = (
    "geofence", "nfz", "altitude", "corridor", "standoff", "separation", "sortie",
)

#: Default corridor tolerances (ADR D21); a plan's corridor carries its own.
LATERAL_TOL_INSPECT_M = 10.0
LATERAL_TOL_SURVEY_M = 15.0
ORBIT_RADIAL_TOL_M = 5.0

#: Commanded-speed scale requested alongside a "slow" action.
SLOW_SPEED_SCALE = 0.5

_EARTH_R_M = 6_371_000.0


def action_rank(action: str) -> int:
    return _ACTION_RANK.get(str(action), 0)


def worse_action(a: str, b: str) -> str:
    return a if action_rank(a) >= action_rank(b) else b


# ---------------------------------------------------------------------------
# Geometry — local equirectangular projection, metres, (lat, lon) order
# ---------------------------------------------------------------------------
def _finite(*values: Any) -> bool:
    try:
        return all(math.isfinite(float(v)) for v in values)
    except (TypeError, ValueError):
        return False


def meters_per_degree(lat_deg: float) -> Tuple[float, float]:
    """(metres per degree latitude, metres per degree longitude) at ``lat``."""
    if not _finite(lat_deg):
        return (111_320.0, 111_320.0)
    lat_m = 111_320.0
    lon_m = max(1.0, lat_m * math.cos(math.radians(max(-89.9, min(89.9, lat_deg)))))
    return (lat_m, lon_m)


def to_local_m(lat: float, lon: float, ref_lat: float, ref_lon: float) -> Tuple[float, float]:
    lat_m, lon_m = meters_per_degree(ref_lat)
    return ((lon - ref_lon) * lon_m, (lat - ref_lat) * lat_m)


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle surface distance in metres; ``inf`` for malformed input."""
    if not _finite(lat1, lon1, lat2, lon2):
        return math.inf
    if not (-90.0 <= lat1 <= 90.0 and -90.0 <= lat2 <= 90.0):
        return math.inf
    if not (-180.0 <= lon1 <= 180.0 and -180.0 <= lon2 <= 180.0):
        return math.inf
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = phi2 - phi1
    dlam = math.radians(lon2 - lon1)
    hav = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2.0) ** 2
    return 2.0 * _EARTH_R_M * math.asin(math.sqrt(min(1.0, max(0.0, hav))))


def point_segment_distance_m(point: Tuple[float, float], start: Tuple[float, float],
                             end: Tuple[float, float]) -> float:
    """Distance from a point to a lat/lon segment, metres.

    Beyond either end the distance to that endpoint is returned: a corridor leg
    is a capsule, not an infinite line, so overshooting the last waypoint reads
    as drift rather than as staying perfectly on track.
    """
    if not _finite(point[0], point[1], start[0], start[1], end[0], end[1]):
        return math.inf
    ref_lat, ref_lon = start
    px, py = to_local_m(point[0], point[1], ref_lat, ref_lon)
    bx, by = to_local_m(end[0], end[1], ref_lat, ref_lon)
    seg_sq = bx * bx + by * by
    if seg_sq <= 1e-9:
        return math.hypot(px, py)
    t = max(0.0, min(1.0, (px * bx + py * by) / seg_sq))
    return math.hypot(px - t * bx, py - t * by)


def point_in_polygon(point: Tuple[float, float], polygon: Sequence[Tuple[float, float]]) -> bool:
    """Boundary-INCLUSIVE ray cast in (lat, lon) order."""
    if len(polygon) < 3:
        return False
    y, x = point
    inside = False
    for i, (y1, x1) in enumerate(polygon):
        y2, x2 = polygon[(i + 1) % len(polygon)]
        cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1)
        if (abs(cross) < 1e-12 and min(x1, x2) <= x <= max(x1, x2)
                and min(y1, y2) <= y <= max(y1, y2)):
            return True
        if (y1 > y) != (y2 > y):
            at_x = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < at_x:
                inside = not inside
    return inside


def signed_distance_inside_m(point: Tuple[float, float],
                             polygon: Sequence[Tuple[float, float]]) -> float:
    """Signed distance to a polygon boundary: positive INSIDE, negative outside.

    ``+inf`` for a degenerate ring: an undefined boundary constrains nothing,
    and reporting a fake breach would be worse than reporting none.
    """
    if len(polygon) < 3 or not _finite(point[0], point[1]):
        return math.inf
    edge = min(point_segment_distance_m(point, polygon[i], polygon[(i + 1) % len(polygon)])
               for i in range(len(polygon)))
    return edge if point_in_polygon(point, polygon) else -edge


# ---------------------------------------------------------------------------
# The certified corridor (the thing the monitor actually checks)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class CorridorLeg:
    start: Tuple[float, float]
    end: Tuple[float, float]
    lateral_tol_m: float = LATERAL_TOL_INSPECT_M


@dataclass(frozen=True)
class CorridorOrbit:
    center: Tuple[float, float]
    radius_m: float = 0.0
    radial_tol_m: float = ORBIT_RADIAL_TOL_M


@dataclass(frozen=True)
class Corridor:
    legs: Tuple[CorridorLeg, ...] = ()
    orbits: Tuple[CorridorOrbit, ...] = ()
    alt_min_m: float = 0.0
    alt_max_m: float = math.inf
    generated_from: str = ""

    @property
    def has_shape(self) -> bool:
        return bool(self.legs or self.orbits)

    @property
    def has_band(self) -> bool:
        return math.isfinite(self.alt_max_m) or self.alt_min_m > 0.0

    @classmethod
    def from_wire(cls, raw: Any) -> "Corridor":
        """Parse the contract ``Corridor`` mapping; malformed parts are dropped.

        Dropping is safe ONLY because a corridor with no shape yields no
        corridor finding at all, and the orchestrator refuses dispatch on a
        mission record it cannot verify — an unparseable corridor never
        silently becomes "anything goes" on a live mission.
        """
        if not isinstance(raw, Mapping):
            return cls()
        legs = []
        for item in raw.get("legs") or ():
            leg = _leg_from_wire(item)
            if leg is not None:
                legs.append(leg)
        orbits = []
        for item in raw.get("orbits") or ():
            orbit = _orbit_from_wire(item)
            if orbit is not None:
                orbits.append(orbit)
        lo, hi = 0.0, math.inf
        band = raw.get("alt_band_m")
        if isinstance(band, Mapping):
            try:
                lo = float(band.get("min", 0.0))
                hi = float(band.get("max", math.inf))
            except (TypeError, ValueError):
                lo, hi = 0.0, math.inf
            if not _finite(lo):
                lo = 0.0
            if hi < lo:
                lo, hi = hi, lo
        return cls(legs=tuple(legs), orbits=tuple(orbits), alt_min_m=lo, alt_max_m=hi,
                   generated_from=str(raw.get("generated_from", "")))


def _latlon_from_wire(raw: Any) -> Optional[Tuple[float, float]]:
    if isinstance(raw, Mapping):
        lat, lon = raw.get("lat"), raw.get("lon")
    elif isinstance(raw, (list, tuple)) and len(raw) == 2:
        lat, lon = raw[0], raw[1]
    else:
        return None
    try:
        lat_f, lon_f = float(lat), float(lon)
    except (TypeError, ValueError):
        return None
    if not _finite(lat_f, lon_f):
        return None
    if not (-90.0 <= lat_f <= 90.0 and -180.0 <= lon_f <= 180.0):
        return None
    return (lat_f, lon_f)


def _positive(raw: Any, default: float) -> float:
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    return default if (not math.isfinite(value) or value <= 0.0) else value


def _leg_from_wire(raw: Any) -> Optional[CorridorLeg]:
    if not isinstance(raw, Mapping):
        return None
    start = _latlon_from_wire(raw.get("from"))
    end = _latlon_from_wire(raw.get("to"))
    if start is None or end is None:
        return None
    return CorridorLeg(start=start, end=end,
                       lateral_tol_m=_positive(raw.get("lateral_tol_m"), LATERAL_TOL_INSPECT_M))


def _orbit_from_wire(raw: Any) -> Optional[CorridorOrbit]:
    if not isinstance(raw, Mapping):
        return None
    center = _latlon_from_wire(raw.get("center"))
    if center is None:
        return None
    radius = _positive(raw.get("radius_m"), 0.0)
    if radius <= 0.0:
        return None
    return CorridorOrbit(center=center, radius_m=radius,
                         radial_tol_m=_positive(raw.get("radial_tol_m"), ORBIT_RADIAL_TOL_M))


# ---------------------------------------------------------------------------
# Site geometry, samples and limits
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class MonitoredZone:
    """An NFZ polygon: flight inside at or below ``ceiling_m`` AGL is forbidden."""
    name: str = ""
    polygon: Tuple[Tuple[float, float], ...] = ()
    ceiling_m: float = math.inf


@dataclass(frozen=True)
class SiteGeometry:
    geofence: Tuple[Tuple[float, float], ...] = ()
    nfz: Tuple[MonitoredZone, ...] = ()
    nfz_buffer_m: float = 25.0


@dataclass(frozen=True)
class EnvelopeSample:
    """One 20 Hz observation. ``t_s`` is a monotonic seconds clock."""
    t_s: float = 0.0
    lat: float = 0.0
    lon: float = 0.0
    rel_alt_m: float = 0.0
    airborne: bool = True
    #: Measured distance to the observed subject; ``inf`` = nothing observed,
    #: so the standoff constraint does not apply this tick.
    standoff_m: float = math.inf
    sortie_elapsed_s: float = 0.0
    sortie_cap_s: float = math.inf


@dataclass(frozen=True)
class PeerSample:
    """The other vehicle, as the hub-relayed fleet message reports it (D26).

    The ONLY cross-vehicle input. ``age_s`` is what makes staleness
    enforceable.
    """
    vehicle_id: str = ""
    lat: float = 0.0
    lon: float = 0.0
    rel_alt_m: float = 0.0
    age_s: float = math.inf
    valid: bool = False


@dataclass(frozen=True)
class EnvelopeLimits:
    """Thresholds the monitor enforces (ADR D21 / D22 values as defaults).

    Config may only TIGHTEN these; nothing may relax them.
    """
    standoff_floor_m: float = 3.0
    geofence_margin_m: float = 5.0
    nfz_buffer_m: float = 25.0
    separation_m: float = 40.0
    separation_stale_m: float = 80.0
    peer_stale_s: float = 3.0
    peer_hold_s: float = 10.0
    escalate_after_s: float = 5.0
    breach_multiple: float = 2.0
    hysteresis_m: float = 2.0
    recovery_s: float = 2.0


def required_separation_m(age_s: float, limits: EnvelopeLimits) -> float:
    """Required separation for peer data of age ``age_s``.

    Monotonically NON-DECREASING in age: 40 m fresh, 80 m past the staleness
    threshold, never narrower again. A stale peer position is an unknown peer
    position, so the requirement widens rather than degrading gracefully.
    """
    if not _finite(age_s) or age_s > limits.peer_stale_s:
        return max(limits.separation_m, limits.separation_stale_m)
    return limits.separation_m


# ---------------------------------------------------------------------------
# Findings + the decision
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Finding:
    constraint: str
    state: str = STATE_IN_ENVELOPE
    action: str = "none"
    margin_m: float = math.inf
    margin_unit: str = "m"
    detail: str = ""
    back_off_m: float = 0.0

    @property
    def rank(self) -> int:
        return action_rank(self.action)


@dataclass(frozen=True)
class EnvelopeDecision:
    state: str = STATE_IN_ENVELOPE
    constraint: str = ""
    margin_m: float = math.inf
    margin_unit: str = "m"
    action: str = "none"
    base_action: str = "none"
    detail: str = ""
    back_off_m: float = 0.0
    speed_scale: float = 1.0
    breach_duration_s: float = 0.0
    #: True while the orchestrator is suspending action requests (manual
    #: engaged): the monitor keeps evaluating and logging, nothing acts.
    suspended: bool = False

    @property
    def wire_action(self) -> str:
        """Contract-legal EnvelopeAction (escalation is not a flight state)."""
        action = self.base_action if self.action == "escalate" else self.action
        return action if action in WIRE_ACTIONS else "none"

    @property
    def escalated(self) -> bool:
        return self.action == "escalate"

    @property
    def rank(self) -> int:
        return action_rank(self.action)

    @property
    def wire_margin_m(self) -> Optional[float]:
        if self.margin_unit != "m" or not math.isfinite(self.margin_m):
            return None
        return float(self.margin_m)

    @property
    def signature(self) -> Tuple[str, str, str]:
        return (self.state, self.constraint, self.action)

    def to_message(self, vehicle_id: str, ts_ms: int) -> Dict[str, Any]:
        message: Dict[str, Any] = {
            "type": "envelope", "ts": int(ts_ms), "vehicleId": str(vehicle_id), "state": self.state,
        }
        if self.constraint:
            message["constraint"] = self.constraint
        margin = self.wire_margin_m
        if margin is not None:
            message["margin_m"] = round(float(margin), 3)
        message["action"] = self.wire_action
        return message


_IN_ENVELOPE = EnvelopeDecision()


# ---------------------------------------------------------------------------
# Stateless assessment — one sample, every constraint
#
# One declarative table, evaluated in CONSTRAINTS order. Each entry answers
# "does this constraint apply this tick?" and, if so, with what margin and what
# action. A constraint that does not apply is ABSENT, never a silent pass.
# ---------------------------------------------------------------------------
def _corridor_finding(sample: EnvelopeSample, corridor: Corridor,
                      limits: EnvelopeLimits) -> Optional[Finding]:
    if not corridor.has_shape:
        return None
    point = (sample.lat, sample.lon)
    # The vehicle only has to be inside ONE corridor element, so the element
    # with the smallest NORMALISED excursion (drift / its own tolerance) is the
    # one the corridor is judged against this tick.
    best_ratio = math.inf
    best: Optional[Tuple[float, float, str]] = None
    for leg in corridor.legs:
        tol = max(1e-6, float(leg.lateral_tol_m))
        dist = point_segment_distance_m(point, leg.start, leg.end)
        if not math.isfinite(dist):
            continue
        ratio = dist / tol
        if ratio < best_ratio:
            best_ratio, best = ratio, (dist, tol, "leg")
    for orbit in corridor.orbits:
        tol = max(1e-6, float(orbit.radial_tol_m))
        centre_dist = distance_m(sample.lat, sample.lon, orbit.center[0], orbit.center[1])
        if not math.isfinite(centre_dist):
            continue
        dist = abs(centre_dist - float(orbit.radius_m))
        ratio = dist / tol
        if ratio < best_ratio:
            best_ratio, best = ratio, (dist, tol, "orbit")
    if best is None:
        return None
    dist, tol, label = best
    margin = tol - dist
    if dist <= tol:
        return Finding("corridor", STATE_IN_ENVELOPE, "none", margin, "m",
                       f"{label} drift {dist:.1f} m within {tol:.1f} m")
    if dist <= limits.breach_multiple * tol:
        return Finding("corridor", STATE_WARNING, "slow", margin, "m",
                       f"{label} drift {dist:.1f} m beyond {tol:.1f} m tolerance")
    return Finding("corridor", STATE_BREACH, "hold", margin, "m",
                   f"{label} drift {dist:.1f} m beyond {limits.breach_multiple:.0f}x "
                   f"{tol:.1f} m tolerance")


def _altitude_finding(sample: EnvelopeSample, corridor: Corridor) -> Optional[Finding]:
    if not corridor.has_band:
        return None
    alt = float(sample.rel_alt_m)
    if not math.isfinite(alt):
        return Finding("altitude", STATE_BREACH, "hold", -math.inf, "m", "altitude unavailable")
    margin = min(alt - corridor.alt_min_m, corridor.alt_max_m - alt)
    if margin >= 0.0:
        return Finding("altitude", STATE_IN_ENVELOPE, "none", margin, "m",
                       f"altitude {alt:.1f} m inside band")
    return Finding("altitude", STATE_BREACH, "hold", margin, "m",
                   f"altitude {alt:.1f} m outside band "
                   f"[{corridor.alt_min_m:.0f}, {corridor.alt_max_m:.0f}] m")


def _geofence_finding(sample: EnvelopeSample, geometry: SiteGeometry,
                      limits: EnvelopeLimits) -> Optional[Finding]:
    if len(geometry.geofence) < 3:
        return None
    inside = signed_distance_inside_m((sample.lat, sample.lon), geometry.geofence)
    if not math.isfinite(inside):
        return None
    margin = inside - limits.geofence_margin_m
    if margin >= 0.0:
        return Finding("geofence", STATE_IN_ENVELOPE, "none", margin, "m",
                       f"{inside:.1f} m inside the geofence")
    return Finding("geofence", STATE_BREACH, "rtl", margin, "m",
                   f"geofence margin breached ({inside:.1f} m inside, "
                   f"{limits.geofence_margin_m:.0f} m required)")


def _nfz_finding(sample: EnvelopeSample, geometry: SiteGeometry,
                 limits: EnvelopeLimits) -> Optional[Finding]:
    buffer_m = max(float(geometry.nfz_buffer_m), float(limits.nfz_buffer_m))
    worst: Optional[Finding] = None
    for zone in geometry.nfz:
        if len(zone.polygon) < 3:
            continue
        # Overflight strictly above the ceiling is permitted (ADR D3).
        if math.isfinite(zone.ceiling_m) and sample.rel_alt_m > zone.ceiling_m:
            continue
        inside = signed_distance_inside_m((sample.lat, sample.lon), zone.polygon)
        if not math.isfinite(inside):
            continue
        clearance = -inside                       # positive = outside the zone
        margin = clearance - buffer_m
        if margin >= 0.0:
            finding = Finding("nfz", STATE_IN_ENVELOPE, "none", margin, "m",
                              f"{clearance:.1f} m clear of NFZ {zone.name!r}")
        else:
            finding = Finding("nfz", STATE_BREACH, "rtl", margin, "m",
                              f"NFZ {zone.name!r} buffer breached ({clearance:.1f} m clear, "
                              f"{buffer_m:.0f} m required)")
        if worst is None or finding.margin_m < worst.margin_m:
            worst = finding
    return worst


def _standoff_finding(sample: EnvelopeSample, limits: EnvelopeLimits) -> Optional[Finding]:
    standoff = float(sample.standoff_m)
    if not math.isfinite(standoff):
        return None                                # nothing observed this tick
    margin = standoff - limits.standoff_floor_m
    if margin >= 0.0:
        return Finding("standoff", STATE_IN_ENVELOPE, "none", margin, "m",
                       f"standoff {standoff:.1f} m")
    return Finding("standoff", STATE_BREACH, "hold", margin, "m",
                   f"standoff {standoff:.1f} m below the {limits.standoff_floor_m:.0f} m floor",
                   back_off_m=-margin)


def _sortie_finding(sample: EnvelopeSample) -> Optional[Finding]:
    cap = float(sample.sortie_cap_s)
    if not math.isfinite(cap) or cap <= 0.0:
        return None
    remaining = cap - float(sample.sortie_elapsed_s)
    if remaining > 0.0:
        return Finding("sortie", STATE_IN_ENVELOPE, "none", remaining, "s",
                       f"{remaining:.0f} s of sortie budget left")
    return Finding("sortie", STATE_BREACH, "rtl", remaining, "s", f"sortie cap {cap:.0f} s exhausted")


def _separation_finding(sample: EnvelopeSample, peer: Optional[PeerSample],
                        limits: EnvelopeLimits) -> Optional[Finding]:
    if peer is None or not peer.valid:
        return None
    required = required_separation_m(peer.age_s, limits)
    gap = distance_m(sample.lat, sample.lon, peer.lat, peer.lon)
    margin = (gap - required) if math.isfinite(gap) else -required
    if not _finite(peer.age_s) or peer.age_s > limits.peer_hold_s:
        # Past the hold threshold an unknown peer position stops the vehicle,
        # whatever the measured range says.
        return Finding("separation", STATE_BREACH, "hold", margin, "m",
                       f"peer {peer.vehicle_id or 'unknown'} data older than "
                       f"{limits.peer_hold_s:.0f} s")
    if margin >= 0.0:
        return Finding("separation", STATE_IN_ENVELOPE, "none", margin, "m",
                       f"{gap:.0f} m from peer ({required:.0f} m required)")
    return Finding("separation", STATE_BREACH, "hold", margin, "m",
                   f"{gap:.0f} m from peer {peer.vehicle_id or 'unknown'}; "
                   f"{required:.0f} m required")


def assess(sample: EnvelopeSample, *, corridor: Optional[Corridor] = None,
           geometry: Optional[SiteGeometry] = None, limits: Optional[EnvelopeLimits] = None,
           peer: Optional[PeerSample] = None) -> Tuple[Finding, ...]:
    """Evaluate every constraint against one sample. Stateless and total.

    Findings come back in ``CONSTRAINTS`` order; a constraint that does not
    apply this tick (no corridor, nothing observed, no peer) is simply absent.
    """
    corridor = corridor if corridor is not None else Corridor()
    geometry = geometry if geometry is not None else SiteGeometry()
    limits = limits if limits is not None else EnvelopeLimits()
    candidates = (
        _geofence_finding(sample, geometry, limits),
        _nfz_finding(sample, geometry, limits),
        _altitude_finding(sample, corridor),
        _corridor_finding(sample, corridor, limits),
        _standoff_finding(sample, limits),
        _separation_finding(sample, peer, limits),
        _sortie_finding(sample),
    )
    return tuple(finding for finding in candidates if finding is not None)


def worst_finding(findings: Sequence[Finding]) -> Optional[Finding]:
    """The most severe finding; ties break by smaller margin, then by
    ``CONSTRAINTS`` order — deterministic, so an audit entry is replayable."""
    worst: Optional[Finding] = None
    for finding in findings:
        if worst is None:
            worst = finding
            continue
        if finding.rank > worst.rank:
            worst = finding
        elif finding.rank == worst.rank and finding.margin_m < worst.margin_m:
            worst = finding
    return worst


def _speed_scale(action: str) -> float:
    if action == "none":
        return 1.0
    if action == "slow":
        return SLOW_SPEED_SCALE
    return 0.0


def _decision_from(finding: Optional[Finding]) -> EnvelopeDecision:
    if finding is None or finding.action == "none":
        state = finding.state if finding is not None else STATE_IN_ENVELOPE
        return EnvelopeDecision(
            state=STATE_IN_ENVELOPE if state == STATE_IN_ENVELOPE else state,
            constraint=(finding.constraint if finding is not None else "") if state != STATE_IN_ENVELOPE else "",
            margin_m=finding.margin_m if finding is not None else math.inf,
            margin_unit=finding.margin_unit if finding is not None else "m",
            action="none", base_action="none",
            detail=finding.detail if finding is not None else "",
            speed_scale=1.0,
        )
    return EnvelopeDecision(
        state=finding.state, constraint=finding.constraint, margin_m=finding.margin_m,
        margin_unit=finding.margin_unit, action=finding.action, base_action=finding.action,
        detail=finding.detail, back_off_m=finding.back_off_m,
        speed_scale=_speed_scale(finding.action),
    )


def evaluate(sample: EnvelopeSample, *, corridor: Optional[Corridor] = None,
             geometry: Optional[SiteGeometry] = None, limits: Optional[EnvelopeLimits] = None,
             peer: Optional[PeerSample] = None) -> EnvelopeDecision:
    """Stateless single-tick verdict (no hysteresis, no escalation timer)."""
    return _decision_from(worst_finding(assess(
        sample, corridor=corridor, geometry=geometry, limits=limits, peer=peer,
    )))


# ---------------------------------------------------------------------------
# The stateful monitor — hysteresis + the 5 s escalation dwell
# ---------------------------------------------------------------------------
class EnvelopeMonitor:
    """Stateful wrapper around :func:`assess`: hysteresis and escalation.

    One instance per vehicle — every rule here is per-vehicle by construction
    and the only cross-vehicle input is the :class:`PeerSample` (ADR D26).
    """

    def __init__(self, limits: Optional[EnvelopeLimits] = None, *,
                 corridor: Optional[Corridor] = None,
                 geometry: Optional[SiteGeometry] = None) -> None:
        self._limits = limits if limits is not None else EnvelopeLimits()
        self._corridor = corridor if corridor is not None else Corridor()
        self._geometry = geometry if geometry is not None else SiteGeometry()
        self._latched: Optional[Finding] = None
        self._latched_since_s: float = 0.0
        self._clear_since_s: Optional[float] = None
        self._escalated: bool = False
        self._last: EnvelopeDecision = _IN_ENVELOPE
        self._armed: bool = False

    @property
    def limits(self) -> EnvelopeLimits:
        return self._limits

    @property
    def corridor(self) -> Corridor:
        return self._corridor

    @property
    def geometry(self) -> SiteGeometry:
        return self._geometry

    @property
    def armed(self) -> bool:
        return self._armed

    @property
    def last(self) -> EnvelopeDecision:
        return self._last

    @property
    def latched(self) -> Optional[Finding]:
        return self._latched

    def set_geometry(self, geometry: SiteGeometry) -> None:
        self._geometry = geometry

    def arm(self, corridor: Corridor) -> None:
        """Install the certified corridor for a dispatched mission."""
        self._corridor = corridor
        self._armed = True
        self._clear_latch()

    def disarm(self) -> None:
        """Mission over: drop the corridor, keep the site geometry."""
        self._corridor = Corridor()
        self._armed = False
        self._clear_latch()

    def reset(self) -> None:
        self.disarm()

    def _clear_latch(self) -> None:
        self._latched = None
        self._latched_since_s = 0.0
        self._clear_since_s = None
        self._escalated = False
        self._last = _IN_ENVELOPE

    def update(self, sample: EnvelopeSample, *, peer: Optional[PeerSample] = None,
               suspended: bool = False) -> EnvelopeDecision:
        """Evaluate one 20 Hz sample and return the hysteretic decision.

        ``suspended`` marks the decision observe-and-log-only (a hands-on
        operator has taken manual control): the monitor keeps evaluating and
        latching so the audit trail is unbroken, and the orchestrator does not
        act on the request. Suspension never clears a latch.
        """
        findings = assess(sample, corridor=self._corridor, geometry=self._geometry,
                          limits=self._limits, peer=peer)
        raw = worst_finding(findings)
        now = float(sample.t_s)

        if raw is not None and raw.action != "none":
            if self._latched is None or raw.rank >= action_rank(self._latched.action):
                if self._latched is None or raw.rank > action_rank(self._latched.action):
                    self._latched_since_s = now
                    self._escalated = False
                self._latched = raw
                self._clear_since_s = None
            # A milder-but-nonzero raw finding leaves the latch alone: recovery
            # is only ever through the fully-inside hysteresis window below.
        elif self._latched is not None:
            recovered = raw is None or (
                raw.state == STATE_IN_ENVELOPE and
                (raw.margin_unit != "m" or raw.margin_m >= self._limits.hysteresis_m)
            )
            if recovered:
                if self._clear_since_s is None:
                    self._clear_since_s = now
                if now - self._clear_since_s >= self._limits.recovery_s:
                    self._clear_latch()
            else:
                self._clear_since_s = None

        decision = _decision_from(self._latched if self._latched is not None else raw)

        if self._latched is not None:
            held_s = max(0.0, now - self._latched_since_s)
            decision = replace(decision, breach_duration_s=held_s)
            if self._latched.state == STATE_BREACH and held_s >= self._limits.escalate_after_s:
                self._escalated = True
                decision = replace(
                    decision, action="escalate", base_action=self._latched.action,
                    detail=(f"{self._latched.detail} (persisted {held_s:.0f} s)"
                            if self._latched.detail else f"persisted {held_s:.0f} s"),
                )

        decision = replace(decision, suspended=bool(suspended))
        self._last = decision
        return decision


__all__ = [
    "ACTIONS", "CONSTRAINTS", "ENVELOPE_STATES", "LATERAL_TOL_INSPECT_M", "LATERAL_TOL_SURVEY_M",
    "ORBIT_RADIAL_TOL_M", "SLOW_SPEED_SCALE", "STATE_BREACH", "STATE_IN_ENVELOPE",
    "STATE_WARNING", "WIRE_ACTIONS", "Corridor", "CorridorLeg", "CorridorOrbit",
    "EnvelopeDecision", "EnvelopeLimits", "EnvelopeMonitor", "EnvelopeSample", "Finding",
    "MonitoredZone", "PeerSample", "SiteGeometry", "action_rank", "assess", "distance_m",
    "evaluate", "meters_per_degree", "point_in_polygon", "point_segment_distance_m",
    "required_separation_m", "signed_distance_inside_m", "to_local_m", "worse_action",
    "worst_finding",
]
