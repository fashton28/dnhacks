"""
Monocular distance estimation from a person's bounding-box height.

Pinhole-camera geometry
-----------------------
A pinhole camera maps a real-world object of height ``H`` (metres) at distance
``Z`` (metres) onto an image of height ``h`` (pixels) according to similar
triangles:

        h_px      f_px
       ------  =  ------          =>     Z = (H * f_px) / h_px
         H          Z

where ``f_px`` is the camera's focal length expressed in *pixels*. We do not
usually know ``f_px`` directly, but we can derive it from the camera's vertical
field of view (FOV) and the frame height in pixels. For a vertical FOV of
``fov_v`` (radians) and a frame of ``frame_h`` pixels, the pinhole relation
between half-FOV and half-sensor gives:

        tan(fov_v / 2) = (frame_h / 2) / f_px
                  f_px = (frame_h / 2) / tan(fov_v / 2)

Combining:

        Z = (H * f_px) / h_px
          = H * (frame_h / 2) / ( tan(fov_v/2) * h_px )

Assumptions / caveats (documented for the operator):
  * The subject is roughly upright and fully in-frame (bbox height ~ person
    height). A crouching / partially-occluded subject reads as farther away.
  * Default person height ``DEFAULT_PERSON_HEIGHT_M = 1.7 m``.
  * Lens distortion is ignored (fine for the modest FOVs used here).
  * This is a *size-based* estimate; a single camera is sufficient for the
    standoff hold (PRD 6.1) but the absolute value is approximate.

The bbox height here is given NORMALISED (0..1 of the frame), so we convert to
pixels with ``h_px = bbox_h_norm * frame_h`` -- which means ``frame_h`` cancels
and the estimate depends only on the FOV and the normalised height:

        Z = H / ( 2 * tan(fov_v/2) * bbox_h_norm )

We still accept ``frame_h`` for clarity / future pixel-space callers.

Pure stdlib + math only.
"""
from __future__ import annotations

import math
from typing import Optional

DEFAULT_PERSON_HEIGHT_M: float = 1.7
DEFAULT_VFOV_DEG: float = 41.0   # typical IMX219-class CSI cam at 720p crop
DEFAULT_FRAME_HEIGHT_PX: int = 720

# Below this normalised bbox height the estimate is meaningless noise; treat as
# "no usable measurement" rather than reporting an absurd distance.
_MIN_BBOX_H_NORM: float = 1e-4


def focal_px_from_vfov(vfov_deg: float, frame_h_px: int) -> float:
    """Focal length in pixels from vertical FOV (degrees) and frame height (px).

    f_px = (frame_h / 2) / tan(vfov/2).
    """
    if frame_h_px <= 0:
        raise ValueError("frame_h_px must be positive")
    half = math.radians(vfov_deg) / 2.0
    t = math.tan(half)
    if t <= 0.0:
        raise ValueError("vfov_deg must be in (0, 180)")
    return (frame_h_px / 2.0) / t


def estimate_distance(
    bbox_h_norm: Optional[float],
    *,
    person_height_m: float = DEFAULT_PERSON_HEIGHT_M,
    vfov_deg: float = DEFAULT_VFOV_DEG,
    frame_h_px: int = DEFAULT_FRAME_HEIGHT_PX,
    max_distance_m: float = 100.0,
) -> Optional[float]:
    """Estimate distance (m) to a person from their NORMALISED bbox height.

    Args:
      bbox_h_norm: bbox height as a fraction of the frame height (0..1). If
        None, <= 0, or implausibly tiny, returns None ("no measurement").
      person_height_m: assumed real person height (default 1.7 m).
      vfov_deg: camera vertical field of view in degrees.
      frame_h_px: frame height in pixels (used to recover f_px; cancels for the
        normalised path but kept explicit).
      max_distance_m: clamp the upper end so a sliver bbox can't report 10 km.

    Returns:
      Estimated distance in metres, clamped to (0, max_distance_m], or None when
      there is no usable bbox.
    """
    if bbox_h_norm is None:
        return None
    bbox_h_norm = float(bbox_h_norm)
    if bbox_h_norm < _MIN_BBOX_H_NORM:
        return None

    f_px = focal_px_from_vfov(vfov_deg, frame_h_px)
    h_px = bbox_h_norm * frame_h_px
    if h_px <= 0.0:
        return None

    z = (person_height_m * f_px) / h_px
    if z <= 0.0:
        return None
    return min(z, max_distance_m)


def estimate_distance_px(
    bbox_h_px: Optional[float],
    *,
    focal_px: float,
    person_height_m: float = DEFAULT_PERSON_HEIGHT_M,
    max_distance_m: float = 100.0,
) -> Optional[float]:
    """Pixel-space variant: distance from a pixel bbox height and known f_px.

    Z = (person_height_m * focal_px) / bbox_h_px.
    """
    if bbox_h_px is None or bbox_h_px <= 0.0 or focal_px <= 0.0:
        return None
    z = (person_height_m * focal_px) / float(bbox_h_px)
    if z <= 0.0:
        return None
    return min(z, max_distance_m)


__all__ = [
    "DEFAULT_PERSON_HEIGHT_M",
    "DEFAULT_VFOV_DEG",
    "DEFAULT_FRAME_HEIGHT_PX",
    "focal_px_from_vfov",
    "estimate_distance",
    "estimate_distance_px",
]
