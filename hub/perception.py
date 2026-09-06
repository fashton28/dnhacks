"""On-board perception: measurements from the Renderer's radiometric thermal map, georeferenced through the camera pose.

No neural network. The thermal camera already computes a temperature for every pixel (the Renderer attaches it to thermal
Frames as `temp_png_b64`, a grayscale PNG calibrated byte 0 = -10 C, byte 255 = 700 C, linear). The Hub thresholds that map,
finds connected blobs and turns each into a `Sighting` with its peak temperature, its box and the ground point its foot pixel
lands on. Smoke and steam classification is left to the vision model for now: every blob is a `hot_spot`.
"""
from __future__ import annotations

import io
import math
import uuid
from collections import deque
from datetime import UTC, datetime
from typing import Any

import numpy as np
from PIL import Image

from contracts.models import Sighting, SightingLabel
from contracts.site import enu_to_latlon, latlon_to_enu

TEMP_MIN_C = -10.0
TEMP_MAX_C = 700.0
HOT_SPOT_C = 80.0          # a blob is a hot spot when its (lightly smoothed) temperature exceeds this
MIN_BLOB_PX = 12           # smaller blobs are texture speckle, not a source
MAX_SIGHTINGS_PER_FRAME = 8
DEFAULT_FOV_DEG = 70.0
CAMERA_LENS_ABOVE_SKIDS_M = 0.15   # the Renderer's gimbal lens sits 15 cm above the reported altitude
MAX_SIGHTINGS_KEPT = 500
MAX_RANGE_M = 2000.0


def decode_temperature_map(png_bytes: bytes) -> np.ndarray:
    """The calibrated PNG as a float32 array of degrees C, shape (h, w)."""
    img = Image.open(io.BytesIO(png_bytes)).convert("L")
    raw = np.asarray(img, dtype=np.float32)
    return TEMP_MIN_C + raw * (TEMP_MAX_C - TEMP_MIN_C) / 255.0


def _smooth3(a: np.ndarray) -> np.ndarray:
    """3x3 box mean with edge replication: kills single bright texels before thresholding."""
    p = np.pad(a, 1, mode="edge")
    out = np.zeros_like(a)
    for dy in (0, 1, 2):
        for dx in (0, 1, 2):
            out += p[dy:dy + a.shape[0], dx:dx + a.shape[1]]
    return out / 9.0


def connected_components(mask: np.ndarray) -> list[np.ndarray]:
    """4-connected components of a boolean mask, each as an (n, 2) array of (y, x), largest first. Plain flood fill."""
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    blobs: list[np.ndarray] = []
    ys, xs = np.nonzero(mask)
    for y0, x0 in zip(ys.tolist(), xs.tolist()):
        if seen[y0, x0]:
            continue
        seen[y0, x0] = True
        q = deque([(y0, x0)])
        pts = []
        while q:
            y, x = q.popleft()
            pts.append((y, x))
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    q.append((ny, nx))
        blobs.append(np.array(pts, dtype=np.int32))
    blobs.sort(key=len, reverse=True)
    return blobs


def georef(frame_meta: dict[str, Any], px: float, py: float) -> tuple[float, float, float] | None:
    """Cast the ray through frame pixel (px, py) from the camera pose to ground level (z = 0): (lat, lon, slant range m).

    Pose: lat, lon, alt (metres above Site ground), heading_deg (clockwise from north), gimbal_pitch_deg (0 level, 90 straight
    down), fov_deg and the frame width and height. fov_deg is the vertical field of view, which is what the Renderer's
    perspective camera uses; the horizontal field follows from the aspect ratio. Returns None when the ray never reaches the ground.
    """
    w, h = float(frame_meta["width"]), float(frame_meta["height"])
    hd = math.radians(float(frame_meta["heading_deg"]))
    pt = math.radians(float(frame_meta["gimbal_pitch_deg"]))
    fov = math.radians(float(frame_meta.get("fov_deg") or DEFAULT_FOV_DEG))
    # camera basis in ENU (x east, y north, z up)
    fwd = (math.sin(hd) * math.cos(pt), math.cos(hd) * math.cos(pt), -math.sin(pt))
    right = (math.cos(hd), -math.sin(hd), 0.0)
    up = (math.sin(hd) * math.sin(pt), math.cos(hd) * math.sin(pt), math.cos(pt))
    tan_v = math.tan(fov / 2)
    sx = ((px + 0.5) / w * 2 - 1) * tan_v * (w / h)
    sy = (1 - (py + 0.5) / h * 2) * tan_v
    d = tuple(fwd[i] + right[i] * sx + up[i] * sy for i in range(3))
    cz = float(frame_meta["alt"]) + CAMERA_LENS_ABOVE_SKIDS_M
    if d[2] >= -1e-6:
        return None
    t = -cz / d[2]
    cx, cy = latlon_to_enu(float(frame_meta["lat"]), float(frame_meta["lon"]))
    gx, gy = cx + d[0] * t, cy + d[1] * t
    rng = t * math.sqrt(d[0] ** 2 + d[1] ** 2 + d[2] ** 2)
    if rng > MAX_RANGE_M:
        return None
    lat, lon = enu_to_latlon(gx, gy)
    return lat, lon, rng


