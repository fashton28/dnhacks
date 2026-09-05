"""
Tracking tests.

Proves:
  * IoU helper correctness,
  * stable id assignment across frames (a moving person keeps its id),
  * single-target auto-lock (highest-confidence / most-central),
  * explicit selection via select(id),
  * lock acquire -> coast-through-occlusion -> lost -> searching transitions,
  * estimatedDistance is produced for the locked target.

Requires numpy (the per-track Kalman filter). numpy + stdlib only.
"""
from __future__ import annotations

import pytest

np = pytest.importorskip("numpy")

from eis_companion.control.tracker import Tracker, iou
from eis_companion.types import TargetObservation, TrackingState


def obs(x, y, w, h, conf=0.9, ts=0.0) -> TargetObservation:
    return TargetObservation(bbox=(x, y, w, h), conf=conf, ts=ts)


# --------------------------------------------------------------------------
# IoU
# --------------------------------------------------------------------------
def test_iou_identical():
    assert iou((0, 0, 1, 1), (0, 0, 1, 1)) == pytest.approx(1.0)


def test_iou_disjoint():
    assert iou((0, 0, 0.1, 0.1), (0.5, 0.5, 0.1, 0.1)) == 0.0


def test_iou_half_overlap():
    # two unit boxes overlapping in half their area
    val = iou((0, 0, 1.0, 1.0), (0.5, 0.0, 1.0, 1.0))
    assert 0.3 < val < 0.34  # 0.5 / 1.5


# --------------------------------------------------------------------------
# Stable ids across frames
# --------------------------------------------------------------------------
def test_stable_id_for_moving_target():
    tr = Tracker(iou_threshold=0.2, min_hits=1)
    ids = []
    x = 0.4
    for i in range(10):
        res = tr.update([obs(x, 0.4, 0.1, 0.2, ts=i * 0.1)], ts=i * 0.1)
        x += 0.01  # drift right slowly
        if res.locked_target_id is not None:
            ids.append(res.locked_target_id)
    assert len(set(ids)) == 1, f"id changed across frames: {set(ids)}"


def test_two_targets_get_distinct_ids():
    tr = Tracker(iou_threshold=0.2, min_hits=1)
    res = None
    for i in range(4):
        res = tr.update(
            [obs(0.1, 0.4, 0.1, 0.2, ts=i * 0.1),
             obs(0.7, 0.4, 0.1, 0.2, ts=i * 0.1)],
            ts=i * 0.1,
        )
    ids = {t.id for t in res.targets}
    assert len(ids) == 2


# --------------------------------------------------------------------------
# Locking
# --------------------------------------------------------------------------
def test_autolock_prefers_central_high_confidence():
    tr = Tracker(iou_threshold=0.2, min_hits=1)
    res = None
    for i in range(4):
        res = tr.update(
            [
                obs(0.05, 0.05, 0.08, 0.15, conf=0.6, ts=i * 0.1),   # corner, lower conf
                obs(0.46, 0.42, 0.10, 0.18, conf=0.95, ts=i * 0.1),  # central, high conf
            ],
            ts=i * 0.1,
        )
    locked = res.locked_target_id
    assert locked is not None
    locked_box = next(t for t in res.targets if t.id == locked)
    # the central, high-confidence target should win
    cx = locked_box.bbox[0] + locked_box.bbox[2] / 2.0
    assert 0.4 < cx < 0.6


def test_state_becomes_locked():
    tr = Tracker(iou_threshold=0.2, min_hits=2)
    res = None
    for i in range(5):
        res = tr.update([obs(0.45, 0.4, 0.1, 0.2, ts=i * 0.1)], ts=i * 0.1)
    assert res.state == TrackingState.LOCKED
    assert res.locked_target_id is not None


def test_explicit_select_overrides_autolock():
    tr = Tracker(iou_threshold=0.2, min_hits=1)
    # establish two tracks
    for i in range(3):
        tr.update(
            [obs(0.1, 0.4, 0.1, 0.2, conf=0.95, ts=i * 0.1),
             obs(0.7, 0.4, 0.1, 0.2, conf=0.6, ts=i * 0.1)],
            ts=i * 0.1,
        )
    res = tr.update(
        [obs(0.1, 0.4, 0.1, 0.2, conf=0.95, ts=0.4),
         obs(0.7, 0.4, 0.1, 0.2, conf=0.6, ts=0.4)],
        ts=0.4,
    )
    # find the id of the right-hand (lower-conf) target and lock it explicitly
    right = max(res.targets, key=lambda t: t.bbox[0])
    tr.select(right.id)
    res2 = tr.update(
        [obs(0.1, 0.4, 0.1, 0.2, conf=0.95, ts=0.5),
         obs(0.7, 0.4, 0.1, 0.2, conf=0.6, ts=0.5)],
        ts=0.5,
    )
    assert res2.locked_target_id == right.id


