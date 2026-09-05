"""Battery depletion shared by the fake Drone and the Webots flight controller.

Depletion is a function of time in flight and speed.
Numbers are tuned so a full charge gives roughly 25 minutes of hover or 15 minutes at cruise, which is Mavic-like.
"""
from __future__ import annotations

HOVER_PCT_PER_S = 100.0 / (25 * 60)
CRUISE_EXTRA_PCT_PER_S_AT_MAX = 100.0 / (15 * 60) - HOVER_PCT_PER_S
MAX_SPEED_MPS = 10.0
RESERVE_PCT = 20.0


class Battery:
    def __init__(self, pct: float = 100.0):
        self.pct = pct

    def step(self, dt: float, speed_mps: float, airborne: bool) -> float:
        if airborne and dt > 0:
            frac = min(abs(speed_mps) / MAX_SPEED_MPS, 1.0)
            self.pct = max(0.0, self.pct - dt * (HOVER_PCT_PER_S + CRUISE_EXTRA_PCT_PER_S_AT_MAX * frac))
        return self.pct

    @property
    def below_reserve(self) -> bool:
        return self.pct < RESERVE_PCT


def estimate_pct(duration_s: float, avg_speed_mps: float) -> float:
    frac = min(abs(avg_speed_mps) / MAX_SPEED_MPS, 1.0)
    return duration_s * (HOVER_PCT_PER_S + CRUISE_EXTRA_PCT_PER_S_AT_MAX * frac)
