"""Parallel SCRIPTED RGB, thermal, and LiDAR staging suite.

PROVENANCE (read this before treating anything here as evidence): every rail in
this module is derived from the site model's ``truth`` label, i.e. from the
answer key. It is a deterministic FIXTURE for the offline demo and the tests,
not live inference. ``StagedObservation.scripted`` is True for everything this
class emits, and ``observation_message`` puts that provenance in the ``scene``
string so an operator reading the wire can tell scripted evidence from
measured evidence. Nothing here may be used to close an incident as if a
sensor had seen it (FM-99).
"""
from __future__ import annotations

import logging
import math
import os
import time
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from eis_companion.control.fusion import SensorTrack, fuse_tracks

from .lidar import (
    FENCE_GAP_VOTES,
    LidarGeometryDetector,
    SyntheticLidarSource,
)
from .staging import haversine_m
from .thermal import ScriptedThermalDetector

log = logging.getLogger("eis.vision.multimodal")

#: Scans taken per staged observation. The fence-gap debounce wants
#: FENCE_GAP_VOTES CONSECUTIVE scans; taking that many DISTINCT scans through
#: one persistent detector is what makes the debounce real evidence rather than
#: the same frame replayed three times (FM-116).
SCANS_PER_OBSERVATION = FENCE_GAP_VOTES


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
    #: True when this observation was derived from the site truth label rather
    #: than from live inference. Always True for this class (FM-99).
    scripted: bool = True
    #: Frame the LiDAR ranges are expressed in. They are centred on the STAGING
    #: POINT, not on the vehicle, so they are NOT vehicle-relative proximity
    #: and must never be published as such (FM-118).
    range_frame: str = "staging_point"


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
        # ONE detector per sensor origin, kept across observations: the
        # fence-gap debounce counts consecutive scans, and a per-observation
        # detector reset that count every time (FM-116).
        self._lidar_detectors: dict[str, LidarGeometryDetector] = {}

    def reset(self) -> None:
        self._inside.clear()

    def asset_health(self) -> dict[str, dict[str, bool]]:
        """PER-POINT fixture health: ``{staging_id: {rgb: bool, thermal: bool}}``.

        Rail-level ``all()`` is the wrong shape on its own -- one unreadable
        asset used to mark the whole rail unhealthy and refuse missions for
        points whose own fixtures were fine (FM-25). The per-arrival build
        already checks the specific point's assets; this exposes the same
        judgement for reporting, so an operator is told WHICH fixture is bad.
        """
        return {
            str(point.get("id", "")): {
                "rgb": self._asset_valid(str(point.get("image", ""))),
                "thermal": self._asset_valid(str(point.get("thermal_image", ""))),
            }
            for point in self._staging
        }

    def unhealthy_points(self) -> dict[str, tuple[str, ...]]:
        """``{rail: (staging ids whose fixture is missing/unreadable)}``."""
        health = self.asset_health()
        return {
            rail: tuple(
                sid for sid, rails in health.items() if not rails.get(rail, False)
            )
            for rail in ("rgb", "thermal")
        }

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
        # Only the point we actually OBSERVE is marked as consumed. Marking
        # every in-radius point as inside consumed the others' arrival edge
        # too, so with overlapping radii (the effective radius grows to the
        # orbit radius) all but one observation vanished silently -- and did
        # not come back until the vehicle left and returned (FM-127). Points
        # still present but unobserved stay pending and emit on a later tick.
        selected_id = str(selected["id"]) if selected is not None else None
        pending = present - self._inside - ({selected_id} if selected_id else set())
        self._inside = (present & self._inside) | (
            {selected_id} if selected_id else set()
        )
        if pending:
            log.info(
                "staging arrival queued (observed %s; still pending: %s)",
                selected_id, ", ".join(sorted(pending)),
            )
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
            staging_id = str(point["id"])
            # PERSISTENT per-origin detector: the fence-gap debounce counts
            # consecutive scans, so it only accumulates if the detector lives
            # longer than one scan (FM-116).
            lidar_detector = self._lidar_detectors.get(staging_id)
            if lidar_detector is None:
                lidar_detector = LidarGeometryDetector(origin, self._perimeter)
                self._lidar_detectors[staging_id] = lidar_detector
            # DISTINCT successive scans, not one frame replayed: three
            # identical frames prove nothing about persistence.
            lidar = None
            for scan_index in range(SCANS_PER_OBSERVATION):
                points = self._lidar_source.frame(
                    truth, origin, scan_index=scan_index
                )
                lidar = lidar_detector.detect(points)
            if lidar is not None and lidar.valid:
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
        failed_rails = sorted(
            rail for rail, state in sensors.items() if state == "failed"
        )
        notes = list(fused.disagreements)
        if failed_rails:
            # A partially-failed observation used to say nothing about the dead
            # rail unless EVERY rail failed; the failure was buried in the
            # sensors map and never became a health event (FM-25).
            notes.append(f"sensor rail(s) failed: {', '.join(failed_rails)}")
        detail = "; ".join(notes)
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
        # The contract has no provenance FIELD, so the provenance rides the
        # scene string, which the UI and the report already show verbatim. A
        # dedicated boolean would be better and is recorded as an open contract
        # gap rather than added unilaterally to one of the three mirrors.
        "scene": (
            observation.scene if not observation.scripted
            else f"[SCRIPTED FIXTURE - not live inference] {observation.scene}"
        ),
        "sensors": observation.sensors,
        "geometry": observation.geometry,
        "frames": observation.frames,
        "stagingId": observation.staging_id,
    }


__all__ = ["StagedObservation", "StagedSensorSuite", "observation_message"]
