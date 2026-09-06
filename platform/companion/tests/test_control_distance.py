"""
Monocular range estimation: pinhole geometry and the "no measurement" rules.
"""
from __future__ import annotations

import math

import pytest

from eis_companion.control.distance import (
    DEFAULT_FRAME_HEIGHT_PX,
    DEFAULT_PERSON_HEIGHT_M,
    DEFAULT_VFOV_DEG,
    PinholeCamera,
    estimate_distance,
    estimate_distance_px,
    focal_px_from_vfov,
)


# --------------------------------------------------------------------------
# Geometry
# --------------------------------------------------------------------------
def test_ninety_degree_fov_reduces_to_the_half_height_rule():
    """tan(45 deg) = 1, so Z = H / (2 * h_norm)."""
    assert estimate_distance(0.5, person_height_m=1.7, vfov_deg=90.0) == pytest.approx(1.7)
    assert estimate_distance(0.25, person_height_m=1.7, vfov_deg=90.0) == pytest.approx(3.4)


@pytest.mark.parametrize("frame_h", [480, 720, 1080, 2160])
def test_frame_height_cancels_for_normalised_boxes(frame_h):
    reference = estimate_distance(0.3, frame_h_px=DEFAULT_FRAME_HEIGHT_PX)
    assert estimate_distance(0.3, frame_h_px=frame_h) == pytest.approx(reference)


def test_pixel_and_normalised_paths_agree():
    focal = focal_px_from_vfov(DEFAULT_VFOV_DEG, DEFAULT_FRAME_HEIGHT_PX)
    for h_norm in (0.05, 0.2, 0.6):
        by_pixels = estimate_distance_px(h_norm * DEFAULT_FRAME_HEIGHT_PX, focal_px=focal)
        assert by_pixels == pytest.approx(estimate_distance(h_norm))


def test_range_falls_as_the_box_grows():
    ranges = [estimate_distance(h) for h in (0.05, 0.1, 0.2, 0.4, 0.8)]
    assert all(a > b for a, b in zip(ranges, ranges[1:]))


def test_taller_person_reads_farther():
    assert estimate_distance(0.3, person_height_m=1.9) > estimate_distance(0.3, person_height_m=1.5)


def test_defaults_match_the_documented_camera():
    assert (DEFAULT_PERSON_HEIGHT_M, DEFAULT_VFOV_DEG, DEFAULT_FRAME_HEIGHT_PX) == (1.7, 41.0, 720)


# --------------------------------------------------------------------------
# Caps and refusals
# --------------------------------------------------------------------------
def test_a_sliver_is_capped_at_max_distance():
    assert estimate_distance(2e-4) == 100.0
    assert estimate_distance(2e-4, max_distance_m=30.0) == 30.0


@pytest.mark.parametrize("bad", [None, 0.0, -0.1, 5e-5, float("nan"), float("inf"), "tall", object()])
def test_an_unusable_height_reports_no_measurement(bad):
    assert estimate_distance(bad) is None


@pytest.mark.parametrize("kwargs", [
    dict(vfov_deg=0.0), dict(vfov_deg=180.0), dict(vfov_deg=-10.0), dict(vfov_deg=float("nan")),
    dict(frame_h_px=0), dict(frame_h_px=-720), dict(person_height_m=0.0),
    dict(person_height_m=float("inf")),
])
def test_an_invalid_camera_or_subject_reports_no_measurement(kwargs):
    assert estimate_distance(0.3, **kwargs) is None


@pytest.mark.parametrize("bad", [None, 0.0, -5.0, float("nan"), float("inf")])
def test_pixel_path_refuses_an_unusable_height(bad):
    assert estimate_distance_px(bad, focal_px=600.0) is None


@pytest.mark.parametrize("bad", [0.0, -1.0, float("nan"), float("inf")])
def test_pixel_path_refuses_an_unusable_focal_length(bad):
    assert estimate_distance_px(100.0, focal_px=bad) is None


# --------------------------------------------------------------------------
# Intrinsics
# --------------------------------------------------------------------------
def test_focal_px_from_vfov_geometry():
    assert focal_px_from_vfov(90.0, 720) == pytest.approx(360.0)
    assert focal_px_from_vfov(60.0, 1000) == pytest.approx(500.0 / math.tan(math.radians(30.0)))


@pytest.mark.parametrize("vfov, frame_h", [(41.0, 0), (41.0, -1), (0.0, 720), (180.0, 720),
                                           (200.0, 720), (float("nan"), 720), (41.0, float("nan"))])
def test_focal_px_from_vfov_rejects_bad_intrinsics(vfov, frame_h):
    with pytest.raises(ValueError):
        focal_px_from_vfov(vfov, frame_h)


def test_pinhole_camera_round_trip():
    camera = PinholeCamera.from_vfov(41.0, 720)
    assert camera is not None
    assert camera.frame_h_px == 720
    assert camera.range_to(1.7, 0.3 * 720) == pytest.approx(estimate_distance(0.3))
    assert PinholeCamera.from_vfov(0.0, 720) is None
