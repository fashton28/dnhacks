"""
============================================================================
Drone Safety Platform -- COMPANION safety manager (PRD 11)
----------------------------------------------------------------------------
Pure-logic safety rules shared by the orchestrator and by the FC layer that
sits next door. Stdlib only -- nothing here imports pymavlink, numpy or a
camera -- so every rule below is unit-testable on a laptop with no vehicle.

Five concerns live in this module:

  1. GROUND-LINK DEADMAN (``SafetyManager.evaluate_link``). Any authorised
     inbound control-WS frame counts as a ground heartbeat. While the operator
     is actively steering -- tracking, manual or planner is the active control
     source -- a link that goes quiet for longer than
     ``Limits.ground_link_timeout_ms`` must stop guidance, zero-and-hold and
     escalate (RTL airborne, HOLD on the ground). In plain ``auto`` the stale
     link is REPORTED but no companion action is commanded from here: the
     firmware's own FS_GCS_* failsafe is that backstop, and an unattended
     ``auto`` flight has no operator to have lost.
  2. ARMING PRECONDITIONS (``SafetyManager.check_arming``). A conservative
     checklist over a ``VehicleState`` plus the raw GPS / EKF / battery rails
     the FC layer fills in. Anything not positively confirmed is a failure or
     a warning, never a silent pass. Structured result; never raises.
  3. EMERGENCY STOP (``SafetyManager.emergency_stop_plan``). ``emergencyStop``
     and kill resolve -- with no confirmation and priority over everything --
     to a concrete plan: drop every control source, zero the setpoint, then
     LAND (airborne) or force-disarm (on the ground).
  4. FC-EGRESS CLAMP (``clamp_body_velocity`` / ``clamp_goto_target``). The
     second stage of the "clamped twice" rule. The FC layer runs every BODY
     velocity setpoint and every GUIDED position target through these
     immediately before the wire. These stages can only ever TIGHTEN what
     guidance/manual already clamped, and a non-finite value on ANY axis
     collapses the whole command to the zero hold -- never to a bound. That
     distinction is the whole point: under CPython ``min(hi, nan)`` is ``hi``,
     which is how one NaN once became full forward + full right + full descent
     + max yaw at the same instant.
  5. FLASHED FAILSAFE ENVELOPE (``failsafe_param_map``). The ArduCopter
     parameter table -- geofence, battery / GCS / RC / EKF failsafes, RTL
     behaviour, WPNAV speed caps, arming checks -- derived from the SAME
     ``Limits`` the software clamps use, returned as a flat dict so it can be
     tabled in ``docs/flashing.md``, pushed by ``Vehicle.apply_failsafe_params``
     and diffed against a live parameter fetch.

DESIGN: no module-global mutable state. Every rule takes its dependencies
(``Limits``, ``VehicleState``, timestamps, the requested site radius) as
arguments; ``SafetyManager`` owns only the ground-heartbeat bookkeeping it is
explicitly handed.

RC OVERRIDE ALWAYS WINS. Nothing in this module -- nor anywhere else in the
companion -- emits RC_CHANNELS_OVERRIDE or MANUAL_CONTROL. The pilot flipping
a mode switch on the transmitter supersedes every companion command, and the
flashed parameter table below is written to keep it that way.
============================================================================
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional, Tuple

from eis_companion.types import (
    ControlSource,
    Limits,
    VehicleState,
    VelocitySetpoint,
)


# --------------------------------------------------------------------------
# Result shapes the orchestrator consumes (field names are contract surface)
# --------------------------------------------------------------------------
class FailsafeAction(str, Enum):
    """What the orchestrator should do, ordered by escalation severity."""
    NONE = "none"          # link healthy, carry on
    HOLD = "hold"          # zero setpoint, hold position (GUIDED zero-vel / BRAKE)
    RTL = "rtl"            # return to launch
    LAND = "land"          # descend and disarm where we are
    DISARM = "disarm"      # cut motors (only safe on the ground)


@dataclass
class LinkStatus:
    """Result of evaluating the ground-link deadman for one tick."""
    alive: bool                       # heartbeat seen within the timeout window
    age_ms: float                     # ms since the last ground heartbeat
    tripped: bool                     # deadman tripped (stale AND link mattered)
    action: FailsafeAction            # what to do this tick
    reason: str = ""                  # human-readable status text


@dataclass
class ArmCheckResult:
    """Outcome of the arming-precondition checklist. Never raises."""
    ok: bool
    failures: list = field(default_factory=list)   # list[str], human-readable
    warnings: list = field(default_factory=list)   # list[str], non-blocking

    @property
    def message(self) -> str:
        if not self.ok:
            return "Arming blocked: " + "; ".join(self.failures)
        text = "Arming preconditions OK"
        if self.warnings:
            text += " (warnings: " + "; ".join(self.warnings) + ")"
        return text


@dataclass
class EmergencyPlan:
    """Concrete, no-confirmation action plan for emergencyStop / kill."""
    disengage_tracking: bool = True
    release_manual: bool = True
    zero_setpoint: bool = True
    set_control_source: str = ControlSource.AUTO.value
    action: FailsafeAction = FailsafeAction.LAND
    force_disarm: bool = False        # emergency (force) disarm even if airborne
    reason: str = "emergencyStop"


def now_ms() -> float:
    """Wall-clock in milliseconds (float)."""
    return time.time() * 1000.0


# --------------------------------------------------------------------------
# Constants: pack chemistry, containment geometry, RTL band
# --------------------------------------------------------------------------
# Battery thresholds are expressed PER CELL so one table can never be
# mis-flashed onto a pack it was not written for. DEFAULT_PACK_CELLS matches
# companion/config/default.yaml and the airframe BOM (4S 5000 mAh); a 3S build
# passes cell_count=3. Erring high is the safe direction -- too high only
# nuisance-trips the failsafe, too low disables it entirely.
DEFAULT_PACK_CELLS: int = 4
CELL_LOW_VOLT: float = 3.5   # V/cell -- warning (BATT_FS_LOW_ACT -> RTL)
CELL_CRT_VOLT: float = 3.3   # V/cell -- critical (BATT_FS_CRT_ACT -> LAND)

#: Series counts a LiPo can plausibly have. Anything outside the band is a
#: mis-typed config, and the table degrades to the documented BOM pack rather
#: than flashing a threshold nobody meant.
_PACK_CELL_BAND: Tuple[int, int] = (1, 12)

#: Fallback cylinder radius when the caller supplies no site geometry (shared
#: DEFAULTS.geofence_radius). It is a FALLBACK, not a policy: a 60 m circle
#: around home fences a plant-scale site into its own launch pad, so the first
#: outbound leg breaches and the firmware RTLs mid-mission -- which looks
#: exactly like a real safety event (FM-155).
DEFAULT_GEOFENCE_RADIUS_M: float = 60.0
MIN_GEOFENCE_RADIUS_M: float = 20.0

#: RTL climbs to RTL_ALT before coming home, so the rung is bounded: never
#: below the floor, never above the cap, and always kept under the altitude
#: fence by the margin so RTL itself cannot breach FENCE_ALT_MAX.
_RTL_ALT_FLOOR_M: float = 5.0
_RTL_ALT_CAP_M: float = 15.0
_RTL_FENCE_MARGIN_M: float = 2.0

#: The control sources that put a live ground operator in the loop. Only these
#: arm the companion-side deadman; plain ``auto`` is the firmware's problem.
_OPERATOR_STEERED: frozenset = frozenset({
    ControlSource.TRACKING.value,
    ControlSource.MANUAL.value,
    ControlSource.PLANNER.value,
})


# --------------------------------------------------------------------------
# Numeric hygiene. Every "unusable value" in this module funnels through here
# so the safe answer is decided once instead of at eleven call sites.
# --------------------------------------------------------------------------
def _finite(value: Any) -> Optional[float]:
    """``float(value)`` when it is numeric AND finite, else ``None``.

    ``None`` is deliberately not a number: callers must decide what the SAFE
    substitute is for their axis rather than inheriting a silent 0/inf.
    """
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _source_value(control_source: Any) -> str:
    """The contract literal for a ``ControlSource`` member OR a plain string."""
    return str(getattr(control_source, "value", control_source))


def _pack_cells(cell_count: Any) -> int:
    """Clamp to a sane LiPo series count; a bad value degrades to the BOM pack."""
    try:
        cells = int(cell_count)
    except (TypeError, ValueError):
        return DEFAULT_PACK_CELLS
    low, high = _PACK_CELL_BAND
    return cells if low <= cells <= high else DEFAULT_PACK_CELLS


# --------------------------------------------------------------------------
# 4. FC-egress clamp -- the second stage of "clamped twice"
# --------------------------------------------------------------------------
def _bound(limit: Any) -> float:
    """A symmetric envelope bound as ``|limit|``; an unusable bound is 0.

    Zero is the safe collapse: a limit we cannot read bounds its axis at "no
    motion" rather than at "whatever number happened to be in the field".
    """
    value = _finite(limit)
    return abs(value) if value is not None else 0.0


def _within(value: float, bound: float) -> float:
    """Fold ``value`` into ``[-bound, +bound]`` (both already finite)."""
    if value > bound:
        return bound
    if value < -bound:
        return -bound
    return value


def _into_band(value: Any, ceiling: Any) -> float:
    """Fold ``value`` into ``[0, ceiling]``; anything unusable becomes 0.

    Zero is the safe end of both bands this serves: a zero leg speed is
    REFUSED by the FC layer (nothing flies), a zero altitude is "stay low".
    """
    number = _finite(value)
    cap = _finite(ceiling)
    if number is None or cap is None:
        return 0.0
    return min(max(0.0, number), max(0.0, cap))


def clamp_body_velocity(
    setpoint: VelocitySetpoint, limits: Limits
) -> VelocitySetpoint:
    """Clamp a BODY-frame velocity setpoint to ``limits``, right before the FC.

    Applied in order:

      * ``valid=False`` IS the hold command -- every axis zero, ``valid``
        stays False. (The FC layer still puts that frame on the wire so
        GUIDED actively holds instead of coasting on a stale target.)
      * a non-numeric or NON-FINITE value on ANY axis collapses the WHOLE
        setpoint to the hold. Never to a bound, and never axis-by-axis:
        three good axes plus one NaN is not a command worth trusting.
      * otherwise |vx|, |vy| <= ``max_speed``, |vz| <= ``max_climb_rate``,
        |yaw_rate| <= ``max_yaw_rate``. A limit that is itself unusable
        bounds its own axis at zero.

    This stage can only TIGHTEN. The guidance / manual layers own the envelope
    and clamp first (including any temporary speed scaling the orchestrator
    applies); nothing here can raise a value they already lowered.
    """
    if not getattr(setpoint, "valid", False):
        return VelocitySetpoint.hold()

    axes = [
        _finite(getattr(setpoint, name, None))
        for name in ("vx", "vy", "vz", "yaw_rate")
    ]
    if any(axis is None for axis in axes):
        return VelocitySetpoint.hold()

    horizontal = _bound(getattr(limits, "max_speed", 0.0))
    bounds = (
        horizontal,
        horizontal,
        _bound(getattr(limits, "max_climb_rate", 0.0)),
        _bound(getattr(limits, "max_yaw_rate", 0.0)),
    )
    vx, vy, vz, yaw_rate = (
        _within(float(axis), bound) for axis, bound in zip(axes, bounds)
    )
    return VelocitySetpoint(vx=vx, vy=vy, vz=vz, yaw_rate=yaw_rate, valid=True)


def clamp_speed_for_fc(speed: Any, limits: Limits) -> float:
    """Leg groundspeed for a GUIDED target, folded into ``[0, max_speed]``.

    Deliberately NOT floored at ``Limits.min_speed``: that floor exists for
    guidance usability, and applying it here would turn a profile the config
    floor degraded to 0.0 ("no motion, safe direction") into real motion. A
    requested speed is never raised, only lowered.
    """
    return _into_band(speed, getattr(limits, "max_speed", 0.0))


def clamp_altitude_for_fc(rel_alt: Any, limits: Limits) -> float:
    """Altitude above home for a GUIDED target: ``[0, Limits.max_altitude]``."""
    return _into_band(rel_alt, getattr(limits, "max_altitude", 0.0))


def clamp_goto_target(
    speed: Any, rel_alt: Any, limits: Limits
) -> Tuple[float, float]:
    """The FC-egress clamp for the planner's global-position path.

    Returns ``(speed, rel_alt)`` ready for the wire. Global position targets
    bypass the orchestrator's per-tick body-velocity clamp, so THIS is the
    second clamp for that path. A non-finite speed lands on 0.0, which the FC
    layer reads as "refuse the leg": ArduPilot denies a non-positive
    DO_CHANGE_SPEED and would otherwise fly the leg at its previous guided
    speed, which is exactly the opposite of not moving.
    """
    return clamp_speed_for_fc(speed, limits), clamp_altitude_for_fc(rel_alt, limits)


# --------------------------------------------------------------------------
# The manager: deadman bookkeeping + arming checklist + e-stop mapping
# --------------------------------------------------------------------------
class SafetyManager:
    """Stateless-by-design safety coordinator (PRD 11).

    The only mutable state it owns is the ground-heartbeat bookkeeping;
    everything else is passed in per call. Construct one per companion
    process and hand it the live ``Limits`` (the operator may edit standoff /
    max-speed at runtime, and ``update_limits`` swaps the envelope in place).
    """

    def __init__(
        self, limits: Limits, *, clock_ms: Callable[[], float] = now_ms
    ) -> None:
        self._limits = limits
        self._clock_ms = clock_ms
        # A freshly started companion has not lost a ground station it never
        # had: seed the last heartbeat to "now" so the ticks before the
        # operator first connects are not already a tripped deadman.
        self._last_ground_hb_ms: float = float(clock_ms())
        # When the deadman tripped (clock ms), or None while it is clear.
        # Storing the INSTANT rather than a bare flag keeps the latch readable
        # (how long have we been down?) and makes escalation monotonic: the
        # ladder only ever climbs from here, and only a heartbeat clears it.
        self._tripped_since_ms: Optional[float] = None

    # -- limits may be swapped at runtime (operator edits) ------------------
    @property
    def limits(self) -> Limits:
        return self._limits

    def update_limits(self, limits: Limits) -> None:
        self._limits = limits

    # ----------------------------------------------------------------------
    # 1. Ground-link deadman
    # ----------------------------------------------------------------------
    @property
    def deadman_latched(self) -> bool:
        """True from the tick the deadman tripped until a heartbeat clears it."""
        return self._tripped_since_ms is not None

    def deadman_down_ms(self) -> float:
        """How long the deadman has been latched (0.0 while it is clear)."""
        if self._tripped_since_ms is None:
            return 0.0
        return max(0.0, self._clock_ms() - self._tripped_since_ms)

    def note_ground_heartbeat(self, ts_ms: Optional[float] = None) -> None:
        """Record one inbound frame from the ground station.

        Call this for *every* authorised inbound control-WS message (command,
        manualInput, an explicit ping -- anything). Clears the deadman latch.
        """
        self._last_ground_hb_ms = (
            self._clock_ms() if ts_ms is None else float(ts_ms)
        )
        self._tripped_since_ms = None

    def ground_link_age_ms(self) -> float:
        """Milliseconds since the last ground heartbeat."""
        return self._clock_ms() - self._last_ground_hb_ms

    def evaluate_link(
        self,
        control_source: str,
        *,
        airborne: bool = True,
    ) -> LinkStatus:
        """Evaluate the ground-link deadman for the active control source.

        Three outcomes, resolved in this order:

          1. the link answered inside ``Limits.ground_link_timeout_ms`` --
             healthy, latch cleared, no action;
          2. the link is stale but nobody was steering (``auto``) -- reported
             as not-alive, NOT tripped, and no companion action: the
             firmware's FS_GCS_* failsafe is the backstop for that case;
          3. the link is stale AND the operator was in the loop -- the deadman
             trips. The orchestrator zeroes and holds on any trip; the rung we
             name here is RTL while airborne (come home rather than hover
             until the pack dies) and HOLD on the ground (nothing to bring
             back, and an unsolicited climb would be worse).

        PRD 11: "ground-link loss while tracking must stop guidance
        immediately". An executing mission plan is an operator-approved
        activity and gets exactly the same protection.

        Args:
          control_source: the active ControlSource -- an enum member or its
            contract literal ('auto' / 'tracking' / 'manual' / 'planner').
          airborne: whether the vehicle is airborne.

        Returns:
          LinkStatus describing the link and the action to take this tick.
        """
        age = self.ground_link_age_ms()
        timeout = float(self._limits.ground_link_timeout_ms)
        # Written as "not (age <= timeout)" on purpose: an unusable age must
        # read as STALE, and a NaN comparison is False either way round.
        stale = not (age <= timeout)
        source = _source_value(control_source)

        if not stale:
            self._tripped_since_ms = None
            return LinkStatus(
                alive=True,
                age_ms=age,
                tripped=False,
                action=FailsafeAction.NONE,
                reason="ground link healthy",
            )

        if source not in _OPERATOR_STEERED:
            return LinkStatus(
                alive=False,
                age_ms=age,
                tripped=False,
                action=FailsafeAction.NONE,
                reason=(
                    f"ground link stale ({age:.0f}ms) but source={source}; "
                    "FC GCS failsafe is the backstop"
                ),
            )

        if self._tripped_since_ms is None:
            self._tripped_since_ms = self._clock_ms()
        action = FailsafeAction.RTL if airborne else FailsafeAction.HOLD
        return LinkStatus(
            alive=False,
            age_ms=age,
            tripped=True,
            action=action,
            reason=(
                f"DEADMAN: no ground heartbeat for {age:.0f}ms "
                f"(> {timeout:.0f}ms) while {source} active -> "
                f"stop guidance, hold, {action.value}"
            ),
        )

    # ----------------------------------------------------------------------
    # 2. Arming preconditions
    # ----------------------------------------------------------------------
    def check_arming(
        self,
        state: VehicleState,
        *,
        gps_fix_type: int = 0,
        gps_satellites: int = 0,
        gps_hdop: float = 99.0,
        battery_voltage: float = 0.0,
        battery_remaining: float = 0.0,
        ekf_ok: bool = True,
        prearm_ok: bool = True,
        min_satellites: int = 6,
        max_hdop: float = 2.5,
        min_battery_voltage: float = 0.0,
        min_battery_remaining: float = 20.0,
        require_gps: bool = True,
    ) -> ArmCheckResult:
        """Conservative arming checklist (PRD 11: enforce arming preconditions).

        Every rule is a ``(applies, failed, message)`` triple evaluated in
        report order -- GPS, then the estimator, then the FC's own prearm
        verdict, then the pack -- so the reason the operator reads matches the
        order a human would walk the aircraft.

        Defaults are the SAFE answer: anything we cannot positively confirm is
        a failure or a warning, never a silent pass. Never raises.

        Most rules mirror checks the FC also enforces (ArduCopter PREARM), but
        gating companion-side too means the operator gets a clear contract
        ``statusText`` instead of a silent FC arm refusal.
        """
        # A pack rail only gates when it is actually REPORTING. A voltage or
        # SoC of zero is "no telemetry", not "an empty battery", and must not
        # block arming on its own -- it is a warning below.
        reporting_voltage = battery_voltage > 0.0
        reporting_soc = battery_remaining > 0.0

        rules: Tuple[Tuple[bool, bool, str], ...] = (
            # ArduPilot fix types: 0/1 = none, 2 = 2D, 3 = 3D, 4+ = DGPS/RTK.
            (
                require_gps,
                gps_fix_type < 3,
                f"no 3D GPS fix (fixType={gps_fix_type})",
            ),
            (
                require_gps,
                gps_satellites < min_satellites,
                f"too few satellites ({gps_satellites} < {min_satellites})",
            ),
            (
                require_gps,
                gps_hdop > max_hdop,
                f"GPS HDOP too high ({gps_hdop:.1f} > {max_hdop:.1f})",
            ),
            (True, not ekf_ok, "EKF / attitude estimate not healthy"),
            (True, not prearm_ok, "FC reports prearm checks failing"),
            (
                min_battery_voltage > 0.0 and reporting_voltage,
                battery_voltage < min_battery_voltage,
                f"battery voltage low ({battery_voltage:.1f}V < "
                f"{min_battery_voltage:.1f}V)",
            ),
            (
                reporting_soc,
                battery_remaining < min_battery_remaining,
                f"battery remaining low ({battery_remaining:.0f}% < "
                f"{min_battery_remaining:.0f}%)",
            ),
        )
        failures: List[str] = [
            message for applies, failed, message in rules if applies and failed
        ]

        warnings: List[str] = []
        if state.armed:
            warnings.append("already armed")
        if not reporting_voltage and not reporting_soc:
            warnings.append("no battery telemetry yet")

        return ArmCheckResult(ok=not failures, failures=failures, warnings=warnings)

    # ----------------------------------------------------------------------
    # 3. Emergency stop / kill mapping
    # ----------------------------------------------------------------------
    def emergency_stop_plan(
        self,
        state: VehicleState,
        *,
        prefer_land: bool = True,
    ) -> EmergencyPlan:
        """Resolve ``emergencyStop`` into a concrete, no-confirmation plan.

        PRD 6.1 / 11: emergencyStop immediately disengages tracking AND
        releases manual control, zeroes the setpoint, and LANDs (airborne) or
        force-disarms (already on the ground). It overrides everything and
        never asks for confirmation.

        ``prefer_land=False`` selects BRAKE-then-hold instead of LAND while
        airborne -- for an operator who wants to keep position and take over
        manually rather than come down.
        """
        if not state.airborne:
            # On the ground: kill the motors. The force flag covers a vehicle
            # stuck in an auto mode that would otherwise refuse a plain disarm.
            return EmergencyPlan(
                action=FailsafeAction.DISARM,
                force_disarm=True,
                reason="emergencyStop (on ground -> force disarm)",
            )
        action = FailsafeAction.LAND if prefer_land else FailsafeAction.HOLD
        return EmergencyPlan(
            action=action,
            force_disarm=False,
            reason=f"emergencyStop (airborne -> {action.value})",
        )

    # ----------------------------------------------------------------------
    # 5. Geofence + failsafe param map
    # ----------------------------------------------------------------------
    def failsafe_param_map(
        self,
        *,
        cell_count: int = DEFAULT_PACK_CELLS,
        geofence_radius_m: Optional[float] = None,
    ) -> dict:
        """The ArduCopter PARAM map for this manager's CURRENT ``Limits``.

        Thin instance wrapper around the module-level
        :func:`failsafe_param_map`. ``cell_count`` must match the physical
        pack (``config.battery.cell_count``); ``geofence_radius_m`` is the
        loaded site's containment radius when there is one.
        """
        return failsafe_param_map(
            self._limits,
            cell_count=cell_count,
            geofence_radius_m=geofence_radius_m,
        )


# --------------------------------------------------------------------------
# 5. Module-level geofence + failsafe PARAM map (no SafetyManager needed)
# --------------------------------------------------------------------------
def _containment_radius_m(requested: Optional[float]) -> float:
    """Geofence cylinder radius (m) -- the SITE's, when the caller knows it.

    ``Limits`` carries no fence radius, so the caller passes the site's own
    containment radius (home -> farthest perimeter vertex, plus margin). The
    result never drops below ``MIN_GEOFENCE_RADIUS_M``, so a misconfig cannot
    quietly disable containment, and it falls back to the shared default when
    no site is loaded or the value is unusable.
    """
    fallback = max(MIN_GEOFENCE_RADIUS_M, DEFAULT_GEOFENCE_RADIUS_M)
    value = _finite(requested) if requested is not None else None
    if value is None or value <= 0.0:
        return fallback
    return max(MIN_GEOFENCE_RADIUS_M, value)


def _rtl_altitude_cm(limits: Limits) -> float:
    """RTL climb altitude in CENTIMETRES, kept under the altitude fence.

    ``min(cap, max(floor, fence_alt - margin))`` -- so the climb RTL performs
    on its way home can never itself breach FENCE_ALT_MAX.
    """
    under_fence = float(limits.max_altitude) - _RTL_FENCE_MARGIN_M
    rtl_m = min(_RTL_ALT_CAP_M, max(_RTL_ALT_FLOOR_M, under_fence))
    return rtl_m * 100.0


def _fence_params(
    limits: Limits, geofence_radius_m: Optional[float]
) -> Dict[str, float]:
    """A hard cylinder: FENCE_TYPE bit0 = altitude (1) | bit1 = circle (2)."""
    return {
        "FENCE_ENABLE": 1.0,
        "FENCE_TYPE": 3.0,
        "FENCE_ACTION": 1.0,            # 1 = RTL or LAND (breach -> come back)
        "FENCE_RADIUS": float(_containment_radius_m(geofence_radius_m)),
        "FENCE_ALT_MAX": float(limits.max_altitude),
        "FENCE_MARGIN": 2.0,            # m, start reacting before the hard edge
    }


def _battery_params(cells: int) -> Dict[str, float]:
    """Two-stage pack failsafe: warn (RTL) then critical (LAND).

    Thresholds are derived per cell so a 3S table (10.5 V) can never be
    flashed onto the 4S BOM pack, where it would sit at 2.6 V/cell -- below
    the point the pack is already destroyed, so the failsafe would never fire.
    """
    return {
        "BATT_MONITOR": 4.0,            # 4 = voltage + current
        "BATT_FS_LOW_ACT": 2.0,         # 2 = RTL on low battery
        "BATT_FS_CRT_ACT": 1.0,         # 1 = LAND on critical battery
        "BATT_LOW_VOLT": round(CELL_LOW_VOLT * cells, 2),
        "BATT_CRT_VOLT": round(CELL_CRT_VOLT * cells, 2),
        "BATT_LOW_TIMER": 10.0,         # s sustained before acting
    }


def _ground_link_params(limits: Limits) -> Dict[str, float]:
    """The FC's own version of the companion deadman; the two are layered."""
    timeout_s = float(limits.ground_link_timeout_ms) / 1000.0
    return {
        "FS_GCS_ENABLE": 1.0,           # 1 = RTL on GCS heartbeat loss
        "FS_GCS_TIMEOUT": max(1.0, timeout_s),
    }


