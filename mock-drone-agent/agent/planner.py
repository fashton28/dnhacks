"""The planning layer: anomaly + constraints -> mission plan.

The planner is a *session*, not a single call, because the verification layer
rejects plans and the planner has to repair them. A rejection comes back as a
tool error in the same conversation, so the model sees exactly which rule it
broke and fixes that waypoint instead of re-planning from scratch.

    session = build_planner(llm, facility, anomaly, battery_pct)
    plan = session.propose()
    verdict = verifier.verify(plan, facility, battery_pct=..., anomaly=anomaly)
    if not verdict.approved:
        plan = session.revise(verdict)   # <- the repair loop

Both the live and mock planners implement this interface, so the orchestrator
does not know or care which one it has.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import geo, llm as llm_mod
from .facility import Facility
from .types import PRIORITIES, utc_now_iso

CONTRACT_PATH = Path(__file__).resolve().parent.parent / "contracts" / "mission_plan.schema.json"

TOOL_NAME = "propose_mission"

SYSTEM_PROMPT = """You are the mission planning layer of an autonomous ISR (intelligence, \
surveillance, reconnaissance) system that inspects critical energy infrastructure.

A wide-area satellite change-detection layer flags anomalies at a facility. Your job is to turn \
one flagged anomaly into a short, safe, close-inspection drone mission that gathers enough \
observation to decide whether it is a real security or safety event.

How to plan:
- Start and end implicitly at the base; do not add the base as a waypoint. Takeoff and landing \
are handled by the flight controller.
- Transit at a safe altitude, then descend to observe. Use `flyto` to move and `hover` to collect \
sensor observations.
- Give the anomaly two viewing angles when the battery allows it. One hover directly over or \
beside the anomaly, plus one offset hover, resolves most false alarms that a single view will not.
- Keep it short. Battery is the binding constraint, and an aborted mission observes nothing.
- Every waypoint's `purpose` should say, in one line, what that waypoint is for.

You must respect the hard limits below exactly. A separate deterministic verification layer \
checks your plan against them before any motor spins, and it will reject the whole mission if \
any single waypoint violates one. If your plan is rejected you will be told precisely which \
rule failed; fix that specific problem and keep the rest of the plan.

Some anomalies cannot be safely investigated at all — for example, one located outside the \
geofence, or one that would require flying through a no-fly zone with no way around. Do not \
invent a plan that pretends otherwise. If no legal plan exists, say so in plain text instead of \
calling the tool, and the system will escalate to a human operator.

{facility_brief}
"""

USER_PROMPT = """SATELLITE ANOMALY REPORT
  anomaly_id: {anomaly_id}
  location:   ({lat:.6f}, {lon:.6f})
  detected:   {detected_at}
  source:     {source}
  detector confidence: {confidence}
  description: {description}

CURRENT DRONE STATE
  battery: {battery_pct:.0f}%
  position: at base, landed

RELATIVE GEOMETRY (precomputed for you — trust these over your own arithmetic)
{geometry}

