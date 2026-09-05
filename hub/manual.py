"""Manual Control: the Operator flies one Drone with velocity commands; the Safety Validator's limits still apply.

Until the safety workstream lands its `clamp` entry point, the Hub clamps against the Site limits here.
Both produce the same ClampEvent contract, so the swap is a one-line change.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import UTC, datetime

from shapely.geometry import Point

from contracts.models import ClampEvent, DroneState, ManualCommand, VelocityNED
from contracts.site import enu_to_latlon, latlon_to_enu
from sim.common.site_limits import SiteLimits

LOOKAHEAD_S = 1.5  # a command is clamped if it would leave the fence within this many seconds


@dataclass
class ManualSession:
    drone_id: str
    mission_id: str | None  # paused Mission, if any
    started_at: datetime


class ManualControl:
    def __init__(self, limits: SiteLimits | None = None):
        self.limits = limits or SiteLimits.load()
        self.sessions: dict[str, ManualSession] = {}

    def clamp(self, cmd: ManualCommand, state: DroneState) -> tuple[ManualCommand, ClampEvent | None]:
        """Return the command to forward and a ClampEvent if any rule changed it."""
        vx, vy, vz = cmd.velocity_ned.vx, cmd.velocity_ned.vy, cmd.velocity_ned.vz
        rules: list[str] = []
        x, y = latlon_to_enu(state.lat, state.lon)
        # geofence: predict where this velocity puts the Drone and stop the outward component
        nx, ny = x + vy * LOOKAHEAD_S, y + vx * LOOKAHEAD_S  # NED vx north -> y, vy east -> x
        if not self.limits.inside(nx, ny):
            # keep only the component that moves back toward the fence interior (toward the nearest inside point)
            cx, cy, _ = self.limits.clamp_point(x, y)
            ix, iy = (cx - x, cy - y) if not self.limits.inside(x, y) else self._inward(x, y)
            n = math.hypot(ix, iy)
            if n > 1e-6:
                ix, iy = ix / n, iy / n
                out = -(vy * ix + vx * iy)  # outward speed (positive = leaving)
                if out > 0:
                    vy += out * ix
                    vx += out * iy
            else:
                vx = vy = 0.0
            rules.append("geofence")
        # altitude ceiling and floor (vz positive = down)
        if state.alt >= self.limits.alt_ceiling_m - 0.5 and vz < 0:
            vz = 0.0
            rules.append("altitude_ceiling")
        if state.alt + vz * LOOKAHEAD_S > self.limits.alt_ceiling_m and vz < 0:
            vz = max(vz, -(self.limits.alt_ceiling_m - state.alt) / LOOKAHEAD_S)
            if "altitude_ceiling" not in rules:
                rules.append("altitude_ceiling")
        if state.alt <= self.limits.alt_floor_m and vz > 0 and state.alt > 0.5:
            vz = 0.0
            rules.append("altitude_floor")
        clamped = cmd.model_copy(update={"velocity_ned": VelocityNED(vx=round(vx, 3), vy=round(vy, 3), vz=round(vz, 3))})
        if not rules:
            return cmd, None
        return clamped, ClampEvent(drone_id=cmd.drone_id, original=cmd, clamped=clamped, rule="+".join(rules))

    def _inward(self, x: float, y: float) -> tuple[float, float]:
        """Unit-ish vector from the nearest fence point back toward the interior."""
        ring = self.limits.geofence_enu.exterior
        p = ring.interpolate(ring.project(Point(x, y)))
        return x - p.x, y - p.y

    def begin(self, drone_id: str, mission_id: str | None) -> ManualSession:
        s = ManualSession(drone_id, mission_id, datetime.now(UTC))
        self.sessions[drone_id] = s
        return s

    def end(self, drone_id: str) -> ManualSession | None:
        return self.sessions.pop(drone_id, None)


def preview_latlon(state: DroneState, cmd: ManualCommand, seconds: float) -> tuple[float, float]:
    x, y = latlon_to_enu(state.lat, state.lon)
    return enu_to_latlon(x + cmd.velocity_ned.vy * seconds, y + cmd.velocity_ned.vx * seconds)
