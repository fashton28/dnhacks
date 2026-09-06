"""
============================================================================
Drone Safety Platform -- END-TO-END ACCEPTANCE TEST (e2e_test.py)
----------------------------------------------------------------------------
THE PRIMARY ACCEPTANCE GATE (PRD 6.3, 13). Runs against a live companion that
is reachable on the control WebSocket port. It drives the WHOLE system through
the contract only -- no internal companion imports.

Preconditions (start these first, see sim/README.md):
  terminal 1:  ./sim/run_sitl.sh                     # ArduCopter SITL @ udp 14550
  terminal 2:  EIS_CONFIG=companion/config/sitl.yaml python -m eis_companion.app
               (config selects camera 'sim' so SimTargetSource drives a
                synthetic moving person into the guidance stack)

The gate is an explicit phase machine; each phase names its successor, so a
failing run prints exactly how far the vehicle got:

  connect -> arm -> takeoff -> configure -> engage -> yaw
          -> standoff -> speed -> disengage -> recover

  connect    first telemetry frame arrives
  arm        arm acked AND telemetry reports armed
  takeoff    climbs to within 1.5 m of the requested altitude
  configure  setStandoff + setMaxSpeed acked
  engage     engageTracking -> controlSource=='tracking', tracking LOCKS, and
             the tracking frame echoes the standoff we asked for
  yaw        the vehicle demonstrably yaws TOWARD the locked target
  standoff   estimatedDistance APPROACHES, then HOLDS at standoff and NEVER
             breaches it (the hard safety limit -- fails loudly)
  speed      groundspeed stayed within the configured maxSpeed (+ margin)
  disengage  disengageTracking -> controlSource back to 'auto'
  recover    rtl (or land if rtl is refused)

Run either way:
  python sim/e2e_test.py                 # standalone, prints PASS/FAIL + exits
  python sim/e2e_test.py --ws-url ws://127.0.0.1:8765
  pytest sim/e2e_test.py                 # pytest-compatible

Exit codes (the contract with scripts/run-sim-e2e.{sh,ps1}):
  0 pass | 1 acceptance assertion failed | 2 link/timeout | 3 unexpected error

Env knobs:
  EIS_WS_URL   (default ws://127.0.0.1:8765)
  EIS_STANDOFF (default 5.0 m)           EIS_MAXSPEED (default 2.0 m/s)
  EIS_TAKEOFF_ALT (default 10.0 m)       EIS_CONVERGE_S (default 35 s)
============================================================================
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import math
import os
import sys
from dataclasses import dataclass, field
from typing import Callable, List, Optional, Sequence, Tuple

# Allow `python sim/e2e_test.py` from anywhere: add this dir to sys.path.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from headless_client import (  # noqa: E402
    HeadlessClient,
    PhaseMachine,
    default_vehicle_id,
    default_ws_url,
    drive_acceptance,
    env_float,
    link_arguments,
    run_acceptance,
)

TAG = "e2e"

# --- tunable acceptance params (env-overridable) ---------------------------
WS_URL = default_ws_url()
STANDOFF = env_float("EIS_STANDOFF", 5.0)
MAX_SPEED = env_float("EIS_MAXSPEED", 2.0)
TAKEOFF_ALT = env_float("EIS_TAKEOFF_ALT", 10.0)
CONVERGE_S = env_float("EIS_CONVERGE_S", 35.0)

# Standoff is a HARD limit: once converged, estimatedDistance must never dip
# more than this small epsilon below the configured standoff.
STANDOFF_EPSILON = 0.6   # m, allowance for distance-estimate noise
SPEED_MARGIN = 0.5       # m/s, allowance over maxSpeed for FC overshoot/noise
HEADING_IMPROVE_DEG = 5.0  # min heading slew to count as "yawed toward"

# --- fixed shape of the acceptance run -------------------------------------
AIRBORNE_TOLERANCE = 1.5   # m below the requested altitude that counts as up
HOLD_WINDOW_S = 12.0       # sustained no-breach window after convergence
HOLD_MIN_SAMPLES = 10      # fewer than this means tracking is not publishing
HOLD_DRIFT_ALLOWANCE = 1.0  # m the mean hold may exceed standoff+band
SPEED_WINDOW_FRAMES = 200  # telemetry frames scanned for the speed peak
YAW_OBSERVE_S = 12.0       # how long the yaw response has to develop
YAW_OFFCENTRE_MIN = 0.05   # |cx-0.5| below this counts as "already centred"
YAW_EARLY_FACTOR = 0.6     # error shrinking to this fraction passes early
YAW_IMPROVE_MIN = 0.02     # smallest error improvement that still counts
YAW_CENTRED_MAX = 0.08     # a centred target must stay within this


# ==========================================================================
# Parameters
# ==========================================================================
@dataclass(frozen=True)
class AcceptanceParams:
    """Everything the gate is allowed to vary, resolved once per run."""

    ws_url: str = field(default_factory=lambda: WS_URL)
    vehicle_id: str = field(default_factory=default_vehicle_id)
    standoff: float = STANDOFF
    max_speed: float = MAX_SPEED
    takeoff_alt: float = TAKEOFF_ALT
    converge_s: float = CONVERGE_S
    standoff_epsilon: float = STANDOFF_EPSILON
    speed_margin: float = SPEED_MARGIN
    heading_improve_deg: float = HEADING_IMPROVE_DEG

    @property
    def converge_band(self) -> float:
        """Distance from standoff that counts as converged (~25% of it)."""
        return max(1.0, 0.25 * self.standoff)

    @property
    def breach_floor(self) -> float:
        """estimatedDistance may never go below this. Hard limit."""
        return self.standoff - self.standoff_epsilon

    @classmethod
    def from_env(cls) -> "AcceptanceParams":
        return cls()

    @classmethod
    def from_args(cls, argv: Optional[Sequence[str]] = None) -> "AcceptanceParams":
        args = build_parser().parse_args(argv)
        return cls(
            ws_url=args.ws_url,
            vehicle_id=args.vehicle_id,
            standoff=args.standoff,
            max_speed=args.max_speed,
            takeoff_alt=args.takeoff_alt,
            converge_s=args.converge_s,
        )


def build_parser() -> argparse.ArgumentParser:
    """CLI surface. ``--ws-url`` is what run-sim-e2e.{sh,ps1} pass."""
    parser = link_arguments(
        argparse.ArgumentParser(
            prog="e2e_test.py",
            description="Primary SITL acceptance gate: track, approach, hold at standoff.",
        )
    )
    parser.add_argument("--standoff", type=float, default=STANDOFF, metavar="M")
    parser.add_argument("--max-speed", type=float, default=MAX_SPEED, metavar="MPS")
    parser.add_argument("--takeoff-alt", type=float, default=TAKEOFF_ALT, metavar="M")
    parser.add_argument("--converge-s", type=float, default=CONVERGE_S, metavar="SEC")
    return parser


# ==========================================================================
# Pure evaluators -- the actual acceptance criteria, testable without a socket
# ==========================================================================
def heading_slew(from_deg: float, to_deg: float) -> float:
    """Absolute shortest-arc heading change in degrees (0..180)."""
    return abs(((to_deg - from_deg + 540.0) % 360.0) - 180.0)


def locked_centre_x(tracking: dict) -> Optional[float]:
    """Horizontal image centre (0..1) of the locked target, if any.

    bbox is ``[x, y, w, h]`` normalised 0..1, so centre x = x + w/2.
    """
    locked_id = tracking.get("lockedTargetId")
    for target in tracking.get("targets") or ():
        if not isinstance(target, dict):
            continue
        if target.get("id") == locked_id or target.get("isLocked"):
            bbox = target.get("bbox") or [0.0, 0.0, 0.0, 0.0]
            if len(bbox) < 3:
                return None
            return float(bbox[0]) + float(bbox[2]) / 2.0
    return None


@dataclass
class YawEvidence:
    """Folds tracking/telemetry into the two independent yaw signals.

    (a) the locked target's bbox centre moves toward the image centre, or
    (b) the heading slews while the target is still off-centre (guidance is
        actively commanding a yaw rate).
    """

    initial_error: float
    initial_heading: float
    best_error: float = field(init=False)
    max_slew: float = 0.0

    def __post_init__(self) -> None:
        self.best_error = self.initial_error

    def observe_tracking(self, tracking: Optional[dict]) -> None:
        if not tracking:
            return
        centre = locked_centre_x(tracking)
        if centre is not None:
            self.best_error = min(self.best_error, abs(centre - 0.5))

    def observe_heading(self, heading: Optional[float]) -> None:
        if heading is None:
            return
        self.max_slew = max(self.max_slew, heading_slew(self.initial_heading, heading))

    def verdict(self, slew_threshold: float) -> Tuple[bool, str]:
        """(passed, reason). Both accumulators are monotonic, so a verdict of
        True can never be revoked by a later sample -- which is why the phase
        may stop observing as soon as it turns True."""
        if self.initial_error > YAW_OFFCENTRE_MIN:
            if self.best_error <= self.initial_error * YAW_EARLY_FACTOR:
                return True, (
                    f"image error {self.initial_error:.3f} -> {self.best_error:.3f} "
                    f"(target driven toward centre)"
                )
            if self.best_error < self.initial_error - YAW_IMPROVE_MIN:
                return True, (
                    f"image error improved {self.initial_error:.3f} -> {self.best_error:.3f}"
                )
            if self.max_slew >= slew_threshold:
                return True, (
                    f"heading slewed {self.max_slew:.1f} deg while the target was off-centre"
                )
            return False, (
                f"image error stuck at {self.best_error:.3f} (from {self.initial_error:.3f}) "
                f"and heading slewed only {self.max_slew:.1f} deg"
            )
        if self.best_error <= YAW_CENTRED_MAX:
            return True, f"target started centred and stayed centred ({self.best_error:.3f})"
        return False, (
            f"target started centred ({self.initial_error:.3f}) but drifted to "
            f"{self.best_error:.3f}"
        )


def check_standoff_not_breached(
    distance: float, params: AcceptanceParams, phase: str
) -> None:
    """The HARD limit. Raises AssertionError naming the violated invariant."""
    if distance >= params.breach_floor:
        return
    message = (
        f"STANDOFF BREACH during {phase}: estimatedDistance={distance:.2f} m "
        f"< standoff {params.standoff:.1f} m - eps {params.standoff_epsilon}"
    )
    if phase == "hold":
        message += ". This violates the hard standoff safety limit."
    raise AssertionError(message)


@dataclass
class ApproachTrace:
    """What the approach phase observed, for the post-hoc assertions."""

    first: Optional[float] = None
    closest: float = math.inf
    converged: bool = False
    samples: int = 0

    def observe(self, distance: float) -> None:
        if self.first is None:
            self.first = distance
        self.closest = min(self.closest, distance)
        self.samples += 1


def evaluate_approach(trace: ApproachTrace, params: AcceptanceParams) -> None:
    """Assert the vehicle converged onto standoff AND actually closed on it."""
    if not trace.converged:
        raise AssertionError(
            f"estimatedDistance did not converge to standoff {params.standoff:.1f} m "
            f"within {params.converge_s:.0f}s (first={trace.first}, "
            f"closest={trace.closest:.2f}). "
            f"Guidance forward axis appears not to approach the target."
        )
    # The target should be APPROACHED: closest distance must be less than where
    # we started (unless we started already at standoff).
    if trace.first is not None and trace.first > params.standoff + params.converge_band:
        if trace.closest >= trace.first - 0.5:
            raise AssertionError(
                f"vehicle never approached: started at {trace.first:.2f} m, "
                f"closest only {trace.closest:.2f} m"
            )


@dataclass(frozen=True)
class HoldStats:
    count: int
    mean: float
    minimum: float
    maximum: float

    def __str__(self) -> str:
        return (
            f"samples={self.count} mean={self.mean:.2f} m "
            f"min={self.minimum:.2f} m max={self.maximum:.2f} m"
        )


def evaluate_hold(samples: Sequence[float], params: AcceptanceParams) -> HoldStats:
    """Assert the hold window is dense enough and centred on standoff.

    Per-frame breaches are rejected as they arrive (check_standoff_not_breached);
    this is the "did it actually HOLD, rather than drift away" half.
    """
    if len(samples) < HOLD_MIN_SAMPLES:
        raise AssertionError(
            f"too few estimatedDistance samples during hold window "
            f"({len(samples)}); is the companion publishing tracking @ ~10Hz?"
        )
    stats = HoldStats(
        count=len(samples),
        mean=sum(samples) / len(samples),
        minimum=min(samples),
        maximum=max(samples),
    )
    ceiling = params.standoff + params.converge_band + HOLD_DRIFT_ALLOWANCE
    if stats.mean > ceiling:
        raise AssertionError(
            f"vehicle did not HOLD at standoff: mean held distance {stats.mean:.2f} m "
            f"is well beyond standoff {params.standoff:.1f} m "
            f"(band {params.converge_band:.1f})"
        )
    return stats


def evaluate_speed(speeds: Sequence[float], params: AcceptanceParams) -> float:
    """Assert no telemetry frame exceeded the configured maxSpeed (+ margin)."""
    worst = max(speeds) if speeds else 0.0
    if worst > params.max_speed + params.speed_margin:
        raise AssertionError(
            f"groundspeed {worst:.2f} m/s exceeded configured maxSpeed "
            f"{params.max_speed:.2f} m/s (+{params.speed_margin} margin)"
        )
    return worst


def _numeric(value: object) -> Optional[float]:
    """Contract distances are ``Optional[float]``; ignore null/NaN."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return None if math.isnan(number) else number


