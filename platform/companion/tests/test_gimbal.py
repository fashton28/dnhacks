"""
Gimbal pointing (control/gimbal.py) + its config floor.

Covers the three things that can hurt:
  * the clamp -- -30..90 deg, narrowable by config, never widenable,
  * the slew limit -- a step command never teleports the mount, and a
    rate-limited approach can never walk outside the envelope, and
  * auto-pointing -- pure geometry, identical inputs give identical angles,
    with no model, plan field or wire message able to select the angle.
"""
from __future__ import annotations

import math

import pytest

from eis_companion.config import load_config
from eis_companion.control.gimbal import (
    GIMBAL_PITCH_MAX_DEG,
    GIMBAL_PITCH_MIN_DEG,
    GimbalController,
    GimbalLimits,
    auto_pitch_from_ground_deg,
    auto_pitch_from_slant_deg,
    clamp_pitch,
    slant_range_m,
    slew,
)

WIDE = GimbalLimits()
NARROW = GimbalLimits(min_pitch_deg=0.0, max_pitch_deg=60.0, slew_rate_dps=30.0)


# ==========================================================================
# Clamp
# ==========================================================================
@pytest.mark.parametrize("requested,expected", [
    (0.0, 0.0), (45.0, 45.0), (-30.0, -30.0), (90.0, 90.0),
    (-120.0, -30.0), (180.0, 90.0),
])
def test_clamp_holds_the_mechanical_envelope(requested, expected):
    assert clamp_pitch(requested, WIDE) == expected


@pytest.mark.parametrize("junk", [float("nan"), float("inf"), None, "down"])
def test_junk_pitch_degrades_to_level_not_to_an_arbitrary_angle(junk):
    assert clamp_pitch(junk, WIDE) == 0.0


def test_config_may_narrow_the_travel_but_never_widen_it():
    assert clamp_pitch(90.0, NARROW) == 60.0
    assert clamp_pitch(-30.0, NARROW) == 0.0
    # A limits object asking for more travel than the mount has gets the mount.
    absurd = GimbalLimits(min_pitch_deg=-180.0, max_pitch_deg=270.0)
    assert clamp_pitch(-180.0, absurd) == GIMBAL_PITCH_MIN_DEG
    assert clamp_pitch(270.0, absurd) == GIMBAL_PITCH_MAX_DEG


# ==========================================================================
# Slew
# ==========================================================================
def test_slew_is_rate_limited_in_both_directions():
    limits = GimbalLimits(slew_rate_dps=30.0)
    assert slew(0.0, 90.0, 0.5, limits) == pytest.approx(15.0)
    assert slew(90.0, 0.0, 0.5, limits) == pytest.approx(75.0)


def test_slew_arrives_exactly_when_the_step_covers_the_gap():
    assert slew(0.0, 10.0, 1.0, GimbalLimits(slew_rate_dps=30.0)) == 10.0


def test_slew_with_no_time_or_no_rate_does_not_move():
    assert slew(10.0, 90.0, 0.0, GimbalLimits(slew_rate_dps=30.0)) == 10.0
    assert slew(10.0, 90.0, 1.0, GimbalLimits(slew_rate_dps=0.0)) == 10.0
    assert slew(10.0, 90.0, float("nan"), GimbalLimits()) == 10.0


def test_slew_toward_an_out_of_range_target_stays_inside_the_envelope():
    for _ in range(200):
        assert -30.0 <= slew(0.0, 500.0, 1.0, WIDE) <= 90.0


# ==========================================================================
# Auto-pointing: pure geometry, no model anywhere near it
# ==========================================================================
def test_slant_geometry_matches_asin_altitude_over_range():
    assert auto_pitch_from_slant_deg(100.0, 50.0) == pytest.approx(30.0)
    assert auto_pitch_from_slant_deg(100.0, 100.0) == pytest.approx(90.0)
    assert auto_pitch_from_slant_deg(100.0, 0.0) == pytest.approx(0.0)


def test_ground_geometry_matches_atan2_altitude_over_distance():
    assert auto_pitch_from_ground_deg(40.0, 40.0) == pytest.approx(45.0)
    assert auto_pitch_from_ground_deg(0.0, 40.0) == pytest.approx(90.0)
    assert auto_pitch_from_ground_deg(40.0, 0.0) == pytest.approx(0.0)


def test_the_two_forms_agree_through_the_slant_range():
    ground, alt = 30.0, 40.0
    slant = slant_range_m(ground, alt)
    assert slant == pytest.approx(50.0)
    assert auto_pitch_from_slant_deg(slant, alt) == pytest.approx(
        auto_pitch_from_ground_deg(ground, alt)
    )


def test_auto_pointing_is_deterministic():
    """The same geometry always yields the same angle -- what makes a recorded
    observation replayable."""
    angles = {auto_pitch_from_ground_deg(35.0, 42.0) for _ in range(50)}
    assert len(angles) == 1


@pytest.mark.parametrize("args", [
    (0.0, 50.0),                 # zero slant range is not a real observation
    (float("nan"), 50.0),
    (100.0, float("inf")),
    (None, 50.0),
])
def test_nonsensical_geometry_stows_rather_than_guessing(args):
    assert auto_pitch_from_slant_deg(*args) == 0.0


def test_impossible_geometry_saturates_instead_of_raising():
    """Altitude greater than slant range cannot happen; saturating at straight
    down beats a domain error in a 20 Hz loop."""
    assert auto_pitch_from_slant_deg(10.0, 50.0) == pytest.approx(90.0)


