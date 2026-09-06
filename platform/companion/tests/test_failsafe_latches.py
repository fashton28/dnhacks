"""Failsafe latches, verification and retry (FM-01/02/03/04/17/18/24).

Every test here drives the REAL orchestrator over MULTIPLE control ticks. That
is the point: the pre-fix suite only ever ran one tick after a trip, and every
one of these defects is invisible on tick 1 and obvious on tick 2.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from eis_companion.app import Companion
from eis_companion.config import AppConfig
from eis_companion.control.failsafe import FailsafeDecision
from eis_companion.types import ControlSource, Limits, VehicleState

STUB_SITE = "site/site.stub.json"
HOME_LAT, HOME_LON = -26.0900, 29.4719


class FakeVehicle:
    """Records FC-bound calls; ``mode_accepts`` scripts set_mode's verdict."""

    def __init__(self, *, mode_accepts=True, mode_readback=True) -> None:
        self.calls: list = []
        self.limits = Limits()
        self.mode = "GUIDED"
        self._mode_accepts = mode_accepts
        self._mode_readback = mode_readback
        self.heartbeats = 0

    def send_body_velocity(self, vx, vy, vz, yaw_rate, valid=True):
        self.calls.append(("vel", vx, vy, vz, yaw_rate, valid))

    def send_heartbeat(self):
        self.heartbeats += 1
        self.calls.append(("heartbeat",))
        return True

    def goto_global(self, lat, lon, rel_alt, speed, **kwargs):
        self.calls.append(("goto", lat, lon, rel_alt, speed))
        return True

    def set_mode(self, mode):
        self.calls.append(("mode", mode))
        if not self._mode_accepts:
            return False
        if self._mode_readback:
            self.mode = mode
        return True

    def arm(self):
        self.calls.append(("arm",))
        return True

    def takeoff(self, altitude):
        self.calls.append(("takeoff", altitude))
        return True

    def land(self):
        self.calls.append(("land",))
        return self._mode_accepts

    def disarm(self, force=False):
        self.calls.append(("disarm", force))
        return True

    def update_limits(self, limits):
        self.limits = limits

    def upload_geofence(self, perimeter, **kwargs):
        self.calls.append(("fence", list(perimeter)))
        return True

    def fence_status(self):
        return {"stored": True, "enabled": True, "enforced": True, "detail": "ok"}

    def named(self, name: str) -> list:
        return [c for c in self.calls if c[0] == name]


def make_companion(site_file: str = STUB_SITE, **vehicle_kwargs) -> Companion:
    cfg = AppConfig()
    cfg.sitl = True
    cfg.camera.source = "sim"
    cfg.planner.site_file = site_file
    c = Companion(cfg)
    c.setup()
    c.vehicle = FakeVehicle(**vehicle_kwargs)
    c._fc_ready = True
    # Pin the battery snapshot (the FakeVehicle reports no pack, so the real
    # estimator would derive 0 % SoC and RTL for reserve, masking the states
    # these tests are about) -- same idiom as tests/test_envelope_wiring.py.
    c.battery_health = None
    c._battery_snapshot = SimpleNamespace(
        ready=True, reasons=(), eta_ready_s=0.0, fault="",
        reserve_should_rtl=False, sortie_should_rtl=False,
        elapsed_sortie_s=10.0, cap_s=480.0, must_rtl_by_s=450.0,
        soc_pct=95.0, voltage_v=12.4, current_a=1.0, cell_delta_v=0.01,
        temp_c=25.0, remaining_s=900.0, charge_state="charged", event="",
        degraded_estimate=False,
    )
    c._nav_snapshot = SimpleNamespace(
        refuse_missions=False, gps_healthy=True, reason="GPS healthy", source="gps"
    )
    return c


def airborne(alt=25.0, mode="GUIDED") -> VehicleState:
    return VehicleState(
        armed=True, airborne=True, mode=mode,
        lat=HOME_LAT, lon=HOME_LON, relAlt=alt, heading=0.0,
    )


def run(coro):
    return asyncio.run(coro)


def dispatch(c: Companion, command: str, params=None):
    return run(c._handle_command({"command": command, "params": params or {}}))


def valid_plan(tools=None):
    return {
        "requestId": "req-1", "anomalyId": "anom-1", "profile": "standard",
        "rationale": "test",
        "tools": tools or [{"tool": "hold", "durationS": 30.0}],
    }


def starve_link(c: Companion) -> None:
    c.safety._last_ground_hb_ms -= 10_000.0


