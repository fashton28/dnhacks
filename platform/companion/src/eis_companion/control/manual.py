"""
Manual piloting: high-rate normalised stick frames -> BODY-frame velocity
setpoints, through the same setpoint path and the same hard limits as
autonomous guidance.

Mapping
-------
A stick frame is the contract ``ManualInput`` quadruple, each axis in -1..1:

    (throttle, yaw, pitch, roll)

It becomes a body setpoint ``(vx, vy, vz, yaw_rate)`` through one fixed
matrix (``_STICK_TO_BODY``) and one per-axis scale taken from ``Limits``:

    vx       = +pitch    * max_speed        pitch>0    = forward
    vy       = +roll     * max_speed        roll>0     = right
    vz       = -throttle * max_climb_rate   throttle>0 = climb = NED up (< 0)
    yaw_rate = +yaw      * max_yaw_rate     yaw>0      = clockwise / right

Per-tick pipeline
-----------------
    admit -> [gates: engaged, link, deadman] -> saturate -> deadzone
          -> map & scale -> smooth -> clamp

Safety (PRD 11)
---------------
* A frame is admitted only when all four axes are finite; anything else is
  rejected WHOLE and does not refresh the deadman, so a stream of NaN sticks
  ages out into the zero-and-hold exactly like a dead link (FM-05).
* Deadman: only an admitted stick frame refreshes it. When no frame has
  arrived within ``manual_watchdog_ms`` -- whether the caller is feeding
  frames or merely ticking ``update()`` -- the output is
  ``VelocitySetpoint.hold()`` (zero, valid=False) and the smoothing memory
  is dropped, so the last command is never continued or coasted.
* Ground-link deadman: ``link_ok=False`` zeroes-and-holds immediately.
* ``engage()`` re-arms the deadman; the CALLER guarantees armed + airborne
  and mutual exclusion with tracking. ``release()`` zeroes and forgets the
  stored frame. Emergency stop / disarm live above this class.
* Manual piloting does NOT enforce the standoff -- a human pilot may fly
  anywhere -- but every axis is clamped to the shared speed / rate limits.

numpy + stdlib only. Time is injected through ``clock`` so the deadman is
deterministic under test.
"""
from __future__ import annotations

import math
from typing import Callable, Optional

import numpy as np

from ..types import Limits, VelocitySetpoint
from .. import types as _types

# Stick frame order (the contract ManualInput field order).
_STICK_ATTRS = ("throttle", "yaw", "pitch", "roll")

# Body setpoint <- stick frame.  Rows: vx, vy, vz, yaw_rate.
# Columns: throttle, yaw, pitch, roll.
_STICK_TO_BODY = np.array(
    [
        [0.0, 0.0, 1.0, 0.0],    # vx       <- pitch
        [0.0, 0.0, 0.0, 1.0],    # vy       <- roll
        [-1.0, 0.0, 0.0, 0.0],   # vz       <- -throttle (climb is NED up)
        [0.0, 1.0, 0.0, 0.0],    # yaw_rate <- yaw
    ]
)


def _clamp01(v: float) -> float:
    """Saturate one stick axis to [-1, 1]. A non-finite axis reads as CENTRED.

    Saturating NaN to 1.0 -- what ``max(-1, min(1, nan))`` does under CPython
    -- is full deflection on that axis (FM-05).
    """
    try:
        value = float(v)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(value):
        return 0.0
    return -1.0 if value < -1.0 else 1.0 if value > 1.0 else value


def _admit_frame(values) -> Optional[np.ndarray]:
    """Four finite axes -> saturated stick vector; anything else -> None."""
    try:
        axes = [float(v) for v in values]
    except (TypeError, ValueError):
        return None
    if len(axes) != len(_STICK_ATTRS) or not all(math.isfinite(a) for a in axes):
        return None
    return np.array([_clamp01(a) for a in axes])


def _frame_from_object(manual_input) -> Optional[np.ndarray]:
    """Read throttle/yaw/pitch/roll off a ManualInput-shaped object."""
    try:
        values = [getattr(manual_input, name) for name in _STICK_ATTRS]
    except AttributeError:
        return None
    return _admit_frame(values)


def _apply_deadzone(frame: np.ndarray, deadzone: float) -> np.ndarray:
    """Centred deadzone with the live band rescaled to start at zero.

    Deflections at or inside ``deadzone`` read as centred; beyond it the
    remaining travel [dz, 1] is stretched onto [0, 1] so there is no jump at
    the edge. ``deadzone <= 0`` is a pass-through; a deadzone that swallows
    the whole travel (>= 1, or non-finite) reads every axis as centred.
    """
    try:
        dz = float(deadzone)
    except (TypeError, ValueError):
        dz = float("nan")
    if not math.isfinite(dz) or dz >= 1.0:
        return np.zeros_like(frame)
    if dz <= 0.0:
        return frame
    magnitude = np.abs(frame)
    live = np.where(magnitude > dz, (magnitude - dz) / (1.0 - dz), 0.0)
    return np.sign(frame) * live


def _body_bounds(limits: Limits) -> np.ndarray:
    """|bound| per body axis; a non-finite limit grants zero authority."""
    raw = np.array(
        [limits.max_speed, limits.max_speed, limits.max_climb_rate, limits.max_yaw_rate],
        dtype=float,
    )
    return np.where(np.isfinite(raw), np.abs(raw), 0.0)


