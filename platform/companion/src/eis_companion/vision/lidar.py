"""Synthetic LiDAR staging and deterministic geometry detection."""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Sequence

from eis_companion.control.fusion import SensorTrack

Point3 = tuple[float, float, float]
LatLon = tuple[float, float]
EARTH_RADIUS_M = 6_371_000.0

#: Along-fence sample spacing, in METRES. Fence-gap width is (missing samples x
#: this spacing) -- the two were coupled only by the accident of both being
#: 1.0, so a denser scan silently rescaled every reported breach width
#: (FM-117). One constant, used by the generator and the detector alike.
FENCE_SAMPLE_SPACING_M: float = 1.0

#: Voxel edge and clustering parameters. Object grids are generated at
#: OBJECT_SAMPLE_SPACING_M so that every synthetic object is DENSER than the
#: cluster radius -- a 5 x 4 m "structure" used to be sampled at 1.667 m, above
#: the 1.5 m radius, so it fragmented into zero-extent slabs and produced no
#: LiDAR evidence at all (FM-113).
VOXEL_SIZE_M: float = 0.25
CLUSTER_RADIUS_M: float = 1.5
CLUSTER_MIN_POINTS: int = 8
OBJECT_SAMPLE_SPACING_M: float = 0.5

#: Maximum range of the modelled scanner, in metres. The synthetic source used
#: to emit the ENTIRE perimeter ring regardless of distance (measured out to
#: ~800 m), so every threshold tuned against it was tuned against a sensor that
#: cannot exist (FM-119). 250 m matches a long-range survey-class scanning
#: LiDAR. NOTE the remaining, deliberate simplifications: no beam divergence,
#: no occlusion, no dropout, no intensity. This is a fixture, not a sensor
#: model, and code that consumes it must not assume otherwise.
DEFAULT_MAX_RANGE_M: float = 250.0

#: Consecutive scans a fence gap must appear in before it is reported.
FENCE_GAP_VOTES: int = 3


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


def _box_points(
    centre_y: float, length: float, width: float, height: float
) -> list[Point3]:
    """A solid-ish box sampled at ``OBJECT_SAMPLE_SPACING_M`` on every axis.

    Sampling density is derived from the box dimensions rather than fixed at
    5x4x3 samples: a fixed sample count means bigger objects are sampled more
    SPARSELY, which is how the 5 x 4 m structure ended up with 1.667 m spacing
    -- above the 1.5 m cluster radius -- and vanished from the LiDAR rail
    entirely (FM-113).
    """
    def _steps(extent: float) -> int:
        return max(2, int(math.ceil(extent / OBJECT_SAMPLE_SPACING_M)) + 1)

    nx, ny, nz = _steps(width), _steps(length), _steps(height)
    return [
        (
            -width / 2.0 + ix * width / (nx - 1),
            centre_y - length / 2.0 + iy * length / (ny - 1),
            iz * height / (nz - 1),
        )
        for ix in range(nx)
        for iy in range(ny)
        for iz in range(nz)
    ]


class SyntheticLidarSource:
    """Generate a fence profile plus truth-keyed gap/box from site geometry.

    A FIXTURE, not a sensor model: range-gated (``max_range_m``) but with no
    occlusion, divergence or dropout. See DEFAULT_MAX_RANGE_M.
    """

    def __init__(
        self,
        home: LatLon,
        perimeter: Sequence[LatLon],
        *,
        max_range_m: float = DEFAULT_MAX_RANGE_M,
    ) -> None:
        self.home = home
        self.perimeter = tuple(perimeter)
        self.max_range_m = max(1.0, float(max_range_m))

    def frame(
        self,
        truth: str,
        sensor_origin: LatLon | None = None,
        *,
        scan_index: int = 0,
    ) -> tuple[Point3, ...]:
        """One scan. ``scan_index`` produces DISTINCT successive scans.

        Distinct scans matter because the fence-gap debounce needs three
        consecutive OBSERVATIONS of the same gap; replaying one identical
        frame three times proves nothing about persistence (FM-116). The
        jitter is deterministic, so the fixture stays reproducible.
        """
        origin = sensor_origin or self.home
        local = [_local_xy(origin, p) for p in self.perimeter]
        points: list[Point3] = []
        for index, a in enumerate(local):
            points.extend(_segment_points(
                a, local[(index + 1) % len(local)], FENCE_SAMPLE_SPACING_M
            ))
        truth = truth.strip().lower()
        if truth == "breach" and len(points) > 8:
            # Cut the gap out of the CLOSEST stretch of fence, not an arbitrary
            # quarter-way index. A gap in fence the scanner cannot reach is not
            # observable, so putting it there would make the fixture depend on
            # the range gate being absent (FM-119).
            centre = min(
                range(len(points)),
                key=lambda i: math.hypot(points[i][0], points[i][1]),
            )
            lo, hi = max(0, centre - 2), min(len(points), centre + 3)
            points = points[:lo] + points[hi:]
            # A person standing in the gap: LiDAR must be ABLE to corroborate a
            # person, or it is structurally excluded from confirming the one
            # class the mission is about (FM-115).
            points.extend(_box_points(9.0, 0.4, 0.6, 1.8))
        if truth in {"vehicle", "structure"}:
            length, width, height = (
                (4.0, 2.0, 1.8) if truth == "vehicle" else (5.0, 4.0, 3.0)
            )
            points.extend(_box_points(12.0, length, width, height))
        # Deterministic per-scan jitter (sub-voxel), so successive scans are
        # genuinely different samples of the same scene rather than a replay.
        if scan_index:
            wobble = 0.05 * ((scan_index % 3) - 1)
            points = [(x + wobble, y - wobble, z) for x, y, z in points]
        limit = self.max_range_m
        return tuple(
            p for p in points if math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) <= limit
        )


