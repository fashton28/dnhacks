"""
============================================================================
Drone Safety Platform -- Person detector (PersonDetector)
----------------------------------------------------------------------------
Single-class (COCO class 0, ``person``) detector on top of the ultralytics
YOLO API.

Weights resolution, in order
  1. ``engine_path`` argument, else ``EIS_ENGINE_PATH`` -- a TensorRT
     ``.engine`` file.  Fastest on Jetson; build one with export_tensorrt.py.
     A path that does not exist is reported and skipped, never guessed at.
  2. ``model_path`` argument, else ``EIS_MODEL_PATH`` -- a ``.pt`` checkpoint.
  3. ``yolo11n.pt``, which ultralytics fetches into its cache on first use.

The choice is made by :func:`resolve_weights`, a pure function, so the policy
is testable without ultralytics installed.

Honesty invariants this module carries
--------------------------------------
* ``supported_classes`` / :data:`SUPPORTED_CLASSES` publish what this backend
  can *express*.  "Found no vehicle" and "cannot represent a vehicle" are
  different answers and callers must be able to tell them apart (FM-98).
* ``last_inference_failed`` distinguishes a failed inference (returns ``[]``)
  from a healthy frame that genuinely contained nobody (also ``[]``).  The two
  support opposite incident verdicts, and collapsing them was FM-100.
* ``last_inference_ms`` is written on every call, success or failure, so a
  caller can watch throughput degrade rather than only notice when it stops.

Never raises from ``detect()``: a slow or broken frame degrades to an empty
result plus a raised ``last_inference_failed`` flag; only the *constructor*
raises, with ``ImportError`` when ultralytics/torch are absent (the ordinary
dev-box case, which callers catch to fall back to synthetic detections).
============================================================================
"""
from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Iterable, Optional, Sequence, Tuple

if TYPE_CHECKING:
    import numpy as np

from eis_companion.types import TargetObservation

log = logging.getLogger(__name__)

# COCO class 0 = person
_PERSON_CLASS_ID = 0

#: The ONLY object class this backend can produce. Published as a capability so
#: nothing upstream can assume a vehicle/structure detection is merely absent
#: when it is structurally impossible (FM-98).
SUPPORTED_CLASSES: tuple[str, ...] = ("person",)

#: Default confidence gate. It MUST stay at or below the lowest confidence any
#: scripted staging stub emits (vision/staging.py STUB_MIN_CONFIDENCE), or a
#: cue the offline demo shows is mathematically unreachable once the real
#: backend is installed and no tuning transfers between the two (FM-121).
#: tests/test_staging.py pins the relationship.
DEFAULT_CONF_THRESHOLD: float = 0.30

#: Environment overrides, lowest precedence after explicit arguments.
ENGINE_PATH_ENV = "EIS_ENGINE_PATH"
MODEL_PATH_ENV = "EIS_MODEL_PATH"
DEFAULT_WEIGHTS = "yolo11n.pt"

_INSTALL_HINT = (
    "ultralytics is not installed.  "
    "Install it inside the companion Docker container:\n"
    "    pip install ultralytics\n"
    "On the Jetson Orin Nano with JetPack 6, torch is pre-installed; "
    "if not, follow https://docs.ultralytics.com/guides/nvidia-jetson/ .\n"
    "For development without a GPU, install:\n"
    "    pip install ultralytics torch torchvision --index-url "
    "https://download.pytorch.org/whl/cpu"
)


# ---------------------------------------------------------------------------
# Backend resolution (pure -- no ultralytics needed to exercise it)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Weights:
    """Which file the detector will load, and how."""

    path: str
    tensorrt: bool

    @property
    def load_kwargs(self) -> dict[str, Any]:
        """Extra kwargs for ``YOLO(...)``.

        A ``.engine`` carries no task metadata, so it has to be told what it
        is; a ``.pt`` checkpoint knows.
        """
        return {"task": "detect"} if self.tensorrt else {}


def resolve_weights(
    engine_path: Optional[str] = None,
    model_path: Optional[str] = None,
    *,
    environ: Optional[dict] = None,
    exists=os.path.isfile,
) -> Weights:
    """Pick the weights file, argument > environment > packaged default.

    ``exists`` is injected so the policy can be tested against a fake
    filesystem.  A configured-but-absent engine is logged and demoted rather
    than silently ignored: an operator who exported an engine and typo'd the
    path deserves to see why the run is slow.
    """
    env = os.environ if environ is None else environ

    engine = (engine_path or env.get(ENGINE_PATH_ENV, "") or "").strip()
    if engine:
        if exists(engine):
            return Weights(path=engine, tensorrt=True)
        log.warning(
            "%s '%s' not found; falling back to model weights.",
            ENGINE_PATH_ENV, engine,
        )

    model = (model_path or env.get(MODEL_PATH_ENV, "") or DEFAULT_WEIGHTS).strip()
    return Weights(path=model or DEFAULT_WEIGHTS, tensorrt=False)


