"""The judgement layer: observations -> decision + written incident report.

This is the half of the LLM layer that is genuinely hard to write as rules. The
planner turns a coordinate into a route; triage turns a pile of detections,
temperatures and captions into "this is a contractor's truck, log it" versus
"someone cut the fence, wake up the duty officer" — and writes the report a
human will actually read at 3am.
"""

from __future__ import annotations

from typing import Any

from . import llm as llm_mod
from .anomaly import for_llm
from .types import TRIAGE_DECISIONS

TOOL_NAME = "submit_triage"

SEVERITIES = ("info", "low", "medium", "high", "critical")

SYSTEM_PROMPT = """You are the triage layer of an autonomous ISR system protecting critical \
energy infrastructure. A satellite layer flagged an anomaly; a drone has now flown to it and \
collected close-range observations. You decide what happens next.

Choose exactly one decision:
  - `false_alarm`  — the satellite detection is explained by something benign and the record \
can be closed. Use this when the close-range evidence positively explains the anomaly.
  - `log_only`     — real but routine. Record it for the next shift; nobody needs to be woken up.
  - `escalate`     — a human operator must act now. Security breach, credible intrusion, or an \
equipment fault with safety or outage consequences.

How to weigh the evidence:
  - Close-range observation outranks the satellite detector. The satellite's confidence score is \
a prior, not a verdict.
  - Detector confidence falls off with slant range. A low-confidence label from a distant hover \
is weak evidence of absence, not evidence of nothing.
  - Absence of a detection is not absence of a threat. A cut fence with nobody in frame is still \
a breach.
  - Distinguish security events from safety events. Both can warrant escalation, but they go to \
different people and the report must say which.
  - Be calibrated. Escalating everything is as useless as escalating nothing. Say plainly what \
would change your mind.

The incident report goes to a human duty officer. Lead with what happened and what they should \
do. State the evidence, then state your uncertainty. No preamble, no restating the prompt."""

USER_TEMPLATE = """ANOMALY AS REPORTED BY THE SATELLITE LAYER
{anomaly}

MISSION FLOWN
{plan_summary}

CLOSE-RANGE OBSERVATIONS COLLECTED
{observations}

TELEMETRY
{telemetry}

Assess this and call the `{tool_name}` tool."""


def triage_tool() -> dict[str, Any]:
    return {
        "name": TOOL_NAME,
        "description": "Submit the triage decision and the incident report for this mission.",
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "decision": {
                    "type": "string",
                    "enum": list(TRIAGE_DECISIONS),
                },
                "confidence": {
                    "type": "number",
                    "description": "0.0-1.0 confidence in the decision, honestly calibrated.",
                },
                "severity": {"type": "string", "enum": list(SEVERITIES)},
                "event_type": {
                    "type": "string",
                    "enum": ["security", "safety", "operational", "none"],
                    "description": "Which desk this belongs to.",
                },
                "title": {
                    "type": "string",
                    "description": "One line, under 80 characters, specific enough to page on.",
                },
                "rationale": {
                    "type": "string",
                    "description": "Two sentences: the decisive evidence, and the main uncertainty.",
                },
                "body_markdown": {
                    "type": "string",
                    "description": (
                        "The incident report in markdown, for a human duty officer: what was "
                        "observed, what it means, what is uncertain, what would change the "
                        "assessment."
                    ),
                },
                "recommended_action": {
                    "type": "string",
                    "description": "The single next action a human should take.",
                },
            },
            "required": [
                "decision",
                "confidence",
                "severity",
                "event_type",
                "title",
                "rationale",
                "body_markdown",
                "recommended_action",
            ],
            "additionalProperties": False,
        },
    }


