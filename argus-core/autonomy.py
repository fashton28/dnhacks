"""Authorised-frame autonomy pipeline.

Images -> Gemini candidate findings -> Detection -> MissionSpec -> FlightPlan
-> ValidationResult -> dashboard/simulator dispatch request.

This module only emits a `dispatch_requested` event for an accepted simulated
mission. A simulator controller may consume that event. It does not directly
connect to or operate a physical drone.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from dashboard_events import emit
from pipeline import run_pipeline
from vision.detect import compare_images
from vision.georef import bbox_to_polygon


def process_frame_pair(
    *, before_image: str | Path, after_image: str | Path, frame_meta: dict[str, Any],
    drone_state: dict[str, Any], policy: dict[str, Any], events_path: str | Path,
) -> list[dict[str, Any]]:
    """Process one authorised before/after image pair and emit dashboard events."""
    findings = compare_images(before_image, after_image)
    outcomes = []
    for index, finding in enumerate(findings, start=1):
        detection = {
            "id": f"{frame_meta['frame_id']}-finding-{index}",
            "polygon": bbox_to_polygon(finding["bbox"], frame_meta),
            "confidence": finding["confidence"],
            "change_type": finding["label"],
            "detected_at": frame_meta["captured_at"],
            "before_ref": str(before_image),
            "after_ref": str(after_image),
        }
        emit(events_path, "detection_created", {"detection": detection, "description": finding["description"]})
        pipeline_result = run_pipeline(detection, drone_state, policy)
        # Return the model's actual vision judgement as well as downstream
        # artifacts, so a CLI user can inspect what Gemini saw.
        outcome = {
            "vision_finding": finding,
            "detection": detection,
            **pipeline_result,
        }
        emit(events_path, "mission_spec_created", outcome["mission_spec"])
        emit(events_path, "flight_plan_created", outcome["flight_plan"])
        emit(events_path, "validation_completed", outcome["validation"])
        if outcome["validation"]["verdict"] == "accept":
            emit(events_path, "dispatch_requested", {"flight_plan": outcome["flight_plan"]})
        outcomes.append(outcome)
    return outcomes
