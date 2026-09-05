"""Hard limits every Drone enforces on its own, loaded from the generated site.geojson."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from shapely.geometry import Point, Polygon

from contracts.site import latlon_to_enu

SITE_GEOJSON = Path(__file__).resolve().parent.parent / "site" / "site.geojson"


@dataclass
class NoFlyZone:
    """A named exclusion. `ceiling_m` is None when the zone is closed at every altitude."""

    name: str
    polygon_enu: Polygon
    ceiling_m: float | None = None


@dataclass
class SiteLimits:
    geofence_enu: Polygon
    alt_ceiling_m: float
    alt_floor_m: float
    no_fly: list[NoFlyZone] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path = SITE_GEOJSON) -> "SiteLimits":
        g = json.loads(path.read_text())
        fence = next(f for f in g["features"] if f["properties"]["kind"] == "geofence")
        ring = [latlon_to_enu(lat, lon) for lon, lat in fence["geometry"]["coordinates"][0]]
        zones = [
            NoFlyZone(
                name=str(f["properties"].get("name", "no_fly")),
                polygon_enu=Polygon([latlon_to_enu(lat, lon) for lon, lat in f["geometry"]["coordinates"][0]]),
                ceiling_m=(float(c) if (c := f["properties"].get("ceiling_m")) is not None else None),
            )
            for f in g["features"]
            if f["properties"].get("kind") == "no_fly_zone"
        ]
        return cls(Polygon(ring), float(fence["properties"]["alt_ceiling_m"]), float(fence["properties"]["alt_floor_m"]), zones)

    def inside(self, x: float, y: float) -> bool:
        return self.geofence_enu.covers(Point(x, y))

    def clamp_point(self, x: float, y: float) -> tuple[float, float, bool]:
        """Nearest point inside the geofence (pulled 1 m in). Returns (x, y, was_clamped)."""
        if self.inside(x, y):
            return x, y, False
        inner = self.geofence_enu.buffer(-1.0)
        p = inner.exterior.interpolate(inner.exterior.project(Point(x, y)))
        return p.x, p.y, True

    def clamp_alt(self, alt: float) -> tuple[float, bool]:
        c = min(alt, self.alt_ceiling_m)
        return c, c != alt


def load_geofence_ring(path: Path = SITE_GEOJSON) -> list[tuple[float, float]]:
    """The Site geofence as (lat, lon) vertices without the closing repeat, for the onboard polygon fence."""
    g = json.loads(path.read_text())
    fence = next(f for f in g["features"] if f["properties"]["kind"] == "geofence")
    coords = fence["geometry"]["coordinates"][0]
    if coords[0] == coords[-1]:
        coords = coords[:-1]
    return [(lat, lon) for lon, lat in coords]
