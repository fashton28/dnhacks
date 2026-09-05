"""Wide-area layer: run argus-core's vision comparison and post Detections to the Hub.

This is the adapter between two components with different vocabularies. argus-core
returns findings with a normalised bbox and its own label set; the Hub speaks
`contracts.models.Detection` with a georeferenced polygon and `ChangeType`. Nothing
else crosses the boundary.

Two modes:

  # capture before, run a Scenario, capture after, compare, post
  python scripts/argus_detect.py --scenario intruder_vehicle

  # compare two images already on disk (no renderer needed)
  python scripts/argus_detect.py --before a.png --after b.png --footprint cap.json

Needs a connected renderer for the capture mode (the Console, or
`scripts/headless_renderer.py`) and `GEMINI_API_KEY` for the vision call.

Posting a Detection authorises nothing: dispatch stays an Operator action and the
Safety Validator still gates the FlightPlan. The model's own prose is carried in
`Detection.metadata` as data, never as instructions.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import sys
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parent.parent
ARGUS_CORE = REPO / "argus-core"

# argus-core ships its own `contracts` package that collides with this repo's on the
# import path (docs/REPOSITORY_REVIEW.md). Its vision modules are stdlib-only, so load
# them by file path and never put argus-core on sys.path.
def _load(name: str, path: Path) -> Any:
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# argus-core label -> Hub ChangeType. Anything without an equivalent becomes `unknown`
# and keeps its original label in metadata rather than being forced into a near-miss.
LABEL_TO_CHANGE_TYPE = {
    "vehicle": "vehicle",
    "unattended_object": "unattended_object",
    "perimeter_change": "fence_breach",
    "gate_state_change": "fence_breach",
    "equipment_visual_anomaly": "structure",
    "plume": "unknown",
    "unknown": "unknown",
}


def post(hub: str, path: str, body: dict[str, Any] | None = None) -> Any:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        f"{hub.rstrip('/')}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST" if body is not None else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{path} -> {e.code}: {e.read().decode()[:400]}") from e
    except urllib.error.URLError as e:
        raise SystemExit(f"cannot reach Hub at {hub}: {e.reason}. Is `make hub` running?") from e


def geo_bounds(footprint: list[list[float]]) -> dict[str, float]:
    """Overhead captures are north-up rectangles, so the corners give exact bounds."""
    lats = [c[0] for c in footprint]
    lons = [c[1] for c in footprint]
    return {
        "north_lat": max(lats), "south_lat": min(lats),
        "west_lon": min(lons), "east_lon": max(lons),
    }


def bbox_area_m2(bbox: dict[str, float], bounds: dict[str, float]) -> float:
    """Approximate projected area. Local-flat approximation; fine at Site scale."""
    mid_lat = (bounds["north_lat"] + bounds["south_lat"]) / 2
    span_lat_m = abs(bounds["north_lat"] - bounds["south_lat"]) * 111_320
    span_lon_m = abs(bounds["east_lon"] - bounds["west_lon"]) * 111_320 * math.cos(math.radians(mid_lat))
    w = max(0.0, min(1.0, bbox["x_max"]) - max(0.0, bbox["x_min"]))
    h = max(0.0, min(1.0, bbox["y_max"]) - max(0.0, bbox["y_min"]))
    return round(w * span_lon_m * h * span_lat_m, 1)


def capture(hub: str, ref: str, evidence: Path) -> tuple[Path, dict[str, Any]]:
    """Ask the Hub for an overhead capture; it writes the PNG and metadata to evidence/."""
    meta = post(hub, "/overhead/capture", {"ref": ref})
    png = evidence / ref
    if not png.exists():
        raise SystemExit(f"capture reported {ref} but {png} is missing (is the Hub's evidence_dir set?)")
    return png, meta


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hub", default="http://127.0.0.1:8000")
    ap.add_argument("--evidence", default="evidence", type=Path, help="the Hub's evidence directory")
    ap.add_argument("--scenario", help="Scenario kind to run between the two captures")
    ap.add_argument("--before", type=Path, help="offline mode: BEFORE image")
    ap.add_argument("--after", type=Path, help="offline mode: AFTER image")
    ap.add_argument("--footprint", type=Path, help="offline mode: JSON with a `footprint` field")
    ap.add_argument("--run-id", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    ap.add_argument("--min-confidence", type=float, default=0.0)
    ap.add_argument("--min-area-m2", type=float, default=0.0)
    ap.add_argument("--dry-run", action="store_true", help="print Detections instead of posting them")
    args = ap.parse_args()

    detect = _load("argus_vision_detect", ARGUS_CORE / "vision" / "detect.py")
    georef = _load("argus_vision_georef", ARGUS_CORE / "vision" / "georef.py")

    if args.before and args.after:
        before, after = args.before, args.after
        if not args.footprint:
            raise SystemExit("offline mode needs --footprint (a capture's .json, or any file with a `footprint` field)")
        footprint = json.loads(args.footprint.read_text())["footprint"]
        before_ref, after_ref = str(before), str(after)
    else:
        before, meta_b = capture(args.hub, f"argus/{args.run_id}/before.png", args.evidence)
        if args.scenario:
            post(args.hub, "/scenarios/run", {"id": f"argus-{args.run_id}", "kind": args.scenario, "params": {}})
        after, meta_a = capture(args.hub, f"argus/{args.run_id}/after.png", args.evidence)
        footprint = meta_a["footprint"]
        before_ref, after_ref = meta_b["ref"], meta_a["ref"]

    bounds = geo_bounds(footprint)
    frame_meta = {"geo_bounds": bounds}
    print(f"[argus] comparing {before} -> {after}", file=sys.stderr)
    findings = detect.compare_images(before, after)
    print(f"[argus] {len(findings)} finding(s) from {detect.MODEL}", file=sys.stderr)

    posted = 0
    for i, f in enumerate(findings, start=1):
        bbox = f["bbox"]
        area = bbox_area_m2(bbox, bounds)
        if f["confidence"] < args.min_confidence or area < args.min_area_m2:
            print(f"[argus] skip {f['label']} (confidence {f['confidence']:.2f}, {area} m2)", file=sys.stderr)
            continue
        ring = georef.bbox_to_polygon(bbox, frame_meta)
        detection = {
            "id": f"argus-{args.run_id}-{i}",
            "polygon": [{"lat": lat, "lon": lon} for lat, lon in ring],
            "confidence": max(0.0, min(1.0, float(f["confidence"]))),
            "change_type": LABEL_TO_CHANGE_TYPE.get(f["label"], "unknown"),
            "before_ref": before_ref,
            "after_ref": after_ref,
            "detected_at": datetime.now(UTC).isoformat(),
            "area_m2": area,
            "metadata": {
                "source": "argus-core.vision",
                "model": detect.MODEL,
                "argus_label": f["label"],
                "description": f["description"],
            },
        }
        if args.dry_run:
            print(json.dumps(detection, indent=2))
        else:
            post(args.hub, "/detections", detection)
            print(f"[argus] posted {detection['id']} {detection['change_type']} ({area} m2)", file=sys.stderr)
        posted += 1

    print(f"[argus] {posted} Detection(s) {'built' if args.dry_run else 'posted'}", file=sys.stderr)


if __name__ == "__main__":
    main()
