"""Parallel scripted RGB, thermal, and LiDAR staging suite."""
from __future__ import annotations

import math
import os
import time
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from eis_companion.control.fusion import SensorTrack, fuse_tracks

from .lidar import LidarGeometryDetector, SyntheticLidarSource
from .staging import haversine_m
from .thermal import ScriptedThermalDetector


@dataclass(frozen=True)
class StagedObservation:
    staging_id: str
    tracks: tuple[SensorTrack, ...]
    scene: str
    sensors: dict[str, str]
    geometry: dict[str, list[dict[str, float]]]
    frames: dict[str, str]
    lidar_ranges_m: tuple[float, ...]
    valid: bool
    detail: str = ""


class StagedSensorSuite:
    """Emit one multi-rail observation on entry to a staging radius."""

    def __init__(
        self,
        staging: Sequence[Mapping[str, Any]],
        *,
        home: tuple[float, float],
        perimeter: Sequence[tuple[float, float]],
        arrival_radius_m: float = 15.0,
        image_root: str = "",
    ) -> None:
        self._staging = tuple(dict(item) for item in staging)
        self._home = home
        self._perimeter = tuple(perimeter)
        self._arrival = max(1.0, float(arrival_radius_m))
        self._image_root = image_root
        self._inside: set[str] = set()
        self._thermal = ScriptedThermalDetector()
        self._lidar_source = SyntheticLidarSource(home, perimeter)

    def reset(self) -> None:
        self._inside.clear()

    def initial_health(self) -> dict[str, bool]:
        """Validate scripted assets without claiming a detection occurred."""
        return {
            "rgb": bool(self._staging) and all(
                self._asset_valid(str(point.get("image", ""))) for point in self._staging
            ),
            "thermal": bool(self._staging) and all(
                self._asset_valid(str(point.get("thermal_image", "")))
                for point in self._staging
            ),
            "lidar": len(self._perimeter) >= 3,
        }

    def observe(
        self,
        lat: float,
        lon: float,
        *,
        fail_rgb: bool = False,
        fail_thermal: bool = False,
        fail_lidar: bool = False,
        observation_radius_m: float | None = None,
    ) -> StagedObservation | None:
        if not all(math.isfinite(v) for v in (lat, lon)) or (lat == 0.0 and lon == 0.0):
            return None
        arrival = self._arrival if observation_radius_m is None else max(
            self._arrival, float(observation_radius_m)
        )
        selected = None
        present: set[str] = set()
        for point in self._staging:
            sid = str(point["id"])
            if haversine_m(lat, lon, float(point["lat"]), float(point["lon"])) <= arrival:
                present.add(sid)
                if sid not in self._inside and selected is None:
                    selected = point
        self._inside = present
        if selected is None:
            return None
        return self._build(selected, fail_rgb, fail_thermal, fail_lidar)

    def _build(
        self,
        point: Mapping[str, Any],
        fail_rgb: bool,
        fail_thermal: bool,
        fail_lidar: bool,
    ) -> StagedObservation:
        truth = str(point.get("truth", "")).lower()
        tracks: list[SensorTrack] = []
        rgb_path = str(point.get("image", ""))
        thermal_path = str(point.get("thermal_image", ""))
        fail_rgb = fail_rgb or not self._asset_valid(rgb_path)
        fail_thermal = fail_thermal or not self._asset_valid(thermal_path)
        sensors = {
            "rgb": "failed" if fail_rgb else "ok",
            "thermal": "failed" if fail_thermal else "ok",
            "lidar": "failed" if fail_lidar else "ok",
        }
        if not fail_rgb and truth != "false_alarm":
            cls = "person" if truth == "breach" else truth
            tracks.append(SensorTrack(1, cls, 0.0, 12.0, 0.88, "rgb"))
        if not fail_thermal:
            thermal = self._thermal.detect(truth)
            if thermal.valid:
                tracks.extend(thermal.tracks)
            else:
                sensors["thermal"] = "failed"

        geometry = {"fence_gaps": [], "new_structures": []}
        lidar_ranges: tuple[float, ...] = ()
        if not fail_lidar:
            origin = (float(point["lat"]), float(point["lon"]))
            lidar_detector = LidarGeometryDetector(origin, self._perimeter)
            points = self._lidar_source.frame(truth, origin)
            lidar = lidar_detector.detect(points)
            # Fence gaps require three consecutive scans.  The staged fixture
            # supplies the same deterministic scan three times at one arrival.
            if truth == "breach":
                lidar_detector.detect(points)
                lidar = lidar_detector.detect(points)
            if lidar.valid:
                lidar_ranges = tuple(
                    math.sqrt(x * x + y * y + z * z) for x, y, z in lidar.points
                )
                tracks.extend(lidar.tracks)
                geometry = {
                    "fence_gaps": list(lidar.geometry.fence_gaps),
                    "new_structures": list(lidar.geometry.new_structures),
                }
            else:
                sensors["lidar"] = "failed"

        fused = fuse_tracks(tracks)
        frames = {}
        if not fail_rgb:
            frames["rgb"] = rgb_path
        if not fail_thermal:
            frames["thermal"] = thermal_path
        valid = any(state != "failed" for state in sensors.values())
        detail = "; ".join(fused.disagreements)
        scene = f"scripted {truth or 'unknown'} observation at {point['id']}"
        return StagedObservation(
            staging_id=str(point["id"]),
            tracks=fused.tracks,
            scene=scene,
            sensors=sensors,
            geometry=geometry,
            frames=frames,
            lidar_ranges_m=lidar_ranges,
            valid=valid,
            detail=detail,
        )

    def _asset_valid(self, path: str) -> bool:
        candidate = path
        if self._image_root and not os.path.isabs(candidate):
            candidate = os.path.join(self._image_root, candidate)
        try:
            with open(candidate, "rb") as handle:
                header = handle.read(12)
            return header.startswith(b"\x89PNG\r\n\x1a\n") or header.startswith(b"\xff\xd8\xff")
        except OSError:
            return False

def observation_message(observation: StagedObservation, vehicle_id: str) -> dict[str, Any]:
    """Convert a valid staged observation to the shared wire shape."""
    return {
        "type": "observation",
        "ts": int(time.time() * 1000),
        "vehicleId": vehicle_id,
        "tracks": [
            {
                "id": track.id,
                "class": track.cls,
                "bearing_deg": track.bearing_deg,
                "range_m": track.range_m,
                "conf": track.conf,
                "modality": track.modality,
                **(
                    {"thermal_delta_c": track.thermal_delta_c}
                    if track.thermal_delta_c is not None else {}
                ),
            }
            for track in observation.tracks
        ],
        "scene": observation.scene,
        "sensors": observation.sensors,
        "geometry": observation.geometry,
        "frames": observation.frames,
        "stagingId": observation.staging_id,
    }


__all__ = ["StagedObservation", "StagedSensorSuite", "observation_message"]
