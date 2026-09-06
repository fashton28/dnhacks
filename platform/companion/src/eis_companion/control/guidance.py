"""
Visual-servoing guidance: turn the locked target's bbox into a BODY-frame
velocity setpoint.

Three independent error channels, each a PID:
  * horizontal centroid error (bbox_cx - 0.5)  -> yaw_rate (turn to face target)
  * vertical   centroid error (0.5 - bbox_cy)  -> vz climb rate (keep centred)
  * distance error (est_distance - standoff)   -> vx forward velocity (approach)

HARD STANDOFF (PRD 11, non-negotiable)
--------------------------------------
``standoff`` is a hard limit. Guidance must NEVER command forward motion (vx>0)
that closes inside it. Concretely:
  * if est_distance is unknown (None)  -> vx is clamped to <= 0 (never approach).
  * if est_distance <= standoff        -> vx is clamped to <= 0 (hold / back off).
  * only when est_distance > standoff may vx be positive, and even then it is
    clamped so the commanded approach is proportional and bounded by max_speed.
Back-off (vx<0) is always permitted -- moving away never breaches standoff.

On 'lost' / no lock -> VelocitySetpoint.hold() (all-zero, valid=False): the
consumer must send a zero-velocity hold, not the last command.

All outputs are clamped to Limits and low-pass smoothed. numpy + stdlib only.
"""
from __future__ import annotations

import math
from typing import Optional, Tuple

from ..types import Limits, TrackingState, VelocitySetpoint
from .pid import PID


def _usable_distance(est_distance: Optional[float]) -> bool:
    """True only for a distance we may act on.

    ``None`` means "no measurement"; so does NaN/Infinity. Treating them
    differently is the whole of FM-07: every standoff guard below is a
    comparison, and a comparison against NaN is False, so a non-finite
    distance would slip past all three re-assertions and be clamped to
    ``+max_speed`` -- a commanded full-speed approach through the standoff.
    """
    if est_distance is None:
        return False
    try:
        return math.isfinite(float(est_distance))
    except (TypeError, ValueError):
        return False


# Sign convention for image axes (normalised, top-left origin):
#   cx in [0,1], 0.5 = centre. target right of centre (cx>0.5) -> turn right
#     (yaw_rate > 0, clockwise) to face it.
#   cy in [0,1], 0.5 = centre. target above centre (cy<0.5) means the drone
#     must climb -> vz < 0 (NED up). So vz = +k*(cy-0.5): cy<0.5 -> vz<0 (up).


