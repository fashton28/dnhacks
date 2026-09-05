"""Append-only event log — the integration seam with the dashboard.

Why a file and not a queue: the dashboard team can `tail -f runs/events.jsonl`
or poll it with two lines of code, on any language or stack, with no service to
stand up and nothing to coordinate. See `contracts/events.md`.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Iterator

from .types import utc_now_iso

DEFAULT_PATH = Path("runs/events.jsonl")

# Terminal colours, so a live demo is readable. Disabled when not a TTY.
_COLORS = {
    "anomaly_detected": "\033[95m",
    "plan_proposed": "\033[94m",
    "plan_rejected": "\033[91m",
    "plan_approved": "\033[92m",
    "plan_abandoned": "\033[91m",
    "mission_started": "\033[96m",
    "observation": "\033[37m",
    "triage_decision": "\033[93m",
    "incident_report": "\033[1;93m",
}
_RESET = "\033[0m"


class EventLog:
    """Writes events to a JSONL file and mirrors a human-readable line to stdout."""

    def __init__(self, path: str | Path = DEFAULT_PATH, *, echo: bool = True) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.echo = echo
        self._seq = self._last_seq()
        self._use_color = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None

    def _last_seq(self) -> int:
        if not self.path.exists():
            return 0
        last = 0
        with self.path.open() as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    last = max(last, int(json.loads(line).get("seq", 0)))
                except (json.JSONDecodeError, TypeError, ValueError):
                    continue
        return last

    def emit(self, type_: str, mission_id: str | None = None, **payload: Any) -> dict[str, Any]:
        self._seq += 1
        event = {
            "seq": self._seq,
            "ts": utc_now_iso(),
            "mission_id": mission_id,
            "type": type_,
            "payload": payload,
        }
        with self.path.open("a") as f:
            f.write(json.dumps(event, default=str) + "\n")
            f.flush()
        if self.echo:
            self._print(event)
        return event

    def _print(self, event: dict[str, Any]) -> None:
        line = f"[{event['seq']:>3}] {event['type']:<18} {_summarize(event)}"
        color = _COLORS.get(event["type"], "") if self._use_color else ""
        reset = _RESET if color else ""
        print(f"{color}{line}{reset}", flush=True)


def _summarize(event: dict[str, Any]) -> str:
    """One-line human summary. Only for the terminal — the JSONL is the real output."""
    p = event.get("payload") or {}
    t = event["type"]
    if t == "run_started":
        return f"facility={p.get('facility_id')} mode={p.get('mode')}"
    if t == "anomaly_detected":
        return f"{p.get('anomaly_id')} @ ({p.get('lat')}, {p.get('lon')}) conf={p.get('confidence')}"
    if t == "plan_proposed":
        plan = p.get("plan") or {}
        return f"attempt {p.get('attempt')}: {len(plan.get('waypoints', []))} waypoints, priority={plan.get('priority')}"
    if t == "plan_rejected":
        codes = ", ".join(v.get("code", "?") for v in p.get("violations", []))
        return f"attempt {p.get('attempt')} BLOCKED: {codes}"
    if t == "plan_approved":
        return (
            f"{p.get('checks_passed')} checks passed, "
            f"est {p.get('flight_time_s', 0):.0f}s / {p.get('battery_needed_pct', 0):.1f}% battery"
        )
    if t == "plan_abandoned":
        return f"no valid plan after {p.get('attempts')} attempts — escalating to human"
    if t == "mission_started":
        return f"{p.get('waypoint_count')} waypoints dispatched to drone control"
    if t == "waypoint_reached":
        return f"#{p.get('index')} ({p.get('lat'):.5f}, {p.get('lon'):.5f}) {p.get('alt_m')}m {p.get('action')}"
    if t == "observation":
        labels = ", ".join(
            f"{d.get('label')} {d.get('confidence', 0):.2f}" for d in p.get("detections", [])
        )
        return f"wp#{p.get('waypoint_index')}: {labels or 'no detections'} | {p.get('caption', '')}"
    if t == "mission_completed":
        return f"status={p.get('status')} observations={p.get('observation_count')}"
    if t == "triage_decision":
        return f"{str(p.get('decision', '')).upper()} (confidence {p.get('confidence')}) — {p.get('rationale', '')[:90]}"
    if t == "incident_report":
        return f"[{p.get('severity')}] {p.get('title')}"
    if t == "run_finished":
        return f"{p.get('missions')} missions, {p.get('escalations')} escalations"
    return json.dumps(p, default=str)[:160]


def read_events(
    path: str | Path = DEFAULT_PATH, since_seq: int = 0
) -> Iterator[dict[str, Any]]:
    """Yield events with seq > since_seq. Skips partially-written trailing lines."""
    path = Path(path)
    if not path.exists():
        return
    with path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue  # writer was mid-flush; it will be there next poll
            if event.get("seq", 0) > since_seq:
                yield event
