"""Configuration layering: defaults -> YAML -> environment.

The loader is table driven (config.SETTINGS), so these tests pin the two
things a table can get wrong and a hand-written loader cannot: a row that
names a field nothing owns, and a row whose environment override is declared
but never actually applied. The rest pins the documented precedence -- a
later layer wins, a blank or unreadable override does not, and an exported
variable always beats a .env file.
"""
from __future__ import annotations

import dataclasses
import os
from pathlib import Path

import pytest

from eis_companion import config as config_mod
from eis_companion.config import (
    BOUNDS,
    SETTINGS,
    AppConfig,
    load_config,
)

CONFIG_DIR = Path(config_mod.__file__).resolve().parents[2] / "config"


@pytest.fixture()
def clean_env(monkeypatch):
    """A process environment with every EIS_* knob removed."""
    for name in list(os.environ):
        if name.startswith("EIS_") or name == "DEMO_CHARGE_SCALE":
            monkeypatch.delenv(name, raising=False)
    return monkeypatch


def _read(cfg: AppConfig, path: str):
    node = cfg
    for part in path.split("."):
        node = getattr(node, part)
    return node


# ==========================================================================
# The tables themselves
# ==========================================================================
def test_every_setting_names_a_real_field():
    cfg = AppConfig()
    for setting in SETTINGS:
        _read(cfg, setting.path)          # raises AttributeError if it drifted


def test_every_bound_names_a_real_field_and_an_earlier_reference():
    cfg = AppConfig()
    seen = []
    for bound in BOUNDS:
        _read(cfg, bound.path)
        for ref in (bound.lo_ref, bound.hi_ref):
            if ref:
                assert ref in seen, f"{bound.path} references {ref} before it is bounded"
        seen.append(bound.path)


def test_env_names_are_unique_and_prefixed():
    declared = [s.env for s in SETTINGS if s.env]
    assert len(declared) == len(set(declared))
    for name in declared:
        assert name.startswith("EIS_") or name == "DEMO_CHARGE_SCALE"


def test_documented_env_names_are_all_wired(clean_env):
    """Every override in .env.example still reaches the config it documents."""
    documented = {
        "EIS_SITL", "EIS_CONTROL_PORT", "EIS_VIDEO_URL", "EIS_FC_CONNECTION",
        "EIS_FC_BAUD", "EIS_MAVLINK_SYSID", "EIS_GCS_SYSID", "EIS_CAMERA_SOURCE",
        "EIS_CAMERA_DEVICE", "EIS_CAMERA_WIDTH", "EIS_CAMERA_HEIGHT",
        "EIS_CAMERA_FPS", "EIS_MODEL_PATH", "EIS_ENGINE_PATH", "EIS_DETECT_CONF",
        "EIS_VIDEO_PORT", "EIS_VIDEO_BITRATE", "EIS_WEBRTC_PORT", "EIS_STANDOFF_M",
        "EIS_MAX_SPEED_MPS", "EIS_MAX_ALT_M", "EIS_GEOFENCE_RADIUS_M",
    }
    wired = {s.env for s in SETTINGS if s.env}
    assert documented <= wired


# ==========================================================================
# Precedence
# ==========================================================================
def test_defaults_apply_when_no_yaml_and_no_env(clean_env):
    cfg = load_config("does/not/exist.yaml", use_dotenv=False, use_env=False)
    assert cfg.source_path is None
    assert cfg.limits.max_speed == 2.0
    assert cfg.limits.standoff == 5.0
    assert cfg.network.control_port == 8765
    assert cfg.vehicle_id == "eis-1"


def test_yaml_overrides_the_defaults(tmp_path, clean_env):
    p = tmp_path / "cfg.yaml"
    p.write_text(
        "vehicle_id: eis-7\n"
        "limits:\n  max_speed: 1.25\n"
        "camera:\n  source: v4l2\n  fps: 15\n"
        "fc:\n  connection: tcp:10.0.0.9:5760\n",
        encoding="utf-8",
    )
    cfg = load_config(str(p), use_dotenv=False, use_env=False)
    assert cfg.source_path == str(p)
    assert cfg.vehicle_id == "eis-7"
    assert cfg.limits.max_speed == 1.25
    assert cfg.camera.source == "v4l2"
    assert cfg.camera.fps == 15
    assert cfg.fc.connection == "tcp:10.0.0.9:5760"
    # untouched keys keep the default, not whatever the section omitted
    assert cfg.camera.width == 1280
    assert cfg.limits.min_speed == 0.5


def test_env_overrides_the_yaml(tmp_path, clean_env):
    p = tmp_path / "cfg.yaml"
    p.write_text("limits:\n  max_speed: 1.0\ncamera:\n  source: csi\n", encoding="utf-8")
    clean_env.setenv("EIS_MAX_SPEED_MPS", "2.5")
    clean_env.setenv("EIS_CAMERA_SOURCE", "sim")
    cfg = load_config(str(p), use_dotenv=False, use_env=True)
    assert cfg.limits.max_speed == 2.5
    assert cfg.camera.source == "sim"


