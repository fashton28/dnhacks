"""Containment that is ARMED, VERIFIED and GATED (FM-13/14/15/16).

Three separate ways containment was nominal-on-paper only:
  * NFZs never reached the vehicle or the firmware at all -- they were enforced
    solely by the ground verifier, so any plan arriving another way was
    uncontained (FM-13);
  * the fence upload reported success on a fence that may never have been
    ENABLED, and matched the PARAM_VALUE echo on name alone, so even the
    acknowledged path proved nothing (FM-14);
  * whatever the outcome, nothing downstream consulted it (FM-15);
  * `failsafe_param_map` -- the whole firmware half of "clamped twice" -- had
    no runtime caller anywhere (FM-16).
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from pymavlink import mavutil

from eis_companion.app import Companion
from eis_companion.config import AppConfig
from eis_companion.mavlink.safety import failsafe_param_map
from eis_companion.mavlink.vehicle import Vehicle
from eis_companion.types import Limits

mav = mavutil.mavlink

STUB_SITE = "site/site.stub.json"
HOME_LAT, HOME_LON = -26.0900, 29.4719
FAR_LAT, FAR_LON = -26.09065, 29.46925
# Dead centre of the stub site's "chimney" NFZ (ceiling 80 m).
NFZ_LAT, NFZ_LON = -26.0885, 29.4701

PERIMETER = [
    (-35.360761, 149.16223),
    (-35.360761, 149.16823),
    (-35.365761, 149.16823),
    (-35.365761, 149.16223),
]
EXCLUSION = [
    (-35.362761, 149.16423),
    (-35.362761, 149.16523),
    (-35.363761, 149.16523),
]


# ==========================================================================
# Fake MAVLink connection
# ==========================================================================
class Msg:
    def __init__(self, mtype: str, **fields) -> None:
        self._mtype = mtype
        for k, v in fields.items():
            setattr(self, k, v)

    def get_type(self) -> str:
        return self._mtype

    def get_srcSystem(self) -> int:
        return 1


class FakeMav:
    def __init__(self, sent: list) -> None:
        self._sent = sent

    def __getattr__(self, name: str):
        if not name.endswith("_send"):
            raise AttributeError(name)
        stripped = name[: -len("_send")]

        def _send(*args):
            self._sent.append((stripped, args))
        return _send


class FakeMaster:
    target_system = 1
    target_component = 1

    def __init__(self, inbox=()) -> None:
        self.sent: list = []
        self.mav = FakeMav(self.sent)
        self.inbox = list(inbox)

    def recv_match(self, type=None, blocking=False, timeout=None):
        want = [type] if isinstance(type, str) else list(type or [])
        while self.inbox:
            msg = self.inbox.pop(0)
            if not want or msg.get_type() in want:
                return msg
        return None


def make_vehicle(inbox=(), limits: Limits | None = None) -> Vehicle:
    v = Vehicle(limits=limits)
    v._master = FakeMaster(inbox)
    v._connected = True
    v._target_system = 1
    v._target_component = 1
    return v


def fence_inbox(items: int, *, enable_value: float = 1.0, type_value: float = 5.0,
                with_params: bool = True):
    inbox = [Msg("MISSION_REQUEST", seq=i) for i in range(items)]
    inbox.append(Msg("MISSION_ACK", type=mav.MAV_MISSION_ACCEPTED))
    if with_params:
        inbox.append(Msg("PARAM_VALUE", param_id="FENCE_TYPE", param_value=type_value))
        inbox.append(Msg("PARAM_VALUE", param_id="FENCE_ENABLE", param_value=enable_value))
    return inbox


# ==========================================================================
# FM-14: "stored" is not "enforced"
# ==========================================================================
def test_a_verified_enable_reports_the_fence_as_enforced():
    v = make_vehicle(fence_inbox(4))
    assert v.upload_geofence(PERIMETER) is True
    status = v.fence_status()
    assert status["stored"] is True
    assert status["enabled"] is True
    assert status["enforced"] is True


def test_an_unacknowledged_enable_is_reported_as_stored_but_NOT_enforced():
    """The transfer succeeds; FENCE_ENABLE goes unanswered. The upload still
    returns True (the polygon IS stored) but the fence is NOT enforced, and
    that distinction is now visible instead of being discarded."""
    v = make_vehicle(fence_inbox(4, with_params=False))
    assert v.upload_geofence(PERIMETER, item_timeout=0.01) is True
    status = v.fence_status()
    assert status["stored"] is True
    assert status["enforced"] is False
    assert "NOT verified as enabled" in status["detail"]


def test_a_refused_or_clamped_param_write_is_detected_by_value():
    """set_param matched the echo on param_id ONLY, and ArduPilot echoes the
    value it ACTUALLY STORED -- so a refused write reported success."""
    v = make_vehicle([Msg("PARAM_VALUE", param_id="FENCE_ENABLE", param_value=0.0)])
    assert v.set_param("FENCE_ENABLE", 1.0, retries=1, timeout=0.01) is False

    ok = make_vehicle([Msg("PARAM_VALUE", param_id="FENCE_ENABLE", param_value=1.0)])
    assert ok.set_param("FENCE_ENABLE", 1.0, retries=1, timeout=0.01) is True


def test_a_fence_the_fc_never_stored_is_reported_as_not_enforced():
    v = make_vehicle([Msg("MISSION_ACK", type=mav.MAV_MISSION_ERROR)])
    assert v.upload_geofence(PERIMETER) is False
    assert v.fence_status()["enforced"] is False


def test_no_fc_link_is_reported_as_no_fence():
    v = make_vehicle()
    v._connected = False
    assert v.upload_geofence(PERIMETER) is False
    assert v.fence_status()["enforced"] is False


# ==========================================================================
# FM-13: NFZs reach the firmware as EXCLUSION polygons
# ==========================================================================
def test_nfz_polygons_are_uploaded_as_exclusion_fences():
    total = len(PERIMETER) + len(EXCLUSION)
    v = make_vehicle(fence_inbox(total))
    assert v.upload_geofence(PERIMETER, exclusions=[EXCLUSION]) is True

    items = [args for name, args in v._master.sent if name == "mission_item_int"]
    assert len(items) == total
    commands = [args[4] for args in items]
    inclusion = mav.MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION
    exclusion = mav.MAV_CMD_NAV_FENCE_POLYGON_VERTEX_EXCLUSION
    assert commands[: len(PERIMETER)] == [inclusion] * len(PERIMETER)
    assert commands[len(PERIMETER):] == [exclusion] * len(EXCLUSION)
    # Each polygon declares its OWN vertex count in param1.
    assert items[0][7] == float(len(PERIMETER))
    assert items[-1][7] == float(len(EXCLUSION))


def test_a_malformed_exclusion_polygon_is_skipped_not_flown():
    v = make_vehicle(fence_inbox(len(PERIMETER)))
    assert v.upload_geofence(PERIMETER, exclusions=[[(0.0, 0.0), (1.0, 1.0)]]) is True
    items = [args for name, args in v._master.sent if name == "mission_item_int"]
    assert len(items) == len(PERIMETER)


# ==========================================================================
# FM-16: the derived envelope actually reaches the FC
# ==========================================================================
def test_apply_failsafe_params_pushes_the_whole_derived_map():
    params = failsafe_param_map(Limits(), cell_count=4)
    inbox = [
        Msg("PARAM_VALUE", param_id=name, param_value=float(value))
        for name, value in params.items()
    ]
    v = make_vehicle(inbox, limits=Limits())
    applied, attempted, failures = v.apply_failsafe_params(cell_count=4)
    assert attempted == len(params)
    assert applied == attempted
    assert failures == []
    written = {
        args[2].decode() if isinstance(args[2], bytes) else args[2]
        for name, args in v._master.sent if name == "param_set"
    }
    for critical in ("FENCE_ENABLE", "FENCE_ALT_MAX", "FS_GCS_ENABLE",
                     "BATT_LOW_VOLT", "RTL_ALT", "WPNAV_SPEED"):
        assert critical in written


def test_an_unconfirmed_param_is_reported_as_a_failure_not_swallowed():
    v = make_vehicle([], limits=Limits())
    applied, attempted, failures = v.apply_failsafe_params(cell_count=4)
    assert applied == 0
    assert attempted > 0
    assert "FENCE_ENABLE" in failures


def test_the_pushed_altitude_fence_is_the_configured_limit():
    """The firmware half of "clamped twice" must derive from the SAME Limits."""
    limits = Limits(max_altitude=42.0)
    params = failsafe_param_map(limits, cell_count=4)
    assert params["FENCE_ALT_MAX"] == pytest.approx(42.0)


# ==========================================================================
# Orchestrator: containment gates dispatch
# ==========================================================================
class OrchestratorVehicle:
    def __init__(self, *, enforced=True) -> None:
        self.calls: list = []
        self.limits = Limits()
        self._enforced = enforced
        self.uploaded_exclusions = None

    def send_body_velocity(self, vx, vy, vz, yaw_rate, valid=True):
        self.calls.append(("vel", vx, vy, vz, yaw_rate, valid))

    def set_mode(self, mode):
        self.calls.append(("mode", mode))
        return True

    def update_limits(self, limits):
        self.limits = limits

    def upload_geofence(self, perimeter, *, exclusions=(), **kwargs):
        self.uploaded_exclusions = [list(z) for z in exclusions]
        self.calls.append(("fence", list(perimeter)))
        return True

    def fence_status(self):
        return {
            "stored": True,
            "enabled": self._enforced,
            "enforced": self._enforced,
            "detail": "ok" if self._enforced
            else "fence STORED but NOT verified as enabled",
        }

    def apply_failsafe_params(self, *, cell_count=4, geofence_radius_m=None):
        self.calls.append(("params", cell_count, geofence_radius_m))
        return (10, 10, [])

    def named(self, name):
        return [c for c in self.calls if c[0] == name]


def make_companion(*, enforced=True, site_file=STUB_SITE) -> Companion:
    cfg = AppConfig()
    cfg.sitl = True
    cfg.camera.source = "sim"
    cfg.planner.site_file = site_file
    c = Companion(cfg)
    c.setup()
    c.vehicle = OrchestratorVehicle(enforced=enforced)
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


def run(coro):
    return asyncio.run(coro)


def plan_to(lat, lon, alt=40.0):
    return {
        "requestId": "req-1", "anomalyId": "anom-1", "profile": "standard",
        "rationale": "test",
        "tools": [{"tool": "goto_gps", "lat": lat, "lon": lon, "alt": alt}],
    }


def test_the_orchestrator_uploads_the_site_nfzs_as_exclusion_zones():
    c = make_companion()
    run(c._upload_site_fence())
    assert c.vehicle.uploaded_exclusions is not None
    # the stub site declares two NFZs (chimney, switchyard)
    assert len(c.vehicle.uploaded_exclusions) == 2
    assert c._fence_enforced is True


def test_a_plan_targeting_an_nfz_is_refused_by_the_companion():
    """planner_exec validates lat/lon RANGE, the alt band and speed -- it has
    no polygon awareness at all, and only the perimeter went to the FC, so a
    breach INSIDE the perimeter triggered nothing (FM-13)."""
    c = make_companion()
    ok, message = run(c._execute_plan({"plan": plan_to(NFZ_LAT, NFZ_LON, alt=40.0)}))
    assert ok is False
    assert "no-fly zone" in message
    assert c._planner_engaged is False


def test_a_plan_near_an_nfz_is_refused_on_the_buffer():
    c = make_companion()
    # ~40 m north of the chimney polygon edge: outside it, inside the 25 m
    # buffer's reach once the config floor is applied.
    near_lat = -26.08805
    ok, message = run(c._execute_plan({"plan": plan_to(near_lat, NFZ_LON, alt=40.0)}))
    assert ok is False
    assert "no-fly zone" in message


def test_overflight_above_the_nfz_ceiling_is_permitted():
    """SITE_CONTRACT: flight inside the polygon AT OR BELOW the ceiling is
    forbidden; overflight above it is not."""
    c = make_companion()
    c.limits.max_altitude = 120.0
    ok, _ = run(c._execute_plan({"plan": plan_to(NFZ_LAT, NFZ_LON, alt=100.0)}))
    assert ok is True


def test_a_clear_plan_is_still_accepted():
    """Control: containment must not refuse everything."""
    c = make_companion()
    ok, _ = run(c._execute_plan({"plan": plan_to(FAR_LAT, FAR_LON, alt=40.0)}))
    assert ok is True


def test_dispatch_is_refused_when_the_fence_is_not_enforced():
    """The upload's outcome used to be a local that was thrown away."""
    c = make_companion(enforced=False)
    run(c._upload_site_fence())
    assert c._fence_enforced is False

    ok, message = run(c._execute_plan({"plan": plan_to(FAR_LAT, FAR_LON)}))
    assert ok is False
    assert "enabled" in message or "enforc" in message

    assert c._readiness_message()["ready"] is False
    ack = run(c._handle_command({"command": "arm", "params": {}}))
    assert ack["success"] is False


