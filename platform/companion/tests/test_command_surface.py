"""The inbound command surface: bounds, exclusion, authentication, audit.

FM-11  planCommand follow/orbit wrote limits.standoff with NO upper bound, from
       a value `1e400` (plain, spec-legal JSON) parses straight into.
FM-12  the same branch returned before executePlan's manual guard, so a plan
       could engage while the operator's sticks were flying the aircraft.
FM-40  the control WebSocket bound 0.0.0.0 with no authentication of any kind.
FM-42  a companion refusal left no durable trace, so the UI's unconditional
       "Mission approved" was the only record.
FM-139 the gps_loss injector had no legacy fallback and set its internal flag
       even when the simulator refused the write.
FM-186 UNATTENDED_ENVELOPE must be hard-floored in config.py, in step with the
       ground's policy.ts.
"""
from __future__ import annotations

import asyncio
import json
import math
from types import SimpleNamespace

import pytest

from eis_companion.app import Companion
from eis_companion.config import (
    DEFAULT_CONTROL_HOST,
    MAX_STANDOFF_CEIL_M,
    UNATTENDED_MAX_ALT_CEIL_M,
    UNATTENDED_MAX_HOLD_CAP_S,
    UNATTENDED_MAX_LAPS_CAP,
    UNATTENDED_MAX_SORTIES_PER_HOUR_CAP,
    UNATTENDED_MAX_WIND_CAP_MPS,
    UNATTENDED_MIN_ALT_FLOOR_M,
    UNATTENDED_PROFILES_ALLOWED,
    AppConfig,
    is_loopback_host,
    load_config,
)
from eis_companion.security import CommandVerifier, sign_payload
from eis_companion.types import ControlSource, Limits, VehicleState

STUB_SITE = "site/site.stub.json"
HOME_LAT, HOME_LON = -26.0900, 29.4719
KEY = b"command-surface-test-key"


class FakeVehicle:
    def __init__(self, *, param_ok=True) -> None:
        self.calls: list = []
        self.limits = Limits()
        self.param_ok = param_ok
        self.params: dict = {}

    def send_body_velocity(self, vx, vy, vz, yaw_rate, valid=True):
        self.calls.append(("vel", vx, vy, vz, yaw_rate, valid))

    def set_mode(self, mode):
        self.calls.append(("mode", mode))
        return True

    def update_limits(self, limits):
        self.limits = limits

    def upload_geofence(self, perimeter, **kwargs):
        return True

    def fence_status(self):
        return {"stored": True, "enabled": True, "enforced": True, "detail": "ok"}

    def set_param(self, name, value, **kwargs):
        self.calls.append(("param", name, value))
        if self.param_ok:
            self.params[name] = value
        return self.param_ok

    def named(self, name):
        return [c for c in self.calls if c[0] == name]


def make_companion(**vehicle_kwargs) -> Companion:
    cfg = AppConfig()
    cfg.sitl = True
    cfg.camera.source = "sim"
    cfg.planner.site_file = STUB_SITE
    c = Companion(cfg)
    c.setup()
    c.vehicle = FakeVehicle(**vehicle_kwargs)
    c._fc_ready = True
    c.battery_health = None
    c._battery_snapshot = SimpleNamespace(
        ready=True, reasons=(), eta_ready_s=0.0, fault="",
        reserve_should_rtl=False, sortie_should_rtl=False,
    )
    c._nav_snapshot = SimpleNamespace(
        refuse_missions=False, gps_healthy=True, reason="GPS healthy", source="gps"
    )
    return c


class StubApi:
    """Captures outbound frames; ``loopback_only`` mirrors the real server."""

    def __init__(self, *, loopback_only=True) -> None:
        self.sent: list = []
        self.loopback_only = loopback_only

    async def broadcast(self, message):
        self.sent.append(dict(message))

    async def push_status(self, severity, text):
        self.sent.append({"type": "statusText", "severity": severity, "text": text})

    async def push_telemetry(self, telemetry):
        self.sent.append(dict(telemetry))

    async def push_tracking(self, tracking):
        self.sent.append(dict(tracking))


def run(coro):
    return asyncio.run(coro)


def airborne() -> VehicleState:
    return VehicleState(
        armed=True, airborne=True, mode="GUIDED",
        lat=HOME_LAT, lon=HOME_LON, relAlt=25.0,
    )


def plan_command(c: Companion, tool="follow", **args):
    return run(c._handle_plan_command({
        "type": "planCommand", "requestId": "r-1", "tool": tool,
        "profile": "standard", "args": {"track_id": 1, **args},
    }))


