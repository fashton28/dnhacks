"""Mission execution: fly an accepted FlightPlan on one Drone, waypoint by waypoint, capturing a frame at each."""
from __future__ import annotations

import asyncio
import base64
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path

from pydantic import BaseModel

from contracts.models import FlightPlan, Waypoint
from contracts.protocol import CaptureFrame, Frame, Goto, RenderFrame, ReturnHome
from contracts.site import distance_m
from hub.audit import AuditLog
from hub.registry import Registry

H_TOL_M = 2.0
V_TOL_M = 1.0


class MissionPhase(StrEnum):
    pending = "pending"
    flying = "flying"
    paused = "paused"
    returning = "returning"
    complete = "complete"
    aborted = "aborted"
    failed = "failed"


class Mission(BaseModel):
    mission_id: str
    drone_id: str
    plan: FlightPlan
    phase: MissionPhase = MissionPhase.pending
    next_waypoint: int = 0
    evidence: list[str] = []
    error: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None


StationHook = Callable[["Mission", int], Awaitable[None]]


class MissionRunner:
    def __init__(self, registry: Registry, audit: AuditLog, evidence_dir: Path | None, speed_factor: float = 1.0):
        self.registry = registry
        self.audit = audit
        self.evidence_dir = evidence_dir
        self.speed_factor = speed_factor
        self.missions: dict[str, Mission] = {}
        self.tasks: dict[str, asyncio.Task[None]] = {}
        self.resume_events: dict[str, asyncio.Event] = {}
        # on-station hooks: awaited after the capture at the given waypoint indices while the Drone holds position
        self.station_hooks: dict[str, tuple[set[int], StationHook]] = {}

    def _publish(self, m: Mission) -> None:
        self.registry.publish({"type": "mission", "mission": m.model_dump(mode="json")})

    def start(self, plan: FlightPlan, drone_id: str, on_station: tuple[set[int], StationHook] | None = None) -> Mission:
        m = Mission(mission_id=plan.mission_id, drone_id=drone_id, plan=plan.model_copy(update={"drone_id": drone_id}))
        self.missions[m.mission_id] = m
        if on_station is not None:
            self.station_hooks[m.mission_id] = on_station
        self.resume_events[m.mission_id] = asyncio.Event()
        self.resume_events[m.mission_id].set()
        self.tasks[m.mission_id] = asyncio.create_task(self._run(m))
        self.audit.append("mission_started", mission_id=m.mission_id, drone_id=drone_id, waypoints=len(plan.waypoints))
        self._publish(m)
        return m

    def pause(self, mission_id: str) -> Mission:
        m = self.missions[mission_id]
        if m.phase == MissionPhase.flying:
            m.phase = MissionPhase.paused
            self.resume_events[mission_id].clear()
            self.audit.append("mission_paused", mission_id=mission_id, next_waypoint=m.next_waypoint)
            self._publish(m)
        return m

    def resume(self, mission_id: str) -> Mission:
        m = self.missions[mission_id]
        if m.phase == MissionPhase.paused:
            m.phase = MissionPhase.flying
            self.resume_events[mission_id].set()
            self.audit.append("mission_resumed", mission_id=mission_id, next_waypoint=m.next_waypoint)
            self._publish(m)
        return m

    async def abort(self, mission_id: str) -> Mission:
        m = self.missions[mission_id]
        task = self.tasks.get(mission_id)
        if task and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        m.phase = MissionPhase.aborted
        m.finished_at = datetime.now(UTC)
        self.audit.append("mission_aborted", mission_id=mission_id)
        self._publish(m)
        await self._return_home(m)
        return m

    def active_for(self, drone_id: str) -> Mission | None:
        for m in self.missions.values():
            if m.drone_id == drone_id and m.phase in (MissionPhase.pending, MissionPhase.flying, MissionPhase.paused, MissionPhase.returning):
                return m
        return None

    # ---- internals -------------------------------------------------------------
    async def _wait_arrival(self, drone_id: str, wp: Waypoint, timeout_s: float, mission: Mission | None = None) -> None:
        conn = self.registry.drones[drone_id]
        deadline = asyncio.get_running_loop().time() + timeout_s / self.speed_factor
        while True:
            if mission is not None and mission.phase == MissionPhase.paused:
                return  # Manual Control took over mid-leg; the loop re-sends this waypoint after resume
            st = conn.state
            if st is not None and st.message.startswith("REFUSED"):
                raise RuntimeError(f"autopilot refused waypoint ({wp.lat:.6f}, {wp.lon:.6f}, {wp.alt}): {st.message}")
            if st is not None and distance_m(st.lat, st.lon, wp.lat, wp.lon) <= H_TOL_M and abs(st.alt - wp.alt) <= V_TOL_M:
                return
            if asyncio.get_running_loop().time() > deadline:
                raise TimeoutError(f"{drone_id} did not reach waypoint ({wp.lat:.6f}, {wp.lon:.6f}, {wp.alt}) in {timeout_s}s")
            await asyncio.sleep(0.05)

    async def _capture(self, m: Mission, index: int) -> None:
        conn = self.registry.drones[m.drone_id]
        cmd_id = self.registry.new_cmd_id()
        if conn.sim == "fake":
            fut = self.registry.await_frame(m.drone_id, cmd_id)
            ack = await self.registry.send(m.drone_id, CaptureFrame(cmd_id=cmd_id))
            if not ack.ok:
                conn.frame_waiters.pop(cmd_id, None)
                return
            frame: Frame = await asyncio.wait_for(fut, 10.0)
        else:
            # real Drones have no camera of their own: the Renderer draws what the Drone sees
            try:
                frame = await self.registry.ask_renderer(RenderFrame(cmd_id=cmd_id, drone_id=m.drone_id))
            except LookupError:
                self.audit.append("capture_skipped", mission_id=m.mission_id, waypoint=index, reason="no renderer connected")
                return
        ref = f"evidence/{m.mission_id}/wp{index}.jpg"
        if self.evidence_dir is not None:
            path = self.evidence_dir / m.mission_id / f"wp{index}.jpg"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(base64.b64decode(frame.jpeg_b64))
            (path.with_suffix(".json")).write_text(frame.model_copy(update={"jpeg_b64": ""}).model_dump_json(indent=2))
        m.evidence.append(ref)
        self.audit.append("frame_captured", mission_id=m.mission_id, ref=ref, lat=frame.lat, lon=frame.lon, alt=frame.alt)
        self._publish(m)

    async def _return_home(self, m: Mission) -> None:
        try:
            await self.registry.send(m.drone_id, ReturnHome(cmd_id=self.registry.new_cmd_id()))
        except Exception as e:  # noqa: BLE001
            self.audit.append("return_home_failed", mission_id=m.mission_id, error=str(e))

    async def _run(self, m: Mission) -> None:
        m.phase = MissionPhase.flying
        m.started_at = datetime.now(UTC)
        self._publish(m)
        try:
            wps = m.plan.waypoints
            while m.next_waypoint < len(wps):
                await self.resume_events[m.mission_id].wait()
                i = m.next_waypoint
                wp = wps[i]
                ack = await self.registry.send(m.drone_id, Goto(cmd_id=self.registry.new_cmd_id(), lat=wp.lat, lon=wp.lon, alt=wp.alt))
                if not ack.ok:
                    raise RuntimeError(f"goto refused: {ack.detail}")
                self.audit.append("goto", mission_id=m.mission_id, waypoint=i, lat=wp.lat, lon=wp.lon, alt=wp.alt)
                await self._wait_arrival(m.drone_id, wp, timeout_s=300.0 if i == 0 else 120.0, mission=m)
                if m.phase == MissionPhase.paused:
                    await self.resume_events[m.mission_id].wait()
                    continue  # re-send this waypoint after resume
                await self._capture(m, i)
                hook = self.station_hooks.get(m.mission_id)
                if hook is not None and i in hook[0]:
                    self.audit.append("on_station", mission_id=m.mission_id, waypoint=i)
                    try:
                        await hook[1](m, i)
                    except Exception as e:  # noqa: BLE001
                        self.audit.append("on_station_failed", mission_id=m.mission_id, waypoint=i, error=str(e)[:200])
                    # the hook may have moved the Drone; come back to the approved waypoint before continuing
                    await self.registry.send(m.drone_id, Goto(cmd_id=self.registry.new_cmd_id(), lat=wp.lat, lon=wp.lon, alt=wp.alt))
                    await self._wait_arrival(m.drone_id, wp, timeout_s=120.0, mission=m)
                m.next_waypoint = i + 1
                self._publish(m)
            m.phase = MissionPhase.returning
            self._publish(m)
            await self._return_home(m)
            m.phase = MissionPhase.complete
            self.audit.append("mission_complete", mission_id=m.mission_id, evidence=len(m.evidence))
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            m.phase = MissionPhase.failed
            m.error = str(e)
            self.audit.append("mission_failed", mission_id=m.mission_id, error=str(e))
            await self._return_home(m)
        finally:
            m.finished_at = datetime.now(UTC)
            self._publish(m)
