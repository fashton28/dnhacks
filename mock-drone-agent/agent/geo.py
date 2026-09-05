"""Geometry helpers. Deliberately dependency-free so the verifier can run anywhere.

Every coordinate in this project is (lat, lon) in WGS84 decimal degrees, in that
order. Do not mix in (lon, lat) — that ordering bug has grounded real aircraft.
"""

from __future__ import annotations

import math
from typing import Iterable, Sequence

EARTH_RADIUS_M = 6_371_008.8

LatLon = Sequence[float]  # (lat, lon)


def haversine_m(a: LatLon, b: LatLon) -> float:
    """Great-circle distance in metres between two (lat, lon) points."""
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def point_in_polygon(point: LatLon, polygon: Sequence[LatLon]) -> bool:
    """Ray-casting test. Planar approximation — fine at facility scale (< a few km).

    Points exactly on an edge are not guaranteed either way; the verifier treats
    the geofence as a hard boundary and plans should stay well inside it.
    """
    lat, lon = point[0], point[1]
    inside = False
    n = len(polygon)
    for i in range(n):
        lat_i, lon_i = polygon[i][0], polygon[i][1]
        lat_j, lon_j = polygon[(i - 1) % n][0], polygon[(i - 1) % n][1]
        straddles = (lat_i > lat) != (lat_j > lat)
        if straddles:
            lon_at_lat = (lon_j - lon_i) * (lat - lat_i) / (lat_j - lat_i) + lon_i
            if lon < lon_at_lat:
                inside = not inside
    return inside


def polygon_centroid(polygon: Sequence[LatLon]) -> tuple[float, float]:
    return (
        sum(p[0] for p in polygon) / len(polygon),
        sum(p[1] for p in polygon) / len(polygon),
    )


def path_length_m(points: Iterable[LatLon]) -> float:
    """Total horizontal length of a path through the given points."""
    pts = list(points)
    return sum(haversine_m(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def offset_m(origin: LatLon, north_m: float, east_m: float) -> tuple[float, float]:
    """Return the (lat, lon) that is `north_m` / `east_m` metres from `origin`."""
    lat = origin[0] + (north_m / EARTH_RADIUS_M) * (180 / math.pi)
    lon = origin[1] + (east_m / (EARTH_RADIUS_M * math.cos(math.radians(origin[0])))) * (
        180 / math.pi
    )
    return (lat, lon)


def bearing_deg(a: LatLon, b: LatLon) -> float:
    """Initial bearing from a to b, degrees clockwise from north."""
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlon = math.radians(b[1] - a[1])
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360) % 360