# ==========================================================================
# FM-11: standoff is a BAND, and a plan gives it back
# ==========================================================================
def test_an_infinite_radius_is_refused_outright():
    """`json.loads('{"radius":1e400}')` is inf, and max(floor, inf) is inf."""
    assert math.isinf(json.loads('{"radius": 1e400}')["radius"])
    c = make_companion()
    before = c.limits.standoff
    response = plan_command(c, radius=float("inf"))
    assert response["status"] == "rejected"
    assert "finite" in response["reason"]
    assert c.limits.standoff == before
    assert c._planner_engaged is False


def test_a_huge_radius_is_clamped_to_the_ceiling_and_the_ack_says_so():
    """Only the FLOOR was enforced, and the ack said 'accepted' for any value
    at or above it -- the operator got zero signal that the envelope moved."""
    c = make_companion()
    response = plan_command(c, radius=1e9)
    assert response["status"] == "clamped"
    assert c.limits.standoff <= MAX_STANDOFF_CEIL_M
    assert c.limits.standoff == pytest.approx(MAX_STANDOFF_CEIL_M)


def test_releasing_the_plan_restores_the_operator_standoff():
    """One follow/orbit permanently poisoned the process-wide envelope: nine
    sites clear _planner_engaged and not one restored limits.standoff."""
    c = make_companion()
    original = c.limits.standoff
    plan_command(c, radius=40.0)
    assert c.limits.standoff == pytest.approx(40.0)

    run(c._handle_command({"command": "abortPlan", "params": {}}))
    assert c.limits.standoff == pytest.approx(original)


def test_the_advertised_envelope_cannot_exceed_the_ceiling():
    """capabilities.max_standoff_m self-widened from the poisoned value."""
    c = make_companion()
    plan_command(c, radius=1e9)
    caps = [m for m in c._connect_messages() if m["type"] == "capabilities"][0]
    for profile in caps["profiles"]:
        assert profile["max_standoff_m"] <= MAX_STANDOFF_CEIL_M


def test_limits_clamp_standoff_is_closed_at_both_ends():
    limits = Limits(min_standoff=3.0, max_standoff=50.0, standoff=5.0)
    assert limits.clamp_standoff(1.0) == 3.0
    assert limits.clamp_standoff(1e9) == 50.0
    assert limits.clamp_standoff(float("inf")) == 5.0     # degrades, never inf
    assert limits.clamp_standoff(float("nan")) == 5.0


def test_config_floors_the_standoff_band(tmp_path):
    p = tmp_path / "cfg.yaml"
    p.write_text(
        "limits:\n  standoff: 900.0\n  min_standoff: 0.5\n  max_standoff: 900.0\n",
        encoding="utf-8",
    )
    cfg = load_config(str(p), use_dotenv=False, use_env=False)
    assert cfg.limits.min_standoff >= 3.0
    assert cfg.limits.max_standoff <= MAX_STANDOFF_CEIL_M
    assert cfg.limits.standoff <= MAX_STANDOFF_CEIL_M


# ==========================================================================
# FM-12: the planCommand path honours mutual exclusion
# ==========================================================================
def test_a_follow_command_is_refused_while_manual_is_engaged():
    c = make_companion()
    c._vehicle_state = airborne()
    assert run(c._handle_command({"command": "engageManual", "params": {}}))["success"]
    assert c._manual_engaged is True

    response = plan_command(c)
    assert response["status"] == "rejected"
    assert "manual" in response["reason"]
    # The invariant that matters: exactly ONE active source, and the label
    # still describes who is flying.
    assert c._planner_engaged is False
    assert c._control_source == ControlSource.MANUAL.value


def test_releasing_manual_after_a_refused_follow_does_not_fly_a_plan():
    """The failure landed on RELEASE: _disengage_manual clears only the manual
    flag, so the next tick fell through to the planner branch and flew a leg
    the operator never authorised -- with the deadman silenced."""
    c = make_companion()
    c._vehicle_state = airborne()
    run(c._handle_command({"command": "engageManual", "params": {}}))
    plan_command(c)
    run(c._handle_command({"command": "disengageManual", "params": {}}))

    assert c._planner_engaged is False
    assert c._planner_tracking_tool == ""
    assert c._control_source == ControlSource.AUTO.value
    c.vehicle.calls.clear()
    run(c._control_tick(0.05))
    vel = c.vehicle.named("vel")
    assert vel and vel[-1] == ("vel", 0.0, 0.0, 0.0, 0.0, False)


def test_a_follow_command_is_refused_without_a_site_model():
    c = make_companion()
    c._site_valid = False
    assert plan_command(c)["status"] == "rejected"


