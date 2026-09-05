"""
============================================================================
Eye in the Sky -- Person detector (PersonDetector)
----------------------------------------------------------------------------
Runs inference via the ultralytics YOLO API.  Targets COCO class 0 (person)
only.

Engine selection (checked in order):
  1. EIS_ENGINE_PATH env var  -- path to a TensorRT .engine file (fastest on
                                  Jetson; export via export_tensorrt.py).
  2. EIS_MODEL_PATH  env var  -- path to a .pt weights file.
  3. Default: yolo11n.pt in the ultralytics cache (downloaded on first use).

Both env vars can also be passed explicitly to the constructor (constructor
args take precedence over env vars, which take precedence over the default).

Performance targets
-------------------
  * Orin Nano + TensorRT FP16 .engine: ≥15 FPS at 720p (detection only).
  * Graceful degradation: if inference takes longer than one frame slot the
    detector still returns results -- it does not drop connections or raise.
    The ``last_inference_ms`` attribute lets the caller monitor throughput.

Installation note (raised as ImportError if ultralytics is absent)
------------------------------------------------------------------
The detector requires ``ultralytics`` and a CUDA-capable ``torch`` build.
Install them on the Jetson per the project docs::

    # JetPack 6 / Python 3.10 -- inside the Docker container:
    pip install ultralytics
    # torch is pre-installed in the JetPack L4T base image; if not:
    # follow https://docs.ultralytics.com/guides/nvidia-jetson/

If ultralytics/torch are not installed this module raises ``ImportError``
with a clear message; the orchestrator (api/server.py) catches it and falls
back to mock detections, so the rest of the companion keeps running.
============================================================================
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Optional

from eis_companion.types import TargetObservation

log = logging.getLogger(__name__)

# COCO class 0 = person
_PERSON_CLASS_ID = 0

# ---------------------------------------------------------------------------
# Lazy imports -- raise a helpful ImportError if ultralytics is missing
# ---------------------------------------------------------------------------

def _require_ultralytics() -> Any:
    """Import ultralytics.YOLO and return it; raise ImportError with install hint."""
    try:
        from ultralytics import YOLO  # type: ignore  # noqa: F401
        return YOLO
    except ImportError as exc:
        raise ImportError(
            "ultralytics is not installed.  "
            "Install it inside the companion Docker container:\n"
            "    pip install ultralytics\n"
            "On the Jetson Orin Nano with JetPack 6, torch is pre-installed; "
            "if not, follow https://docs.ultralytics.com/guides/nvidia-jetson/ .\n"
            "For development without a GPU, install:\n"
            "    pip install ultralytics torch torchvision --index-url "
            "https://download.pytorch.org/whl/cpu"
        ) from exc


# ---------------------------------------------------------------------------
# PersonDetector
# ---------------------------------------------------------------------------

class PersonDetector:
    """YOLO-based single-class person detector.

    Parameters
    ----------
    engine_path:
        Path to a TensorRT ``.engine`` file.  Overrides ``EIS_ENGINE_PATH``
        env var.  Pass *None* to fall through to ``model_path``.
    model_path:
        Path to a ``.pt`` weights file.  Overrides ``EIS_MODEL_PATH`` env var.
        Defaults to ``yolo11n.pt`` (ultralytics auto-downloads on first use).
    conf_threshold:
        Minimum detector confidence to include a detection.  Default 0.45.
    device:
        PyTorch device string, e.g. ``'cuda:0'`` (default) or ``'cpu'``.
        ``'cuda:0'`` is required for TensorRT engines.
    imgsz:
        Inference image size (square side length).  640 is the YOLO default and
        gives the best accuracy/speed trade-off on the Orin Nano.
    half:
        Run in FP16 mode (``True`` by default).  Silently ignored for .engine
        files because the precision is baked into the engine at export time.
    """

    def __init__(
        self,
        engine_path: Optional[str] = None,
        model_path: Optional[str] = None,
        conf_threshold: float = 0.45,
        device: str = "cuda:0",
        imgsz: int = 640,
        half: bool = True,
    ) -> None:
        # Resolve model path: constructor arg > env var > default
        resolved_engine = (
            engine_path
            or os.environ.get("EIS_ENGINE_PATH", "")
            or ""
        )
        resolved_model = (
            model_path
            or os.environ.get("EIS_MODEL_PATH", "")
            or "yolo11n.pt"
        )

        self._conf = float(conf_threshold)
        self._device = device
        self._imgsz = imgsz
        self._half = half
        self._model: Any = None
        self.last_inference_ms: float = 0.0   # updated every call to detect()

        # ultralytics raises ImportError here if not installed (propagates up)
        YOLO = _require_ultralytics()

        if resolved_engine and os.path.isfile(resolved_engine):
            log.info("PersonDetector: loading TensorRT engine from %s", resolved_engine)
            self._model = YOLO(resolved_engine, task="detect")
            log.info("TensorRT engine loaded.")
        else:
            if resolved_engine:
                log.warning(
                    "EIS_ENGINE_PATH '%s' not found; falling back to model weights.",
                    resolved_engine,
                )
            log.info("PersonDetector: loading model weights from %s", resolved_model)
            self._model = YOLO(resolved_model)
            # Warm up once to trigger JIT/CUDA initialisation before live frames
            self._warmup()
            log.info("Model loaded and warmed up.")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def detect(self, frame: "np.ndarray") -> list[TargetObservation]:
        """Run inference on *frame* and return person detections.

        Parameters
        ----------
        frame:
            A HxWx3 uint8 BGR numpy array (as returned by ``Capture.read()``).

        Returns
        -------
        list[TargetObservation]
            Zero or more detections, sorted by descending confidence, each with
            a normalised (x, y, w, h) bbox (top-left origin, 0..1 coords),
            confidence in [0, 1], and a timestamp (``time.time()``).
        """
        if frame is None or frame.size == 0:
            return []

        t0 = time.perf_counter()
        try:
            results = self._model.predict(
                source=frame,
                classes=[_PERSON_CLASS_ID],
                conf=self._conf,
                imgsz=self._imgsz,
                device=self._device,
                half=self._half,
                verbose=False,
            )
        except Exception as exc:
            log.error("PersonDetector.detect() inference failed: %s", exc)
            return []
        finally:
            self.last_inference_ms = (time.perf_counter() - t0) * 1000.0

        ts = time.time()
        observations: list[TargetObservation] = []

        for result in results:
            if result.boxes is None:
                continue
            h_img, w_img = frame.shape[:2]
            for box in result.boxes:
                cls = int(box.cls[0].item())
                if cls != _PERSON_CLASS_ID:
                    continue
                conf = float(box.conf[0].item())
                if conf < self._conf:
                    continue
                # xyxy pixel coords -> normalised xywh
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                nx = float(x1) / w_img
                ny = float(y1) / h_img
                nw = float(x2 - x1) / w_img
                nh = float(y2 - y1) / h_img
                # Clamp to [0, 1]
                nx = max(0.0, min(1.0, nx))
                ny = max(0.0, min(1.0, ny))
                nw = max(0.0, min(1.0 - nx, nw))
                nh = max(0.0, min(1.0 - ny, nh))
                observations.append(
                    TargetObservation(bbox=(nx, ny, nw, nh), conf=conf, ts=ts)
                )

        # Sort by descending confidence so the caller's default selection
        # (highest-conf / most-central) is easy.
        observations.sort(key=lambda o: o.conf, reverse=True)

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

    def _warmup(self) -> None:
        """Send one blank frame through the model to trigger JIT / CUDA init."""
        try:
            import numpy as np  # noqa: F401 -- only used here
            dummy = np.zeros((640, 640, 3), dtype=np.uint8)
            self._model.predict(
                source=dummy,
                classes=[_PERSON_CLASS_ID],
                conf=self._conf,
                imgsz=self._imgsz,
                device=self._device,
                half=self._half,
                verbose=False,
            )
            log.debug("Warmup inference complete.")
        except Exception as exc:
            log.warning("Warmup failed (non-fatal): %s", exc)