# ==========================================================================
# FM-03: the deadman must not silence its own trigger
# ==========================================================================
def test_deadman_keeps_acting_after_the_release_resets_the_control_source():
    """Tick 1 releases to 'auto'; ticks 2..N must STILL see the link as lost.

    Pre-fix, `_on_deadman` set `_control_source = 'auto'`, and both
    `evaluate_link` and `_actual_datalink_lost` gate on the source being
    tracking/manual/planner -- so from tick 2 the outage was invisible, exactly
    one unverified RTL was ever attempted, and telemetry reported
    `failsafeState: none` for the whole outage.
    """
    c = make_companion()
    c._vehicle_state = airborne()
    assert dispatch(c, "executePlan", {"plan": valid_plan()})["success"] is True
    starve_link(c)

    run(c._control_tick(0.05))
    assert c._link_lost_latched is True
    assert c._control_source == ControlSource.AUTO.value

    # The source is now 'auto' -- the exact state the old gate stopped tripping
    # on. The latch must survive it.
    for _ in range(4):
        run(c._control_tick(0.05))
    assert c._link_lost_latched is True
    assert c._actual_datalink_lost() is True


def test_a_tripped_deadman_reaches_the_failsafe_state_on_the_wire():
    """docs/FAILURE_MODES contract row: datalink loss -> `hold` within 5 s."""
    c = make_companion()
    c._vehicle_state = airborne()
    dispatch(c, "executePlan", {"plan": valid_plan()})
    starve_link(c)
    run(c._control_tick(0.05))          # trips + latches

    run(c._health_tick({"battery": {}}))
    assert c._failsafe_decision is not None
    assert c._failsafe_decision.state == "hold"
    assert "datalink" in c._failsafe_decision.reason


def test_a_tripped_deadman_raises_an_audited_health_event_not_only_statustext():
    """statusText goes to zero clients during a link outage, by definition."""
    c = make_companion()
    events: list = []

    class Api:
        async def broadcast(self, message):
            events.append(dict(message))

        async def push_status(self, severity, text):
            events.append({"type": "statusText", "severity": severity, "text": text})

        async def push_telemetry(self, t):
            pass

        async def push_tracking(self, t):
            pass

    c.api = Api()
    c._vehicle_state = airborne()
    dispatch(c, "executePlan", {"plan": valid_plan()})
    starve_link(c)
    run(c._control_tick(0.05))

    health = [
        e for e in events
        if e.get("type") == "healthEvent" and e.get("state") == "deadman"
    ]
    assert health, "the deadman must emit an audited, replayable healthEvent"


def test_a_tripped_deadman_stops_the_gcs_heartbeat_so_fs_gcs_can_fire():
    """The companion IS the FC's GCS; pumping the beat suppressed FS_GCS."""
    c = make_companion()
    c._vehicle_state = airborne()
    c._last_fc_heartbeat_sent_s = 0.0
    run(c._telemetry_tick())
    assert c.vehicle.heartbeats == 1

    c._link_lost_latched = True
    c._last_fc_heartbeat_sent_s = 0.0
    run(c._telemetry_tick())
    assert c.vehicle.heartbeats == 1, "no GCS heartbeat while the deadman is tripped"


def test_a_fresh_ground_heartbeat_clears_the_deadman_latch():
    c = make_companion()
    c._vehicle_state = airborne()
    dispatch(c, "executePlan", {"plan": valid_plan()})
    starve_link(c)
    run(c._control_tick(0.05))
    assert c._link_lost_latched is True

    c._note_ground_heartbeat(0.0)   # ts ignored: SafetyManager takes 'now'
    c.safety.note_ground_heartbeat()
    assert c._link_lost_latched is False
    assert c._actual_datalink_lost() is False


def test_the_deadman_release_resets_guidance_and_manual_state():
    """It hand-rolled the release and skipped guidance/manual reset."""
    c = make_companion()
    c._vehicle_state = airborne()
    dispatch(c, "engageTracking")
    resets = {"guidance": 0, "manual": 0}
    c.guidance.reset = lambda: resets.__setitem__("guidance", resets["guidance"] + 1)
    c.manual.reset = lambda: resets.__setitem__("manual", resets["manual"] + 1)
    starve_link(c)

    run(c._control_tick(0.05))
    assert resets["guidance"] >= 1
    assert resets["manual"] >= 1
    assert c._vehicle_state.control_source == ControlSource.AUTO.value


