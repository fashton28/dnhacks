"""
Orchestrator wiring for Phase 2: envelope monitor, attendance mode, gimbal.

Proves, against the real Companion orchestrator (no network, FakeVehicle):
  * the monitor runs as its OWN coroutine, fed by telemetry + the mission
    record, and its verdict reaches the flight state ONLY through
    control/failsafe.py -- never through guidance,
  * guidance can neither read nor write monitor state (structural, not just
    behavioural: the monitor holds no reference to guidance and vice versa),
  * manual engage suspends the monitor's ACTIONS while it keeps evaluating and
    logging -- the audit trail does not go dark when someone takes the sticks,
  * 'envelope' is emitted at ~5 Hz while airborne plus on every state change,
    with a healthEvent on component 'envelope',
  * 'mode' is emitted on change; enterUnattended needs a signature; an
    operator connecting reverts to attended with no command,
  * dispatch is tagged with the attendance mode in the mission record, and a
    record whose hash does not verify REFUSES dispatch and raises a health
    event,
  * the gimbal auto-points by geometry during orbit legs, a signed setGimbal
    overrides until the next leg, and telemetry carries gimbal.pitchDeg,
  * both test hooks are OFF by default and gated three ways,
  * the 20 Hz loop, the single controlSource and the watchdogs are intact.

Style matches tests/test_app_wiring.py: plain pytest, asyncio.run() for the
async paths, recording fakes at the component seams.
"""
from __future__ import annotations

import asyncio
import math
from types import SimpleNamespace

import pytest

from eis_companion.app import Companion, _plan_envelope_shape
from eis_companion.config import AppConfig, load_config
from eis_companion.control.failsafe import FailsafeDecision
from eis_companion.security import record_hash, sign_payload
from eis_companion.types import ControlSource, Limits, VehicleState

STUB_SITE = "site/site.stub.json"
HOME_LAT, HOME_LON = -26.0900, 29.4719
FAR_LAT, FAR_LON = -26.09065, 29.46925
M_PER_DEG_LAT = 111_320.0
KEY = "wiring-test-session-key"


# ==========================================================================
# Fakes
# ==========================================================================
class FakeVehicle:
    def __init__(self) -> None:
        self.calls: list = []
        self.limits = Limits()
        self.reported_pitch = None

    def send_body_velocity(self, vx, vy, vz, yaw_rate, valid=True):
        self.calls.append(("vel", vx, vy, vz, yaw_rate, valid))

    def goto_global(self, lat, lon, rel_alt, speed, **kwargs):
        self.calls.append(("goto", lat, lon, rel_alt, speed))
        return True

    def set_mode(self, mode):
        self.calls.append(("mode", mode))

    def set_gimbal_pitch(self, pitch_deg, *, use_gimbal_manager=False):
        self.calls.append(("gimbal", round(float(pitch_deg), 3), use_gimbal_manager))
        return True

    def gimbal_pitch_deg(self):
        return self.reported_pitch

    def update_limits(self, limits):
        self.limits = limits

    def upload_geofence(self, perimeter, **kwargs):
        return True

    def named(self, name: str) -> list:
        return [c for c in self.calls if c[0] == name]


class FakeApi:
    """Captures every outbound frame instead of putting it on a socket."""

    def __init__(self) -> None:
        self.sent: list = []

    async def broadcast(self, message):
        self.sent.append(dict(message))

    async def push_telemetry(self, telemetry):
        self.sent.append(dict(telemetry))

    async def push_tracking(self, tracking):
        self.sent.append(dict(tracking))

    async def push_status(self, severity, text):
        self.sent.append({"type": "statusText", "severity": severity, "text": text})

    def of_type(self, mtype: str) -> list:
        return [m for m in self.sent if m.get("type") == mtype]


# ==========================================================================
# Helpers
# ==========================================================================
def make_companion(site_file: str = STUB_SITE, **cfg_overrides) -> Companion:
    cfg = AppConfig()
    cfg.sitl = True
    cfg.camera.source = "sim"
    cfg.planner.site_file = site_file
    for key, value in cfg_overrides.items():
        setattr(cfg, key, value)
    c = Companion(cfg)
    c.setup()
    c.vehicle = FakeVehicle()
    c.api = FakeApi()
    c._fc_ready = True
    # Pin the battery snapshot: FakeVehicle reports no pack, so the real
    # BatteryHealth would derive 0% SoC and RTL for reserve -- masking the
    # envelope-derived states these tests are about.
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