def _rc_params() -> Dict[str, float]:
    """RC OVERRIDE PRIMACY.

    The throttle failsafe fires only when the transmitter is genuinely gone;
    while it is alive the pilot keeps full authority and the companion never
    sends an RC override. Flipping the mode switch out of GUIDED takes the
    aircraft away from us instantly, by design.
    """
    return {
        "FS_THR_ENABLE": 1.0,           # 1 = enabled, RTL on loss
        "FS_THR_VALUE": 975.0,          # us threshold below which RC is "lost"
    }


def _ekf_params() -> Dict[str, float]:
    return {
        "FS_EKF_ACTION": 1.0,           # 1 = land/hold on EKF failure
        "FS_EKF_THRESH": 0.8,
    }


def _rtl_params(limits: Limits) -> Dict[str, float]:
    return {
        "RTL_ALT": float(_rtl_altitude_cm(limits)),  # cm, climb before returning
        "RTL_ALT_FINAL": 0.0,           # 0 = land at home after RTL
    }


def _speed_params(limits: Limits) -> Dict[str, float]:
    """cm/s. WPNAV_SPEED bounds GUIDED horizontal velocity inside the firmware,
    so the flashed cap is the same number the runtime clamp uses."""
    horizontal = float(limits.max_speed) * 100.0
    vertical = float(limits.max_climb_rate) * 100.0
    return {
        "WPNAV_SPEED": horizontal,
        "WPNAV_SPEED_UP": vertical,
        "WPNAV_SPEED_DN": vertical,
        "PILOT_SPEED_UP": vertical,
    }


