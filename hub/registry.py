"""In-memory state of the Fleet, the controller connections, pending acks, and the live event fan-out."""
from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from fastapi import WebSocket

from contracts.models import DroneState, DroneStatus, SceneState
from contracts.protocol import Ack, Command, Frame, Overhead

OFFLINE_AFTER_S = 2.0


@dataclass
class DroneConn:
    drone_id: str
    ws: WebSocket
    sim: str
    state: DroneState | None = None
    last_seen: float = 0.0
    pending: dict[str, asyncio.Future[Ack]] = field(default_factory=dict)
    frame_waiters: dict[str, asyncio.Future[Frame]] = field(default_factory=dict)
    last_frame: Frame | None = None


@dataclass
class RendererConn:
    renderer_id: str
    ws: WebSocket
    sim: str
    pending: dict[str, asyncio.Future[Any]] = field(default_factory=dict)


class Registry:
    def __init__(self) -> None:
        self.drones: dict[str, DroneConn] = {}
        self.renderers: dict[str, RendererConn] = {}
        self.scene = SceneState()
        self.live: set[asyncio.Queue[dict[str, Any]]] = set()

    # ---- live fan-out to Console clients -------------------------------------
    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=500)
        self.live.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        self.live.discard(q)

    def publish(self, event: dict[str, Any]) -> None:
        for q in list(self.live):
            if q.full():
                try:
                    q.get_nowait()  # drop oldest for slow consumers
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(event)

    # ---- drones ---------------------------------------------------------------
    def add_drone(self, drone_id: str, ws: WebSocket, sim: str) -> DroneConn:
        conn = DroneConn(drone_id=drone_id, ws=ws, sim=sim, last_seen=asyncio.get_running_loop().time())
        self.drones[drone_id] = conn
        return conn

    def remove_drone(self, drone_id: str) -> None:
        conn = self.drones.get(drone_id)
        if conn is None:
            return
        for fut in list(conn.pending.values()) + list(conn.frame_waiters.values()):
            if not fut.done():
                fut.set_exception(ConnectionError(f"{drone_id} disconnected"))
        if conn.state is not None:
            conn.state = conn.state.model_copy(update={"status": DroneStatus.offline, "ts": datetime.now(UTC)})
            self.publish({"type": "drone_state", "state": conn.state.model_dump(mode="json")})
        conn.ws = None  # type: ignore[assignment]

    def states(self) -> list[DroneState]:
        return [c.state for c in self.drones.values() if c.state is not None]

    def mark_stale(self) -> None:
        now = asyncio.get_running_loop().time()
        for conn in self.drones.values():
            if conn.state is None or conn.ws is None:
                continue
            if now - conn.last_seen > OFFLINE_AFTER_S and conn.state.status != DroneStatus.offline:
                conn.state = conn.state.model_copy(update={"status": DroneStatus.offline, "ts": datetime.now(UTC)})
                self.publish({"type": "drone_state", "state": conn.state.model_dump(mode="json")})

    async def send(self, drone_id: str, cmd: Command, timeout: float = 5.0) -> Ack:
        conn = self.drones.get(drone_id)
        if conn is None or conn.ws is None:
            raise LookupError(f"unknown or offline drone {drone_id}")
        fut: asyncio.Future[Ack] = asyncio.get_running_loop().create_future()
        conn.pending[cmd.cmd_id] = fut
        try:
            await conn.ws.send_text(cmd.model_dump_json())
            return await asyncio.wait_for(fut, timeout)
        finally:
            conn.pending.pop(cmd.cmd_id, None)

    # ---- renderers ---------------------------------------------------------------
    def add_renderer(self, renderer_id: str, ws: WebSocket, sim: str) -> RendererConn:
        conn = RendererConn(renderer_id, ws, sim)
        self.renderers[renderer_id] = conn
        return conn

    def remove_renderer(self, renderer_id: str) -> None:
        conn = self.renderers.pop(renderer_id, None)
        if conn:
            for fut in conn.pending.values():
                if not fut.done():
                    fut.set_exception(ConnectionError("renderer disconnected"))

    def pick_renderer(self) -> RendererConn | None:
        # prefer a headless renderer (deterministic), else any browser
        for c in self.renderers.values():
            if c.sim == "headless":
                return c
        return next(iter(self.renderers.values()), None)

    async def ask_renderer(self, cmd: Command, timeout: float = 15.0) -> Frame | Overhead:
        conn = self.pick_renderer()
        if conn is None:
            raise LookupError("no renderer connected")
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        conn.pending[cmd.cmd_id] = fut
        try:
            await conn.ws.send_text(cmd.model_dump_json())
            return await asyncio.wait_for(fut, timeout)
        finally:
            conn.pending.pop(cmd.cmd_id, None)

    async def broadcast_scene(self) -> None:
        from contracts.protocol import Scene
        msg = Scene(cmd_id=self.new_cmd_id(), state=self.scene).model_dump_json()
        for c in list(self.renderers.values()):
            try:
                await c.ws.send_text(msg)
            except Exception:  # noqa: BLE001
                pass
        self.publish({"type": "scene", "state": self.scene.model_dump(mode="json")})

    def await_frame(self, drone_id: str, cmd_id: str) -> asyncio.Future[Frame]:
        conn = self.drones[drone_id]
        fut: asyncio.Future[Frame] = asyncio.get_running_loop().create_future()
        conn.frame_waiters[cmd_id] = fut
        return fut

    @staticmethod
    def new_cmd_id() -> str:
        return f"cmd-{uuid.uuid4().hex[:8]}"
