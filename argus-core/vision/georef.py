"""Map a normalised image bounding box to a simulator-provided geo rectangle.

This deliberately does not guess coordinates: the simulator supplies the image
footprint in `frame_meta`. For a non-rectangular or tilted camera, replace this
simple mapping with the simulator's camera projection later.
"""
from __future__ import annotations

from typing import Any


def bbox_to_polygon(bbox: dict[str, float], frame_meta: dict[str, Any]) -> list[list[float]]:
    """Return [lat, lon] corners for a north-up rectangular overhead frame."""
    bounds = frame_meta["geo_bounds"]
    north, south = float(bounds["north_lat"]), float(bounds["south_lat"])
    west, east = float(bounds["west_lon"]), float(bounds["east_lon"])

    def point(x: float, y: float) -> list[float]:
        return [north - y * (north - south), west + x * (east - west)]

    return [
        point(bbox["x_min"], bbox["y_min"]), point(bbox["x_max"], bbox["y_min"]),
        point(bbox["x_max"], bbox["y_max"]), point(bbox["x_min"], bbox["y_max"]),
    ]
