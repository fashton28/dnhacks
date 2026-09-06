"""Shared fixtures: an in-process Hub on a free port, fake Drones connected to it, REST and live clients."""
from __future__ import annotations

import asyncio
import json
import socket
from pathlib import Path

import httpx
import pytest
import uvicorn
import websockets

from hub.server import HubSettings, create_app
from sim.fake_drone.fake_drone import FakeDrone

FIXTURES = Path(__file__).resolve().parent.parent / "contracts" / "fixtures"
SPEED = 30.0  # fake Drones fly 30x real time in tests


def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text())


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class HubHandle:
    def __init__(self, port: int, tmp: Path, app=None):
        self.port = port
        self.tmp = tmp
        self.app = app  # for tests that exercise Hub internals directly (e.g. the autonomy executor)
        self.http = f"http://127.0.0.1:{port}"
        self.ws_controller = f"ws://127.0.0.1:{port}/ws/controller"
        self.ws_live = f"ws://127.0.0.1:{port}/ws/live"
        self.drones: dict[str, tuple[FakeDrone, asyncio.Event, asyncio.Task]] = {}

    async def add_fake_drone(self, drone_id: str, home=(-60.0, -60.0)) -> FakeDrone:
        d = FakeDrone(drone_id, home, speed_factor=SPEED)
        stop = asyncio.Event()
        task = asyncio.create_task(d.run(self.ws_controller, stop))
        self.drones[drone_id] = (d, stop, task)
        async with httpx.AsyncClient(base_url=self.http) as c:
            for _ in range(100):
                r = await c.get(f"/drones/{drone_id}")
                if r.status_code == 200:
                    return d
                await asyncio.sleep(0.05)
        raise RuntimeError("fake drone did not register")

    async def drop_drone(self, drone_id: str) -> None:
        d, stop, task = self.drones.pop(drone_id)
        stop.set()
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass

    async def wait_mission(self, mission_id: str, phases=("complete", "failed", "aborted"), timeout=30.0) -> dict:
        async with httpx.AsyncClient(base_url=self.http) as c:
            deadline = asyncio.get_running_loop().time() + timeout
            while asyncio.get_running_loop().time() < deadline:
                m = (await c.get(f"/missions/{mission_id}")).json()
                if m["phase"] in phases:
                    return m
                await asyncio.sleep(0.05)
        raise TimeoutError(f"mission {mission_id} not in {phases}")


@pytest.fixture(autouse=True)
def manual_autonomy(monkeypatch):
    """The test Hub starts in manual mode: a posted Detection flies only when the test dispatches it.
    Tests of the hands-off modes switch through POST /autonomy/mode."""
    monkeypatch.setenv("ARGUS_AUTONOMY_MODE", "manual")


@pytest.fixture
async def hub(tmp_path: Path):
    port = _free_port()
    settings = HubSettings(audit_path=tmp_path / "events.jsonl", evidence_dir=tmp_path / "evidence", runs_dir=tmp_path / "runs", speed_factor=SPEED)
    app = create_app(settings)
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", ws="websockets")
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    async with httpx.AsyncClient() as c:
        for _ in range(100):
            try:
                if (await c.get(f"http://127.0.0.1:{port}/health")).status_code == 200:
                    break
            except httpx.ConnectError:
                await asyncio.sleep(0.05)
    handle = HubHandle(port, tmp_path, app)
    try:
        yield handle
    finally:
        for drone_id in list(handle.drones):
            await handle.drop_drone(drone_id)
        server.should_exit = True
        await task


@pytest.fixture
async def live(hub: HubHandle):
    async with websockets.connect(hub.ws_live) as ws:
        snapshot = json.loads(await ws.recv())
        assert snapshot["type"] == "snapshot"
        yield ws
