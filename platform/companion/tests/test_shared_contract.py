"""
Contract parity -- pins the PYTHON mirror (shared/shared.py) to the
AUTHORITATIVE contract at ground/ui/src/contract/index.ts.

The TypeScript side already has drift protection: ground/planner's
test/contract-parity.test.ts type-asserts mutual assignability between
shared/shared.ts, the planner mirror and the authoritative copy. Python has no
compiler to do that, so this test does it structurally:

  * every closed literal union that exists in both files has the same members,
  * the shared constants have the same values,
  * the Phase 1 TypedDicts partition their keys into the same required/optional
    sets the TS interfaces declare (required field vs `field?:`).

It reads the .ts file as text on purpose -- no build step, no node, no network
-- and only ever parses forms the contract file actually uses. A mirror that
drifts fails here instead of at a demo.
"""
from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path
from typing import get_args

import pytest

PLATFORM = Path(__file__).resolve().parents[2]
SHARED_PY = PLATFORM / "shared" / "shared.py"
CONTRACT_TS = PLATFORM / "ground" / "ui" / "src" / "contract" / "index.ts"


def _load_shared():
    """Import shared/shared.py by path (it is a mirror file, not a package)."""
    spec = importlib.util.spec_from_file_location("eis_shared_contract", SHARED_PY)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    # Registered before exec: the @dataclass decorators resolve __module__.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def shared():
    return _load_shared()


@pytest.fixture(scope="module")
def ts() -> str:
    return CONTRACT_TS.read_text(encoding="utf-8")


def _ts_union(ts: str, name: str) -> set[str]:
    """Members of `export type <name> = 'a' | 'b' | ...;` in the contract."""
    match = re.search(rf"export type {name} =\s*(.*?);", ts, re.DOTALL)
    assert match, f"{name} not found in {CONTRACT_TS}"
    body = match.group(1)
    # Strip comments so a commented-out example can never widen the set.
    body = re.sub(r"//.*?$|/\*.*?\*/", "", body, flags=re.MULTILINE | re.DOTALL)
    return set(re.findall(r"'([^']+)'", body))


def _ts_number(ts: str, name: str) -> float:
    match = re.search(rf"export const {name} = (-?\d+(?:\.\d+)?);", ts)
    assert match, f"{name} not found in {CONTRACT_TS}"
    return float(match.group(1))


# --------------------------------------------------------------------------
# Closed literal unions
# --------------------------------------------------------------------------
UNIONS = [
    "Mode", "ControlSource", "NavSource", "FailsafeState", "ChargeState",
    "TrackingState", "MissionProfile", "AnomalySource", "CommandName",
    "SensorModality", "SensorHealth", "HealthComponent", "RfSource",
    "RfEventKind", "ConnectionState",
    # Phase 1
    "TaskLookFor", "TaskUrgency", "TaskSource",
    "EnvelopeState", "EnvelopeConstraint", "EnvelopeAction",
    "AttendanceMode", "VerificationCheckName",
]


@pytest.mark.parametrize("name", UNIONS)
def test_literal_union_members_match_the_authoritative_contract(shared, ts, name):
    py = set(get_args(getattr(shared, name)))
    assert py == _ts_union(ts, name), f"{name} drifted between shared.py and the TS contract"


def test_phase1_union_members_are_actually_present(shared):
    """Guards against the parity test passing because BOTH mirrors dropped a
    member: these are the Phase 1 values the rest of the system depends on."""
    assert "fence_sensor" in get_args(shared.AnomalySource)
    assert "cctv" in get_args(shared.AnomalySource)
    assert "envelope" in get_args(shared.HealthComponent)
    for command in ("setGimbal", "enterUnattended", "exitUnattended"):
        assert command in get_args(shared.CommandName)
    for check in ("attended", "deconfliction"):
        assert check in shared.VERIFICATION_CHECK_NAMES
    # A breach never resolves to "carry on".
    assert set(get_args(shared.EnvelopeAction)) == {"none", "slow", "hold", "rtl"}


# --------------------------------------------------------------------------
# Shared constants
# --------------------------------------------------------------------------
def test_shared_constants_match_the_authoritative_contract(shared, ts):
    assert shared.TASK_QUESTION_MAX_CHARS == _ts_number(ts, "TASK_QUESTION_MAX_CHARS")
    assert shared.GIMBAL_PITCH_MIN_DEG == _ts_number(ts, "GIMBAL_PITCH_MIN_DEG")
    assert shared.GIMBAL_PITCH_MAX_DEG == _ts_number(ts, "GIMBAL_PITCH_MAX_DEG")
    # -30 up / 0 level / 90 down -- the ARGUS console's gimbal convention.
    assert (shared.GIMBAL_PITCH_MIN_DEG, shared.GIMBAL_PITCH_MAX_DEG) == (-30.0, 90.0)
    assert set(shared.VERIFICATION_CHECK_NAMES) == _ts_union(ts, "VerificationCheckName")


