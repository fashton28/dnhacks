"""
Visual-servoing guidance: the locked target's box becomes a BODY-frame
velocity setpoint.

Geometry
--------
The box centre is measured as an error vector from the frame centre,
``e = (cx - 0.5, cy - 0.5)`` with a small circular deadzone per component:

  * ``e.x`` -> yaw_rate     target right of centre -> turn right (clockwise, +)
  * ``e.y`` -> vz           target above centre    -> climb (NED up, vz < 0)
  * ``d - standoff`` -> vx  farther than standoff  -> approach (vx > 0)

Each channel is a PID. The three channel outputs are assembled into one
setpoint vector ``[vx, vy, vz, yaw_rate]`` and pushed through a fixed stage
pipeline whose order is the safety argument:

    servo -> clamp -> standoff gate -> smooth -> standoff gate -> clamp

Every axis is clamped to ``Limits`` before AND after the low-pass, and the
standoff gate is applied to the raw and to the emitted vx, so neither the PID
maths nor the smoothing memory can leak a forward command past the floor.

HARD STANDOFF (PRD 11, non-negotiable)
--------------------------------------
``limits.standoff`` is a hard limit. Positive vx is permitted only when a
usable (finite) distance strictly exceeds it:
  * distance unknown (None) or non-finite -> vx <= 0 (never approach)
  * distance <= standoff                  -> vx <= 0 (hold / back off)
Backing off is always allowed -- moving away cannot breach the floor.

Not locked, or no box -> ``VelocitySetpoint.hold()`` (zero, valid=False) and
all channel memory is cleared, so a re-lock starts from rest.

numpy + stdlib only.
"""
from __future__ import annotations

import math
from typing import Dict, Optional, Tuple

import numpy as np

from ..types import Limits, TrackingState, VelocitySetpoint
from .pid import PID

# Setpoint vector layout -- the order of VelocitySetpoint's numeric fields.
_VX, _VY, _VZ, _YAW = 0, 1, 2, 3
_AXES = 4


def _finite_or_none(value) -> Optional[float]:
    """float(value) when finite, else None ("no measurement")."""
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _axis_bounds(limits: Limits) -> np.ndarray:
    """|bound| per setpoint axis; a non-finite limit contributes zero authority."""
    raw = np.array(
        [limits.max_speed, limits.max_speed, limits.max_climb_rate, limits.max_yaw_rate],
        dtype=float,
    )
    return np.where(np.isfinite(raw), np.abs(raw), 0.0)


def _clamp_vector(vector: np.ndarray, bounds: np.ndarray) -> np.ndarray:
    """Clamp each axis to [-bound, +bound]; a non-finite axis becomes 0.0.

    ``np.clip`` propagates NaN and Python's ``min`` would pick the bound, so
    the finiteness test comes first (FM-06).
    """
    safe = np.where(np.isfinite(vector), vector, 0.0)
    return np.clip(safe, -bounds, bounds)


def _standoff_gate(vx: float, distance: Optional[float], standoff: float) -> float:
    """The hard floor: forward motion only beyond a usable distance."""
    if distance is not None and distance > standoff:
        return vx
    return min(vx, 0.0)


def _centroid_error(bbox: Tuple[float, float, float, float], deadzone: float) -> np.ndarray:
    """(cx - 0.5, cy - 0.5) with components inside the deadzone zeroed."""
    x, y, w, h = (float(v) for v in bbox)
    error = np.array([x + 0.5 * w - 0.5, y + 0.5 * h - 0.5])
    return np.where(np.abs(error) < deadzone, 0.0, error)


def _as_state_name(tracking_state) -> str:
    if isinstance(tracking_state, TrackingState):
        return tracking_state.value
    return str(tracking_state)


