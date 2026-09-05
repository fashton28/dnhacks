"""
Mission-plan executor: fly an approved MissionPlan tool list (goto_gps /
orbit_point / hold / rtl) on top of the existing guidance/setpoint idiom.

This is PURE LOGIC (stdlib math only -- no yaml, no cv2, no pymavlink, no file
or env I/O). The orchestrator constructs it with the hard ``Limits`` envelope,
the mission-profile cruise speed (a plain float the config layer has already
clamped), and the site altitude band as plain numbers -- site data is passed IN,
never read here.

Per 20 Hz tick, ``update(state, dt)`` consumes the latest ``VehicleState``
(lat/lon/relAlt/heading) and returns a ``PlannerOutput`` with one of two
motion flavors:

  * kind == GOTO      -> an absolute ``GotoTarget`` (lat, lon, alt AGL, speed)
                         for goto_gps legs; the orchestrator streams it to the
                         FC (SET_POSITION_TARGET_GLOBAL_INT path).
  * kind == VELOCITY  -> a BODY-frame ``VelocitySetpoint`` (same type guidance
                         and manual emit) for orbit_point legs, hold legs, and
                         any safe zero-and-hold condition; it routes through
                         the orchestrator's existing clamp + send path.
  * kind == RTL       -> signal: trigger the existing rtl path and release.
  * kind == DONE/IDLE -> plan finished / nothing loaded; setpoint is hold().

Sequencing: goto legs advance on arrival (horizontal radius + altitude
tolerance), hold legs advance on duration expiry (indefinite when durationS is
omitted), orbit legs advance after a configured number of revolutions
(default 1); rtl is terminal.

SAFETY (PRD rule 4 -- clamp in-component even though the FC path clamps again):
  * every speed emitted (goto leg speed, orbit tangential+radial magnitude) is
    <= min(profile speed, limits.max_speed); per-leg profile overrides may
    only TIGHTEN the plan profile speed, never raise it.
  * every altitude emitted is clamped into the passed site alt band intersected
    with [0, limits.max_altitude].
  * orbit radius is floored at limits.min_standoff (the hard standoff floor);
    approach (vx > 0) is NEVER commanded at/inside the effective radius --
    asserted twice (pre- and post-clamp), mirroring guidance's standoff idiom.
  * vz / yaw_rate clamped to max_climb_rate / max_yaw_rate; the whole setpoint
    gets a final belt-and-braces clamp before it is returned.
  * abort() -> zero-and-hold (VelocitySetpoint.hold()), same semantics as the
    manual watchdog; a lost ground link (link_ok=False) also yields hold.

Deterministic and clock-free: all timing is dt-accumulated, so tests need no
fake clock. numpy + stdlib only (currently stdlib ``math`` suffices).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, List, Mapping, Optional, Tuple, Union

from ..types import Limits, VehicleState, VelocitySetpoint

_EARTH_RADIUS_M = 6371000.0

# Hard cap on plan size: bounds per-tick work in the 20 Hz control loop (a
# plan of instantly-completing legs advances through at most this many in one
# tick) and rejects absurd plans outright at load.
MAX_PLAN_TOOLS = 100


# --------------------------------------------------------------------------
# Output types
# --------------------------------------------------------------------------
class PlanOutputKind(str, Enum):
    """What the orchestrator should do with this tick's PlannerOutput."""
    IDLE = "idle"          # no active plan -> hold
    GOTO = "goto"          # stream .goto as an absolute position target
    VELOCITY = "velocity"  # stream .setpoint through the normal velocity path
    RTL = "rtl"            # trigger the existing rtl path + release the planner
    DONE = "done"          # plan complete -> hold + release the planner


@dataclass
class GotoTarget:
    """Absolute position target for a goto_gps leg (already clamped)."""
    lat: float
    lon: float
    alt: float    # m AGL relative to home (clamped into the effective band)
    speed: float  # m/s groundspeed cap for the leg (clamped)


@dataclass
class PlannerOutput:
    """One control-tick output. Exactly one motion flavor is meaningful:
    .goto when kind==GOTO, .setpoint when kind==VELOCITY; everything else is
    a hold. tool_index/tool_count/done expose plan progress for telemetry."""
    kind: PlanOutputKind
    setpoint: VelocitySetpoint = field(default_factory=VelocitySetpoint.hold)
    goto: Optional[GotoTarget] = None
    tool_index: int = 0
    tool_count: int = 0
    done: bool = False


