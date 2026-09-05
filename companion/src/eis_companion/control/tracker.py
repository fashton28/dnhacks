"""
Single-target multi-object tracker.

Per frame the vision layer hands us a list of ``TargetObservation`` (person
detections, normalised bboxes). The tracker:

  * associates detections to existing tracks by IoU (greedy, highest IoU first),
  * runs a simple per-track constant-velocity Kalman filter on the bbox centre +
    size, so a track can coast through brief occlusion on prediction alone,
  * assigns stable integer ids,
  * maintains a single-target *lock* -- chosen explicitly via ``select(id)`` or,
    by default, the highest-confidence / most-central detection,
  * declares the overall ``state``: idle -> searching -> locked, and on losing
    the locked track holds 'locked' (coasting) up to ``lost_timeout`` then
    'lost', then falls back to 'searching'.

It produces the contract ``TrackingStatus`` field values: ``state``,
``targets`` (each id/bbox/confidence/isLocked), ``lockedTargetId`` and (via the
distance module, wired by the caller) ``estimatedDistance``.

numpy + stdlib only -- no hardware, no detector. Unit-testable in isolation.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np

from ..types import TargetObservation, TrackingState
from .distance import estimate_distance


# --------------------------------------------------------------------------
# Per-track constant-velocity Kalman filter on [cx, cy, w, h] + velocities
# --------------------------------------------------------------------------
class _KalmanBox:
    """8-state constant-velocity filter: [cx, cy, w, h, vcx, vcy, vw, vh].

    Measures [cx, cy, w, h]. Plain numpy, fixed small matrices. Tuned gently so
    a track coasts smoothly through a few missed frames.
    """

    def __init__(self, cx: float, cy: float, w: float, h: float) -> None:
        self.x = np.array([cx, cy, w, h, 0.0, 0.0, 0.0, 0.0], dtype=float)
        # Covariance: confident on position, uncertain on velocity.
        self.P = np.diag([1e-2, 1e-2, 1e-2, 1e-2, 1.0, 1.0, 1.0, 1.0]).astype(float)
        # Measurement matrix: observe the first 4 states.
        self.H = np.zeros((4, 8), dtype=float)
        self.H[0, 0] = self.H[1, 1] = self.H[2, 2] = self.H[3, 3] = 1.0
        # Process / measurement noise.
        self._q = 1e-3
        self._r = 1e-2

    def _F(self, dt: float) -> np.ndarray:
        F = np.eye(8, dtype=float)
        for i in range(4):
            F[i, i + 4] = dt
        return F

    def predict(self, dt: float) -> np.ndarray:
        F = self._F(max(dt, 0.0))
        self.x = F @ self.x
        Q = np.eye(8, dtype=float) * self._q
        self.P = F @ self.P @ F.T + Q
        # bbox dims can't go negative
        self.x[2] = max(self.x[2], 1e-4)
        self.x[3] = max(self.x[3], 1e-4)
        return self.x[:4].copy()

    def update(self, cx: float, cy: float, w: float, h: float) -> None:
        z = np.array([cx, cy, w, h], dtype=float)
        R = np.eye(4, dtype=float) * self._r
        y = z - self.H @ self.x
        S = self.H @ self.P @ self.H.T + R
        K = self.P @ self.H.T @ np.linalg.inv(S)
        self.x = self.x + K @ y
        self.P = (np.eye(8) - K @ self.H) @ self.P
        self.x[2] = max(self.x[2], 1e-4)
        self.x[3] = max(self.x[3], 1e-4)

    @property
    def bbox(self) -> Tuple[float, float, float, float]:
        """Current (x, y, w, h) top-left bbox from the filtered centre+size."""
        cx, cy, w, h = self.x[0], self.x[1], self.x[2], self.x[3]
        return (cx - w / 2.0, cy - h / 2.0, w, h)


@dataclass
class Track:
    """A single tracked person."""
    id: int
    kf: _KalmanBox
    conf: float
    hits: int = 1                 # total successful associations
    age: int = 0                  # frames since created
    time_since_update: float = 0.0  # seconds since last measurement
    last_ts: float = 0.0

    @property
    def bbox(self) -> Tuple[float, float, float, float]:
        return self.kf.bbox

    @property
    def cx(self) -> float:
        return self.kf.x[0]

    @property
    def cy(self) -> float:
        return self.kf.x[1]

    @property
    def height(self) -> float:
        return self.kf.x[3]


def iou(a: Tuple[float, float, float, float],
        b: Tuple[float, float, float, float]) -> float:
    """IoU of two (x, y, w, h) boxes. 0 when they don't overlap."""
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ax2, ay2 = ax + aw, ay + ah
    bx2, by2 = bx + bw, by + bh
    ix = max(ax, bx)
    iy = max(ay, by)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    iw = max(0.0, ix2 - ix)
    ih = max(0.0, iy2 - iy)
    inter = iw * ih
    if inter <= 0.0:
        return 0.0
    union = aw * ah + bw * bh - inter
    if union <= 0.0:
        return 0.0
    return inter / union


