"""
Attendance mode + UNATTENDED_ENVELOPE (control/mode.py) and its config floor.

What is actually being asserted:
  * unattended mode is reachable ONLY through a signed command,
  * an operator connecting reverts it immediately, with no command at all,
  * an operator merely DISCONNECTING never enters it,
  * every ADR D23 constraint refuses independently and by name, and
  * config.py's hard floors let YAML/env tighten the envelope and never widen
    it -- including the pathological cases (NaN, inversion, unknown profiles).
"""
from __future__ import annotations

import pytest

from eis_companion import config as config_mod
from eis_companion.config import load_config
from eis_companion.control import mode as mode_mod
from eis_companion.control.mode import (
    MODE_ATTENDED,
    MODE_UNATTENDED,
    AttendanceMachine,
    DispatchRequest,
    UnattendedEnvelope,
    canonical_profile,
    check_unattended,
    sorties_in_window,
)

HOUR_MS = 3_600_000


def ok_request(**overrides) -> DispatchRequest:
    """A dispatch that satisfies every UNATTENDED_ENVELOPE constraint."""
    base = dict(
        profile="inspect",
        altitude_m=40.0,
        laps=1.0,
        hold_s=15.0,
        inside_perimeter=True,
        nav_source="gps",
        rf_interference=False,
        hostile_drone=False,
        night=False,
        thermal_healthy=True,
        wind_mps=3.0,
        recent_sortie_starts_ms=(),
        now_ms=HOUR_MS * 10,
    )
    base.update(overrides)
    return DispatchRequest(**base)


# ==========================================================================
# The envelope (ADR D23)
# ==========================================================================
def test_a_conforming_dispatch_passes():
    assert check_unattended(ok_request()).ok


@pytest.mark.parametrize("overrides,expected", [
    ({"inside_perimeter": False}, "perimeter"),
    ({"profile": "survey"}, "profile"),
    ({"altitude_m": 25.0}, "altitude"),
    ({"altitude_m": 55.0}, "altitude"),
    ({"laps": 2.0}, "laps"),
    ({"hold_s": 20.0}, "hold"),
    ({"nav_source": "optflow"}, "navSource"),
    ({"rf_interference": True}, "RF interference"),
    ({"hostile_drone": True}, "hostile drone"),
    ({"night": True, "thermal_healthy": False}, "thermal"),
    ({"wind_mps": 7.0}, "wind"),
])
def test_each_constraint_refuses_by_name(overrides, expected):
    """A refusal has to say WHAT it refused: the operator reading the
    escalation is the whole point of naming the constraint."""
    check = check_unattended(ok_request(**overrides))
    assert not check.ok
    assert expected in check.reason


def test_the_sortie_rate_budget_is_two_per_hour():
    now = HOUR_MS * 10
    one = ok_request(recent_sortie_starts_ms=(now - 600_000,), now_ms=now)
    two = ok_request(
        recent_sortie_starts_ms=(now - 600_000, now - 1_200_000), now_ms=now
    )
    assert check_unattended(one).ok
    assert not check_unattended(two).ok
    assert "sorties already flown" in check_unattended(two).reason

    # A sortie older than the window no longer counts against the budget.
    aged = ok_request(
        recent_sortie_starts_ms=(now - 600_000, now - HOUR_MS - 1), now_ms=now
    )
    assert check_unattended(aged).ok


def test_every_violated_constraint_is_reported_not_just_the_first():
    """A partial reason invites a retry that fails again for the next reason."""
    check = check_unattended(ok_request(
        profile="survey", altitude_m=10.0, wind_mps=9.0, hostile_drone=True
    ))
    assert not check.ok
    assert len(check.violations) >= 4


def test_night_with_healthy_thermal_is_permitted():
    assert check_unattended(ok_request(night=True, thermal_healthy=True)).ok


def test_profile_aliases_resolve_to_canonical_names():
    assert canonical_profile("standard") == "inspect"
    assert canonical_profile("SLOW") == "follow"
    assert canonical_profile("fast") == "survey"
    assert canonical_profile("inspect") == "inspect"
    # The compatibility alias is accepted exactly like the canonical name.
    assert check_unattended(ok_request(profile="standard")).ok


def test_sorties_in_window_ignores_junk_and_the_future():
    now = HOUR_MS * 10
    assert sorties_in_window((now - 10, "junk", None, now + 10_000), now) == 1


