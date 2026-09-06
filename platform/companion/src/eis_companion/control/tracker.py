"""
Single-target multi-object tracker.

Each frame the vision layer hands over a list of ``TargetObservation`` (person
boxes, normalised to the frame). The tracker turns that stream into the
contract ``TrackingStatus`` values -- ``state``, ``targets`` (id / bbox /
confidence / isLocked), ``lockedTargetId`` and ``estimatedDistance``.

Pipeline per frame
------------------
  admit      drop any detection with a non-finite box or confidence at the
             door (one NaN inside a filter would latch for the life of the
             track and poison the range estimate, FM-07)
  predict    every track's ``BoxFilter`` is rolled forward by ``dt``
  associate  a vectorised IoU matrix (detections x tracks) is reduced
             greedily: take the best remaining pair while it clears
             ``iou_threshold``
  correct    matched tracks absorb their measurement; unmatched detections
             are born as new tracks with fresh, monotonically increasing ids
  cull       tracks unseen for longer than ``max_age`` seconds are deleted
  lock       an explicit ``select(id)`` request wins when that id exists; a
             live lock is kept while its track survives (coasting through
             occlusion); otherwise the best confirmed track (confidence
             weighted with centrality) is auto-selected
  state      a transition table over idle / searching / locked / lost

Filtering
---------
``KalmanFilter`` is a generic linear filter in matrix form (solve-based gain,
Joseph-form covariance update). ``BoxFilter`` specialises it to a
constant-velocity model over ``[cx, cy, w, h]`` with discrete white-noise
acceleration as the process model, so uncertainty grows with the elapsed
time and a coasting track keeps moving along its estimated velocity.

numpy + stdlib only -- no hardware, no detector.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np

from ..types import TargetObservation, TrackingState
from .distance import estimate_distance


# ---------------------------------------------------------------------------
# Generic linear Kalman filter
# ---------------------------------------------------------------------------
class KalmanFilter:
    """Linear Kalman filter: ``x' = F x`` and ``z = H x``.

    predict: x <- F x ;  P <- F P Fᵀ + Q
    correct: y = z - H x ;  S = H P Hᵀ + R ;  K = P Hᵀ S⁻¹
             x <- x + K y ;  P <- (I - K H) P (I - K H)ᵀ + K R Kᵀ

    The gain comes from a linear solve rather than an explicit inverse and the
    Joseph form keeps P symmetric under rounding. A correction that cannot be
    formed (singular S) or that would leave a non-finite state is refused and
    reported as ``False``; the filter then keeps its prediction.
    """

    def __init__(self, x0, P0, H, R) -> None:
        self.x = np.array(x0, dtype=float).reshape(-1)
        self.P = np.array(P0, dtype=float)
        self.H = np.array(H, dtype=float)
        self.R = np.array(R, dtype=float)
        self._identity = np.eye(self.x.size)

    def predict(self, F, Q) -> None:
        F = np.asarray(F, dtype=float)
        self.x = F @ self.x
        self.P = F @ self.P @ F.T + np.asarray(Q, dtype=float)

    def correct(self, z) -> bool:
        z = np.asarray(z, dtype=float).reshape(-1)
        innovation = z - self.H @ self.x
        S = self.H @ self.P @ self.H.T + self.R
        try:
            # K = P Hᵀ S⁻¹ == (S⁻¹ H P)ᵀ since S is symmetric.
            K = np.linalg.solve(S, self.H @ self.P).T
        except np.linalg.LinAlgError:
            return False
        x_new = self.x + K @ innovation
        I_KH = self._identity - K @ self.H
        P_new = I_KH @ self.P @ I_KH.T + K @ self.R @ K.T
        if not (np.isfinite(x_new).all() and np.isfinite(P_new).all()):
            return False
        self.x, self.P = x_new, P_new
        return True


# ---------------------------------------------------------------------------
# Constant-velocity box model
# ---------------------------------------------------------------------------
_MEAS = 4                    # cx, cy, w, h
_STATE = 2 * _MEAS           # ... plus their rates
_P0_OBSERVED = 1e-2          # the first box IS the estimate; modest doubt
_P0_RATE = 1.0               # rates are unknown at birth
_Q_INTENSITY = 0.5           # acceleration spectral density (frame units/s²)²
_Q_FLOOR = 1e-6              # keeps P alive when frames share a timestamp
_R_MEAS = 4e-4               # detector box jitter ~ 2 % of the frame
_MIN_DIM = 1e-4              # a box never collapses to zero size


def _transition(dt: float) -> np.ndarray:
    F = np.eye(_STATE)
    F[:_MEAS, _MEAS:] = np.eye(_MEAS) * dt
    return F


def _process_noise(dt: float) -> np.ndarray:
    """Discrete white-noise-acceleration Q for the CV model, plus a floor."""
    d2 = dt * dt
    d3 = d2 * dt
    d4 = d3 * dt
    block = np.eye(_MEAS)
    Q = np.zeros((_STATE, _STATE))
    Q[:_MEAS, :_MEAS] = block * (d4 / 4.0)
    Q[:_MEAS, _MEAS:] = block * (d3 / 2.0)
    Q[_MEAS:, :_MEAS] = block * (d3 / 2.0)
    Q[_MEAS:, _MEAS:] = block * d2
    return Q * _Q_INTENSITY + np.eye(_STATE) * _Q_FLOOR


class BoxFilter:
    """Constant-velocity Kalman filter over a normalised box (cx, cy, w, h)."""

    def __init__(self, cx: float, cy: float, w: float, h: float) -> None:
        x0 = np.array([cx, cy, w, h, 0.0, 0.0, 0.0, 0.0])
        P0 = np.diag([_P0_OBSERVED] * _MEAS + [_P0_RATE] * _MEAS)
        H = np.hstack([np.eye(_MEAS), np.zeros((_MEAS, _MEAS))])
        R = np.eye(_MEAS) * _R_MEAS
        self._kf = KalmanFilter(x0, P0, H, R)
        self._floor_dims()

    def predict(self, dt: float) -> None:
        """Roll the box forward by ``dt`` seconds along its estimated rates."""
        step = float(dt) if math.isfinite(float(dt)) and dt > 0.0 else 0.0
        self._kf.predict(_transition(step), _process_noise(step))
        self._floor_dims()

    def correct(self, cx: float, cy: float, w: float, h: float) -> bool:
        """Absorb a measurement. False when the correction was refused."""
        accepted = self._kf.correct((cx, cy, w, h))
        if accepted:
            self._floor_dims()
        return accepted

    def _floor_dims(self) -> None:
        dims = self._kf.x[2:_MEAS]
        self._kf.x[2:_MEAS] = np.where(dims < _MIN_DIM, _MIN_DIM, dims)

    @property
    def state(self) -> np.ndarray:
        """The full 8-vector [cx, cy, w, h, vcx, vcy, vw, vh] (a copy)."""
        return self._kf.x.copy()

    @property
    def centre(self) -> Tuple[float, float]:
        return float(self._kf.x[0]), float(self._kf.x[1])

    @property
    def size(self) -> Tuple[float, float]:
        return float(self._kf.x[2]), float(self._kf.x[3])

    @property
    def bbox(self) -> Tuple[float, float, float, float]:
        """Top-left (x, y, w, h) derived from the filtered centre and size."""
        cx, cy = self.centre
        w, h = self.size
        return (cx - 0.5 * w, cy - 0.5 * h, w, h)


# ---------------------------------------------------------------------------
# Tracks, IoU, association
# ---------------------------------------------------------------------------
@dataclass
class Track:
    """A single tracked person."""
    id: int
    kf: BoxFilter
    conf: float
    hits: int = 1                   # successful associations (incl. birth)
    age: int = 0                    # frames since birth
    time_since_update: float = 0.0  # seconds without a measurement
    last_ts: float = 0.0

    @property
    def bbox(self) -> Tuple[float, float, float, float]:
        return self.kf.bbox

    @property
    def cx(self) -> float:
        return self.kf.centre[0]

    @property
    def cy(self) -> float:
        return self.kf.centre[1]

    @property
    def height(self) -> float:
        return self.kf.size[1]


def _iou_matrix(dets: np.ndarray, trks: np.ndarray) -> np.ndarray:
    """IoU of every (x, y, w, h) row in ``dets`` (n) against ``trks`` (m) -> (n, m)."""
    d_lo = dets[:, None, :2]
    d_hi = d_lo + dets[:, None, 2:]
    t_lo = trks[None, :, :2]
    t_hi = t_lo + trks[None, :, 2:]
    overlap = np.clip(np.minimum(d_hi, t_hi) - np.maximum(d_lo, t_lo), 0.0, None)
    inter = overlap[..., 0] * overlap[..., 1]
    union = (dets[:, 2] * dets[:, 3])[:, None] + (trks[:, 2] * trks[:, 3])[None, :] - inter
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = inter / union
    return np.where((inter > 0.0) & (union > 0.0), ratio, 0.0)


def iou(a: Tuple[float, float, float, float],
        b: Tuple[float, float, float, float]) -> float:
    """IoU of two (x, y, w, h) boxes; 0.0 when they do not overlap."""
    boxes_a = np.array([a], dtype=float)
    boxes_b = np.array([b], dtype=float)
    return float(_iou_matrix(boxes_a, boxes_b)[0, 0])


def _greedy_pairs(scores: np.ndarray, threshold: float) -> List[Tuple[int, int]]:
    """Best-first one-to-one assignment over a (dets x tracks) score matrix."""
    pairs: List[Tuple[int, int]] = []
    if scores.size == 0:
        return pairs
    remaining = scores.astype(float, copy=True)
    columns = remaining.shape[1]
    while True:
        flat = int(np.argmax(remaining))
        row, col = divmod(flat, columns)
        best = remaining[row, col]
        if best < 0.0 or best < threshold:
            break
        pairs.append((row, col))
        remaining[row, :] = -1.0
        remaining[:, col] = -1.0
    return pairs


def _measurement(obs: Any) -> Optional[Tuple[float, float, float, float]]:
    """(cx, cy, w, h) for a detection with a finite 4-box and confidence, else None."""
    try:
        x, y, w, h = (float(v) for v in obs.bbox)
        conf = float(obs.conf)
    except (AttributeError, TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in (x, y, w, h, conf)):
        return None
    return (x + 0.5 * w, y + 0.5 * h, w, h)


def _corner_box(measurement: Tuple[float, float, float, float]) -> Tuple[float, float, float, float]:
    cx, cy, w, h = measurement
    return (cx - 0.5 * w, cy - 0.5 * h, w, h)


def _unit_interval(v: float) -> float:
    """Clip to [0, 1]; a non-finite value becomes 0.0, never 1.0.

    ``min(1.0, nan)`` is 1.0 under CPython, which would paint a poisoned track
    as a full-frame box in the operator's UI.
    """
    if not math.isfinite(v):
        return 0.0
    return 0.0 if v < 0.0 else 1.0 if v > 1.0 else v


# Overall state when NO lock is held, indexed [previous state][tracks exist].
# Once the tracker has left ``idle`` it never returns there.
_UNLOCKED_NEXT: Dict[TrackingState, Tuple[TrackingState, TrackingState]] = {
    TrackingState.IDLE: (TrackingState.IDLE, TrackingState.SEARCHING),
    TrackingState.SEARCHING: (TrackingState.SEARCHING, TrackingState.SEARCHING),
    TrackingState.LOCKED: (TrackingState.LOST, TrackingState.LOST),
    TrackingState.LOST: (TrackingState.SEARCHING, TrackingState.SEARCHING),
}

# Auto-lock preference: confidence first, centrality second.
_CONF_WEIGHT = 0.7
_CENTRE_WEIGHT = 0.3
_HALF_DIAGONAL = math.sqrt(0.5)   # farthest a centre can be from (0.5, 0.5)


def _lock_score(track: Track) -> float:
    off_centre = math.hypot(track.cx - 0.5, track.cy - 0.5) / _HALF_DIAGONAL
    centrality = 1.0 - min(1.0, off_centre)
    return _CONF_WEIGHT * track.conf + _CENTRE_WEIGHT * centrality


# ---------------------------------------------------------------------------
# The tracker
# ---------------------------------------------------------------------------
class Tracker:
    """Single-target multi-object tracker with stable ids and one lock.

    Args:
      iou_threshold: minimum IoU for a detection to associate to a track.
      max_age: seconds a track may go unmeasured before it is deleted.
      lost_timeout: seconds the LOCKED track may go unmeasured before the
        overall state degrades from 'locked' (coasting) to 'lost'.
      min_hits: associations before a track is confirmed (surfaced and
        eligible for auto-lock).
      vfov_deg / frame_h_px / person_height_m: distance-estimator intrinsics.
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
        self._ids = iter(range(1, 2 ** 62))
        self._locked_id: Optional[int] = None
        self._requested_id: Optional[int] = None
        self._state: TrackingState = TrackingState.IDLE
        self._clock: Optional[float] = None

    # ---- public lock control ----------------------------------------------
    def select(self, target_id: Optional[int]) -> None:
        """Ask for a lock on ``target_id`` (applied on the next ``update``).

        The request stays pending until a track with that id exists. ``None``
        drops the lock immediately and returns to auto-selection.
        """
        self._requested_id = target_id
        if target_id is None:
            self._locked_id = None

    @property
    def locked_id(self) -> Optional[int]:
        return self._locked_id

    @property
    def state(self) -> TrackingState:
        return self._state

    # ---- main step ---------------------------------------------------------
    def update(
        self,
        observations: Sequence[TargetObservation],
        ts: Optional[float] = None,
    ) -> "TrackingResult":
        """Ingest one frame of detections and advance every track.

        ``ts`` defaults to the first admitted detection's timestamp, then to
        the previous frame's, then to 0.0. Time never runs backwards: a
        non-increasing or non-finite timestamp is a zero-length step.
        """
        admitted = []
        for obs in (observations or []):
            z = _measurement(obs)
            if z is not None:
                admitted.append((obs, z))

        ts = self._resolve_ts(ts, admitted)
        dt = self._advance(ts)

        for track in self._tracks.values():
            track.kf.predict(dt)
            track.age += 1
            track.time_since_update += dt

        matched = self._associate(admitted, ts)
        for index, (obs, z) in enumerate(admitted):
            if index not in matched:
                self._spawn(obs, z, ts)

        self._cull()
        self._resolve_lock()
        self._state = self._transition()
        return self._snapshot(ts)

    # ---- internals ---------------------------------------------------------
    def _resolve_ts(self, ts: Optional[float], admitted: list) -> float:
        candidates = [ts]
        if admitted:
            candidates.append(getattr(admitted[0][0], "ts", None))
        candidates.append(self._clock)
        for candidate in candidates:
            if candidate is None:
                continue
            try:
                value = float(candidate)
            except (TypeError, ValueError):
                continue
            if math.isfinite(value):
                return value
        return 0.0

    def _advance(self, ts: float) -> float:
        dt = 0.0 if self._clock is None else max(0.0, ts - self._clock)
        self._clock = ts
        return dt

    def _associate(self, admitted: list, ts: float) -> set:
        """Match admitted detections to live tracks; returns matched det indices."""
        ids = list(self._tracks)
        if not admitted or not ids:
            return set()
        det_boxes = np.array([_corner_box(z) for _, z in admitted], dtype=float)
        trk_boxes = np.array([self._tracks[i].bbox for i in ids], dtype=float)
        pairs = _greedy_pairs(_iou_matrix(det_boxes, trk_boxes), float(self.iou_threshold))

        matched: set = set()
        for det_index, trk_index in pairs:
            obs, z = admitted[det_index]
            track = self._tracks[ids[trk_index]]
            track.kf.correct(*z)
            track.conf = float(obs.conf)
            track.hits += 1
            track.time_since_update = 0.0
            track.last_ts = ts
            matched.add(det_index)
        return matched

    def _spawn(self, obs: TargetObservation, z: Tuple[float, float, float, float], ts: float) -> Track:
        track = Track(id=next(self._ids), kf=BoxFilter(*z), conf=float(obs.conf), last_ts=ts)
        self._tracks[track.id] = track
        return track

    def _cull(self) -> None:
        expired = [tid for tid, tr in self._tracks.items() if tr.time_since_update > self.max_age]
        for tid in expired:
            del self._tracks[tid]
        if self._locked_id is not None and self._locked_id not in self._tracks:
            self._locked_id = None

    def _confirmed(self, track: Track) -> bool:
        return track.hits >= self.min_hits

    def _resolve_lock(self) -> None:
        if self._requested_id is not None and self._requested_id in self._tracks:
            self._locked_id = self._requested_id
            self._requested_id = None
        if self._locked_id in self._tracks:
            return                      # live lock survives (coasting)
        candidates = [tr for tr in self._tracks.values() if self._confirmed(tr)]
        self._locked_id = max(candidates, key=_lock_score).id if candidates else None

    def _transition(self) -> TrackingState:
        lock = self._tracks.get(self._locked_id) if self._locked_id is not None else None
        if lock is not None:
            fresh = lock.time_since_update <= self.lost_timeout
            return TrackingState.LOCKED if fresh else TrackingState.LOST
        return _UNLOCKED_NEXT[self._state][1 if self._tracks else 0]

    def _snapshot(self, ts: float) -> "TrackingResult":
        views: List[DetectedTargetView] = []
        for track in self._tracks.values():
            locked = track.id == self._locked_id
            if not (locked or self._confirmed(track)):
                continue                # unconfirmed flicker is not selectable
            views.append(
                DetectedTargetView(
                    id=track.id,
                    bbox=tuple(_unit_interval(v) for v in track.bbox),
                    confidence=track.conf,
                    is_locked=locked,
                )
            )

        lock = self._tracks.get(self._locked_id) if self._locked_id is not None else None
        distance = None if lock is None else estimate_distance(
            lock.height,
            person_height_m=self.person_height_m,
            vfov_deg=self.vfov_deg,
            frame_h_px=self.frame_h_px,
        )
        return TrackingResult(
            state=self._state,
            targets=views,
            locked_target_id=self._locked_id,
            estimated_distance=distance,
            ts=ts,
        )


# ---------------------------------------------------------------------------
# Result shapes (mirror the contract TrackingStatus / DetectedTarget)
# ---------------------------------------------------------------------------
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
        for target in self.targets:
            if target.is_locked:
                return target.bbox
        return None


__all__ = [
    "Tracker",
    "Track",
    "TrackingResult",
    "DetectedTargetView",
    "KalmanFilter",
    "BoxFilter",
    "iou",
]