def airborne_state(lat=HOME_LAT, lon=HOME_LON, alt=40.0) -> VehicleState:
    return VehicleState(
        armed=True, airborne=True, mode="GUIDED",
        lat=lat, lon=lon, relAlt=alt, heading=0.0,
    )


def run(coro):
    return asyncio.run(coro)


def dispatch(c: Companion, command: str, params=None, **envelope):
    msg = {
        "type": "command", "vehicleId": c.config.vehicle_id,
        "command": command, "params": params or {},
    }
    msg.update(envelope)
    return run(c._handle_command(msg))


def signed_dispatch(c: Companion, command: str, params=None, *, nonce="n-1"):
    msg = {
        "type": "command", "vehicleId": c.config.vehicle_id,
        "command": command, "params": params or {},
        "ts": int(__import__("time").time() * 1000), "nonce": nonce,
    }
    msg["sig"] = sign_payload(msg, KEY.encode("utf-8"))
    return run(c._handle_command(msg))


CORRIDOR = {
    "legs": [{
        "from": {"lat": HOME_LAT, "lon": HOME_LON},
        "to": {"lat": HOME_LAT, "lon": HOME_LON + 0.002},
        "lateral_tol_m": 10.0,
    }],
    "orbits": [],
    "alt_band_m": {"min": 30.0, "max": 50.0},
    "generated_from": "req-1",
}


def valid_plan(tools=None, profile="standard", corridor=CORRIDOR):
    plan = {
        "requestId": "req-1",
        "anomalyId": "anom-1",
        "profile": profile,
        "rationale": "test",
        "tools": tools or [
            {"tool": "goto_gps", "lat": FAR_LAT, "lon": FAR_LON, "alt": 40.0},
            {"tool": "hold", "durationS": 1.0},
            {"tool": "rtl"},
        ],
    }
    if corridor is not None:
        plan["corridor"] = corridor
    return plan


def drifted(c: Companion, metres: float) -> None:
    """Put the vehicle ``metres`` perpendicular to the corridor leg."""
    c._vehicle_state = airborne_state(
        lat=HOME_LAT + metres / M_PER_DEG_LAT, lon=HOME_LON + 0.001
    )


# ==========================================================================
# The monitor is its own coroutine, and it is independent of guidance
# ==========================================================================
def test_envelope_task_is_launched_alongside_the_other_loops():
    """The monitor must keep evaluating even if perception stalls or the
    control loop is held, so it gets its own task."""
    import inspect
    source = inspect.getsource(Companion.run)
    assert '_envelope_loop(), name="envelope"' in source
    assert '_control_loop(), name="control"' in source


def test_monitor_holds_the_vehicle_through_the_failsafe_machine_only():
    c = make_companion()
    run(c._execute_plan({"plan": valid_plan()}))
    drifted(c, 40.0)                      # 4x the 10 m lateral tolerance

    run(c._envelope_tick())
    assert c._envelope_hold is True
    assert c._envelope_rtl is False

    # The request only becomes a flight state via control/failsafe.py.
    run(c._telemetry_tick())
    assert c._failsafe_decision.state == "hold"
    assert "envelope" in c._failsafe_decision.reason

    c.vehicle.calls.clear()
    run(c._control_tick(0.05))
    assert c.vehicle.named("vel")[-1] == ("vel", 0.0, 0.0, 0.0, 0.0, False)


def test_monitor_rtls_on_a_geofence_margin_intrusion():
    c = make_companion()
    run(c._execute_plan({"plan": valid_plan()}))
    # 1 m inside the stub geofence's northern edge.
    c._vehicle_state = airborne_state(lat=-26.0871 - 1.0 / M_PER_DEG_LAT, lon=29.472)

    run(c._envelope_tick())
    assert c._envelope_rtl is True
    run(c._telemetry_tick())
    assert c._failsafe_decision.state == "rtl"

    c.vehicle.calls.clear()
    run(c._control_tick(0.05))
    assert ("mode", "RTL") in c.vehicle.calls