def _load_yolo() -> Any:
    """Return ``ultralytics.YOLO`` or raise ImportError with an install hint."""
    try:
        from ultralytics import YOLO  # type: ignore
    except ImportError as exc:
        raise ImportError(_INSTALL_HINT) from exc
    return YOLO


# ---------------------------------------------------------------------------
# Result conversion (pure -- shaped by the ultralytics Results contract)
# ---------------------------------------------------------------------------

def _scalar(value: Any) -> float:
    """Unwrap a torch 0-d tensor / numpy scalar / plain number to a float."""
    item = getattr(value, "item", None)
    return float(item()) if callable(item) else float(value)


def _normalise_box(
    corners: Sequence[float],
    frame_hw: Tuple[int, int],
) -> Tuple[float, float, float, float]:
    """xyxy pixel corners -> ``(x, y, w, h)`` normalised and clamped to 0..1."""
    height, width = frame_hw
    x1, y1, x2, y2 = (float(v) for v in corners[:4])
    nx = min(max(x1 / width, 0.0), 1.0)
    ny = min(max(y1 / height, 0.0), 1.0)
    nw = min(max((x2 - x1) / width, 0.0), 1.0 - nx)
    nh = min(max((y2 - y1) / height, 0.0), 1.0 - ny)
    return nx, ny, nw, nh


def observations_from_results(
    results: Iterable[Any],
    frame_hw: Tuple[int, int],
    conf_gate: float,
    ts: float,
) -> list[TargetObservation]:
    """Convert ultralytics ``Results`` into normalised person observations.

    Keeps only class 0 at or above *conf_gate*, and returns them sorted by
    descending confidence so a caller's "best target" is ``[0]``.
    """
    observations: list[TargetObservation] = []
    for result in results or ():
        boxes = getattr(result, "boxes", None)
        if boxes is None:
            continue
        for box in boxes:
            if int(_scalar(box.cls[0])) != _PERSON_CLASS_ID:
                continue
            conf = _scalar(box.conf[0])
            if conf < conf_gate:
                continue
            observations.append(
                TargetObservation(
                    bbox=_normalise_box(box.xyxy[0].tolist(), frame_hw),
                    conf=conf,
                    ts=ts,
                )
            )
    observations.sort(key=lambda obs: obs.conf, reverse=True)
    return observations


def _frame_geometry(frame: Any) -> Optional[Tuple[int, int]]:
    """``(height, width)`` of a usable frame, or None if it is not one."""
    if frame is None:
        return None
    size = getattr(frame, "size", None)
    if size is not None and not callable(size) and int(size) == 0:
        return None
    shape = getattr(frame, "shape", None)
    if shape is None or len(shape) < 2:
        return None
    height, width = int(shape[0]), int(shape[1])
    if height <= 0 or width <= 0:
        return None
    return height, width


# ---------------------------------------------------------------------------
# PersonDetector
# ---------------------------------------------------------------------------

