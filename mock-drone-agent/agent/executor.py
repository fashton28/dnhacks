"""The seam with the drone-control / simulation layer.

THE ONLY THING THE SIM TEAM HAS TO IMPLEMENT is one method:

    def execute_mission(self, plan: dict) -> dict

`plan` matches `contracts/mission_plan.schema.json`. The return value matches
`MISSION_RESULT` below. `SimStubExecutor` implements it so the LLM layer works
today; `Px4Executor` is the real one, with the MAVSDK calls stubbed out and the
exact shape to fill in.

Nothing in this file talks to a model.
"""

from __future__ import annotations

import random
import time
from typing import Any, Callable, Protocol

from . import geo
from .events import EventLog
from .facility import Facility
from .types import utc_now_iso


def _catalogue_lookup(anomaly_id: str) -> dict[str, Any]:
    """Default ground-truth source: the mock satellite catalogue.

    Only the stub executor needs this — the real one gets its observations from
    a camera, not from an answer key.
    """
    from .anomaly import BY_ID

    return dict(BY_ID.get(anomaly_id, {}))

# The return contract, documented as data so it can be pasted into a review.
MISSION_RESULT = {
    "mission_id": "str, echoed back from the plan",
    "status": "'success' | 'aborted' | 'failed'",
    "observations": "list of observation objects (see contracts/events.md)",
    "telemetry": {
        "flight_time_s": "float",
        "battery_start_pct": "float",
        "battery_end_pct": "float",
        "distance_m": "float",
    },
    "error": "str, present only when status != 'success'",
}


class DroneExecutor(Protocol):
    """Anything that can fly a verified mission plan."""

    def execute_mission(self, plan: dict[str, Any]) -> dict[str, Any]: ...


# ---------------------------------------------------------------------------
# Stub executor: no simulator required. Use this until PX4 SITL is wired up.
# ---------------------------------------------------------------------------


class SimStubExecutor:
    """Pretends to fly the mission and synthesizes plausible sensor observations.

    Observations are generated from the anomaly's hidden `ground_truth`, so
    triage has something real to reason about — and so a false alarm actually
    looks like a false alarm rather than being labelled as one.
    """

    def __init__(
        self,
        facility: Facility,
        events: EventLog,
        *,
        anomaly_lookup: Callable[[str], dict[str, Any]] | None = None,
        battery_start_pct: float = 100.0,
        seed: int | None = None,
        realtime: bool = False,
    ) -> None:
        self.facility = facility
        self.events = events
        # Ground truth is resolved per mission from the plan's anomaly_id, the
        # same way a real executor is constructed once and flies many missions.
        self.anomaly_lookup = anomaly_lookup or _catalogue_lookup
        self.battery_start_pct = battery_start_pct
        self.rng = random.Random(seed)
        # `realtime` inserts short sleeps so a live demo looks like a flight
        # instead of instant output. Off by default so tests stay fast.
        self.realtime = realtime

    def execute_mission(self, plan: dict[str, Any]) -> dict[str, Any]:
        from .verifier import estimate_flight  # local import avoids a cycle

        mission_id = plan.get("mission_id", "")
        waypoints = plan["waypoints"]
        anomaly = self.anomaly_lookup(plan.get("anomaly_id", ""))
        observations: list[dict[str, Any]] = []

        for i, wp in enumerate(waypoints):
            if self.realtime:
                time.sleep(0.35)
            self.events.emit(
                "waypoint_reached",
                mission_id,
                index=i,
                lat=wp["lat"],
                lon=wp["lon"],
                alt_m=wp["alt_m"],
                action=wp["action"],
            )
            if wp["action"] == "hover":
                obs = self._observe(i, wp, anomaly)
                observations.append(obs)
                self.events.emit("observation", mission_id, **obs)

        flight_time_s, distance_m = estimate_flight(self.facility, waypoints)
        drain = (flight_time_s / 60.0) * self.facility.limits.battery_drain_pct_per_min
        return {
            "mission_id": mission_id,
            "status": "success",
            "observations": observations,
            "telemetry": {
                "flight_time_s": round(flight_time_s, 1),
                "battery_start_pct": self.battery_start_pct,
                "battery_end_pct": round(self.battery_start_pct - drain, 1),
                "distance_m": round(distance_m, 1),
            },
        }

    def _observe(
        self, index: int, wp: dict[str, Any], anomaly: dict[str, Any]
    ) -> dict[str, Any]:
        """Synthesize a sensor reading consistent with what is actually there."""
        truth = anomaly.get("ground_truth")
        target = (anomaly.get("lat", wp["lat"]), anomaly.get("lon", wp["lon"]))
        dist = geo.haversine_m((wp["lat"], wp["lon"]), target)

        # Confidence falls off with slant range — a distant hover sees less.
        slant = (dist**2 + wp["alt_m"] ** 2) ** 0.5
        clarity = max(0.25, min(1.0, 45.0 / max(slant, 1.0)))
        jitter = lambda: self.rng.uniform(-0.05, 0.05)  # noqa: E731

        profiles: dict[str | None, dict[str, Any]] = {
            "fence_cut": {
                "detections": [
                    {"label": "fence_damage", "confidence": round(0.86 * clarity + jitter(), 2)},
                    {"label": "person", "confidence": round(0.31 * clarity + jitter(), 2)},
                ],
                "thermal_max_c": round(29.0 + self.rng.uniform(0, 1.5), 1),
                "rf_anomaly_db": round(self.rng.uniform(0, 1.2), 1),
                "caption": (
                    "Chain-link fabric is cut and folded inward over roughly 2 m. Ground "
                    "vegetation inside the line is flattened in a narrow track leading south. "
                    "No person currently visible in frame."
                ),
            },
            "intruder": {
                "detections": [
                    {"label": "person", "confidence": round(0.79 * clarity + jitter(), 2)},
                    {"label": "backpack", "confidence": round(0.44 * clarity + jitter(), 2)},
                ],
                "thermal_max_c": round(33.5 + self.rng.uniform(0, 1.0), 1),
                "rf_anomaly_db": round(self.rng.uniform(2.0, 5.0), 1),
                "caption": (
                    "One individual on foot, stationary, facing the perimeter fence. No "
                    "high-visibility vest or site PPE. A second object consistent with a "
                    "backpack is on the ground beside them."
                ),
            },
            "vehicle_authorized": {
                "detections": [
                    {"label": "vehicle", "confidence": round(0.91 * clarity + jitter(), 2)},
                    {"label": "utility_livery", "confidence": round(0.72 * clarity + jitter(), 2)},
                ],
                "thermal_max_c": round(41.0 + self.rng.uniform(0, 3.0), 1),
                "rf_anomaly_db": round(self.rng.uniform(0, 0.8), 1),
                "caption": (
                    "Three light trucks parked in marked bays. Two carry utility-contractor "
                    "livery and orange beacons. Engine bays are warm, consistent with recent "
                    "arrival. Fence line intact behind them."
                ),
            },
            "equipment_fault": {
                "detections": [
                    {"label": "transformer", "confidence": round(0.94 * clarity + jitter(), 2)},
                    {"label": "oil_stain", "confidence": round(0.58 * clarity + jitter(), 2)},
                ],
                "thermal_max_c": round(87.0 + self.rng.uniform(0, 6.0), 1),
                "rf_anomaly_db": round(self.rng.uniform(4.0, 9.0), 1),
                "caption": (
                    "Transformer bushing and upper radiator bank running far hotter than the "
                    "adjacent identical unit. A dark stain is visible on the plinth below the "
                    "bushing. No smoke, no visible arcing, no personnel present."
                ),
            },
            "nothing": {
                "detections": [],
                "thermal_max_c": round(27.5 + self.rng.uniform(0, 1.0), 1),
                "rf_anomaly_db": round(self.rng.uniform(0, 0.5), 1),
                "caption": (
                    "Bare gravel apron. The rectangular signature in the satellite pass "
                    "aligns with the shadow cast by the control building at low sun angle. "
                    "No object, no disturbed ground, fence line intact."
                ),
            },
        }

        profile = profiles.get(truth, profiles["nothing"])
        return {
            "waypoint_index": index,
            "lat": wp["lat"],
            "lon": wp["lon"],
            "alt_m": wp["alt_m"],
            "timestamp": utc_now_iso(),
            "slant_range_m": round(slant, 1),
            **profile,
        }