def _clamp_vector(vector: np.ndarray, bounds: np.ndarray) -> np.ndarray:
    """Per-axis clamp to [-bound, bound]; a non-finite axis becomes 0.0 (FM-06)."""
    safe = np.where(np.isfinite(vector), vector, 0.0)
    return np.clip(safe, -bounds, bounds)


class _Deadman:
    """Remembers when the last admitted stick frame arrived."""

    def __init__(self, clock: Callable[[], float]) -> None:
        self._clock = clock
        self._last_frame_t: Optional[float] = None

    def arm(self) -> None:
        """Start a fresh window now (engage / a new frame)."""
        self._last_frame_t = float(self._clock())

    def disarm(self) -> None:
        self._last_frame_t = None

    def expired(self, timeout_ms: float) -> bool:
        """True when no frame has been seen, or the last one is too old."""
        if self._last_frame_t is None:
            return True
        age_ms = (float(self._clock()) - self._last_frame_t) * 1000.0
        return age_ms > float(timeout_ms)


class ManualPilot:
    """Stateful stick-to-setpoint mapper with deadzone, smoothing and a deadman.

    Args:
      smoothing: low-pass alpha in (0, 1]; 1.0 disables smoothing.
      clock: seconds source (injectable). Defaults to ``eis_companion.types.now``.
    """

    def __init__(
        self,
        *,
        smoothing: float = 0.5,
        clock: Optional[Callable[[], float]] = None,
    ) -> None:
        self._alpha = float(smoothing)
        self._deadman = _Deadman(clock or _types.now)
        self._engaged = False
        self._frame: Optional[np.ndarray] = None       # latest admitted sticks
        self._filtered = np.zeros(4)                   # smoothing memory (body)
        self._emitted = VelocitySetpoint.hold()        # last setpoint handed out

    # ---- engage / release ---------------------------------------------------
    @property
    def engaged(self) -> bool:
        return self._engaged

    def engage(self) -> None:
        """Take manual control. The caller has verified armed + airborne and
        released tracking. Starts a fresh deadman window and rests the output."""
        self._engaged = True
        self._deadman.arm()
        self._rest()

    def release(self) -> VelocitySetpoint:
        """Give manual control back: zero, forget the stored frame, return the
        safe hold setpoint the caller should emit."""
        self._engaged = False
        self._frame = None
        self._deadman.disarm()
        return self._rest()

    def reset(self) -> None:
        """Release and clear everything (the orchestrator's watchdog path)."""
        self.release()

    # ---- orchestrator adapter: high-rate set_input + per-tick update ------
    def set_input(
        self,
        throttle: float = 0.0,
        yaw: float = 0.0,
        pitch: float = 0.0,
        roll: float = 0.0,
    ) -> bool:
        """Store the newest stick frame (fire-and-forget path).

        Engages on the first frame and refreshes the deadman. A frame with any
        non-finite axis is rejected whole: not stored, deadman NOT refreshed.
        Returns True when the frame was admitted.
        """
        frame = _admit_frame((throttle, yaw, pitch, roll))
        if frame is None:
            return False
        self._frame = frame
        if not self._engaged:
            self.engage()
        self._deadman.arm()
        return True

    def update(self, limits: Limits, dt: float, *, link_ok: bool = True) -> VelocitySetpoint:
        """Per-tick step: replay the stored frame through the pipeline.

        Does NOT refresh the deadman -- only a real frame does -- so a silent
        ground station ages out into the zero-and-hold on schedule.
        """
        return self._step(self._frame, limits, link_ok=link_ok, fresh=False)

    # ---- direct step ----------------------------------------------------------
    def feed(
        self,
        manual_input,
        limits: Limits,
        dt: float,
        *,
        link_ok: bool = True,
    ) -> VelocitySetpoint:
        """Map one stick frame (or None to just tick the deadman) to a setpoint.

        Args:
          manual_input: object with throttle/yaw/pitch/roll in -1..1, or None.
            An admitted frame refreshes the deadman; ``None`` inside the window
            re-issues the previous setpoint, after it -> hold.
          limits: live limits (clamps, deadzone, watchdog timeout).
          dt: seconds since the previous call (kept for signature parity).
          link_ok: ground-link health. False -> immediate zero-and-hold.
        """
        frame = None if manual_input is None else _frame_from_object(manual_input)
        return self._step(frame, limits, link_ok=link_ok, fresh=frame is not None)

    # ---- pipeline ---------------------------------------------------------------
    def _rest(self) -> VelocitySetpoint:
        """Drop the smoothing memory and emit the canonical hold."""
        self._filtered = np.zeros(4)
        self._emitted = VelocitySetpoint.hold()
        return self._emitted

    def _step(
        self,
        frame: Optional[np.ndarray],
        limits: Limits,
        *,
        link_ok: bool,
        fresh: bool,
    ) -> VelocitySetpoint:
        if not self._engaged:
            return VelocitySetpoint.hold()
        if fresh:
            self._deadman.arm()
        if not link_ok or self._deadman.expired(limits.manual_watchdog_ms):
            return self._rest()
        if frame is None:
            return self._emitted            # inside the window, nothing new

        shaped = _apply_deadzone(frame, limits.deadzone)
        bounds = _body_bounds(limits)
        target = (_STICK_TO_BODY @ shaped) * bounds
        self._filtered = self._alpha * target + (1.0 - self._alpha) * self._filtered
        body = _clamp_vector(self._filtered, bounds)
        self._emitted = VelocitySetpoint(
            vx=float(body[0]),
            vy=float(body[1]),
            vz=float(body[2]),
            yaw_rate=float(body[3]),
            valid=True,
        )
        return self._emitted


__all__ = ["ManualPilot"]
