"""Seed two simulator alerts and request concurrent autonomous inspections.

Preview by default; --run uses an already-running ARGUS simulation. This presets
the incidents, not drone assignments, flight paths or assessment results.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import httpx

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from contracts.models import ChangeType, Detection, LatLon, Scenario
from contracts.site import enu_to_latlon
from hub.drone_select import MARGIN_PCT
from hub.safety import BATTERY_RESERVE_PCT

PRESET = ROOT / "demo" / "presets" / "multi_drone_response.json"
ACTIVE = {"pending", "flying", "paused", "returning"}


def build_preset() -> dict:
    preset = json.loads(PRESET.read_text(encoding="utf-8"))
    run_id = f"demo-{uuid4().hex[:12]}"
    incidents = []
    for item in preset["incidents"]:
        key = f"{run_id}-{item['key']}"
        x, y = item["params"]["x"], item["params"]["y"]
        ring = [LatLon(lat=lat, lon=lon) for lat, lon in (
            enu_to_latlon(x - 6, y - 5), enu_to_latlon(x + 9, y - 5),
            enu_to_latlon(x + 9, y + 7), enu_to_latlon(x - 6, y + 7),
        )]
        detection = Detection(
            id=f"{key}-alert", polygon=ring, confidence=0.84,
            change_type=ChangeType.smoke_plume, detected_at=datetime.now(UTC),
            area_m2=180, before_ref="", after_ref="",
            metadata={"source": "seeded-demo-alert", "note": item["note"]},
        )
        scenario = Scenario(id=key, kind=item["scenario"], params=item["params"])
        incidents.append({"scenario": scenario.model_dump(mode="json"),
                          "detection": detection.model_dump(mode="json")})
    return {"name": preset["name"], "description": preset["description"],
            "run_id": run_id, "incidents": incidents}


async def run_preset(client: httpx.AsyncClient, preset: dict) -> dict:
    async def get(path):
        response = await client.get(path)
        response.raise_for_status()
        return response.json()

    async def post(path, body=None):
        response = await client.post(path, json=body)
        response.raise_for_status()
        return response.json()

    autonomy, drones, missions, scene = await asyncio.gather(
        get("/autonomy"), get("/drones"), get("/missions"), get("/scene"),
    )
    if autonomy["flight_mode"] != "agent":
        raise RuntimeError("Start the Hub with ARGUS_FLIGHT_MODE=agent for concurrent responses.")
    busy = {m["drone_id"] for m in missions if m["phase"] in ACTIVE}
    ready = [d for d in drones if d["status"] == "idle" and d["drone_id"] not in busy
             and d["battery_pct"] >= BATTERY_RESERVE_PCT + MARGIN_PCT]
    if len(ready) < len(preset["incidents"]):
        raise RuntimeError("This preset needs at least two idle drones above the battery reserve; launch a fleet of three.")
    if scene["scenario_ids"] or scene["props"] or scene["open_fences"]:
        raise RuntimeError("The scene already contains a scenario. Use the Console Reset scene control before this demo.")

    # Stage both alerts before dispatching either. No assigned drone or scripted
    # FlightPlan is sent: the Hub performs triage, selection, validation and flight.
    for incident in preset["incidents"]:
        await post("/scenarios/run", incident["scenario"])
        await post("/detections", incident["detection"])

    responses = await asyncio.gather(*(
        post(f"/detections/{i['detection']['id']}/dispatch") for i in preset["incidents"]
    ), return_exceptions=True)
    # Wait for every dispatched request, including when one fails; do not abandon
    # the other flight or automatically retry a request that may already be flying.
    outcomes = [{"error": str(r)} if isinstance(r, Exception) else r for r in responses]
    successful = [o for o in outcomes if o.get("flown")
                  and (o.get("result") or {}).get("status") == "success"
                  and not o["result"].get("hard_stop")]
    distinct = {o["drone_id"] for o in successful}
    completed = {m["mission_id"]: m for m in await get("/missions")}
    intervals = [completed[o["mission_id"]] for o in successful if o["mission_id"] in completed]
    overlapping = False
    if len(intervals) == len(preset["incidents"]) and all(m.get("started_at") and m.get("finished_at") for m in intervals):
        overlapping = max(datetime.fromisoformat(m["started_at"]) for m in intervals) < min(
            datetime.fromisoformat(m["finished_at"]) for m in intervals)
    return {"run_id": preset["run_id"], "llm_mode": autonomy["llm_mode"],
            "overlapping_missions": overlapping,
            "multi_drone_success": overlapping and len(distinct) == len(preset["incidents"]),
            "outcomes": outcomes}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="seed and dispatch against the running simulator")
    parser.add_argument("--hub", default="http://127.0.0.1:8000")
    args = parser.parse_args()
    preset = build_preset()
    if not args.run:
        print(json.dumps(preset, indent=2))
        return

    async def execute():
        async with httpx.AsyncClient(base_url=args.hub.rstrip("/"), timeout=600) as client:
            return await run_preset(client, preset)

    print(f"Starting {preset['name']}. Follow both drones in /gcs/ or /console/.", flush=True)
    try:
        result = asyncio.run(execute())
    except (httpx.HTTPError, RuntimeError) as exc:
        parser.exit(1, f"Demo could not finish: {exc}\nInspect the Hub before retrying; dispatched flights may still be active.\n")
    print(json.dumps(result, indent=2))
    if not result["multi_drone_success"]:
        parser.exit(1, "The demo did not complete two overlapping responses on distinct drones; inspect the outcomes above and restart an older Hub.\n")


if __name__ == "__main__":
    main()
