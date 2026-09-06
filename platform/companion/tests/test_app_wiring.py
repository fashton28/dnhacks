"""
Orchestrator wiring tests for the mission-planner retrofit (Phase 2).

Proves, against the real Companion orchestrator (no network, FakeVehicle):
  * executePlan validates params.plan via PlannerExecutor (the companion-side
    independent validator): valid plans ack success + engage controlSource
    'planner'; unknown tools / malformed plans ack failure and stay 'auto',
  * mutual exclusion: manual blocks executePlan, executePlan releases
    tracking, engageTracking refuses while a plan is active, engageManual
    force-releases the plan (hands-on operator wins),
  * abortPlan zero-and-holds and releases back to auto (idempotent), and a
    stray abortPlan/disengage never stomps another active control source
    (that would silence the ground-link deadman mid-flight),
  * the 20 Hz control tick routes planner output: velocity legs through the
    normal clamp+send path, goto legs through Vehicle.goto_global (throttled
    stream, no competing body-velocity frame), rtl -> existing rtl path +
    release, completion -> release to hold,
  * rtl/disarm/land (_release_all) and the ground-link deadman clear the
    planner flag and reset the executor (a plan never survives a failsafe),
  * SafetyManager.evaluate_link treats 'planner' like tracking/manual,
  * the staging observer runs ONLY while a plan is flying and its
    observations ride the normal tracker path; setup() builds the REAL
    StagingObserver from the Site loaded off disk (wiring regression),
  * the site perimeter fence upload is attempted after connect (best-effort),
  * config: planner profile speeds mirror the shared PROFILE_SPEED_MPS and
    are clamped under the hard 8 m/s cap at load; EIS_SITE_FILE overrides.

Style matches the existing suite: plain pytest, no hardware; async paths are
driven with asyncio.run(). Manual/tracking behavior is untouched and stays
covered by the pre-existing tests.
"""
from __future__ import annotations

import asyncio
import math
from types import SimpleNamespace

import pytest

from eis_companion.app import Companion, _great_circle_distance_m
from eis_companion.config import AppConfig, MAX_SPEED_CAP, load_config
from eis_companion.control.failsafe import FailsafeDecision
from eis_companion.mavlink.safety import FailsafeAction, SafetyManager
from eis_companion.types import ControlSource, Limits, TargetObservation, VehicleState

# Stub site geometry (site/site.stub.json -- resolved from the repo root).
STUB_SITE = "site/site.stub.json"
HOME_LAT, HOME_LON = 41.1992364, -98.3995821
FAR_LAT, FAR_LON = 41.198383, -98.4  # south service-road staging point


# ==========================================================================
# Fakes
# ==========================================================================
class FakeVehicle:
    """Records every FC-bound call as a tuple (mirrors tests/test_vehicle.py's
    recording idiom at the orchestrator seam)."""

    def __init__(self) -> None:
        self.calls: list = []
        self.limits = Limits()

    def send_body_velocity(self, vx, vy, vz, yaw_rate, valid=True):
        self.calls.append(("vel", vx, vy, vz, yaw_rate, valid))

    def send_heartbeat(self):
        self.calls.append(("heartbeat",))
        return True

    def goto_global(self, lat, lon, rel_alt, speed, **kwargs):
        self.calls.append(("goto", lat, lon, rel_alt, speed))
        return True

    def set_mode(self, mode):
        self.calls.append(("mode", mode))

    def arm(self):
        self.calls.append(("arm",))

    def takeoff(self, altitude):
        self.calls.append(("takeoff", altitude))

    def land(self):
        self.calls.append(("land",))

    def disarm(self, force=False):
        self.calls.append(("disarm", force))

    def update_limits(self, limits):
        self.limits = limits

    def upload_geofence(self, perimeter, **kwargs):
        self.calls.append(("fence", list(perimeter)))
        return True

    def named(self, name: str) -> list:
        return [c for c in self.calls if c[0] == name]


class FakeStagingObserver:
    def __init__(self, out=None) -> None:
        self.calls: list = []
        self.resets = 0
        self._out = list(out or [])

    def observe(self, lat, lon, rel_alt=0.0):
        self.calls.append((lat, lon, rel_alt))
        return list(self._out)

    def reset(self) -> None:
        self.resets += 1


