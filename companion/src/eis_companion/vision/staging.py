"""
============================================================================
Eye in the Sky -- Staging-point observer (StagingObserver)
----------------------------------------------------------------------------
Power-plant retrofit: when the vehicle arrives at a pre-surveyed staging
point (from the site model's ``staging[]`` list), run person/anomaly
detection on the point's CONFIGURED STILL IMAGE FILE -- no camera, no
Gazebo -- and emit the result as ordinary ``TargetObservation`` objects.

The emissions use the exact same type the live ``PersonDetector`` produces,
so the orchestrator can splice them into the normal perception pipeline
(``observations -> tracker.update() -> push_tracking``) unchanged: they
surface on the wire as a regular ``tracking`` frame.

Site-model rules (docs/SITE_CONTRACT.md):
  * This module NEVER reads site/site.json itself. The orchestrator loads
    the site file (EIS_SITE_FILE) and passes the staging entries in as
    plain data: id, lat, lon, image path, truth.
  * ``image`` is a repo-root-relative path; pass ``image_root`` if the
    process cwd is not the repo root.

Detection backend (resolved lazily, once):
  * REAL  -- if ultralytics is importable (the ``[detect]`` extra), the
    still image is loaded (cv2.imread) and run through ``PersonDetector``;
    whatever it returns is emitted.
  * STUB  -- otherwise (the default SITL/dev environment) a deterministic
    synthetic result keyed off the staging point's ``truth`` field:
      'vehicle' | 'breach' -> one high-confidence observation
      'structure'          -> one low-confidence observation
      'false_alarm'        -> no observation
    This keeps the demo path offline and dependency-free while live YOLO
    works when the extra is installed.

Arrival gating + debounce:
  * An arrival = horizontal (haversine) distance to the staging point
    dropping to <= ``arrival_radius_m`` (default 15 m, configurable).
  * Detection runs ONCE per arrival; the cached result is re-emitted for
    ``emit_repeat`` consecutive ``observe()`` calls (default 3 -- the
    tracker needs ``min_hits`` (default 2) consecutive associations to
    confirm a track, so a strict one-frame emission would never surface).
  * After the burst the point is silent until the vehicle LEAVES the
    arrival radius (re-arm) and comes back -- the 10 Hz perception loop is
    never spammed.

Pure stdlib at import time (numpy/cv2/ultralytics only touched lazily on
the real-backend path), so this module is importable in the plain SITL/dev
environment.
============================================================================
"""
from __future__ import annotations

import logging
import math
import os
import time
from dataclasses import dataclass, field
from typing import Any, Callable, List, Mapping, Optional, Sequence, Union

from eis_companion.types import TargetObservation

from .detector import PersonDetector

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Defaults / stub table
# ---------------------------------------------------------------------------

#: Horizontal arrival threshold around a staging point (metres).
DEFAULT_ARRIVAL_RADIUS_M = 15.0

#: Consecutive observe() calls that re-emit the cached detection after an
#: arrival. 3 > Tracker.min_hits default (2) so the observation confirms a
#: track; still a one-shot burst, not a stream.
DEFAULT_EMIT_REPEAT = 3

#: Deterministic stub detections keyed by the staging point's ``truth``
#: label (docs/SITE_CONTRACT.md: vehicle|breach|structure|false_alarm).
#: Each entry: list of (bbox(x, y, w, h) normalised 0..1, confidence).
STUB_DETECTIONS: dict[str, list[tuple[tuple[float, float, float, float], float]]] = {
    # A parked vehicle: wide, low box near frame centre, high confidence.
    "vehicle": [((0.36, 0.42, 0.26, 0.18), 0.91)],
    # A person breaching the fence line: portrait box, high confidence.
    "breach": [((0.44, 0.30, 0.12, 0.38), 0.90)],
    # Plant structure / clutter: big vague box, low confidence.
    "structure": [((0.28, 0.24, 0.44, 0.50), 0.32)],
    # Nothing there.
    "false_alarm": [],
}


# ---------------------------------------------------------------------------
# Staging point -- plain data mirror of one site.json staging[] entry
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class StagingPoint:
    """One pre-surveyed observation point (plain data, no file I/O here)."""
    id: str
    lat: float
    lon: float
    image: str   # still-image path (repo-root-relative per SITE_CONTRACT.md)
    truth: str   # 'vehicle' | 'breach' | 'structure' | 'false_alarm'

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "StagingPoint":
        """Build from a site.json ``staging[]`` entry (same key names)."""
        return cls(
            id=str(data["id"]),
            lat=float(data["lat"]),
            lon=float(data["lon"]),
            image=str(data.get("image", "")),
            truth=str(data.get("truth", "")).strip().lower(),
        )


