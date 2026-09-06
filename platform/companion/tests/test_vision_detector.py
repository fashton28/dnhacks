"""The detector's fallback behaviour is what keeps a dev box flyable.

`ultralytics`/`torch` are an OPTIONAL extra. Every consumer -- the
orchestrator's `_build_vision_source`, `StagingObserver._resolve_backend` --
is written around two promises this module makes:

  1. importing `eis_companion.vision.detector` never needs ultralytics, and
  2. constructing `PersonDetector` raises `ImportError` (not TypeError, not
     AttributeError) when it is absent, so "no hardware" stays distinguishable
     from "wiring bug" (FM-101).

Plus the observation-state invariant (FM-100): `detect()` returns `[]` both
for "a healthy frame with nobody in it" and for "inference failed", and
`last_inference_failed` is the only thing that separates them. Those support
opposite incident verdicts, so the flag is tested on every path.
"""
from __future__ import annotations

import importlib.util
import sys
from types import SimpleNamespace

import numpy as np
import pytest

from eis_companion.types import TargetObservation
from eis_companion.vision import detector as det_mod
from eis_companion.vision.detector import (
    DEFAULT_CONF_THRESHOLD,
    DEFAULT_WEIGHTS,
    ENGINE_PATH_ENV,
    MODEL_PATH_ENV,
    SUPPORTED_CLASSES,
    PersonDetector,
    observations_from_results,
    resolve_weights,
)

ULTRALYTICS_PRESENT = importlib.util.find_spec("ultralytics") is not None


# ---------------------------------------------------------------------------
# Import-time contract
# ---------------------------------------------------------------------------

def test_the_module_imports_without_the_detect_extra():
    """`from eis_companion.vision import PersonDetector` runs on every box."""
    assert "ultralytics" not in sys.modules or ULTRALYTICS_PRESENT
    assert SUPPORTED_CLASSES == ("person",)
    assert PersonDetector.supported_classes == SUPPORTED_CLASSES


def test_the_confidence_gate_never_rises_above_the_scripted_cues():
    """Pinned here too: staging stubs must stay reachable by the real backend
    (FM-121). The relationship itself is asserted in test_perception_honesty."""
    assert 0.0 < DEFAULT_CONF_THRESHOLD <= 0.32


@pytest.mark.skipif(ULTRALYTICS_PRESENT, reason="the [detect] extra is installed")
def test_construction_without_ultralytics_raises_importerror_with_a_hint():
    with pytest.raises(ImportError) as excinfo:
        PersonDetector()
    assert "pip install ultralytics" in str(excinfo.value)


def test_a_broken_ultralytics_import_is_still_an_importerror(monkeypatch):
    """Whatever the loader failure, callers must see ImportError -- they catch
    exactly that to fall back to synthetic detections."""
    def boom():
        raise ImportError("torch: undefined symbol")

    monkeypatch.setattr(det_mod, "_load_yolo", boom)
    with pytest.raises(ImportError):
        PersonDetector()


# ---------------------------------------------------------------------------
# Weights resolution: argument > environment > packaged default
# ---------------------------------------------------------------------------

def test_an_existing_engine_wins_and_is_loaded_as_tensorrt():
    weights = resolve_weights("/models/y.engine", "/models/y.pt",
                              environ={}, exists=lambda p: True)
    assert weights.path == "/models/y.engine"
    assert weights.tensorrt is True
    assert weights.load_kwargs == {"task": "detect"}


def test_a_missing_engine_demotes_to_the_checkpoint():
    weights = resolve_weights("/models/typo.engine", "/models/y.pt",
                              environ={}, exists=lambda p: False)
    assert weights.path == "/models/y.pt"
    assert weights.tensorrt is False
    assert weights.load_kwargs == {}


def test_the_environment_supplies_paths_when_arguments_do_not():
    env = {ENGINE_PATH_ENV: "/env/y.engine", MODEL_PATH_ENV: "/env/y.pt"}
    assert resolve_weights(environ=env, exists=lambda p: True).path == "/env/y.engine"
    assert resolve_weights(environ=env, exists=lambda p: False).path == "/env/y.pt"


def test_arguments_beat_the_environment():
    env = {ENGINE_PATH_ENV: "/env/y.engine", MODEL_PATH_ENV: "/env/y.pt"}
    weights = resolve_weights(model_path="/arg/y.pt", environ=env,
                              exists=lambda p: False)
    assert weights.path == "/arg/y.pt"


def test_with_nothing_configured_the_packaged_default_is_used():
    weights = resolve_weights(environ={}, exists=lambda p: False)
    assert weights.path == DEFAULT_WEIGHTS
    assert weights.tensorrt is False


# ---------------------------------------------------------------------------
# Result conversion
# ---------------------------------------------------------------------------

def box(cls, conf, xyxy):
    return SimpleNamespace(
        cls=[SimpleNamespace(item=lambda v=cls: v)],
        conf=[SimpleNamespace(item=lambda v=conf: v)],
        xyxy=[SimpleNamespace(tolist=lambda v=xyxy: list(v))],
    )


def result(*boxes):
    return SimpleNamespace(boxes=list(boxes))


def test_pixel_boxes_become_normalised_xywh():
    got = observations_from_results(
        [result(box(0, 0.9, (100, 50, 300, 400)))], (500, 1000), 0.3, 1.0,
    )
    assert len(got) == 1
    assert got[0].bbox == pytest.approx((0.1, 0.1, 0.2, 0.7))
    assert got[0].conf == pytest.approx(0.9)
    assert got[0].ts == 1.0


