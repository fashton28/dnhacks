"""On-board perception: hot spots from a synthetic radiometric map, and georeferencing through the camera pose."""
from __future__ import annotations

import io
import math

import numpy as np
from PIL import Image

from contracts.site import ORIGIN_LAT, ORIGIN_LON, distance_m, enu_to_latlon, latlon_to_enu
from hub.perception import HOT_SPOT_C, TEMP_MAX_C, TEMP_MIN_C, find_hot_spots, georef, sightings_text


def _byte(c: float) -> int:
    return int(round((c - TEMP_MIN_C) / (TEMP_MAX_C - TEMP_MIN_C) * 255))


def _png(temp: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(temp.astype(np.uint8), "L").save(buf, "PNG")
    return buf.getvalue()


def _meta(**kw) -> dict:
    meta = {"drone_id": "drone-1", "mission_id": "m-1", "ts": "2026-09-06T10:00:00Z", "width": 640, "height": 400,
            "lat": ORIGIN_LAT, "lon": ORIGIN_LON, "alt": 30.0, "heading_deg": 90.0, "gimbal_pitch_deg": 45.0, "fov_deg": 70.0,
            "camera_mode": "thermal", "frame_ref": "evidence/m-1/inspect0-1.jpg"}
    meta.update(kw)
    return meta


def test_one_hot_blob_yields_one_sighting_with_peak_and_bbox():
    temp = np.full((200, 320), _byte(25.0), dtype=np.uint8)   # ambient at 25 C, well under the threshold
    temp[80:100, 150:180] = _byte(640.0)                        # a 30 x 20 px fire
    temp[10, 10] = _byte(650.0)                                 # a single bright texel is not a source
    found = find_hot_spots(_png(temp), _meta())
    assert len(found) == 1
    s = found[0]
    assert s.label.value == "hot_spot"
    assert abs(s.temp_max_c - 640.0) < 3.0                      # 8-bit quantisation
    # the map is 320 x 200 but the frame is 640 x 400: the box comes back in frame pixels
    assert s.bbox == [300, 160, 360, 200]
    assert s.drone_id == "drone-1" and s.mission_id == "m-1" and s.frame_ref == "evidence/m-1/inspect0-1.jpg"
    assert s.range_m > 0
    assert "hot spot" in sightings_text([s.model_dump(mode="json")]) and " C at (" in sightings_text([s.model_dump(mode="json")])


def test_cool_scene_yields_nothing():
    temp = np.full((120, 160), _byte(HOT_SPOT_C - 30.0), dtype=np.uint8)
    assert find_hot_spots(_png(temp), _meta()) == []


def test_georef_frame_centre_lands_on_the_expected_ground_point():
    # camera 30 m up looking east, 45 deg down: the centre ray reaches the ground 30 m east (plus the 0.15 m lens offset)
    meta = _meta(heading_deg=90.0, gimbal_pitch_deg=45.0, alt=30.0)
    lat, lon, rng = georef(meta, meta["width"] / 2, meta["height"] / 2)
    exp_lat, exp_lon = enu_to_latlon(30.15, 0.0)
    assert distance_m(lat, lon, exp_lat, exp_lon) < 5.0
    assert abs(rng - 30.15 * math.sqrt(2)) < 1.0
    # heading north from a known offset, 60 deg down from 40 m: ground point 40 / tan(60) north of the camera
    cam_lat, cam_lon = enu_to_latlon(100.0, -50.0)
    meta = _meta(lat=cam_lat, lon=cam_lon, heading_deg=0.0, gimbal_pitch_deg=60.0, alt=40.0)
    lat, lon, _ = georef(meta, meta["width"] / 2, meta["height"] / 2)
    x, y = latlon_to_enu(lat, lon)
    assert abs(x - 100.0) < 5.0 and abs(y - (-50.0 + 40.15 / math.tan(math.radians(60)))) < 5.0
    # pixels below the centre land nearer; a ray above the horizon never lands
    _, _, near = georef(meta, meta["width"] / 2, meta["height"] - 1)
    _, _, far = georef(meta, meta["width"] / 2, 0)
    assert near < far
    assert georef(_meta(gimbal_pitch_deg=0.0), 320, 0) is None


def test_capture_wiring_publishes_sightings_event_and_stores_them():
    """A thermal Frame with a temperature map, through the Inspector's perception step: one live event, the Hub store, tool text."""
    import base64
    from types import SimpleNamespace

    from contracts.protocol import Frame
    from hub.inspection import Inspector

    temp = np.full((100, 160), _byte(20.0), dtype=np.uint8)
    temp[40:50, 70:90] = _byte(500.0)
    published, audited = [], []
    app = SimpleNamespace(state=SimpleNamespace(
        registry=SimpleNamespace(publish=published.append),
        audit=SimpleNamespace(append=lambda kind, **kw: audited.append((kind, kw)))))
    frame = Frame(drone_id="drone-1", jpeg_b64="", width=1280, height=720, lat=ORIGIN_LAT, lon=ORIGIN_LON, alt=30.0, heading_deg=0.0, gimbal_pitch_deg=50.0,
                  ts="2026-09-06T10:00:00Z", temp_png_b64=base64.b64encode(_png(temp)).decode())
    insp = Inspector(app, loop=None, describe=None, emit=None, live=False)
    rows = insp._perceive(frame, "drone-1", "m-1", "evidence/m-1/inspect0-1.jpg", {"mode": "thermal", "fov_deg": 70.0})
    assert len(rows) == 1 and rows[0]["label"] == "hot_spot" and abs(rows[0]["temp_max_c"] - 500.0) < 3.0
    assert rows[0]["bbox"] == [560, 288, 720, 360]
    assert app.state.sightings == rows
    assert published == [{"type": "sightings", "drone_id": "drone-1", "mission_id": "m-1", "frame_ref": "evidence/m-1/inspect0-1.jpg", "width": 1280, "height": 720, "sightings": rows}]
    assert audited[0][0] == "sightings" and audited[0][1]["count"] == 1
    # an RGB frame (no map) is a no-op
    assert insp._perceive(Frame(drone_id="drone-1", jpeg_b64="", width=1280, height=720, lat=0, lon=0, alt=1, heading_deg=0, gimbal_pitch_deg=0, ts="t"), "drone-1", "m-1", None, {}) == []
    assert len(app.state.sightings) == 1
