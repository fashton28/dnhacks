"""Autonomy layer adapter: the mock-drone-agent's planner, verifier and triage drive our Hub's Drones.

- Detections (ours) become anomalies (theirs).
- Their Orchestrator plans with Claude (or its offline mock), verifies against the Meridian Facility generated
  from site.geojson, and hands approved plans to HubExecutor, which flies them on a real Drone through the
  Mission runner and returns observations built from the Renderer's evidence frames.
- Their events are mirrored onto our live feed as mission_spec / validation / triage / incident events.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any

from contracts.models import Detection, DroneStatus, FlightPlan, Waypoint
from contracts.site import distance_m, latlon_to_enu

ROOT = Path(__file__).resolve().parent.parent
AGENT_DIR = ROOT / "mock-drone-agent"
FACILITY = ROOT / "sim" / "site" / "facility_meridian.json"
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from agent.events import EventLog  # noqa: E402
from agent.facility import Facility  # noqa: E402
from agent.llm import LLM  # noqa: E402
from agent.orchestrator import Orchestrator  # noqa: E402


class LiveEventLog(EventLog):
    """The agent's JSONL event log, mirrored onto the Hub live feed with Console-shaped translations."""

    def __init__(self, path: Path, publish, loop: asyncio.AbstractEventLoop):
        super().__init__(path, echo=False)
        self._publish = publish
        self._loop = loop

    def emit(self, type_: str, mission_id: str | None = None, **payload: Any) -> dict[str, Any]:
        ev = super().emit(type_, mission_id, **payload)
        out = [{"type": "autonomy", "event": ev}]
        if type_ == "plan_proposed":
            plan = payload.get("plan", {})
            wps = plan.get("waypoints", [])
            out.append({"type": "mission_spec", "mission_id": mission_id, "spec": {
                "objective": plan.get("priority", "inspect"), "rationale": plan.get("reasoning", ""),
                "max_altitude_m": max([w.get("alt_m", 0) for w in wps] or [0]), "standoff_m": 0, "attempt": payload.get("attempt")}})
        elif type_ == "plan_rejected":
            out.append({"type": "validation", "mission_id": mission_id, "result": {"verdict": "reject", "attempt": payload.get("attempt"),
                        "violations": [{"rule": v.get("code", "rule"), "detail": v.get("message", ""), "severity": "violation"} for v in payload.get("violations", [])]}})
        elif type_ == "plan_approved":
            out.append({"type": "validation", "mission_id": mission_id, "result": {"verdict": "accept", "violations": [],
                        "checks_passed": payload.get("checks_passed"), "flight_time_s": payload.get("flight_time_s"), "battery_needed_pct": payload.get("battery_needed_pct")}})
        elif type_ == "plan_abandoned":
            out.append({"type": "validation", "mission_id": mission_id, "result": {"verdict": "reject", "abandoned": True,
                        "violations": [{"rule": v.get("code", "rule"), "detail": v.get("message", ""), "severity": "violation"} for v in payload.get("last_violations", [])]}})
        elif type_ == "triage_decision":
            out.append({"type": "triage", "mission_id": mission_id, **{k: payload.get(k) for k in ("decision", "confidence", "rationale")}})
        elif type_ == "incident_report":
            out.append({"type": "incident", "mission_id": mission_id, **{k: payload.get(k) for k in ("title", "severity", "body_markdown", "recommended_action")}})
        for o in out:
            self._loop.call_soon_threadsafe(self._publish, o)
        return ev