def classify_cluster(footprint_m2: float, height_m: float) -> str:
    """Geometric class for one cluster: person | vehicle | structure | "".

    Returns "" for anything with no vertical extent -- the fence line itself
    clusters into one enormous flat run, and calling that a structure would
    fabricate a building on every scan.

    LiDAR returns geometry, not identity. The vocabulary used to be the single
    hardcoded string ``"vehicle"``, which meant a LiDAR return could never
    corroborate a person or a structure at all: fusion requires class equality,
    so the strongest geometric evidence in the system was structurally excluded
    from every confirmation that mattered (FM-115).
    """
    if height_m < 0.8:
        return ""
    if footprint_m2 <= 1.5 and height_m <= 2.4:
        return "person"
    if footprint_m2 <= 12.0 and height_m <= 2.5:
        return "vehicle"
    return "structure"


class LidarGeometryDetector:
    """First-pass 0.25 m voxel, 1.5 m/8-point cluster detector.

    STATEFUL: the fence-gap debounce counts CONSECUTIVE scans, so one detector
    must survive across scans. Constructing a fresh detector per observation
    reset the vote every time and made the debounce structurally unreachable
    (FM-116); callers keep one instance per sensor origin.
    """

    def __init__(
        self,
        home: LatLon,
        perimeter: Sequence[LatLon],
        *,
        max_range_m: float = DEFAULT_MAX_RANGE_M,
    ) -> None:
        self.home = home
        self.perimeter = tuple(perimeter)
        self.max_range_m = max(1.0, float(max_range_m))
        self._gap_votes: dict[int, int] = {}

    @property
    def gap_votes(self) -> dict[int, int]:
        """Consecutive-scan vote count per perimeter segment (diagnostics)."""
        return dict(self._gap_votes)

    def detect(self, points: Iterable[Point3]) -> LidarFrameResult:
        raw = tuple(points)
        if not raw:
            return LidarFrameResult(False, (), LidarGeometry(), "failed", (), "no LiDAR frame")
        voxels = self._voxelize(raw, VOXEL_SIZE_M)
        if not voxels:
            return LidarFrameResult(False, (), LidarGeometry(), "failed", (), "invalid LiDAR frame")
        clusters = self._clusters(voxels, CLUSTER_RADIUS_M, CLUSTER_MIN_POINTS)
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
            cls = classify_cluster(footprint, height)
            if not cls:
                continue
            tracks.append(SensorTrack(
                200 + len(tracks), cls, bearing, distance, 0.78, "lidar"
            ))
            if cls == "structure":
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
            expected = [
                p for p in _segment_points(a, b, FENCE_SAMPLE_SPACING_M)
                # A sample beyond the scanner's range is not "missing fence" --
                # it was never observable. Without this the range gate would
                # manufacture a gap along every distant segment (FM-119).
                if math.hypot(p[0], p[1]) <= self.max_range_m
            ]
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
            # METRES, derived from the sample spacing -- not a raw point count
            # that happened to equal metres because the spacing was 1.0 m
            # (FM-117).
            width_m = float(len(missing)) * FENCE_SAMPLE_SPACING_M
            if len(missing) >= 2:
                self._gap_votes[index] = self._gap_votes.get(index, 0) + 1
            else:
                self._gap_votes[index] = 0
            if self._gap_votes[index] >= FENCE_GAP_VOTES and missing:
                x = sum(p[0] for p in missing) / len(missing)
                y = sum(p[1] for p in missing) / len(missing)
                lat, lon = _latlon(self.home, x, y)
                gaps.append({"lat": lat, "lon": lon, "width_m": width_m})
        return gaps


__all__ = [
    "CLUSTER_MIN_POINTS",
    "CLUSTER_RADIUS_M",
    "DEFAULT_MAX_RANGE_M",
    "FENCE_GAP_VOTES",
    "FENCE_SAMPLE_SPACING_M",
    "LidarFrameResult",
    "LidarGeometry",
    "LidarGeometryDetector",
    "OBJECT_SAMPLE_SPACING_M",
    "SyntheticLidarSource",
    "VOXEL_SIZE_M",
    "classify_cluster",
]