# --------------------------------------------------------------------------
# Normalised (validated) plan legs
# --------------------------------------------------------------------------
@dataclass
class _GotoLeg:
    lat: float
    lon: float
    alt: Optional[float]   # None -> freeze current altitude at leg activation
    speed: float           # requested leg cap (>=0); re-clamped live at emit


@dataclass
class _OrbitLeg:
    lat: float
    lon: float
    radius: float          # raw; floored at limits.min_standoff at every tick
    speed: float


@dataclass
class _HoldLeg:
    duration: Optional[float]  # seconds; None -> indefinite (until abort)


@dataclass
class _RtlLeg:
    pass


_Leg = Union[_GotoLeg, _OrbitLeg, _HoldLeg, _RtlLeg]

_LEG_NAMES = {
    _GotoLeg: "goto_gps",
    _OrbitLeg: "orbit_point",
    _HoldLeg: "hold",
    _RtlLeg: "rtl",
}


# --------------------------------------------------------------------------
# Executor
# --------------------------------------------------------------------------
class PlannerExecutor:
    """Stateful MissionPlan executor. See module docstring for the contract.

    Args:
      limits: the hard safety envelope (shared, live object -- limit changes
        made by the orchestrator apply on the next tick).
      profile_speed: cruise speed for the plan's mission profile, m/s. The
        config layer clamps it already; it is re-clamped here to
        [0, limits.max_speed] at every use (belt-and-braces). It is a CAP:
        no emitted speed ever exceeds min(profile_speed, limits.max_speed).
      alt_band_min / alt_band_max: permitted flight band, m AGL relative to
        home (plain numbers from the site model -- passed in, never read
        here). Intersected with [0, limits.max_altitude]; the band can only
        tighten the envelope, never relax it.
      profile_speeds: optional plain mapping of profile name -> m/s used to
        resolve plan/leg ``profile`` fields (e.g. the config-clamped mirror
        of PROFILE_SPEED_MPS). Per-leg profiles only TIGHTEN the plan cap.
      arrival_radius_m / arrival_alt_tol_m: goto arrival thresholds.
      orbit_revolutions: revolutions before an orbit leg auto-advances.
      orbit_clockwise: orbit direction as seen from above.
      radial_gain / yaw_gain / alt_gain: P gains for orbit ring-keeping,
        nose-on-center yaw, and alt-band recovery.
    """

    def __init__(
        self,
        limits: Limits,
        profile_speed: float,
        *,
        alt_band_min: float = 0.0,
        alt_band_max: float = float("inf"),
        profile_speeds: Optional[Mapping[str, float]] = None,
        arrival_radius_m: float = 2.0,
        arrival_alt_tol_m: float = 2.0,
        orbit_revolutions: float = 1.0,
        orbit_clockwise: bool = True,
        radial_gain: float = 0.5,
        yaw_gain: float = 1.5,
        alt_gain: float = 0.8,
    ) -> None:
        self._limits = limits
        self._profile_speed = _sanitize_speed(profile_speed)
        # Sanitize the band: non-finite max falls back to the hard alt cap,
        # non-finite min to 0. The effective band is recomputed live per tick.
        self._band_min = float(alt_band_min) if _finite(alt_band_min) else 0.0
        self._band_max = (
            float(alt_band_max) if _finite(alt_band_max) else float(limits.max_altitude)
        )
        self._profile_speeds = dict(profile_speeds) if profile_speeds else {}
        self._arrival_radius_m = max(0.1, float(arrival_radius_m))
        self._arrival_alt_tol_m = max(0.1, float(arrival_alt_tol_m))
        self._orbit_revolutions = max(0.0, float(orbit_revolutions))
        self._orbit_clockwise = bool(orbit_clockwise)
        self._radial_gain = max(0.0, float(radial_gain))
        self._yaw_gain = max(0.0, float(yaw_gain))
        self._alt_gain = max(0.0, float(alt_gain))

        # plan state
        self._legs: List[_Leg] = []
        self._index: int = 0
        self._active: bool = False
        self._done: bool = False
        self._aborted: bool = False
        self._request_id: str = ""
        self._anomaly_id: str = ""

        # per-leg state (cleared on advance)
        self._goto_alt: Optional[float] = None
        self._hold_elapsed: float = 0.0
        self._orbit_accum_deg: float = 0.0
        self._orbit_prev_bearing: Optional[float] = None

    # ---- progress / status ----------------------------------------------
    @property
    def active(self) -> bool:
        return self._active

    @property
    def done(self) -> bool:
        return self._done

    @property
    def tool_index(self) -> int:
        return self._index

    @property
    def tool_count(self) -> int:
        return len(self._legs)

    def progress(self) -> dict:
        """Plan progress for telemetry/status (camelCase, JSON-ready)."""
        tool = None
        if self._legs and self._index < len(self._legs):
            tool = _LEG_NAMES[type(self._legs[self._index])]
        return {
            "active": self._active,
            "done": self._done,
            "aborted": self._aborted,
            "toolIndex": self._index,
            "toolCount": len(self._legs),
            "tool": tool,
            "requestId": self._request_id,
            "anomalyId": self._anomaly_id,
        }

    def plan_summary(self) -> List[dict]:
        """The normalised plan with the clamps applied at CURRENT limits --
        what will actually be flown. For status display and tests."""
        lim = self._limits
        out: List[dict] = []
        for leg in self._legs:
            if isinstance(leg, _GotoLeg):
                out.append({
                    "tool": "goto_gps",
                    "lat": leg.lat,
                    "lon": leg.lon,
                    "alt": None if leg.alt is None else self._clamp_alt(leg.alt),
                    "speed": self._clamp_speed(leg.speed),
                })
            elif isinstance(leg, _OrbitLeg):
                out.append({
                    "tool": "orbit_point",
                    "lat": leg.lat,
                    "lon": leg.lon,
                    "radius": max(leg.radius, lim.min_standoff),
                    "speed": self._clamp_speed(leg.speed),
                })
            elif isinstance(leg, _HoldLeg):
                out.append({"tool": "hold", "durationS": leg.duration})
            else:
                out.append({"tool": "rtl"})
        return out

    # ---- plan lifecycle --------------------------------------------------
    def load_plan(
        self,
        plan: Mapping[str, Any],
        *,
        profile_speed: Optional[float] = None,
    ) -> Tuple[bool, str]:
        """Validate + normalise a MissionPlan-shaped mapping and arm it.

        Returns (ok, message) matching the orchestrator's dispatch idiom. A
        rejected plan leaves any previously loaded plan untouched. Numeric
        values out of the safe envelope are CLAMPED (radius up to the standoff
        floor, alt into the band, speeds down to the cap); malformed or
        non-finite required fields REJECT the plan.
        """
        if not isinstance(plan, Mapping):
            return False, "plan must be a mapping"
        tools = plan.get("tools")
        if not isinstance(tools, (list, tuple)) or len(tools) == 0:
            return False, "plan has no tools"
        if len(tools) > MAX_PLAN_TOOLS:
            return False, f"plan too large: {len(tools)} tools (max {MAX_PLAN_TOOLS})"

        plan_cap = self._resolve_plan_speed(plan, profile_speed)
        legs: List[_Leg] = []
        for i, raw in enumerate(tools):
            ok, result = self._parse_tool(raw, plan_cap)
            if not ok:
                return False, f"tool {i}: {result}"
            legs.append(result)  # type: ignore[arg-type]

        self._legs = legs
        self._index = 0
        self._active = True
        self._done = False
        self._aborted = False
        self._request_id = str(plan.get("requestId", "") or "")
        self._anomaly_id = str(plan.get("anomalyId", "") or "")
        self._clear_leg_state()
        return True, f"plan loaded: {len(legs)} tool(s)"

    def abort(self) -> VelocitySetpoint:
        """Abort the plan -> zero-and-hold. Returns the safe hold setpoint the
        caller should emit (same semantics as ManualPilot.release / the
        watchdog pattern). Subsequent updates emit IDLE holds."""
        self._active = False
        self._aborted = True
        self._clear_leg_state()
        return VelocitySetpoint.hold()

    def reset(self) -> None:
        """Full reset: drop the plan entirely and return to idle."""
        self.abort()
        self._legs = []
        self._index = 0
        self._done = False
        self._aborted = False
        self._request_id = ""
        self._anomaly_id = ""

    # ---- main per-tick step ---------------------------------------------
    def update(
        self,
        state: VehicleState,
        dt: float,
        *,
        link_ok: bool = True,
    ) -> PlannerOutput:
        """Advance the plan one control tick and emit the next output.

        Args:
          state: latest VehicleState (lat/lon/relAlt/heading are consumed).
          dt: seconds since the last tick (>=0); drives hold timing.
          link_ok: ground-link health (deadman). False -> zero-and-hold
            immediately; the plan does not advance while the link is down.
        """
        if not _finite(dt) or dt < 0.0:
            dt = 0.0

        # Bounded advance loop, NOT recursion (a plan full of instantly
        # completing legs -- zero-duration holds, already-arrived gotos --
        # must never RecursionError the 20 Hz control tick). Every pass
        # either returns an output or a leg tick advanced ``_index`` by one
        # (a tick returns None ONLY after ``_advance()``), so at most
        # ``len(legs) + 1`` passes run; the range bound is belt-and-braces.
        for _ in range(len(self._legs) + 1):
            if not self._active:
                return self._out(PlanOutputKind.IDLE)
            if self._index >= len(self._legs):
                self._done = True
                return self._out(PlanOutputKind.DONE)
            if not link_ok:
                return self._out(PlanOutputKind.VELOCITY)  # zero-and-hold
            if not _state_finite(state):
                return self._out(PlanOutputKind.VELOCITY)  # defensive hold

            leg = self._legs[self._index]
            if isinstance(leg, _RtlLeg):
                # Terminal: the orchestrator triggers the existing rtl path
                # and releases the planner. Keep signalling until it does.
                self._done = True
                return self._out(PlanOutputKind.RTL)
            if isinstance(leg, _HoldLeg):
                out = self._tick_hold(leg, dt)
            elif isinstance(leg, _GotoLeg):
                out = self._tick_goto(leg, state)
            else:
                out = self._tick_orbit(leg, state)
            if out is not None:
                return out
            # Leg completed instantly and advanced: re-evaluate the next leg
            # in the SAME tick with the elapsed time already consumed (the
            # old recursion's ``update(state, 0.0)`` semantics).
            dt = 0.0

        # Unreachable unless a future leg tick neither returns nor advances;
        # fail in the safe direction.
        return self._out(PlanOutputKind.VELOCITY)

    # ---- per-leg ticks ---------------------------------------------------
    # Each returns the tick's PlannerOutput, or None after advancing to the
    # next leg (the caller's bounded loop re-evaluates -- never recursion).
    def _tick_hold(self, leg: _HoldLeg, dt: float) -> Optional[PlannerOutput]:
        self._hold_elapsed += dt
        if leg.duration is not None and self._hold_elapsed >= leg.duration:
            self._advance()
            return None
        # zero-velocity hover: hold() == all-zero, valid=False (canonical hold)
        return self._out(PlanOutputKind.VELOCITY)

    def _tick_goto(
        self, leg: _GotoLeg, state: VehicleState
    ) -> Optional[PlannerOutput]:
        # Freeze the target altitude at leg activation (missing alt -> current
        # altitude), always clamped into the effective band.
        if self._goto_alt is None:
            base = state.relAlt if leg.alt is None else leg.alt
            self._goto_alt = self._clamp_alt(base)

        dist = _haversine_m(state.lat, state.lon, leg.lat, leg.lon)
        # Re-clamp every emit: the band/limits may have tightened live.
        alt = self._clamp_alt(self._goto_alt)
        if dist <= self._arrival_radius_m and abs(state.relAlt - alt) <= self._arrival_alt_tol_m:
            self._advance()
            return None

        target = GotoTarget(
            lat=leg.lat,
            lon=leg.lon,
            alt=alt,
            speed=self._clamp_speed(leg.speed),
        )
        return self._out(PlanOutputKind.GOTO, goto=target)

    def _tick_orbit(
        self, leg: _OrbitLeg, state: VehicleState
    ) -> Optional[PlannerOutput]:
        lim = self._limits
        # HARD floor: the orbit ring can never be inside the standoff floor.
        radius = max(float(leg.radius), lim.min_standoff)
        cap = self._clamp_speed(leg.speed)

        dist = _haversine_m(state.lat, state.lon, leg.lat, leg.lon)
        brg_to_center = _bearing_deg(state.lat, state.lon, leg.lat, leg.lon)
        heading_err = _wrap180(brg_to_center - state.heading)

        # -- revolution progress: accumulate the center->vehicle bearing ----
        if dist >= max(1.0, 0.1 * radius):
            b = _bearing_deg(leg.lat, leg.lon, state.lat, state.lon)
            if self._orbit_prev_bearing is not None:
                self._orbit_accum_deg += _wrap180(b - self._orbit_prev_bearing)
            self._orbit_prev_bearing = b
        if abs(self._orbit_accum_deg) >= 360.0 * self._orbit_revolutions:
            self._advance()
            return None

        # -- radial: nose-on-center convention, vx>0 closes on the center ---
        vx = _clamp(self._radial_gain * (dist - radius), -cap, cap)
        if dist <= radius:
            vx = min(vx, 0.0)  # NEVER approach at/inside the effective radius

        # -- tangential: strafe; scaled down while not yet facing center ----
        tangential = cap * max(0.0, math.cos(math.radians(heading_err)))
        vy = -tangential if self._orbit_clockwise else tangential

        # -- horizontal speed magnitude cap (tighter than per-axis clamps) --
        norm = math.hypot(vx, vy)
        if norm > cap and norm > 0.0:
            scale = cap / norm  # preserves signs, so the radius floor holds
            vx *= scale
            vy *= scale

        # -- altitude: steer back inside the effective band, else level -----
        lo, hi = self._alt_band()
        if state.relAlt < lo:
            vz = -_clamp(self._alt_gain * (lo - state.relAlt), 0.0, lim.max_climb_rate)
        elif state.relAlt > hi:
            vz = _clamp(self._alt_gain * (state.relAlt - hi), 0.0, lim.max_climb_rate)
        else:
            vz = 0.0

        # -- yaw: keep the nose on the center + circular feed-forward -------
        ff = 0.0
        if radius > 0.0 and tangential > 0.0:
            ff = math.degrees(tangential / radius)
            if not self._orbit_clockwise:
                ff = -ff
        yaw_rate = _clamp(
            self._yaw_gain * heading_err + ff, -lim.max_yaw_rate, lim.max_yaw_rate
        )

        sp = VelocitySetpoint(vx=vx, vy=vy, vz=vz, yaw_rate=yaw_rate, valid=True)
        sp = _clamp_setpoint(sp, lim)  # belt-and-braces final clamp
        # Re-assert the radius floor on the EMITTED value (guidance idiom).
        if dist <= radius and sp.vx > 0.0:
            sp.vx = 0.0
        return self._out(PlanOutputKind.VELOCITY, setpoint=sp)

    # ---- helpers ---------------------------------------------------------
    def _out(
        self,
        kind: PlanOutputKind,
        *,
        setpoint: Optional[VelocitySetpoint] = None,
        goto: Optional[GotoTarget] = None,
    ) -> PlannerOutput:
        return PlannerOutput(
            kind=kind,
            setpoint=setpoint if setpoint is not None else VelocitySetpoint.hold(),
            goto=goto,
            tool_index=self._index,
            tool_count=len(self._legs),
            done=self._done,
        )

    def _advance(self) -> None:
        self._index += 1
        self._clear_leg_state()

    def _clear_leg_state(self) -> None:
        self._goto_alt = None
        self._hold_elapsed = 0.0
        self._orbit_accum_deg = 0.0
        self._orbit_prev_bearing = None

    def _alt_band(self) -> Tuple[float, float]:
        """Effective altitude band: site band intersected with the hard cap.
        Degenerate bands collapse safely (lo can never exceed hi)."""
        hi = max(0.0, min(self._band_max, self._limits.max_altitude))
        lo = max(0.0, min(self._band_min, hi))
        return lo, hi

    def _clamp_alt(self, alt: float) -> float:
        lo, hi = self._alt_band()
        return _clamp(float(alt), lo, hi)

    def _clamp_speed(self, mps: float) -> float:
        """Clamp an emitted speed to [0, min(requested cap, limits.max_speed)].
        Never raises a requested speed (raising would relax the envelope)."""
        return max(0.0, min(float(mps), self._limits.max_speed))

    def _resolve_plan_speed(
        self, plan: Mapping[str, Any], override: Optional[float]
    ) -> float:
        """The plan-level speed cap: explicit override > plan.profile (via the
        injected mapping) > constructor profile speed. Sanitized to >= 0."""
        if override is not None and _finite(override):
            return _sanitize_speed(override)
        prof = plan.get("profile")
        if isinstance(prof, str) and prof in self._profile_speeds:
            mapped = self._profile_speeds[prof]
            if _finite(mapped):
                return _sanitize_speed(mapped)
        return self._profile_speed

    def _parse_tool(
        self, raw: Any, plan_cap: float
    ) -> Tuple[bool, Union[_Leg, str]]:
        if not isinstance(raw, Mapping):
            return False, "tool must be a mapping"
        name = raw.get("tool")

        if name == "goto_gps":
            lat, lon = raw.get("lat"), raw.get("lon")
            if not _valid_latlon(lat, lon):
                return False, "goto_gps needs finite lat/lon in range"
            alt = raw.get("alt")
            if alt is not None:
                if not _finite(alt):
                    return False, "goto_gps alt must be finite"
                alt = float(alt)
            speed = plan_cap
            prof = raw.get("profile")
            if isinstance(prof, str) and prof in self._profile_speeds:
                mapped = self._profile_speeds[prof]
                if _finite(mapped):
                    # per-leg profile may only TIGHTEN the plan cap
                    speed = min(speed, _sanitize_speed(mapped))
            return True, _GotoLeg(float(lat), float(lon), alt, speed)

        if name == "orbit_point":
            lat, lon = raw.get("lat"), raw.get("lon")
            if not _valid_latlon(lat, lon):
                return False, "orbit_point needs finite lat/lon in range"
            radius = raw.get("radius")
            if not _finite(radius):
                return False, "orbit_point radius must be finite"
            return True, _OrbitLeg(float(lat), float(lon), float(radius), plan_cap)

        if name == "hold":
            duration = raw.get("durationS")
            if duration is not None:
                if not _finite(duration):
                    return False, "hold durationS must be finite"
                duration = max(0.0, float(duration))
            return True, _HoldLeg(duration)

        if name == "rtl":
            return True, _RtlLeg()

        return False, f"unknown tool {name!r}"