def test_boxes_running_off_the_frame_are_clamped_into_range():
    got = observations_from_results(
        [result(box(0, 0.8, (-40, -20, 1200, 700)))], (500, 1000), 0.3, 0.0,
    )
    x, y, w, h = got[0].bbox
    assert (x, y) == (0.0, 0.0)
    assert 0.0 <= w <= 1.0 and 0.0 <= h <= 1.0
    assert x + w <= 1.0 and y + h <= 1.0


def test_non_person_classes_and_sub_threshold_boxes_are_dropped():
    got = observations_from_results(
        [result(
            box(2, 0.99, (0, 0, 10, 10)),      # a car
            box(0, 0.10, (0, 0, 10, 10)),      # too unsure
            box(0, 0.55, (0, 0, 10, 10)),      # keeper
        )],
        (100, 100), 0.3, 0.0,
    )
    assert [round(o.conf, 2) for o in got] == [0.55]


def test_detections_come_back_most_confident_first():
    got = observations_from_results(
        [result(
            box(0, 0.42, (0, 0, 10, 10)),
            box(0, 0.91, (0, 0, 10, 10)),
            box(0, 0.66, (0, 0, 10, 10)),
        )],
        (100, 100), 0.3, 0.0,
    )
    assert [round(o.conf, 2) for o in got] == [0.91, 0.66, 0.42]


def test_a_result_without_boxes_is_skipped_not_crashed_on():
    assert observations_from_results(
        [SimpleNamespace(boxes=None), result()], (100, 100), 0.3, 0.0,
    ) == []


def test_every_observation_is_a_person_target_observation():
    got = observations_from_results(
        [result(box(0, 0.9, (0, 0, 10, 10)))], (100, 100), 0.3, 0.0,
    )
    assert isinstance(got[0], TargetObservation)
    assert got[0].cls == "person"          # the person-tracking wire (FM-122)


# ---------------------------------------------------------------------------
# detect(): the observation-state invariant (FM-100)
# ---------------------------------------------------------------------------

def detector(predict):
    """A PersonDetector wired to a fake model, bypassing the YOLO load."""
    det = PersonDetector.__new__(PersonDetector)
    det._conf = 0.3
    det._device = "cpu"
    det._imgsz = 640
    det._half = False
    det._model = SimpleNamespace(predict=predict)
    det.weights = det_mod.Weights(path="fake.pt", tensorrt=False)
    det.last_inference_ms = 0.0
    det.last_inference_failed = False
    return det


FRAME = np.zeros((90, 160, 3), dtype=np.uint8)


def test_a_healthy_empty_frame_is_a_valid_observation():
    det = detector(lambda **kwargs: [result()])
    assert det.detect(FRAME) == []
    assert det.last_inference_failed is False


def test_a_missing_frame_is_not_an_empty_frame():
    det = detector(lambda **kwargs: [result()])
    assert det.detect(None) == []
    assert det.last_inference_failed is True


def test_a_zero_sized_frame_is_not_an_empty_frame():
    det = detector(lambda **kwargs: [result()])
    assert det.detect(np.zeros((0, 0, 3), dtype=np.uint8)) == []
    assert det.last_inference_failed is True


def test_a_failed_inference_is_not_an_empty_frame_and_never_escapes():
    def boom(**kwargs):
        raise RuntimeError("CUDA out of memory")

    det = detector(boom)
    assert det.detect(FRAME) == []          # no exception reaches the caller
    assert det.last_inference_failed is True


def test_the_failure_flag_clears_once_inference_recovers():
    calls = {"n": 0}

    def flaky(**kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("transient")
        return [result(box(0, 0.9, (0, 0, 16, 45)))]

    det = detector(flaky)
    det.detect(FRAME)
    assert det.last_inference_failed is True
    assert len(det.detect(FRAME)) == 1
    assert det.last_inference_failed is False


def test_timing_is_recorded_even_when_inference_fails():
    """last_inference_ms is how a caller watches throughput degrade."""
    def boom(**kwargs):
        raise RuntimeError("nope")

    det = detector(boom)
    det.detect(FRAME)
    assert det.last_inference_ms > 0.0


def test_the_frame_geometry_drives_normalisation():
    seen = {}

    def predict(**kwargs):
        seen.update(kwargs)
        return [result(box(0, 0.9, (16, 9, 32, 45)))]

    det = detector(predict)
    got = det.detect(FRAME)
    assert seen["classes"] == [0]
    assert seen["conf"] == pytest.approx(0.3)
    assert seen["verbose"] is False
    assert got[0].bbox == pytest.approx((0.1, 0.1, 0.1, 0.4))


# ---------------------------------------------------------------------------
# Threshold knob
# ---------------------------------------------------------------------------

def test_the_confidence_threshold_is_clamped_into_a_usable_range():
    det = detector(lambda **kwargs: [result()])
    det.conf_threshold = 5.0
    assert det.conf_threshold == 1.0
    det.conf_threshold = -1.0
    assert det.conf_threshold == 0.01


def test_conf_is_an_accepted_alias_so_the_old_call_site_cannot_be_fatal():
    """FM-101: PersonDetector(conf=...) used to raise TypeError, and the
    caller's blanket except reported that bug as 'no hardware'."""
    import inspect

    parameters = inspect.signature(PersonDetector.__init__).parameters
    assert "conf_threshold" in parameters
    assert "conf" in parameters
    assert parameters["conf"].kind is inspect.Parameter.KEYWORD_ONLY
