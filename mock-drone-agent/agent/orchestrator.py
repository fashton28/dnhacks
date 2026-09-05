"""The loop. This is the whole system in ~100 lines of control flow.

    anomaly
      -> planner (LLM)                    propose a mission
      -> verifier (deterministic)         approve, or reject with reasons
           rejected -> back to planner with the reasons  (up to MAX_ATTEMPTS)
           never approved -> escalate to a human, do not fly
      -> executor (drone control / sim)   fly it, collect observations
      -> triage (LLM)                     decide, and write the incident report

Every transition emits an event, so the dashboard is a pure function of
`runs/events.jsonl` and never has to call into this module.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import planner as planner_mod
from . import triage as triage_mod
from . import verifier as verifier_mod
from .anomaly import for_llm
from .events import EventLog
from .executor import DroneExecutor
from .facility import Facility
from .llm import LLM
from .types import utc_now_iso

MAX_ATTEMPTS = 3
REPORT_DIR = Path("runs/reports")


@dataclass
class MissionOutcome:
    anomaly_id: str
    mission_id: str
    flown: bool
    plan: dict[str, Any] | None
    verdict: dict[str, Any] | None
    result: dict[str, Any] | None
    triage: dict[str, Any]
    attempts: int


class Orchestrator:
    def __init__(
        self,
        facility: Facility,
        llm: LLM,
        executor: DroneExecutor,
        events: EventLog,
        *,
        battery_pct: float = 100.0,
        max_attempts: int = MAX_ATTEMPTS,
        force_bad_first: bool = False,
        report_dir: Path = REPORT_DIR,
    ) -> None:
        self.facility = facility
        self.llm = llm
        self.executor = executor
        self.events = events
        self.battery_pct = battery_pct
        self.max_attempts = max_attempts
        self.force_bad_first = force_bad_first
        self.report_dir = Path(report_dir)
        self._counter = 0

    def _next_mission_id(self) -> str:
        self._counter += 1
        return f"m-{utc_now_iso()[:10].replace('-', '')}-{self._counter:04d}"

    # -- the pipeline --------------------------------------------------------

    def handle_anomaly(self, anomaly: dict[str, Any]) -> MissionOutcome:
        mission_id = self._next_mission_id()
        self.events.emit("anomaly_detected", mission_id, **for_llm(anomaly))

        plan, verdict, attempts, note = self._plan_and_verify(mission_id, anomaly)

        if plan is None or verdict is None or not verdict.approved:
            last_violations = verdict.as_dict()["violations"] if verdict else []
            self.events.emit(
                "plan_abandoned", mission_id, attempts=attempts, last_violations=last_violations
            )
            triage = triage_mod.unflyable_report(anomaly, attempts, last_violations, note)
            self._publish(mission_id, triage)
            return MissionOutcome(
                anomaly_id=anomaly["anomaly_id"],
                mission_id=mission_id,
                flown=False,
                plan=plan,
                verdict=verdict.as_dict() if verdict else None,
                result=None,
                triage=triage,
                attempts=attempts,
            )

        # Approved. Only now does anything touch the airframe.
        self.events.emit("mission_started", mission_id, waypoint_count=len(plan["waypoints"]))
        result = self.executor.execute_mission(plan)
        self.events.emit(
            "mission_completed",
            mission_id,
            status=result.get("status"),
            observation_count=len(result.get("observations", [])),
            telemetry=result.get("telemetry", {}),
        )

        triage = triage_mod.assess(self.llm, anomaly, plan, result)
        self.events.emit(
            "triage_decision",
            mission_id,
            decision=triage["decision"],
            confidence=triage["confidence"],
            rationale=triage["rationale"],
            event_type=triage.get("event_type"),
            assessed_by=triage.get("assessed_by"),
        )
        self._publish(mission_id, triage)

        return MissionOutcome(
            anomaly_id=anomaly["anomaly_id"],
            mission_id=mission_id,
            flown=True,
            plan=plan,
            verdict=verdict.as_dict(),
            result=result,
            triage=triage,
            attempts=attempts,
        )

    def _plan_and_verify(self, mission_id: str, anomaly: dict[str, Any]):
        """Propose -> verify -> repair, until approved or out of attempts."""
        session = planner_mod.build_planner(
            self.llm,
            self.facility,
            for_llm(anomaly),
            self.battery_pct,
            force_bad_first=self.force_bad_first,
        )

        plan = session.propose()
        verdict = None

        for attempt in range(1, self.max_attempts + 1):
            if plan is None:
                # The planner declined to produce a plan at all.
                note = getattr(session, "refusal_text", None) or "planner produced no plan"
                return None, verdict, attempt, note

            plan = {**plan, "mission_id": mission_id}
            self.events.emit("plan_proposed", mission_id, plan=plan, attempt=attempt)

            verdict = verifier_mod.verify(
                plan, self.facility, battery_pct=self.battery_pct, anomaly=anomaly
            )

            if verdict.approved:
                self.events.emit(
                    "plan_approved",
                    mission_id,
                    plan=plan,
                    **{
                        k: v
                        for k, v in verdict.as_dict().items()
                        if k in ("checks_passed", "flight_time_s", "battery_needed_pct")
                    },
                )
                return plan, verdict, attempt, ""

            self.events.emit(
                "plan_rejected",
                mission_id,
                attempt=attempt,
                violations=verdict.as_dict()["violations"],
            )

            if attempt == self.max_attempts:
                break
            plan = session.revise(verdict)

        return None, verdict, self.max_attempts, ""

    # -- reporting ----------------------------------------------------------

    def _publish(self, mission_id: str, triage: dict[str, Any]) -> None:
        self.events.emit(
            "incident_report",
            mission_id,
            title=triage["title"],
            severity=triage["severity"],
            body_markdown=triage["body_markdown"],
            recommended_action=triage["recommended_action"],
        )
        self.report_dir.mkdir(parents=True, exist_ok=True)
        path = self.report_dir / f"{mission_id}.md"
        path.write_text(
            f"# {triage['title']}\n\n"
            f"- **Mission:** `{mission_id}`\n"
            f"- **Decision:** `{triage['decision']}` "
            f"(confidence {triage['confidence']})\n"
            f"- **Severity:** {triage['severity']}\n"
            f"- **Desk:** {triage.get('event_type', 'n/a')}\n"
            f"- **Assessed by:** {triage.get('assessed_by', 'unknown')}\n"
            f"- **Generated:** {utc_now_iso()}\n\n"
            f"## Recommended action\n\n{triage['recommended_action']}\n\n"
            f"## Report\n\n{triage['body_markdown']}\n"
        )

    def run(self, anomalies: list[dict[str, Any]]) -> list[MissionOutcome]:
        self.events.emit(
            "run_started",
            None,
            facility_id=self.facility.facility_id,
            mode="mock" if self.llm.mock else "live",
            model=self.llm.model,
        )
        outcomes = [self.handle_anomaly(a) for a in anomalies]
        self.events.emit(
            "run_finished",
            None,
            missions=len(outcomes),
            escalations=sum(1 for o in outcomes if o.triage["decision"] == "escalate"),
            flown=sum(1 for o in outcomes if o.flown),
        )
        return outcomes
