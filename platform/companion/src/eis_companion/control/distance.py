"""
Monocular range from a person's bounding-box height.

Model
-----
A pinhole camera projects an object of physical height ``H`` standing ``Z``
metres away onto ``h_px`` image rows:

    h_px / H = f_px / Z            =>   Z = H * f_px / h_px

The focal length in pixels follows from the vertical field of view and the
sensor height: half the frame subtends half the FOV, so

    f_px = (frame_h_px / 2) / tan(vfov / 2)

When the box height is NORMALISED (a fraction of the frame) the frame height
cancels and the range depends on the FOV alone:

    Z = H / (2 * tan(vfov / 2) * h_norm)

``PinholeCamera`` carries the intrinsics; the two public estimators are thin
adapters over it -- one for normalised heights (what the tracker produces),
one for pixel heights (external callers with a calibrated ``f_px``).

Every estimator answers ``None`` for "no usable measurement": a missing,
non-finite, non-positive or sub-threshold height, a non-positive or non-finite
camera parameter, or a non-positive range. NaN in particular must never leave
this module as a number -- the guidance standoff predicates are comparisons
and a comparison against NaN is False (FM-07). Ranges are capped at
``max_distance_m`` so a one-pixel sliver cannot report kilometres.

Assumptions: the subject is upright and fully framed (a crouching or partly
occluded person reads as farther away), lens distortion is ignored, and the
estimate is size-based -- adequate for the standoff hold, approximate in
absolute terms.

stdlib only.
"""
from __future__ import annotations

import math
from typing import NamedTuple, Optional

DEFAULT_PERSON_HEIGHT_M: float = 1.7
DEFAULT_VFOV_DEG: float = 41.0   # typical IMX219-class CSI cam at 720p crop
DEFAULT_FRAME_HEIGHT_PX: int = 720

# A normalised box height below this is detector noise, not a person: report
# "no measurement" rather than an absurd range.
_NOISE_FLOOR_H_NORM: float = 1e-4


def _positive_finite(value) -> Optional[float]:
    """float(value) if it is a finite, strictly positive number, else None."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(number) or number <= 0.0:
        return None
    return number


def _half_fov_tangent(vfov_deg) -> Optional[float]:
    """tan(vfov/2) for a vertical FOV strictly inside (0, 180) degrees."""
    fov = _positive_finite(vfov_deg)
    if fov is None or fov >= 180.0:
        return None
    tangent = math.tan(math.radians(fov) / 2.0)
    return tangent if math.isfinite(tangent) and tangent > 0.0 else None


class PinholeCamera(NamedTuple):
    """Intrinsics needed for size-based ranging.

    ``frame_h_px`` is optional: a caller holding only a calibrated focal
    length (the pixel-space estimator) has no use for it.
    """
    focal_px: float
    frame_h_px: Optional[float] = None

    @classmethod
    def from_vfov(cls, vfov_deg, frame_h_px) -> Optional["PinholeCamera"]:
        """Derive f_px from a vertical FOV and a frame height; None if invalid."""
        rows = _positive_finite(frame_h_px)
        tangent = _half_fov_tangent(vfov_deg)
        if rows is None or tangent is None:
            return None
        return cls(focal_px=rows / (2.0 * tangent), frame_h_px=rows)

    def range_to(
        self,
        object_height_m,
        image_height_px,
        max_distance_m: Optional[float] = None,
    ) -> Optional[float]:
        """Z = H * f_px / h_px, capped at ``max_distance_m`` when that is usable."""
        height_m = _positive_finite(object_height_m)
        height_px = _positive_finite(image_height_px)
        focal = _positive_finite(self.focal_px)
        if height_m is None or height_px is None or focal is None:
            return None
        z = height_m * focal / height_px
        if not math.isfinite(z) or z <= 0.0:
            return None
        cap = _positive_finite(max_distance_m)
        return z if cap is None else min(z, cap)


def focal_px_from_vfov(vfov_deg: float, frame_h_px: int) -> float:
    """Focal length in pixels: f_px = (frame_h / 2) / tan(vfov / 2).

    Raises ``ValueError`` for a non-positive frame height or a FOV outside
    (0, 180) degrees -- this is the strict, configuration-time entry point.
    """
    if _positive_finite(frame_h_px) is None:
        raise ValueError("frame_h_px must be positive")
    camera = PinholeCamera.from_vfov(vfov_deg, frame_h_px)
    if camera is None:
        raise ValueError("vfov_deg must be in (0, 180)")
    return camera.focal_px


def estimate_distance(
    bbox_h_norm: Optional[float],
    *,
    person_height_m: float = DEFAULT_PERSON_HEIGHT_M,
    vfov_deg: float = DEFAULT_VFOV_DEG,
    frame_h_px: int = DEFAULT_FRAME_HEIGHT_PX,
    max_distance_m: float = 100.0,
) -> Optional[float]:
    """Range (m) to a person from their NORMALISED bbox height, or None.

    Args:
      bbox_h_norm: box height as a fraction of the frame (0..1).
      person_height_m: assumed real height of the subject.
      vfov_deg: camera vertical field of view in degrees.
      frame_h_px: frame height in pixels (cancels for the normalised path but
        defines the pixel space the intrinsics live in).
      max_distance_m: upper cap on the reported range.

    Returns None whenever any input is unusable -- this runs once per frame
    inside the tracker and must never raise.
    """
    height_norm = _positive_finite(bbox_h_norm)
    if height_norm is None or height_norm < _NOISE_FLOOR_H_NORM:
        return None
    camera = PinholeCamera.from_vfov(vfov_deg, frame_h_px)
    if camera is None:
        return None
    return camera.range_to(
        person_height_m, height_norm * camera.frame_h_px, max_distance_m
    )


def estimate_distance_px(
    bbox_h_px: Optional[float],
    *,
    focal_px: float,
    person_height_m: float = DEFAULT_PERSON_HEIGHT_M,
    max_distance_m: float = 100.0,
) -> Optional[float]:
    """Pixel-space variant: Z = person_height_m * focal_px / bbox_h_px, or None."""
    return PinholeCamera(focal_px=focal_px).range_to(
        person_height_m, bbox_h_px, max_distance_m
    )


__all__ = [
    "DEFAULT_PERSON_HEIGHT_M",
    "DEFAULT_VFOV_DEG",
    "DEFAULT_FRAME_HEIGHT_PX",
    "PinholeCamera",
    "focal_px_from_vfov",
    "estimate_distance",
    "estimate_distance_px",
]
