"""
Tracker lifecycle, lock arbitration, timing and the filters underneath.

  * the idle / searching / locked / lost transitions, tick by tick,
  * a lost target never drags the tracker back to idle, and re-acquisition
    mints a new id,
  * ``select`` semantics: pending until the id exists, ``None`` returns to
    auto-selection, an explicitly selected unconfirmed track is surfaced,
  * a coasting lock keeps moving along its estimated velocity,
  * timestamps never run backwards and default sensibly,
  * the generic Kalman filter refuses what it cannot compute.
"""
from __future__ import annotations

import math

import pytest

np = pytest.importorskip("numpy")

from eis_companion.control.tracker import (  # noqa: E402
    BoxFilter,
    KalmanFilter,
    Tracker,
    iou,
)
from eis_companion.types import TargetObservation, TrackingState  # noqa: E402

DT = 0.1
IDLE, SEARCHING, LOCKED, LOST = (
    TrackingState.IDLE, TrackingState.SEARCHING, TrackingState.LOCKED, TrackingState.LOST,
)


def det(x, y, w=0.1, h=0.2, conf=0.9, ts=0.0) -> TargetObservation:
    return TargetObservation(bbox=(x, y, w, h), conf=conf, ts=ts)


# --------------------------------------------------------------------------
# State machine
# --------------------------------------------------------------------------
def test_first_empty_frame_is_idle():
    assert Tracker().update([], ts=0.0).state == IDLE


def test_an_unconfirmed_track_means_searching_and_is_not_surfaced():
    tracker = Tracker(min_hits=2)
    result = tracker.update([det(0.45, 0.4)], ts=0.0)
    assert result.state == SEARCHING
    assert result.targets == []
    assert result.locked_target_id is None


def test_confirmation_locks_and_surfaces_the_track():
    tracker = Tracker(min_hits=2)
    tracker.update([det(0.45, 0.4)], ts=0.0)
    result = tracker.update([det(0.45, 0.4)], ts=DT)
    assert result.state == LOCKED
    assert [t.is_locked for t in result.targets] == [True]
    assert result.locked_target_id == result.targets[0].id


def test_exact_lifecycle_tick_by_tick():
    tracker = Tracker(min_hits=2, lost_timeout=0.25, max_age=0.6)
    t = 0.0
    for _ in range(2):
        tracker.update([det(0.45, 0.4)], ts=t)
        t += DT
    assert tracker.state == LOCKED

    expected = [LOCKED, LOCKED, LOST, LOST, LOST, LOST, SEARCHING, SEARCHING]
    observed = []
    for _ in expected:
        observed.append(tracker.update([], ts=t).state)
        t += DT
    assert observed == expected


def test_once_left_idle_is_never_revisited():
    tracker = Tracker(min_hits=1, lost_timeout=0.1, max_age=0.1)
    tracker.update([det(0.45, 0.4)], ts=0.0)
    states = {tracker.update([], ts=0.5 + i * DT).state for i in range(30)}
    assert IDLE not in states
    assert states == {LOST, SEARCHING}


def test_reacquisition_mints_a_new_id():
    tracker = Tracker(min_hits=1, lost_timeout=0.1, max_age=0.2)
    first = tracker.update([det(0.45, 0.4)], ts=0.0).locked_target_id
    for i in range(5):
        tracker.update([], ts=0.1 + i * DT)
    assert tracker.locked_id is None
    second = tracker.update([det(0.45, 0.4)], ts=1.0).locked_target_id
    assert second is not None and second != first
    assert second > first


# --------------------------------------------------------------------------
# select()
# --------------------------------------------------------------------------
def two_people(tracker: Tracker, frames: int = 3):
    result = None
    for i in range(frames):
        result = tracker.update(
            [det(0.1, 0.4, conf=0.95, ts=i * DT), det(0.7, 0.4, conf=0.6, ts=i * DT)],
            ts=i * DT,
        )
    return result


def test_select_none_drops_the_lock_and_resumes_auto_selection():
    tracker = Tracker(min_hits=1)
    result = two_people(tracker)
    strong = min(result.targets, key=lambda t: t.bbox[0]).id
    weak = max(result.targets, key=lambda t: t.bbox[0]).id
    tracker.select(weak)
    assert two_people(tracker).locked_target_id == weak
    tracker.select(None)
    assert tracker.locked_id is None
    assert two_people(tracker).locked_target_id == strong


def test_select_of_an_unknown_id_stays_pending_until_it_appears():
    tracker = Tracker(min_hits=1)
    result = two_people(tracker)
    current = result.locked_target_id
    tracker.select(3)                                     # not born yet
    assert two_people(tracker).locked_target_id == current
    result = tracker.update(
        [det(0.1, 0.4, conf=0.95), det(0.7, 0.4, conf=0.6), det(0.4, 0.8, conf=0.5)], ts=1.0
    )
    assert result.locked_target_id == 3


def test_an_explicitly_selected_unconfirmed_track_is_surfaced_as_locked():
    tracker = Tracker(min_hits=5)
    tracker.update([det(0.45, 0.4)], ts=0.0)
    tracker.select(1)
    result = tracker.update([det(0.45, 0.4)], ts=DT)
    assert result.locked_target_id == 1
    assert [(t.id, t.is_locked) for t in result.targets] == [(1, True)]
    assert result.state == LOCKED


def test_auto_lock_survives_a_stronger_late_arrival():
    """A live lock is not stolen by a newcomer; the operator must select it."""
    tracker = Tracker(min_hits=1)
    first = tracker.update([det(0.7, 0.4, conf=0.6)], ts=0.0).locked_target_id
    for i in range(1, 4):
        result = tracker.update(
            [det(0.7, 0.4, conf=0.6, ts=i * DT), det(0.45, 0.4, conf=0.99, ts=i * DT)], ts=i * DT
        )
    assert result.locked_target_id == first