def _format_plan(plan: dict[str, Any]) -> str:
    lines = [f"  priority: {plan.get('priority')}", f"  rationale: {plan.get('reasoning')}"]
    for i, wp in enumerate(plan.get("waypoints", [])):
        hold = f", hold {wp['duration_s']:.0f}s" if wp["duration_s"] else ""
        lines.append(
            f"  [{i}] {wp['action']} ({wp['lat']:.6f}, {wp['lon']:.6f}) at "
            f"{wp['alt_m']:.0f} m{hold} — {wp['purpose']}"
        )
    return "\n".join(lines)


def _format_observations(observations: list[dict[str, Any]]) -> str:
    if not observations:
        return "  (none collected — the mission returned no observations)"
    out = []
    for obs in observations:
        dets = (
            ", ".join(f"{d['label']} @ {d.get('confidence', 0):.2f}" for d in obs["detections"])
            or "none"
        )
        out.append(
            f"  waypoint {obs['waypoint_index']} — {obs['alt_m']:.0f} m altitude, "
            f"slant range {obs.get('slant_range_m', 0):.0f} m\n"
            f"    detections: {dets}\n"
            f"    thermal max: {obs.get('thermal_max_c')} C | "
            f"RF anomaly: {obs.get('rf_anomaly_db')} dB\n"
            f"    observer notes: {obs.get('caption', '')}"
        )
    return "\n".join(out)


def _format_dict(d: dict[str, Any]) -> str:
    return "\n".join(f"  {k}: {v}" for k, v in d.items()) or "  (none)"


def assess(
    llm: llm_mod.LLM,
    anomaly: dict[str, Any],
    plan: dict[str, Any],
    result: dict[str, Any],
) -> dict[str, Any]:
    """Return a triage dict with the keys declared in `triage_tool`."""
    if llm.mock:
        return _mock_assess(anomaly, result)

    user = USER_TEMPLATE.format(
        anomaly=_format_dict(for_llm(anomaly)),
        plan_summary=_format_plan(plan),
        observations=_format_observations(result.get("observations", [])),
        telemetry=_format_dict(result.get("telemetry", {})),
        tool_name=TOOL_NAME,
    )
    response = llm.create(
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user}],
        tools=[triage_tool()],
    )
    call = llm_mod.first_tool_use(response, TOOL_NAME)
    if call is None:
        # Never silently drop a mission. Fall back to escalation with the
        # model's own text as the report — a human reads it either way.
        text = llm_mod.response_text(response)
        return {
            "decision": "escalate",
            "confidence": 0.3,
            "severity": "medium",
            "event_type": "operational",
            "title": "Triage inconclusive — manual review required",
            "rationale": "The triage model did not return a structured decision.",
            "body_markdown": text or "_No response text returned._",
            "recommended_action": "Review the raw observations manually.",
            "assessed_by": llm.model,
        }
    _, payload = call
    return {**payload, "assessed_by": llm.model}


