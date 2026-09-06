"""Control-source arbitration and the two zero-and-hold watchdogs.

Two invariants from PRD 11, driven against the real orchestrator:

  * EXACTLY ONE control source is active at a time, the arbitration ladder
    decides which, and the label reported in telemetry is that same decision --
    telemetry can never disagree with who is actually flying.
  * both watchdogs ZERO AND HOLD rather than coasting. The manual-input
    watchdog stops honouring stale sticks; the ground-link deadman stops
    honouring the operator entirely, latches, and keeps acting.

The ladder's ORDER is itself an invariant, so it is tested by construction:
each stage is exercised against a state that would otherwise have produced a
different setpoint, which is only possible if the higher stage really does win.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from eis_companion.app import Companion
from eis_companion.config import AppConfig
from eis_companion.types import ControlSource, Limits, VehicleState

HOLD = (0.0, 0.0, 0.0, 0.0, False)


def run(coro):
    return asyncio.run(coro)


# ==========================================================================
# Fakes
# ==========================================================================
class RecordingVehicle:
    """Records every FC-bound call as a tuple."""

    def __init__(self) -> None:
        self.calls: list = []
        self.limits = Limits()
        #: Set to a dict to make get_telemetry() return it.
        self.telemetry = None

    def get_telemetry(self):
        if self.telemetry is None:
            raise RuntimeError("no telemetry from this fake")
        return dict(self.telemetry)

    def send_body_velocity(self, vx, vy, vz, yaw_rate, valid=True):
        self.calls.append(("vel", vx, vy, vz, yaw_rate, valid))

    def send_heartbeat(self):
        self.calls.append(("heartbeat",))
        return True

    def set_mode(self, mode):
        self.calls.append(("mode", mode))
        return True

    def goto_global(self, lat, lon, rel_alt, speed, **kwargs):
        self.calls.append(("goto", lat, lon, rel_alt, speed))
        return True

    def arm(self):
        self.calls.append(("arm",))

    def disarm(self, force=False):
        self.calls.append(("disarm", force))

    def land(self):
        self.calls.append(("land",))

    def takeoff(self, altitude):
        self.calls.append(("takeoff", altitude))

    def update_limits(self, limits):
        self.limits = limits

    def named(self, name: str) -> list:
        return [c for c in self.calls if c[0] == name]

    def velocities(self) -> list:
        """Just the (vx, vy, vz, yaw, valid) tuples, in order."""
        return [c[1:] for c in self.calls if c[0] == "vel"]


class CapturingApi:
    """Captures outbound frames in place of the real ApiServer."""

    def __init__(self) -> None:
        self.sent: list = []
        self.loopback_only = True

    async def broadcast(self, message):
        self.sent.append(dict(message))

    async def push_status(self, severity, text):
        self.sent.append(
            {"type": "statusText", "severity": severity, "text": text}
        )

    async def push_telemetry(self, telemetry):
        self.sent.append(dict(telemetry))

    async def push_tracking(self, tracking):
        self.sent.append(dict(tracking))

    def of_type(self, wire_type: str) -> list:
        return [m for m in self.sent if m.get("type") == wire_type]


class ConstantGuidance:
    """Stands in for control.Guidance with a fixed, obvious setpoint."""

    def __init__(self, vx=1.25) -> None:
        self.vx = vx
        self.resets = 0

    def update(self, state, bbox, distance, limits, dt):
        from eis_companion.types import VelocitySetpoint
        return VelocitySetpoint(vx=self.vx, valid=True)

    def reset(self):
        self.resets += 1


class ConstantManual:
    """Stands in for control.ManualPilot with a fixed, obvious setpoint."""

    def __init__(self, vy=0.75) -> None:
        self.vy = vy
        self.resets = 0
        self.inputs: list = []

    def set_input(self, **axes):
        self.inputs.append(axes)

    def update(self, limits, dt):
        from eis_companion.types import VelocitySetpoint
        return VelocitySetpoint(vy=self.vy, valid=True)

    def reset(self):
        self.resets += 1


def make_companion() -> Companion:
    cfg = AppConfig()
    cfg.sitl = True
    cfg.camera.source = "sim"
    cfg.planner.site_file = "site/site.stub.json"
    c = Companion(cfg)
    c.setup()
    c.vehicle = RecordingVehicle()
    c.guidance = ConstantGuidance()
    c.manual = ConstantManual()
    c._fc_ready = True
    c._vehicle_state = airborne()
    # A locked track so guidance has something to servo to.
    c._latest_tracking = SimpleNamespace(
        state="locked", locked_bbox=(0.4, 0.4, 0.2, 0.4),
        estimated_distance=8.0, targets=[], locked_target_id=1,
    )
    return c


def airborne(mode="GUIDED") -> VehicleState:
    return VehicleState(
        armed=True, airborne=True, mode=mode,
        lat=-26.0900, lon=29.4719, relAlt=25.0, heading=0.0,
    )


def link_alive(c: Companion) -> None:
    """Pretend the ground just spoke, so the deadman does not trip."""
    c.safety.note_ground_heartbeat()
    c._link_lost_latched = False


def link_dead(c: Companion) -> None:
    """Age the ground link far past ``ground_link_timeout_ms``."""
    c.safety._last_ground_hb_ms -= 10_000.0


# ==========================================================================
# Exactly one source, and telemetry agrees with it
# ==========================================================================
@pytest.mark.parametrize("engage,expected", [
    ("_tracking_engaged", ControlSource.TRACKING.value),
    ("_manual_engaged", ControlSource.MANUAL.value),
    ("_planner_engaged", ControlSource.PLANNER.value),
])
def test_the_active_source_is_stamped_into_every_telemetry_frame(engage, expected):
    """The orchestrator is the single source of truth, and the wire says so."""
    c = make_companion()
    c.api = CapturingApi()
    setattr(c, engage, True)
    c._set_control_source(expected)
    run(c._telemetry_tick())

    assert c._control_source == expected
    assert c._vehicle_state.control_source == expected
    assert c.api.of_type("telemetry")[-1]["controlSource"] == expected


def test_the_stamped_source_overrides_whatever_the_fc_layer_reported():
    """An FC layer that guesses at controlSource must not win."""
    c = make_companion()
    c.api = CapturingApi()
    c.vehicle.telemetry = {"type": "telemetry", "controlSource": "manual"}
    c._set_control_source(ControlSource.AUTO.value)

    run(c._telemetry_tick())
    assert c.api.of_type("telemetry")[-1]["controlSource"] == ControlSource.AUTO.value


def test_release_all_clears_every_engagement_flag_at_once():
    c = make_companion()
    c._tracking_engaged = True
    c._manual_engaged = True
    c._planner_engaged = True

    c._release_all(ControlSource.AUTO.value)

    assert (c._tracking_engaged, c._manual_engaged, c._planner_engaged) == (
        False, False, False
    )
    assert c._control_source == ControlSource.AUTO.value
    assert c._vehicle_state.control_source == ControlSource.AUTO.value
    assert c._takeoff_deadline_ms == 0.0


def test_release_all_resets_the_wound_up_controllers():
    """PID and stick-smoothing state must not be inherited by the next engage."""
    c = make_companion()
    c._release_all(ControlSource.AUTO.value)
    assert c.guidance.resets == 1
    assert c.manual.resets == 1


# ==========================================================================
# Arbitration: which source actually produces the setpoint
# ==========================================================================
def test_tracking_flies_the_guidance_setpoint():
    c = make_companion()
    link_alive(c)
    c._tracking_engaged = True
    c._set_control_source(ControlSource.TRACKING.value)

    run(c._control_tick(0.05))
    assert c.vehicle.velocities()[-1] == (1.25, 0.0, 0.0, 0.0, True)


def test_manual_beats_tracking_even_with_a_locked_track():
    """A hands-on operator wins over every automated source below it."""
    c = make_companion()
    link_alive(c)
    c._tracking_engaged = True
    c._manual_engaged = True
    c._last_manual_input_ms = _now_ms_of(c)
    c._set_control_source(ControlSource.MANUAL.value)

    run(c._control_tick(0.05))
    assert c.vehicle.velocities()[-1] == (0.0, 0.75, 0.0, 0.0, True)


def test_a_plan_flying_a_tracking_tool_uses_guidance_not_the_executor():
    c = make_companion()
    link_alive(c)
    c._planner_engaged = True
    c._planner_tracking_tool = "follow"
    c._set_control_source(ControlSource.PLANNER.value)

    run(c._control_tick(0.05))
    assert c.vehicle.velocities()[-1] == (1.25, 0.0, 0.0, 0.0, True)


def test_no_engaged_source_holds():
    c = make_companion()
    link_alive(c)
    run(c._control_tick(0.05))
    assert c.vehicle.velocities()[-1] == HOLD


def test_guidance_preconditions_gate_every_source():
    """Armed + airborne + GUIDED. Anything else holds, whatever is engaged."""
    for mode in ("LOITER", "RTL", "STABILIZE"):
        c = make_companion()
        link_alive(c)
        c._vehicle_state = airborne(mode=mode)
        c._tracking_engaged = True
        c._set_control_source(ControlSource.TRACKING.value)

        run(c._control_tick(0.05))
        assert c.vehicle.velocities()[-1] == HOLD, f"{mode} must not fly guidance"


def test_the_estop_latch_outranks_a_hands_on_operator():
    """The ladder's top stage: nothing commands motion while latched."""
    c = make_companion()
    link_alive(c)
    c._manual_engaged = True
    c._last_manual_input_ms = _now_ms_of(c)
    c._estop_latched = True

    run(c._control_tick(0.05))
    assert c.vehicle.velocities()[-1] == HOLD