StagingPointLike = Union[StagingPoint, Mapping[str, Any]]


# ---------------------------------------------------------------------------
# Geometry helper (stdlib only)
# ---------------------------------------------------------------------------

_EARTH_RADIUS_M = 6_371_000.0


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres between two WGS84 points."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2.0) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2.0) ** 2
    return 2.0 * _EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


# ---------------------------------------------------------------------------
# Default image loader (lazy cv2; None on any failure -> stub fallback)
# ---------------------------------------------------------------------------

def _default_image_loader(path: str) -> Optional[Any]:
    """Load *path* as a HxWx3 BGR ndarray via cv2, or return None."""
    try:
        import cv2  # type: ignore
    except ImportError:
        log.warning("StagingObserver: cv2 not installed; cannot load %s", path)
        return None
    frame = cv2.imread(path)
    if frame is None:
        log.warning("StagingObserver: could not read staging image %s", path)
    return frame


# ---------------------------------------------------------------------------
# Per-point runtime state
# ---------------------------------------------------------------------------

@dataclass
class _PointState:
    point: StagingPoint
    inside: bool = False          # currently within the arrival radius
    burst_left: int = 0           # remaining observe() calls that emit
    cached: List[TargetObservation] = field(default_factory=list)


# ---------------------------------------------------------------------------
# StagingObserver
# ---------------------------------------------------------------------------

