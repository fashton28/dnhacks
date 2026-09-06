"""
Discrete PID controller for the guidance servo channels.

Three pieces, so the arithmetic is testable without a controller object:

  PIDGains   the tuning record: (kp, ki, kd), the output band and an optional
             cap on the integrator sum. Immutable.
  PIDState   what one step must remember: the integrator sum and the previous
             error. Immutable -- a step returns a NEW state, never mutates.
  pid_step   the pure step: (gains, state, error, dt) -> (output, next_state).

``PID`` is the stateful facade the control core instantiates. Its field order
``(kp, ki, kd, out_min, out_max, integral_limit)`` is positional API: callers
write ``PID(*gain_triple)`` and ``PID(kp, ki, kd, out_min=.., out_max=..)``.

Behaviour the rest of the system relies on
------------------------------------------
* The returned output always lies inside ``[out_min, out_max]`` (a swapped
  band is tolerated).
* Anti-windup is the *tracking* form: whenever the unsaturated sum leaves the
  band, the integrator is re-solved so that ``P + I + D`` sits exactly on the
  bound. The integrator can never hold more authority than the band can
  spend, so a reversal of the error is answered immediately, not after the
  surplus has been paid off. ``integral_limit`` additionally caps the raw
  integrator sum when given.
* ``dt <= 0`` is "no time elapsed": nothing is integrated and no derivative is
  formed. The error is still remembered so the next real step differentiates
  against the most recent sample rather than a stale one.
* The first step after construction or ``reset()`` forms no derivative.
* A non-finite ``error`` or ``dt`` is refused outright: the output is ``0.0``
  and the state is returned unchanged, so a single NaN cannot poison the
  integrator or the derivative memory (FM-07).
* ``set_gains`` retunes live and leaves the state alone.

stdlib only.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import NamedTuple, Optional, Tuple


class PIDState(NamedTuple):
    """Controller memory. ``prev_error is None`` means "no sample seen yet"."""
    integral: float = 0.0
    prev_error: Optional[float] = None


class PIDGains(NamedTuple):
    """Tuning + output band. ``integral_limit=None`` means no explicit cap."""
    kp: float
    ki: float
    kd: float
    out_min: float
    out_max: float
    integral_limit: Optional[float]

    @property
    def band(self) -> Tuple[float, float]:
        """The output band as (lo, hi), ordered even if configured swapped."""
        lo, hi = float(self.out_min), float(self.out_max)
        return (lo, hi) if lo <= hi else (hi, lo)


def _as_finite(value) -> Optional[float]:
    """float(value) if it is a finite number, else None."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _saturate(value: float, lo: float, hi: float) -> float:
    """Clamp to [lo, hi]. A non-finite value becomes 0.0 -- never a bound.

    ``min(hi, nan)`` is ``hi`` under CPython, so the naive clamp would turn an
    unusable number into the maximum commanded output (FM-06).
    """
    if not math.isfinite(value):
        return 0.0
    return lo if value < lo else hi if value > hi else value


def pid_step(
    gains: PIDGains, state: PIDState, error: float, dt: float
) -> Tuple[float, PIDState]:
    """Advance one PID step. Pure: returns ``(output, next_state)``.

    See the module docstring for the contract. ``state`` is never mutated.
    """
    e = _as_finite(error)
    step = _as_finite(dt)
    if e is None or step is None:
        return 0.0, state

    lo, hi = gains.band
    elapsed = step > 0.0

    proportional = gains.kp * e

    derivative = 0.0
    if elapsed and state.prev_error is not None:
        derivative = gains.kd * (e - state.prev_error) / step

    integral = state.integral
    if elapsed and gains.ki != 0.0:
        integral += e * step
        if gains.integral_limit is not None:
            cap = abs(float(gains.integral_limit))
            integral = _saturate(integral, -cap, cap)

    unsaturated = proportional + gains.ki * integral + derivative
    output = _saturate(unsaturated, lo, hi)

    if elapsed and gains.ki != 0.0 and output != unsaturated:
        # Tracking anti-windup: hand the excess back to the integrator so the
        # stored I contribution is exactly what the band could spend.
        integral -= (unsaturated - output) / gains.ki
        if not math.isfinite(integral):
            integral = 0.0

    return output, PIDState(integral=integral, prev_error=e)


@dataclass
class PID:
    """Stateful PID facade over :func:`pid_step`.

    Args:
      kp, ki, kd: gains.
      out_min, out_max: hard output band (also bounds the integral authority).
      integral_limit: optional explicit |integral| cap in integral units.

    ``update(error, dt)`` returns the clamped output; ``reset()`` forgets the
    integrator and the previous error; ``set_gains`` retunes live.
    """
    kp: float = 0.0
    ki: float = 0.0
    kd: float = 0.0
    out_min: float = -1e9
    out_max: float = 1e9
    integral_limit: Optional[float] = None
    _memory: PIDState = field(
        default_factory=PIDState, init=False, repr=False, compare=False
    )

    @property
    def gains(self) -> PIDGains:
        """The current tuning as an immutable record."""
        return PIDGains(
            kp=float(self.kp),
            ki=float(self.ki),
            kd=float(self.kd),
            out_min=float(self.out_min),
            out_max=float(self.out_max),
            integral_limit=self.integral_limit,
        )

    @property
    def state(self) -> PIDState:
        """The current memory (read-only snapshot)."""
        return self._memory

    def reset(self) -> None:
        """Forget the integrator and the previous error (no derivative kick)."""
        self._memory = PIDState()

    def set_gains(
        self,
        kp: Optional[float] = None,
        ki: Optional[float] = None,
        kd: Optional[float] = None,
    ) -> None:
        """Retune any subset of the gains live. The memory is untouched."""
        if kp is not None:
            self.kp = float(kp)
        if ki is not None:
            self.ki = float(ki)
        if kd is not None:
            self.kd = float(kd)

    def update(self, error: float, dt: float) -> float:
        """Advance one step and return the clamped output."""
        output, self._memory = pid_step(self.gains, self._memory, error, dt)
        return output


__all__ = ["PID", "PIDGains", "PIDState", "pid_step"]
