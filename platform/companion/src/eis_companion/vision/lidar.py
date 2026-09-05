"""Synthetic LiDAR staging and deterministic geometry detection."""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Sequence

from eis_companion.control.fusion import SensorTrack

Point3 = tuple[float, float, float]
LatLon = tuple[float, float]
EARTH_RADIUS_M = 6_371_000.0


@dataclass(frozen=True)
class LidarGeometry:
    fence_gaps: tuple[dict[str, float], ...] = ()
    new_structures: tuple[dict[str, float], ...] = ()


@dataclass(frozen=True)
class LidarFrameResult:
    valid: bool
    tracks: tuple[SensorTrack, ...]
    geometry: LidarGeometry
    health: str
    points: tuple[Point3, ...] = ()
    detail: str = ""


def _local_xy(origin: LatLon, point: LatLon) -> tuple[float, float]:
    lat0 = math.radians(origin[0])
    x = math.radians(point[1] - origin[1]) * EARTH_RADIUS_M * math.cos(lat0)
    y = math.radians(point[0] - origin[0]) * EARTH_RADIUS_M
    return x, y


def _latlon(origin: LatLon, x: float, y: float) -> LatLon:
    lat = origin[0] + math.degrees(y / EARTH_RADIUS_M)
    lon = origin[1] + math.degrees(x / (EARTH_RADIUS_M * math.cos(math.radians(origin[0]))))
    return lat, lon


def _segment_points(a: tuple[float, float], b: tuple[float, float], spacing: float) -> list[Point3]:
    length = math.hypot(b[0] - a[0], b[1] - a[1])
    count = max(1, int(length / max(0.1, spacing)))
    return [
        (a[0] + (b[0] - a[0]) * i / count, a[1] + (b[1] - a[1]) * i / count, 1.8)
        for i in range(count + 1)
    ]


class SyntheticLidarSource:
    """Generate a fence profile plus truth-keyed gap/box from site geometry."""

    def __init__(self, home: LatLon, perimeter: Sequence[LatLon]) -> None:
        self.home = home
        self.perimeter = tuple(perimeter)

    def frame(self, truth: str, sensor_origin: LatLon | None = None) -> tuple[Point3, ...]:
        origin = sensor_origin or self.home
        local = [_local_xy(origin, p) for p in self.perimeter]
        points: list[Point3] = []
        for index, a in enumerate(local):
            points.extend(_segment_points(a, local[(index + 1) % len(local)], 1.0))
        truth = truth.strip().lower()
        if truth == "breach" and len(points) > 8:
            centre = len(points) // 4
            points = points[: max(0, centre - 2)] + points[centre + 3:]
        if truth in {"vehicle", "structure"}:
            length, width, height = (4.0, 2.0, 1.8) if truth == "vehicle" else (5.0, 4.0, 3.0)
            for ix in range(5):
                for iy in range(4):
                    for iz in range(3):
                        points.append((
                            -width / 2 + ix * width / 4,
                            12.0 - length / 2 + iy * length / 3,
                            iz * height / 2,
                        ))
        return tuple(points)