def test_the_failsafe_params_are_pushed_on_connect():
    c = make_companion()
    run(c._apply_failsafe_params())
    assert c.vehicle.named("params"), "the derived envelope must reach the FC"


def test_the_fc_circle_fence_is_sized_to_the_site_not_the_launch_pad():
    """A 60 m circle around home fences a ~720 x 880 m plant into its own pad:
    the first outbound leg breaches and the firmware RTLs mid-demo (FM-155)."""
    c = make_companion()
    radius = c._site_containment_radius_m()
    assert radius is not None and radius > 400.0

    params = failsafe_param_map(Limits(), geofence_radius_m=radius)
    assert params["FENCE_RADIUS"] == pytest.approx(radius)

    # No site loaded -> the conservative shared default, never 0 or infinite.
    bare = make_companion(site_file="site/does-not-exist.json")
    assert bare._site_containment_radius_m() is None
    fallback = failsafe_param_map(Limits(), geofence_radius_m=None)
    assert fallback["FENCE_RADIUS"] == pytest.approx(60.0)


def test_the_sitl_param_file_contains_the_site_it_flies():
    """The bootstrap .parm must not fence the aircraft out of its own site."""
    parm = (
        Path(__file__).resolve().parents[2] / "sim" / "params" / "eis-sitl.parm"
    ).read_text(encoding="utf-8")
    values = {}
    for line in parm.splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        name, _, value = line.partition(" ")
        values[name.strip()] = float(value.strip())

    site = json.loads(
        (Path(__file__).resolve().parents[2] / "site" / "site.stub.json")
        .read_text(encoding="utf-8")
    )
    assert values["FENCE_ALT_MAX"] >= site["alt_band_m"]["max"]
    assert values["FENCE_ALT_MAX"] >= site["clear_altitude_m"]

    home = (site["home"]["lat"], site["home"]["lon"])
    span = max(
        _great_circle(home[0], home[1], v[0], v[1]) for v in site["perimeter"]
    )
    assert values["FENCE_RADIUS"] >= span, (
        f"FENCE_RADIUS {values['FENCE_RADIUS']} m cannot contain a site whose "
        f"farthest perimeter vertex is {span:.0f} m from home"
    )


def _great_circle(lat1, lon1, lat2, lon2) -> float:
    import math

    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6_371_000.0 * math.asin(min(1.0, math.sqrt(a)))
