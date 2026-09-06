"""The safety floor: config layers may tighten the envelope, never widen it.

`config.py` re-asserts the hard envelope AFTER YAML and after the environment,
so these tests all take the same shape: ask for something dangerous through
one layer, then assert the loader handed back the conservative value anyway.
The numbers are the documented ones (standoff floor 3 m and ceiling 50 m,
max speed 8 m/s, sortie 480 s, dispatch SoC 80 %, the ADR D21/D22 envelope
monitor and the ADR D23 unattended envelope) -- if one of them moves, this
file is where the move has to be argued for.
"""
from __future__ import annotations

import os

import pytest

from eis_companion.config import (
    ENVELOPE_ESCALATE_CAP_S,
    ENVELOPE_GEOFENCE_MARGIN_FLOOR_M,
    ENVELOPE_NFZ_BUFFER_FLOOR_M,
    ENVELOPE_PEER_HOLD_CAP_S,
    ENVELOPE_PEER_STALE_CAP_S,
    ENVELOPE_SEPARATION_FLOOR_M,
    ENVELOPE_SEPARATION_STALE_FLOOR_M,
    GIMBAL_PITCH_MAX_DEG,
    GIMBAL_PITCH_MIN_DEG,
    MAX_SPEED_CAP,
    MAX_STANDOFF_CEIL_M,
    MIN_STANDOFF_FLOOR,
    UNATTENDED_MAX_ALT_CEIL_M,
    UNATTENDED_MAX_HOLD_CAP_S,
    UNATTENDED_MAX_LAPS_CAP,
    UNATTENDED_MAX_SORTIES_PER_HOUR_CAP,
    UNATTENDED_MAX_WIND_CAP_MPS,
    UNATTENDED_MIN_ALT_FLOOR_M,
    UNATTENDED_PROFILES_ALLOWED,
    load_config,
)


@pytest.fixture()
def clean_env(monkeypatch):
    for name in list(os.environ):
        if name.startswith("EIS_") or name == "DEMO_CHARGE_SCALE":
            monkeypatch.delenv(name, raising=False)
    return monkeypatch


def from_yaml(tmp_path, text):
    p = tmp_path / "cfg.yaml"
    p.write_text(text, encoding="utf-8")
    return load_config(str(p), use_dotenv=False, use_env=False)


# ==========================================================================
# Speed and standoff -- the two limits guidance servos against
# ==========================================================================
def test_yaml_cannot_raise_the_speed_cap(tmp_path, clean_env):
    cfg = from_yaml(tmp_path, "limits:\n  max_speed: 50\n")
    assert cfg.limits.max_speed == MAX_SPEED_CAP


def test_env_cannot_raise_the_speed_cap(clean_env):
    clean_env.setenv("EIS_MAX_SPEED_MPS", "999")
    assert load_config(None, use_dotenv=False, use_env=True).limits.max_speed == MAX_SPEED_CAP


def test_the_speed_band_cannot_invert(tmp_path, clean_env):
    cfg = from_yaml(tmp_path, "limits:\n  max_speed: 1.0\n  min_speed: 9.0\n")
    assert cfg.limits.max_speed == 1.0
    assert cfg.limits.min_speed <= cfg.limits.max_speed


def test_a_zero_speed_cap_is_not_accepted(tmp_path, clean_env):
    assert from_yaml(tmp_path, "limits:\n  max_speed: 0\n").limits.max_speed > 0.0


def test_standoff_cannot_be_pushed_under_the_floor(tmp_path, clean_env):
    cfg = from_yaml(tmp_path, "limits:\n  standoff: 0.5\n  min_standoff: 0.1\n")
    assert cfg.limits.min_standoff == MIN_STANDOFF_FLOOR
    assert cfg.limits.standoff == MIN_STANDOFF_FLOOR