class StagingObserver:
    """Emit still-image detections when the vehicle arrives at staging points.

    Parameters
    ----------
    staging:
        Staging points as plain data -- ``StagingPoint`` instances or
        mappings with the site.json keys (id, lat, lon, image, truth).
    arrival_radius_m:
        Horizontal arrival threshold (metres). Default 15.
    emit_repeat:
        Consecutive ``observe()`` calls that emit after an arrival
        (>= 1). Default 3 so the tracker (min_hits=2) confirms the track.
    detector:
        Optional pre-built detector exposing
        ``detect(frame) -> list[TargetObservation]``. When given, the
        real-backend path is used unconditionally (tests inject fakes
        here; production lets the observer resolve one lazily).
    image_loader:
        Optional ``path -> ndarray | None`` loader. Defaults to a lazy
        cv2.imread wrapper.
    image_root:
        Optional directory the (repo-root-relative) image paths are
        resolved against. Default: use paths as given.
    detector_kwargs:
        Kwargs for the lazily-built ``PersonDetector`` (e.g. device,
        conf_threshold) when no ``detector`` is injected.
    clock:
        Timestamp source (seconds). Injectable for deterministic tests.
    """

    def __init__(
        self,
        staging: Sequence[StagingPointLike],
        arrival_radius_m: float = DEFAULT_ARRIVAL_RADIUS_M,
        *,
        emit_repeat: int = DEFAULT_EMIT_REPEAT,
        detector: Optional[Any] = None,
        image_loader: Optional[Callable[[str], Optional[Any]]] = None,
        image_root: Optional[str] = None,
        detector_kwargs: Optional[Mapping[str, Any]] = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._states: List[_PointState] = [
            _PointState(point=self._coerce(entry)) for entry in staging
        ]
        self._radius = max(0.1, float(arrival_radius_m))
        self._emit_repeat = max(1, int(emit_repeat))
        self._detector: Optional[Any] = detector
        self._image_loader = image_loader
        self._image_root = image_root
        self._detector_kwargs = dict(detector_kwargs or {})
        self._clock = clock
        # Backend is resolved lazily on first arrival; an injected detector
        # counts as already-resolved (real path).
        self._backend_resolved = detector is not None
        self._warned_truths: set[str] = set()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def arrival_radius_m(self) -> float:
        return self._radius

    @property
    def points(self) -> List[StagingPoint]:
        return [st.point for st in self._states]

    def reset(self) -> None:
        """Forget all arrival state (every point re-arms)."""
        for st in self._states:
            st.inside = False
            st.burst_left = 0
            st.cached = []

    def observe(self, lat: float, lon: float, rel_alt: float = 0.0
                ) -> List[TargetObservation]:
        """Per-tick update from the vehicle position.

        Call at the perception rate with the current vehicle lat/lon
        (``rel_alt`` in m AGL is accepted for symmetry/logging; gating is
        horizontal-only). Returns the staging detections to splice into
        this tick's observation list -- usually ``[]``.
        """
        # No-GPS guard: VehicleState lat/lon default to 0.0 before the
        # first fix; never match staging points against a bogus origin.
        if not (math.isfinite(lat) and math.isfinite(lon)):
            return []
        if lat == 0.0 and lon == 0.0:
            return []

        out: List[TargetObservation] = []
        for st in self._states:
            dist = haversine_m(lat, lon, st.point.lat, st.point.lon)
            if dist <= self._radius:
                if not st.inside:
                    # New arrival: run detection once, start the burst.
                    st.inside = True
                    st.cached = self._detect_for_point(st.point)
                    st.burst_left = self._emit_repeat if st.cached else 0
                    log.info(
                        "StagingObserver: arrived at '%s' (%.1f m, alt %.1f m) "
                        "-> %d observation(s)",
                        st.point.id, dist, rel_alt, len(st.cached),
                    )
                if st.burst_left > 0:
                    st.burst_left -= 1
                    ts = self._clock()
                    out.extend(
                        TargetObservation(bbox=o.bbox, conf=o.conf, ts=ts)
                        for o in st.cached
                    )
            else:
                # Left the radius: re-arm for the next arrival.
                if st.inside:
                    log.debug("StagingObserver: left '%s'; re-armed", st.point.id)
                st.inside = False
                st.burst_left = 0
                st.cached = []
        return out

    # ------------------------------------------------------------------
    # Detection backends
    # ------------------------------------------------------------------

    def _detect_for_point(self, point: StagingPoint) -> List[TargetObservation]:
        """Run the resolved backend on *point*'s still image."""
        self._resolve_backend()
        if self._detector is not None:
            obs = self._detect_real(point)
            if obs is not None:
                return obs
            # Real backend selected but the image/inference failed --
            # fall through to the deterministic stub so the demo flow
            # still produces its scripted result.
        return self._stub_observations(point)

    def _detect_real(self, point: StagingPoint
                     ) -> Optional[List[TargetObservation]]:
        """Load the still image and run the real detector.

        Returns None (-> stub fallback) if the image cannot be loaded or
        inference raises; returns the (possibly empty) detection list
        otherwise -- an empty real result is a real result.
        """
        path = point.image
        if self._image_root:
            path = os.path.join(self._image_root, path)
        loader = self._image_loader or _default_image_loader
        frame = loader(path)
        if frame is None:
            return None
        try:
            return list(self._detector.detect(frame))
        except Exception as exc:  # noqa: BLE001 -- never kill the perception loop
            log.warning(
                "StagingObserver: detector failed on %s (%s); using stub",
                path, exc,
            )
            return None

    def _resolve_backend(self) -> None:
        """Decide real-vs-stub once, on first arrival (lazy, cached)."""
        if self._backend_resolved:
            return
        self._backend_resolved = True
        try:
            # PersonDetector.__init__ raises ImportError when ultralytics
            # is not installed -- the default SITL/dev environment.
            self._detector = PersonDetector(**self._detector_kwargs)
            log.info("StagingObserver: real detector backend active")
        except ImportError:
            self._detector = None
            log.info(
                "StagingObserver: ultralytics not installed; "
                "using deterministic truth-keyed stub detections"
            )
        except Exception as exc:  # noqa: BLE001 -- model load failure etc.
            self._detector = None
            log.warning(
                "StagingObserver: real detector unavailable (%s); using stub",
                exc,
            )

    def _stub_observations(self, point: StagingPoint) -> List[TargetObservation]:
        """Deterministic truth-keyed synthetic detections (offline path)."""
        truth = point.truth.strip().lower()
        if truth not in STUB_DETECTIONS:
            if truth not in self._warned_truths:
                self._warned_truths.add(truth)
                log.warning(
                    "StagingObserver: unknown truth %r on staging point '%s'; "
                    "emitting nothing",
                    point.truth, point.id,
                )
            return []
        ts = self._clock()
        return [
            TargetObservation(bbox=bbox, conf=conf, ts=ts)
            for bbox, conf in STUB_DETECTIONS[truth]
        ]

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _coerce(entry: StagingPointLike) -> StagingPoint:
        if isinstance(entry, StagingPoint):
            return entry
        return StagingPoint.from_dict(entry)
