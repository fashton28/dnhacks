"""
============================================================================
Drone Safety Platform -- GIMBAL POINTING (pure logic)
----------------------------------------------------------------------------
Where the camera looks, and nothing else. Two halves:

  * a hard clamp + slew-rate limiter on commanded pitch. -30 deg looks UP,
    0 is level, +90 is straight DOWN -- the same convention the contract
    (``GIMBAL_PITCH_MIN_DEG`` / ``GIMBAL_PITCH_MAX_DEG``) and the ARGUS
    console report. The clamp is a hard bound: config may narrow it, nothing
    may widen it (``config.py`` re-asserts the -30..90 envelope after load).

  * deterministic auto-pointing for orbit / observation legs:
    ``pitch = asin(altitude / slant_range)`` -- pure trigonometry from two
    measured numbers. There is no model, no heuristic, and no LLM anywhere on
    this path; the same geometry always produces the same angle, which is what
    makes a recorded observation replayable.

An operator ``setGimbal`` overrides auto-pointing until the next leg begins;
``clear_override()`` is what "next leg" means to this module. The override is
clamped like everything else -- a signed command still cannot point the camera
outside the mechanical envelope.

Pure stdlib (math). No MAVLink here: ``mavlink/vehicle.py`` turns the angle
this module produces into MAV_CMD_DO_MOUNT_CONTROL.
============================================================================
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

#: Contract-wide mechanical bounds (shared/shared.py GIMBAL_PITCH_*_DEG).
#: -30 looks up, 0 is level, +90 is straight down.
GIMBAL_PITCH_MIN_DEG = -30.0
GIMBAL_PITCH_MAX_DEG = 90.0

#: Default slew rate. Slow enough that a step command does not smear a frame,
#: fast enough to re-point across the band inside a single orbit leg.
DEFAULT_SLEW_RATE_DPS = 30.0

#: Pitch used while no leg asks for anything in particular.
DEFAULT_STOW_PITCH_DEG = 0.0


@dataclass(frozen=True)
class GimbalLimits:
    """The pointing envelope. ``config.py`` may only tighten these."""
    min_pitch_deg: float = GIMBAL_PITCH_MIN_DEG
    max_pitch_deg: float = GIMBAL_PITCH_MAX_DEG
    slew_rate_dps: float = DEFAULT_SLEW_RATE_DPS

    def clamp(self, pitch_deg: float) -> float:
        """Clamp a pitch into the envelope; a non-finite input reads as level."""
        try:
            value = float(pitch_deg)
        except (TypeError, ValueError):
            return clamp_pitch(DEFAULT_STOW_PITCH_DEG, self)
        if not math.isfinite(value):
            return clamp_pitch(DEFAULT_STOW_PITCH_DEG, self)
        return clamp_pitch(value, self)


def clamp_pitch(pitch_deg: float, limits: Optional[GimbalLimits] = None) -> float:
    """Clamp ``pitch_deg`` into [min, max], never outside the -30..90 envelope."""
    lo = GIMBAL_PITCH_MIN_DEG
    hi = GIMBAL_PITCH_MAX_DEG
    if limits is not None:
        lo = max(lo, float(limits.min_pitch_deg))
        hi = min(hi, float(limits.max_pitch_deg))
    if lo > hi:
        lo, hi = hi, lo
    try:
        value = float(pitch_deg)
    except (TypeError, ValueError):
        return max(lo, min(hi, DEFAULT_STOW_PITCH_DEG))
    if not math.isfinite(value):
        return max(lo, min(hi, DEFAULT_STOW_PITCH_DEG))
    return max(lo, min(hi, value))


def slew(
    current_deg: float,
    target_deg: float,
    dt_s: float,
    limits: Optional[GimbalLimits] = None,
) -> float:
    """Move ``current`` toward ``target`` by at most ``slew_rate * dt`` degrees.

    Both ends are clamped, so a rate-limited approach can never walk out of
    the envelope even if the target was somehow outside it.
    """
    lim = limits if limits is not None else GimbalLimits()
    current = clamp_pitch(current_deg, lim)
    target = clamp_pitch(target_deg, lim)
    try:
        dt = max(0.0, float(dt_s))
    except (TypeError, ValueError):
        dt = 0.0
    if not math.isfinite(dt):
        dt = 0.0
    rate = max(0.0, float(lim.slew_rate_dps))
    step = rate * dt
    delta = target - current
    if delta == 0.0:
        return target
    if step <= 0.0:
        return current              # no time / no rate: the mount cannot move
    if abs(delta) <= step:
        return target
    return clamp_pitch(current + math.copysign(step, delta), lim)


def auto_pitch_from_slant_deg(
    slant_range_m: float,
    altitude_agl_m: float,
    limits: Optional[GimbalLimits] = None,
) -> float:
    """Depression angle to a target at ``slant_range`` and ``altitude`` below.

    ``pitch = asin(altitude / slant_range)`` -- pure geometry. A slant range
    shorter than the altitude is physically impossible (the target would be
    directly beneath and closer than straight down), so it saturates at 90 deg
    rather than raising. Missing or nonsensical inputs return the stow angle,
    never an arbitrary one.
    """
    try:
        slant = float(slant_range_m)
        alt = float(altitude_agl_m)
    except (TypeError, ValueError):
        return clamp_pitch(DEFAULT_STOW_PITCH_DEG, limits)
    if not (math.isfinite(slant) and math.isfinite(alt)) or slant <= 0.0:
        return clamp_pitch(DEFAULT_STOW_PITCH_DEG, limits)
    ratio = max(-1.0, min(1.0, alt / slant))
    return clamp_pitch(math.degrees(math.asin(ratio)), limits)


def auto_pitch_from_ground_deg(
    ground_distance_m: float,
    altitude_agl_m: float,
    limits: Optional[GimbalLimits] = None,
) -> float:
    """Depression angle from horizontal ground distance and altitude.

    The orbit form: on a ring of radius R at altitude h the anomaly sits at
    the centre, so ``pitch = atan2(h, R)``. Zero ground distance is straight
    down.
    """
    try:
        ground = float(ground_distance_m)
        alt = float(altitude_agl_m)
    except (TypeError, ValueError):
        return clamp_pitch(DEFAULT_STOW_PITCH_DEG, limits)
    if not (math.isfinite(ground) and math.isfinite(alt)):
        return clamp_pitch(DEFAULT_STOW_PITCH_DEG, limits)
    if alt <= 0.0 and ground <= 0.0:
        return clamp_pitch(DEFAULT_STOW_PITCH_DEG, limits)
    return clamp_pitch(math.degrees(math.atan2(max(0.0, alt), max(0.0, ground))), limits)


def slant_range_m(ground_distance_m: float, altitude_agl_m: float) -> float:
    """Slant range from horizontal distance and altitude (Pythagoras)."""
    try:
        ground = float(ground_distance_m)
        alt = float(altitude_agl_m)
    except (TypeError, ValueError):
        return math.inf
    if not (math.isfinite(ground) and math.isfinite(alt)):
        return math.inf
    return math.hypot(ground, alt)


class GimbalController:
    """Commanded pitch over time: auto-pointing, operator override, slew limit.

    State is one angle plus one override. ``update`` is called from the
    orchestrator's control tick; it never talks to MAVLink and never reads
    config -- both are the caller's job.
    """

    def __init__(
        self,
        limits: Optional[GimbalLimits] = None,
        *,
        initial_pitch_deg: float = DEFAULT_STOW_PITCH_DEG,
    ) -> None:
        self._limits = limits if limits is not None else GimbalLimits()
        self._commanded = clamp_pitch(initial_pitch_deg, self._limits)
        self._override: Optional[float] = None
        self._auto_target: Optional[float] = None

    # ---- observation -----------------------------------------------------
    @property
    def limits(self) -> GimbalLimits:
        return self._limits

    @property
    def commanded_pitch_deg(self) -> float:
        """The angle last emitted toward the mount."""
        return self._commanded

    @property
    def override_active(self) -> bool:
        return self._override is not None

    @property
    def override_pitch_deg(self) -> Optional[float]:
        return self._override

    @property
    def target_pitch_deg(self) -> float:
        """Where the controller is heading right now (override beats auto)."""
        if self._override is not None:
            return self._override
        if self._auto_target is not None:
            return self._auto_target
        return self._commanded

    # ---- inputs ----------------------------------------------------------
    def set_override(self, pitch_deg: float) -> float:
        """Operator ``setGimbal``: hold this angle until the next leg begins."""
        self._override = clamp_pitch(pitch_deg, self._limits)
        return self._override

    def clear_override(self) -> None:
        """A new leg started: auto-pointing resumes."""
        self._override = None

    def set_auto_target(self, pitch_deg: Optional[float]) -> None:
        """Install the deterministic auto-pointing target for the active leg."""
        if pitch_deg is None:
            self._auto_target = None
            return
        self._auto_target = clamp_pitch(pitch_deg, self._limits)

    def point_at(
        self,
        *,
        ground_distance_m: float,
        altitude_agl_m: float,
    ) -> float:
        """Auto-point at an anomaly from its ground distance and our altitude."""
        target = auto_pitch_from_slant_deg(
            slant_range_m(ground_distance_m, altitude_agl_m),
            altitude_agl_m,
            self._limits,
        )
        self.set_auto_target(target)
        return target

    def reset(self, pitch_deg: float = DEFAULT_STOW_PITCH_DEG) -> None:
        """Drop the override and the auto target; stow."""
        self._override = None
        self._auto_target = None
        self._commanded = clamp_pitch(pitch_deg, self._limits)

    # ---- the tick --------------------------------------------------------
    def update(self, dt_s: float) -> float:
        """Advance the commanded angle one tick and return it (degrees)."""
        self._commanded = slew(
            self._commanded, self.target_pitch_deg, dt_s, self._limits
        )
        return self._commanded


__all__ = [
    "DEFAULT_SLEW_RATE_DPS",
    "DEFAULT_STOW_PITCH_DEG",
    "GIMBAL_PITCH_MAX_DEG",
    "GIMBAL_PITCH_MIN_DEG",
    "GimbalController",
    "GimbalLimits",
    "auto_pitch_from_ground_deg",
    "auto_pitch_from_slant_deg",
    "clamp_pitch",
    "slant_range_m",
    "slew",
]