def test_env_cannot_push_standoff_under_the_floor(clean_env):
    clean_env.setenv("EIS_STANDOFF_M", "0.25")
    assert load_config(None, use_dotenv=False, use_env=True).limits.standoff == MIN_STANDOFF_FLOOR


def test_standoff_is_a_band_closed_at_the_top_too(tmp_path, clean_env):
    """FM-11: an unbounded standoff commands sustained full-speed RETREAT."""
    cfg = from_yaml(tmp_path, "limits:\n  standoff: 900\n  max_standoff: 5000\n")
    assert cfg.limits.max_standoff == MAX_STANDOFF_CEIL_M
    assert cfg.limits.standoff == MAX_STANDOFF_CEIL_M


def test_the_standoff_band_stays_ordered(tmp_path, clean_env):
    cfg = from_yaml(tmp_path, "limits:\n  min_standoff: 20\n  max_standoff: 6\n  standoff: 4\n")
    assert cfg.limits.min_standoff <= cfg.limits.max_standoff
    assert cfg.limits.min_standoff <= cfg.limits.standoff <= cfg.limits.max_standoff


def test_a_non_finite_limit_degrades_to_the_conservative_end(tmp_path, clean_env):
    cfg = from_yaml(
        tmp_path,
        "limits:\n  max_speed: .inf\n  max_altitude: .inf\n  standoff: .nan\n",
    )
    assert cfg.limits.max_speed <= MAX_SPEED_CAP
    assert cfg.limits.max_altitude < float("inf")
    assert cfg.limits.standoff >= MIN_STANDOFF_FLOOR


# ==========================================================================
# Watchdogs, altitude, geofence
# ==========================================================================
def test_watchdogs_cannot_be_disabled(tmp_path, clean_env):
    cfg = from_yaml(
        tmp_path,
        "limits:\n  manual_watchdog_ms: 0\n  ground_link_timeout_ms: 0\n",
    )
    assert cfg.limits.manual_watchdog_ms >= 50
    assert cfg.limits.ground_link_timeout_ms >= 200


def test_altitude_climb_and_yaw_stay_positive(tmp_path, clean_env):
    cfg = from_yaml(
        tmp_path,
        "limits:\n  max_altitude: 0\n  max_climb_rate: -3\n  max_yaw_rate: 0\n",
    )
    assert cfg.limits.max_altitude > 0.0
    assert cfg.limits.max_climb_rate > 0.0
    assert cfg.limits.max_yaw_rate > 0.0


def test_the_geofence_cannot_collapse(tmp_path, clean_env):
    assert from_yaml(tmp_path, "safety:\n  geofence_radius_m: 0.5\n").safety.geofence_radius_m >= 10.0


# ==========================================================================
# Battery / dispatch gates
# ==========================================================================
def test_battery_gates_may_only_be_tightened(tmp_path, clean_env):
    wide = from_yaml(
        tmp_path,
        "battery:\n  max_sortie_s: 99999\n  dispatch_min_soc_pct: 5\n"
        "  cell_imbalance_max_v: 9\n  batt_temp_max_c: 900\n",
    )
    assert wide.battery.max_sortie_s == 480.0
    assert wide.battery.dispatch_min_soc_pct == 80.0
    assert wide.battery.cell_imbalance_max_v == pytest.approx(0.10)
    assert wide.battery.batt_temp_max_c == 60.0


def test_battery_gates_accept_a_stricter_setting(tmp_path, clean_env):
    tight = from_yaml(
        tmp_path,
        "battery:\n  max_sortie_s: 240\n  dispatch_min_soc_pct: 95\n"
        "  cell_imbalance_max_v: 0.04\n  batt_temp_max_c: 45\n",
    )
    assert tight.battery.max_sortie_s == 240.0
    assert tight.battery.dispatch_min_soc_pct == 95.0
    assert tight.battery.cell_imbalance_max_v == pytest.approx(0.04)
    assert tight.battery.batt_temp_max_c == 45.0


