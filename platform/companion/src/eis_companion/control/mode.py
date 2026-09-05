"""
============================================================================
Drone Safety Platform -- ATTENDANCE MODE + UNATTENDED_ENVELOPE (pure logic)
----------------------------------------------------------------------------
Two things live here, and nothing else:

  1. ``AttendanceMachine`` -- the attended/unattended state machine.
     * Unattended is entered ONLY by a *signed* operator command. The
       signature check itself is I/O (it reads a key), so it happens in
       ``eis_companion.security`` and arrives here as a plain boolean: this
       module stays pure. An unsigned request is REFUSED and the refusal is
       reportable -- an attempt is itself an event (THREAT_MODEL A6/A7).
     * The moment an operator connects, the machine reverts to attended. The
       safe direction is always toward supervision (ADR D23), so this is
       automatic, immediate, and needs no command at all.
     * Every dispatch is tagged with the mode in force when it was dispatched,
       which is what makes a mission record answer "was anyone watching?".

  2. ``UnattendedEnvelope`` + :func:`check_unattended` -- the D23 envelope.
     A task outside it is REFUSED (never clamped into range), and the refusal
     names the constraint and its envelope value so the escalation a human
     reads says what was asked for and why it was declined.

     | Area          | inside the perimeter                                  |
     | Profile       | ``inspect`` only                                      |
     | Altitude      | 30-50 m AGL                                           |
     | Orbit         | one lap                                               |
     | Hold          | <= 15 s                                               |
     | Sortie rate   | <= 2 per hour                                         |
     | No dispatch   | navSource != gps, RF interference, hostile drone,     |
     |               | night without healthy thermal, wind > 6 m/s (half     |
     |               | the attended 12 m/s limit -- nobody can take over)    |

HARD FLOOR. The values above are the widest the system will ever accept.
``config.py`` re-asserts them after loading YAML/env, so configuration may
only TIGHTEN the envelope. :meth:`UnattendedEnvelope.tightened` is the only
supported way to build a narrower one and it refuses to widen any field.

Pure stdlib -- no config, no clock ownership (callers pass epoch ms), no I/O.
============================================================================
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Iterable, Optional, Sequence, Tuple

# --------------------------------------------------------------------------
# Vocabulary (mirrors shared/shared.py AttendanceMode)
# --------------------------------------------------------------------------
MODE_ATTENDED = "attended"
MODE_UNATTENDED = "unattended"
ATTENDANCE_MODES: Tuple[str, ...] = (MODE_ATTENDED, MODE_UNATTENDED)

#: Compatibility profile aliases (ADR D13). The envelope reasons about the
#: canonical names only.
PROFILE_ALIASES: Dict[str, str] = {
    "slow": "follow",
    "standard": "inspect",
    "fast": "survey",
}


def canonical_profile(profile: str) -> str:
    """Map a compatibility profile name onto its canonical name (ADR D13)."""
    name = str(profile or "").strip().lower()
    return PROFILE_ALIASES.get(name, name)


# --------------------------------------------------------------------------
# UNATTENDED_ENVELOPE (ADR D23) -- the hard bounds
# --------------------------------------------------------------------------
#: Absolute bounds. Nothing in this system accepts an unattended dispatch
#: outside these, whatever a config file, a wire message or a model says.
UNATTENDED_MIN_ALT_M = 30.0
UNATTENDED_MAX_ALT_M = 50.0
UNATTENDED_MAX_LAPS = 1.0
UNATTENDED_MAX_HOLD_S = 15.0
UNATTENDED_MAX_SORTIES_PER_HOUR = 2
UNATTENDED_MAX_WIND_MPS = 6.0        # half the attended 12 m/s limit
UNATTENDED_PROFILES: Tuple[str, ...] = ("inspect",)
UNATTENDED_SORTIE_WINDOW_S = 3600.0


@dataclass(frozen=True)
class UnattendedEnvelope:
    """The envelope an unattended dispatch must fit inside (ADR D23)."""
    min_alt_m: float = UNATTENDED_MIN_ALT_M
    max_alt_m: float = UNATTENDED_MAX_ALT_M
    max_laps: float = UNATTENDED_MAX_LAPS
    max_hold_s: float = UNATTENDED_MAX_HOLD_S
    max_sorties_per_hour: int = UNATTENDED_MAX_SORTIES_PER_HOUR
    max_wind_mps: float = UNATTENDED_MAX_WIND_MPS
    profiles: Tuple[str, ...] = UNATTENDED_PROFILES
    require_inside_perimeter: bool = True
    sortie_window_s: float = UNATTENDED_SORTIE_WINDOW_S

    def tightened(
        self,
        *,
        min_alt_m: Optional[float] = None,
        max_alt_m: Optional[float] = None,
        max_laps: Optional[float] = None,
        max_hold_s: Optional[float] = None,
        max_sorties_per_hour: Optional[int] = None,
        max_wind_mps: Optional[float] = None,
        profiles: Optional[Iterable[str]] = None,
    ) -> "UnattendedEnvelope":
        """Return a copy that is narrower than, or equal to, this envelope.

        Every argument is applied in the SAFE direction only: a request to
        widen a bound is silently ignored rather than honoured, so no config
        layer can relax the envelope by asking nicely. ``require_inside_perimeter``
        is not an argument at all -- "inside the perimeter" is not negotiable.
        """
        allowed = tuple(self.profiles)
        if profiles is not None:
            requested = tuple(
                canonical_profile(p) for p in profiles if str(p).strip()
            )
            allowed = tuple(p for p in requested if p in self.profiles) or allowed
        return UnattendedEnvelope(
            min_alt_m=max(self.min_alt_m, _num(min_alt_m, self.min_alt_m)),
            max_alt_m=min(self.max_alt_m, _num(max_alt_m, self.max_alt_m)),
            max_laps=min(self.max_laps, _num(max_laps, self.max_laps)),
            max_hold_s=min(self.max_hold_s, _num(max_hold_s, self.max_hold_s)),
            max_sorties_per_hour=min(
                self.max_sorties_per_hour,
                int(_num(max_sorties_per_hour, self.max_sorties_per_hour)),
            ),
            max_wind_mps=min(self.max_wind_mps, _num(max_wind_mps, self.max_wind_mps)),
            profiles=allowed,
            require_inside_perimeter=True,
            sortie_window_s=self.sortie_window_s,
        )


def _num(value: Any, default: float) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return float(default)
    if result != result:                    # NaN
        return float(default)
    return result


@dataclass(frozen=True)
class DispatchRequest:
    """Everything the envelope check needs about one proposed dispatch.

    All plain numbers/booleans: the caller (the orchestrator) reads config,
    site geometry and health rails and hands the answers in.
    """
    profile: str = ""
    altitude_m: float = 0.0
    laps: float = 0.0
    hold_s: float = 0.0
    inside_perimeter: bool = False
    nav_source: str = "gps"
    rf_interference: bool = False
    hostile_drone: bool = False
    night: bool = False
    thermal_healthy: bool = True
    wind_mps: float = 0.0
    #: Epoch-ms starts of this vehicle's recent sorties (the rate budget is
    #: per vehicle: every rule here is independent per vehicle, ADR D26).
    recent_sortie_starts_ms: Tuple[int, ...] = ()
    now_ms: int = 0


@dataclass(frozen=True)
class EnvelopeCheck:
    """Outcome of :func:`check_unattended`."""
    ok: bool
    violations: Tuple[str, ...] = ()

    @property
    def reason(self) -> str:
        return "; ".join(self.violations)


def check_unattended(
    request: DispatchRequest, envelope: Optional[UnattendedEnvelope] = None
) -> EnvelopeCheck:
    """Is this dispatch inside ``UNATTENDED_ENVELOPE``? (ADR D23)

    Returns EVERY violated constraint, not just the first: the operator who
    reads the escalation should see the whole reason the system declined, and
    a partial reason invites a retry that fails again for the next reason.
    """
    env = envelope if envelope is not None else UnattendedEnvelope()
    bad: list = []

    if env.require_inside_perimeter and not request.inside_perimeter:
        bad.append("outside the site perimeter")

    profile = canonical_profile(request.profile)
    if profile not in env.profiles:
        bad.append(
            f"profile {profile or 'unknown'!r} not permitted unattended "
            f"(allowed: {', '.join(env.profiles)})"
        )

    alt = _num(request.altitude_m, float("nan"))
    if not (env.min_alt_m <= alt <= env.max_alt_m):
        bad.append(
            f"altitude {alt:.0f} m outside the unattended band "
            f"[{env.min_alt_m:.0f}, {env.max_alt_m:.0f}] m"
        )

    laps = _num(request.laps, 0.0)
    if laps > env.max_laps:
        bad.append(f"{laps:g} laps exceeds the unattended maximum of {env.max_laps:g}")

    hold = _num(request.hold_s, 0.0)
    if hold > env.max_hold_s:
        bad.append(
            f"hold {hold:.0f} s exceeds the unattended maximum of "
            f"{env.max_hold_s:.0f} s"
        )

    recent = sorties_in_window(
        request.recent_sortie_starts_ms, request.now_ms, env.sortie_window_s
    )
    if recent >= env.max_sorties_per_hour:
        bad.append(
            f"{recent} sorties already flown in the last hour "
            f"(limit {env.max_sorties_per_hour})"
        )

    if str(request.nav_source or "").lower() != "gps":
        bad.append(f"navSource {request.nav_source or 'unknown'!r} is not gps")
    if request.rf_interference:
        bad.append("RF interference present")
    if request.hostile_drone:
        bad.append("hostile drone detected")
    if request.night and not request.thermal_healthy:
        bad.append("night mission without healthy thermal")

    wind = _num(request.wind_mps, 0.0)
    if wind > env.max_wind_mps:
        bad.append(
            f"wind {wind:.1f} m/s above the unattended limit of "
            f"{env.max_wind_mps:.1f} m/s"
        )

    return EnvelopeCheck(ok=not bad, violations=tuple(bad))


def sorties_in_window(
    starts_ms: Sequence[int], now_ms: int, window_s: float = UNATTENDED_SORTIE_WINDOW_S
) -> int:
    """Count sortie starts inside the trailing ``window_s`` ending at ``now_ms``."""
    try:
        now = int(now_ms)
    except (TypeError, ValueError):
        return 0
    cutoff = now - int(max(0.0, window_s) * 1000.0)
    count = 0
    for value in starts_ms or ():
        try:
            start = int(value)
        except (TypeError, ValueError):
            continue
        if cutoff <= start <= now:
            count += 1
    return count


# --------------------------------------------------------------------------
# The attended / unattended state machine
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class ModeTransition:
    """One attempted mode change and what actually happened."""
    ok: bool
    mode: str
    since_ms: int
    reason: str = ""
    changed: bool = False
    operator_present: bool = False
    #: True when the request was rejected for want of a valid signature -- the
    #: attempt itself is reportable and the orchestrator escalates it.
    refused_unsigned: bool = False


class AttendanceMachine:
    """attended <-> unattended, with the D23 entry and exit rules.

    Entry: a *signed* ``enterUnattended`` and nothing else -- not a config
    value, not an inference from operator silence, not an LLM output.
    Exit: an operator connecting reverts to attended immediately (and so does
    a signed ``exitUnattended``). Reverting never needs a signature: moving
    toward supervision is always allowed.
    """

    def __init__(self, *, now_ms: int = 0, operator_present: bool = True) -> None:
        self._mode = MODE_ATTENDED
        self._since_ms = int(now_ms)
        self._operator_present = bool(operator_present)
        self._operator_id = ""

    # ---- observation -----------------------------------------------------
    @property
    def mode(self) -> str:
        return self._mode

    @property
    def since_ms(self) -> int:
        return self._since_ms

    @property
    def operator_present(self) -> bool:
        return self._operator_present

    @property
    def operator_id(self) -> str:
        """The operator who authorised the current unattended period, if any."""
        return self._operator_id

    @property
    def unattended(self) -> bool:
        return self._mode == MODE_UNATTENDED

    def tag(self) -> str:
        """The mode to stamp on a dispatch/mission record right now."""
        return self._mode

    def message(self, vehicle_id: str, ts_ms: int) -> dict:
        """Build the contract ``mode`` wire message (shared.py ModeMessage)."""
        return {
            "type": "mode",
            "ts": int(ts_ms),
            "vehicleId": str(vehicle_id),
            "mode": self._mode,
            "since": int(self._since_ms),
            "operatorPresent": bool(self._operator_present),
        }

    # ---- transitions -----------------------------------------------------
    def enter_unattended(
        self, *, signature_ok: bool, now_ms: int, operator_id: str = ""
    ) -> ModeTransition:
        """Signed entry into unattended mode (the ONLY way in)."""
        if not signature_ok:
            return ModeTransition(
                ok=False, mode=self._mode, since_ms=self._since_ms,
                reason="enterUnattended requires a valid signed operator command",
                operator_present=self._operator_present, refused_unsigned=True,
            )
        if self._operator_present:
            return ModeTransition(
                ok=False, mode=self._mode, since_ms=self._since_ms,
                reason="an operator is connected; unattended mode reverts on connect",
                operator_present=True,
            )
        if self._mode == MODE_UNATTENDED:
            return ModeTransition(
                ok=True, mode=self._mode, since_ms=self._since_ms,
                reason="already unattended", operator_present=False,
            )
        self._mode = MODE_UNATTENDED
        self._since_ms = int(now_ms)
        self._operator_id = str(operator_id or "")
        return ModeTransition(
            ok=True, mode=self._mode, since_ms=self._since_ms, changed=True,
            reason=f"unattended mode authorised by {self._operator_id or 'operator'}",
            operator_present=False,
        )

    def exit_unattended(
        self, *, signature_ok: bool, now_ms: int, operator_id: str = ""
    ) -> ModeTransition:
        """Signed exit. Always permitted -- the safe direction never needs a key.

        The signature is still verified and recorded (an unsigned exit is an
        attributable event too), but a failed check does NOT keep the vehicle
        unattended: reverting toward supervision wins.
        """
        changed = self._mode != MODE_ATTENDED
        if changed:
            self._mode = MODE_ATTENDED
            self._since_ms = int(now_ms)
        self._operator_id = str(operator_id or "") if changed else self._operator_id
        reason = "attended mode restored" if changed else "already attended"
        return ModeTransition(
            ok=True, mode=self._mode, since_ms=self._since_ms, changed=changed,
            reason=reason if signature_ok else f"{reason} (unsigned request honoured: "
                                               "reverting to supervision is always allowed)",
            operator_present=self._operator_present,
            refused_unsigned=not signature_ok,
        )

    def operator_connected(self, now_ms: int) -> ModeTransition:
        """An operator session appeared: auto-revert to attended (ADR D23)."""
        was_unattended = self._mode == MODE_UNATTENDED
        self._operator_present = True
        if was_unattended:
            self._mode = MODE_ATTENDED
            self._since_ms = int(now_ms)
            self._operator_id = ""
        return ModeTransition(
            ok=True, mode=self._mode, since_ms=self._since_ms,
            changed=was_unattended, operator_present=True,
            reason="operator connected; reverted to attended" if was_unattended
            else "operator connected",
        )

    def operator_disconnected(self, now_ms: int) -> ModeTransition:
        """The last operator session went away.

        This does NOT enter unattended mode. Losing the operator makes the
        vehicle unsupervised, not authorised: only a signed command does that.
        """
        self._operator_present = False
        return ModeTransition(
            ok=True, mode=self._mode, since_ms=self._since_ms, changed=False,
            operator_present=False,
            reason="operator disconnected; mode unchanged (entry needs a signed command)",
        )


__all__ = [
    "ATTENDANCE_MODES",
    "MODE_ATTENDED",
    "MODE_UNATTENDED",
    "PROFILE_ALIASES",
    "UNATTENDED_MAX_HOLD_S",
    "UNATTENDED_MAX_LAPS",
    "UNATTENDED_MAX_ALT_M",
    "UNATTENDED_MAX_SORTIES_PER_HOUR",
    "UNATTENDED_MAX_WIND_MPS",
    "UNATTENDED_MIN_ALT_M",
    "UNATTENDED_PROFILES",
    "UNATTENDED_SORTIE_WINDOW_S",
    "AttendanceMachine",
    "DispatchRequest",
    "EnvelopeCheck",
    "ModeTransition",
    "UnattendedEnvelope",
    "canonical_profile",
    "check_unattended",
    "sorties_in_window",
]