# ==========================================================================
# FM-01 / FM-02: RTL is latched only once it is OBSERVED
# ==========================================================================
def test_a_refused_rtl_is_retried_instead_of_being_latched_as_done():
    """set_mode returning False used to be indistinguishable from success."""
    c = make_companion(mode_accepts=False)
    c._vehicle_state = airborne()
    c._failsafe_decision = FailsafeDecision("rtl", "battery reserve reached", "companion")

    run(c._control_tick(0.05))
    first = len(c.vehicle.named("mode"))
    assert first >= 1
    assert c._last_applied_failsafe.startswith("rtl-pending:")

    # The retry is throttled, not abandoned: advance past the throttle window.
    c._rtl_last_attempt_ms -= 2000.0
    run(c._control_tick(0.05))
    assert len(c.vehicle.named("mode")) > first, "a refused RTL must be re-asserted"


def test_a_confirmed_rtl_is_latched_and_not_re_commanded():
    c = make_companion()
    c._vehicle_state = airborne()
    c._failsafe_decision = FailsafeDecision("rtl", "battery reserve reached", "companion")

    run(c._control_tick(0.05))
    assert ("mode", "RTL") in c.vehicle.calls
    # The FakeVehicle's readback now reports RTL; reflect it in vehicle state.
    c._vehicle_state = airborne(mode="RTL")
    sent = len(c.vehicle.named("mode"))
    c._rtl_last_attempt_ms -= 2000.0
    run(c._control_tick(0.05))
    assert len(c.vehicle.named("mode")) == sent, "no spam once RTL is observed"


def test_vehicle_set_mode_refuses_a_mode_the_fc_never_confirms():
    """Vehicle.set_mode must not report success it cannot evidence (FM-02)."""
    from eis_companion.mavlink.vehicle import Vehicle

    class Master:
        target_system = 1
        target_component = 1

        def __init__(self):
            self.sent = []
            self.inbox = []

        class _Mav:
            def __init__(self, sent):
                self._sent = sent

            def __getattr__(self, name):
                if not name.endswith("_send"):
                    raise AttributeError(name)

                def _send(*args):
                    self._sent.append((name[:-5], args))
                return _send

        @property
        def mav(self):
            return Master._Mav(self.sent)

        def recv_match(self, type=None, blocking=False, timeout=None):
            return None

        def mode_mapping(self):
            return {"GUIDED": 4, "RTL": 6}

    v = Vehicle()
    v._master = Master()
    v._connected = True
    v._mode_mapping = {"GUIDED": 4, "RTL": 6}
    v._inv_mode_mapping = {4: "GUIDED", 6: "RTL"}

    assert v.set_mode("RTL", timeout_s=0.01, attempts=1) is False
    assert v.set_mode("NOT_A_MODE") is False


def test_vehicle_set_mode_accepts_a_heartbeat_readback():
    from eis_companion.mavlink.vehicle import Vehicle

    class Heartbeat:
        def __init__(self, custom_mode):
            self.custom_mode = custom_mode
            self.base_mode = 0

        def get_type(self):
            return "HEARTBEAT"

        def get_srcSystem(self):
            return 1

    class Master:
        target_system = 1
        target_component = 1

        def __init__(self):
            self.sent = []
            self.inbox = [Heartbeat(6)]

        class _Mav:
            def __init__(self, sent):
                self._sent = sent

            def __getattr__(self, name):
                if not name.endswith("_send"):
                    raise AttributeError(name)

                def _send(*args):
                    self._sent.append((name[:-5], args))
                return _send

        @property
        def mav(self):
            return Master._Mav(self.sent)

        def recv_match(self, type=None, blocking=False, timeout=None):
            want = [type] if isinstance(type, str) else list(type or [])
            while self.inbox:
                msg = self.inbox.pop(0)
                if not want or msg.get_type() in want:
                    return msg
            return None

    v = Vehicle()
    v._master = Master()
    v._connected = True
    v._target_system = 1
    v._mode_mapping = {"GUIDED": 4, "RTL": 6}
    v._inv_mode_mapping = {4: "GUIDED", 6: "RTL"}

    assert v.set_mode("RTL", timeout_s=0.5, attempts=1) is True


