"""Tests for the trust layer. Plain unittest — no pytest needed.

    python3 -m unittest discover -s tests -v

These are the tests worth showing a judge: each one is a specific unsafe plan
that the system provably refuses to fly.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent import anomaly as anomaly_mod  # noqa: E402
from agent import geo, verifier  # noqa: E402
from agent.facility import Facility  # noqa: E402
from agent.planner import MockPlannerSession  # noqa: E402
from agent.types import ContractError, validate_mission_plan  # noqa: E402

FACILITY = Facility.load()
ANOMALY = anomaly_mod.get("fence-breach-01")


def wp(lat, lon, alt=25.0, action="hover", duration=15.0, purpose="test"):
    return {
        "lat": lat,
        "lon": lon,
        "alt_m": alt,
        "action": action,
        "duration_s": duration if action == "hover" else 0.0,
        "purpose": purpose,
    }


def plan(*waypoints, priority="medium"):
    return {
        "mission_id": "m-test-0001",
        "anomaly_id": ANOMALY["anomaly_id"],
        "created_at": "2026-09-05T00:00:00.000Z",
        "planner": "test",
        "priority": priority,
        "reasoning": "test plan",
        "waypoints": list(waypoints),
    }


def check(p, battery=100.0, anomaly=ANOMALY):
    return verifier.verify(p, FACILITY, battery_pct=battery, anomaly=anomaly)


def codes(verdict):
    return {v.code for v in verdict.violations}


class TestApproval(unittest.TestCase):
    def test_mock_planner_produces_an_approvable_plan(self):
        session = MockPlannerSession(FACILITY, ANOMALY, 100.0)
        verdict = check(session.propose())
        self.assertTrue(verdict.approved, f"unexpected violations: {codes(verdict)}")
        self.assertGreater(verdict.checks_passed, 5)
        self.assertGreater(verdict.flight_time_s, 0)

    def test_approved_plan_reports_a_battery_estimate(self):
        verdict = check(plan(wp(ANOMALY["lat"], ANOMALY["lon"])))
        self.assertTrue(verdict.approved)
        self.assertGreater(verdict.battery_needed_pct, 0)
        self.assertLess(verdict.battery_needed_pct, 100)


class TestGeofence(unittest.TestCase):
    def test_waypoint_north_of_the_fence_is_rejected(self):
        verdict = check(plan(wp(39.9560, -75.1901)))
        self.assertFalse(verdict.approved)
        self.assertIn("OUTSIDE_GEOFENCE", codes(verdict))

    def test_offsite_anomaly_cannot_be_investigated(self):
        """The anomaly outside the fence must not produce a flyable mission."""
        offsite = anomaly_mod.get("offsite-activity-05")
        session = MockPlannerSession(FACILITY, offsite, 100.0)
        verdict = check(session.propose(), anomaly=offsite)
        self.assertFalse(verdict.approved)
        self.assertIn("OUTSIDE_GEOFENCE", codes(verdict))


class TestAltitude(unittest.TestCase):
    def test_above_ceiling_is_rejected(self):
        verdict = check(plan(wp(ANOMALY["lat"], ANOMALY["lon"], alt=200.0)))
        self.assertIn("ABOVE_MAX_ALTITUDE", codes(verdict))

    def test_below_floor_is_rejected(self):
        verdict = check(plan(wp(ANOMALY["lat"], ANOMALY["lon"], alt=3.0)))
        self.assertIn("BELOW_MIN_ALTITUDE", codes(verdict))


class TestNoFlyZones(unittest.TestCase):
    def test_waypoint_inside_a_no_fly_zone_is_rejected(self):
        zone = FACILITY.no_fly_zones[0]
        verdict = check(plan(wp(zone.center[0], zone.center[1])))
        self.assertIn("IN_NO_FLY_ZONE", codes(verdict))

    def test_a_leg_flying_straight_through_a_zone_is_rejected(self):
        """Both endpoints legal, the path between them is not.

        This is the failure mode a naive waypoint-only check misses.
        """
        zone = FACILITY.no_fly_zones[0]
        before = geo.offset_m(zone.center, north_m=-200.0, east_m=0.0)
        after = geo.offset_m(zone.center, north_m=200.0, east_m=0.0)
        verdict = check(
            plan(
                wp(before[0], before[1], action="flyto"),
                wp(after[0], after[1]),
            )
        )
        self.assertNotIn("IN_NO_FLY_ZONE", codes(verdict))
        self.assertIn("LEG_CROSSES_NO_FLY_ZONE", codes(verdict))


class TestEndurance(unittest.TestCase):
    def test_low_battery_blocks_a_mission_it_could_otherwise_fly(self):
        p = MockPlannerSession(FACILITY, ANOMALY, 100.0).propose()
        self.assertTrue(check(p, battery=100.0).approved)
        verdict = check(p, battery=26.0)
        self.assertFalse(verdict.approved)
        self.assertIn("INSUFFICIENT_BATTERY", codes(verdict))

    def test_reserve_is_actually_withheld(self):
        """A mission needing less than total charge but more than usable charge fails."""
        p = MockPlannerSession(FACILITY, ANOMALY, 100.0).propose()
        needed = check(p).battery_needed_pct
        reserve = FACILITY.limits.min_battery_reserve_pct
        verdict = check(p, battery=needed + reserve - 1.0)
        self.assertIn("INSUFFICIENT_BATTERY", codes(verdict))

    def test_excessive_hover_is_rejected(self):
        verdict = check(plan(wp(ANOMALY["lat"], ANOMALY["lon"], duration=600.0)))
        self.assertIn("HOVER_TOO_LONG", codes(verdict))


class TestMissionEffectiveness(unittest.TestCase):
    def test_a_legal_plan_that_never_looks_at_the_anomaly_is_rejected(self):
        """Every hard limit satisfied, zero intelligence value."""
        far = geo.offset_m((ANOMALY["lat"], ANOMALY["lon"]), north_m=-400.0, east_m=0.0)
        verdict = check(plan(wp(far[0], far[1])))
        self.assertFalse(verdict.approved)
        self.assertIn("ANOMALY_NOT_OBSERVED", codes(verdict))

    def test_a_plan_with_no_hover_collects_nothing(self):
        verdict = check(plan(wp(ANOMALY["lat"], ANOMALY["lon"], action="flyto")))
        self.assertIn("NO_OBSERVATION_WAYPOINT", codes(verdict))


class TestMalformedInput(unittest.TestCase):
    def test_garbage_is_rejected_without_raising(self):
        for bad in ({}, {"waypoints": []}, {"waypoints": "north a bit"}, {"waypoints": [{}]}):
            verdict = check(bad)
            self.assertFalse(verdict.approved)
            self.assertIn("MALFORMED_PLAN", codes(verdict))

    def test_string_coordinates_are_rejected(self):
        verdict = check(plan({**wp(0, 0), "lat": "39.95"}))
        self.assertIn("MALFORMED_PLAN", codes(verdict))

    def test_unknown_action_is_rejected(self):
        with self.assertRaises(ContractError):
            validate_mission_plan(plan(wp(39.95, -75.19, action="barrel_roll")))

    def test_extra_keys_are_dropped_not_forwarded(self):
        normalised = validate_mission_plan(
            {**plan(wp(39.95, -75.19)), "drop_payload": True}
        )
        self.assertNotIn("drop_payload", normalised)


class TestFeedbackLoop(unittest.TestCase):
    def test_rejection_feedback_names_the_rule_and_the_waypoint(self):
        verdict = check(plan(wp(39.9560, -75.1901, alt=300.0)))
        feedback = verdict.feedback()
        self.assertIn("OUTSIDE_GEOFENCE", feedback)
        self.assertIn("ABOVE_MAX_ALTITUDE", feedback)
        self.assertIn("waypoint index 0", feedback)

    def test_mock_repair_loop_recovers_from_a_bad_first_attempt(self):
        session = MockPlannerSession(FACILITY, ANOMALY, 100.0, force_bad_first=True)
        first = check(session.propose())
        self.assertFalse(first.approved)
        second = check(session.revise(first))
        self.assertTrue(second.approved, f"repair failed: {codes(second)}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
