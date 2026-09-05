"""Site anchor and local frame helpers.

The Site (Meridian Station, fictional) is anchored at a real rural location so all geodesic math is real.
Webots uses an ENU world frame (x east, y north, z up) with its origin at this anchor.
"""
from __future__ import annotations

import math

SITE_NAME = "Meridian Station"
ORIGIN_LAT = 41.2000
ORIGIN_LON = -98.4000

_R = 6378137.0  # WGS84 equatorial radius, metres


def enu_to_latlon(x: float, y: float) -> tuple[float, float]:
    """Local east/north metres from the anchor to latitude/longitude (flat-earth, fine for a 300 m Site)."""
    lat = ORIGIN_LAT + math.degrees(y / _R)
    lon = ORIGIN_LON + math.degrees(x / (_R * math.cos(math.radians(ORIGIN_LAT))))
    return lat, lon


def latlon_to_enu(lat: float, lon: float) -> tuple[float, float]:
    y = math.radians(lat - ORIGIN_LAT) * _R
    x = math.radians(lon - ORIGIN_LON) * _R * math.cos(math.radians(ORIGIN_LAT))
    return x, y


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    x1, y1 = latlon_to_enu(lat1, lon1)
    x2, y2 = latlon_to_enu(lat2, lon2)
    return math.hypot(x2 - x1, y2 - y1)