class PersonDetector:
    """YOLO-based single-class person detector.

    Declares ``supported_classes`` so callers can tell "this backend found
    nothing" apart from "this backend cannot express what you asked about"
    (FM-98). A backend that declares nothing is treated as unrestricted.

    Parameters
    ----------
    engine_path:
        TensorRT ``.engine`` file; overrides ``EIS_ENGINE_PATH``.  *None*
        falls through to ``model_path``.
    model_path:
        ``.pt`` weights file; overrides ``EIS_MODEL_PATH``.  Defaults to
        ``yolo11n.pt`` (ultralytics auto-downloads on first use).
    conf_threshold:
        Minimum confidence to keep a detection.  Default
        :data:`DEFAULT_CONF_THRESHOLD`.
    device:
        Torch device string, ``'cuda:0'`` by default; TensorRT engines require
        a CUDA device.
    imgsz:
        Square inference size.  640 is the accuracy/speed sweet spot on Orin.
    half:
        FP16 inference.  Ignored for ``.engine`` files, where precision was
        fixed at export time.
    conf:
        Accepted ALIAS for *conf_threshold* -- see the note in ``__init__``.
    """

    #: The object classes this backend can produce (see SUPPORTED_CLASSES).
    supported_classes: tuple[str, ...] = SUPPORTED_CLASSES

    def __init__(
        self,
        engine_path: Optional[str] = None,
        model_path: Optional[str] = None,
        conf_threshold: float = DEFAULT_CONF_THRESHOLD,
        device: str = "cuda:0",
        imgsz: int = 640,
        half: bool = True,
        *,
        conf: Optional[float] = None,
    ) -> None:
        # ``conf`` is an accepted ALIAS for conf_threshold. The orchestrator
        # called PersonDetector(conf=...) against a parameter named
        # conf_threshold, so every real-camera build raised TypeError and the
        # blanket except reported it as "no hardware" -- perception was
        # silently disabled for the whole flight (FM-101). The call site is
        # fixed; the alias means the same mistake cannot be fatal again.
        if conf is not None:
            conf_threshold = conf

        self._conf = float(conf_threshold)
        self._device = device
        self._imgsz = imgsz
        self._half = half
        self._model: Any = None

        #: Wall time of the most recent detect() call, success or failure.
        self.last_inference_ms: float = 0.0
        #: True when the LAST detect() call failed. An empty list from a failed
        #: inference is NOT a valid empty frame, and the caller has to be able
        #: to tell the two apart (FM-100).
        self.last_inference_failed: bool = False

        # ImportError here is the expected dev-box outcome and propagates up.
        yolo_cls = _load_yolo()
        self.weights = resolve_weights(engine_path, model_path)

        log.info(
            "PersonDetector: loading %s from %s",
            "TensorRT engine" if self.weights.tensorrt else "model weights",
            self.weights.path,
        )
        self._model = yolo_cls(self.weights.path, **self.weights.load_kwargs)
        if not self.weights.tensorrt:
            # A serialised engine is already device-resident; a checkpoint pays
            # its JIT/CUDA initialisation on the first frame unless we spend it
            # here, before the control loop is depending on the cadence.
            self._warmup()
        log.info("PersonDetector ready (%s).", self.weights.path)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def detect(self, frame: "np.ndarray") -> list[TargetObservation]:
        """Run inference on *frame* and return person detections.

        Parameters
        ----------
        frame:
            HxWx3 uint8 BGR array, as returned by ``Capture.read()``.

        Returns
        -------
        list[TargetObservation]
            Zero or more detections sorted by descending confidence, each with
            a normalised ``(x, y, w, h)`` bbox (top-left origin, 0..1),
            confidence in [0, 1] and a ``time.time()`` timestamp.  An empty
            list means either "nobody there" or "inference failed" -- read
            ``last_inference_failed`` to tell which.
        """
        geometry = _frame_geometry(frame)
        if geometry is None:
            self.last_inference_failed = True
            return []

        started = time.perf_counter()
        try:
            results = self._predict(frame)
        except Exception as exc:
            log.error("PersonDetector.detect() inference failed: %s", exc)
            # A failed inference is "no observation", not "a valid frame with
            # nothing in it" -- the two support opposite incident verdicts
            # (FAILURE_MODES observation-state invariant / FM-100).
            self.last_inference_failed = True
            return []
        finally:
            self.last_inference_ms = (time.perf_counter() - started) * 1000.0

        self.last_inference_failed = False
        observations = observations_from_results(
            results, geometry, self._conf, time.time(),
        )
        log.debug(
            "detect(): %d person(s) in %.1f ms",
            len(observations), self.last_inference_ms,
        )
        return observations

    @property
    def conf_threshold(self) -> float:
        return self._conf

    @conf_threshold.setter
    def conf_threshold(self, value: float) -> None:
        self._conf = max(0.01, min(1.0, float(value)))

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _predict(self, frame: Any) -> Any:
        """One ultralytics forward pass with this detector's fixed settings."""
        return self._model.predict(
            source=frame,
            classes=[_PERSON_CLASS_ID],
            conf=self._conf,
            imgsz=self._imgsz,
            device=self._device,
            half=self._half,
            verbose=False,
        )

    def _warmup(self) -> None:
        """Push one blank frame through the model to pay JIT / CUDA init."""
        try:
            import numpy as np  # local: the module itself is numpy-free

            self._predict(np.zeros((self._imgsz, self._imgsz, 3), dtype=np.uint8))
            log.debug("Warmup inference complete.")
        except Exception as exc:
            log.warning("Warmup failed (non-fatal): %s", exc)


__all__ = [
    "PersonDetector",
    "Weights",
    "SUPPORTED_CLASSES",
    "DEFAULT_CONF_THRESHOLD",
    "ENGINE_PATH_ENV",
    "MODEL_PATH_ENV",
    "DEFAULT_WEIGHTS",
    "resolve_weights",
    "observations_from_results",
]
