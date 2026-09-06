"""Fake Drone: a kinematic quadcopter that speaks the Hub controller protocol exactly like the Webots controller.

Run:  uv run python -m sim.fake_drone --id drone-1 --home -60 -60
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import io
import math
import os
from datetime import UTC, datetime

import websockets
from PIL import Image, ImageDraw

from contracts.models import DroneState, DroneStatus, VelocityNED
from contracts.protocol import (
    Ack,
    CaptureFrame,
    Frame,
    Goto,
    Hello,
    Hover,
    LookAt,
    ReturnHome,
    SetVelocity,
    Telemetry,
    hub_message,
)
from contracts.site import enu_to_latlon, latlon_to_enu
from sim.common.battery import Battery

CRUISE_MPS = 5.0
CLIMB_MPS = 2.0
YAW_DPS = 90.0
LAND_ALT = 0.05
TELEMETRY_HZ = 20
FRAME_HZ = 2


class FakeDrone:
    def __init__(self, drone_id: str, home_xy: tuple[float, float], speed_factor: float = 1.0):
        self.id = drone_id
        self.home = home_xy
        self.x, self.y, self.z = home_xy[0], home_xy[1], 0.0
        self.heading = 0.0
        self.gimbal_pitch = 8.0
        self.vel_ned = VelocityNED(vx=0, vy=0, vz=0)
        self.roll = 0.0   # degrees, right wing down positive: synthesized from acceleration like a real multirotor
        self.pitch = 0.0  # degrees, nose up positive
        self.speed_factor = speed_factor
        self.battery = Battery()
        self.status = DroneStatus.idle
        self.mission_id: str | None = None
        self.mode: str = "idle"  # idle | goto | hover | velocity | rth | landing
        self.target: tuple[float, float, float] | None = None
        self.target_speed = CRUISE_MPS
        self.manual_vel = (0.0, 0.0, 0.0)
        self.manual_yaw_rate = 0.0
        self.frame_seq = 0

    # ---- physics ------------------------------------------------------------------
    def step(self, dt: float) -> None:
        vx = vy = vz = 0.0  # ENU velocities (x east, y north, z up)
        if self.mode == "goto" and self.target is not None:
            tx, ty, tz = self.target
            dx, dy, dz = tx - self.x, ty - self.y, tz - self.z
            dist = math.hypot(dx, dy)
            if dist > 0.05:
                s = min(self.target_speed, dist / dt)
                vx, vy = dx / dist * s, dy / dist * s
                self.heading = math.degrees(math.atan2(dx, dy)) % 360  # compass heading from north
            if abs(dz) > 0.05:
                vz = math.copysign(min(CLIMB_MPS, abs(dz) / dt), dz)
            if dist <= 0.05 and abs(dz) <= 0.05:
                self.mode = "hover"
                if getattr(self, "target_yaw", None) is not None:
                    self.heading = float(self.target_yaw) % 360  # face the target on arrival, as the autopilot does
        elif self.mode == "velocity":
            n, e, d = self.manual_vel
            vx, vy, vz = e, n, -d
            self.heading = (self.heading + self.manual_yaw_rate * dt) % 360
            if self.z + vz * dt < 0:
                vz = -self.z / dt
        elif self.mode == "rth":
            hx, hy = self.home
            dx, dy = hx - self.x, hy - self.y
            dist = math.hypot(dx, dy)
            if dist > 0.1:
                s = min(CRUISE_MPS, dist / dt)
                vx, vy = dx / dist * s, dy / dist * s
                self.heading = math.degrees(math.atan2(dx, dy)) % 360
            else:
                self.mode = "landing"
        elif self.mode == "landing":
            if self.z > LAND_ALT:
                vz = -min(CLIMB_MPS / 2, self.z / dt)
            else:
                self.z = 0.0
                self.mode = "idle"
                self.status = DroneStatus.idle
                self.mission_id = None
        # Attitude: a multirotor tilts its thrust vector to accelerate, so bank follows lateral acceleration and pitch
        # follows forward acceleration plus a steady nose-down lean against drag at cruise. Smoothed like a real controller.
        if dt > 0:
            ax, ay = (vx - self.vel_ned.vy) / dt, (vy - self.vel_ned.vx) / dt  # ENU acceleration (vel_ned stores east in vy, north in vx)
            h = math.radians(self.heading)
            fwd = ax * math.sin(h) + ay * math.cos(h)
            right = ax * math.cos(h) - ay * math.sin(h)
            speed = math.hypot(vx, vy)
            pitch_t = max(-25.0, min(25.0, -math.degrees(math.atan2(fwd, 9.81)) - min(12.0, 0.9 * speed)))
            roll_t = max(-30.0, min(30.0, math.degrees(math.atan2(right, 9.81))))
            k = min(1.0, dt / 0.25)
            self.pitch += (pitch_t - self.pitch) * k
            self.roll += (roll_t - self.roll) * k
        self.x += vx * dt
        self.y += vy * dt
        self.z = max(0.0, self.z + vz * dt)
        self.vel_ned = VelocityNED(vx=vy, vy=vx, vz=-vz)
        self.battery.step(dt, math.sqrt(vx * vx + vy * vy + vz * vz), airborne=self.z > LAND_ALT)

    # ---- protocol -----------------------------------------------------------------
    def state(self) -> DroneState:
        lat, lon = enu_to_latlon(self.x, self.y)
        return DroneState(drone_id=self.id, lat=lat, lon=lon, alt=self.z, heading_deg=self.heading, velocity_ned=self.vel_ned,
                          battery_pct=self.battery.pct, status=self.status, mission_id=self.mission_id, gimbal_pitch_deg=self.gimbal_pitch,
                          roll_deg=round(self.roll, 2), pitch_deg=round(self.pitch, 2), armed=self.z > LAND_ALT, mode="FAKE", ts=datetime.now(UTC))

    def handle(self, cmd) -> Ack:
        if isinstance(cmd, Goto):
            x, y = latlon_to_enu(cmd.lat, cmd.lon)
            self.target = (x, y, cmd.alt)
            self.target_yaw = cmd.yaw_deg
            self.target_speed = cmd.speed_mps or CRUISE_MPS
            self.mode = "goto"
            if self.status in (DroneStatus.idle, DroneStatus.returning):
                self.status = DroneStatus.on_mission
            return Ack(cmd_id=cmd.cmd_id, ok=True)
        if isinstance(cmd, Hover):
            self.mode = "hover"
            return Ack(cmd_id=cmd.cmd_id, ok=True)
        if isinstance(cmd, SetVelocity):
            self.manual_vel = (cmd.velocity_ned.vx, cmd.velocity_ned.vy, cmd.velocity_ned.vz)
            self.manual_yaw_rate = cmd.yaw_rate_dps
            self.mode = "velocity"
            self.status = DroneStatus.manual_control
            return Ack(cmd_id=cmd.cmd_id, ok=True)
        if isinstance(cmd, LookAt):
            self.gimbal_pitch = max(-30.0, min(90.0, cmd.pitch_deg))
            return Ack(cmd_id=cmd.cmd_id, ok=True)
        if isinstance(cmd, ReturnHome):
            self.mode = "rth"
            self.status = DroneStatus.returning
            return Ack(cmd_id=cmd.cmd_id, ok=True)
        if isinstance(cmd, CaptureFrame):
            return Ack(cmd_id=cmd.cmd_id, ok=True)
        return Ack(cmd_id=cmd.cmd_id, ok=False, detail=f"unsupported command {cmd.type}")

    def frame(self, cmd_id: str | None = None, size: tuple[int, int] = (400, 240)) -> Frame:
        self.frame_seq += 1
        img = Image.new("RGB", size, (70, 110, 60))
        d = ImageDraw.Draw(img)
        # a synthetic ground grid that scrolls with position so motion is visible
        for gx in range(-2, 12):
            off = int((self.x * 4) % 40)
            d.line([(gx * 40 - off, 0), (gx * 40 - off, size[1])], fill=(60, 95, 50))
        for gy in range(-2, 8):
            off = int((self.y * 4) % 40)
            d.line([(0, gy * 40 - off), (size[0], gy * 40 - off)], fill=(60, 95, 50))
        lat, lon = enu_to_latlon(self.x, self.y)
        d.rectangle([0, 0, size[0], 28], fill=(0, 0, 0))
        d.text((6, 6), f"{self.id} FAKE  #{self.frame_seq}  alt {self.z:.1f}m  hdg {self.heading:.0f}  {lat:.5f},{lon:.5f}", fill=(255, 255, 255))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=70)
        return Frame(drone_id=self.id, jpeg_b64=base64.b64encode(buf.getvalue()).decode(), width=size[0], height=size[1],
                     lat=lat, lon=lon, alt=self.z, heading_deg=self.heading, gimbal_pitch_deg=self.gimbal_pitch,
                     ts=datetime.now(UTC).isoformat(), cmd_id=cmd_id)

    # ---- main loop ----------------------------------------------------------------
    async def run(self, hub_url: str, stop: asyncio.Event | None = None) -> None:
        """Connect to the Hub and reconnect forever until `stop` is set."""
        stop = stop or asyncio.Event()
        while not stop.is_set():
            try:
                await self._session(hub_url, stop)
            except (OSError, websockets.exceptions.WebSocketException) as e:
                if stop.is_set():
                    return
                print(f"[fake-drone] {self.id} hub link lost ({e}); retrying", flush=True)
                await asyncio.sleep(1.0)

    async def _session(self, hub_url: str, stop: asyncio.Event) -> None:
        async with websockets.connect(hub_url, max_size=16 * 1024 * 1024) as ws:
            await ws.send(Hello(role="drone", id=self.id, sim="fake").model_dump_json())

            async def physics_and_telemetry() -> None:
                tick = 1.0 / TELEMETRY_HZ
                frame_every = TELEMETRY_HZ // FRAME_HZ
                n = 0
                while not stop.is_set():
                    self.step(tick * self.speed_factor)
                    await ws.send(Telemetry(state=self.state()).model_dump_json())
                    n += 1
                    if n % frame_every == 0 and self.z > LAND_ALT:
                        await ws.send(self.frame().model_dump_json())
                    await asyncio.sleep(tick)

            async def commands() -> None:
                async for raw in ws:
                    cmd = hub_message.validate_json(raw)
                    ack = self.handle(cmd)
                    await ws.send(ack.model_dump_json())
                    if isinstance(cmd, CaptureFrame) and ack.ok:
                        await ws.send(self.frame(cmd_id=cmd.cmd_id).model_dump_json())

            tasks = [asyncio.create_task(physics_and_telemetry()), asyncio.create_task(commands())]
            stopper = asyncio.create_task(stop.wait())
            try:
                done, _ = await asyncio.wait([*tasks, stopper], return_when=asyncio.FIRST_COMPLETED)
                for t in done:
                    if t is not stopper:
                        t.result()
            finally:
                for t in [*tasks, stopper]:
                    t.cancel()


def main() -> None:
    ap = argparse.ArgumentParser(description="ARGUS fake Drone")
    ap.add_argument("--id", default="drone-1")
    ap.add_argument("--hub", default=os.environ.get("ARGUS_HUB_WS", "ws://127.0.0.1:8000/ws/controller"))
    ap.add_argument("--home", nargs=2, type=float, default=[-60.0, -60.0], metavar=("X_EAST", "Y_NORTH"))
    ap.add_argument("--speed-factor", type=float, default=float(os.environ.get("ARGUS_SPEED_FACTOR", "1")))
    a = ap.parse_args()
    drone = FakeDrone(a.id, (a.home[0], a.home[1]), a.speed_factor)
    print(f"[fake-drone] {a.id} home={a.home} -> {a.hub} speed_factor={a.speed_factor}", flush=True)
    asyncio.run(drone.run(a.hub))


if __name__ == "__main__":
    main()
