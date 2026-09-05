"""Wide-area change detection: two overhead renders in, Detections out.

Pure numpy: blur, absolute difference, threshold, connected components on a coarse grid, minimum area gate.
Pixel boxes map to latitude and longitude through the overhead footprint the Renderer reported.
"""
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

from contracts.models import ChangeType, Detection, LatLon

CELL = 4            # px per grid cell (about 1.3 m at the Site footprint)
DIFF_THRESHOLD = 18  # 0..255 mean abs difference per cell; plume and ripple noise stays below this
MIN_CELLS = 4        # minimum blob size in cells


def _load(path: Path, size: int = 1024) -> np.ndarray:
    im = Image.open(path).convert("RGB").resize((size, size)).filter(ImageFilter.GaussianBlur(1.0))
    return np.asarray(im, dtype=np.float32)


def _components(mask: np.ndarray) -> list[list[tuple[int, int]]]:
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    out = []
    for r in range(h):
        for c in range(w):
            if not mask[r, c] or seen[r, c]:
                continue
            stack, blob = [(r, c)], []
            seen[r, c] = True
            while stack:
                y, x = stack.pop()
                blob.append((y, x))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            out.append(blob)
    return out


def detect(before: Path, after: Path, footprint: list[list[float]], *, before_ref: str, after_ref: str, min_area_m2: float = 4.0) -> list[Detection]:
    """footprint: [[lat, lon] x 4] corners top-left, top-right, bottom-right, bottom-left (image up = north)."""
    a, b = _load(before), _load(after)
    size = a.shape[0]
    diff = np.abs(a - b).mean(axis=2)
    cells = diff.reshape(size // CELL, CELL, size // CELL, CELL).mean(axis=(1, 3))
    mask = cells > DIFF_THRESHOLD
    (lat_t, lon_l), (_, lon_r), (lat_b, _), _ = footprint
    px_w = (lon_r - lon_l) / size
    px_h = (lat_t - lat_b) / size
    m_per_px = abs(lat_t - lat_b) * 111_320 / size
    dets: list[Detection] = []
    for i, blob in enumerate(sorted(_components(mask), key=len, reverse=True)):
        if len(blob) < MIN_CELLS:
            continue
        rows = [y for y, _ in blob]
        cols = [x for _, x in blob]
        y0, y1 = min(rows) * CELL, (max(rows) + 1) * CELL
        x0, x1 = min(cols) * CELL, (max(cols) + 1) * CELL
        area_m2 = len(blob) * (CELL * m_per_px) ** 2
        if area_m2 < min_area_m2:
            continue
        ring = [LatLon(lat=lat_t - y0 * px_h, lon=lon_l + x0 * px_w), LatLon(lat=lat_t - y0 * px_h, lon=lon_l + x1 * px_w),
                LatLon(lat=lat_t - y1 * px_h, lon=lon_l + x1 * px_w), LatLon(lat=lat_t - y1 * px_h, lon=lon_l + x0 * px_w)]
        strength = float(np.clip(cells[[y for y, _ in blob], [x for _, x in blob]].mean() / 120.0, 0, 1))
        confidence = round(min(0.98, 0.45 + 0.35 * strength + 0.2 * min(1.0, len(blob) / 30)), 2)
        dets.append(Detection(id=f"det-{datetime.now(UTC).strftime('%H%M%S')}-{i}", polygon=ring, confidence=confidence, change_type=ChangeType.unknown,
                              before_ref=before_ref, after_ref=after_ref, detected_at=datetime.now(UTC), area_m2=round(area_m2, 1),
                              metadata={"source": "overhead-change-detection", "cells": str(len(blob)), "mean_diff": f"{cells[[y for y, _ in blob], [x for _, x in blob]].mean():.1f}"}))
    return dets


def footprint_from_meta(meta_path: Path) -> list[list[float]]:
    return json.loads(meta_path.read_text())["footprint"]