def test_guidance_neither_reads_nor_writes_monitor_state():
    """Structural, not just behavioural: the two components hold no reference
    to each other, so there is no path for one to influence the other."""
    c = make_companion()
    monitor_refs = set(id(v) for v in vars(c.envelope).values())
    for component in (c.guidance, c.planner, c.tracker, c.api, c.vehicle):
        assert id(component) not in monitor_refs

    # ...and the monitor's verdict is not reachable from guidance's inputs.
    guidance_refs = set(id(v) for v in vars(c.guidance).values())
    assert id(c.envelope) not in guidance_refs


def test_a_monitor_tick_that_raises_requests_a_hold():
    """If the monitor cannot evaluate, we cannot claim to be inside the
    envelope -- the safe answer is hold, not "carry on"."""
    c = make_companion()

    class Exploding:
        def update(self, *args, **kwargs):
            raise RuntimeError("boom")

        def set_geometry(self, geometry):
            pass

    c.envelope = Exploding()
    c._vehicle_state = airborne_state()

    # Drive ONE iteration of the real loop: the sleep stops it afterwards.
    async def stop_after(t0, period):
        c._stop.set()

    c._sleep_remaining = stop_after
    run(c._envelope_loop())

    assert c._envelope_hold is True
    assert c._envelope_speed_scale == 0.0
    health = [m for m in c.api.of_type("healthEvent")
              if m.get("component") == "envelope"]
    assert health and health[-1]["state"] == "unavailable"


def test_warning_asks_for_slow_and_the_final_clamp_applies_it():
    """The slow-down request is applied at the orchestrator's LAST clamp, not
    inside guidance -- which is how guidance stays unaware of the monitor."""
    from eis_companion.types import VelocitySetpoint

    c = make_companion()
    run(c._execute_plan({"plan": valid_plan()}))
    drifted(c, 15.0)                       # past 10 m, inside 20 m

    run(c._envelope_tick())
    assert c._envelope_decision.state == "warning"
    assert 0.0 < c._envelope_speed_scale < 1.0

    full = VelocitySetpoint(vx=c.limits.max_speed, valid=True)
    assert c._clamp_setpoint(full).vx == pytest.approx(
        c.limits.max_speed * c._envelope_speed_scale
    )


# ==========================================================================
# Manual engage: actions suspended, evaluation and logging continue
# ==========================================================================
def test_manual_engage_suspends_actions_but_not_evaluation():
    c = make_companion()
    run(c._execute_plan({"plan": valid_plan()}))
    c._vehicle_state = airborne_state()
    assert dispatch(c, "engageManual")["success"] is True
    drifted(c, 40.0)

    run(c._envelope_tick())
    decision = c._envelope_decision
    assert decision.suspended is True
    assert decision.state == "breach"          # still measured
    assert c.envelope.latched is not None      # still latched
    assert c._envelope_hold is False           # ...but nothing acts on it
    assert c._envelope_speed_scale == 1.0

    # The record does not go dark: the breach is still published and logged.
    assert c.api.of_type("envelope")
    health = [m for m in c.api.of_type("healthEvent")
              if m.get("component") == "envelope"]
    assert health and "suspended" in health[-1]["detail"]


# ==========================================================================
# Wire emission
# ==========================================================================
def test_envelope_messages_carry_the_contract_shape_and_vehicle_id():
    c = make_companion()
    run(c._execute_plan({"plan": valid_plan()}))
    drifted(c, 40.0)
    run(c._envelope_tick())

    messages = c.api.of_type("envelope")
    assert messages
    message = messages[-1]
    assert message["vehicleId"] == "eis-1"
    assert message["state"] == "breach"
    assert message["constraint"] == "corridor"
    assert message["action"] in ("none", "slow", "hold", "rtl")
    assert isinstance(message["ts"], int)


def test_envelope_is_published_at_five_hz_while_airborne():
    c = make_companion()
    run(c._execute_plan({"plan": valid_plan()}))
    drifted(c, 2.0)                            # nominal: no state changes

    run(c._envelope_tick())                    # first tick: change -> publish
    baseline = len(c.api.of_type("envelope"))
    for _ in range(5):                         # ~5 more 20 Hz ticks
        run(c._envelope_tick())
    # Rate-limited: the unchanged state does not publish on every 20 Hz tick.
    assert len(c.api.of_type("envelope")) < baseline + 5


