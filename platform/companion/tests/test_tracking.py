"""
Tracking behaviour.

Pinned here:
  * the IoU helper,
  * stable ids across frames (a moving person keeps its id; two people get
    two ids),
  * single-target auto-lock (confidence + centrality) and explicit
    ``select(id)`` override,
  * lock -> coast through occlusion -> lost -> searching, and re-acquisition,
  * ``estimated_distance`` is produced for the locked target only, and a
    taller box reads as closer,
  * ``TrackingResult.locked_bbox`` mirrors the locked target.

numpy + stdlib only (the Kalman filters need numpy).
"""
from __future__ import annotations

import pytest

np = pytest.importorskip("numpy")

from eis_companion.control.tracker import Tracker, iou  # noqa: E402
from eis_companion.types import TargetObservation, TrackingState  # noqa: E402

DT = 0.1


def box(x, y, w, h, conf=0.9, ts=0.0) -> TargetObservation:
    return TargetObservation(bbox=(x, y, w, h), conf=conf, ts=ts)


def run_frames(tracker: Tracker, frames, start: float = 0.0):
    """Feed ``frames`` (each a list of (x, y, w, h[, conf])) DT apart; return the last result."""
    result = None
    t = start
    for detections in frames:
        observations = [box(*d[:4], conf=(d[4] if len(d) > 4 else 0.9), ts=t) for d in detections]
        result = tracker.update(observations, ts=t)
        t += DT
    return result


# --------------------------------------------------------------------------
# IoU
# --------------------------------------------------------------------------
def test_iou_of_identical_boxes_is_one():
    assert iou((0, 0, 1, 1), (0, 0, 1, 1)) == pytest.approx(1.0)


def test_iou_of_disjoint_boxes_is_zero():
    assert iou((0, 0, 0.1, 0.1), (0.5, 0.5, 0.1, 0.1)) == 0.0


def test_iou_of_half_overlapping_unit_boxes():
    assert 0.3 < iou((0, 0, 1.0, 1.0), (0.5, 0.0, 1.0, 1.0)) < 0.34   # 0.5 / 1.5


# --------------------------------------------------------------------------
# Stable ids
# --------------------------------------------------------------------------
def test_a_drifting_person_keeps_one_id():
    tracker = Tracker(iou_threshold=0.2, min_hits=1)
    seen = set()
    for i in range(10):
        result = tracker.update([box(0.4 + 0.01 * i, 0.4, 0.1, 0.2, ts=i * DT)], ts=i * DT)
        if result.locked_target_id is not None:
            seen.add(result.locked_target_id)
    assert len(seen) == 1, f"id changed across frames: {seen}"


def test_two_people_get_two_ids():
    tracker = Tracker(iou_threshold=0.2, min_hits=1)
    pair = [(0.1, 0.4, 0.1, 0.2), (0.7, 0.4, 0.1, 0.2)]
    result = run_frames(tracker, [pair] * 4)
    assert len({t.id for t in result.targets}) == 2


# --------------------------------------------------------------------------
# Locking
# --------------------------------------------------------------------------
def test_autolock_prefers_the_central_confident_person():
    tracker = Tracker(iou_threshold=0.2, min_hits=1)
    corner_weak = (0.05, 0.05, 0.08, 0.15, 0.6)
    central_strong = (0.46, 0.42, 0.10, 0.18, 0.95)
    result = run_frames(tracker, [[corner_weak, central_strong]] * 4)
    assert result.locked_target_id is not None
    locked = next(t for t in result.targets if t.id == result.locked_target_id)
    assert 0.4 < locked.bbox[0] + locked.bbox[2] / 2.0 < 0.6


def test_state_becomes_locked_once_confirmed():
    tracker = Tracker(iou_threshold=0.2, min_hits=2)
    result = run_frames(tracker, [[(0.45, 0.4, 0.1, 0.2)]] * 5)
    assert result.state == TrackingState.LOCKED
    assert result.locked_target_id is not None


