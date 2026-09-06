"""The Hub's Incident Report store, and the adapter that produces one.

The autonomy layer's agent speaks its own vocabulary — `title`, `severity`,
`event_type`, `body_markdown`, `recommended_action`, and a decision of
`false_alarm | log_only | escalate`. The Hub speaks `contracts.models.IncidentReport`,
whose verdict is `false_alarm | log | escalate`. `from_agent_outcome` is the single
place that translation happens; note `log_only` -> `log`, which is the only name that
differs and the reason this adapter has to exist at all.

The adapter also does something the agent's markdown cannot: it attaches
`evidence_refs` and `observations`, so a verdict links to the frames that produced it
rather than asserting a conclusion on its own authority.
"""
from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from contracts.models import IncidentReport, IncidentVerdict, Observation

# The agent's decision vocabulary -> the contract's. Only `log_only` differs by name.
_VERDICT = {
    "false_alarm": IncidentVerdict.false_alarm,
    "log_only": IncidentVerdict.log,
    "log": IncidentVerdict.log,
    "escalate": IncidentVerdict.escalate,
}


def _narrative(triage: dict[str, Any]) -> str:
    """One readable block: what happened, how serious, which desk, what to do."""
    title = triage.get("title", "Incident")
    severity = triage.get("severity", "unknown")
    desk = triage.get("event_type") or "unspecified"
    action = triage.get("recommended_action", "")
    body = triage.get("body_markdown", "")
    head = f"**{title}**\n\nSeverity: {severity} · Desk: {desk}"
    if action:
        head += f"\n\nRecommended action: {action}"
    return f"{head}\n\n{body}".strip()


def _observations(mission_id: str, drone_id: str, raw: list[dict[str, Any]]) -> list[Observation]:
    """The executor's observation dicts become contract Observations.

    `salient` marks the frames that carry a detection: those are what a reader should
    look at first, and what the verdict most likely rests on.
    """
    out: list[Observation] = []
    for o in raw:
        detections = o.get("detections") or []
        out.append(
            Observation(
                mission_id=mission_id,
                drone_id=drone_id,
                frame_ref=o.get("frame_ref") or "",  # a capture that returned no frame still counts as an Observation
                waypoint_index=int(o.get("waypoint_index", 0)),
                captured_at=datetime.now(UTC),
                description=o.get("caption") or o.get("description") or "",
                salient=bool(detections),
            )
        )
    return out


def from_agent_outcome(outcome: dict[str, Any]) -> IncidentReport:
    """Build an IncidentReport from one MissionOutcome as the autonomy layer returns it.

    Works for the unflown case too: when a plan cannot be verified the agent still
    produces a triage assessment, and `result` is None. That report carries no
    observations and no evidence, which is the honest representation of a Mission that
    never left the pad.
    """
    triage = outcome.get("triage") or {}
    result = outcome.get("result") or {}
    mission_id = outcome.get("mission_id") or result.get("mission_id") or "unknown"
    drone_id = outcome.get("drone_id") or (result.get("telemetry") or {}).get("drone_id") or ""

    observations = _observations(mission_id, drone_id, result.get("observations") or [])
    evidence = list((result.get("telemetry") or {}).get("evidence") or [])
    # Frames an Observation names but the mission did not list are still evidence.
    for o in observations:
        if o.frame_ref and o.frame_ref not in evidence:
            evidence.append(o.frame_ref)

    return IncidentReport(
        mission_id=mission_id,
        verdict=_VERDICT.get(str(triage.get("decision", "")), IncidentVerdict.log),
        narrative=_narrative(triage),
        evidence_refs=evidence,
        observations=observations,
        created_at=datetime.now(UTC),
    )


class IncidentStore:
    """In-memory, insertion-ordered, newest last. Keyed by mission_id."""

    def __init__(self, limit: int = 200) -> None:
        self._items: dict[str, IncidentReport] = {}
        self._limit = limit

    def add(self, report: IncidentReport) -> IncidentReport:
        self._items.pop(report.mission_id, None)
        self._items[report.mission_id] = report
        while len(self._items) > self._limit:
            self._items.pop(next(iter(self._items)))
        return report

    def get(self, mission_id: str) -> IncidentReport | None:
        return self._items.get(mission_id)

    def all(self) -> list[IncidentReport]:
        return list(self._items.values())

    def __len__(self) -> int:
        return len(self._items)