def test_a_state_change_publishes_immediately_and_raises_a_health_event():
    c = make_companion()
    run(c._execute_plan({"plan": valid_plan()}))
    drifted(c, 2.0)
    run(c._envelope_tick())
    c.api.sent.clear()

    drifted(c, 40.0)
    run(c._envelope_tick())
    assert c.api.of_type("envelope")
    health = [m for m in c.api.of_type("healthEvent")
              if m.get("component") == "envelope"]
    assert health and health[-1]["state"] == "breach"


def test_a_breach_that_persists_five_seconds_escalates_once():
    c = make_companion()
    run(c._execute_plan({"plan": valid_plan()}))
    drifted(c, 40.0)
    for _ in range(3):
        run(c._envelope_tick())
    assert not c.api.of_type("escalation")

    # Age the latch past the 5 s escalation dwell without waiting for it.
    c.envelope._latched_since_s -= 6.0
    run(c._envelope_tick())
    escalations = c.api.of_type("escalation")
    assert len(escalations) == 1
    payload = escalations[0]["payload"]
    assert payload["kind"] == "envelope_breach"
    assert payload["constraint"] == "corridor"
    assert escalations[0]["vehicleId"] == "eis-1"

    run(c._envelope_tick())                    # ...and it does not repeat
    assert len(c.api.of_type("escalation")) == 1


# ==========================================================================
# Attendance mode
# ==========================================================================
def test_enter_unattended_is_refused_unsigned(monkeypatch):
    monkeypatch.setenv("EIS_SESSION_KEY", KEY)
    c = make_companion()
    ack = dispatch(c, "enterUnattended", {"operatorId": "op-7"})
    assert ack["success"] is False
    assert "signed" in ack["message"]
    assert c.attendance.mode == "attended"
    # The attempt is itself reportable.
    assert [m for m in c.api.of_type("healthEvent")
            if "refused" in m.get("state", "")]


def test_signed_enter_unattended_switches_mode_and_publishes_it(monkeypatch):
    monkeypatch.setenv("EIS_SESSION_KEY", KEY)
    c = make_companion()
    ack = signed_dispatch(c, "enterUnattended", {"operatorId": "op-7"})
    assert ack["success"] is True
    assert c.attendance.mode == "unattended"
    modes = c.api.of_type("mode")
    assert modes and modes[-1]["mode"] == "unattended"
    assert modes[-1]["vehicleId"] == "eis-1"


def test_a_replayed_enter_unattended_is_refused(monkeypatch):
    monkeypatch.setenv("EIS_SESSION_KEY", KEY)
    c = make_companion()
    import time as _time
    msg = {
        "type": "command", "vehicleId": "eis-1", "command": "enterUnattended",
        "params": {"operatorId": "op-7"}, "ts": int(_time.time() * 1000),
        "nonce": "replay-me",
    }
    msg["sig"] = sign_payload(msg, KEY.encode("utf-8"))
    assert run(c._handle_command(dict(msg)))["success"] is True
    replayed = run(c._handle_command(dict(msg)))
    assert replayed["success"] is False
    assert "already used" in replayed["message"]


def test_operator_connect_reverts_to_attended_without_a_command(monkeypatch):
    monkeypatch.setenv("EIS_SESSION_KEY", KEY)
    c = make_companion()
    signed_dispatch(c, "enterUnattended", {"operatorId": "op-7"})
    assert c.attendance.mode == "unattended"

    run(c._on_operator_connected(1))
    assert c.attendance.mode == "attended"
    assert c.attendance.operator_present is True
    assert c.api.of_type("mode")[-1]["mode"] == "attended"


def test_operator_disconnect_never_enters_unattended():
    c = make_companion()
    run(c._on_operator_connected(1))
    run(c._on_operator_disconnected(0))
    assert c.attendance.mode == "attended"
    assert c.attendance.operator_present is False