# ==========================================================================
# The envelope may only be tightened
# ==========================================================================
def test_tightened_narrows_but_never_widens():
    env = UnattendedEnvelope().tightened(
        min_alt_m=35.0, max_alt_m=45.0, max_hold_s=10.0,
        max_sorties_per_hour=1, max_wind_mps=4.0, max_laps=1.0,
    )
    assert (env.min_alt_m, env.max_alt_m) == (35.0, 45.0)
    assert env.max_hold_s == 10.0 and env.max_sorties_per_hour == 1
    assert env.max_wind_mps == 4.0
    # 40 m is inside the hard band but outside the tightened one.
    assert not check_unattended(ok_request(altitude_m=32.0), env).ok
    assert check_unattended(ok_request(altitude_m=40.0, hold_s=5.0), env).ok


def test_a_request_to_widen_the_envelope_is_ignored():
    """The whole point of the floor: asking nicely for a wider envelope gets
    you the hard one, not the one you asked for."""
    env = UnattendedEnvelope().tightened(
        min_alt_m=5.0, max_alt_m=400.0, max_hold_s=600.0,
        max_sorties_per_hour=99, max_wind_mps=25.0, max_laps=10.0,
        profiles=["survey", "follow"],
    )
    assert env.min_alt_m == mode_mod.UNATTENDED_MIN_ALT_M
    assert env.max_alt_m == mode_mod.UNATTENDED_MAX_ALT_M
    assert env.max_hold_s == mode_mod.UNATTENDED_MAX_HOLD_S
    assert env.max_sorties_per_hour == mode_mod.UNATTENDED_MAX_SORTIES_PER_HOUR
    assert env.max_wind_mps == mode_mod.UNATTENDED_MAX_WIND_MPS
    assert env.max_laps == mode_mod.UNATTENDED_MAX_LAPS
    # An entirely out-of-set profile list falls back to the allowed set rather
    # than admitting survey.
    assert env.profiles == mode_mod.UNATTENDED_PROFILES
    assert env.require_inside_perimeter is True


# ==========================================================================
# The state machine
# ==========================================================================
def test_unsigned_entry_is_refused_and_is_itself_reportable():
    machine = AttendanceMachine(now_ms=0, operator_present=False)
    transition = machine.enter_unattended(signature_ok=False, now_ms=100)
    assert not transition.ok
    assert transition.refused_unsigned is True
    assert machine.mode == MODE_ATTENDED


def test_signed_entry_works_only_with_no_operator_connected():
    machine = AttendanceMachine(now_ms=0, operator_present=True)
    blocked = machine.enter_unattended(signature_ok=True, now_ms=100)
    assert not blocked.ok and machine.mode == MODE_ATTENDED

    machine.operator_disconnected(200)
    entered = machine.enter_unattended(
        signature_ok=True, now_ms=300, operator_id="op-7"
    )
    assert entered.ok and entered.changed
    assert machine.mode == MODE_UNATTENDED
    assert machine.since_ms == 300
    assert machine.operator_id == "op-7"


def test_operator_connect_reverts_immediately_and_needs_no_command():
    machine = AttendanceMachine(now_ms=0, operator_present=False)
    machine.enter_unattended(signature_ok=True, now_ms=100, operator_id="op-7")
    transition = machine.operator_connected(500)
    assert transition.changed
    assert machine.mode == MODE_ATTENDED
    assert machine.since_ms == 500
    assert machine.operator_present is True
    assert machine.operator_id == ""


def test_operator_disconnect_does_not_enter_unattended():
    """Losing the operator makes the vehicle unsupervised, not authorised."""
    machine = AttendanceMachine(now_ms=0, operator_present=True)
    machine.operator_disconnected(400)
    assert machine.mode == MODE_ATTENDED
    assert machine.operator_present is False


def test_exit_is_always_honoured_even_unsigned():
    """Reverting toward supervision is the safe direction, so a failed
    signature check records the fact and still reverts."""
    machine = AttendanceMachine(now_ms=0, operator_present=False)
    machine.enter_unattended(signature_ok=True, now_ms=100)
    transition = machine.exit_unattended(signature_ok=False, now_ms=200)
    assert transition.ok and transition.changed
    assert transition.refused_unsigned is True
    assert machine.mode == MODE_ATTENDED


def test_entry_is_idempotent_and_keeps_the_original_since():
    machine = AttendanceMachine(now_ms=0, operator_present=False)
    machine.enter_unattended(signature_ok=True, now_ms=100)
    again = machine.enter_unattended(signature_ok=True, now_ms=900)
    assert again.ok and not again.changed
    assert machine.since_ms == 100


def test_mode_message_matches_the_contract():
    machine = AttendanceMachine(now_ms=50, operator_present=True)
    message = machine.message("eis-2", 777)
    assert message == {
        "type": "mode", "ts": 777, "vehicleId": "eis-2",
        "mode": "attended", "since": 50, "operatorPresent": True,
    }


