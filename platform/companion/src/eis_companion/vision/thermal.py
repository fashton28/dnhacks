"""Thermal detector rail with deterministic staged fallback."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

from eis_companion.control.fusion import SensorTrack


@dataclass(frozen=True)
class ThermalFrameResult:
    valid: bool
    tracks: tuple[SensorTrack, ...]
    health: str
    detail: str = ""


class ScriptedThermalDetector:
    """Truth-keyed detector used by offline tests and the demo."""

    def detect(self, truth: str, *, track_id: int = 100) -> ThermalFrameResult:
        truth = str(truth).strip().lower()
        if truth == "false_alarm":
            return ThermalFrameResult(True, (), "ok")
        if truth not in {"vehicle", "breach", "structure"}:
            return ThermalFrameResult(False, (), "failed", f"unknown scripted truth {truth!r}")
        cls = "person" if truth == "breach" else truth
        confidence = {"vehicle": 0.93, "breach": 0.91, "structure": 0.58}[truth]
        delta = {"vehicle": 18.0, "breach": 9.0, "structure": 4.0}[truth]
        distance = {"vehicle": 12.0, "breach": 9.0, "structure": 20.0}[truth]
        return ThermalFrameResult(True, (
            SensorTrack(track_id, cls, 0.0, distance, confidence, "thermal", delta),
        ), "ok")


class YoloThermalDetector:
    """Optional YOLO thermal weights; constructed only on the live path."""

    def __init__(self, weights: str, confidence: float = 0.4) -> None:
        try:
            from ultralytics import YOLO  # type: ignore
        except ImportError as exc:  # pragma: no cover - optional hardware path
            raise ImportError("thermal YOLO requires companion[detect]") from exc
        self._model = YOLO(weights)
        self._confidence = max(0.0, min(1.0, float(confidence)))

    def detect(self, frame: Any) -> ThermalFrameResult:  # pragma: no cover - GPU path
        if frame is None:
            return ThermalFrameResult(False, (), "failed", "missing thermal frame")
        try:
            results = self._model.predict(frame, conf=self._confidence, verbose=False)
        except Exception as exc:
            return ThermalFrameResult(False, (), "failed", str(exc))
        tracks = []
        next_id = 100
        names: Mapping[int, str] = getattr(self._model, "names", {})
        for result in results:
            for box in getattr(result, "boxes", ()):
                cls_id = int(float(box.cls[0]))
                confidence = float(box.conf[0])
                tracks.append(SensorTrack(
                    next_id,
                    str(names.get(cls_id, cls_id)),
                    0.0,
                    0.0,
                    confidence,
                    "thermal",
                    None,
                ))
                next_id += 1
        return ThermalFrameResult(True, tuple(tracks), "ok")


__all__ = ["ScriptedThermalDetector", "ThermalFrameResult", "YoloThermalDetector"]
