"""Run the entire portable slice with fixture JSON."""
from __future__ import annotations

import json
from pathlib import Path

from pipeline import run_pipeline

ROOT = Path(__file__).parent
detection = json.loads((ROOT / "fixtures/detection.json").read_text())
policy = json.loads((ROOT / "fixtures/policy.json").read_text())
drone = {"drone_id": "drone-1", "lat": 39.9495, "lon": -75.1900, "battery_pct": 90, "link_state": "healthy"}

print(json.dumps(run_pipeline(detection, drone, policy), indent=2))