def test_a_follow_command_is_accepted_on_a_clean_vehicle():
    """Control: the new guards must not refuse the legitimate case."""
    c = make_companion()
    c._vehicle_state = airborne()
    response = plan_command(c, radius=12.0)
    assert response["status"] in ("accepted", "clamped")
    assert c._planner_engaged is True
    assert c._control_source == ControlSource.PLANNER.value


# ==========================================================================
# FM-40: bind policy + authentication of EVERY frame
# ==========================================================================
def test_the_control_socket_binds_loopback_by_default():
    cfg = load_config(None, use_dotenv=False, use_env=False)
    assert cfg.network.host == DEFAULT_CONTROL_HOST
    assert is_loopback_host(cfg.network.host)


def test_opening_the_socket_to_the_network_forces_signed_commands(tmp_path):
    p = tmp_path / "cfg.yaml"
    p.write_text(
        "network:\n  host: 0.0.0.0\nsecurity:\n  require_signed_commands: false\n",
        encoding="utf-8",
    )
    cfg = load_config(str(p), use_dotenv=False, use_env=False)
    assert cfg.network.host == "0.0.0.0"
    assert cfg.security.require_signed_commands is True, (
        "a socket the LAN can reach must authenticate every frame"
    )


def test_the_bind_all_env_opt_in_is_explicit(monkeypatch):
    monkeypatch.setenv("EIS_BIND_ALL", "true")
    cfg = load_config(None, use_dotenv=False, use_env=True)
    assert cfg.network.host == "0.0.0.0"
    assert cfg.security.require_signed_commands is True


def test_every_frame_type_passes_the_signing_layer_when_required():
    """manualInput / planCommand / fleet used to bypass signing entirely --
    and any inbound frame also satisfied the ground-link deadman (FM-40)."""
    verifier = CommandVerifier(KEY, require_all=True)
    for mtype in ("manualInput", "planCommand", "planHeartbeat", "rfEvent", "fleet"):
        unsigned = {"type": mtype, "vehicleId": "eis-1"}
        assert verifier.verify_frame(unsigned).ok is False

        signed = {"type": mtype, "vehicleId": "eis-1",
                  "ts": int(__import__("time").time() * 1000), "nonce": f"n-{mtype}"}
        signed["sig"] = sign_payload(signed, KEY)
        assert verifier.verify_frame(signed).ok is True


def test_unsigned_frames_still_flow_on_a_loopback_deployment():
    """Control: the default developer/demo posture is unchanged."""
    verifier = CommandVerifier(KEY, require_all=False)
    assert verifier.verify_frame({"type": "manualInput"}).ok is True
    # ...but the privileged set is never a knob.
    assert verifier.verify_frame(
        {"type": "command", "command": "enterUnattended"}
    ).ok is False


def test_the_orchestrator_authorize_hook_refuses_an_unsigned_privileged_command():
    c = make_companion()
    refusal = c._authorize_frame(
        {"type": "command", "command": "enterUnattended", "params": {}}
    )
    assert refusal
    assert c._authorize_frame({"type": "manualInput", "pitch": 0.0}) == ""


def test_test_fault_is_refused_when_the_socket_is_not_loopback(monkeypatch):
    monkeypatch.setenv("EIS_ENABLE_TEST_HOOKS", "true")
    c = make_companion()
    c.api = StubApi(loopback_only=False)
    ok, message = run(c._test_fault({"fault": "gps_loss", "enabled": True}))
    assert ok is False
    assert "loopback" in message


# ==========================================================================
# FM-42: a companion refusal is durable
# ==========================================================================
def test_a_refused_plan_leaves_a_replayable_health_event():
    c = make_companion()
    api = StubApi()
    c.api = api
    ok, _ = run(c._execute_plan({"plan": "not-a-dict"}))
    assert ok is False
    refusals = [
        e for e in api.sent
        if e.get("type") == "healthEvent" and e.get("state") == "refused"
    ]
    assert refusals, "a companion refusal must reach the audited health log"
    assert refusals[0]["component"] == "planner"


# ==========================================================================
# FM-139: the gps_loss injector has a legacy fallback and no divergence
# ==========================================================================
def test_gps_loss_falls_back_to_the_legacy_parameter(monkeypatch):
    monkeypatch.setenv("EIS_ENABLE_TEST_HOOKS", "true")
    c = make_companion()
    c.api = StubApi()

    class OnlyLegacy(FakeVehicle):
        def set_param(self, name, value, **kwargs):
            self.calls.append(("param", name, value))
            return name == "SIM_GPS_DISABLE"

    c.vehicle = OnlyLegacy()
    ok, _ = run(c._test_fault({"fault": "gps_loss", "enabled": True}))
    assert ok is True
    names = [call[1] for call in c.vehicle.named("param")]
    assert names == ["SIM_GPS1_ENABLE", "SIM_GPS_DISABLE"]
    assert c._faults["gps_loss"] is True