# ---------------------------------------------------------------------------
# The real one. Sim team: fill this in; nothing else in the project changes.
# ---------------------------------------------------------------------------


class Px4Executor:
    """PX4 SITL executor over MAVSDK.

    Fill in the two marked blocks and pass an instance of this to
    `Orchestrator(executor=...)` instead of `SimStubExecutor`. The rest of the
    system is unchanged — that is the point of the contract.

    Sketch of the MAVSDK-Python shape (async; wrap with `asyncio.run`):

        from mavsdk import System
        drone = System()
        await drone.connect(system_address="udp://:14540")
        async for state in drone.core.connection_state():
            if state.is_connected:
                break
        await drone.action.arm()
        await drone.action.set_takeoff_altitude(transit_alt)
        await drone.action.takeoff()

        for wp in plan["waypoints"]:
            await drone.action.goto_location(wp["lat"], wp["lon"], abs_alt, 0.0)
            # poll drone.telemetry.position() until within an acceptance radius
            if wp["action"] == "hover":
                await asyncio.sleep(wp["duration_s"])
                obs = capture_observation(...)   # camera / gimbal / your CV model

        await drone.action.return_to_launch()

    Two things worth getting right early:
      - `goto_location` takes AMSL altitude, while the mission plan is in metres
        AGL relative to the base. Convert once, in `_to_amsl`, not at each call.
      - Emit a `waypoint_reached` event as each waypoint is achieved, and an
        `observation` event per hover, so the dashboard animates live instead of
        jumping at the end.
    """

    def __init__(
        self,
        facility: Facility,
        events: EventLog,
        *,
        connection: str = "udp://:14540",
        base_amsl_m: float = 0.0,
    ) -> None:
        self.facility = facility
        self.events = events
        self.connection = connection
        self.base_amsl_m = base_amsl_m

    def _to_amsl(self, alt_agl_m: float) -> float:
        return self.base_amsl_m + alt_agl_m

    def execute_mission(self, plan: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError(
            "Px4Executor.execute_mission is the sim team's piece. It must accept a plan "
            "matching contracts/mission_plan.schema.json and return the MISSION_RESULT "
            "shape from agent/executor.py. Use SimStubExecutor until then."
        )