class LidarGeometryDetector:
    """First-pass 0.25 m voxel, 1.5 m/8-point cluster detector."""

    def __init__(self, home: LatLon, perimeter: Sequence[LatLon]) -> None:
        self.home = home
        self.perimeter = tuple(perimeter)
        self._gap_votes: dict[int, int] = {}

    def detect(self, points: Iterable[Point3]) -> LidarFrameResult:
        raw = tuple(points)
        if not raw:
            return LidarFrameResult(False, (), LidarGeometry(), "failed", (), "no LiDAR frame")
        voxels = self._voxelize(raw, 0.25)
        if not voxels:
            return LidarFrameResult(False, (), LidarGeometry(), "failed", (), "invalid LiDAR frame")
        clusters = self._clusters(voxels, 1.5, 8)
        tracks: list[SensorTrack] = []
        structures: list[dict[str, float]] = []
        for cluster in clusters:
            xs, ys, zs = zip(*cluster)
            width = max(xs) - min(xs)
            length = max(ys) - min(ys)
            height = max(zs) - min(zs)
            footprint = max(0.0, width * length)
            cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
            distance = math.hypot(cx, cy)
            bearing = math.degrees(math.atan2(cx, cy))
            if 2.0 <= footprint <= 20.0 and 1.0 <= height <= 4.0:
                tracks.append(SensorTrack(
                    200 + len(tracks), "vehicle", bearing, distance, 0.78, "lidar"
                ))
            elif footprint > 2.0 and height >= 1.0:
                lat, lon = _latlon(self.home, cx, cy)
                structures.append({
                    "lat": lat,
                    "lon": lon,
                    "footprint_m2": footprint,
                    "height_m": height,
                })
        gaps = self._fence_gaps(voxels)
        return LidarFrameResult(
            True,
            tuple(tracks),
            LidarGeometry(tuple(gaps), tuple(structures)),
            "ok",
            tuple(voxels),
        )

    @staticmethod
    def _voxelize(points: Iterable[Point3], size: float) -> list[Point3]:
        buckets: dict[tuple[int, int, int], Point3] = {}
        for x, y, z in points:
            if not all(math.isfinite(v) for v in (x, y, z)):
                continue
            key = (round(x / size), round(y / size), round(z / size))
            buckets.setdefault(key, (float(x), float(y), float(z)))
        return list(buckets.values())

    @staticmethod
    def _clusters(points: Sequence[Point3], radius: float, minimum: int) -> list[list[Point3]]:
        cell = max(0.1, radius)
        buckets: dict[tuple[int, int, int], list[int]] = {}
        for index, (x, y, z) in enumerate(points):
            key = (math.floor(x / cell), math.floor(y / cell), math.floor(z / cell))
            buckets.setdefault(key, []).append(index)
        remaining = set(range(len(points)))
        result = []
        radius2 = radius * radius
        while remaining:
            seed = remaining.pop()
            queue = [seed]
            group = [points[seed]]
            while queue:
                index = queue.pop()
                x, y, z = points[index]
                bx, by, bz = math.floor(x / cell), math.floor(y / cell), math.floor(z / cell)
                candidates = (
                    other
                    for dx in (-1, 0, 1) for dy in (-1, 0, 1) for dz in (-1, 0, 1)
                    for other in buckets.get((bx + dx, by + dy, bz + dz), ())
                )
                neighbours = [other for other in candidates if other in remaining and (
                    (points[other][0] - x) ** 2 + (points[other][1] - y) ** 2
                    + (points[other][2] - z) ** 2 <= radius2
                )]
                for other in neighbours:
                    remaining.remove(other)
                    queue.append(other)
                    group.append(points[other])
            if len(group) >= minimum:
                result.append(group)
        return result

    def _fence_gaps(self, points: Sequence[Point3]) -> list[dict[str, float]]:
        local = [_local_xy(self.home, p) for p in self.perimeter]
        cell = 0.75
        occupied: dict[tuple[int, int], list[Point3]] = {}
        for point in points:
            key = (math.floor(point[0] / cell), math.floor(point[1] / cell))
            occupied.setdefault(key, []).append(point)
        gaps = []
        for index, a in enumerate(local):
            b = local[(index + 1) % len(local)]
            expected = _segment_points(a, b, 1.0)
            missing = []
            for expected_point in expected:
                bx = math.floor(expected_point[0] / cell)
                by = math.floor(expected_point[1] / cell)
                nearby = (
                    candidate
                    for dx in (-1, 0, 1) for dy in (-1, 0, 1)
                    for candidate in occupied.get((bx + dx, by + dy), ())
                )
                if not any(
                    math.hypot(expected_point[0] - q[0], expected_point[1] - q[1]) <= 0.75
                    for q in nearby
                ):
                    missing.append(expected_point)
            width = float(len(missing))
            if width >= 2.0:
                self._gap_votes[index] = self._gap_votes.get(index, 0) + 1
            else:
                self._gap_votes[index] = 0
            if self._gap_votes[index] >= 3 and missing:
                x = sum(p[0] for p in missing) / len(missing)
                y = sum(p[1] for p in missing) / len(missing)
                lat, lon = _latlon(self.home, x, y)
                gaps.append({"lat": lat, "lon": lon, "width_m": width})
        return gaps


__all__ = [
    "LidarFrameResult",
    "LidarGeometry",
    "LidarGeometryDetector",
    "SyntheticLidarSource",
]