def test_use_env_false_leaves_the_yaml_alone(tmp_path, clean_env):
    p = tmp_path / "cfg.yaml"
    p.write_text("limits:\n  max_speed: 1.0\n", encoding="utf-8")
    clean_env.setenv("EIS_MAX_SPEED_MPS", "2.5")
    assert load_config(str(p), use_dotenv=False, use_env=False).limits.max_speed == 1.0


def test_blank_env_is_not_an_override(clean_env):
    clean_env.setenv("EIS_VIDEO_URL", "   ")
    clean_env.setenv("EIS_VEHICLE_ID", "")
    clean_env.setenv("EIS_CAMERA_SOURCE", "\t")
    cfg = load_config(None, use_dotenv=False, use_env=True)
    assert cfg.network.video_url == ""
    assert cfg.vehicle_id == "eis-1"
    assert cfg.camera.source == "csi"


def test_unparseable_env_is_not_an_override(clean_env):
    clean_env.setenv("EIS_MAX_SPEED_MPS", "quick")
    clean_env.setenv("EIS_CONTROL_PORT", "eight-seven-six-five")
    cfg = load_config(None, use_dotenv=False, use_env=True)
    assert cfg.limits.max_speed == 2.0
    assert cfg.network.control_port == 8765


def test_numeric_env_is_coerced_the_documented_way(clean_env):
    clean_env.setenv("EIS_CONTROL_PORT", "9000.9")   # ports truncate
    clean_env.setenv("EIS_DETECT_CONF", "0.55")
    clean_env.setenv("EIS_SITL", "no")               # only 1/true/yes/on are true
    clean_env.setenv("EIS_GIMBAL_MANAGER", "ON")
    cfg = load_config(None, use_dotenv=False, use_env=True)
    assert cfg.network.control_port == 9000
    assert cfg.detector.conf == pytest.approx(0.55)
    assert cfg.sitl is False
    assert cfg.gimbal.use_gimbal_manager is True


def test_bind_all_decides_the_host_whatever_the_export_order(clean_env):
    clean_env.setenv("EIS_CONTROL_HOST", "127.0.0.1")
    clean_env.setenv("EIS_BIND_ALL", "true")
    opened = load_config(None, use_dotenv=False, use_env=True)
    assert opened.network.host == "0.0.0.0"

    clean_env.setenv("EIS_CONTROL_HOST", "0.0.0.0")
    clean_env.setenv("EIS_BIND_ALL", "false")
    closed = load_config(None, use_dotenv=False, use_env=True)
    assert closed.network.host == "127.0.0.1"


def test_control_host_alone_still_moves_the_bind(clean_env):
    clean_env.setenv("EIS_CONTROL_HOST", "192.168.1.5")
    assert load_config(None, use_dotenv=False, use_env=True).network.host == "192.168.1.5"


def test_dotenv_fills_gaps_but_never_beats_an_exported_variable(tmp_path, clean_env):
    (tmp_path / ".env").write_text(
        "EIS_VEHICLE_ID=from-dotenv\nEIS_CAMERA_SOURCE=file\n# a comment\n",
        encoding="utf-8",
    )
    clean_env.chdir(tmp_path)
    clean_env.setenv("EIS_VEHICLE_ID", "from-export")
    try:
        cfg = load_config(None, use_dotenv=True, use_env=True)
        assert cfg.vehicle_id == "from-export"     # the export wins
        assert cfg.camera.source == "file"         # the file fills the gap
    finally:
        os.environ.pop("EIS_CAMERA_SOURCE", None)


def test_env_config_selects_the_file(clean_env):
    clean_env.setenv("EIS_CONFIG", "config/sitl.yaml")
    cfg = load_config(None, use_dotenv=False, use_env=True)
    assert cfg.source_path is not None
    assert Path(cfg.source_path).name == "sitl.yaml"
    assert cfg.sitl is True


# ==========================================================================
# Parsing shapes the YAML files rely on
# ==========================================================================
def test_gain_triples_accept_both_mapping_and_sequence(tmp_path, clean_env):
    p = tmp_path / "cfg.yaml"
    p.write_text(
        "guidance:\n  gains:\n"
        "    yaw: [10, 1, 2]\n"
        "    altitude: {kp: 9.0}\n",
        encoding="utf-8",
    )
    g = load_config(str(p), use_dotenv=False, use_env=False).gains
    assert g.yaw.as_tuple() == (10.0, 1.0, 2.0)
    assert g.altitude.as_tuple() == (9.0, 0.0, 0.1)   # unnamed terms keep defaults
    assert g.forward.as_tuple() == (0.6, 0.0, 0.05)   # unnamed channel untouched


