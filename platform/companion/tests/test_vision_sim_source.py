"""The synthetic camera is the whole acceptance demo's perception rail.

`config/sitl.yaml` selects `camera: sim`, so `SimTargetSource` is what feeds
Tracker -> Guidance during the e2e gate. That makes three of its properties
load-bearing rather than decorative:

  * **Determinism.** A failing acceptance run has to reproduce, so the same
    seed must replay the same motion exactly.
  * **Scale.** The bbox geometry is what the distance estimator and the
    tracker's IoU association are calibrated against.
  * **Trackability.** Consecutive frames must overlap enough for the tracker
    to associate them within `min_hits`, and the target must actually move --
    a parked target would let guidance "converge" on nothing.

The rendered frame is checked against the observations it is supposed to
depict: a frame that draws the person somewhere other than where the
observation says would make every overlay a lie.
"""
from __future__ import annotations

import numpy as np
import pytest

from eis_companion.vision.sim_source import (
    BBOX_HEIGHT,
    BBOX_WIDTH,
    _PALETTE,
    SimTargetSource,
)


def iou(a, b) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return 0.0 if union <= 0 else inter / union


# ---------------------------------------------------------------------------
# Construction contract
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("count", [1, 2])
def test_one_or_two_targets_are_supported(count):
    assert SimTargetSource(num_targets=count).num_persons == count


@pytest.mark.parametrize("count", [0, -1, 3])
def test_any_other_target_count_is_refused(count):
    with pytest.raises(ValueError):
        SimTargetSource(num_targets=count)


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------

def test_the_same_seed_replays_the_same_motion():
    """An acceptance failure that cannot be replayed cannot be diagnosed."""
    left = SimTargetSource(seed=7)
    right = SimTargetSource(seed=7)
    for _ in range(120):
        a = [o.bbox for o in left.get_observations()]
        b = [o.bbox for o in right.get_observations()]
        assert a == b


def test_a_different_seed_lays_out_a_different_scene():
    a = SimTargetSource(seed=1).get_observations()
    b = SimTargetSource(seed=2).get_observations()
    assert [o.bbox for o in a] != [o.bbox for o in b]


def test_confidence_does_not_depend_on_object_identity():
    """The ripple used id(person) % 10, which is an ADDRESS: the same seed
    produced different confidences from run to run."""
    first = [round(o.conf, 12) for o in SimTargetSource(seed=3).get_observations()]
    second = [round(o.conf, 12) for o in SimTargetSource(seed=3).get_observations()]
    assert first == second


# ---------------------------------------------------------------------------
# Target geometry -- what the tracker + distance estimator are tuned to
# ---------------------------------------------------------------------------

def test_every_bbox_keeps_the_calibrated_person_scale():
    source = SimTargetSource(num_targets=2, seed=11)
    for _ in range(400):
        for obs in source.get_observations():
            x, y, w, h = obs.bbox
            assert w == pytest.approx(BBOX_WIDTH)
            assert h == pytest.approx(BBOX_HEIGHT)


def test_no_target_ever_leaves_the_frame():
    """A clipped bbox would shrink the apparent person and pull the distance
    estimate with it."""
    source = SimTargetSource(num_targets=2, seed=5)
    for _ in range(1200):
        for obs in source.get_observations():
            x, y, w, h = obs.bbox
            assert 0.0 <= x and x + w <= 1.0
            assert 0.0 <= y and y + h <= 1.0


def test_confidence_stays_in_the_detector_band():
    source = SimTargetSource(seed=13, base_confidence=0.92)
    for _ in range(300):
        for obs in source.get_observations():
            assert 0.5 <= obs.conf <= 1.0
            assert obs.conf == pytest.approx(0.92, abs=0.05)


# ---------------------------------------------------------------------------
# Trackability
# ---------------------------------------------------------------------------

def test_consecutive_frames_overlap_enough_for_iou_association():
    """Tracker association is IoU-based; a target that jumps between frames
    would never accumulate min_hits and 'locked' would be unreachable."""
    source = SimTargetSource(num_targets=2, seed=17)
    previous = [o.bbox for o in source.get_observations()]
    for _ in range(600):
        current = [o.bbox for o in source.get_observations()]
        for before, after in zip(previous, current):
            assert iou(before, after) > 0.9
        previous = current