def test_dispatch_is_tagged_with_the_mode_in_force():
    machine = AttendanceMachine(now_ms=0, operator_present=False)
    assert machine.tag() == MODE_ATTENDED
    machine.enter_unattended(signature_ok=True, now_ms=10)
    assert machine.tag() == MODE_UNATTENDED


# ==========================================================================
# config.py mirrors the hard bounds and only ever tightens them
# ==========================================================================
def test_config_constants_mirror_the_pure_logic_owner():
    """config.py duplicates the D23 numbers so loading config stays a
    stdlib-only operation; this test is what keeps the two copies honest."""
    assert config_mod.UNATTENDED_MIN_ALT_FLOOR_M == mode_mod.UNATTENDED_MIN_ALT_M
    assert config_mod.UNATTENDED_MAX_ALT_CEIL_M == mode_mod.UNATTENDED_MAX_ALT_M
    assert config_mod.UNATTENDED_MAX_LAPS_CAP == mode_mod.UNATTENDED_MAX_LAPS
    assert config_mod.UNATTENDED_MAX_HOLD_CAP_S == mode_mod.UNATTENDED_MAX_HOLD_S
    assert (
        config_mod.UNATTENDED_MAX_SORTIES_PER_HOUR_CAP
        == mode_mod.UNATTENDED_MAX_SORTIES_PER_HOUR
    )
    assert config_mod.UNATTENDED_MAX_WIND_CAP_MPS == mode_mod.UNATTENDED_MAX_WIND_MPS
    assert config_mod.UNATTENDED_PROFILES_ALLOWED == mode_mod.UNATTENDED_PROFILES


def test_config_defaults_are_the_hard_envelope():
    cfg = load_config(None, use_dotenv=False, use_env=False)
    u = cfg.unattended
    assert (u.min_alt_m, u.max_alt_m) == (30.0, 50.0)
    assert u.max_laps == 1.0 and u.max_hold_s == 15.0
    assert u.max_sorties_per_hour == 2 and u.max_wind_mps == 6.0
    assert u.profiles == ("inspect",)


def test_yaml_may_tighten_the_unattended_envelope(tmp_path):
    p = tmp_path / "cfg.yaml"
    p.write_text(
        "unattended:\n"
        "  min_alt_m: 35\n"
        "  max_alt_m: 45\n"
        "  max_hold_s: 8\n"
        "  max_sorties_per_hour: 1\n"
        "  max_wind_mps: 4\n",
        encoding="utf-8",
    )
    u = load_config(str(p), use_dotenv=False, use_env=False).unattended
    assert (u.min_alt_m, u.max_alt_m) == (35.0, 45.0)
    assert u.max_hold_s == 8.0 and u.max_sorties_per_hour == 1
    assert u.max_wind_mps == 4.0


def test_yaml_may_not_widen_the_unattended_envelope(tmp_path):
    p = tmp_path / "cfg.yaml"
    p.write_text(
        "unattended:\n"
        "  min_alt_m: 5\n"
        "  max_alt_m: 400\n"
        "  max_laps: 10\n"
        "  max_hold_s: 600\n"
        "  max_sorties_per_hour: 50\n"
        "  max_wind_mps: 25\n"
        "  profiles: [survey, follow]\n",
        encoding="utf-8",
    )
    u = load_config(str(p), use_dotenv=False, use_env=False).unattended
    assert (u.min_alt_m, u.max_alt_m) == (30.0, 50.0)
    assert u.max_laps == 1.0 and u.max_hold_s == 15.0
    assert u.max_sorties_per_hour == 2 and u.max_wind_mps == 6.0
    assert u.profiles == ("inspect",)


def test_an_inverted_or_junk_band_collapses_to_the_hard_band(tmp_path):
    p = tmp_path / "cfg.yaml"
    p.write_text(
        "unattended:\n  min_alt_m: 49\n  max_alt_m: 31\n", encoding="utf-8"
    )
    u = load_config(str(p), use_dotenv=False, use_env=False).unattended
    assert (u.min_alt_m, u.max_alt_m) == (30.0, 50.0)


def test_env_may_tighten_the_unattended_envelope(monkeypatch):
    monkeypatch.setenv("EIS_UNATTENDED_MAX_WIND_MPS", "2")
    monkeypatch.setenv("EIS_UNATTENDED_MAX_ALT_M", "999")
    u = load_config(None, use_dotenv=False, use_env=True).unattended
    assert u.max_wind_mps == 2.0
    assert u.max_alt_m == 50.0          # the widening attempt is ignored
