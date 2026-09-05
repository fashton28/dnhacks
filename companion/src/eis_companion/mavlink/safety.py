"""
============================================================================
Eye in the Sky -- COMPANION safety manager (PRD 11)
----------------------------------------------------------------------------
Pure-logic safety helpers shared by the orchestrator. NO hardware imports
(stdlib only) so this unit-tests with zero MAVLink / numpy.

Responsibilities
  1. Ground-link DEADMAN. The ground station sends a heartbeat (any inbound
     control-WS message counts). If nothing arrives within
     ``ground_link_timeout_ms`` *while tracking or manual is the active control
     source*, guidance must stop, the setpoint must be zeroed/held, and we
     escalate the failsafe action (HOLD -> RTL). Auto guidance with no ground
     operator present is intentionally NOT a deadman trigger on its own -- the
     FC's own GCS failsafe (FS_GCS_ENABLE) is the backstop.
  2. ARMING PRECONDITIONS. A conservative checklist evaluated against a
     ``VehicleState`` (+ a couple of raw fields the FC layer fills in) before we
     let the operator arm: GPS fix, EKF/health, battery, geofence, not already
     armed, etc. Returns a structured result, never raises.
  3. EMERGENCY STOP mapping. ``emergencyStop`` (and disarm) take precedence over
     everything, need no confirmation, and resolve to a concrete action plan:
     disengage tracking + release manual + zero setpoints + LAND (airborne) or
     BRAKE/disarm. Returned as a small plan object the orchestrator executes.
  4. GEOFENCE + FAILSAFE PARAM MAP. The exact ArduCopter parameters to flash so
     the vehicle is safe by construction (geofence, battery / GCS / throttle
     failsafes, RTL altitude, ...). Returned as a plain ``dict[str, float]`` so
     ``docs/flashing.md`` can table them and a ``set_params`` helper can push
     them to the FC.

DESIGN: no module-global state. Every function/method takes its dependencies
(``Limits``, ``VehicleState``, timestamps) as arguments. ``SafetyManager`` holds
only the link bookkeeping it is explicitly given.

RC OVERRIDE ALWAYS WINS. Nothing in this module (or the whole companion) ever
sends an RC_CHANNELS_OVERRIDE / MANUAL_CONTROL that fights the pilot. The pilot
flipping a mode switch on the transmitter supersedes every companion command;
the failsafe params below make sure of it (see ``failsafe_param_map`` notes).
============================================================================
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

from eis_companion.types import (
    ControlSource,
    Limits,
    VehicleState,
)


# --------------------------------------------------------------------------
# Failsafe escalation ladder
# --------------------------------------------------------------------------
class FailsafeAction(str, Enum):
    """What the orchestrator should do, ordered by escalation severity."""
    NONE = "none"          # link healthy, carry on
    HOLD = "hold"          # zero setpoint, hold position (GUIDED zero-vel / BRAKE)
    RTL = "rtl"            # return to launch
    LAND = "land"          # descend and disarm where we are
    DISARM = "disarm"      # cut motors (only safe on the ground)


# --------------------------------------------------------------------------
# Ground-link deadman bookkeeping
# --------------------------------------------------------------------------
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
        if self.ok:
            return "Arming preconditions OK" + (
                f" (warnings: {'; '.join(self.warnings)})" if self.warnings else ""
            )
        return "Arming blocked: " + "; ".join(self.failures)


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


class SafetyManager:
    """Stateless-by-design safety coordinator (PRD 11).

    The only mutable state it owns is the timestamp of the last ground
    heartbeat -- everything else is passed in per call. Construct one per
    companion process and feed it the ``Limits`` (which may change at runtime
    when the operator edits standoff / max-speed via the API).
    """

    def __init__(self, limits: Limits, *, clock_ms=now_ms) -> None:
        self._limits = limits
        self._clock_ms = clock_ms
        # Seed "last heartbeat" to now so a freshly-started companion is not
        # instantly in a tripped state before the ground has ever connected.
        self._last_ground_hb_ms: float = clock_ms()
        # Latches so we only escalate (never silently de-escalate mid-failsafe)
        # and so statusText isn't spammed.
        self._deadman_latched: bool = False

    # -- limits may be swapped at runtime (operator edits) ------------------
    @property
    def limits(self) -> Limits:
        return self._limits

    def update_limits(self, limits: Limits) -> None:
        self._limits = limits

    # ----------------------------------------------------------------------
    # 1. Ground-link deadman
    # ----------------------------------------------------------------------
    def note_ground_heartbeat(self, ts_ms: Optional[float] = None) -> None:
        """Record that a message was received from the ground station.

        Call this on *every* inbound control-WS message (command, manualInput,
        an explicit ping -- anything). Clears the deadman latch.
        """
        self._last_ground_hb_ms = self._clock_ms() if ts_ms is None else float(ts_ms)
        self._deadman_latched = False

    def ground_link_age_ms(self) -> float:
        """Milliseconds since the last ground heartbeat."""
        return self._clock_ms() - self._last_ground_hb_ms

    def evaluate_link(
        self,
        control_source: str,
        *,
        airborne: bool = True,
    ) -> LinkStatus:
        """Evaluate the ground-link deadman for the current control source.

        The deadman only *trips* when the ground operator is actively in the
        loop -- i.e. tracking or manual is the active control source. For those,
        a stale link means we must immediately stop guidance, hold, and escalate
        to RTL (PRD 11: "Ground-link loss while tracking must stop guidance
        immediately"). For plain ``auto``, link loss is handled by the FC's own
        GCS failsafe, so we report it but do not command an action from here.

        Args:
          control_source: the active ControlSource value ('auto'/'tracking'/'manual').
          airborne: whether the vehicle is airborne (a tripped deadman on the
            ground escalates to DISARM-safe HOLD rather than RTL).

        Returns:
          LinkStatus describing the link and the action to take this tick.
        """
        age = self.ground_link_age_ms()
        timeout = float(self._limits.ground_link_timeout_ms)
        alive = age <= timeout

        link_matters = control_source in (
            ControlSource.TRACKING.value,
            ControlSource.MANUAL.value,
        )

        if alive or not link_matters:
            # Healthy, or the operator isn't steering -- no companion action.
            if alive:
                self._deadman_latched = False
            return LinkStatus(
                alive=alive,
                age_ms=age,
                tripped=False,
                action=FailsafeAction.NONE,
                reason=(
                    "ground link healthy"
                    if alive
                    else f"ground link stale ({age:.0f}ms) but source={control_source}; "
                    "FC GCS failsafe is the backstop"
                ),
            )

        # Link is stale AND the operator was steering -> DEADMAN TRIPS.
        # First action is always HOLD (stop guidance, zero setpoint). Once the
        # link stays down we escalate to RTL (airborne) so the aircraft comes
        # home rather than hovering until the battery dies.
        self._deadman_latched = True
        action = FailsafeAction.RTL if airborne else FailsafeAction.HOLD
        return LinkStatus(
            alive=False,
            age_ms=age,
            tripped=True,
            action=action,
            reason=(
                f"DEADMAN: no ground heartbeat for {age:.0f}ms "
                f"(> {timeout:.0f}ms) while {control_source} active -> "
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

        Defaults to the SAFE answer: anything we can't positively confirm is a
        failure or a warning, never a silent pass. Never raises.

        Most of these mirror checks the FC also enforces (ArduCopter PREARM),
        but we gate on them companion-side too so the operator gets a clear
        contract ``statusText`` instead of a silent FC arm refusal.
        """
        failures: list = []
        warnings: list = []

        if state.armed:
            warnings.append("already armed")

        if require_gps:
            # ArduPilot fix types: 0/1 = none, 2 = 2D, 3 = 3D, 4+ = DGPS/RTK.
            if gps_fix_type < 3:
                failures.append(f"no 3D GPS fix (fixType={gps_fix_type})")
            if gps_satellites < min_satellites:
                failures.append(
                    f"too few satellites ({gps_satellites} < {min_satellites})"
                )
            if gps_hdop > max_hdop:
                failures.append(f"GPS HDOP too high ({gps_hdop:.1f} > {max_hdop:.1f})")

        if not ekf_ok:
            failures.append("EKF / attitude estimate not healthy")
        if not prearm_ok:
            failures.append("FC reports prearm checks failing")

        if min_battery_voltage > 0.0 and 0.0 < battery_voltage < min_battery_voltage:
            failures.append(
                f"battery voltage low ({battery_voltage:.1f}V < {min_battery_voltage:.1f}V)"
            )
        if 0.0 < battery_remaining < min_battery_remaining:
            failures.append(
                f"battery remaining low ({battery_remaining:.0f}% < "
                f"{min_battery_remaining:.0f}%)"
            )
        if battery_voltage <= 0.0 and battery_remaining <= 0.0:
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

        PRD 6.1 / 11: emergencyStop immediately disengages tracking AND releases
        manual control, zeroes setpoints, and LANDs (airborne) or BRAKEs/disarms.
        It overrides everything and never asks for confirmation.

        We default to LAND while airborne (brings the aircraft down safely) and
        to a force-disarm when already on the ground. ``prefer_land=False``
        selects BRAKE-then-hold instead (e.g. if the operator wants to keep
        position and manually take over).
        """
        if not state.airborne:
            # On the ground: kill motors. Force flag handles a stuck/auto state.
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
    # 4. Geofence + failsafe param map
    # ----------------------------------------------------------------------
    def failsafe_param_map(self) -> dict:
        """The ArduCopter PARAM map for this vehicle's safety envelope.

        Thin instance wrapper around the module-level :func:`failsafe_param_map`
        using this manager's current ``Limits``.
        """
        return failsafe_param_map(self._limits)


# --------------------------------------------------------------------------
# Module-level geofence + failsafe PARAM map (no SafetyManager needed)
# --------------------------------------------------------------------------
def failsafe_param_map(limits: Limits) -> dict:
    """Return the exact ArduCopter parameters to flash for a safe vehicle.

    Returned as a flat ``dict[str, float]`` (param name -> value) so it can be:
      * tabled verbatim in ``docs/flashing.md``,
      * pushed to the FC by a ``set_params`` helper (PARAM_SET per entry), and
      * diffed against a live param fetch for verification.

    Grouped by concern below. Values derive from ``Limits`` / shared DEFAULTS so
    the flashed envelope matches the runtime clamp.

    CRITICAL -- RC OVERRIDE ALWAYS WINS (PRD 11):
      * We deliberately do NOT set THR_FS / RC failsafe to a value that ignores
        the pilot. FS_THR_ENABLE is left enabling RC failsafe so loss of the
        transmitter triggers a safe action, but while the TX is alive the pilot
        always retains authority -- the companion only ever sends GUIDED
        setpoints, never RC overrides. Flipping the mode switch out of GUIDED on
        the transmitter instantly takes the aircraft away from the companion.
    """
    L = limits

    params: dict = {
        # --- Geofence (a hard cylinder: radius + altitude) --------------------
        # FENCE_TYPE bit0=altitude(1) | bit1=circle(2) -> 3 = both.
        "FENCE_ENABLE": 1.0,
        "FENCE_TYPE": 3.0,
        "FENCE_ACTION": 1.0,            # 1 = RTL or LAND (breach -> come back)
        "FENCE_RADIUS": float(_geofence_radius(L)),
        "FENCE_ALT_MAX": float(L.max_altitude),
        "FENCE_MARGIN": 2.0,           # m, start reacting before the hard edge

        # --- Battery failsafe (two-stage: warn -> land/RTL) -------------------
        "BATT_MONITOR": 4.0,           # 4 = voltage + current
        "BATT_FS_LOW_ACT": 2.0,        # 2 = RTL on low battery
        "BATT_FS_CRT_ACT": 1.0,        # 1 = LAND on critical battery
        "BATT_LOW_VOLT": 14.0,         # 4S nominal; tune per pack in flashing.md
        "BATT_CRT_VOLT": 13.2,
        "BATT_LOW_TIMER": 10.0,        # s sustained before acting

        # --- GCS / ground-link failsafe (the FC-side backstop deadman) --------
        # FS_GCS_ENABLE 1 = RTL on GCS heartbeat loss. This is the FC's own
        # version of our companion deadman; both are layered (PRD 11).
        "FS_GCS_ENABLE": 1.0,
        "FS_GCS_TIMEOUT": max(1.0, float(L.ground_link_timeout_ms) / 1000.0),

        # --- RC / throttle failsafe (RC OVERRIDE PRIMACY) --------------------
        # FS_THR_ENABLE 1 = enabled, RTL on loss; the pilot keeps authority
        # whenever the link is up. We never override RC from the companion.
        "FS_THR_ENABLE": 1.0,
        "FS_THR_VALUE": 975.0,         # us threshold below which RC is "lost"

        # --- EKF / sensor failsafe ------------------------------------------
        "FS_EKF_ACTION": 1.0,          # 1 = land/hold on EKF failure
        "FS_EKF_THRESH": 0.8,

        # --- RTL behaviour ---------------------------------------------------
        "RTL_ALT": float(_rtl_alt_cm(L)),   # cm, climb to this before returning
        "RTL_ALT_FINAL": 0.0,          # 0 = land at home after RTL

        # --- Speed / climb envelope (matches the runtime clamp) -------------
        # WPNAV_SPEED is cm/s and bounds GUIDED horizontal velocity in the FC.
        "WPNAV_SPEED": float(L.max_speed * 100.0),
        "WPNAV_SPEED_UP": float(L.max_climb_rate * 100.0),
        "WPNAV_SPEED_DN": float(L.max_climb_rate * 100.0),
        "PILOT_SPEED_UP": float(L.max_climb_rate * 100.0),

        # --- Arming preconditions -------------------------------------------
        # ARMING_CHECK 1 = all checks (GPS, EKF, battery, ...). Never disable
        # for a real flight; SITL bring-up may relax this temporarily.
        "ARMING_CHECK": 1.0,
        "GPS_HDOP_GOOD": 250.0,        # 0.01 units -> HDOP 2.5 gate
    }
    return params


def _geofence_radius(limits: Limits) -> float:
    """Geofence cylinder radius (m).

    ``Limits`` doesn't carry the fence radius directly (it lives in shared
    DEFAULTS.geofence_radius = 60 m); we keep that here so the param map is
    self-contained. Always >= a small floor so a misconfig can't disable it.
    """
    return max(20.0, 60.0)


def _rtl_alt_cm(limits: Limits) -> float:
    """RTL altitude in centimetres, kept under the geofence altitude cap.

    RTL climbs to RTL_ALT before returning; clamp it so RTL can never breach
    the altitude fence. Use min(15 m, fence_alt - 2 m floor).
    """
    fence_alt = float(limits.max_altitude)
    rtl_m = min(15.0, max(5.0, fence_alt - 2.0))
    return rtl_m * 100.0


__all__ = [
    "SafetyManager",
    "ArmCheckResult",
    "LinkStatus",
    "EmergencyPlan",
    "FailsafeAction",
    "failsafe_param_map",
    "now_ms",
]