def test_a_refused_injection_does_not_diverge_companion_state(monkeypatch):
    """The internal flag was set even when the param push failed, so the
    companion believed in a fault the simulator never had."""
    monkeypatch.setenv("EIS_ENABLE_TEST_HOOKS", "true")
    c = make_companion(param_ok=False)
    c.api = StubApi()
    ok, message = run(c._test_fault({"fault": "gps_loss", "enabled": True}))
    assert ok is False
    assert c._faults["gps_loss"] is False


# ==========================================================================
# FM-186: UNATTENDED_ENVELOPE is hard-floored, in step with policy.ts
# ==========================================================================
GROUND_POLICY_VALUES = {
    # The ground's UNATTENDED_ENVELOPE (ground/planner/src/policy.ts): inspect
    # profile only, 30-50 m AGL, 1 lap, 15 s hold, 2 sorties/hour, 6 m/s wind.
    "min_alt_m": 30.0,
    "max_alt_m": 50.0,
    "max_laps": 1.0,
    "max_hold_s": 15.0,
    "max_sorties_per_hour": 2,
    "max_wind_mps": 6.0,
    "profiles": ("inspect",),
}


def test_config_mirrors_the_ground_unattended_envelope():
    assert UNATTENDED_MIN_ALT_FLOOR_M == GROUND_POLICY_VALUES["min_alt_m"]
    assert UNATTENDED_MAX_ALT_CEIL_M == GROUND_POLICY_VALUES["max_alt_m"]
    assert UNATTENDED_MAX_LAPS_CAP == GROUND_POLICY_VALUES["max_laps"]
    assert UNATTENDED_MAX_HOLD_CAP_S == GROUND_POLICY_VALUES["max_hold_s"]
    assert (
        UNATTENDED_MAX_SORTIES_PER_HOUR_CAP
        == GROUND_POLICY_VALUES["max_sorties_per_hour"]
    )
    assert UNATTENDED_MAX_WIND_CAP_MPS == GROUND_POLICY_VALUES["max_wind_mps"]
    assert UNATTENDED_PROFILES_ALLOWED == GROUND_POLICY_VALUES["profiles"]


def test_yaml_and_env_may_only_tighten_the_unattended_envelope(tmp_path, monkeypatch):
    p = tmp_path / "cfg.yaml"
    p.write_text(
        "unattended:\n"
        "  min_alt_m: 5.0\n"        # attempt to LOWER the floor
        "  max_alt_m: 400.0\n"      # attempt to RAISE the ceiling
        "  max_laps: 99\n"
        "  max_hold_s: 600\n"
        "  max_sorties_per_hour: 40\n"
        "  max_wind_mps: 25\n"
        "  profiles: [survey, follow]\n",
        encoding="utf-8",
    )
    cfg = load_config(str(p), use_dotenv=False, use_env=False)
    u = cfg.unattended
    assert u.min_alt_m >= UNATTENDED_MIN_ALT_FLOOR_M
    assert u.max_alt_m <= UNATTENDED_MAX_ALT_CEIL_M
    assert u.max_laps <= UNATTENDED_MAX_LAPS_CAP
    assert u.max_hold_s <= UNATTENDED_MAX_HOLD_CAP_S
    assert u.max_sorties_per_hour <= UNATTENDED_MAX_SORTIES_PER_HOUR_CAP
    assert u.max_wind_mps <= UNATTENDED_MAX_WIND_CAP_MPS
    assert u.profiles == UNATTENDED_PROFILES_ALLOWED

    monkeypatch.setenv("EIS_UNATTENDED_MAX_ALT_M", "999")
    monkeypatch.setenv("EIS_UNATTENDED_MAX_WIND_MPS", "30")
    env_cfg = load_config(None, use_dotenv=False, use_env=True)
    assert env_cfg.unattended.max_alt_m <= UNATTENDED_MAX_ALT_CEIL_M
    assert env_cfg.unattended.max_wind_mps <= UNATTENDED_MAX_WIND_CAP_MPS


def test_an_unattended_dispatch_is_refused_without_a_wind_estimate():
    """Nobody can take manual control up there and the wind limit is HALF the
    attended one, so an absent estimate must refuse, not read as calm (FM-20)."""
    c = make_companion()
    c.attendance.enter_unattended(signature_ok=True, now_ms=1, operator_id="op")
    c._wind_known = False
    ok, message = run(c._check_unattended_dispatch({"tools": []}, {}))
    assert ok is False
    assert "wind" in message