# ==========================================================================
# FM-04: the takeoff window must not suspend the ladder
# ==========================================================================
def test_the_failsafe_ladder_still_acts_during_the_takeoff_window():
    """A battery RTL injected mid-climb used to be inert for up to 60 s."""
    c = make_companion()
    c._vehicle_state = VehicleState(
        armed=True, airborne=True, mode="GUIDED", relAlt=5.0,
        lat=HOME_LAT, lon=HOME_LON,
    )
    c._failsafe_decision = FailsafeDecision("none", "", "companion")
    assert dispatch(c, "takeoff", {"altitude": 30.0})["success"] is True
    assert c._takeoff_deadline_ms > 0.0
    c.vehicle.calls.clear()

    # Nominal climb: the window still suppresses the idle hold frame.
    run(c._control_tick(0.05))
    assert c.vehicle.named("vel") == []

    # Now a real in-flight failsafe arrives mid-climb.
    c._failsafe_decision = FailsafeDecision("rtl", "battery reserve reached", "companion")
    run(c._control_tick(0.05))
    assert ("mode", "RTL") in c.vehicle.calls, "the ladder must act during the climb"
    assert c._takeoff_deadline_ms == 0.0, "an RTL abandons the climb window"


def test_a_hold_failsafe_during_the_takeoff_window_emits_the_hold_frame():
    c = make_companion()
    c._vehicle_state = VehicleState(
        armed=True, airborne=True, mode="GUIDED", relAlt=5.0,
        lat=HOME_LAT, lon=HOME_LON,
    )
    c._failsafe_decision = FailsafeDecision("none", "", "companion")
    dispatch(c, "takeoff", {"altitude": 30.0})
    c.vehicle.calls.clear()
    c._failsafe_decision = FailsafeDecision(
        "hold", "hostile drone; operator continue or RTL required", "companion"
    )
    run(c._control_tick(0.05))
    vel = c.vehicle.named("vel")
    assert vel and vel[-1] == ("vel", 0.0, 0.0, 0.0, 0.0, False)


@pytest.mark.parametrize("command", ["rtl", "land", "disarm"])
def test_recovery_commands_clear_the_takeoff_window(command):
    """rtl/land/disarm/e-stop all used to leave the window armed."""
    c = make_companion()
    c._vehicle_state = VehicleState(
        armed=True, airborne=True, mode="GUIDED", relAlt=5.0,
        lat=HOME_LAT, lon=HOME_LON,
    )
    c._failsafe_decision = FailsafeDecision("none", "", "companion")
    dispatch(c, "takeoff", {"altitude": 30.0})
    assert c._takeoff_deadline_ms > 0.0
    dispatch(c, command)
    assert c._takeoff_deadline_ms == 0.0


# ==========================================================================
# FM-17: the LiDAR climb has a ceiling and a symmetric release
# ==========================================================================
def test_the_lidar_climb_never_targets_above_the_altitude_limit():
    c = make_companion()
    c.limits.max_altitude = 30.0        # default.yaml ceiling
    assert c.site.clear_altitude_m == 45.0   # stub site clear altitude
    assert c._lidar_clear_altitude_m() == pytest.approx(30.0)

    c._vehicle_state = airborne(alt=31.0)
    c._failsafe_decision = FailsafeDecision(
        "hold", "LiDAR failed; climb to clear altitude", "companion"
    )
    c.vehicle.calls.clear()
    run(c._control_tick(0.05))
    vel = c.vehicle.named("vel")
    assert vel and vel[-1] == ("vel", 0.0, 0.0, 0.0, 0.0, False), (
        "above the altitude limit the branch must HOLD, not keep climbing"
    )


def test_the_lidar_climb_still_climbs_below_the_ceiling():
    c = make_companion()
    c.limits.max_altitude = 60.0
    c._vehicle_state = airborne(alt=10.0)
    c._failsafe_decision = FailsafeDecision(
        "hold", "LiDAR failed; climb to clear altitude", "companion"
    )
    c.vehicle.calls.clear()
    run(c._control_tick(0.05))
    _, vx, vy, vz, yaw, valid = c.vehicle.named("vel")[-1]
    assert valid is True and vz < 0.0        # NED: negative vz is UP
    assert abs(vz) <= c.limits.max_climb_rate + 1e-9


def test_a_real_lidar_failure_can_reach_clear_altitude_and_release():
    """The latch was gated on the INJECTED fault only, so a real failure
    climbed to clear altitude and held there forever."""
    c = make_companion()
    c.limits.max_altitude = 60.0
    c._lidar_observation_valid = False        # a REAL failure, not testFault
    assert c._faults["lidar"] is False
    c._vehicle_state = airborne(alt=50.0)     # already at/above clear altitude

    run(c._health_tick({"battery": {}}))
    assert c._lidar_clear_reached is True, (
        "a real LiDAR failure must be able to satisfy the clear-altitude latch"
    )
    assert c._failsafe_decision.state != "hold" or "LiDAR" not in c._failsafe_decision.reason


