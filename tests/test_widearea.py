"""Wide-area change detection on a synthetic overhead pair."""
from pathlib import Path

from PIL import Image, ImageDraw

from widearea.detect import detect

FOOTPRINT = [[41.20153, -98.40203], [41.20153, -98.39797], [41.19847, -98.39797], [41.19847, -98.40203]]  # 340 m square


def test_detects_a_new_vehicle_and_ignores_noise(tmp_path: Path):
    before = Image.new("RGB", (1024, 1024), (95, 130, 70))
    d = ImageDraw.Draw(before)
    d.rectangle([300, 300, 700, 420], fill=(120, 120, 125))  # a building in both images
    after = before.copy()
    ImageDraw.Draw(after).rectangle([800, 860, 818, 875], fill=(140, 20, 20))  # a 6 m x 5 m vehicle near the SE corner
    before.save(tmp_path / "b.png"); after.save(tmp_path / "a.png")
    dets = detect(tmp_path / "b.png", tmp_path / "a.png", FOOTPRINT, before_ref="b.png", after_ref="a.png")
    assert len(dets) == 1
    det = dets[0]
    lat = sum(p.lat for p in det.polygon) / 4
    lon = sum(p.lon for p in det.polygon) / 4
    assert 41.1985 < lat < 41.1995 and -98.3990 < lon < -98.3985  # south-east of the anchor
    assert 5 < det.area_m2 < 200 and 0.4 < det.confidence <= 0.98


def test_identical_images_yield_nothing(tmp_path: Path):
    im = Image.new("RGB", (512, 512), (95, 130, 70))
    im.save(tmp_path / "b.png"); im.save(tmp_path / "a.png")
    assert detect(tmp_path / "b.png", tmp_path / "a.png", FOOTPRINT, before_ref="b", after_ref="a") == []