class Guidance:
    """Stateful visual-servoing controller (one instance per vehicle).

    ``update()`` runs once per guidance tick with the tracker state, the locked
    box, the estimated distance, the live ``Limits`` and the elapsed seconds;
    it returns a BODY-frame ``VelocitySetpoint`` that is clamped, gated and
    smoothed.
    """

    def __init__(
        self,
        *,
        yaw_gains: Tuple[float, float, float] = (90.0, 0.0, 4.0),
        vz_gains: Tuple[float, float, float] = (2.0, 0.0, 0.1),
        vx_gains: Tuple[float, float, float] = (0.6, 0.0, 0.05),
        smoothing: float = 0.4,
        center_deadzone: float = 0.03,
    ) -> None:
        """
        Args:
          yaw_gains:  (kp, ki, kd) horizontal error -> yaw_rate [deg/s per unit]
          vz_gains:   (kp, ki, kd) vertical error   -> climb rate [m/s per unit]
          vx_gains:   (kp, ki, kd) distance error   -> forward vel [m/s per m]
          smoothing:  low-pass alpha in (0, 1]; out = a*new + (1-a)*prev.
                      1.0 disables smoothing.
          center_deadzone: centroid errors smaller than this are ignored.
        """
        self._servo: Dict[str, PID] = {
            "yaw": PID(*yaw_gains),
            "vz": PID(*vz_gains),
            "vx": PID(*vx_gains),
        }
        self._alpha = float(smoothing)
        self._center_deadzone = float(center_deadzone)
        self._filtered = np.zeros(_AXES)     # smoothing memory (emitted vector)

    # ---- tuning hooks ---------------------------------------------------
    def set_standoff(self, meters: float, limits: Limits) -> float:
        """Apply a standoff request through the Limits floor/ceiling; return it."""
        limits.standoff = limits.clamp_standoff(meters)
        return limits.standoff

    def set_max_speed(self, mps: float, limits: Limits) -> float:
        """Apply a max-speed request, floored at ``min_speed``; return it.

        The cap side belongs to the orchestrator/config envelope, so this
        stays cap-agnostic. A non-finite request leaves the limit unchanged.
        """
        requested = _finite_or_none(mps)
        if requested is not None:
            limits.max_speed = max(float(limits.min_speed), requested)
        return limits.max_speed

    def set_gains(
        self,
        *,
        yaw: Optional[Tuple[float, float, float]] = None,
        vz: Optional[Tuple[float, float, float]] = None,
        vx: Optional[Tuple[float, float, float]] = None,
    ) -> None:
        """Retune any subset of the three channels live."""
        for name, triple in (("yaw", yaw), ("vz", vz), ("vx", vx)):
            if triple is not None:
                self._servo[name].set_gains(*triple)

    def reset(self) -> None:
        """Clear every channel's memory and the smoothing state (-> rest)."""
        for servo in self._servo.values():
            servo.reset()
        self._filtered = np.zeros(_AXES)

    # ---- main step ------------------------------------------------------
    def update(
        self,
        tracking_state: TrackingState | str,
        locked_bbox: Optional[Tuple[float, float, float, float]],
        est_distance: Optional[float],
        limits: Limits,
        dt: float,
    ) -> VelocitySetpoint:
        """Compute the next BODY-frame velocity setpoint.

        Args:
          tracking_state: only 'locked' produces motion; anything else holds.
          locked_bbox: (x, y, w, h) normalised box of the locked target, or None.
          est_distance: estimated range to the target (m), or None.
          limits: the live hard limits (standoff, speeds, rates).
          dt: seconds since the previous tick.
        """
        if _as_state_name(tracking_state) != TrackingState.LOCKED.value or locked_bbox is None:
            self.reset()
            return VelocitySetpoint.hold()

        distance = _finite_or_none(est_distance)
        standoff = float(limits.standoff)
        error = _centroid_error(locked_bbox, self._center_deadzone)

        # -- servo: three channels into one setpoint vector ------------------
        raw = np.zeros(_AXES)
        raw[_YAW] = self._servo["yaw"].update(error[0], dt)
        raw[_VZ] = self._servo["vz"].update(error[1], dt)
        if distance is None:
            # No usable range: the forward channel rests so it cannot carry a
            # stale derivative or integral into the moment the range returns.
            self._servo["vx"].reset()
        else:
            raw[_VX] = self._servo["vx"].update(distance - standoff, dt)

        # -- clamp -> gate -> smooth -> gate -> clamp ------------------------
        bounds = _axis_bounds(limits)
        staged = _clamp_vector(raw, bounds)
        staged[_VX] = _standoff_gate(staged[_VX], distance, standoff)

        blended = self._alpha * staged + (1.0 - self._alpha) * self._filtered
        blended[_VX] = _standoff_gate(blended[_VX], distance, standoff)
        emitted = _clamp_vector(blended, bounds)

        self._filtered = emitted
        return VelocitySetpoint(
            vx=float(emitted[_VX]),
            vy=float(emitted[_VY]),
            vz=float(emitted[_VZ]),
            yaw_rate=float(emitted[_YAW]),
            valid=True,
        )


__all__ = ["Guidance"]