# ==========================================================================
# FM-18: release-to-safe commands survive a failsafe
# ==========================================================================
@pytest.mark.parametrize("command", ["abortPlan", "disengageTracking"])
def test_release_to_safe_commands_are_accepted_during_a_notification_escalate(command):
    c = make_companion()
    c._vehicle_state = airborne()
    dispatch(c, "executePlan", {"plan": valid_plan()})
    c._failsafe_decision = FailsafeDecision(
        "escalate", "battery degraded_estimate", "companion"
    )
    ack = dispatch(c, command)
    assert ack["success"] is True, f"{command} is release-to-safe and must be accepted"


def test_abort_plan_during_a_failsafe_actually_releases_the_planner():
    c = make_companion()
    c._vehicle_state = airborne()
    dispatch(c, "executePlan", {"plan": valid_plan()})
    c._failsafe_decision = FailsafeDecision(
        "escalate", "no observation: camera failed", "companion"
    )
    assert dispatch(c, "abortPlan")["success"] is True
    assert c._planner_engaged is False
    assert c._control_source == ControlSource.AUTO.value


def test_new_autonomous_work_is_still_refused_during_a_failsafe():
    """The allow-list must not have become a hole."""
    c = make_companion()
    c._vehicle_state = airborne()
    c._failsafe_decision = FailsafeDecision(
        "escalate", "battery degraded_estimate", "companion"
    )
    for command in ("engageTracking", "executePlan", "arm", "takeoff", "selectTarget"):
        ack = dispatch(c, command, {"plan": valid_plan(), "altitude": 10})
        assert ack["success"] is False, f"{command} must stay refused"


def test_set_mode_admits_recovery_modes_only_during_a_failsafe():
    c = make_companion()
    c._vehicle_state = airborne()
    c._failsafe_decision = FailsafeDecision(
        "escalate", "battery degraded_estimate", "companion"
    )
    assert dispatch(c, "setMode", {"mode": "LOITER"})["success"] is True
    assert dispatch(c, "setMode", {"mode": "GUIDED"})["success"] is False


# ==========================================================================
# FM-24: emergencyStop is a LATCH, not a pulse
# ==========================================================================
def test_emergency_stop_latches_and_blocks_re_engagement():
    c = make_companion()
    c._vehicle_state = airborne()
    ack = dispatch(c, "emergencyStop")
    assert ack["success"] is True
    assert c._estop_latched is True

    for command in ("engageTracking", "takeoff", "executePlan", "engageManual"):
        refused = dispatch(c, command, {"plan": valid_plan(), "altitude": 5})
        assert refused["success"] is False
        assert "emergency stop" in refused["message"]
    assert dispatch(c, "setMode", {"mode": "GUIDED"})["success"] is False


def test_the_latch_holds_the_setpoint_across_many_ticks():
    c = make_companion()
    c._vehicle_state = airborne()
    dispatch(c, "emergencyStop")
    c.vehicle.calls.clear()
    for _ in range(5):
        run(c._control_tick(0.05))
    vel = c.vehicle.named("vel")
    assert vel and all(frame[5] is False for frame in vel)


def test_the_latch_clears_only_once_the_vehicle_is_disarmed_on_the_ground():
    c = make_companion()
    c._vehicle_state = airborne()
    dispatch(c, "emergencyStop")
    assert c._estop_latched is True

    c._vehicle_state = airborne(alt=1.0)        # still armed + airborne
    run(c._control_tick(0.05))
    assert c._estop_latched is True

    c._vehicle_state = VehicleState(armed=False, airborne=False, mode="STABILIZE")
    run(c._control_tick(0.05))
    assert c._estop_latched is False
    assert dispatch(c, "engageTracking")["success"] is True


def test_emergency_stop_reports_failure_when_the_fc_refuses_the_action():
    """A refused LAND used to ack success:true with nothing stopped."""
    c = make_companion(mode_accepts=False)
    c._vehicle_state = airborne()
    ack = dispatch(c, "emergencyStop")
    assert ack["success"] is False
    assert "refused" in ack["message"]
    assert c._estop_latched is True, "a failed stop must still LATCH"


def test_emergency_stop_without_an_fc_link_reports_failure_not_success():
    c = make_companion()
    c.vehicle = None
    c._vehicle_state = airborne()
    ack = dispatch(c, "emergencyStop")
    assert ack["success"] is False
    assert c._estop_latched is True