class HubExecutor:
    """The agent's DroneExecutor protocol, backed by our Mission runner and Renderer evidence."""

    def __init__(self, hub_app, loop: asyncio.AbstractEventLoop, events: LiveEventLog, describe):
        self.app = hub_app
        self.loop = loop
        self.events = events
        self.describe = describe
        self.last_drone_id: str | None = None

    def _run(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout=60)

    def execute_mission(self, plan: dict[str, Any]) -> dict[str, Any]:
        reg, runner = self.app.state.registry, self.app.state.missions
        wps = [Waypoint(lat=w["lat"], lon=w["lon"], alt=float(w["alt_m"])) for w in plan["waypoints"]]
        fp = FlightPlan(mission_id=plan.get("mission_id", f"agent-{int(time.time())}"), waypoints=wps, pattern="agent",
                        est_duration_s=float(plan.get("flight_time_s", 120.0)), est_battery_pct=float(plan.get("battery_needed_pct", 10.0)))

        async def start():
            idle = [s for s in reg.states() if s.status == DroneStatus.idle and reg.drones[s.drone_id].ws is not None]
            if not idle:
                raise RuntimeError("no idle Drone available")
            drone_id = max(idle, key=lambda s: s.battery_pct).drone_id
            return runner.start(fp, drone_id)

        m = self._run(start())
        self.last_drone_id = m.drone_id
        mission_id = m.mission_id
        seen = -1
        while True:
            time.sleep(0.5)
            cur = runner.missions[mission_id]
            while seen + 1 < min(cur.next_waypoint, len(wps)):
                seen += 1
                w = plan["waypoints"][seen]
                self.events.emit("waypoint_reached", plan.get("mission_id"), index=seen, lat=w["lat"], lon=w["lon"], alt_m=w["alt_m"], action=w.get("action", "flyto"))
            if cur.phase.value in ("complete", "failed", "aborted"):
                break
        observations = []
        for i, w in enumerate(plan["waypoints"]):
            if w.get("action") != "hover" and i != len(plan["waypoints"]) - 1:
                continue
            ref = f"evidence/{mission_id}/wp{i}.jpg"
            path = self.app.state.settings.evidence_dir / mission_id / f"wp{i}.jpg" if self.app.state.settings.evidence_dir else None
            obs = self.describe(path if path and path.exists() else None, w, reg.scene, i)
            obs.update({"waypoint_index": i, "frame_ref": ref, "lat": w["lat"], "lon": w["lon"], "alt_m": w["alt_m"]})
            observations.append(obs)
            self.events.emit("observation", plan.get("mission_id"), **obs)
        st = reg.drones[m.drone_id].state
        return {"mission_id": plan.get("mission_id"), "status": "success" if cur.phase.value == "complete" else cur.phase.value,
                "observations": observations, "telemetry": {"drone_id": m.drone_id, "battery_end_pct": st.battery_pct if st else None, "evidence": cur.evidence, "error": cur.error}}


def describe_from_scene(frame: Path | None, wp: dict[str, Any], scene, index: int) -> dict[str, Any]:
    """Offline observation: what the Scenario engine placed near this waypoint (stands in for the vision model)."""
    x, y = latlon_to_enu(wp["lat"], wp["lon"])
    seen, dets = [], []
    for p in scene.props:
        d = ((p.x - x) ** 2 + (p.y - y) ** 2) ** 0.5
        if d < 60:
            label = {"vehicle": "vehicle", "crate": "unattended_object", "person": "person"}.get(p.kind, p.kind)
            conf = round(max(0.3, min(0.95, 1.0 - d / 80)), 2)
            dets.append({"label": label, "confidence": conf})
            seen.append(f"a {p.kind} about {d:.0f} m from the camera")
    if scene.open_fences:
        dets.append({"label": "fence_damage", "confidence": 0.7})
        seen.append(f"an opening in fence section {scene.open_fences[0]}")
    caption = ("Frame shows " + "; ".join(seen) + ".") if seen else "Frame shows lawn, fences and buildings with nothing unusual."
    return {"detections": dets, "caption": caption, "thermal_max_c": None, "rf_anomaly_db": None,
            "assessed_by": "scene-truth stub (no vision model credentials)", "frame_available": frame is not None}


