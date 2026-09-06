"""Pure bearing/range association for RGB, thermal, and LiDAR tracks."""
from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Iterable


@dataclass(frozen=True)
class SensorTrack:
    id: int
    cls: str
    bearing_deg: float
    range_m: float
    conf: float
    modality: str
    thermal_delta_c: float | None = None


@dataclass(frozen=True)
class FusionResult:
    tracks: tuple[SensorTrack, ...]
    disagreements: tuple[str, ...]


#: Classes a purely GEOMETRIC return may stand in for. A LiDAR cluster reports
#: shape, not identity, so "unclassified" corroborates whatever the imaging
#: rails identified at the same bearing and range. Without this, cross-rail
#: association required exact string equality and a geometric return could
#: never confirm anything it had not already named correctly (FM-115).
UNCLASSIFIED = "unclassified"


def class_compatible(a: str, b: str) -> bool:
    """Whether two modality classes may describe the same object."""
    a, b = str(a).strip().lower(), str(b).strip().lower()
    if a == b:
        return True
    return UNCLASSIFIED in (a, b)


def bearing_delta_deg(a: float, b: float) -> float:
    return abs((a - b + 180.0) % 360.0 - 180.0)


def fuse_tracks(
    tracks: Iterable[SensorTrack],
    *,
    bearing_gate_deg: float = 5.0,
    range_gate_m: float = 5.0,
    agreement_boost: float = 0.10,
    disagreement_penalty: float = 0.15,
) -> FusionResult:
    """Retain modality tracks and append fused tracks for cross-rail matches.

    Unmatched tracks are retained with the documented confidence penalty.  A
    missing sensor frame is represented by sensor health outside this function;
    an empty iterable is a valid no-detections observation.
    """
    source = tuple(
        track for track in tracks
        if (
            math.isfinite(track.bearing_deg)
            and math.isfinite(track.range_m)
            and track.range_m >= 0.0
            and math.isfinite(track.conf)
            and 0.0 <= track.conf <= 1.0
        )
    )
    consumed: set[int] = set()
    fused: list[SensorTrack] = []
    output: list[SensorTrack] = []
    disagreements: list[str] = []
    next_id = max((t.id for t in source), default=0) + 1

    for i, track in enumerate(source):
        if i in consumed:
            continue
        group = [track]
        for modality in sorted({candidate.modality for candidate in source} - {track.modality}):
            matches = []
            for j in range(i + 1, len(source)):
                candidate = source[j]
                bearing_error = bearing_delta_deg(candidate.bearing_deg, track.bearing_deg)
                range_error = abs(candidate.range_m - track.range_m)
                if (
                    j not in consumed
                    and candidate.modality == modality
                    and class_compatible(candidate.cls, track.cls)
                    and bearing_error <= bearing_gate_deg
                    and range_error <= range_gate_m
                ):
                    matches.append((bearing_error, range_error, candidate.id, j, candidate))
            if matches:
                _, _, _, j, candidate = min(matches)
                group.append(candidate)
                consumed.add(j)

        consumed.add(i)
        if len({item.modality for item in group}) >= 2:
            total_weight = sum(max(0.001, item.conf) for item in group)
            sin_sum = sum(
                math.sin(math.radians(item.bearing_deg)) * max(0.001, item.conf)
                for item in group
            )
            cos_sum = sum(
                math.cos(math.radians(item.bearing_deg)) * max(0.001, item.conf)
                for item in group
            )
            bearing = math.degrees(math.atan2(sin_sum, cos_sum)) % 360.0
            distance = sum(item.range_m * max(0.001, item.conf) for item in group) / total_weight
            confidence = min(0.99, max(item.conf for item in group) + agreement_boost)
            thermal = next(
                (item.thermal_delta_c for item in group if item.thermal_delta_c is not None),
                None,
            )
            output.extend(group)
            # The fused class is the most SPECIFIC one in the group: an
            # unclassified geometric return corroborates an identification, it
            # never overwrites one.
            named = [
                item.cls for item in group
                if str(item.cls).strip().lower() != UNCLASSIFIED
            ]
            fused.append(SensorTrack(
                id=next_id,
                cls=named[0] if named else track.cls,
                bearing_deg=bearing,
                range_m=distance,
                conf=confidence,
                modality="fused",
                thermal_delta_c=thermal,
            ))
            next_id += 1
        else:
            penalized = replace(track, conf=max(0.0, track.conf - disagreement_penalty))
            output.append(penalized)
            disagreements.append(
                f"{track.modality} {track.cls} track {track.id} has no cross-modality match"
            )

    output.extend(fused)
    return FusionResult(tuple(output), tuple(disagreements))


__all__ = [
    "UNCLASSIFIED",
    "FusionResult",
    "SensorTrack",
    "bearing_delta_deg",
    "class_compatible",
    "fuse_tracks",
]
