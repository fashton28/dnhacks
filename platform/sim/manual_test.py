"""
============================================================================
Drone Safety Platform -- MANUAL-PILOTING ACCEPTANCE TEST (manual_test.py)
----------------------------------------------------------------------------
Headless test of the manual-control safety behaviour (PRD 6.1, 6.3, 11, 13),
driven entirely through the WebSocket contract -- no internal companion imports.

Preconditions (same stack as e2e, see sim/README.md):
  terminal 1:  ./sim/run_sitl.sh
  terminal 2:  EIS_CONFIG=companion/config/sitl.yaml python -m eis_companion.app

The gate is an explicit phase machine; each phase names its successor:

  connect -> reject -> arm -> takeoff -> track -> manual
          -> sticks -> watchdog -> release -> estop

  reject     engageManual is REFUSED while not armed+airborne (negative check
             up front, on the ground) and controlSource stays put
  track      engageTracking first, so manual can prove it auto-releases
  manual     engageManual -> tracking auto-releases AND controlSource=='manual'
             (exactly one control source is ever active)
  sticks     streamed manualInput drives attitude/heading/relAlt/position AND
             every axis stays within its clamp
  watchdog   STOP sending input -> the setpoint is zeroed and the vehicle HOLDS
             (it never coasts on the last commanded velocity)
  release    disengageManual -> auto-hold + controlSource=='auto'
  estop      emergencyStop overrides ACTIVE manual input instantly

Run either way:
  python sim/manual_test.py              # standalone, prints PASS/FAIL + exits
  python sim/manual_test.py --ws-url ws://127.0.0.1:8765
  pytest sim/manual_test.py              # pytest-compatible

Exit codes (the contract with scripts/run-sim-e2e.{sh,ps1}):
  0 pass | 1 acceptance assertion failed | 2 link/timeout | 3 unexpected error

Env knobs:
  EIS_WS_URL   (default ws://127.0.0.1:8765)
  EIS_TAKEOFF_ALT (default 10.0 m)
  EIS_MAX_SPEED / EIS_MAX_CLIMB / EIS_MAX_YAW (clamp limits, defaults from PRD 9)
  EIS_WATCHDOG_MS (default 500)
============================================================================
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Callable, Optional, Sequence, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from headless_client import (  # noqa: E402
    HeadlessClient,
    PhaseMachine,
    default_vehicle_id,
    default_ws_url,
    drive_acceptance,
    env_float,
    env_int,
    link_arguments,
    run_acceptance,
)

TAG = "manual"

# --- tunables (env-overridable, defaults mirror shared DEFAULTS / PRD 9) ----
WS_URL = default_ws_url()
TAKEOFF_ALT = env_float("EIS_TAKEOFF_ALT", 10.0)
MAX_SPEED = env_float("EIS_MAX_SPEED", 2.0)       # m/s horizontal
MAX_CLIMB = env_float("EIS_MAX_CLIMB", 1.5)       # m/s vertical
MAX_YAW = env_float("EIS_MAX_YAW", 45.0)          # deg/s
WATCHDOG_MS = env_int("EIS_WATCHDOG_MS", 500)     # ms

# Margins: FC controllers and the wire add overshoot/noise; allow headroom but
# keep it tight enough that an UNCLAMPED axis would clearly fail.
SPEED_MARGIN = 0.6      # m/s over the configured horizontal cap
CLIMB_MARGIN = 0.6      # m/s over the configured climb cap
YAW_MARGIN = 20.0       # deg/s over the configured yaw cap

# --- fixed shape of the manual run -----------------------------------------
AIRBORNE_TOLERANCE = 1.5   # m below the requested altitude that counts as up
STICK_RATE_HZ = 25.0       # the UI streams sticks at ~20-50 Hz
STICK_LEG_S = 2.5          # seconds of full deflection per axis
STICK_RUN_S = 10.0         # four legs: pitch, yaw, throttle, roll
WATCHDOG_DRIVE_S = 2.0     # forward burst before input stops
WATCHDOG_HOLD_GS = 0.8     # m/s: "essentially stopped" after the watchdog
WATCHDOG_DRIFT_WINDOW_S = 2.0
WATCHDOG_DRIFT_MAX = 5e-5  # deg (lat+lon); ~1e-5 deg is ~1.1 m
ESTOP_STREAM_S = 8.0       # sticks keep flowing while the stop is fired
SAFE_STOP_MODES = ("LAND", "BRAKE", "RTL")

# Response thresholds: below these the axis is considered inactive.
RESPONSE_POSITION_DELTA = 1e-6   # deg (lat+lon)
RESPONSE_GROUNDSPEED = 0.3       # m/s
RESPONSE_HEADING_DEG = 3.0       # deg
RESPONSE_YAW_RATE = 3.0          # deg/s
RESPONSE_ALT_DELTA = 0.5         # m
RESPONSE_CLIMB_RATE = 0.2        # m/s


# ==========================================================================
# Parameters
# ==========================================================================
@dataclass(frozen=True)
class ManualParams:
    """Everything the manual gate is allowed to vary, resolved once per run."""

    ws_url: str = field(default_factory=lambda: WS_URL)
    vehicle_id: str = field(default_factory=default_vehicle_id)
    takeoff_alt: float = TAKEOFF_ALT
    max_speed: float = MAX_SPEED
    max_climb: float = MAX_CLIMB
    max_yaw: float = MAX_YAW
    watchdog_ms: int = WATCHDOG_MS
    speed_margin: float = SPEED_MARGIN
    climb_margin: float = CLIMB_MARGIN
    yaw_margin: float = YAW_MARGIN

    @property
    def watchdog_s(self) -> float:
        return self.watchdog_ms / 1000.0

    @property
    def watchdog_settle_s(self) -> float:
        """Several watchdog periods: long enough for it to engage AND settle."""
        return max(2.0, 4 * self.watchdog_s)

    @property
    def release_settle_s(self) -> float:
        return max(1.5, 2 * self.watchdog_s)

    @classmethod
    def from_env(cls) -> "ManualParams":
        return cls()

    @classmethod
    def from_args(cls, argv: Optional[Sequence[str]] = None) -> "ManualParams":
        args = build_parser().parse_args(argv)
        return cls(
            ws_url=args.ws_url,
            vehicle_id=args.vehicle_id,
            takeoff_alt=args.takeoff_alt,
            max_speed=args.max_speed,
            max_climb=args.max_climb,
            max_yaw=args.max_yaw,
            watchdog_ms=args.watchdog_ms,
        )


def build_parser() -> argparse.ArgumentParser:
    """CLI surface. ``--ws-url`` is what run-sim-e2e.{sh,ps1} pass."""
    parser = link_arguments(
        argparse.ArgumentParser(
            prog="manual_test.py",
            description="Manual-piloting acceptance gate: engage, clamps, watchdog, e-stop.",
        )
    )
    parser.add_argument("--takeoff-alt", type=float, default=TAKEOFF_ALT, metavar="M")
    parser.add_argument("--max-speed", type=float, default=MAX_SPEED, metavar="MPS")
    parser.add_argument("--max-climb", type=float, default=MAX_CLIMB, metavar="MPS")
    parser.add_argument("--max-yaw", type=float, default=MAX_YAW, metavar="DPS")
    parser.add_argument("--watchdog-ms", type=int, default=WATCHDOG_MS, metavar="MS")
    return parser


# ==========================================================================
# Stick schedule (what the "pilot" does)
# ==========================================================================
#: (until_seconds, (throttle, yaw, pitch, roll)) -- one axis at FULL deflection
#: at a time. A correctly clamped companion turns |axis|=1.0 into <= the
#: configured max for that axis.
STICK_SCHEDULE: Tuple[Tuple[float, Tuple[float, float, float, float]], ...] = (
    (1 * STICK_LEG_S, (0.0, 0.0, 1.0, 0.0)),   # full forward pitch
    (2 * STICK_LEG_S, (0.0, 1.0, 0.0, 0.0)),   # full right yaw
    (3 * STICK_LEG_S, (1.0, 0.0, 0.0, 0.0)),   # full climb throttle
)
FINAL_STICKS = (0.0, 0.0, 0.0, 1.0)            # full right roll


def scripted_sticks(elapsed: float) -> Tuple[float, float, float, float]:
    """Axes for ``elapsed`` seconds into the scripted stick run."""
    for until, axes in STICK_SCHEDULE:
        if elapsed < until:
            return axes
    return FINAL_STICKS


def full_forward(_elapsed: float) -> Tuple[float, float, float, float]:
    return (0.0, 0.0, 1.0, 0.0)


# ==========================================================================
# Pure evaluators -- the acceptance criteria, testable without a socket
# ==========================================================================
def heading_slew(from_deg: float, to_deg: float) -> float:
    """Absolute shortest-arc heading change in degrees (0..180)."""
    return abs(((to_deg - from_deg + 540.0) % 360.0) - 180.0)


def position_delta(before: dict, after: dict) -> float:
    """|Δlat| + |Δlon| in degrees between two telemetry frames."""
    first = before.get("position") or {}
    second = after.get("position") or {}
    return abs(
        float(second.get("lat", 0.0)) - float(first.get("lat", 0.0))
    ) + abs(float(second.get("lon", 0.0)) - float(first.get("lon", 0.0)))


def rel_alt(telemetry: dict) -> float:
    return float((telemetry.get("position") or {}).get("relAlt", 0.0))


def groundspeed(telemetry: dict) -> float:
    return float((telemetry.get("velocity") or {}).get("groundspeed", 0.0))


@dataclass
class AxisEnvelope:
    """Folds telemetry frames into the per-axis peaks the clamps bound.

    Yaw rate is differentiated from consecutive frames. The frame's own ``ts``
    is used as the clock when the companion stamps one (it is the sampling
    instant, whereas the reader's wall clock includes queueing jitter and would
    inflate the rate); otherwise a monotonic fallback is used. The clock choice
    is made once, on the first frame, so the two are never mixed.
    """

    frames: int = 0
    peak_groundspeed: float = 0.0
    peak_climb: float = 0.0
    peak_yaw_rate: float = 0.0
    first_heading: Optional[float] = None
    last_heading: Optional[float] = None
    _wire_clock: Optional[bool] = None
    _last_stamp: Optional[float] = None

    #: Ignore an implausible dt (a stalled or rewound stamp).
    MIN_DT = 1e-3
    MAX_DT = 5.0

    def _stamp(self, telemetry: dict, fallback: float) -> Optional[float]:
        """Reading of the chosen clock, in that clock's own unit.

        Wire stamps stay in milliseconds: ``ts`` is ~1.7e12, so dividing each
        reading by 1000 before subtracting throws away the resolution the
        difference needs. ``_seconds`` scales the delta instead.
        """
        wire = telemetry.get("ts")
        usable = isinstance(wire, (int, float)) and not isinstance(wire, bool)
        if self._wire_clock is None:
            self._wire_clock = bool(usable)
        if self._wire_clock:
            return float(wire) if usable else None
        return fallback

    def _seconds(self, delta: float) -> float:
        return delta / 1000.0 if self._wire_clock else delta

    def observe(self, telemetry: dict, *, now: Optional[float] = None) -> None:
        velocity = telemetry.get("velocity") or {}
        self.peak_groundspeed = max(
            self.peak_groundspeed, float(velocity.get("groundspeed", 0.0))
        )
        self.peak_climb = max(
            self.peak_climb, abs(float(velocity.get("verticalSpeed", 0.0)))
        )

        stamp = self._stamp(
            telemetry, time.monotonic() if now is None else now
        )
        heading = telemetry.get("heading")
        if isinstance(heading, (int, float)) and not isinstance(heading, bool):
            heading = float(heading)
            if self.first_heading is None:
                self.first_heading = heading
            elif (
                self.last_heading is not None
                and stamp is not None
                and self._last_stamp is not None
            ):
                dt = self._seconds(stamp - self._last_stamp)
                if self.MIN_DT < dt <= self.MAX_DT:
                    rate = heading_slew(self.last_heading, heading) / dt
                    self.peak_yaw_rate = max(self.peak_yaw_rate, rate)
            self.last_heading = heading
        if stamp is not None:
            self._last_stamp = stamp
        self.frames += 1

    @property
    def heading_travel(self) -> float:
        if self.first_heading is None or self.last_heading is None:
            return 0.0
        return heading_slew(self.first_heading, self.last_heading)


@dataclass(frozen=True)
class StickOutcome:
    """What the stick run did to the vehicle."""

    envelope: AxisEnvelope
    heading_start: float
    heading_end: float
    alt_start: float
    alt_end: float
    moved_deg: float
    frames_sent: int


def evaluate_stick_response(outcome: StickOutcome) -> None:
    """Assert every stick axis actually reached the vehicle."""
    envelope = outcome.envelope
    moved_horiz = (
        outcome.moved_deg > RESPONSE_POSITION_DELTA
        or envelope.peak_groundspeed > RESPONSE_GROUNDSPEED
    )
    turned = (
        heading_slew(outcome.heading_start, outcome.heading_end) > RESPONSE_HEADING_DEG
        or envelope.peak_yaw_rate > RESPONSE_YAW_RATE
    )
    climbed = (
        abs(outcome.alt_end - outcome.alt_start) > RESPONSE_ALT_DELTA
        or envelope.peak_climb > RESPONSE_CLIMB_RATE
    )
    if not moved_horiz:
        raise AssertionError(
            "manual sticks did not move the vehicle horizontally "
            f"(max groundspeed {envelope.peak_groundspeed:.2f} m/s, no position change) -- "
            "pitch/roll axes appear inactive."
        )
    if not turned:
        raise AssertionError(
            "manual yaw stick did not change heading "
            f"(heading {outcome.heading_start:.1f}->{outcome.heading_end:.1f}, "
            f"max yaw-rate {envelope.peak_yaw_rate:.1f} deg/s)."
        )
    if not climbed:
        raise AssertionError(
            "manual throttle stick did not change altitude "
            f"(relAlt {outcome.alt_start:.2f}->{outcome.alt_end:.2f}, "
            f"max vspeed {envelope.peak_climb:.2f} m/s)."
        )


def evaluate_stick_clamps(envelope: AxisEnvelope, params: ManualParams) -> None:
    """Assert full deflection still respected every configured limit."""
    if envelope.peak_groundspeed > params.max_speed + params.speed_margin:
        raise AssertionError(
            f"manual horizontal speed {envelope.peak_groundspeed:.2f} m/s EXCEEDED clamp "
            f"{params.max_speed:.2f} m/s (+{params.speed_margin}) -- axis not clamped to limits."
        )
    if envelope.peak_climb > params.max_climb + params.climb_margin:
        raise AssertionError(
            f"manual climb rate {envelope.peak_climb:.2f} m/s EXCEEDED clamp "
            f"{params.max_climb:.2f} m/s (+{params.climb_margin}) -- throttle axis not clamped."
        )
    if envelope.peak_yaw_rate > params.max_yaw + params.yaw_margin:
        raise AssertionError(
            f"manual yaw rate {envelope.peak_yaw_rate:.1f} deg/s EXCEEDED clamp "
            f"{params.max_yaw:.1f} deg/s (+{params.yaw_margin}) -- yaw axis not clamped."
        )


def evaluate_watchdog(speed: float, drift: float, settle: float) -> None:
    """Assert the setpoint was zeroed and the vehicle is holding position."""
    if speed > WATCHDOG_HOLD_GS:
        raise AssertionError(
            f"WATCHDOG FAILURE: {settle:.1f}s after stopping manualInput the vehicle "
            f"is still moving at {speed:.2f} m/s -- it must zero the setpoint and hold, "
            f"never continue the last commanded velocity (PRD 11)."
        )
    if drift >= WATCHDOG_DRIFT_MAX:
        raise AssertionError(
            f"after the watchdog engaged the vehicle kept drifting (delta lat+lon="
            f"{drift:.2e} deg over {WATCHDOG_DRIFT_WINDOW_S:.0f}s) -- it is not holding position."
        )


def evaluate_auto_hold(speed: float, params: ManualParams) -> None:
    if speed > params.max_speed + params.speed_margin:
        raise AssertionError(
            f"after release the vehicle is still moving fast ({speed:.2f} m/s) -- "
            f"auto-hold did not zero the setpoint."
        )


def evaluate_emergency_stop(
    control_source: Optional[str], mode: Optional[str], armed: Optional[bool]
) -> None:
    """emergencyStop needs no confirmation and supersedes manual immediately."""
    if control_source == "manual":
        raise AssertionError(
            f"emergencyStop did NOT override manual: controlSource still {control_source!r}."
        )
    if not (mode in SAFE_STOP_MODES or armed is False):
        raise AssertionError(
            f"emergencyStop did not put the vehicle in a safe stop state "
            f"(mode={mode!r}, armed={armed!r}); expected LAND/BRAKE/RTL or disarm."
        )


# ==========================================================================
# The gate itself
# ==========================================================================
class ManualGate:
    """Phase implementations for the manual-piloting safety sequence."""

    def __init__(
        self,
        client: HeadlessClient,
        params: ManualParams,
        *,
        echo: Callable[[str], None] = print,
    ) -> None:
        self.client = client
        self.params = params
        self.echo = echo

    # -- machine wiring ------------------------------------------------
    def machine(self) -> PhaseMachine:
        return PhaseMachine(
            tag=TAG,
            phases={
                "connect": self.connect,
                "reject": self.reject_before_airborne,
                "arm": self.arm,
                "takeoff": self.takeoff,
                "track": self.engage_tracking,
                "manual": self.engage_manual,
                "sticks": self.verify_sticks,
                "watchdog": self.verify_watchdog,
                "release": self.release,
                "estop": self.verify_emergency_stop,
            },
            start="connect",
            echo=self.echo,
        )

    def say(self, message: str) -> None:
        self.echo(f"[{TAG}] {message}")

    def telemetry(self) -> dict:
        return self.client.last_telemetry or {}

    # -- phases --------------------------------------------------------
    async def connect(self) -> str:
        self.say(f"connecting to {self.params.ws_url} ...")
        await self.client.connect()
        await self.client.wait_for_telemetry(
            lambda _t: True, timeout=20.0, desc="first telemetry"
        )
        return "reject"

    async def reject_before_airborne(self) -> str:
        """NEGATIVE: engageManual must be refused on the ground / disarmed."""
        self.say("(negative) engageManual must be REJECTED before armed+airborne ...")
        ack = await self.client.send_command("engageManual", timeout=10.0)
        if ack.get("success"):
            raise AssertionError(
                "engageManual was ACCEPTED while not armed+airborne -- this violates "
                "the manual-control safety precondition (PRD 11)."
            )
        if self.client.control_source == "manual":
            raise AssertionError(
                "controlSource became 'manual' despite engageManual being refused."
            )
        self.say(f"  correctly rejected: {ack.get('message')!r}")
        return "arm"

    async def arm(self) -> str:
        self.say("arming + taking off ...")
        await self.client.send_command("arm", expect_success=True, timeout=15.0)
        await self.client.wait_for_telemetry(
            lambda t: bool(t.get("armed")), timeout=20.0, desc="armed"
        )
        return "takeoff"

    async def takeoff(self) -> str:
        floor = self.params.takeoff_alt - AIRBORNE_TOLERANCE
        await self.client.send_command(
            "takeoff",
            {"altitude": self.params.takeoff_alt},
            expect_success=True,
            timeout=15.0,
        )
        airborne = await self.client.wait_for_telemetry(
            lambda t: rel_alt(t) >= floor, timeout=60.0, desc="airborne"
        )
        self.say(f"airborne at relAlt={rel_alt(airborne):.2f} m.")
        return "track"

    async def engage_tracking(self) -> str:
        """Engage tracking FIRST, so manual can prove it auto-releases."""
        self.say("engageTracking (so manual can prove it auto-releases) ...")
        await self.client.send_command(
            "engageTracking", expect_success=True, timeout=15.0
        )
        await self.client.wait_for_telemetry(
            lambda t: t.get("controlSource") == "tracking",
            timeout=20.0,
            desc="controlSource=='tracking'",
        )
        self.say("tracking engaged (controlSource=='tracking').")
        return "manual"

    async def engage_manual(self) -> str:
        self.say("engageManual ...")
        await self.client.send_command(
            "engageManual", expect_success=True, timeout=10.0
        )
        await self.client.wait_for_telemetry(
            lambda t: t.get("controlSource") == "manual",
            timeout=10.0,
            desc="controlSource=='manual'",
        )
        # Control sources are mutually exclusive: tracking must have released.
        released = await self.client.wait_for_tracking(
            lambda tr: tr.get("state") != "locked" or tr.get("lockedTargetId") is None,
            timeout=10.0,
            desc="tracking auto-released by engageManual",
        )
        self.say(
            f"manual engaged: controlSource=='manual', tracking released "
            f"(state={released.get('state')})."
        )
        return "sticks"

    async def verify_sticks(self) -> str:
        """Stream manualInput and assert the vehicle responds AND stays clamped."""
        self.say("streaming manualInput; asserting response within clamps ...")
        before = self.telemetry()
        envelope = AxisEnvelope()
        watcher = asyncio.ensure_future(self._fold_telemetry(envelope, STICK_RUN_S))
        try:
            sent = await self.client.stream_manual_input(
                scripted_sticks, duration=STICK_RUN_S, rate_hz=STICK_RATE_HZ
            )
        finally:
            await watcher

        after = self.telemetry()
        outcome = StickOutcome(
            envelope=envelope,
            heading_start=float(before.get("heading", 0.0)),
            heading_end=float(after.get("heading", before.get("heading", 0.0))),
            alt_start=rel_alt(before),
            alt_end=rel_alt(after),
            moved_deg=position_delta(before, after),
            frames_sent=sent,
        )
        evaluate_stick_response(outcome)
        evaluate_stick_clamps(envelope, self.params)
        self.say(
            f"  responded + clamped: gs<= {envelope.peak_groundspeed:.2f} "
            f"(cap {self.params.max_speed}), vs<= {envelope.peak_climb:.2f} "
            f"(cap {self.params.max_climb}), yaw<= {envelope.peak_yaw_rate:.1f} deg/s "
            f"(cap {self.params.max_yaw}); {sent} frames sent."
        )
        return "watchdog"

    async def _fold_telemetry(self, envelope: AxisEnvelope, duration: float) -> None:
        """Fold every telemetry frame published during ``duration`` seconds."""
        async with contextlib.aclosing(
            self.client.follow("telemetry", timeout=duration)
        ) as frames:
            async for telemetry in frames:
                envelope.observe(telemetry)

    async def verify_watchdog(self) -> str:
        """Drive forward, STOP sending input, assert the watchdog zeroes + holds."""
        params = self.params
        self.say(
            f"driving forward then STOPPING input; "
            f"asserting watchdog ({params.watchdog_ms}ms) zeroes + holds ..."
        )
        # Drive full-forward briefly so there's real velocity to arrest.
        await self.client.stream_manual_input(
            full_forward, duration=WATCHDOG_DRIVE_S, rate_hz=STICK_RATE_HZ
        )

        # Now send NOTHING. Wait several watchdog periods to engage + settle.
        settle = params.watchdog_settle_s
        await asyncio.sleep(settle)
        speed = groundspeed(self.telemetry())

        # Position should be roughly stationary over a follow-up window.
        anchor = self.telemetry()
        await asyncio.sleep(WATCHDOG_DRIFT_WINDOW_S)
        drift = position_delta(anchor, self.telemetry())

        evaluate_watchdog(speed, drift, settle)
        self.say(
            f"  watchdog held: groundspeed {speed:.2f} m/s, position drift {drift:.2e} deg."
        )
        return "release"

    async def release(self) -> str:
        self.say("disengageManual ...")
        await self.client.send_command(
            "disengageManual", expect_success=True, timeout=10.0
        )
        await self.client.wait_for_telemetry(
            lambda t: t.get("controlSource") == "auto",
            timeout=10.0,
            desc="controlSource=='auto' after release",
        )
        # Auto-hold: groundspeed should settle low, not continue prior motion.
        await asyncio.sleep(self.params.release_settle_s)
        speed = groundspeed(self.telemetry())
        evaluate_auto_hold(speed, self.params)
        self.say(
            f"released: controlSource=='auto', groundspeed={speed:.2f} m/s (auto-hold)."
        )
        return "estop"

    async def verify_emergency_stop(self) -> None:
        """Re-engage manual, then assert emergencyStop overrides it INSTANTLY."""
        self.say("re-engageManual, then emergencyStop must override instantly ...")
        await self.client.send_command(
            "engageManual", expect_success=True, timeout=10.0
        )
        await self.client.wait_for_telemetry(
            lambda t: t.get("controlSource") == "manual",
            timeout=10.0,
            desc="controlSource=='manual' before emergencyStop",
        )

        # Keep sticks flowing: the stop must override ACTIVE manual input.
        halt = asyncio.Event()
        streamer = asyncio.ensure_future(
            self.client.stream_manual_input(
                full_forward,
                duration=ESTOP_STREAM_S,
                rate_hz=STICK_RATE_HZ,
                stop=halt,
            )
        )
        try:
            # Fire emergencyStop (acked or not, it must take effect).
            await self.client.send_command("emergencyStop", timeout=10.0)
            await self.client.wait_for_telemetry(
                lambda t: t.get("controlSource") != "manual",
                timeout=6.0,
                desc="emergencyStop overrides manual (controlSource leaves 'manual')",
            )
        finally:
            halt.set()
            with contextlib.suppress(Exception):
                await streamer

        telemetry = self.telemetry()
        source = self.client.control_source
        mode = telemetry.get("mode")
        armed = telemetry.get("armed")
        evaluate_emergency_stop(source, mode, armed)
        self.say(
            f"  emergencyStop overrode manual: controlSource={source!r}, "
            f"mode={mode!r}, armed={armed!r}."
        )
        self.say("PASS -- manual safety behaviours all verified.")
        return None


async def safe_state(client: HeadlessClient) -> None:
    """Best-effort safe-state on the way out (disarm), never fatal."""
    with contextlib.suppress(Exception):
        await client.send_command("disarm", timeout=5.0)


def build_gate(params: ManualParams) -> Tuple[HeadlessClient, PhaseMachine]:
    client = HeadlessClient(params.ws_url, vehicle_id=params.vehicle_id)
    return client, ManualGate(client, params).machine()


# --------------------------------------------------------------------------
# pytest + standalone entry points
# --------------------------------------------------------------------------
def test_manual_piloting() -> None:
    """pytest wrapper: runs the full manual-safety sequence, fails on any assert."""
    client, machine = build_gate(ManualParams.from_env())
    asyncio.run(drive_acceptance(client, machine, on_exit=safe_state))


def main(argv: Optional[Sequence[str]] = None) -> int:
    client, machine = build_gate(ManualParams.from_args(argv))
    return run_acceptance(TAG, client, machine, on_exit=safe_state)


if __name__ == "__main__":
    raise SystemExit(main())