def test_unattended_dispatch_outside_the_envelope_is_refused_and_escalates(monkeypatch):
    monkeypatch.setenv("EIS_SESSION_KEY", KEY)
    c = make_companion()
    signed_dispatch(c, "enterUnattended", {"operatorId": "op-7"})
    c.api.sent.clear()

    # 'survey' profile and a 70 m leg: two independent envelope violations.
    plan = valid_plan(
        tools=[{"tool": "goto_gps", "lat": FAR_LAT, "lon": FAR_LON, "alt": 70.0}],
        profile="survey",
    )
    ok, message = run(c._execute_plan({"plan": plan}))
    assert ok is False
    assert "unattended dispatch refused" in message
    assert "profile" in message and "altitude" in message
    escalations = c.api.of_type("escalation")
    assert escalations
    assert escalations[-1]["payload"]["kind"] == "unattended_envelope_refusal"


def test_a_conforming_unattended_dispatch_is_accepted(monkeypatch):
    monkeypatch.setenv("EIS_SESSION_KEY", KEY)
    c = make_companion()
    signed_dispatch(c, "enterUnattended", {"operatorId": "op-7"})
    plan = valid_plan(tools=[
        {"tool": "goto_gps", "lat": FAR_LAT, "lon": FAR_LON, "alt": 40.0},
        {"tool": "rtl"},
    ], profile="inspect")
    ok, _ = run(c._execute_plan({"plan": plan}))
    assert ok is True
    assert c._mission_record["mode"] == "unattended"


def test_the_unattended_sortie_rate_is_two_per_hour(monkeypatch):
    monkeypatch.setenv("EIS_SESSION_KEY", KEY)
    c = make_companion()
    signed_dispatch(c, "enterUnattended", {"operatorId": "op-7"})
    plan = valid_plan(tools=[
        {"tool": "goto_gps", "lat": FAR_LAT, "lon": FAR_LON, "alt": 40.0},
        {"tool": "rtl"},
    ], profile="inspect")
    assert run(c._execute_plan({"plan": plan}))[0] is True
    run(c._abort_plan())
    assert run(c._execute_plan({"plan": plan}))[0] is True
    run(c._abort_plan())
    ok, message = run(c._execute_plan({"plan": plan}))
    assert ok is False
    assert "sorties already flown" in message


# ==========================================================================
# Mission record: tagged with the mode, refused on a hash mismatch
# ==========================================================================
def test_dispatch_is_tagged_with_the_attendance_mode():
    c = make_companion()
    run(c._execute_plan({"plan": valid_plan()}))
    assert c._mission_record["mode"] == "attended"
    assert c._mission_record["vehicleId"] == "eis-1"
    assert c._mission_record["missionId"] == "req-1"


def test_a_mission_record_hash_mismatch_refuses_dispatch():
    c = make_companion()
    record = {
        "missionId": "m-1", "vehicleId": "eis-1", "anomalyId": "anom-1",
        "corridor": CORRIDOR,
    }
    record["recordHash"] = record_hash(record)
    record["anomalyId"] = "anom-swapped"       # mutated after verification

    ok, message = run(c._execute_plan({
        "plan": valid_plan(), "missionRecord": record,
    }))
    assert ok is False
    assert "hash mismatch" in message
    assert c._planner_engaged is False
    health = [m for m in c.api.of_type("healthEvent")
              if m.get("component") == "envelope" and m.get("state") == "refused"]
    assert health


def test_a_verified_mission_record_arms_the_corridor():
    c = make_companion()
    record = {
        "missionId": "m-1", "vehicleId": "eis-1", "anomalyId": "anom-1",
        "corridor": CORRIDOR,
    }
    record["recordHash"] = record_hash(record)
    ok, _ = run(c._execute_plan({"plan": valid_plan(), "missionRecord": record}))
    assert ok is True
    assert c.envelope.armed is True
    assert c.envelope.corridor.has_shape
    assert c._mission_record["missionId"] == "m-1"


def test_releasing_the_plan_drops_the_corridor_but_keeps_containment():
    c = make_companion()
    run(c._execute_plan({"plan": valid_plan()}))
    assert c.envelope.armed is True

    run(c._abort_plan())
    assert c.envelope.armed is False
    assert c._envelope_hold is False
    # Site containment still applies with no plan loaded.
    assert c.envelope.geometry.geofence