class Tracker:
    """Single-target multi-object tracker with stable ids and one lock.

    Args:
      iou_threshold: minimum IoU for a detection to associate to a track.
      max_age: seconds a track may coast (no measurement) before deletion.
      lost_timeout: seconds the *locked* track may be missing before the
        overall state goes 'locked'(coasting) -> 'lost'.
      min_hits: associations before a track is "confirmed" / eligible for lock.
      vfov_deg / frame_h_px / person_height_m: passed to the distance estimator
        for ``estimated_distance``.
    """

    def __init__(
        self,
        *,
        iou_threshold: float = 0.3,
        max_age: float = 1.5,
        lost_timeout: float = 1.0,
        min_hits: int = 2,
        vfov_deg: float = 41.0,
        frame_h_px: int = 720,
        person_height_m: float = 1.7,
    ) -> None:
        self.iou_threshold = iou_threshold
        self.max_age = max_age
        self.lost_timeout = lost_timeout
        self.min_hits = min_hits
        self.vfov_deg = vfov_deg
        self.frame_h_px = frame_h_px
        self.person_height_m = person_height_m

        self._tracks: Dict[int, Track] = {}
        self._next_id: int = 1
        self._locked_id: Optional[int] = None
        self._select_request: Optional[int] = None
        self._state: TrackingState = TrackingState.IDLE
        self._last_ts: Optional[float] = None

    # ---- public lock control --------------------------------------------
    def select(self, target_id: Optional[int]) -> None:
        """Request a lock on a specific track id (applied on next update()).

        Pass None to clear the explicit selection and revert to auto-select
        (highest-confidence / most-central).
        """
        self._select_request = target_id
        if target_id is None:
            self._locked_id = None

    @property
    def locked_id(self) -> Optional[int]:
        return self._locked_id

    @property
    def state(self) -> TrackingState:
        return self._state

    # ---- main step ------------------------------------------------------
    def update(
        self,
        observations: List[TargetObservation],
        ts: Optional[float] = None,
    ) -> "TrackingResult":
        """Ingest this frame's detections and advance all tracks.

        Returns a TrackingResult carrying the contract field values.
        """
        if ts is None:
            ts = observations[0].ts if observations else (
                self._last_ts if self._last_ts is not None else 0.0
            )
        dt = 0.0 if self._last_ts is None else max(0.0, ts - self._last_ts)
        self._last_ts = ts

        # 1) predict every existing track forward
        for tr in self._tracks.values():
            tr.kf.predict(dt)
            tr.age += 1
            tr.time_since_update += dt

        # 2) associate detections to tracks greedily by IoU
        matches, unmatched_dets = self._associate(observations)

        # 3) update matched tracks
        for det_idx, tid in matches:
            obs = observations[det_idx]
            tr = self._tracks[tid]
            tr.kf.update(obs.cx, obs.cy, obs.width, obs.height)
            tr.conf = obs.conf
            tr.hits += 1
            tr.time_since_update = 0.0
            tr.last_ts = ts

        # 4) spawn tracks for unmatched detections
        for det_idx in unmatched_dets:
            obs = observations[det_idx]
            self._spawn(obs, ts)

        # 5) cull stale tracks
        self._cull()

        # 6) resolve the lock + overall state
        self._resolve_lock()
        self._resolve_state()

        return self._result(ts)

    # ---- internals ------------------------------------------------------
    def _associate(
        self, observations: List[TargetObservation]
    ) -> Tuple[List[Tuple[int, int]], List[int]]:
        """Greedy IoU association. Returns (matches[(det_idx, track_id)], unmatched_det_idxs)."""
        track_ids = list(self._tracks.keys())
        if not track_ids or not observations:
            return [], list(range(len(observations)))

        # Build IoU matrix [n_det x n_track]
        pairs: List[Tuple[float, int, int]] = []
        for di, obs in enumerate(observations):
            det_box = (obs.bbox[0], obs.bbox[1], obs.width, obs.height)
            for tid in track_ids:
                score = iou(det_box, self._tracks[tid].bbox)
                if score >= self.iou_threshold:
                    pairs.append((score, di, tid))

        pairs.sort(reverse=True)  # highest IoU first
        used_det: set = set()
        used_trk: set = set()
        matches: List[Tuple[int, int]] = []
        for score, di, tid in pairs:
            if di in used_det or tid in used_trk:
                continue
            used_det.add(di)
            used_trk.add(tid)
            matches.append((di, tid))

        unmatched = [di for di in range(len(observations)) if di not in used_det]
        return matches, unmatched

    def _spawn(self, obs: TargetObservation, ts: float) -> Track:
        tid = self._next_id
        self._next_id += 1
        kf = _KalmanBox(obs.cx, obs.cy, obs.width, obs.height)
        tr = Track(id=tid, kf=kf, conf=obs.conf, last_ts=ts)
        self._tracks[tid] = tr
        return tr

    def _cull(self) -> None:
        dead = [tid for tid, tr in self._tracks.items()
                if tr.time_since_update > self.max_age]
        for tid in dead:
            del self._tracks[tid]
            if tid == self._locked_id:
                self._locked_id = None

    def _confirmed(self, tr: Track) -> bool:
        return tr.hits >= self.min_hits

    def _resolve_lock(self) -> None:
        # honour an explicit selection request if that track exists
        if self._select_request is not None:
            if self._select_request in self._tracks:
                self._locked_id = self._select_request
                self._select_request = None
            # if requested id not present yet, keep the request pending

        # if we still hold a valid lock, keep it (coast through occlusion)
        if self._locked_id is not None and self._locked_id in self._tracks:
            return

        # otherwise auto-select among confirmed tracks
        self._locked_id = None
        candidates = [tr for tr in self._tracks.values() if self._confirmed(tr)]
        if not candidates:
            return
        # score: high confidence + central. centre distance from (0.5, 0.5).
        def score(tr: Track) -> float:
            centrality = 1.0 - min(
                1.0, ((tr.cx - 0.5) ** 2 + (tr.cy - 0.5) ** 2) ** 0.5 / 0.7071
            )
            return tr.conf * 0.7 + centrality * 0.3
        best = max(candidates, key=score)
        self._locked_id = best.id

    def _resolve_state(self) -> None:
        if self._locked_id is not None and self._locked_id in self._tracks:
            tr = self._tracks[self._locked_id]
            if tr.time_since_update <= self.lost_timeout:
                self._state = TrackingState.LOCKED
                return
            # locked track is coasting past the lost timeout -> lost
            self._state = TrackingState.LOST
            return

        # no lock
        if self._state in (TrackingState.LOCKED,):
            # we just lost the locked track entirely
            self._state = TrackingState.LOST
            return
        if self._state == TrackingState.LOST:
            # after being lost, look again
            self._state = TrackingState.SEARCHING
            return
        if self._tracks:
            self._state = TrackingState.SEARCHING
        else:
            # nothing seen yet / cleared
            self._state = (
                TrackingState.IDLE
                if self._state == TrackingState.IDLE
                else TrackingState.SEARCHING
            )

    def _result(self, ts: float) -> "TrackingResult":
        targets: List[DetectedTargetView] = []
        for tr in self._tracks.values():
            if not self._confirmed(tr) and tr.id != self._locked_id:
                # don't surface unconfirmed flickers as selectable targets
                continue
            bx, by, bw, bh = tr.bbox
            targets.append(
                DetectedTargetView(
                    id=tr.id,
                    bbox=(
                        _clip01(bx), _clip01(by),
                        _clip01(bw), _clip01(bh),
                    ),
                    confidence=tr.conf,
                    is_locked=(tr.id == self._locked_id),
                )
            )

        est_dist: Optional[float] = None
        if self._locked_id is not None and self._locked_id in self._tracks:
            lt = self._tracks[self._locked_id]
            est_dist = estimate_distance(
                lt.height,
                person_height_m=self.person_height_m,
                vfov_deg=self.vfov_deg,
                frame_h_px=self.frame_h_px,
            )

        return TrackingResult(
            state=self._state,
            targets=targets,
            locked_target_id=self._locked_id,
            estimated_distance=est_dist,
            ts=ts,
        )


@dataclass
class DetectedTargetView:
    """Mirror of the contract DetectedTarget (id/bbox/confidence/isLocked)."""
    id: int
    bbox: Tuple[float, float, float, float]
    confidence: float
    is_locked: bool


@dataclass
class TrackingResult:
    """Everything needed to build a contract TrackingStatus message.

    The API layer combines this with the configured standoff/maxSpeed.
    """
    state: TrackingState
    targets: List[DetectedTargetView]
    locked_target_id: Optional[int]
    estimated_distance: Optional[float]
    ts: float

    @property
    def locked_bbox(self) -> Optional[Tuple[float, float, float, float]]:
        """Convenience: the locked target's bbox, or None."""
        for t in self.targets:
            if t.is_locked:
                return t.bbox
        return None


def _clip01(v: float) -> float:
    return max(0.0, min(1.0, v))


__all__ = [
    "Tracker",
    "Track",
    "TrackingResult",
    "DetectedTargetView",
    "iou",
]
