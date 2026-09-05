import json
import time
from pathlib import Path

from eis_companion.vision.multimodal import StagedSensorSuite


ROOT = Path(__file__).resolve().parents[2]


def fixture_points():
    raw = json.loads((ROOT / "site/site.stub.json").read_text(encoding="utf-8"))
    return raw, StagedSensorSuite(
        raw["staging"],
        home=(raw["home"]["lat"], raw["home"]["lon"]),
        perimeter=raw["perimeter"],
        image_root=str(ROOT),
    )


def test_vehicle_fixture_is_fast_and_cross_modal():
    raw, suite = fixture_points()
    point = raw["staging"][0]
    started = time.perf_counter()
    observation = suite.observe(point["lat"], point["lon"])
    assert time.perf_counter() - started < 2.0
    assert observation is not None and observation.valid
    assert observation.sensors == {"rgb": "ok", "thermal": "ok", "lidar": "ok"}
    modalities = {track.modality for track in observation.tracks}
    assert {"rgb", "thermal", "lidar", "fused"} <= modalities
    assert observation.frames["rgb"] != observation.frames["thermal"]


def test_false_alarm_is_valid_empty_detection_not_sensor_failure():
    raw, suite = fixture_points()
    point = raw["staging"][1]
    observation = suite.observe(point["lat"], point["lon"])
    assert observation is not None and observation.valid
    assert observation.tracks == ()
    assert all(state == "ok" for state in observation.sensors.values())


def test_broken_assets_mark_only_their_modalities_failed(tmp_path):
    raw, _ = fixture_points()
    point = dict(raw["staging"][0], image="missing.png", thermal_image="bad.png")
    (tmp_path / "bad.png").write_bytes(b"not an image")
    suite = StagedSensorSuite(
        [point], home=(raw["home"]["lat"], raw["home"]["lon"]),
        perimeter=raw["perimeter"], image_root=str(tmp_path),
    )
    observation = suite.observe(point["lat"], point["lon"])
    assert observation is not None and observation.valid
    assert observation.sensors["rgb"] == "failed"
    assert observation.sensors["thermal"] == "failed"
    assert observation.sensors["lidar"] == "ok"
    assert observation.frames == {}