# ==========================================================================
# Gimbal
# ==========================================================================
def test_gimbal_auto_points_at_the_orbit_centre_by_geometry():
    c = make_companion()
    # 40 m north of the orbit centre at 40 m AGL -> 45 degrees depression.
    c._vehicle_state = airborne_state(lat=HOME_LAT + 40.0 / M_PER_DEG_LAT, alt=40.0)
    run(c._execute_plan({"plan": valid_plan(tools=[
        {"tool": "orbit_point", "lat": HOME_LAT, "lon": HOME_LON, "radius": 40.0},
    ])}))

    for _ in range(200):                    # let the slew limiter converge
        run(c._gimbal_tick(0.05))
    assert c.gimbal.commanded_pitch_deg == pytest.approx(45.0, abs=0.5)
    assert c.vehicle.named("gimbal")


def test_transit_legs_leave_the_mount_where_it_is():
    """A goto has nothing to look at; swinging the mount would only smear the
    imagery that matters."""
    c = make_companion()
    c._vehicle_state = airborne_state()
    run(c._execute_plan({"plan": valid_plan()}))
    assert c._auto_gimbal_target() is None


def test_signed_set_gimbal_overrides_until_the_next_leg(monkeypatch):
    monkeypatch.setenv("EIS_SESSION_KEY", KEY)
    c = make_companion()
    ack = signed_dispatch(c, "setGimbal", {"pitchDeg": 20.0})
    assert ack["success"] is True
    assert c.gimbal.override_active
    assert c.gimbal.override_pitch_deg == pytest.approx(20.0)

    run(c._gimbal_tick(10.0))
    assert c.gimbal.commanded_pitch_deg == pytest.approx(20.0)


def test_set_gimbal_is_refused_unsigned():
    c = make_companion()
    ack = dispatch(c, "setGimbal", {"pitchDeg": 20.0})
    assert ack["success"] is False
    assert c.gimbal.override_active is False


def test_a_signed_set_gimbal_is_still_clamped(monkeypatch):
    monkeypatch.setenv("EIS_SESSION_KEY", KEY)
    c = make_companion()
    ack = signed_dispatch(c, "setGimbal", {"pitchDeg": 500.0})
    assert ack["success"] is True
    assert "clamped" in ack["message"]
    assert c.gimbal.override_pitch_deg == 90.0


def test_a_new_leg_clears_the_operator_override(monkeypatch):
    monkeypatch.setenv("EIS_SESSION_KEY", KEY)
    c = make_companion()
    c._vehicle_state = airborne_state()
    run(c._execute_plan({"plan": valid_plan()}))
    run(c._gimbal_tick(0.05))
    signed_dispatch(c, "setGimbal", {"pitchDeg": 20.0})
    assert c.gimbal.override_active

    c.planner._index += 1                   # the plan advanced to the next leg
    run(c._gimbal_tick(0.05))
    assert c.gimbal.override_active is False


def test_telemetry_prefers_the_reported_pitch_over_the_commanded_one():
    c = make_companion()
    c.vehicle.reported_pitch = 33.0
    run(c._telemetry_tick())
    telemetry = c.api.of_type("telemetry")[-1]
    assert telemetry["gimbal"]["pitchDeg"] == pytest.approx(33.0)

    c.vehicle.reported_pitch = None         # mount says nothing: use commanded
    c.gimbal.set_override(12.0)
    run(c._gimbal_tick(10.0))
    run(c._telemetry_tick())
    assert c.api.of_type("telemetry")[-1]["gimbal"]["pitchDeg"] == pytest.approx(12.0)


def test_no_gimbal_means_no_telemetry_field():
    """An airframe with no commandable mount omits the field rather than
    reporting a fictional 0."""
    cfg = AppConfig()
    cfg.sitl = True
    cfg.camera.source = "sim"
    cfg.gimbal.enabled = False
    c = Companion(cfg)
    c.setup()
    c.vehicle = None
    c.api = FakeApi()
    run(c._telemetry_tick())
    assert "gimbal" not in c.api.of_type("telemetry")[-1]