def test_env_cannot_widen_the_battery_gates(clean_env):
    clean_env.setenv("EIS_MAX_SORTIE_S", "100000")
    clean_env.setenv("EIS_DISPATCH_MIN_SOC_PCT", "1")
    cfg = load_config(None, use_dotenv=False, use_env=True)
    assert cfg.battery.max_sortie_s == 480.0
    assert cfg.battery.dispatch_min_soc_pct == 80.0


# ==========================================================================
# Planner profile speeds
# ==========================================================================
def test_every_profile_speed_is_capped(tmp_path, clean_env):
    cfg = from_yaml(
        tmp_path,
        "planner:\n  profile_speed_mps: {follow: 99, survey: -4, extra: 3.0}\n",
    )
    speeds = cfg.planner.profile_speed_mps
    assert speeds["follow"] == MAX_SPEED_CAP
    assert speeds["survey"] == 0.0            # negative collapses to no motion
    assert speeds["extra"] == 3.0             # an unknown profile is still capped
    assert all(0.0 <= v <= MAX_SPEED_CAP for v in speeds.values())


def test_a_malformed_profile_speed_keeps_the_shared_default(tmp_path, clean_env):
    cfg = from_yaml(tmp_path, "planner:\n  profile_speed_mps: {inspect: fast}\n")
    assert cfg.planner.profile_speed_mps["inspect"] == 4.0


def test_planner_radii_cannot_collapse(tmp_path, clean_env):
    cfg = from_yaml(
        tmp_path,
        "planner:\n  arrival_radius_m: 0\n  staging_arrival_radius_m: 0\n"
        "  heartbeat_timeout_ms: 1\n",
    )
    assert cfg.planner.arrival_radius_m >= 0.5
    assert cfg.planner.staging_arrival_radius_m >= 1.0
    assert cfg.planner.heartbeat_timeout_ms >= 200


# ==========================================================================
# Runtime envelope monitor (ADR D21 / D22) -- stricter only, never off
# ==========================================================================
def test_the_envelope_monitor_cannot_be_relaxed(tmp_path, clean_env):
    cfg = from_yaml(
        tmp_path,
        "envelope:\n  separation_m: 1\n  separation_stale_m: 2\n  peer_stale_s: 99\n"
        "  peer_hold_s: 99\n  escalate_after_s: 99\n  geofence_margin_m: 0\n"
        "  nfz_buffer_m: 0\n  breach_multiple: 99\n",
    )
    e = cfg.envelope
    assert e.separation_m == ENVELOPE_SEPARATION_FLOOR_M
    assert e.separation_stale_m == ENVELOPE_SEPARATION_STALE_FLOOR_M
    assert e.peer_stale_s == ENVELOPE_PEER_STALE_CAP_S
    assert e.peer_hold_s == ENVELOPE_PEER_HOLD_CAP_S
    assert e.escalate_after_s == ENVELOPE_ESCALATE_CAP_S
    assert e.geofence_margin_m == ENVELOPE_GEOFENCE_MARGIN_FLOOR_M
    assert e.nfz_buffer_m == ENVELOPE_NFZ_BUFFER_FLOOR_M
    assert e.breach_multiple <= 2.0


def test_the_envelope_monitor_accepts_a_stricter_setting(tmp_path, clean_env):
    cfg = from_yaml(
        tmp_path,
        "envelope:\n  separation_m: 60\n  separation_stale_m: 120\n  peer_stale_s: 1\n"
        "  peer_hold_s: 4\n  escalate_after_s: 2\n  geofence_margin_m: 12\n"
        "  nfz_buffer_m: 40\n",
    )
    e = cfg.envelope
    assert (e.separation_m, e.separation_stale_m) == (60.0, 120.0)
    assert (e.peer_stale_s, e.peer_hold_s, e.escalate_after_s) == (1.0, 4.0, 2.0)
    assert (e.geofence_margin_m, e.nfz_buffer_m) == (12.0, 40.0)


