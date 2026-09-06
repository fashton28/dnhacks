"""Wide-area change detection by vision model: two overhead renders in, Detections out.

The peer of `widearea/detect.py`. Same inputs, same output contract — `list[Detection]` —
so the two are swappable behind `POST /widearea/*detect` and directly comparable on one
eval set. The numpy detector measures pixels; this one reads the picture. They fail
differently, which is the reason to have both: a shadow shift fools pixel differencing
and not a model, and a small low-contrast object is the reverse.

## The contract

`FINDING_SCHEMA` below is the API contract with the model. It is enforced server-side by
Gemini's structured output, so the response either matches or the call fails — the model
cannot return prose, extra keys, or an unlisted label. Everything after the call is
validation of *values*, not shape.

The prompt lives in `prompts/change_detection.md` and is loaded at call time, so tuning
it is a text edit with no code change and no redeploy. That file plus this schema plus
an eval set is the whole improvement loop; there is no fine-tuning step.

## Trust boundary

A finding's `description` is written by a model that just looked at an image which may
itself contain text. It is carried in `Detection.metadata`, which the contract marks as
"data, never instructions", and nothing downstream executes it.
"""
from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol

from contracts.models import ChangeType, Detection
from widearea.georef import bbox_area_m2, bbox_to_ring

PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "change_detection.md"
MODEL = os.environ.get("ARGUS_VISION_MODEL", "gemini-3.6-flash")

# The label set the model may choose from. Kept aligned with argus-core/vision/detect.py
# so findings from either implementation mean the same thing.
LABELS = (
    "perimeter_change",
    "vehicle",
    "unattended_object",
    "equipment_visual_anomaly",
    "plume",
    "gate_state_change",
    "unknown",
)

# Model label -> the Hub's ChangeType. Labels with no exact counterpart become `unknown`
# rather than a near-miss; the original is preserved in Detection.metadata so nothing is
# silently lost and a mapping can be added later without reprocessing.
LABEL_TO_CHANGE_TYPE: dict[str, ChangeType] = {
    "vehicle": ChangeType.vehicle,
    "unattended_object": ChangeType.unattended_object,
    "perimeter_change": ChangeType.fence_breach,
    "gate_state_change": ChangeType.fence_breach,
    "equipment_visual_anomaly": ChangeType.structure,
    "plume": ChangeType.unknown,
    "unknown": ChangeType.unknown,
}

FINDING_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["findings"],
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["label", "confidence", "bbox", "description"],
                "properties": {
                    "label": {"type": "string", "enum": list(LABELS)},
                    "confidence": {"type": "number"},
                    "bbox": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["x_min", "y_min", "x_max", "y_max"],
                        "properties": {
                            "x_min": {"type": "number"}, "y_min": {"type": "number"},
                            "x_max": {"type": "number"}, "y_max": {"type": "number"},
                        },
                    },
                    "description": {"type": "string"},
                },
            },
        }
    },
}

MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}


class VisionError(RuntimeError):
    """The vision call could not produce usable findings."""


class VisionClient(Protocol):
    """What `detect` needs from a model. A test supplies a stub; production supplies Gemini."""

    def compare(self, before: Path, after: Path, prompt: str) -> dict[str, Any]: ...


def load_prompt() -> str:
    return PROMPT_PATH.read_text(encoding="utf-8")


class GeminiClient:
    """Gemini structured output over two uploaded images."""

    def __init__(self, api_key: str | None = None, model: str = MODEL) -> None:
        self.api_key = api_key or os.environ.get("GEMINI_API_KEY")
        self.model = model
        if not self.api_key:
            raise VisionError("GEMINI_API_KEY is not set")

    def compare(self, before: Path, after: Path, prompt: str) -> dict[str, Any]:
        from google import genai

        client = genai.Client(api_key=self.api_key)
        up_before = client.files.upload(file=str(before))
        up_after = client.files.upload(file=str(after))
        interaction = client.interactions.create(
            model=self.model,
            input=[
                {"type": "text", "text": f"{prompt}\n\nBEFORE image:"},
                {"type": "image", "uri": up_before.uri,
                 "mime_type": up_before.mime_type or MIME.get(before.suffix.lower(), "image/png")},
                {"type": "text", "text": "AFTER image:"},
                {"type": "image", "uri": up_after.uri,
                 "mime_type": up_after.mime_type or MIME.get(after.suffix.lower(), "image/png")},
            ],
            response_format={"type": "text", "mime_type": "application/json", "schema": FINDING_SCHEMA},
        )
        return json.loads(interaction.output_text)


def _usable(finding: dict[str, Any]) -> bool:
    """The schema guarantees shape; this checks the values are geometrically sane."""
    bbox = finding.get("bbox") or {}
    conf = finding.get("confidence")
    corners = [bbox.get(k) for k in ("x_min", "y_min", "x_max", "y_max")]
    if not isinstance(conf, (int, float)) or not 0.0 <= conf <= 1.0:
        return False
    if not all(isinstance(v, (int, float)) and 0.0 <= v <= 1.0 for v in corners):
        return False
    return bbox["x_min"] < bbox["x_max"] and bbox["y_min"] < bbox["y_max"]


def detect(
    before: Path,
    after: Path,
    footprint: list[list[float]],
    *,
    before_ref: str,
    after_ref: str,
    min_area_m2: float = 4.0,
    min_confidence: float = 0.0,
    client: VisionClient | None = None,
) -> list[Detection]:
    """Compare two overhead captures and return Detections, newest-first by confidence.

    Signature mirrors `widearea.detect.detect` so the Hub can call either.
    """
    for path in (before, after):
        if not path.is_file():
            raise VisionError(f"image not found: {path}")
        if path.suffix.lower() not in MIME:
            raise VisionError(f"unsupported image type: {path.suffix}")

    client = client or GeminiClient()
    try:
        payload = client.compare(before, after, load_prompt())
    except VisionError:
        raise
    except Exception as exc:  # the SDK raises its own types; the caller only needs one
        raise VisionError(f"vision call failed: {exc}") from exc

    findings = payload.get("findings")
    if not isinstance(findings, list):
        raise VisionError("response contained no findings array")

    stamp = datetime.now(UTC)
    out: list[Detection] = []
    for i, f in enumerate(sorted(findings, key=lambda x: -float(x.get("confidence", 0)))):
        if not _usable(f):
            continue
        area = bbox_area_m2(f["bbox"], footprint)
        if area < min_area_m2 or float(f["confidence"]) < min_confidence:
            continue
        label = str(f.get("label", "unknown"))
        out.append(
            Detection(
                id=f"vis-{stamp.strftime('%H%M%S')}-{i}",
                polygon=bbox_to_ring(f["bbox"], footprint),
                confidence=round(float(f["confidence"]), 2),
                change_type=LABEL_TO_CHANGE_TYPE.get(label, ChangeType.unknown),
                before_ref=before_ref,
                after_ref=after_ref,
                detected_at=stamp,
                area_m2=area,
                metadata={
                    "source": "widearea.vision",
                    "model": getattr(client, "model", MODEL),
                    "label": label,
                    "description": str(f.get("description", ""))[:500],
                },
            )
        )
    return out