def _mock_assess(anomaly: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    """Rule-based stand-in. Deliberately cruder than the LLM — that is the point.

    It keys off the strongest detection label, which is exactly the brittleness
    the model layer exists to replace.
    """
    observations = result.get("observations", [])
    labels: dict[str, float] = {}
    thermal = 0.0
    for obs in observations:
        thermal = max(thermal, float(obs.get("thermal_max_c") or 0))
        for det in obs.get("detections", []):
            labels[det["label"]] = max(labels.get(det["label"], 0.0), det.get("confidence", 0.0))

    caption = observations[0].get("caption", "") if observations else ""
    aid = anomaly["anomaly_id"]

    if labels.get("fence_damage", 0) > 0.5 or labels.get("person", 0) > 0.6:
        decision, severity, event_type = "escalate", "high", "security"
        title = "Perimeter breach indicated at north fence line"
        rationale = (
            "Close-range imagery shows physical damage to the perimeter fence. "
            "Whether anyone is still on site is unresolved."
        )
        action = "Dispatch site security to the north perimeter and review gate access logs."
    elif thermal > 75.0:
        decision, severity, event_type = "escalate", "high", "safety"
        title = "Transformer running far above baseline temperature"
        rationale = (
            f"Peak observed surface temperature of {thermal:.0f} C is well above the "
            "adjacent identical unit. No fire or arcing observed."
        )
        action = "Notify the substation duty engineer; consider load transfer off this bank."
    elif labels.get("vehicle", 0) > 0.6:
        decision, severity, event_type = "log_only", "low", "operational"
        title = "Contractor vehicles in south-east service lot"
        rationale = (
            "Vehicles carry utility-contractor livery and are parked in marked bays. "
            "Whether the work order is authorised was not verifiable from the air."
        )
        action = "Cross-check against today's contractor work orders at next shift handover."
    elif not labels:
        decision, severity, event_type = "false_alarm", "info", "none"
        title = "Satellite detection explained by building shadow"
        rationale = (
            "Close-range observation found no object at the flagged coordinate. "
            "The signature aligns with a low-sun-angle shadow."
        )
        action = "Close the record. No action required."
    else:
        decision, severity, event_type = "log_only", "medium", "operational"
        title = f"Unresolved anomaly at {aid}"
        rationale = "Observations were collected but are not conclusive."
        action = "Queue for analyst review."

    detections_md = (
        "\n".join(f"- `{k}` at confidence {v:.2f}" for k, v in sorted(labels.items()))
        or "- none"
    )
    body = (
        f"**Anomaly:** `{aid}` at ({anomaly['lat']:.6f}, {anomaly['lon']:.6f})\n\n"
        f"**Satellite report:** {anomaly['description']}\n\n"
        f"**Close-range observation:** {caption}\n\n"
        f"**Detections:**\n{detections_md}\n\n"
        f"**Peak thermal:** {thermal:.1f} C\n\n"
        f"**Assessment:** {rationale}\n\n"
        f"_Produced by the rule-based mock triage layer. Run with Anthropic credentials "
        f"for a model-written assessment._"
    )
    return {
        "decision": decision,
        "confidence": 0.6,
        "severity": severity,
        "event_type": event_type,
        "title": title,
        "rationale": rationale,
        "body_markdown": body,
        "recommended_action": action,
        "assessed_by": "mock",
    }


def unflyable_report(
    anomaly: dict[str, Any], attempts: int, violations: list[dict[str, Any]], note: str = ""
) -> dict[str, Any]:
    """The report produced when the trust layer refused to authorise any mission.

    This path matters more than the happy path: the system declined to fly and
    told a human why, instead of launching something unsafe.
    """
    reasons = "\n".join(
        f"- `{v.get('code')}` — {v.get('message')}" for v in violations
    ) or "- (none recorded)"
    body = (
        f"**Anomaly:** `{anomaly['anomaly_id']}` at "
        f"({anomaly['lat']:.6f}, {anomaly['lon']:.6f})\n\n"
        f"**Satellite report:** {anomaly['description']}\n\n"
        f"**Outcome:** No mission was authorised. The verification layer rejected all "
        f"{attempts} candidate plans and the drone did not launch.\n\n"
        f"**Blocking constraints:**\n{reasons}\n"
        + (f"\n**Planner's note:** {note}\n" if note else "")
        + "\n**Why this is the correct outcome:** the anomaly cannot be investigated from "
        "the air within the facility's authorised envelope. Autonomous investigation is "
        "not available here; a human decides what happens next."
    )
    return {
        "decision": "escalate",
        "confidence": 0.9,
        "severity": "medium",
        "event_type": "operational",
        "title": f"No authorised mission for {anomaly['anomaly_id']} — human tasking required",
        "rationale": (
            "Every candidate plan violated a hard safety constraint, so nothing was flown."
        ),
        "body_markdown": body,
        "recommended_action": (
            "Task a ground patrol, or extend the authorised flight envelope if the "
            "operator accepts the risk."
        ),
        "assessed_by": "verification-layer",
    }