class FakeTracker:
    """Records observations; returns an idle-ish TrackingResult shape."""

    def __init__(self) -> None:
        self.seen: list = []

    def update(self, observations, ts):
        self.seen.append(list(observations))
        return SimpleNamespace(
            state="searching",
            targets=[],
            locked_target_id=None,
            locked_bbox=None,
            estimated_distance=None,
        )

    def select(self, tid):
        pass


# ==========================================================================
# Helpers
# ==========================================================================
def make_companion(site_file: str = STUB_SITE) -> Companion:
    cfg = AppConfig()
    cfg.sitl = True
    cfg.camera.source = "sim"
    cfg.planner.site_file = site_file
    c = Companion(cfg)
    c.setup()
    c.vehicle = FakeVehicle()
    c._fc_ready = True
    c._battery_snapshot = SimpleNamespace(
        ready=True, reasons=(), eta_ready_s=0.0, fault="",
        reserve_should_rtl=False, sortie_should_rtl=False,
    )
    c._nav_snapshot = SimpleNamespace(
        refuse_missions=False, gps_healthy=True, reason="GPS healthy", source="gps"
    )
    return c


def airborne_state(lat=HOME_LAT, lon=HOME_LON, alt=25.0) -> VehicleState:
    return VehicleState(
        armed=True, airborne=True, mode="GUIDED",
        lat=lat, lon=lon, relAlt=alt, heading=0.0,
    )


def run(coro):
    return asyncio.run(coro)


def test_home_distance_uses_vehicle_position_and_site_home():
    assert _great_circle_distance_m(HOME_LAT, HOME_LON, HOME_LAT, HOME_LON) == pytest.approx(0.0)
    assert _great_circle_distance_m(FAR_LAT, FAR_LON, HOME_LAT, HOME_LON) > 100.0
    assert math.isinf(_great_circle_distance_m(math.nan, HOME_LON, HOME_LAT, HOME_LON))


def test_telemetry_tick_sends_fc_heartbeat_at_one_hz():
    c = make_companion()
    c._last_fc_heartbeat_sent_s = 0.0
    run(c._telemetry_tick())
    run(c._telemetry_tick())
    assert c.vehicle.named("heartbeat") == [("heartbeat",)]


def dispatch(c: Companion, command: str, params=None):
    return run(c._handle_command({"command": command, "params": params or {}}))