# --------------------------------------------------------------------------
# Pure helpers (stdlib math only)
# --------------------------------------------------------------------------
def _finite(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _valid_latlon(lat: Any, lon: Any) -> bool:
    return (
        _finite(lat) and _finite(lon)
        and -90.0 <= float(lat) <= 90.0
        and -180.0 <= float(lon) <= 180.0
    )


def _sanitize_speed(v: Any) -> float:
    """A requested speed cap: non-finite/negative -> 0 (no motion, safe)."""
    if not _finite(v):
        return 0.0
    return max(0.0, float(v))


def _state_finite(state: VehicleState) -> bool:
    return all(
        _finite(v) for v in (state.lat, state.lon, state.relAlt, state.heading)
    )


def _clamp(v: float, lo: float, hi: float) -> float:
    if lo > hi:
        lo, hi = hi, lo
    return max(lo, min(hi, v))


def _clamp_setpoint(sp: VelocitySetpoint, limits: Limits) -> VelocitySetpoint:
    """Belt-and-braces final clamp; any non-finite axis collapses to hold."""
    if not all(math.isfinite(v) for v in (sp.vx, sp.vy, sp.vz, sp.yaw_rate)):
        return VelocitySetpoint.hold()
    sp.vx = _clamp(sp.vx, -limits.max_speed, limits.max_speed)
    sp.vy = _clamp(sp.vy, -limits.max_speed, limits.max_speed)
    sp.vz = _clamp(sp.vz, -limits.max_climb_rate, limits.max_climb_rate)
    sp.yaw_rate = _clamp(sp.yaw_rate, -limits.max_yaw_rate, limits.max_yaw_rate)
    return sp


def _wrap180(deg: float) -> float:
    """Wrap an angle to (-180, 180]."""
    return ((float(deg) + 180.0) % 360.0) - 180.0


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in meters."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2.0) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2.0) ** 2
    return 2.0 * _EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def _bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial bearing from point 1 to point 2, degrees 0..360 (0 = north)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return math.degrees(math.atan2(y, x)) % 360.0


__all__ = [
    "PlannerExecutor",
    "PlannerOutput",
    "PlanOutputKind",
    "GotoTarget",
    "MAX_PLAN_TOOLS",
]