Plan the inspection mission by calling the `{tool_name}` tool."""


def _waypoint_schema() -> dict[str, Any]:
    """Pull the waypoint definition straight out of the shared contract file.

    One source of truth: if the team changes the contract, the tool the model
    sees changes with it. Inlined rather than passed as a `$ref`, because a
    strict tool schema must be self-contained.
    """
    contract = json.loads(CONTRACT_PATH.read_text())
    return contract["$defs"]["waypoint"]


def mission_tool() -> dict[str, Any]:
    return {
        "name": TOOL_NAME,
        "description": (
            "Submit a drone mission plan to investigate the flagged anomaly. The plan is "
            "checked against the facility's hard safety limits before it is flown."
        ),
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": {
                "priority": {
                    "type": "string",
                    "enum": list(PRIORITIES),
                    "description": (
                        "How urgently a human should look at the result. 'high' for a "
                        "probable intrusion or equipment fault, 'low' for a likely "
                        "false alarm worth logging."
                    ),
                },
                "reasoning": {
                    "type": "string",
                    "description": (
                        "Two or three sentences: what you are trying to observe, why this "
                        "route, and what would make this a false alarm."
                    ),
                },
                # No `minItems` here on purpose: strict tool schemas support a
                # restricted subset of JSON Schema, and an unsupported keyword
                # is a 400 rather than a warning. "At least one waypoint" is
                # enforced by types.validate_mission_plan, which runs on every
                # plan regardless of where it came from.
                "waypoints": {
                    "type": "array",
                    "items": _waypoint_schema(),
                    "description": (
                        "Ordered mission waypoints, at least one, excluding takeoff "
                        "and landing."
                    ),
                },
            },
            "required": ["priority", "reasoning", "waypoints"],
            "additionalProperties": False,
        },
    }


def _geometry_brief(facility: Facility, anomaly: dict[str, Any]) -> str:
    """Distances the model would otherwise have to derive from raw lat/lon.

    Models are poor at mental great-circle arithmetic and good at using numbers
    they are handed. This removes a whole class of plan rejections.
    """
    target = (anomaly["lat"], anomaly["lon"])
    lines = [
        f"  - base -> anomaly: {geo.haversine_m(facility.base, target):.0f} m "
        f"on a bearing of {geo.bearing_deg(facility.base, target):.0f}deg",
        f"  - anomaly is {'INSIDE' if geo.point_in_polygon(target, facility.geofence) else 'OUTSIDE'} "
        f"the geofence",
    ]
    for zone in facility.no_fly_zones:
        d = geo.haversine_m(target, zone.center)
        lines.append(
            f"  - anomaly -> no-fly zone '{zone.id}': {d:.0f} m "
            f"(zone radius {zone.radius_m:.0f} m)"
        )
    lines.append(
        "  - 0.00001deg of latitude is about 1.1 m; 0.00001deg of longitude is about 0.85 m here"
    )
    return "\n".join(lines)


class LivePlannerSession:
    """A planning conversation with Claude, including the repair loop."""

    def __init__(
        self, llm: llm_mod.LLM, facility: Facility, anomaly: dict[str, Any], battery_pct: float
    ) -> None:
        self.llm = llm
        self.facility = facility
        self.anomaly = anomaly
        self.battery_pct = battery_pct
        self.attempts = 0
        self.refusal_text: str | None = None
        self._tool_use_id: str | None = None

        self.system = SYSTEM_PROMPT.format(facility_brief=facility.prompt_brief())
        self.messages: list[dict[str, Any]] = [
            {
                "role": "user",
                "content": USER_PROMPT.format(
                    anomaly_id=anomaly["anomaly_id"],
                    lat=anomaly["lat"],
                    lon=anomaly["lon"],
                    detected_at=anomaly["detected_at"],
                    source=anomaly["source"],
                    confidence=anomaly["confidence"],
                    description=anomaly["description"],
                    battery_pct=battery_pct,
                    geometry=_geometry_brief(facility, anomaly),
                    tool_name=TOOL_NAME,
                ),
            }
        ]

    def _call(self) -> dict[str, Any] | None:
        self.attempts += 1
        response = self.llm.create(
            system=self.system, messages=self.messages, tools=[mission_tool()]
        )
        self.messages.append({"role": "assistant", "content": response.content})

        call = llm_mod.first_tool_use(response, TOOL_NAME)
        if call is None:
            # The model judged that no legal plan exists, and said so in text.
            self._tool_use_id = None
            self.refusal_text = llm_mod.response_text(response) or "planner returned no plan"
            return None

        self._tool_use_id, tool_input = call
        return {
            **tool_input,
            "anomaly_id": self.anomaly["anomaly_id"],
            "created_at": utc_now_iso(),
            "planner": self.llm.model,
        }

    def propose(self) -> dict[str, Any] | None:
        return self._call()

    def revise(self, verdict) -> dict[str, Any] | None:
        """Feed the rejection back as a tool error and ask for a repair."""
        if self._tool_use_id is None:
            return None
        self.messages.append(
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": self._tool_use_id,
                        "is_error": True,
                        "content": (
                            "MISSION REJECTED by the verification layer. The drone did not "
                            "launch. Violations:\n"
                            f"{verdict.feedback()}\n\n"
                            "Fix only what failed and resubmit the corrected plan by calling "
                            f"`{TOOL_NAME}` again. If no plan can satisfy these constraints, "
                            "reply in plain text explaining why instead of calling the tool."
                        ),
                    }
                ],
            }
        )
        return self._call()


class MockPlannerSession:
    """Deterministic stand-in so the pipeline runs with no API key.

    It plans the obvious mission: transit high to the anomaly, drop down for a
    close hover, then take a second look from an offset angle. With
    `force_bad_first=True` its first attempt is deliberately illegal, which is
    the easiest way to demo the verification layer and the repair loop.
    """

    def __init__(
        self,
        facility: Facility,
        anomaly: dict[str, Any],
        battery_pct: float,
        *,
        force_bad_first: bool = False,
    ) -> None:
        self.facility = facility
        self.anomaly = anomaly
        self.battery_pct = battery_pct
        self.force_bad_first = force_bad_first
        self.attempts = 0
        self.refusal_text: str | None = None

    def _wrap(self, priority: str, reasoning: str, waypoints: list[dict[str, Any]]):
        return {
            "anomaly_id": self.anomaly["anomaly_id"],
            "created_at": utc_now_iso(),
            "planner": "mock",
            "priority": priority,
            "reasoning": reasoning,
            "waypoints": waypoints,
        }

    def _good_plan(self) -> dict[str, Any]:
        lim = self.facility.limits
        target = (self.anomaly["lat"], self.anomaly["lon"])
        transit_alt = min(lim.max_alt_m, 60.0)
        offset = geo.offset_m(target, north_m=-35.0, east_m=25.0)
        return self._wrap(
            "high" if self.anomaly.get("confidence", 0) >= 0.7 else "medium",
            "Transit at 60 m to stay clear of ground obstacles, descend to 25 m directly over "
            "the reported coordinate for a close look, then take a second oblique view from "
            "the south-east to resolve shadow and occlusion ambiguity.",
            [
                {
                    "lat": target[0],
                    "lon": target[1],
                    "alt_m": transit_alt,
                    "action": "flyto",
                    "duration_s": 0,
                    "purpose": "transit to the anomaly at a safe altitude",
                },
                {
                    "lat": target[0],
                    "lon": target[1],
                    "alt_m": 25.0,
                    "action": "hover",
                    "duration_s": 20,
                    "purpose": "close overhead observation of the reported coordinate",
                },
                {
                    "lat": offset[0],
                    "lon": offset[1],
                    "alt_m": 30.0,
                    "action": "hover",
                    "duration_s": 15,
                    "purpose": "oblique second view to resolve occlusion and shadow",
                },
            ],
        )

    def _bad_plan(self) -> dict[str, Any]:
        """Legal-looking and unflyable: too high, and parked in a no-fly zone."""
        zone = (
            self.facility.no_fly_zones[0]
            if self.facility.no_fly_zones
            else None
        )
        target = (self.anomaly["lat"], self.anomaly["lon"])
        waypoints = [
            {
                "lat": target[0],
                "lon": target[1],
                "alt_m": self.facility.limits.max_alt_m + 80.0,
                "action": "hover",
                "duration_s": 240,
                "purpose": "get a wide overview of the whole site from high up",
            }
        ]
        if zone is not None:
            waypoints.append(
                {
                    "lat": zone.center[0],
                    "lon": zone.center[1],
                    "alt_m": 20.0,
                    "action": "hover",
                    "duration_s": 30,
                    "purpose": "inspect the switchyard equipment on the way past",
                }
            )
        return self._wrap(
            "high",
            "Climb high for a single wide overview covering the anomaly and the adjacent "
            "equipment yard in one pass.",
            waypoints,
        )

    def propose(self) -> dict[str, Any] | None:
        self.attempts += 1
        if self.force_bad_first:
            return self._bad_plan()
        return self._good_plan()

    def revise(self, verdict) -> dict[str, Any] | None:
        self.attempts += 1
        # The mock cannot reason its way out of a genuinely impossible anomaly
        # (e.g. one outside the geofence); returning the same plan lets the
        # orchestrator exhaust its retries and escalate, which is correct.
        return self._good_plan()


def build_planner(
    llm: llm_mod.LLM,
    facility: Facility,
    anomaly: dict[str, Any],
    battery_pct: float,
    *,
    force_bad_first: bool = False,
):
    if llm.mock:
        return MockPlannerSession(
            facility, anomaly, battery_pct, force_bad_first=force_bad_first
        )
    return LivePlannerSession(llm, facility, anomaly, battery_pct)