def test_the_stale_separation_never_falls_below_the_nominal_one(tmp_path, clean_env):
    cfg = from_yaml(tmp_path, "envelope:\n  separation_m: 150\n  separation_stale_m: 90\n")
    assert cfg.envelope.separation_stale_m >= cfg.envelope.separation_m


def test_the_peer_hold_never_precedes_the_stale_threshold(tmp_path, clean_env):
    cfg = from_yaml(tmp_path, "envelope:\n  peer_stale_s: 3\n  peer_hold_s: 0.5\n")
    assert cfg.envelope.peer_hold_s >= cfg.envelope.peer_stale_s


def test_the_monitor_has_no_off_switch(tmp_path, clean_env):
    cfg = from_yaml(tmp_path, "envelope:\n  hz: 0\n  publish_hz: 0\n")
    assert cfg.envelope.hz >= 1.0
    assert cfg.envelope.publish_hz >= 0.5


def test_the_monitor_never_publishes_faster_than_it_ticks(tmp_path, clean_env):
    cfg = from_yaml(tmp_path, "envelope:\n  hz: 10\n  publish_hz: 99\n")
    assert cfg.envelope.publish_hz <= cfg.envelope.hz


def test_env_cannot_relax_the_envelope_monitor(clean_env):
    clean_env.setenv("EIS_ENVELOPE_SEPARATION_M", "1")
    clean_env.setenv("EIS_ENVELOPE_PEER_STALE_S", "60")
    clean_env.setenv("EIS_ENVELOPE_NFZ_BUFFER_M", "0")
    e = load_config(None, use_dotenv=False, use_env=True).envelope
    assert e.separation_m == ENVELOPE_SEPARATION_FLOOR_M
    assert e.peer_stale_s == ENVELOPE_PEER_STALE_CAP_S
    assert e.nfz_buffer_m == ENVELOPE_NFZ_BUFFER_FLOOR_M


# ==========================================================================
# UNATTENDED_ENVELOPE (ADR D23)
# ==========================================================================
def test_the_unattended_envelope_cannot_be_widened(tmp_path, clean_env):
    u = from_yaml(
        tmp_path,
        "unattended:\n  min_alt_m: 2\n  max_alt_m: 400\n  max_laps: 20\n"
        "  max_hold_s: 900\n  max_sorties_per_hour: 40\n  max_wind_mps: 30\n"
        "  profiles: [survey, follow, inspect]\n",
    ).unattended
    assert u.min_alt_m == UNATTENDED_MIN_ALT_FLOOR_M
    assert u.max_alt_m == UNATTENDED_MAX_ALT_CEIL_M
    assert u.max_laps == UNATTENDED_MAX_LAPS_CAP
    assert u.max_hold_s == UNATTENDED_MAX_HOLD_CAP_S
    assert u.max_sorties_per_hour == UNATTENDED_MAX_SORTIES_PER_HOUR_CAP
    assert u.max_wind_mps == UNATTENDED_MAX_WIND_CAP_MPS
    assert u.profiles == UNATTENDED_PROFILES_ALLOWED


def test_an_unknown_profile_list_falls_back_to_the_allowed_set(tmp_path, clean_env):
    u = from_yaml(tmp_path, "unattended:\n  profiles: [survey, follow]\n").unattended
    assert u.profiles == UNATTENDED_PROFILES_ALLOWED


def test_an_inverted_unattended_band_collapses_to_the_hard_band(tmp_path, clean_env):
    u = from_yaml(tmp_path, "unattended:\n  min_alt_m: 48\n  max_alt_m: 32\n").unattended
    assert (u.min_alt_m, u.max_alt_m) == (UNATTENDED_MIN_ALT_FLOOR_M, UNATTENDED_MAX_ALT_CEIL_M)


