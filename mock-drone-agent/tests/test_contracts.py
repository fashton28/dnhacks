"""Everything on the live API path that can be checked without the network.

The point of this file: the first `--mode live` run should fail for interesting
reasons (credentials, rate limits), not because a tool schema was malformed or
a prompt template had a stale placeholder. Run it before you burn API budget.

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent import anomaly as anomaly_mod  # noqa: E402
from agent import planner, triage  # noqa: E402
from agent.events import EventLog  # noqa: E402
from agent.executor import SimStubExecutor  # noqa: E402
from agent.facility import Facility  # noqa: E402
from agent.types import validate_mission_plan  # noqa: E402

FACILITY = Facility.load()
ANOMALY = anomaly_mod.for_llm(anomaly_mod.get("fence-breach-01"))

# Keywords the strict-tool-schema subset does not accept. An unsupported
# keyword is a 400 from the API, so catch it here instead.
UNSUPPORTED_IN_STRICT = ("minItems", "maxItems", "minimum", "maximum", "pattern", "$ref")


class TestToolSchemas(unittest.TestCase):
    def all_tools(self):
        return [planner.mission_tool(), triage.triage_tool()]

    def test_schemas_satisfy_strict_mode_requirements(self):
        for tool in self.all_tools():
            with self.subTest(tool=tool["name"]):
                schema = tool["input_schema"]
                self.assertIs(tool["strict"], True)
                self.assertIs(schema["additionalProperties"], False)
                self.assertEqual(set(schema["required"]), set(schema["properties"]))

    def test_no_unsupported_keywords_anywhere_in_the_schemas(self):
        for tool in self.all_tools():
            serialized = json.dumps(tool["input_schema"])
            for keyword in UNSUPPORTED_IN_STRICT:
                with self.subTest(tool=tool["name"], keyword=keyword):
                    self.assertNotIn(keyword, serialized)

    def test_waypoint_schema_comes_from_the_shared_contract(self):
        contract = json.loads(planner.CONTRACT_PATH.read_text())
        items = planner.mission_tool()["input_schema"]["properties"]["waypoints"]["items"]
        self.assertEqual(items, contract["$defs"]["waypoint"])
        self.assertEqual(set(items["required"]), set(items["properties"]))

    def test_a_plan_shaped_like_the_tool_output_passes_validation(self):
        """The model's tool output must satisfy the contract without massaging."""
        tool_output = {
            "priority": "high",
            "reasoning": "test",
            "waypoints": [
                {
                    "lat": ANOMALY["lat"],
                    "lon": ANOMALY["lon"],
                    "alt_m": 25.0,
                    "action": "hover",
                    "duration_s": 20.0,
                    "purpose": "observe",
                }
            ],
        }
        plan = validate_mission_plan(
            {**tool_output, "anomaly_id": "a", "planner": "test", "mission_id": "m"}
        )
        self.assertEqual(len(plan["waypoints"]), 1)


class TestPromptRendering(unittest.TestCase):
    def test_planner_prompts_render_with_real_data(self):
        system = planner.SYSTEM_PROMPT.format(facility_brief=FACILITY.prompt_brief())
        user = planner.USER_PROMPT.format(
            anomaly_id=ANOMALY["anomaly_id"],
            lat=ANOMALY["lat"],
            lon=ANOMALY["lon"],
            detected_at=ANOMALY["detected_at"],
            source=ANOMALY["source"],
            confidence=ANOMALY["confidence"],
            description=ANOMALY["description"],
            battery_pct=100.0,
            geometry=planner._geometry_brief(FACILITY, ANOMALY),
            tool_name=planner.TOOL_NAME,
        )
        # Every hard limit must actually reach the model.
        for needle in ("GEOFENCE", "NO-FLY", "120", "switchyard", "propose_mission"):
            self.assertIn(needle, system + user)

    def test_the_answer_key_never_reaches_a_prompt(self):
        """`ground_truth` is for the simulator only."""
        full = anomaly_mod.get("fence-breach-01")
        self.assertIn("ground_truth", full)
        self.assertNotIn("ground_truth", anomaly_mod.for_llm(full))
        self.assertNotIn("ground_truth", triage._format_dict(anomaly_mod.for_llm(full)))

    def test_triage_prompt_renders_against_a_real_mission_result(self):
        events = EventLog(Path("runs/test_contracts.jsonl"), echo=False)
        plan = planner.MockPlannerSession(FACILITY, ANOMALY, 100.0).propose()
        plan["mission_id"] = "m-test"
        plan["anomaly_id"] = "fence-breach-01"
        result = SimStubExecutor(FACILITY, events, seed=1).execute_mission(plan)
        user = triage.USER_TEMPLATE.format(
            anomaly=triage._format_dict(ANOMALY),
            plan_summary=triage._format_plan(plan),
            observations=triage._format_observations(result["observations"]),
            telemetry=triage._format_dict(result["telemetry"]),
            tool_name=triage.TOOL_NAME,
        )
        self.assertIn("fence_damage", user)
        self.assertIn("submit_triage", user)

    def test_triage_prompt_handles_a_mission_that_observed_nothing(self):
        self.assertIn("none", triage._format_observations([]))


class TestSystemPromptIsCacheable(unittest.TestCase):
    def test_the_facility_brief_is_byte_stable(self):
        """A timestamp or set-ordering in here would silently kill prompt caching."""
        first = FACILITY.prompt_brief()
        for _ in range(3):
            self.assertEqual(Facility.load().prompt_brief(), first)


if __name__ == "__main__":
    unittest.main(verbosity=2)
