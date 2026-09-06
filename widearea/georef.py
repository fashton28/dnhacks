"""Normalised image boxes to Site geography.

An overhead capture is a north-up rectangle: the Renderer points the camera straight
down and reports the four corners it covered. That makes the pixel-to-ground mapping a
plain linear interpolation, which is why a model can return fractions of the image and
the Hub can still place the result on the map.

Shared by both wide-area detectors so a Gemini finding and a numpy blob are
georeferenced identically and their outputs are comparable.
"""
from __future__ import annotations

import math

from contracts.models import LatLon

# Corner order the Renderer reports, matching contracts.protocol.Overhead.footprint.
TOP_LEFT, TOP_RIGHT, BOTTOM_RIGHT, BOTTOM_LEFT = 0, 1, 2, 3


def bounds(footprint: list[list[float]]) -> tuple[float, float, float, float]:
    """(north_lat, south_lat, west_lon, east_lon) from the four reported corners."""
    lats = [c[0] for c in footprint]
    lons = [c[1] for c in footprint]
    return max(lats), min(lats), min(lons), max(lons)


def bbox_to_ring(bbox: dict[str, float], footprint: list[list[float]]) -> list[LatLon]:
    """A normalised box (0..1, origin top-left) becomes a four-point ring, clockwise from
    the north-west corner. The ring is open: the closing edge is implied."""
    north, south, west, east = bounds(footprint)

    def point(x: float, y: float) -> LatLon:
        return LatLon(lat=north - y * (north - south), lon=west + x * (east - west))

    x0 = min(max(0.0, bbox["x_min"]), 1.0)
    x1 = min(max(0.0, bbox["x_max"]), 1.0)
    y0 = min(max(0.0, bbox["y_min"]), 1.0)
    y1 = min(max(0.0, bbox["y_max"]), 1.0)
    return [point(x0, y0), point(x1, y0), point(x1, y1), point(x0, y1)]


def bbox_area_m2(bbox: dict[str, float], footprint: list[list[float]]) -> float:
    """Projected area of a normalised box. Local-flat approximation, exact enough at Site scale."""
    north, south, west, east = bounds(footprint)
    mid_lat = (north + south) / 2
    span_lat_m = abs(north - south) * 111_320
    span_lon_m = abs(east - west) * 111_320 * math.cos(math.radians(mid_lat))
    w = max(0.0, min(1.0, bbox["x_max"]) - max(0.0, bbox["x_min"]))
    h = max(0.0, min(1.0, bbox["y_max"]) - max(0.0, bbox["y_min"]))
    return round(w * span_lon_m * h * span_lat_m, 1)