def valid_plan(tools=None, profile="standard"):
    return {
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


# ==========================================================================
# executePlan / abortPlan dispatch + acks
# ==========================================================================
def test_execute_plan_ack_and_engage():
    c = make_companion()
    ack = dispatch(c, "executePlan", {"plan": valid_plan()})
    assert ack["type"] == "ack" and ack["command"] == "executePlan"
    assert ack["success"] is True
    assert c._planner_engaged is True
    assert c._control_source == ControlSource.PLANNER.value
    assert c.planner.active is True
    assert c.planner.tool_count == 3


def test_execute_plan_rejects_unknown_tool():
    c = make_companion()
    plan = valid_plan(tools=[{"tool": "teleport", "lat": 0.1, "lon": 0.1}])
    ack = dispatch(c, "executePlan", {"plan": plan})
    assert ack["success"] is False
    assert "unknown tool" in ack["message"]
    assert c._planner_engaged is False
    assert c._control_source == ControlSource.AUTO.value


@pytest.mark.parametrize("tool", ["follow", "orbit", "goto_relative"])
def test_sequence_plan_rejects_single_command_only_tools(tool):
    c = make_companion()
    params = {"tool": tool, "lat": HOME_LAT, "lon": HOME_LON, "dx": 1.0, "dy": 1.0}
    ack = dispatch(c, "executePlan", {"plan": valid_plan(tools=[params])})
    assert ack["success"] is False
    assert "unknown tool" in ack["message"]
    assert c._planner_engaged is False


def test_startup_race_refuses_arm_without_health_evidence():
    c = make_companion()
    c._battery_snapshot = None
    c._nav_snapshot = None
    ack = dispatch(c, "arm")
    assert not ack["success"]
    assert "telemetry unavailable" in ack["message"]


def test_armed_takeoff_transition_does_not_require_charged_state_again():
    c = make_companion()
    c._vehicle_state = VehicleState(armed=True, airborne=False, mode="GUIDED")
    c._battery_snapshot.ready = False
    c._battery_snapshot.reasons = ("charge_state=discharging",)
    c._failsafe_decision = FailsafeDecision("none", "", "companion")
    ack = dispatch(c, "takeoff", {"altitude": 20})
    assert ack["success"]
    assert ("takeoff", 20.0) in c.vehicle.calls
    c.vehicle.calls.clear()
    run(c._control_tick(0.05))
    assert c.vehicle.named("vel") == []


def test_night_and_clutter_require_real_sensor_rails_before_plan_load():
    c = make_companion()
    c._thermal_observation_valid = False
    night = dispatch(c, "executePlan", {"plan": valid_plan(), "night": True})
    assert not night["success"] and "thermal" in night["message"]
    c._thermal_observation_valid = True
    c._lidar_observation_valid = False
    clutter = dispatch(c, "executePlan", {
        "plan": valid_plan(), "routeThroughClutter": True,
    })
    assert not clutter["success"] and "LiDAR" in clutter["message"]


def test_camera_escalation_allows_existing_plan_to_reach_terminal_rtl():
    c = make_companion()
    c._vehicle_state = airborne_state()
    assert dispatch(c, "executePlan", {"plan": valid_plan(tools=[{"tool": "rtl"}])})["success"]
    c._failsafe_decision = FailsafeDecision(
        "escalate", "no observation: camera failed", "companion"
    )
    c.vehicle.calls.clear()
    run(c._control_tick(0.05))
    assert ("mode", "RTL") in c.vehicle.calls


@pytest.mark.parametrize("params", [
    {},                                # no plan at all
    {"plan": "not-a-dict"},            # wrong type
    {"plan": {"tools": []}},           # empty tool list
    {"plan": {"tools": [{"tool": "goto_gps", "lat": float("nan"), "lon": 0.0}]}},
])
def test_execute_plan_rejects_malformed(params):
    c = make_companion()
    ack = dispatch(c, "executePlan", params)
    assert ack["success"] is False
    assert c._planner_engaged is False
    assert c._control_source == ControlSource.AUTO.value


def test_execute_plan_refused_while_manual():
    c = make_companion()
    c._manual_engaged = True
    ack = dispatch(c, "executePlan", {"plan": valid_plan()})
    assert ack["success"] is False
    assert "manual" in ack["message"]
    assert c._planner_engaged is False


def test_execute_plan_releases_tracking():
    c = make_companion()
    c._tracking_engaged = True
    c._set_control_source(ControlSource.TRACKING.value)
    ack = dispatch(c, "executePlan", {"plan": valid_plan()})
    assert ack["success"] is True
    assert c._tracking_engaged is False
    assert c._control_source == ControlSource.PLANNER.value


def test_engage_tracking_refused_while_plan_active():
    c = make_companion()
    dispatch(c, "executePlan", {"plan": valid_plan()})
    ack = dispatch(c, "engageTracking", {})
    assert ack["success"] is False
    assert c._tracking_engaged is False
    assert c._control_source == ControlSource.PLANNER.value


def test_engage_manual_force_releases_plan():
    c = make_companion()
    c._vehicle_state = airborne_state()
    dispatch(c, "executePlan", {"plan": valid_plan()})
    ack = dispatch(c, "engageManual", {})
    assert ack["success"] is True
    assert c._manual_engaged is True
    assert c._planner_engaged is False
    assert c.planner.active is False
    assert c._control_source == ControlSource.MANUAL.value


def test_abort_plan_releases_to_auto_hold():
    c = make_companion()
    dispatch(c, "executePlan", {"plan": valid_plan()})
    ack = dispatch(c, "abortPlan", {})
    assert ack["success"] is True
    assert c._planner_engaged is False
    assert c._control_source == ControlSource.AUTO.value
    assert c.planner.active is False
    # the abort emitted the canonical zero-and-hold frame
    vel = c.vehicle.named("vel")
    assert vel and vel[-1] == ("vel", 0.0, 0.0, 0.0, 0.0, False)


def test_abort_plan_idempotent_without_plan():
    c = make_companion()
    ack = dispatch(c, "abortPlan", {})
    assert ack["success"] is True
    assert c._control_source == ControlSource.AUTO.value


def test_stray_abort_plan_does_not_stomp_active_source():
    """SAFETY regression: a stray abortPlan (idempotent success by design)
    while tracking or manual is engaged must NOT relabel controlSource
    'auto' -- SafetyManager.evaluate_link's link_matters would go False and
    the ground-link deadman would be silenced while guidance/manual keeps
    commanding motion (and telemetry would lie about the active source)."""
    c = make_companion()
    ack = dispatch(c, "engageTracking", {})
    assert ack["success"] is True
    c.vehicle.calls.clear()

    ack = dispatch(c, "abortPlan", {})
    assert ack["success"] is True                       # still idempotent
    assert c._tracking_engaged is True                  # tracking untouched
    assert c._control_source == ControlSource.TRACKING.value
    assert c.vehicle.named("vel") == []                 # no competing hold frame

    # same for manual: only the planner flag may be touched
    c2 = make_companion()
    c2._vehicle_state = airborne_state()
    assert dispatch(c2, "engageManual", {})["success"] is True
    dispatch(c2, "abortPlan", {})
    assert c2._manual_engaged is True
    assert c2._control_source == ControlSource.MANUAL.value


def test_stray_disengages_do_not_stomp_planner_source():
    """Same stomp hazard, disengage idiom: stray disengageTracking /
    disengageManual while a plan is flying must leave source 'planner'."""
    c = make_companion()
    c._vehicle_state = airborne_state()
    assert dispatch(c, "executePlan", {"plan": valid_plan()})["success"] is True

    dispatch(c, "disengageTracking", {})
    assert c._planner_engaged is True
    assert c._control_source == ControlSource.PLANNER.value

    dispatch(c, "disengageManual", {})
    assert c._planner_engaged is True
    assert c._control_source == ControlSource.PLANNER.value


def test_rtl_command_releases_planner():
    c = make_companion()
    dispatch(c, "executePlan", {"plan": valid_plan()})
    dispatch(c, "rtl", {})
    assert c._planner_engaged is False
    assert c.planner.active is False
    assert c._control_source == ControlSource.AUTO.value


# ==========================================================================
# Control-tick routing (source == planner)
# ==========================================================================
def test_goto_leg_streams_goto_global_not_velocity():
    c = make_companion()
    c._vehicle_state = airborne_state()
    dispatch(c, "executePlan", {"plan": valid_plan(profile="fast")})
    c.vehicle.calls.clear()

    run(c._control_tick(0.05))
    run(c._control_tick(0.05))

    gotos = c.vehicle.named("goto")
    # throttled stream: same target within 1 s is sent exactly once
    assert len(gotos) == 1
    _, lat, lon, alt, speed = gotos[0]
    assert (lat, lon) == (FAR_LAT, FAR_LON)
    # alt clamped into site band [20, 60] intersected with max_altitude 30
    assert alt == pytest.approx(30.0)
    # 'fast' profile (6 m/s) re-clamped to limits.max_speed (2 m/s default)
    assert speed <= c.limits.max_speed + 1e-9
    # no competing body-velocity frame while the goto is streamed
    assert c.vehicle.named("vel") == []


def test_hold_leg_uses_normal_velocity_path_and_completes():
    c = make_companion()
    c._vehicle_state = airborne_state()
    dispatch(c, "executePlan", {"plan": valid_plan(tools=[
        {"tool": "hold", "durationS": 0.2},
    ])})
    c.vehicle.calls.clear()

    run(c._control_tick(0.15))          # holding: canonical zero-and-hold frame
    assert c.vehicle.named("vel")[-1] == ("vel", 0.0, 0.0, 0.0, 0.0, False)
    assert c._planner_engaged is True

    run(c._control_tick(0.15))          # duration expires -> plan complete
    assert c._planner_engaged is False
    assert c._control_source == ControlSource.AUTO.value
    assert c.planner.done is True


def test_rtl_tool_triggers_rtl_path_and_release():
    c = make_companion()
    c._vehicle_state = airborne_state()
    dispatch(c, "executePlan", {"plan": valid_plan(tools=[{"tool": "rtl"}])})
    c.vehicle.calls.clear()

    run(c._control_tick(0.05))
    assert ("mode", "RTL") in c.vehicle.calls
    assert c._planner_engaged is False
    assert c._control_source == ControlSource.AUTO.value


def test_planner_holds_until_preconditions_ok():
    """A plan accepted on the ground must not command motion until
    armed + airborne + GUIDED (same gate as tracking)."""
    c = make_companion()
    c._vehicle_state = VehicleState(armed=False, airborne=False, mode="STABILIZE")
    dispatch(c, "executePlan", {"plan": valid_plan()})
    c.vehicle.calls.clear()

    run(c._control_tick(0.05))
    assert c.vehicle.named("goto") == []
    assert c.vehicle.named("vel")[-1] == ("vel", 0.0, 0.0, 0.0, 0.0, False)
    assert c._planner_engaged is True   # still engaged, just gated


def test_orbit_velocity_output_respects_final_clamp():
    c = make_companion()
    # vehicle 3 m from the orbit centre with a 20 m ring -> radial output
    c._vehicle_state = airborne_state(lat=HOME_LAT + 0.000027, lon=HOME_LON)
    dispatch(c, "executePlan", {"plan": valid_plan(tools=[
        {"tool": "orbit_point", "lat": HOME_LAT, "lon": HOME_LON, "radius": 20.0},
    ])})
    c.vehicle.calls.clear()

    run(c._control_tick(0.05))
    vel = c.vehicle.named("vel")
    assert len(vel) == 1
    _, vx, vy, vz, yaw_rate, valid = vel[0]
    assert valid is True
    L = c.limits
    assert abs(vx) <= L.max_speed + 1e-9
    assert abs(vy) <= L.max_speed + 1e-9
    assert abs(vz) <= L.max_climb_rate + 1e-9
    assert abs(yaw_rate) <= L.max_yaw_rate + 1e-9


# ==========================================================================
# Deadman coverage for the planner source
# ==========================================================================
def test_link_deadman_trips_for_planner_source():
    t = {"now": 1000.0}
    sm = SafetyManager(Limits(), clock_ms=lambda: t["now"])
    t["now"] += 5000.0  # well past ground_link_timeout_ms (2000)
    status = sm.evaluate_link(ControlSource.PLANNER.value, airborne=True)
    assert status.tripped is True
    assert status.action == FailsafeAction.RTL

    # plain auto still never trips (FC GCS failsafe is the backstop)
    status_auto = sm.evaluate_link(ControlSource.AUTO.value, airborne=True)
    assert status_auto.tripped is False


def test_control_tick_deadman_releases_planner():
    c = make_companion()
    c._vehicle_state = airborne_state()
    dispatch(c, "executePlan", {"plan": valid_plan()})
    # starve the ground link far past the timeout
    c.safety._last_ground_hb_ms -= 10_000.0
    c.vehicle.calls.clear()

    run(c._control_tick(0.05))
    assert c._planner_engaged is False
    assert c.planner.active is False
    assert c._control_source == ControlSource.AUTO.value
    assert ("mode", "RTL") in c.vehicle.calls          # airborne -> RTL
    assert c.vehicle.named("vel")[0][5] is False       # zero-and-hold first


# ==========================================================================
# Staging vision gating (perception loop)
# ==========================================================================
def test_staging_observer_only_runs_while_planner_active():
    c = make_companion()
    c.source = None
    c.tracker = FakeTracker()
    fake = FakeStagingObserver()
    c.staging_observer = fake
    c._vehicle_state = airborne_state(lat=FAR_LAT, lon=FAR_LON)

    run(c._perception_tick())
    assert fake.calls == []            # idle: staging vision never runs

    c._planner_engaged = True
    run(c._perception_tick())
    assert fake.calls == [(FAR_LAT, FAR_LON, 25.0)]


def test_staging_observations_ride_the_tracker_path():
    c = make_companion()
    c.source = None
    tracker = FakeTracker()
    c.tracker = tracker
    obs = TargetObservation(bbox=(0.36, 0.42, 0.26, 0.18), conf=0.91)
    c.staging_observer = FakeStagingObserver(out=[obs])
    c._planner_engaged = True
    c._vehicle_state = airborne_state(lat=FAR_LAT, lon=FAR_LON)

    run(c._perception_tick())
    assert tracker.seen == [[obs]]


def test_execute_plan_rearms_staging_observer():
    c = make_companion()
    fake = FakeStagingObserver()
    c.staging_observer = fake
    dispatch(c, "executePlan", {"plan": valid_plan()})
    assert fake.resets == 1


def test_staging_observer_built_from_loaded_site():
    """Wiring regression: setup() must construct the REAL StagingObserver
    from the Site loaded off disk. site.py's StagingPoint dataclass is not
    a Mapping (and not vision/staging.py's same-named class); passing it
    through raw used to raise inside the observer and the swallowed error
    silently disabled staging vision in every real run."""
    c = make_companion()
    obs = c.staging_observer
    assert obs is not None, "StagingObserver failed to build from the loaded Site"
    assert [p.id for p in obs.points] == [
        "meridian-south-service-road",
        "meridian-east-yard",
    ]

    # End-to-end through the real observer: arriving at the south point (truth
    # 'vehicle') emits one high-confidence stub observation (ultralytics is
    # absent in the test env, so the deterministic truth-keyed backend runs).
    out = obs.observe(FAR_LAT, FAR_LON)
    assert len(out) == 1
    assert out[0].conf == pytest.approx(0.91)


# ==========================================================================
# Site fence upload after connect
# ==========================================================================
def test_site_fence_uploaded_from_stub_perimeter():
    c = make_companion()
    run(c._upload_site_fence())
    fences = c.vehicle.named("fence")
    assert len(fences) == 1
    assert len(fences[0][1]) == 4      # stub perimeter has 4 vertices
    assert all(len(v) == 2 for v in fences[0][1])


def test_site_fence_skipped_without_site_model():
    c = make_companion(site_file="site/does-not-exist.json")
    assert c.site is None
    run(c._upload_site_fence())
    assert c.vehicle.named("fence") == []


def test_missing_site_still_boots_planner():
    c = make_companion(site_file="site/does-not-exist.json")
    assert c.planner is not None
    ack = dispatch(c, "executePlan", {"plan": valid_plan()})
    assert ack["success"] is False
    assert "site model invalid" in ack["message"]


# ==========================================================================
# Runtime envelope: the wire can never relax the hard cap
# ==========================================================================
def test_set_max_speed_wire_command_clamped_under_hard_cap():
    """SAFETY regression: setMaxSpeed {mps: 50} used to raise the shared live
    Limits.max_speed to 50 at runtime (guidance.set_max_speed only floors at
    min_speed), silently relaxing the tracking/manual velocity clamps AND the
    Vehicle-held goto clamp past the config-time 8 m/s envelope. The dispatch
    handler must mirror _enforce_safety_floor at runtime."""
    c = make_companion()
    ack = dispatch(c, "setMaxSpeed", {"mps": 50.0})
    assert ack["success"] is True
    assert c.limits.max_speed <= MAX_SPEED_CAP
    assert c.vehicle.limits.max_speed <= MAX_SPEED_CAP  # shared live object

    # lowering (the legitimate use) still works...
    dispatch(c, "setMaxSpeed", {"mps": 1.5})
    assert c.limits.max_speed == pytest.approx(1.5)
    # ...and non-finite input degrades safely, never poisoning the envelope
    dispatch(c, "setMaxSpeed", {"mps": float("nan")})
    assert 0.0 < c.limits.max_speed <= MAX_SPEED_CAP


# ==========================================================================
# Config: planner section + safety floor
# ==========================================================================
def test_planner_config_defaults_mirror_shared_profiles():
    cfg = load_config(None, use_dotenv=False, use_env=False)
    assert cfg.planner.profile_speed_mps == {
        "follow": 2.0, "inspect": 4.0, "survey": 6.0,
        "slow": 2.0, "standard": 4.0, "fast": 6.0,
    }
    assert all(v <= MAX_SPEED_CAP for v in cfg.planner.profile_speed_mps.values())
    assert cfg.planner.staging_arrival_radius_m == 15.0
    assert cfg.planner.arrival_radius_m == 2.0


def test_planner_profile_speeds_clamped_under_hard_cap(tmp_path):
    p = tmp_path / "cfg.yaml"
    p.write_text(
        "planner:\n"
        "  profile_speed_mps: { slow: 1.0, standard: 99.0, fast: -5.0 }\n"
        "  staging_arrival_radius_m: 0.1\n"
        "  arrival_radius_m: 0.0\n",
        encoding="utf-8",
    )
    cfg = load_config(str(p), use_dotenv=False, use_env=False)
    assert cfg.planner.profile_speed_mps["slow"] == 1.0
    assert cfg.planner.profile_speed_mps["standard"] == MAX_SPEED_CAP
    assert cfg.planner.profile_speed_mps["fast"] == 0.0   # negative -> no motion
    assert cfg.planner.staging_arrival_radius_m == 1.0    # floored
    assert cfg.planner.arrival_radius_m == 0.5            # floored
    # the pre-existing hard floors are untouched
    assert cfg.limits.min_standoff >= 3.0
    assert cfg.limits.max_speed <= MAX_SPEED_CAP


def test_site_file_env_override(tmp_path, monkeypatch):
    p = tmp_path / "cfg.yaml"
    p.write_text("planner:\n  site_file: from-yaml.json\n", encoding="utf-8")
    monkeypatch.setenv("EIS_SITE_FILE", "custom/site.json")
    cfg = load_config(str(p), use_dotenv=False, use_env=True)
    assert cfg.planner.site_file == "custom/site.json"