def test_the_estop_latch_clears_only_on_the_ground():
    c = make_companion()
    c._estop_latched = True
    c._vehicle_state = airborne()

    c._maybe_clear_estop()
    assert c._estop_latched is True, "airborne + armed must keep the latch"

    c._vehicle_state = VehicleState(armed=False, airborne=False, mode="STABILIZE")
    c._maybe_clear_estop()
    assert c._estop_latched is False


# ==========================================================================
# Manual-input watchdog: zero and hold, never coast
# ==========================================================================
def _now_ms_of(c: Companion) -> float:
    from eis_companion.app import _now_ms
    return _now_ms()


def test_fresh_sticks_are_flown():
    c = make_companion()
    c._manual_engaged = True
    c._last_manual_input_ms = _now_ms_of(c)
    setpoint = run(c._manual_setpoint(0.05))
    assert setpoint.valid is True and setpoint.vy == 0.75


def test_stale_sticks_zero_and_hold_rather_than_coasting():
    c = make_companion()
    c._manual_engaged = True
    c._last_manual_input_ms = _now_ms_of(c) - (c.limits.manual_watchdog_ms + 500)

    setpoint = run(c._manual_setpoint(0.05))
    assert setpoint.valid is False
    assert (setpoint.vx, setpoint.vy, setpoint.vz, setpoint.yaw_rate) == (
        0.0, 0.0, 0.0, 0.0
    )
    assert c.manual.resets == 1, "the pilot is reset so smoothing cannot coast"