def test_explicit_select_overrides_autolock():
    tracker = Tracker(iou_threshold=0.2, min_hits=1)
    strong_left = (0.1, 0.4, 0.1, 0.2, 0.95)
    weak_right = (0.7, 0.4, 0.1, 0.2, 0.6)
    result = run_frames(tracker, [[strong_left, weak_right]] * 4)
    right = max(result.targets, key=lambda t: t.bbox[0])
    tracker.select(right.id)
    result = run_frames(tracker, [[strong_left, weak_right]], start=0.5)
    assert result.locked_target_id == right.id


# --------------------------------------------------------------------------
# Lifecycle: lock -> occlusion coast -> lost -> searching
# --------------------------------------------------------------------------
def test_lock_coasts_then_is_lost_then_searches():
    tracker = Tracker(iou_threshold=0.2, min_hits=2, lost_timeout=0.5, max_age=5.0)
    person = [(0.45, 0.4, 0.1, 0.2)]
    t = 0.0

    result = run_frames(tracker, [person] * 4, start=t)
    t += 4 * DT
    assert result.state == TrackingState.LOCKED
    locked_id = result.locked_target_id

    # one blank frame inside lost_timeout: still LOCKED, coasting, same id
    result = tracker.update([], ts=t)
    t += DT
    assert result.state == TrackingState.LOCKED
    assert result.locked_target_id == locked_id

    # blank past lost_timeout -> LOST
    result = run_frames(tracker, [[]] * 8, start=t)
    t += 8 * DT
    assert result.state in (TrackingState.LOST, TrackingState.SEARCHING)

    # blank past max_age -> track culled, nothing to lock
    result = run_frames(tracker, [[]] * 60, start=t)
    assert result.state in (TrackingState.SEARCHING, TrackingState.LOST, TrackingState.IDLE)
    assert result.locked_target_id is None


def test_reacquires_after_losing_the_lock():
    tracker = Tracker(iou_threshold=0.2, min_hits=2, lost_timeout=0.3, max_age=0.5)
    result = run_frames(tracker, [[(0.45, 0.4, 0.1, 0.2)]] * 4)
    assert result.state == TrackingState.LOCKED

    result = run_frames(tracker, [[]] * 15, start=0.4)
    assert result.locked_target_id is None

    result = run_frames(tracker, [[(0.5, 0.5, 0.1, 0.2)]] * 5, start=1.9)
    assert result.state == TrackingState.LOCKED
    assert result.locked_target_id is not None


# --------------------------------------------------------------------------
# Estimated distance
# --------------------------------------------------------------------------
def test_distance_present_for_the_locked_target():
    tracker = Tracker(iou_threshold=0.2, min_hits=1, vfov_deg=41.0, frame_h_px=720)
    result = run_frames(tracker, [[(0.45, 0.3, 0.1, 0.4)]] * 3)
    assert result.locked_target_id is not None
    assert result.estimated_distance is not None
    assert result.estimated_distance > 0.0


def test_distance_absent_when_idle():
    result = Tracker().update([], ts=0.0)
    assert result.locked_target_id is None
    assert result.estimated_distance is None


def test_taller_box_reads_closer():
    far = run_frames(Tracker(iou_threshold=0.2, min_hits=1), [[(0.45, 0.45, 0.08, 0.10)]] * 3)
    near = run_frames(Tracker(iou_threshold=0.2, min_hits=1), [[(0.40, 0.20, 0.12, 0.50)]] * 3)
    assert far.estimated_distance > near.estimated_distance


# --------------------------------------------------------------------------
# locked_bbox convenience
# --------------------------------------------------------------------------
def test_locked_bbox_mirrors_the_locked_target():
    result = run_frames(Tracker(iou_threshold=0.2, min_hits=1), [[(0.45, 0.4, 0.1, 0.2)]] * 3)
    assert result.locked_bbox is not None
    assert result.locked_bbox == next(t for t in result.targets if t.is_locked).bbox
