"""Frame conversions shared by controllers: ENU world <-> lat/lon, NED <-> ENU, yaw <-> compass heading."""
from __future__ import annotations

import math

from contracts.site import enu_to_latlon, latlon_to_enu  # noqa: F401  (re-exported)


def ned_to_enu(vx_n: float, vy_e: float, vz_d: float) -> tuple[float, float, float]:
    return vy_e, vx_n, -vz_d


def enu_to_ned(ve: float, vn: float, vu: float) -> tuple[float, float, float]:
    return vn, ve, -vu


def yaw_to_heading(yaw_rad: float) -> float:
    """ENU yaw (0 = +x east, counter-clockwise positive) to compass heading in degrees (0 = north, clockwise)."""
    return (90.0 - math.degrees(yaw_rad)) % 360.0


def heading_to_yaw(heading_deg: float) -> float:
    return math.radians(90.0 - heading_deg)


def wrap_pi(a: float) -> float:
    return (a + math.pi) % (2 * math.pi) - math.pi