# ==========================================================================
# The controller: override beats auto, and a new leg clears the override
# ==========================================================================
def test_controller_slews_toward_the_auto_target():
    gimbal = GimbalController(GimbalLimits(slew_rate_dps=30.0))
    gimbal.set_auto_target(60.0)
    assert gimbal.update(0.5) == pytest.approx(15.0)
    assert gimbal.update(0.5) == pytest.approx(30.0)
    for _ in range(10):
        gimbal.update(0.5)
    assert gimbal.commanded_pitch_deg == pytest.approx(60.0)


def test_operator_override_beats_auto_pointing_until_the_next_leg():
    gimbal = GimbalController(GimbalLimits(slew_rate_dps=1000.0))
    gimbal.set_auto_target(60.0)
    gimbal.set_override(10.0)
    assert gimbal.override_active
    assert gimbal.update(1.0) == pytest.approx(10.0)

    gimbal.set_auto_target(60.0)          # auto keeps proposing; override wins
    assert gimbal.update(1.0) == pytest.approx(10.0)

    gimbal.clear_override()               # a new leg begins
    assert gimbal.update(1.0) == pytest.approx(60.0)


def test_a_signed_override_is_still_clamped():
    """A valid signature buys the right to ASK, not travel past the mount."""
    gimbal = GimbalController(NARROW)
    assert gimbal.set_override(500.0) == 60.0
    assert gimbal.set_override(-90.0) == 0.0


def test_point_at_uses_the_ground_distance_and_our_altitude():
    gimbal = GimbalController(GimbalLimits(slew_rate_dps=1000.0))
    target = gimbal.point_at(ground_distance_m=40.0, altitude_agl_m=40.0)
    assert target == pytest.approx(45.0)
    assert gimbal.update(1.0) == pytest.approx(45.0)


def test_reset_stows_and_drops_everything():
    gimbal = GimbalController(GimbalLimits(slew_rate_dps=1000.0))
    gimbal.set_override(45.0)
    gimbal.reset()
    assert not gimbal.override_active
    assert gimbal.commanded_pitch_deg == 0.0
    assert gimbal.update(1.0) == 0.0


# ==========================================================================
# config floor
# ==========================================================================
def test_config_defaults_are_the_contract_envelope():
    g = load_config(None, use_dotenv=False, use_env=False).gimbal
    assert (g.pitch_min_deg, g.pitch_max_deg) == (GIMBAL_PITCH_MIN_DEG,
                                                  GIMBAL_PITCH_MAX_DEG)
    assert g.enabled is True
    assert g.use_gimbal_manager is False


def test_yaml_may_narrow_the_gimbal_envelope(tmp_path):
    p = tmp_path / "cfg.yaml"
    p.write_text(
        "gimbal:\n  pitch_min_deg: 0\n  pitch_max_deg: 60\n"
        "  slew_rate_dps: 10\n  use_gimbal_manager: true\n",
        encoding="utf-8",
    )
    g = load_config(str(p), use_dotenv=False, use_env=False).gimbal
    assert (g.pitch_min_deg, g.pitch_max_deg) == (0.0, 60.0)
    assert g.slew_rate_dps == 10.0
    assert g.use_gimbal_manager is True


def test_yaml_may_not_widen_the_gimbal_envelope(tmp_path):
    p = tmp_path / "cfg.yaml"
    p.write_text(
        "gimbal:\n  pitch_min_deg: -180\n  pitch_max_deg: 270\n"
        "  slew_rate_dps: 5000\n",
        encoding="utf-8",
    )
    g = load_config(str(p), use_dotenv=False, use_env=False).gimbal
    assert g.pitch_min_deg == GIMBAL_PITCH_MIN_DEG
    assert g.pitch_max_deg == GIMBAL_PITCH_MAX_DEG
    assert g.slew_rate_dps <= 90.0


def test_an_inverted_gimbal_band_collapses_to_the_hard_band(tmp_path):
    p = tmp_path / "cfg.yaml"
    p.write_text("gimbal:\n  pitch_min_deg: 80\n  pitch_max_deg: 10\n",
                 encoding="utf-8")
    g = load_config(str(p), use_dotenv=False, use_env=False).gimbal
    assert (g.pitch_min_deg, g.pitch_max_deg) == (GIMBAL_PITCH_MIN_DEG,
                                                  GIMBAL_PITCH_MAX_DEG)


def test_env_overrides_are_clamped_too(monkeypatch):
    monkeypatch.setenv("EIS_GIMBAL_PITCH_MAX_DEG", "500")
    monkeypatch.setenv("EIS_GIMBAL_MANAGER", "true")
    g = load_config(None, use_dotenv=False, use_env=True).gimbal
    assert g.pitch_max_deg == GIMBAL_PITCH_MAX_DEG
    assert g.use_gimbal_manager is True


def test_shared_contract_constants_match_the_control_module():
    """shared/shared.py is the wire authority for the pitch envelope; the pure
    module must agree with it or the UI and the mount disagree by 120 deg."""
    import importlib.util
    import sys
    from pathlib import Path

    shared_py = Path(__file__).resolve().parents[2] / "shared" / "shared.py"
    spec = importlib.util.spec_from_file_location("_shared_for_gimbal", shared_py)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module     # @dataclass needs __module__ resolvable
    spec.loader.exec_module(module)
    assert module.GIMBAL_PITCH_MIN_DEG == GIMBAL_PITCH_MIN_DEG
    assert module.GIMBAL_PITCH_MAX_DEG == GIMBAL_PITCH_MAX_DEG
    assert math.isfinite(GIMBAL_PITCH_MIN_DEG)