def test_a_section_that_is_not_a_mapping_falls_back_to_defaults(tmp_path, clean_env):
    p = tmp_path / "cfg.yaml"
    p.write_text("limits: 5\ncamera: nonsense\nplanner: []\n", encoding="utf-8")
    cfg = load_config(str(p), use_dotenv=False, use_env=False)
    assert cfg.limits.max_speed == 2.0
    assert cfg.camera.source == "csi"
    assert cfg.planner.arrival_radius_m == 2.0


def test_an_empty_file_is_all_defaults(tmp_path, clean_env):
    p = tmp_path / "cfg.yaml"
    p.write_text("\n", encoding="utf-8")
    assert load_config(str(p), use_dotenv=False, use_env=False) == dataclasses.replace(
        AppConfig(), source_path=str(p)
    )


def test_a_top_level_sequence_is_refused(tmp_path, clean_env):
    p = tmp_path / "cfg.yaml"
    p.write_text("- one\n- two\n", encoding="utf-8")
    with pytest.raises(ValueError):
        load_config(str(p), use_dotenv=False, use_env=False)


# ==========================================================================
# The shipped YAML files must keep loading unchanged
# ==========================================================================
@pytest.mark.parametrize("name", ["default.yaml", "sitl.yaml", "vehicle2.yaml"])
def test_shipped_config_files_load(name, clean_env):
    cfg = load_config(str(CONFIG_DIR / name), use_dotenv=False, use_env=False)
    assert cfg.limits.max_speed == 2.0
    assert cfg.limits.standoff == 5.0
    assert cfg.limits.min_standoff == 3.0
    assert cfg.safety.geofence_radius_m == 60.0
    assert cfg.gains.yaw.as_tuple() == (90.0, 0.0, 4.0)
    assert cfg.network.host == "127.0.0.1"
    assert cfg.security.require_signed_commands is False


def test_default_yaml_is_the_hardware_profile(clean_env):
    cfg = load_config(str(CONFIG_DIR / "default.yaml"), use_dotenv=False, use_env=False)
    assert cfg.sitl is False
    assert cfg.vehicle_id == "eis-1"
    assert cfg.fc.connection == "/dev/ttyTHS1"
    assert cfg.camera.source == "csi"
    assert cfg.battery.cell_count == 4
    assert cfg.limits.max_altitude == 30.0


def test_sitl_yaml_is_the_simulation_profile(clean_env):
    cfg = load_config(str(CONFIG_DIR / "sitl.yaml"), use_dotenv=False, use_env=False)
    assert cfg.sitl is True
    assert cfg.fc.connection == "udp:127.0.0.1:14550"
    assert cfg.camera.source == "sim"
    assert cfg.limits.max_altitude == 80.0
    assert cfg.battery.cell_count == 3          # SITL simulates a 12.6 V pack
    assert cfg.video_url == ""                  # a sim camera advertises nothing


def test_vehicle2_yaml_is_the_second_airframe(clean_env):
    cfg = load_config(str(CONFIG_DIR / "vehicle2.yaml"), use_dotenv=False, use_env=False)
    assert cfg.vehicle_id == "eis-2"
    assert cfg.network.control_port == 8766
    assert cfg.network.video_port == 8555
    assert cfg.fc.sysid == 2 and cfg.fc.gcs_sysid == 254
    assert cfg.security.session_key_env == "EIS_SESSION_KEY_EIS_2"
    assert cfg.unattended.profiles == ("inspect",)
    assert cfg.envelope.separation_m == 40.0
    # a second airframe flies the SAME envelope as the first
    first = load_config(str(CONFIG_DIR / "sitl.yaml"), use_dotenv=False, use_env=False)
    assert dataclasses.astuple(cfg.limits) == dataclasses.astuple(first.limits)


def test_profile_speeds_mirror_the_shared_contract(clean_env):
    cfg = load_config(str(CONFIG_DIR / "sitl.yaml"), use_dotenv=False, use_env=False)
    assert cfg.planner.profile_speed_mps == config_mod.PROFILE_SPEED_FALLBACK


def test_each_load_gets_its_own_profile_speed_dict(clean_env):
    first = load_config(None, use_dotenv=False, use_env=False)
    first.planner.profile_speed_mps["inspect"] = 0.0
    second = load_config(None, use_dotenv=False, use_env=False)
    assert second.planner.profile_speed_mps["inspect"] == 4.0


def test_video_url_is_derived_only_for_a_real_camera(clean_env):
    cfg = load_config(str(CONFIG_DIR / "default.yaml"), use_dotenv=False, use_env=False)
    assert cfg.video_url == "rtsp://0.0.0.0:8554/stream"
    cfg.network.video_url = "webrtc://elsewhere/whep"
    assert cfg.video_url == "webrtc://elsewhere/whep"
    cfg.network.video_url = ""
    cfg.camera.source = "mock"
    assert cfg.video_url == ""
