"""Facility definition: where the drone may fly and what it must not do.

This is the ground truth the verification layer checks plans against. It is plain
data on purpose — a judge can read `config/facility_riverbend.json` and audit
every rule the system enforces.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "config" / "facility_riverbend.json"


@dataclass(frozen=True)
class NoFlyZone:
    id: str
    description: str
    center: tuple[float, float]  # (lat, lon)
    radius_m: float


@dataclass(frozen=True)
class Limits:
    min_alt_m: float
    max_alt_m: float
    max_waypoints: int
    max_hover_s: float
    max_mission_range_m: float
    max_leg_m: float
    min_battery_reserve_pct: float
    cruise_speed_mps: float
    battery_drain_pct_per_min: float
    anomaly_proximity_m: float


@dataclass(frozen=True)
class Facility:
    facility_id: str
    name: str
    base: tuple[float, float]  # (lat, lon)
    geofence: tuple[tuple[float, float], ...]
    no_fly_zones: tuple[NoFlyZone, ...]
    limits: Limits
    raw: dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def load(cls, path: str | Path | None = None) -> "Facility":
        path = Path(path) if path else DEFAULT_CONFIG
        data = json.loads(path.read_text())
        return cls(
            facility_id=data["facility_id"],
            name=data["name"],
            base=(data["base"]["lat"], data["base"]["lon"]),
            geofence=tuple((p[0], p[1]) for p in data["geofence"]),
            no_fly_zones=tuple(
                NoFlyZone(
                    id=z["id"],
                    description=z["description"],
                    center=(z["center"]["lat"], z["center"]["lon"]),
                    radius_m=z["radius_m"],
                )
                for z in data.get("no_fly_zones", [])
            ),
            limits=Limits(**data["limits"]),
            raw=data,
        )

    def prompt_brief(self) -> str:
        """The facility described for the planner's prompt.

        Kept byte-stable for a given config file so it can be prompt-cached.
        """
        lim = self.limits
        fence = "\n".join(f"  - ({lat:.6f}, {lon:.6f})" for lat, lon in self.geofence)
        nfz = (
            "\n".join(
                f"  - {z.id}: circle of radius {z.radius_m:.0f} m centred on "
                f"({z.center[0]:.6f}, {z.center[1]:.6f}) — {z.description}"
                for z in self.no_fly_zones
            )
            or "  - none"
        )
        return (
            f"FACILITY: {self.name} (id: {self.facility_id})\n"
            f"LAUNCH/RECOVERY BASE: ({self.base[0]:.6f}, {self.base[1]:.6f})\n"
            f"GEOFENCE (closed polygon, lat/lon vertices — every waypoint must be strictly inside):\n"
            f"{fence}\n"
            f"NO-FLY ZONES (never place a waypoint inside, and never route a leg through one):\n"
            f"{nfz}\n"
            f"HARD LIMITS:\n"
            f"  - altitude: {lim.min_alt_m:.0f}–{lim.max_alt_m:.0f} m AGL\n"
            f"  - at most {lim.max_waypoints} waypoints\n"
            f"  - at most {lim.max_hover_s:.0f} s per hover\n"
            f"  - total path (base -> waypoints -> base) at most {lim.max_mission_range_m:.0f} m\n"
            f"  - no single leg longer than {lim.max_leg_m:.0f} m\n"
            f"  - must land with at least {lim.min_battery_reserve_pct:.0f}% battery in reserve\n"
            f"AIRFRAME: cruise {lim.cruise_speed_mps:.0f} m/s, "
            f"battery drain {lim.battery_drain_pct_per_min:.1f}%/min of flight time\n"
            f"MISSION EFFECTIVENESS: at least one hover waypoint must be within "
            f"{lim.anomaly_proximity_m:.0f} m of the reported anomaly, or the mission "
            f"observes nothing useful."
        )