# ==========================================================================
# Fleet: the only cross-vehicle input
# ==========================================================================
def test_a_fleet_message_supplies_the_peer_position():
    c = make_companion()
    run(c._handle_fleet({
        "type": "fleet", "ts": 0, "vehicleId": "eis-1",
        "vehicles": [
            {"vehicleId": "eis-1", "position": {"lat": HOME_LAT, "lon": HOME_LON}},
            {"vehicleId": "eis-2",
             "position": {"lat": HOME_LAT + 0.0002, "lon": HOME_LON, "relAlt": 40.0}},
        ],
    }))
    peer = c._peer_sample()
    assert peer is not None and peer.vehicle_id == "eis-2"
    assert peer.valid and peer.age_s < 1.0


def test_a_close_peer_holds_the_vehicle():
    c = make_companion()
    run(c._execute_plan({"plan": valid_plan()}))
    c._vehicle_state = airborne_state(lon=HOME_LON + 0.001)
    run(c._handle_fleet({
        "type": "fleet", "vehicles": [{
            "vehicleId": "eis-2",
            "position": {"lat": HOME_LAT + 20.0 / M_PER_DEG_LAT,
                         "lon": HOME_LON + 0.001},
        }],
    }))
    run(c._envelope_tick())
    assert c._envelope_decision.constraint == "separation"
    assert c._envelope_hold is True


def test_a_self_only_fleet_frame_leaves_the_peer_untouched():
    c = make_companion()
    run(c._handle_fleet({"type": "fleet", "vehicles": [
        {"vehicleId": "eis-1", "position": {"lat": HOME_LAT, "lon": HOME_LON}},
    ]}))
    assert c._peer_sample() is None


def test_a_malformed_fleet_frame_lets_the_peer_age_rather_than_forgetting_it():
    """Forgetting a peer would NARROW the requirement; ageing widens it."""
    c = make_companion()
    run(c._handle_fleet({"type": "fleet", "vehicles": [
        {"vehicleId": "eis-2", "position": {"lat": HOME_LAT, "lon": HOME_LON}},
    ]}))
    run(c._handle_fleet({"type": "fleet", "vehicles": "not-a-list"}))
    run(c._handle_fleet({"type": "fleet", "vehicles": [{"vehicleId": "eis-2"}]}))
    assert c._peer_sample() is not None


# ==========================================================================
# Test hooks: OFF by default, gated three ways
# ==========================================================================
def test_guidance_override_hook_is_off_by_default():
    c = make_companion()
    c._vehicle_state = airborne_state()
    run(c._execute_plan({"plan": valid_plan()}))
    assert c._guidance_override_active() is False


def test_guidance_override_hook_needs_all_three_gates(monkeypatch):
    c = make_companion()
    c._vehicle_state = airborne_state()
    run(c._execute_plan({"plan": valid_plan()}))

    monkeypatch.setenv("EIS_TEST_GUIDANCE_OVERRIDE", "true")
    assert c._guidance_override_active() is False        # hooks still disabled
    monkeypatch.setenv("EIS_ENABLE_TEST_HOOKS", "true")
    assert c._guidance_override_active() is True
    c.config.sitl = False
    assert c._guidance_override_active() is False        # never on real hardware


def test_guidance_override_flies_out_of_the_corridor_and_the_monitor_wins(monkeypatch):
    monkeypatch.setenv("EIS_ENABLE_TEST_HOOKS", "true")
    monkeypatch.setenv("EIS_TEST_GUIDANCE_OVERRIDE", "true")
    c = make_companion()
    c._vehicle_state = airborne_state()
    run(c._execute_plan({"plan": valid_plan()}))
    c._failsafe_decision = FailsafeDecision("none", "", "companion")

    c.vehicle.calls.clear()
    run(c._control_tick(0.05))
    forward = c.vehicle.named("vel")[-1]
    assert forward[1] > 0.0                              # commanded outward

    # Once the monitor trips, its hold suppresses the override entirely.
    drifted(c, 40.0)
    run(c._envelope_tick())
    run(c._telemetry_tick())
    c.vehicle.calls.clear()
    run(c._control_tick(0.05))
    assert c.vehicle.named("vel")[-1] == ("vel", 0.0, 0.0, 0.0, 0.0, False)