def test_profile_speeds_stay_under_the_hard_max_speed_cap(shared):
    for speed in shared.PROFILE_SPEED_MPS.values():
        assert 0.0 < speed <= shared.DEFAULTS.max_speed_cap


# --------------------------------------------------------------------------
# TypedDict key partitions (required vs optional) for the Phase 1 shapes
# --------------------------------------------------------------------------
EXPECTED_KEYS = {
    "Task": (
        {"taskId", "anomalyId", "lookFor", "question", "urgency", "priority",
         "rationale", "source"},
        {"assignedTo"},
    ),
    "TaskMessage": ({"type", "ts", "vehicleId", "task"}, set()),
    "EnvelopeMessage": (
        {"type", "ts", "vehicleId", "state"},
        {"constraint", "margin_m", "action"},
    ),
    "ModeMessage": (
        {"type", "ts", "vehicleId", "mode", "since", "operatorPresent"}, set(),
    ),
    "EscalationMessage": (
        {"type", "ts", "vehicleId", "missionId", "channel", "payload"},
        {"deliveredAt"},
    ),
    "CctvEventMessage": (
        {"type", "ts", "vehicleId", "cameraId", "zone"},
        {"class", "thumbnail"},
    ),
    "Corridor": ({"legs", "orbits", "alt_band_m", "generated_from"}, set()),
    "CorridorLeg": ({"from", "to", "lateral_tol_m"}, set()),
    "CorridorOrbit": ({"center", "radius_m", "radial_tol_m"}, set()),
    "PlanTraceEntry": ({"rule", "effect"}, set()),
    "GimbalState": ({"pitchDeg"}, set()),
    "FleetSortie": ({"elapsed_s", "must_rtl_by"}, set()),
    "MissionRecord": (
        {"missionId", "vehicleId", "anomalyId", "plan", "verification",
         "startedAt", "mode", "planTrace", "envelopeEvents"},
        {"report", "endedAt", "task", "corridor", "handoffFrom"},
    ),
}


@pytest.mark.parametrize("name", sorted(EXPECTED_KEYS))
def test_typeddict_key_partitions(shared, name):
    required, optional = EXPECTED_KEYS[name]
    td = getattr(shared, name)
    assert set(td.__required_keys__) == required, f"{name} required keys drifted"
    assert set(td.__optional_keys__) == optional, f"{name} optional keys drifted"


def test_cue_freshness_fields_are_optional_on_anomaly(shared):
    """Undated satellite/SAR cues stay valid; the cue rails add freshness."""
    assert {"observedAt", "ttl_s", "cameraId"} <= set(shared.Anomaly.__optional_keys__)
    assert "source" in shared.Anomaly.__required_keys__


def test_plan_trace_and_corridor_are_optional_on_mission_plan(shared):
    """Both are optional for now -- the planner does not emit them yet."""
    assert {"planTrace", "corridor"} <= set(shared.MissionPlan.__optional_keys__)
    assert "holdUntil" in shared.Verification.__optional_keys__


def test_gimbal_is_optional_on_telemetry(shared):
    """An airframe with no commandable gimbal omits it rather than reporting 0."""
    assert "gimbal" in shared.Telemetry.__optional_keys__
    assert "controlSource" in shared.Telemetry.__required_keys__


def test_every_new_wire_message_carries_a_vehicle_id(shared):
    """Non-negotiable: every wire message and audit entry is attributable."""
    for name in ("TaskMessage", "EnvelopeMessage", "ModeMessage",
                 "EscalationMessage", "CctvEventMessage"):
        assert "vehicleId" in getattr(shared, name).__required_keys__, name
    assert "vehicleId" in shared.MissionRecord.__required_keys__


def test_task_carries_no_geometry_tools_or_altitudes(shared):
    """A task says WHAT to look for and WHY. The only geometry it may reference
    is anomalyId -- turning that into a route is the planner's job."""
    keys = set(shared.Task.__required_keys__) | set(shared.Task.__optional_keys__)
    forbidden = {"lat", "lon", "alt", "alt_m", "altitude", "tool", "tools",
                 "radius", "radius_m", "speed_mps", "profile", "mode",
                 "waypoints", "setpoint"}
    assert keys & forbidden == set()
    assert "anomalyId" in keys


def test_new_inbound_messages_are_in_the_inbound_union(shared):
    members = set(get_args(shared.InboundMessage))
    for name in ("TaskMessage", "EnvelopeMessage", "ModeMessage",
                 "EscalationMessage", "CctvEventMessage"):
        assert getattr(shared, name) in members, name