def test_the_manual_watchdog_opens_closed():
    """Never having received a frame counts as stale, not as 'no timeout yet'."""
    c = make_companion()
    c._manual_engaged = True
    c._last_manual_input_ms = 0.0
    assert c._manual_input_stale() is True
    assert run(c._manual_setpoint(0.05)).valid is False


def test_a_stray_stick_frame_cannot_command_motion_in_auto():
    """Arrival is recorded (it is liveness) but the sticks go nowhere."""
    c = make_companion()
    c._manual_engaged = False
    c._handle_manual_input({
        "type": "manualInput", "throttle": 1.0, "yaw": 1.0,
        "pitch": 1.0, "roll": 1.0,
    })
    assert c._last_manual_input_ms > 0.0
    assert c.manual.inputs == []


def test_a_non_finite_axis_drops_the_frame_whole_and_stalls_the_watchdog():
    c = make_companion()
    c._manual_engaged = True
    c._last_manual_input_ms = 0.0
    c._handle_manual_input({
        "type": "manualInput", "throttle": float("nan"), "yaw": 0.0,
        "pitch": 0.5, "roll": 0.0,
    })
    assert c.manual.inputs == [], "a partially usable frame is not a frame"
    assert c._last_manual_input_ms == 0.0, "the watchdog must NOT be refreshed"


def test_a_non_numeric_axis_drops_the_frame_whole():
    c = make_companion()
    c._manual_engaged = True
    c._last_manual_input_ms = 0.0
    c._handle_manual_input({"type": "manualInput", "pitch": "hard left"})
    assert c.manual.inputs == []
    assert c._last_manual_input_ms == 0.0


# ==========================================================================
# Ground-link deadman: zero, hold, latch, and KEEP acting
# ==========================================================================
def test_a_dead_link_zeroes_and_holds_before_anything_else():
    c = make_companion()
    c._tracking_engaged = True
    c._set_control_source(ControlSource.TRACKING.value)
    link_dead(c)
    c.vehicle.calls.clear()

    run(c._control_tick(0.05))
    assert c.vehicle.velocities()[0] == HOLD, "the FIRST thing sent is the hold"
    assert c._link_lost_latched is True