def test_bad_plan_hook_is_off_by_default():
    c = make_companion()
    plan = valid_plan()
    assert c._maybe_corrupt_plan(plan) is plan
    assert run(c._execute_plan({"plan": plan}))[0] is True


def test_bad_plan_hook_is_rejected_by_the_companion_validator(monkeypatch):
    monkeypatch.setenv("EIS_ENABLE_TEST_HOOKS", "true")
    monkeypatch.setenv("EIS_TEST_BAD_PLAN", "true")
    c = make_companion()
    plan = valid_plan()
    ok, message = run(c._execute_plan({"plan": plan}))
    assert ok is False
    assert "unknown tool" in message
    assert c._planner_engaged is False
    assert plan["tools"][0]["tool"] == "goto_gps"        # the caller's copy is intact


# ==========================================================================
# Regressions: the pre-existing invariants still hold
# ==========================================================================
def test_control_loop_still_runs_at_twenty_hz():
    from eis_companion.app import CONTROL_HZ
    assert CONTROL_HZ == 20.0


def test_exactly_one_control_source_after_every_transition():
    c = make_companion()
    c._vehicle_state = airborne_state()
    assert c._control_source == ControlSource.AUTO.value
    run(c._execute_plan({"plan": valid_plan()}))
    assert c._control_source == ControlSource.PLANNER.value
    dispatch(c, "engageManual")
    assert c._control_source == ControlSource.MANUAL.value
    assert c._planner_engaged is False
    dispatch(c, "disengageManual")
    assert c._control_source == ControlSource.AUTO.value


def test_the_deadman_still_releases_everything_including_the_corridor():
    c = make_companion()
    c._vehicle_state = airborne_state()
    run(c._execute_plan({"plan": valid_plan()}))
    c.safety._last_ground_hb_ms -= 10_000.0

    run(c._control_tick(0.05))
    assert c._planner_engaged is False
    assert c.envelope.armed is False
    assert c._control_source == ControlSource.AUTO.value


# ==========================================================================
# Plan shape extraction + the second vehicle's config
# ==========================================================================
def test_plan_shape_reports_the_worst_case_of_each_field():
    alt, laps, hold = _plan_envelope_shape({"tools": [
        {"tool": "goto_gps", "lat": 0, "lon": 0, "alt": 35.0},
        {"tool": "goto_gps", "lat": 0, "lon": 0, "alt": 48.0},
        {"tool": "orbit_point", "lat": 0, "lon": 0, "radius": 30.0, "laps": 2.0},
        {"tool": "hold", "durationS": 12.0},
        {"tool": "hold", "duration_s": 20.0},
    ]})
    assert alt == 48.0 and laps == 2.0 and hold == 20.0


def test_a_plan_with_no_declared_altitude_yields_nan():
    """"We could not tell" must not read as "it was fine" when nobody is
    watching -- NaN fails the unattended band check."""
    alt, _, _ = _plan_envelope_shape({"tools": [{"tool": "rtl"}]})
    assert math.isnan(alt)


def test_second_vehicle_config_is_independent():
    cfg = load_config("config/vehicle2.yaml", use_dotenv=False, use_env=False)
    assert cfg.vehicle_id == "eis-2"
    assert cfg.network.control_port == 8766
    assert cfg.fc.connection == "udp:127.0.0.1:14560"     # SITL instance 1
    assert cfg.fc.sysid == 2 and cfg.fc.gcs_sysid == 254
    assert cfg.security.session_key_env == "EIS_SESSION_KEY_EIS_2"
    # Identical safety envelope: a second airframe is not a reason to fly wider.
    assert cfg.limits.min_standoff >= 3.0
    assert cfg.limits.max_speed <= 8.0
    assert cfg.envelope.separation_m == 40.0
    assert cfg.envelope.separation_stale_m == 80.0
    assert cfg.unattended.max_sorties_per_hour == 2


def test_the_second_vehicle_gets_its_own_audit_chain():
    cfg = load_config("config/vehicle2.yaml", use_dotenv=False, use_env=False)
    c = Companion(cfg)
    assert c._audit_path().endswith("companion-audit-eis-2.jsonl")

    first = Companion(load_config(None, use_dotenv=False, use_env=False))
    assert first._audit_path().endswith("companion-audit.jsonl")
