"""
rails/scripted — the ``EIS_TEST_BAD_PLAN`` rail, and nothing else.

Reference of ``platform/ground/planner/src/scripted.ts``.

READ THIS BEFORE USING IT. ``ScriptedPlanner`` is NOT a plan source. The
deterministic planner (:mod:`rails.deterministic`) is the only source of flight
plans — ADR D20 — and this class survives for exactly one purpose: the
``EIS_TEST_BAD_PLAN`` demo rail, where a deliberately invalid plan is injected
so an audience can watch the trust layer bounce it. Nothing on the demo or test
flight path may call :meth:`ScriptedPlanner.passing_plan` as a planner.

All coordinates are DERIVED from the loaded site model and the anomaly, so a
different site JSON produces different plans; nothing is hardcoded.
"""
from __future__ import annotations

from .geometry import Point, haversine_meters, polygon_centroid
from .schemas import Anomaly, MissionPlan
from .site import SiteModel

#: Orbit radius used by the passing plan, metres (well above the 3 m floor).
ORBIT_RADIUS_M = 25.0
#: The scripted plan uses the inspect/standard profile, capped at 45 m AGL.
SCRIPTED_PROFILE_MAX_ALT_M = 45.0
#: How far above the alt band's max the failing plan flies, metres.
FAILING_ALT_OVERSHOOT_M = 10.0
#: How far below the alt band's min the failing plan flies when the first NFZ's
#: ceiling sits inside the band (so an above-band altitude could not also
#: violate the NFZ), metres.
FAILING_ALT_UNDERSHOOT_M = 5.0


def orbit_approach_point(home: Point, center: Point, radius_m: float) -> Point:
    """Point on the observation ring facing home, so approach never breaches standoff."""
    distance = haversine_meters(home, center)
    if distance < 0.01:
        return (center[0] + radius_m / 111_320.0, center[1])
    scale = radius_m / distance
    return (center[0] + (home[0] - center[0]) * scale,
            center[1] + (home[1] - center[1]) * scale)


class ScriptedPlanner:
    """The EIS_TEST_BAD_PLAN rail. Never a plan source on a flight path."""

    def plan(self, site: SiteModel, anomaly: Anomaly, *, failing: bool = False) -> MissionPlan:
        return self.failing_plan(site, anomaly) if failing else self.passing_plan(site, anomaly)

    def passing_plan(self, site: SiteModel, anomaly: Anomaly) -> MissionPlan:
        """A plan the verifier should PASS, for the demo's "before" frame."""
        mid_alt = min((site.altBandMin + site.altBandMax) / 2.0, SCRIPTED_PROFILE_MAX_ALT_M)
        home: Point = (site.home.lat, site.home.lon)
        approach = orbit_approach_point(home, (anomaly.lat, anomaly.lon), ORBIT_RADIUS_M)
        return MissionPlan(
            requestId=f"scripted-{anomaly.id}",
            anomalyId=anomaly.id,
            profile="standard",
            rationale=(
                f"Scripted survey of anomaly {anomaly.id} ({anomaly.type}, confidence "
                f"{anomaly.confidence}): fly to the flagged location at mid-band altitude "
                f"{mid_alt} m AGL, orbit at {ORBIT_RADIUS_M} m for observation, then return to launch."
            ),
            tools=[
                {"tool": "goto_gps", "lat": approach[0], "lon": approach[1],
                 "alt": mid_alt, "profile": "standard"},
                {"tool": "orbit_point", "lat": anomaly.lat, "lon": anomaly.lon,
                 "radius": ORBIT_RADIUS_M},
                {"tool": "rtl"},
            ],
        )

    def failing_plan(self, site: SiteModel, anomaly: Anomaly) -> MissionPlan:
        """The deliberately invalid plan: into an NFZ, outside the altitude band.

        Fails BOTH the nfz and the altitude check. The altitude is derived from
        the site: preferably above the band but still at/below the NFZ ceiling;
        when the ceiling is not above the band max (so an above-band altitude
        could never be inside the NFZ), below the band instead.
        """
        if not site.nfz:
            raise ValueError("ScriptedPlanner.failing_plan: site has no NFZs to violate")
        zone = site.nfz[0]
        target = polygon_centroid(zone.polygon)
        if zone.ceilingM > site.altBandMax:
            alt = min(zone.ceilingM, site.altBandMax + FAILING_ALT_OVERSHOOT_M)
        else:
            alt = min(zone.ceilingM, max(1.0, site.altBandMin - FAILING_ALT_UNDERSHOOT_M))
        return MissionPlan(
            requestId=f"scripted-failing-{anomaly.id}",
            anomalyId=anomaly.id,
            profile="standard",
            rationale=(
                f"Deliberately invalid demo plan for anomaly {anomaly.id}: flies into NFZ "
                f'"{zone.name}" at {alt} m AGL, which is both inside the no-fly ceiling '
                f"({zone.ceilingM} m) and outside the site alt band "
                f"[{site.altBandMin}, {site.altBandMax}] m. The MissionVerifier must flag it."
            ),
            tools=[
                {"tool": "goto_gps", "lat": target[0], "lon": target[1],
                 "alt": alt, "profile": "standard"},
                {"tool": "rtl"},
            ],
        )


__all__ = [
    "FAILING_ALT_OVERSHOOT_M", "FAILING_ALT_UNDERSHOOT_M", "ORBIT_RADIUS_M",
    "SCRIPTED_PROFILE_MAX_ALT_M", "ScriptedPlanner", "orbit_approach_point",
]