def find_hot_spots(temp_png_bytes: bytes, frame_meta: dict[str, Any]) -> list[Sighting]:
    """Threshold the temperature map at HOT_SPOT_C, one Sighting per connected blob with its peak temperature and box.

    frame_meta: drone_id, mission_id, ts, width, height (frame pixels), lat, lon, alt, heading_deg, gimbal_pitch_deg, fov_deg,
    camera_mode, frame_ref. The temperature map may be a different size from the frame; boxes are scaled to frame pixels.
    """
    temp = decode_temperature_map(temp_png_bytes)
    th, tw = temp.shape
    fw, fh = int(frame_meta["width"]), int(frame_meta["height"])
    sx, sy = fw / tw, fh / th
    mask = _smooth3(temp) > HOT_SPOT_C
    out: list[Sighting] = []
    ts = frame_meta.get("ts") or datetime.now(UTC).isoformat()
    for pts in connected_components(mask):
        if len(pts) < MIN_BLOB_PX:
            break
        y0, x0 = pts.min(axis=0)
        y1, x1 = pts.max(axis=0)
        peak = float(temp[pts[:, 0], pts[:, 1]].max())
        bbox = [int(x0 * sx), int(y0 * sy), int((x1 + 1) * sx), int((y1 + 1) * sy)]
        foot = georef(frame_meta, (bbox[0] + bbox[2]) / 2, bbox[3] - 0.5)
        if foot is None:
            continue
        lat, lon, rng = foot
        # confidence: how far above the threshold the peak sits, saturating at 300 C over
        conf = max(0.5, min(1.0, 0.5 + (peak - HOT_SPOT_C) / 600.0))
        out.append(Sighting(id=f"sight-{uuid.uuid4().hex[:8]}", drone_id=str(frame_meta["drone_id"]), mission_id=frame_meta.get("mission_id"),
                            ts=ts, label=SightingLabel.hot_spot, confidence=round(conf, 2), bbox=bbox, camera_mode=str(frame_meta.get("camera_mode") or "thermal"),
                            lat=lat, lon=lon, range_m=round(rng, 1), temp_max_c=round(peak, 1), frame_ref=frame_meta.get("frame_ref")))
        if len(out) >= MAX_SIGHTINGS_PER_FRAME:
            break
    return out


def sightings_text(sightings: list[dict[str, Any]]) -> str:
    """The measurement line the agent reads in its tool result: 'hot spot 640 C at (41.20012, -98.39987), 31 m'."""
    if not sightings:
        return ""
    parts = []
    for s in sightings:
        label = str(s.get("label", "hot_spot")).replace("_", " ")
        temp = s.get("temp_max_c")
        parts.append(f"{label}{f' {temp:.0f} C' if temp is not None else ''} at ({s['lat']:.5f}, {s['lon']:.5f}), {s['range_m']:.0f} m")
    return " Sightings: " + "; ".join(parts) + "."


def store(app) -> list[dict[str, Any]]:
    """The Hub's rolling list of Sighting dicts (newest last, capped)."""
    lst = getattr(app.state, "sightings", None)
    if lst is None:
        lst = []
        app.state.sightings = lst
    return lst


def remember(app, sightings: list[Sighting]) -> list[dict[str, Any]]:
    lst = store(app)
    dicts = [s.model_dump(mode="json") for s in sightings]
    lst.extend(dicts)
    del lst[:-MAX_SIGHTINGS_KEPT]
    return dicts