def describe_with_claude(frame: Path | None, wp: dict[str, Any], scene, index: int) -> dict[str, Any]:
    """Vision model observation of the evidence frame (Anthropic)."""
    if frame is None:
        return describe_from_scene(frame, wp, scene, index)
    import anthropic

    client = anthropic.Anthropic()
    model = os.environ.get("ARGUS_VISION_MODEL", "claude-opus-5")
    b64 = base64.b64encode(frame.read_bytes()).decode()
    tool = {"name": "report_observation", "description": "Report what the drone camera frame shows.", "strict": True,
            "input_schema": {"type": "object", "additionalProperties": False, "required": ["caption", "detections"],
                             "properties": {"caption": {"type": "string"},
                                            "detections": {"type": "array", "items": {"type": "object", "additionalProperties": False, "required": ["label", "confidence"],
                                                                                        "properties": {"label": {"type": "string"}, "confidence": {"type": "number"}}}}}}}
    resp = client.messages.create(model=model, max_tokens=800, tools=[tool], tool_choice={"type": "tool", "name": "report_observation"},
                                  messages=[{"role": "user", "content": [
                                      {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}},
                                      {"type": "text", "text": f"Security drone frame at waypoint {index}, altitude {wp['alt_m']} m, over a simulated power plant perimeter. "
                                                               "Describe what is visible for a security operator: vehicles, people, objects, fence damage, anything unusual. "
                                                               "Label detections from: vehicle, person, unattended_object, fence_damage, nothing_unusual."}]}])
    for block in resp.content:
        if block.type == "tool_use":
            return {**block.input, "thermal_max_c": None, "rf_anomaly_db": None, "assessed_by": model, "frame_available": True}
    return describe_from_scene(frame, wp, scene, index)


def detection_to_anomaly(d: Detection) -> dict[str, Any]:
    lat = sum(p.lat for p in d.polygon) / len(d.polygon)
    lon = sum(p.lon for p in d.polygon) / len(d.polygon)
    desc = f"Overhead change detection flagged a {d.change_type.value.replace('_', ' ')} sized about {d.area_m2 or 0:.0f} m2 " \
           f"near ({lat:.5f}, {lon:.5f}). {d.metadata.get('note', '')}".strip()
    return {"anomaly_id": d.id, "lat": lat, "lon": lon, "detected_at": d.detected_at.isoformat(), "source": d.metadata.get("source", "overhead-change-detection"),
            "confidence": d.confidence, "description": desc, "ground_truth": None}


class Autonomy:
    def __init__(self, hub_app, loop: asyncio.AbstractEventLoop, runs_dir: Path):
        self.app = hub_app
        self.loop = loop
        self.detections: dict[str, Detection] = {}
        self.outcomes: dict[str, dict[str, Any]] = {}
        self.facility = Facility.load(FACILITY)
        self.llm = LLM(mode=os.environ.get("ARGUS_LLM_MODE", "auto"))
        self.events = LiveEventLog(runs_dir / "agent_events.jsonl", hub_app.state.registry.publish, loop)
        describe = describe_with_claude if (os.environ.get("ANTHROPIC_API_KEY") and os.environ.get("ARGUS_VISION", "claude") == "claude") else describe_from_scene
        self.executor = HubExecutor(hub_app, loop, self.events, describe)
        self.orchestrator = Orchestrator(self.facility, self.llm, self.executor, self.events, report_dir=runs_dir / "reports")
        self._lock = threading.Lock()

    @property
    def mode(self) -> str:
        return "mock" if getattr(self.llm, "mock", True) else "live"

    def add_detection(self, d: Detection) -> Detection:
        self.detections[d.id] = d
        self.app.state.registry.publish({"type": "detection", "detection": d.model_dump(mode="json")})
        return d

    async def dispatch(self, detection_id: str) -> dict[str, Any]:
        d = self.detections[detection_id]
        anomaly = detection_to_anomaly(d)

        def run():
            with self._lock:
                st = self.orchestrator.executor  # noqa: F841
                outcome = self.orchestrator.handle_anomaly(anomaly)
            return {"anomaly_id": outcome.anomaly_id, "mission_id": outcome.mission_id, "flown": outcome.flown, "attempts": outcome.attempts,
                    "plan": outcome.plan, "verdict": outcome.verdict, "result": outcome.result, "triage": outcome.triage,
                    "drone_id": self.executor.last_drone_id}

        outcome = await asyncio.to_thread(run)
        self.outcomes[detection_id] = outcome
        self.app.state.registry.publish({"type": "dispatch_outcome", "detection_id": detection_id, **{k: outcome[k] for k in ("mission_id", "flown", "attempts", "triage", "drone_id")}})
        return outcome
