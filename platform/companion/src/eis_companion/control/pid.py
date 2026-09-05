"""
PID controller -- pure stdlib, dt-aware, output-clamped, with anti-windup.

Used by the guidance visual-servoing loops (yaw / climb / forward). Kept
hardware-free and dependency-free so it unit-tests in isolation.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass
class PID:
    """A discrete PID controller.

    Args:
      kp, ki, kd: gains.
      out_min, out_max: hard clamp on the controller output. Also bounds the
        integral term (clamped anti-windup): when the output saturates the
        integrator is back-calculated so it never winds past what could be
        used, preventing overshoot when the error reverses.
      integral_limit: optional explicit |integral| cap (in integral units). If
        None, the integral is bounded only by the back-calculation against the
        output limits.

    update(error, dt) returns the clamped output. dt is in seconds; dt<=0 is
    treated as "no time elapsed" (derivative skipped, integral not advanced) so
    callers never divide by zero or get a derivative kick on a stalled clock.
    """
    kp: float = 0.0
    ki: float = 0.0
    kd: float = 0.0
    out_min: float = -1e9
    out_max: float = 1e9
    integral_limit: Optional[float] = None

    def __post_init__(self) -> None:
        self._integral: float = 0.0
        self._prev_error: Optional[float] = None

    def reset(self) -> None:
        """Zero the integrator and forget the previous error (no derivative kick)."""
        self._integral = 0.0
        self._prev_error = None

    def set_gains(self, kp: Optional[float] = None,
                  ki: Optional[float] = None,
                  kd: Optional[float] = None) -> None:
        """Update any subset of gains live. Does not reset internal state."""
        if kp is not None:
            self.kp = float(kp)
        if ki is not None:
            self.ki = float(ki)
        if kd is not None:
            self.kd = float(kd)

    def update(self, error: float, dt: float) -> float:
        """Advance the controller one step and return the clamped output."""
        error = float(error)

        # Proportional
        p = self.kp * error

        # Derivative (skip on first call or stalled clock to avoid a kick)
        d = 0.0
        if dt > 0.0 and self._prev_error is not None:
            d = self.kd * (error - self._prev_error) / dt
        self._prev_error = error

        # Integral (only advance when time actually elapsed)
        if dt > 0.0 and self.ki != 0.0:
            self._integral += error * dt
            # explicit integral cap if requested
            if self.integral_limit is not None:
                self._integral = _clamp(
                    self._integral, -self.integral_limit, self.integral_limit
                )
            # clamped anti-windup: bound the integral *contribution* so the
            # summed output cannot be pushed beyond the output limits by I alone
            i_term_max = (self.out_max - p - d)
            i_term_min = (self.out_min - p - d)
            i_contrib = self.ki * self._integral
            if i_contrib > i_term_max:
                self._integral = i_term_max / self.ki if self.ki else 0.0
            elif i_contrib < i_term_min:
                self._integral = i_term_min / self.ki if self.ki else 0.0

        i = self.ki * self._integral

        out = p + i + d
        return _clamp(out, self.out_min, self.out_max)


def _clamp(v: float, lo: float, hi: float) -> float:
    """Clamp v to [lo, hi]; tolerant if lo/hi are swapped."""
    if lo > hi:
        lo, hi = hi, lo
    return max(lo, min(hi, v))


__all__ = ["PID"]