def _arming_params() -> Dict[str, float]:
    """ARMING_CHECK 1 = every check (GPS, EKF, battery, ...).

    Never disabled for a real flight; SITL bring-up may relax it temporarily.
    """
    return {
        "ARMING_CHECK": 1.0,
        "GPS_HDOP_GOOD": 250.0,         # 0.01 units -> HDOP 2.5 gate
    }


def failsafe_param_map(
    limits: Limits,
    *,
    cell_count: int = DEFAULT_PACK_CELLS,
    geofence_radius_m: Optional[float] = None,
) -> dict:
    """Return the exact ArduCopter parameters to flash for a safe vehicle.

    A flat ``dict[str, float]`` (param name -> value) in a stable, grouped
    order so it can be:
      * tabled verbatim in ``docs/flashing.md``,
      * pushed to the FC by ``Vehicle.apply_failsafe_params`` (one echo-
        verified PARAM_SET per entry), and
      * diffed against a live param fetch for verification.

    Every value derives from ``Limits`` / the shared DEFAULTS, so the flashed
    envelope is the same envelope the runtime clamp enforces. The groups, in
    order: geofence, battery failsafe, GCS-link failsafe, RC failsafe, EKF
    failsafe, RTL behaviour, speed envelope, arming checks.

    CRITICAL -- RC OVERRIDE ALWAYS WINS (PRD 11). No entry in this table
    teaches the firmware to ignore its pilot. FS_THR_ENABLE is on so that a
    transmitter which genuinely disappears triggers a safe action; for as long
    as the TX is answering, the stick and the mode switch outrank everything
    the companion has to say, and the companion never sends anything but
    GUIDED setpoints in the first place.
    """
    cells = _pack_cells(cell_count)
    groups: Tuple[Dict[str, float], ...] = (
        _fence_params(limits, geofence_radius_m),
        _battery_params(cells),
        _ground_link_params(limits),
        _rc_params(),
        _ekf_params(),
        _rtl_params(limits),
        _speed_params(limits),
        _arming_params(),
    )
    params: Dict[str, float] = {}
    for group in groups:
        params.update(group)
    return params


__all__ = [
    "SafetyManager",
    "ArmCheckResult",
    "LinkStatus",
    "EmergencyPlan",
    "FailsafeAction",
    "failsafe_param_map",
    "clamp_body_velocity",
    "clamp_speed_for_fc",
    "clamp_altitude_for_fc",
    "clamp_goto_target",
    "DEFAULT_PACK_CELLS",
    "CELL_LOW_VOLT",
    "CELL_CRT_VOLT",
    "DEFAULT_GEOFENCE_RADIUS_M",
    "MIN_GEOFENCE_RADIUS_M",
    "now_ms",
]
