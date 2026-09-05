"""Run a live Gemini before/after image comparison against authorised frames.

Example:
  python3 run_vision_pipeline.py --before before.png --after after.png \
    --frame-meta frame_meta.json --drone drone.json --policy fixtures/policy.json
"""
from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path

from autonomy import process_frame_pair


def load_json(path: str) -> dict:
    return json.loads(Path(path).read_text())


def standalone_frame_meta(policy: dict, after_path: str) -> dict:
    """Demo fallback when Webots/Fable has not supplied image calibration yet.

    It maps the whole screenshot onto the policy geofence's bounding rectangle.
    This is sufficient for an independent demo. Replace it with the simulator's
    camera footprint once that interface exists.
    """
    geofence = policy["geofence"]
    lats, lons = [p[0] for p in geofence], [p[1] for p in geofence]
    return {
        "frame_id": Path(after_path).stem,
        "captured_at": datetime.now(UTC).isoformat(),
        "source": "standalone-screenshot-demo",
        "geo_bounds": {
            "north_lat": max(lats), "south_lat": min(lats),
            "west_lon": min(lons), "east_lon": max(lons),
        },
    }


def standalone_drone(policy: dict) -> dict:
    """Healthy simulated drone used until the dashboard/controller sends state."""
    geofence = policy["geofence"]
    return {
        "drone_id": "sim-drone-1",
        "lat": sum(p[0] for p in geofence) / len(geofence),
        "lon": sum(p[1] for p in geofence) / len(geofence),
        "battery_pct": 90,
        "link_state": "healthy",
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--before", default="input/before.png")
    parser.add_argument("--after", default="input/after.png")
    parser.add_argument("--frame-meta", help="optional simulator camera footprint JSON")
    parser.add_argument("--drone", help="optional live drone-state JSON")
    parser.add_argument("--policy", default="fixtures/policy.json")
    parser.add_argument("--events", default="runs/dashboard_events.jsonl")
    args = parser.parse_args()

    policy = load_json(args.policy)
    outcomes = process_frame_pair(
        before_image=args.before,
        after_image=args.after,
        frame_meta=load_json(args.frame_meta) if args.frame_meta else standalone_frame_meta(policy, args.after),
        drone_state=load_json(args.drone) if args.drone else standalone_drone(policy),
        policy=policy,
        events_path=args.events,
    )
    print(json.dumps(outcomes, indent=2))


if __name__ == "__main__":
    main()