def test_the_target_actually_walks():
    """A parked target lets guidance 'hold standoff' without ever tracking."""
    source = SimTargetSource(num_targets=1, seed=23)
    centres = []
    for _ in range(30 * 20):          # 20 simulated seconds
        obs = source.get_observations()[0]
        centres.append((obs.cx, obs.cy))
    span_x = max(c[0] for c in centres) - min(c[0] for c in centres)
    assert span_x > 0.05


def test_the_walk_stays_slow_enough_to_follow():
    source = SimTargetSource(num_targets=2, seed=29, fps=30.0)
    previous = [(o.cx, o.cy) for o in source.get_observations()]
    for _ in range(900):
        current = [(o.cx, o.cy) for o in source.get_observations()]
        for (px, py), (cx, cy) in zip(previous, current):
            step = ((cx - px) ** 2 + (cy - py) ** 2) ** 0.5
            assert step < 0.02          # << 0.6 normalised units/s at 30 fps
        previous = current


# ---------------------------------------------------------------------------
# Clock
# ---------------------------------------------------------------------------

def test_observations_and_frames_share_one_clock_and_each_step_it():
    source = SimTargetSource(fps=25.0)
    assert source.current_time == pytest.approx(0.0)
    source.get_observations()
    assert source.current_time == pytest.approx(1 / 25.0)
    source.render_frame()
    assert source.current_time == pytest.approx(2 / 25.0)


def test_advance_drives_the_clock_from_a_real_wall_clock():
    source = SimTargetSource()
    source.advance(0.5)
    assert source.current_time == pytest.approx(0.5)


def test_observe_is_the_perception_loop_alias_of_get_observations():
    """The orchestrator's perception loop calls source.observe()."""
    a = SimTargetSource(seed=31).observe()
    b = SimTargetSource(seed=31).get_observations()
    assert [o.bbox for o in a] == [o.bbox for o in b]
    assert [o.conf for o in a] == [o.conf for o in b]


# ---------------------------------------------------------------------------
# Rendered frame
# ---------------------------------------------------------------------------

def test_the_frame_is_a_bgr_uint8_image_of_the_configured_size():
    source = SimTargetSource(frame_width=320, frame_height=240)
    frame = source.render_frame()
    assert frame.shape == (240, 320, 3)
    assert frame.dtype == np.uint8
    assert source.frame_size == (320, 240)


def test_each_frame_is_an_independent_buffer():
    """A cached backdrop handed out by reference would accumulate every
    person ever drawn."""
    source = SimTargetSource(frame_width=160, frame_height=120)
    first = source.render_frame()
    second = source.render_frame()
    assert first is not second
    first[:] = 0
    assert second.any()


def test_the_person_is_drawn_where_the_observation_says_it_is():
    """The overlay and the detection must agree, or every operator-facing
    box is drawn against a body that is somewhere else."""
    boxes = [o.bbox for o in SimTargetSource(seed=41).get_observations()]
    frame = SimTargetSource(seed=41).render_frame()   # same seed, same t=0
    height, width = frame.shape[:2]

    for index, (x, y, w, h) in enumerate(boxes):
        colour = _PALETTE[index % len(_PALETTE)]
        x0, y0 = int(round(x * width)), int(round(y * height))
        x1, y1 = int(round((x + w) * width)), int(round((y + h) * height))
        body = frame[y0:y1, x0:x1]
        painted = np.all(body == np.array(colour, dtype=np.uint8), axis=2)
        assert painted.any(), f"person {index} is not drawn inside its bbox"
        # ...and it is not painted all over the rest of the frame.
        whole = np.all(frame == np.array(colour, dtype=np.uint8), axis=2)
        assert whole.sum() == painted.sum()


def test_a_single_target_scene_renders_one_person():
    frame = SimTargetSource(num_targets=1, seed=41).render_frame()
    second = np.all(frame == np.array(_PALETTE[1], dtype=np.uint8), axis=2)
    assert not second.any()