def test_a_dead_link_releases_the_operator_to_auto():
    c = make_companion()
    c._tracking_engaged = True
    c._set_control_source(ControlSource.TRACKING.value)
    link_dead(c)

    run(c._control_tick(0.05))
    assert c._tracking_engaged is False
    assert c._control_source == ControlSource.AUTO.value


def test_an_airborne_deadman_escalates_to_rtl():
    c = make_companion()
    c._manual_engaged = True
    c._set_control_source(ControlSource.MANUAL.value)
    link_dead(c)
    c.vehicle.calls.clear()

    run(c._control_tick(0.05))
    assert ("mode", "RTL") in c.vehicle.calls


def test_the_latch_survives_the_release_and_keeps_holding():
    """FM-03: the deadman used to silence its own trigger. Releasing to 'auto'
    is exactly the source ``evaluate_link`` stops tripping on, so the latch --
    not the source -- is what keeps it awake."""
    c = make_companion()
    c._tracking_engaged = True
    c._set_control_source(ControlSource.TRACKING.value)
    link_dead(c)
    run(c._control_tick(0.05))

    # Source is now 'auto', so evaluate_link alone would report a healthy tick.
    assert c.safety.evaluate_link(c._control_source, airborne=True).tripped is False
    c.vehicle.calls.clear()

    run(c._control_tick(0.05))
    assert c._link_lost_latched is True
    assert c.vehicle.velocities()[0] == HOLD, "still held on the next tick"


def test_the_deadman_stops_the_companions_own_fc_heartbeat():
    """The companion IS the FC's GCS. Pumping the heartbeat through an outage
    kept FS_GCS_ENABLE's timer alive and suppressed the firmware backstop."""
    c = make_companion()
    c._link_lost_latched = True
    c._last_fc_heartbeat_sent_s = 0.0
    run(c._telemetry_tick())
    assert c.vehicle.named("heartbeat") == []


def test_an_authorized_frame_clears_the_latch_and_the_timestamp_together():
    c = make_companion()
    c._link_lost_latched = True
    c.safety._last_ground_hb_ms -= 10_000.0

    from eis_companion.app import _now_ms
    c._note_ground_heartbeat(_now_ms())

    assert c._link_lost_latched is False
    assert c.safety.evaluate_link(
        ControlSource.TRACKING.value, airborne=True
    ).tripped is False


def test_plain_auto_never_trips_the_companion_deadman():
    """Link loss in auto is the FC's GCS failsafe to handle, not ours."""
    c = make_companion()
    link_dead(c)
    c._set_control_source(ControlSource.AUTO.value)
    c.vehicle.calls.clear()

    run(c._control_tick(0.05))
    assert c._link_lost_latched is False
    assert c.vehicle.named("mode") == []


# ==========================================================================
# The last clamp: every setpoint is bounded before it reaches the FC
# ==========================================================================
def test_the_final_clamp_bounds_every_axis_to_limits():
    from eis_companion.types import VelocitySetpoint

    c = make_companion()
    limits = c.limits
    clamped = c._clamp_setpoint(VelocitySetpoint(
        vx=999.0, vy=-999.0, vz=999.0, yaw_rate=-999.0, valid=True,
    ))
    assert clamped.vx == pytest.approx(limits.max_speed)
    assert clamped.vy == pytest.approx(-limits.max_speed)
    assert clamped.vz == pytest.approx(limits.max_climb_rate)
    assert clamped.yaw_rate == pytest.approx(-limits.max_yaw_rate)


def test_a_single_non_finite_axis_collapses_the_whole_setpoint():
    from eis_companion.types import VelocitySetpoint

    c = make_companion()
    clamped = c._clamp_setpoint(VelocitySetpoint(
        vx=1.0, vy=float("nan"), vz=0.0, yaw_rate=0.0, valid=True,
    ))
    assert clamped.valid is False
    assert (clamped.vx, clamped.vy, clamped.vz, clamped.yaw_rate) == (
        0.0, 0.0, 0.0, 0.0
    )


def test_the_envelope_scale_can_only_tighten_the_clamp():
    from eis_companion.types import VelocitySetpoint

    c = make_companion()
    c._envelope_speed_scale = 0.5
    half = c._clamp_setpoint(VelocitySetpoint(vx=999.0, valid=True))
    assert half.vx == pytest.approx(c.limits.max_speed * 0.5)

    # A monitor bug offering a scale above 1.0 cannot become an amplifier.
    c._envelope_speed_scale = 4.0
    assert c._clamp_setpoint(VelocitySetpoint(vx=999.0, valid=True)).vx == (
        pytest.approx(c.limits.max_speed)
    )