def _rel_alt(telemetry: dict) -> float:
    return float((telemetry.get("position") or {}).get("relAlt", 0.0))


def _groundspeed(telemetry: dict) -> float:
    return float((telemetry.get("velocity") or {}).get("groundspeed", 0.0))


# ==========================================================================
# The gate itself
# ==========================================================================
class E2EGate:
    """Phase implementations for the primary acceptance sequence."""

    def __init__(
        self,
        client: HeadlessClient,
        params: AcceptanceParams,
        *,
        echo: Callable[[str], None] = print,
    ) -> None:
        self.client = client
        self.params = params
        self.echo = echo
        self.locked_target_id: Optional[int] = None
        self.hold_stats: Optional[HoldStats] = None
        self.peak_groundspeed = 0.0

    # -- machine wiring ------------------------------------------------
    def machine(self) -> PhaseMachine:
        return PhaseMachine(
            tag=TAG,
            phases={
                "connect": self.connect,
                "arm": self.arm,
                "takeoff": self.takeoff,
                "configure": self.configure,
                "engage": self.engage,
                "yaw": self.verify_yaw,
                "standoff": self.verify_standoff,
                "speed": self.verify_speed,
                "disengage": self.disengage,
                "recover": self.recover,
            },
            start="connect",
            echo=self.echo,
        )

    def say(self, message: str) -> None:
        self.echo(f"[{TAG}] {message}")

    # -- phases --------------------------------------------------------
    async def connect(self) -> str:
        self.say(f"connecting to {self.params.ws_url} ...")
        await self.client.connect()
        telemetry = await self.client.wait_for_telemetry(
            lambda _t: True, timeout=20.0, desc="first telemetry"
        )
        self.say(
            f"connected. mode={telemetry.get('mode')} armed={telemetry.get('armed')}"
        )
        return "arm"

    async def arm(self) -> str:
        self.say("arming ...")
        await self.client.send_command("arm", expect_success=True, timeout=15.0)
        await self.client.wait_for_telemetry(
            lambda t: bool(t.get("armed")), timeout=20.0, desc="armed=true"
        )
        self.say("armed.")
        return "takeoff"

    async def takeoff(self) -> str:
        target = self.params.takeoff_alt
        self.say(f"takeoff to {target:.1f} m ...")
        await self.client.send_command(
            "takeoff", {"altitude": target}, expect_success=True, timeout=15.0
        )
        floor = target - AIRBORNE_TOLERANCE
        airborne = await self.client.wait_for_telemetry(
            lambda t: _rel_alt(t) >= floor,
            timeout=60.0,
            desc="airborne at takeoff alt",
        )
        self.say(f"airborne at relAlt={_rel_alt(airborne):.2f} m.")
        return "configure"

    async def configure(self) -> str:
        self.say(
            f"setStandoff {self.params.standoff:.1f} m, "
            f"setMaxSpeed {self.params.max_speed:.1f} m/s ..."
        )
        await self.client.send_command(
            "setStandoff", {"meters": self.params.standoff}, expect_success=True
        )
        await self.client.send_command(
            "setMaxSpeed", {"mps": self.params.max_speed}, expect_success=True
        )
        return "engage"

    async def engage(self) -> str:
        self.say("engageTracking ...")
        await self.client.send_command(
            "engageTracking", expect_success=True, timeout=15.0
        )
        # Exactly one control source is ever active; it must become 'tracking'.
        await self.client.wait_for_telemetry(
            lambda t: t.get("controlSource") == "tracking",
            timeout=20.0,
            desc="controlSource=='tracking'",
        )
        # Tracking must lock onto the synthetic person.
        locked = await self.client.wait_for_tracking(
            lambda tr: tr.get("state") == "locked" and tr.get("lockedTargetId") is not None,
            timeout=30.0,
            desc="tracking locked",
        )
        self.locked_target_id = locked.get("lockedTargetId")
        self.say(f"tracking locked on target id={self.locked_target_id}.")

        # The configured standoff must be reflected back on the tracking msg.
        echoed = locked.get("standoffDistance", -1)
        if abs(float(echoed) - self.params.standoff) >= 1e-6:
            raise AssertionError(
                f"tracking.standoffDistance={echoed} "
                f"!= requested {self.params.standoff}"
            )
        return "yaw"

    async def verify_yaw(self) -> str:
        """ASSERT the vehicle yaws toward the locked target."""
        self.say("verifying the vehicle yaws toward the target ...")
        start = self.client.last_tracking or await self.client.wait_for_tracking(
            lambda tr: tr.get("state") == "locked", timeout=10.0
        )
        centre = locked_centre_x(start)
        evidence = YawEvidence(
            initial_error=abs((centre if centre is not None else 0.5) - 0.5),
            initial_heading=float((self.client.last_telemetry or {}).get("heading", 0.0)),
        )

        passed, reason = evidence.verdict(self.params.heading_improve_deg)
        async with contextlib.aclosing(
            self.client.follow("tracking", timeout=YAW_OBSERVE_S)
        ) as frames:
            async for tracking in frames:
                evidence.observe_tracking(tracking)
                evidence.observe_heading(
                    (self.client.last_telemetry or {}).get("heading")
                )
                passed, reason = evidence.verdict(self.params.heading_improve_deg)
                if passed:
                    break

        if not passed:
            raise AssertionError(
                "vehicle did not yaw toward the target: the locked bbox horizontal "
                "error never decreased and heading never slewed -- guidance yaw axis "
                f"appears inactive ({reason})."
            )
        self.say(f"yaw-toward-target confirmed: {reason}.")
        return "standoff"

    async def verify_standoff(self) -> str:
        """ASSERT distance approaches standoff, then HOLDS at/above it."""
        params = self.params
        self.say(
            f"verifying estimatedDistance converges to standoff "
            f"({params.standoff:.1f} m) and NEVER breaches it ..."
        )
        trace = await self._approach()
        evaluate_approach(trace, params)
        self.say(
            f"  converged after {trace.samples} frames "
            f"(first={trace.first}, closest={trace.closest:.2f} m)."
        )

        samples = await self._hold_for(HOLD_WINDOW_S)
        self.hold_stats = evaluate_hold(samples, params)
        self.say(f"  hold {self.hold_stats} (standoff {params.standoff:.1f})")
        self.say("standoff convergence + hold confirmed; standoff never breached.")
        return "speed"

    async def _approach(self) -> ApproachTrace:
        """Phase A: every published tracking frame, until converged or timeout.

        Frame-driven rather than polled: a breach that lasts a single frame
        still fails the gate.
        """
        params = self.params
        trace = ApproachTrace()
        async with contextlib.aclosing(
            self.client.follow("tracking", timeout=params.converge_s)
        ) as frames:
            async for tracking in frames:
                distance = _numeric(tracking.get("estimatedDistance"))
                if distance is None:
                    continue
                trace.observe(distance)
                # The HARD limit holds during the approach too, not only at hold.
                check_standoff_not_breached(distance, params, "approach")
                if abs(distance - params.standoff) <= params.converge_band:
                    trace.converged = True
                    break
        return trace

    async def _hold_for(self, duration: float) -> List[float]:
        """Phase B: sustained window in which no frame may breach standoff."""
        params = self.params
        samples: List[float] = []
        async with contextlib.aclosing(
            self.client.follow("tracking", timeout=duration)
        ) as frames:
            async for tracking in frames:
                distance = _numeric(tracking.get("estimatedDistance"))
                if distance is None:
                    continue
                check_standoff_not_breached(distance, params, "hold")
                samples.append(distance)
        return samples

    async def verify_speed(self) -> str:
        window = list(self.client.telemetry_log)[-SPEED_WINDOW_FRAMES:]
        self.peak_groundspeed = evaluate_speed(
            [_groundspeed(t) for t in window], self.params
        )
        self.say(
            f"peak groundspeed {self.peak_groundspeed:.2f} m/s within maxSpeed cap."
        )
        return "disengage"

    async def disengage(self) -> str:
        self.say("disengageTracking ...")
        await self.client.send_command("disengageTracking", expect_success=True)
        await self.client.wait_for_telemetry(
            lambda t: t.get("controlSource") == "auto",
            timeout=15.0,
            desc="controlSource back to 'auto'",
        )
        return "recover"

    async def recover(self) -> None:
        self.say("rtl/land ...")
        # Prefer RTL; fall back to land if the companion rejects RTL.
        ack = await self.client.send_command("rtl", timeout=15.0)
        if not ack.get("success"):
            await self.client.send_command("land", expect_success=True, timeout=15.0)
        self.say("PASS -- approached, held at standoff without breaching, landed.")
        return None


def build_gate(params: AcceptanceParams) -> Tuple[HeadlessClient, PhaseMachine]:
    client = HeadlessClient(params.ws_url, vehicle_id=params.vehicle_id)
    return client, E2EGate(client, params).machine()


# --------------------------------------------------------------------------
# pytest entry point
# --------------------------------------------------------------------------
def test_e2e_tracking_standoff() -> None:
    """pytest wrapper: runs the full acceptance sequence, fails on any assert."""
    client, machine = build_gate(AcceptanceParams.from_env())
    asyncio.run(drive_acceptance(client, machine))


# --------------------------------------------------------------------------
# standalone entry point
# --------------------------------------------------------------------------
def main(argv: Optional[Sequence[str]] = None) -> int:
    client, machine = build_gate(AcceptanceParams.from_args(argv))
    return run_acceptance(TAG, client, machine)


if __name__ == "__main__":
    raise SystemExit(main())