# --------------------------------------------------------------------------
# Lifecycle: lock -> occlusion coast -> lost -> searching
# --------------------------------------------------------------------------
def test_lock_coasts_then_lost_then_searching():
    tr = Tracker(iou_threshold=0.2, min_hits=2, lost_timeout=0.5, max_age=5.0)
    t = 0.0
    # acquire lock
    for _ in range(4):
        res = tr.update([obs(0.45, 0.4, 0.1, 0.2, ts=t)], ts=t)
        t += 0.1
    assert res.state == TrackingState.LOCKED
    locked_id = res.locked_target_id

    # brief occlusion (no detections) but within lost_timeout -> still LOCKED,
    # coasting on the Kalman prediction, same id retained.
    res = tr.update([], ts=t)
    t += 0.1
    assert res.state == TrackingState.LOCKED
    assert res.locked_target_id == locked_id

    # keep occluded past lost_timeout -> LOST
    for _ in range(8):
        res = tr.update([], ts=t)
        t += 0.1
    assert res.state in (TrackingState.LOST, TrackingState.SEARCHING)

    # eventually track is culled (>max_age) and with nothing seen -> searching
    for _ in range(60):
        res = tr.update([], ts=t)
        t += 0.1
    assert res.state in (TrackingState.SEARCHING, TrackingState.LOST, TrackingState.IDLE)
    assert res.locked_target_id is None


def test_reacquire_after_lost():
    tr = Tracker(iou_threshold=0.2, min_hits=2, lost_timeout=0.3, max_age=0.5)
    t = 0.0
    for _ in range(4):
        res = tr.update([obs(0.45, 0.4, 0.1, 0.2, ts=t)], ts=t)
        t += 0.1
    assert res.state == TrackingState.LOCKED

    # lose it entirely
    for _ in range(15):
        res = tr.update([], ts=t)
        t += 0.1
    assert res.locked_target_id is None

    # a new person appears -> tracker searches then re-locks
    for _ in range(5):
        res = tr.update([obs(0.5, 0.5, 0.1, 0.2, ts=t)], ts=t)
        t += 0.1
    assert res.state == TrackingState.LOCKED
    assert res.locked_target_id is not None


# --------------------------------------------------------------------------
# Estimated distance
# --------------------------------------------------------------------------
def test_estimated_distance_present_when_locked():
    tr = Tracker(iou_threshold=0.2, min_hits=1, vfov_deg=41.0, frame_h_px=720)
    res = None
    for i in range(3):
        res = tr.update([obs(0.45, 0.3, 0.1, 0.4, ts=i * 0.1)], ts=i * 0.1)
    assert res.locked_target_id is not None
    assert res.estimated_distance is not None
    assert res.estimated_distance > 0.0


def test_estimated_distance_none_when_idle():
    tr = Tracker()
    res = tr.update([], ts=0.0)
    assert res.locked_target_id is None
    assert res.estimated_distance is None


def test_closer_person_smaller_distance():
    """A taller bbox (closer person) yields a smaller estimated distance."""
    tr_far = Tracker(iou_threshold=0.2, min_hits=1)
    tr_near = Tracker(iou_threshold=0.2, min_hits=1)
    rf = rn = None
    for i in range(3):
        rf = tr_far.update([obs(0.45, 0.45, 0.08, 0.10, ts=i * 0.1)], ts=i * 0.1)
        rn = tr_near.update([obs(0.40, 0.20, 0.12, 0.50, ts=i * 0.1)], ts=i * 0.1)
    assert rf.estimated_distance > rn.estimated_distance


# --------------------------------------------------------------------------
# locked_bbox convenience
# --------------------------------------------------------------------------
def test_result_locked_bbox_matches_locked_target():
    tr = Tracker(iou_threshold=0.2, min_hits=1)
    res = None
    for i in range(3):
        res = tr.update([obs(0.45, 0.4, 0.1, 0.2, ts=i * 0.1)], ts=i * 0.1)
    lb = res.locked_bbox
    assert lb is not None
    locked = next(t for t in res.targets if t.is_locked)
    assert lb == locked.bbox