class Guidance:
    """Stateful visual-servoing controller.

    update() is called per guidance tick with the latest tracking state, the
    locked target's normalised bbox (or None), the estimated distance (or None),
    the active Limits, and dt seconds since the last tick. It returns a
    BODY-frame VelocitySetpoint, hard-clamped and smoothed.
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
          yaw_gains:  (kp,ki,kd) for horizontal-error -> yaw_rate [deg/s per unit]
          vz_gains:   (kp,ki,kd) for vertical-error  -> climb rate [m/s per unit]
          vx_gains:   (kp,ki,kd) for distance-error  -> forward vel [m/s per m]
          smoothing:  low-pass alpha in (0,1]; output = a*new + (1-a)*prev.
                      Smaller = smoother/slower. 1.0 = no smoothing.
          center_deadzone: ignore centroid errors smaller than this (normalised)
                      to avoid jitter when already centred.
        """
        self._yaw_pid = PID(*yaw_gains)
        self._vz_pid = PID(*vz_gains)
        self._vx_pid = PID(*vx_gains)
        self._alpha = float(smoothing)
        self._center_deadzone = float(center_deadzone)

        # smoothed previous outputs
        self._prev = VelocitySetpoint.hold()

    # ---- tuning hooks ----------------------------------------------------
    def set_standoff(self, meters: float, limits: Limits) -> float:
        """Set the configured standoff (clamped to the limits floor). Returns it."""
        limits.standoff = limits.clamp_standoff(meters)
        return limits.standoff

    def set_max_speed(self, mps: float, limits: Limits) -> float:
        """Set the configured horizontal max speed (clamped). Returns it."""
        limits.max_speed = max(limits.min_speed, float(mps))
        return limits.max_speed

    def set_gains(
        self,
        *,
        yaw: Optional[Tuple[float, float, float]] = None,
        vz: Optional[Tuple[float, float, float]] = None,
        vx: Optional[Tuple[float, float, float]] = None,
    ) -> None:
        """Live-update any subset of the three PID gain triples."""
        if yaw is not None:
            self._yaw_pid.set_gains(*yaw)
        if vz is not None:
            self._vz_pid.set_gains(*vz)
        if vx is not None:
            self._vx_pid.set_gains(*vx)

    def reset(self) -> None:
        """Reset all PID state and smoothing to the safe hold output."""
        self._yaw_pid.reset()
        self._vz_pid.reset()
        self._vx_pid.reset()
        self._prev = VelocitySetpoint.hold()

    # ---- main step -------------------------------------------------------
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
          tracking_state: current Tracker state. Only 'locked' produces motion;
            any other state (idle/searching/lost) -> hold.
          locked_bbox: (x,y,w,h) normalised bbox of the locked target, or None.
          est_distance: estimated distance to target (m), or None if unknown.
          limits: active hard limits (standoff, max_speed, etc.).
          dt: seconds since last update (>=0).
        """
        state = (
            tracking_state.value
            if isinstance(tracking_state, TrackingState)
            else str(tracking_state)
        )

        # Not locked, or no bbox -> hold. Reset PIDs so we don't carry stale I.
        if state != TrackingState.LOCKED.value or locked_bbox is None:
            self.reset()
            return VelocitySetpoint.hold()

        bx, by, bw, bh = locked_bbox
        cx = bx + bw / 2.0
        cy = by + bh / 2.0

        # --- yaw: horizontal centroid error -------------------------------
        ex = cx - 0.5
        if abs(ex) < self._center_deadzone:
            ex = 0.0
        yaw_rate = self._yaw_pid.update(ex, dt)

        # --- vz: vertical centroid error (climb to keep centred) ----------
        # cy<0.5 (target high) -> need to climb -> vz<0 (NED up).
        ey = cy - 0.5
        if abs(ey) < self._center_deadzone:
            ey = 0.0
        vz = self._vz_pid.update(ey, dt)

        # --- vx: distance error (approach / hold / back off) --------------
        vx = self._compute_vx(est_distance, limits, dt)

        # --- clamp every axis to the hard limits --------------------------
        yaw_rate = _clamp(yaw_rate, -limits.max_yaw_rate, limits.max_yaw_rate)
        vz = _clamp(vz, -limits.max_climb_rate, limits.max_climb_rate)
        vx = _clamp(vx, -limits.max_speed, limits.max_speed)

        # --- HARD STANDOFF re-assertion (belt-and-braces) -----------------
        # After all PID math + clamps, guarantee we never command approach
        # inside / at / unknown-of the standoff. This is intentionally
        # redundant with _compute_vx so no future edit can silently break it.
        if not _usable_distance(est_distance) or est_distance <= limits.standoff:
            if vx > 0.0:
                vx = 0.0

        out = VelocitySetpoint(vx=vx, vy=0.0, vz=vz, yaw_rate=yaw_rate, valid=True)

        # --- low-pass smoothing -------------------------------------------
        out = self._smooth(out)

        # Smoothing could in principle nudge vx positive from a positive prev;
        # re-assert the hard standoff one final time on the *emitted* value.
        if not _usable_distance(est_distance) or est_distance <= limits.standoff:
            if out.vx > 0.0:
                out.vx = 0.0
        out.vx = _clamp(out.vx, -limits.max_speed, limits.max_speed)
        out.vz = _clamp(out.vz, -limits.max_climb_rate, limits.max_climb_rate)
        out.yaw_rate = _clamp(out.yaw_rate, -limits.max_yaw_rate, limits.max_yaw_rate)

        self._prev = out
        return out

    # ---- helpers ---------------------------------------------------------
    def _compute_vx(
        self, est_distance: Optional[float], limits: Limits, dt: float
    ) -> float:
        """Forward velocity from the distance error, with the hard standoff.

        Returns vx in m/s (positive = approach). Never positive when distance
        is unknown or at/inside standoff.
        """
        if not _usable_distance(est_distance):
            # Unknown (None) OR unusable (NaN/inf) distance: never approach.
            # Hold (zero forward), let yaw/vz keep the target centred. PID gets
            # a zero error so it unwinds instead of latching a non-finite state.
            self._vx_pid.update(0.0, dt)
            return 0.0

        est_distance = float(est_distance)
        error = est_distance - limits.standoff  # >0 too far, <0 too close
        vx = self._vx_pid.update(error, dt)

        # Hard standoff: if we're at/inside the standoff, forbid approach.
        if est_distance <= limits.standoff:
            vx = min(vx, 0.0)
        return vx

    def _smooth(self, out: VelocitySetpoint) -> VelocitySetpoint:
        a = self._alpha
        p = self._prev
        return VelocitySetpoint(
            vx=a * out.vx + (1.0 - a) * p.vx,
            vy=a * out.vy + (1.0 - a) * p.vy,
            vz=a * out.vz + (1.0 - a) * p.vz,
            yaw_rate=a * out.yaw_rate + (1.0 - a) * p.yaw_rate,
            valid=True,
        )


def _clamp(v: float, lo: float, hi: float) -> float:
    """Clamp to [lo, hi]; a NON-FINITE input collapses to 0.0, never to ``hi``.

    ``max(lo, min(hi, NaN))`` returns ``hi`` under CPython, so the naive clamp
    is a NaN-to-full-throttle amplifier (FM-06). Zero is the only safe answer
    for a value we cannot order.
    """
    if not math.isfinite(v):
        return 0.0
    if lo > hi:
        lo, hi = hi, lo
    return max(lo, min(hi, v))


__all__ = ["Guidance"]
