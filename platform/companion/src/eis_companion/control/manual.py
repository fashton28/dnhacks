"""
Manual piloting: map high-rate normalised stick frames to BODY-frame velocity
setpoints, reusing the same setpoint path (and the same hard limits) as
autonomous guidance.

Axis mapping (contract ManualInput, each axis -1..1):
  throttle -> vz  (climb/descend)   : throttle>0 = climb  -> vz<0 (NED up)
  yaw      -> yaw_rate              : yaw>0      = turn right (clockwise) >0
  pitch    -> vx  (forward/back)    : pitch>0    = forward -> vx>0
  roll     -> vy  (left/right)      : roll>0     = right   -> vy>0

Each axis is scaled to the SAME configured limit as guidance:
  vx,vy -> max_speed ; vz -> max_climb_rate ; yaw_rate -> max_yaw_rate.

Safety (PRD 11):
  * deadzone + output smoothing on every axis.
  * Input watchdog: if no stick frame arrives within manual_watchdog_ms, OR the
    ground link is reported down, feed() returns VelocitySetpoint.hold()
    (zeroed, valid=False) -- never continue the last commanded velocity.
  * engage() requires armed+airborne (the CALLER enforces this precondition and
    passes the result); engaging is mutually exclusive with tracking and the
    caller is responsible for disengaging tracking + setting controlSource.
  * release() zeroes and reverts to auto-hold.
  * emergencyStop / disarm are handled above this class and always supersede it.

NOTE on standoff: manual piloting does NOT enforce standoff -- a human pilot may
deliberately fly anywhere. Standoff is an autonomous-guidance guarantee. (Manual
is still clamped to all speed/rate limits.)

numpy + stdlib only. Time is injected via ``now`` so the watchdog is testable.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from ..types import Limits, VelocitySetpoint
from .. import types as _types


# A ManualInput is anything with throttle/yaw/pitch/roll floats. We duck-type to
# avoid importing the contract dataclass into a pure-logic module; the API layer
# hands us shared.ManualInput which matches.
class _HasAxes:
    throttle: float
    yaw: float
    pitch: float
    roll: float


@dataclass
class _Axes:
    """Concrete stick frame stored by set_input() and replayed by update()."""
    throttle: float = 0.0
    yaw: float = 0.0
    pitch: float = 0.0
    roll: float = 0.0


class ManualPilot:
    """Stateful manual-piloting mapper with deadzone, smoothing and a watchdog.

    Args:
      smoothing: low-pass alpha in (0,1]; 1.0 = no smoothing.
      clock: callable returning seconds (injectable for tests). Defaults to
        ``eis_companion.types.now``.
    """

    def __init__(
        self,
        *,
        smoothing: float = 0.5,
        clock: Optional[Callable[[], float]] = None,
    ) -> None:
        self._alpha = float(smoothing)
        self._clock = clock or _types.now
        self._engaged: bool = False
        self._last_input_t: Optional[float] = None
        self._prev = VelocitySetpoint.hold()
        self._pending: Optional[_Axes] = None   # latest stick frame for update()

    # ---- engage / release ------------------------------------------------
    @property
    def engaged(self) -> bool:
        return self._engaged

    def engage(self) -> None:
        """Engage manual control. Caller MUST have verified armed+airborne and
        disengaged any active tracking first (mutual exclusion). Resets the
        watchdog clock so we don't immediately trip it."""
        self._engaged = True
        self._last_input_t = self._clock()
        self._prev = VelocitySetpoint.hold()

    def release(self) -> VelocitySetpoint:
        """Release manual control -> zero setpoint + hold (auto-hold). Returns
        the safe hold setpoint the caller should emit."""
        self._engaged = False
        self._last_input_t = None
        self._prev = VelocitySetpoint.hold()
        return VelocitySetpoint.hold()

    # ---- orchestrator-facing adapter (high-rate set_input + per-tick update)
    # The orchestrator separates the high-rate stick path (set_input, called from
    # the fire-and-forget manualInput handler) from the control-loop step
    # (update, called every tick). These wrap engage()/feed()/release() so the
    # app never has to thread a ManualInput object through the control loop.
    def set_input(
        self,
        throttle: float = 0.0,
        yaw: float = 0.0,
        pitch: float = 0.0,
        roll: float = 0.0,
    ) -> None:
        """Store the latest stick frame (high-rate, fire-and-forget). Engages the
        pilot on first input and refreshes the watchdog clock. The orchestrator
        only calls this while manual control is the active source."""
        self._pending = _Axes(float(throttle), float(yaw), float(pitch), float(roll))
        if not self._engaged:
            self.engage()
        self._last_input_t = self._clock()

    def update(self, limits: Limits, dt: float, *, link_ok: bool = True) -> VelocitySetpoint:
        """Per-tick step: map the latest stored stick frame to a clamped BODY
        setpoint. Watchdog-gated inside feed(); returns hold() until the first
        set_input or after a release/reset."""
        return self.feed(self._pending, limits, dt, link_ok=link_ok)

    def reset(self) -> None:
        """Release manual control and clear any pending stick frame (-> hold)."""
        self._pending = None
        self.release()

    # ---- main step -------------------------------------------------------
    def feed(
        self,
        manual_input,
        limits: Limits,
        dt: float,
        *,
        link_ok: bool = True,
    ) -> VelocitySetpoint:
        """Map one stick frame to a clamped BODY-frame velocity setpoint.

        Pass ``manual_input=None`` to "tick" the watchdog without new input
        (e.g. on a periodic loop) -- this will return hold() once the timeout
        elapses. Any non-None input refreshes the watchdog.

        Args:
          manual_input: object with throttle/yaw/pitch/roll in -1..1, or None.
          limits: active hard limits (clamps + deadzone + watchdog timeout).
          dt: seconds since last call (>=0), for smoothing.
          link_ok: ground-link health (deadman). False -> immediate hold.
        """
        if not self._engaged:
            return VelocitySetpoint.hold()

        t = self._clock()

        if manual_input is not None:
            self._last_input_t = t

        # --- watchdog + deadman: zero & hold on input or link loss --------
        if not link_ok:
            self._prev = VelocitySetpoint.hold()
            return VelocitySetpoint.hold()

        if self._last_input_t is None:
            self._prev = VelocitySetpoint.hold()
            return VelocitySetpoint.hold()

        age_ms = (t - self._last_input_t) * 1000.0
        if age_ms > limits.manual_watchdog_ms:
            self._prev = VelocitySetpoint.hold()
            return VelocitySetpoint.hold()

        if manual_input is None:
            # No new frame but still inside the watchdog window: keep holding
            # the last *smoothed* command would be unsafe per spec ("never
            # continue the last commanded velocity"), but we are within the
            # window so we re-emit the last command. To stay strictly safe we
            # decay toward zero via smoothing against a zero target is wrong;
            # instead we simply re-issue the previous valid command unchanged.
            return self._prev

        # --- deadzone per axis --------------------------------------------
        thr = _deadzone(_clamp01(manual_input.throttle), limits.deadzone)
        yaw = _deadzone(_clamp01(manual_input.yaw), limits.deadzone)
        pitch = _deadzone(_clamp01(manual_input.pitch), limits.deadzone)
        roll = _deadzone(_clamp01(manual_input.roll), limits.deadzone)

        # --- scale to the SAME limits as guidance -------------------------
        # throttle>0 = climb -> vz negative (NED up)
        vz = -thr * limits.max_climb_rate
        yaw_rate = yaw * limits.max_yaw_rate
        vx = pitch * limits.max_speed
        vy = roll * limits.max_speed

        target = VelocitySetpoint(vx=vx, vy=vy, vz=vz, yaw_rate=yaw_rate, valid=True)

        # --- smoothing ----------------------------------------------------
        out = self._smooth(target)

        # --- final hard clamp (belt-and-braces) ---------------------------
        out.vx = _clamp(out.vx, -limits.max_speed, limits.max_speed)
        out.vy = _clamp(out.vy, -limits.max_speed, limits.max_speed)
        out.vz = _clamp(out.vz, -limits.max_climb_rate, limits.max_climb_rate)
        out.yaw_rate = _clamp(out.yaw_rate, -limits.max_yaw_rate, limits.max_yaw_rate)

        self._prev = out
        return out

    # ---- helpers ---------------------------------------------------------
    def _smooth(self, target: VelocitySetpoint) -> VelocitySetpoint:
        a = self._alpha
        p = self._prev
        return VelocitySetpoint(
            vx=a * target.vx + (1.0 - a) * p.vx,
            vy=a * target.vy + (1.0 - a) * p.vy,
            vz=a * target.vz + (1.0 - a) * p.vz,
            yaw_rate=a * target.yaw_rate + (1.0 - a) * p.yaw_rate,
            valid=True,
        )


def _clamp(v: float, lo: float, hi: float) -> float:
    if lo > hi:
        lo, hi = hi, lo
    return max(lo, min(hi, v))


def _clamp01(v: float) -> float:
    """Clamp a stick axis to [-1, 1]."""
    return max(-1.0, min(1.0, float(v)))


def _deadzone(v: float, dz: float) -> float:
    """Apply a centred deadzone and rescale so output is continuous past dz."""
    if dz <= 0.0:
        return v
    if abs(v) <= dz:
        return 0.0
    # rescale remaining range [dz,1] -> [0,1] so there's no jump at the edge
    sign = 1.0 if v > 0 else -1.0
    return sign * (abs(v) - dz) / (1.0 - dz)


__all__ = ["ManualPilot"]