# --------------------------------------------------------------------------
# Coasting
# --------------------------------------------------------------------------
def test_a_coasting_lock_keeps_moving_along_its_velocity():
    tracker = Tracker(min_hits=2, lost_timeout=1.0, max_age=2.0)
    x = 0.2
    for i in range(10):
        tracker.update([det(x, 0.4)], ts=i * DT)
        x += 0.02
    last_x = tracker.update([], ts=1.0).locked_bbox[0]
    for i in range(1, 4):
        result = tracker.update([], ts=1.0 + i * DT)
        assert result.state == LOCKED
        assert result.locked_bbox[0] > last_x
        last_x = result.locked_bbox[0]


def test_a_coasting_track_reassociates_with_the_reappearing_person():
    tracker = Tracker(min_hits=2, lost_timeout=1.0, max_age=2.0, iou_threshold=0.3)
    x = 0.2
    for i in range(10):
        tracker.update([det(x, 0.4)], ts=i * DT)
        x += 0.02
    locked = tracker.locked_id
    for i in range(3):
        tracker.update([], ts=1.0 + i * DT)
        x += 0.02
    result = tracker.update([det(x, 0.4)], ts=1.4)
    assert result.locked_target_id == locked


# --------------------------------------------------------------------------
# Timing
# --------------------------------------------------------------------------
def test_time_never_runs_backwards():
    tracker = Tracker(min_hits=1, lost_timeout=0.2)
    tracker.update([det(0.45, 0.4)], ts=5.0)
    assert tracker.update([], ts=1.0).state == LOCKED       # dt clamps to 0
    assert tracker.update([], ts=float("nan")).state == LOCKED
    assert tracker.update([], ts=5.3).state == LOST


def test_ts_defaults_to_the_observation_then_to_the_last_frame():
    tracker = Tracker(min_hits=1)
    assert tracker.update([det(0.45, 0.4, ts=3.0)]).ts == 3.0
    assert tracker.update([]).ts == 3.0
    assert tracker.update([], ts=4.5).ts == 4.5


def test_first_frame_without_any_clue_is_at_zero():
    assert Tracker().update([]).ts == 0.0


# --------------------------------------------------------------------------
# Admission
# --------------------------------------------------------------------------
@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_non_finite_confidence_is_dropped(bad):
    tracker = Tracker(min_hits=1)
    result = tracker.update([TargetObservation(bbox=(0.4, 0.4, 0.1, 0.2), conf=bad)], ts=0.0)
    assert result.targets == [] and result.state == IDLE


def test_a_malformed_bbox_is_dropped():
    tracker = Tracker(min_hits=1)
    result = tracker.update([TargetObservation(bbox=(0.4, 0.4, 0.1), conf=0.9)], ts=0.0)
    assert result.targets == [] and result.state == IDLE


def test_surfaced_boxes_are_inside_the_unit_square():
    tracker = Tracker(min_hits=1)
    result = tracker.update([det(-0.3, 0.9, w=0.5, h=0.5)], ts=0.0)
    for value in result.targets[0].bbox:
        assert 0.0 <= value <= 1.0


# --------------------------------------------------------------------------
# Filters
# --------------------------------------------------------------------------
def test_kalman_predict_moves_with_velocity():
    kf = KalmanFilter(x0=[0.0, 1.0], P0=np.eye(2), H=[[1.0, 0.0]], R=[[1.0]])
    kf.predict(F=[[1.0, 0.5], [0.0, 1.0]], Q=np.zeros((2, 2)))
    assert kf.x[0] == pytest.approx(0.5)


def test_kalman_correct_pulls_toward_the_measurement():
    kf = KalmanFilter(x0=[0.0], P0=[[1.0]], H=[[1.0]], R=[[1.0]])
    assert kf.correct([2.0]) is True
    assert kf.x[0] == pytest.approx(1.0)                  # equal trust -> halfway
    assert kf.P[0, 0] == pytest.approx(0.5)


def test_kalman_refuses_a_singular_innovation():
    kf = KalmanFilter(x0=[1.0], P0=[[0.0]], H=[[0.0]], R=[[0.0]])
    assert kf.correct([5.0]) is False
    assert kf.x[0] == 1.0


def test_kalman_refuses_a_non_finite_measurement():
    kf = KalmanFilter(x0=[1.0], P0=[[1.0]], H=[[1.0]], R=[[1.0]])
    assert kf.correct([float("nan")]) is False
    assert kf.x[0] == 1.0 and math.isfinite(kf.P[0, 0])


def test_box_filter_dims_never_collapse():
    bf = BoxFilter(0.5, 0.5, 0.0, -1.0)
    assert min(bf.size) >= 1e-4
    bf.predict(1.0)
    assert min(bf.size) >= 1e-4


def test_box_filter_bbox_is_centre_minus_half_size():
    assert BoxFilter(0.5, 0.5, 0.2, 0.4).bbox == pytest.approx((0.4, 0.3, 0.2, 0.4))


@pytest.mark.parametrize("a, b, expected", [
    ((0, 0, 2, 2), (1, 1, 2, 2), 1.0 / 7.0),
    ((0, 0, 1, 1), (0, 0, 0.5, 0.5), 0.25),
    ((0, 0, 0, 0), (0, 0, 1, 1), 0.0),
])
def test_iou_values(a, b, expected):
    assert iou(a, b) == pytest.approx(expected)