def test_env_may_tighten_but_not_widen_the_unattended_envelope(clean_env):
    clean_env.setenv("EIS_UNATTENDED_MAX_WIND_MPS", "3")
    clean_env.setenv("EIS_UNATTENDED_MAX_ALT_M", "999")
    clean_env.setenv("EIS_UNATTENDED_MAX_SORTIES_PER_HOUR", "99")
    u = load_config(None, use_dotenv=False, use_env=True).unattended
    assert u.max_wind_mps == 3.0
    assert u.max_alt_m == UNATTENDED_MAX_ALT_CEIL_M
    assert u.max_sorties_per_hour == UNATTENDED_MAX_SORTIES_PER_HOUR_CAP


# ==========================================================================
# Gimbal travel + the command replay window
# ==========================================================================
def test_gimbal_travel_cannot_be_widened(tmp_path, clean_env):
    g = from_yaml(
        tmp_path,
        "gimbal:\n  pitch_min_deg: -120\n  pitch_max_deg: 200\n  slew_rate_dps: 900\n",
    ).gimbal
    assert g.pitch_min_deg == GIMBAL_PITCH_MIN_DEG
    assert g.pitch_max_deg == GIMBAL_PITCH_MAX_DEG
    assert g.slew_rate_dps <= 90.0


def test_gimbal_travel_may_be_narrowed(tmp_path, clean_env):
    g = from_yaml(tmp_path, "gimbal:\n  pitch_min_deg: 0\n  pitch_max_deg: 45\n").gimbal
    assert (g.pitch_min_deg, g.pitch_max_deg) == (0.0, 45.0)


def test_an_inverted_gimbal_band_collapses_to_the_mechanical_one(tmp_path, clean_env):
    g = from_yaml(tmp_path, "gimbal:\n  pitch_min_deg: 70\n  pitch_max_deg: 10\n").gimbal
    assert (g.pitch_min_deg, g.pitch_max_deg) == (GIMBAL_PITCH_MIN_DEG, GIMBAL_PITCH_MAX_DEG)


def test_the_command_replay_window_is_bounded_at_both_ends(tmp_path, clean_env):
    wide = from_yaml(tmp_path, "security:\n  max_command_age_ms: 999999999\n")
    narrow = from_yaml(tmp_path, "security:\n  max_command_age_ms: 1\n")
    assert wide.security.max_command_age_ms == 300_000
    assert narrow.security.max_command_age_ms == 1_000


# ==========================================================================
# Identity + the bind/authentication pairing (FM-40)
# ==========================================================================
def test_blank_identities_fall_back_to_their_documented_defaults(tmp_path, clean_env):
    cfg = from_yaml(
        tmp_path,
        "vehicle_id: '   '\nsecurity:\n  session_key_env: '  '\nnetwork:\n  host: '  '\n",
    )
    assert cfg.vehicle_id == "eis-1"
    assert cfg.security.session_key_env == "EIS_SESSION_KEY"
    assert cfg.network.host == "127.0.0.1"


def test_a_loopback_bind_does_not_force_signing(tmp_path, clean_env):
    cfg = from_yaml(tmp_path, "network:\n  host: localhost\n")
    assert cfg.security.require_signed_commands is False


@pytest.mark.parametrize("host", ["0.0.0.0", "192.168.1.42", "::"])
def test_opening_the_socket_forces_signed_commands(host, tmp_path, clean_env):
    cfg = from_yaml(
        tmp_path,
        f"network:\n  host: '{host}'\nsecurity:\n  require_signed_commands: false\n",
    )
    assert cfg.network.host == host
    assert cfg.security.require_signed_commands is True


def test_bind_all_env_forces_signed_commands(clean_env):
    clean_env.setenv("EIS_BIND_ALL", "true")
    clean_env.setenv("EIS_REQUIRE_SIGNED_COMMANDS", "false")
    cfg = load_config(None, use_dotenv=False, use_env=True)
    assert cfg.network.host == "0.0.0.0"
    assert cfg.security.require_signed_commands is True
