"""ArduPilot Bridge: one per Drone. MAVLink on one side, the Hub controller protocol on the other.

Run:  uv run python -m sim.bridge --id drone-1 --mavlink tcp:127.0.0.1:5760 --hub ws://127.0.0.1:8000/ws/controller
"""
from __future__ import annotations

import argparse
import asyncio
import math
import os
import time
from datetime import UTC, datetime

import websockets
from pymavlink import mavutil

from contracts.models import DroneState, DroneStatus, VelocityNED
from contracts.protocol import Ack, CaptureFrame, Goto, Hello, Hover, LookAt, ReturnHome, SetVelocity, Telemetry, hub_message
from sim.common.site_limits import load_geofence_ring

TELEMETRY_HZ = 10
VEL_RESEND_HZ = 5
TAKEOFF_ALT_DEFAULT = 3.0
ARRIVE_M = 1.5

POS_MASK = 0b0000_1111_1111_1000  # use position only (ignore vel, accel, yaw, yaw_rate)
VEL_YAWRATE_MASK = 0b0000_0101_1100_0111  # use velocity + yaw_rate (ignore pos, accel, yaw)


class Bridge:
    def __init__(self, drone_id: str, mav_url: str, speedup: float = 1.0):
        self.id = drone_id
        self.mav = mavutil.mavlink_connection(mav_url, source_system=250 + int(drone_id.split("-")[-1]) % 5)
        self.speedup = speedup
        self.lat = self.lon = 0.0
        self.alt = 0.0
        self.hdg = 0.0
        self.vned = (0.0, 0.0, 0.0)
        self.battery = 100.0
        self.armed = False
        self.mode = ""
        self.gimbal = 45.0
        self.status = DroneStatus.idle
        self.intent: str = "idle"  # idle | mission | manual | rth
        self.pending_goto: tuple[float, float, float] | None = None
        self.manual_vel: tuple[float, float, float, float] | None = None
        self.takeoff_target: float | None = None
        self.last_vel_send = 0.0
        self.fence_breach = False
        self.statustext: list[str] = []
        self.gps_fix = 0
        self.ekf_flags = 0
        self.last_arm_try = 0.0
        self.last_message = ""
        self.awaiting_reposition_ack = 0.0
        self.last_mode_try = 0.0
        self.takeoff_sent_at = 0.0

    # ---- MAVLink helpers ---------------------------------------------------------------------
    def wait_heartbeat(self) -> None:
        self.mav.wait_heartbeat(timeout=60)
        print(f"[{self.id}] heartbeat from sys {self.mav.target_system} comp {self.mav.target_component}", flush=True)
        try:
            self.upload_fence(load_geofence_ring())
        except Exception as e:  # noqa: BLE001
            print(f"[{self.id}] fence upload failed: {e}", flush=True)
        for msg_id, hz in ((33, 10), (30, 10), (147, 2), (1, 2), (162, 2), (24, 2), (193, 2)):  # GLOBAL_POSITION_INT, ATTITUDE, BATTERY_STATUS, SYS_STATUS, FENCE_STATUS, GPS_RAW_INT, EKF_STATUS_REPORT
            self.mav.mav.command_long_send(self.mav.target_system, self.mav.target_component, mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL, 0, msg_id, int(1e6 / hz), 0, 0, 0, 0, 0)

    def upload_fence(self, ring: list[tuple[float, float]], timeout: float = 10.0) -> None:
        """Upload the Site geofence as an ArduPilot polygon inclusion fence (mission protocol, mission_type FENCE)."""
        n = len(ring)
        ftype = mavutil.mavlink.MAV_MISSION_TYPE_FENCE
        self.mav.mav.mission_count_send(self.mav.target_system, self.mav.target_component, n, ftype)
        deadline = time.time() + timeout
        sent = 0
        while time.time() < deadline:
            msg = self.mav.recv_match(type=["MISSION_REQUEST_INT", "MISSION_REQUEST", "MISSION_ACK"], blocking=True, timeout=1.0)
            if msg is None:
                continue
            if msg.get_type() == "MISSION_ACK":
                if msg.type == mavutil.mavlink.MAV_MISSION_ACCEPTED:
                    print(f"[{self.id}] onboard polygon fence uploaded: {n} vertices", flush=True)
                    return
                raise RuntimeError(f"fence upload rejected: MAV_MISSION result {msg.type}")
            if getattr(msg, "mission_type", ftype) != ftype:
                continue
            seq = msg.seq
            lat, lon = ring[seq]
            self.mav.mav.mission_item_int_send(self.mav.target_system, self.mav.target_component, seq, mavutil.mavlink.MAV_FRAME_GLOBAL,
                                               mavutil.mavlink.MAV_CMD_NAV_FENCE_POLYGON_VERTEX_INCLUSION, 0, 0, n, 0, 0, 0,
                                               int(lat * 1e7), int(lon * 1e7), 0, ftype)
            sent += 1
        raise TimeoutError(f"fence upload timed out after {sent} vertices")

    def set_mode(self, name: str) -> None:
        mode_id = self.mav.mode_mapping()[name]
        self.mav.mav.set_mode_send(self.mav.target_system, mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, mode_id)

    def arm(self) -> None:
        self.mav.mav.command_long_send(self.mav.target_system, self.mav.target_component, mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM, 0, 1, 0, 0, 0, 0, 0, 0)

    def takeoff(self, alt: float) -> None:
        self.mav.mav.command_long_send(self.mav.target_system, self.mav.target_component, mavutil.mavlink.MAV_CMD_NAV_TAKEOFF, 0, 0, 0, 0, 0, 0, 0, alt)

    def send_position(self, lat: float, lon: float, alt: float) -> None:
        """Reposition via MAV_CMD_DO_REPOSITION so the autopilot answers with a COMMAND_ACK (denied when outside its fence)."""
        self.mav.mav.command_int_send(self.mav.target_system, self.mav.target_component, mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
                                      mavutil.mavlink.MAV_CMD_DO_REPOSITION, 0, 0,
                                      -1, mavutil.mavlink.MAV_DO_REPOSITION_FLAGS_CHANGE_MODE, 0, float("nan"),
                                      int(lat * 1e7), int(lon * 1e7), alt)
        self.awaiting_reposition_ack = time.time()

    def send_velocity(self, vn: float, ve: float, vd: float, yaw_rate_dps: float) -> None:
        self.mav.mav.set_position_target_local_ned_send(0, self.mav.target_system, self.mav.target_component,
                                                        mavutil.mavlink.MAV_FRAME_LOCAL_NED, VEL_YAWRATE_MASK,
                                                        0, 0, 0, vn, ve, vd, 0, 0, 0, 0, math.radians(yaw_rate_dps))

    def pump(self) -> None:
        """Drain incoming MAVLink and update state."""
        while True:
            msg = self.mav.recv_match(blocking=False)
            if msg is None:
                return
            t = msg.get_type()
            if t == "GLOBAL_POSITION_INT":
                self.lat, self.lon = msg.lat / 1e7, msg.lon / 1e7
                self.alt = msg.relative_alt / 1000.0
                self.hdg = msg.hdg / 100.0 if msg.hdg != 65535 else self.hdg
                self.vned = (msg.vx / 100.0, msg.vy / 100.0, msg.vz / 100.0)
            elif t == "HEARTBEAT" and msg.get_srcComponent() == 1:
                self.armed = bool(msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
                self.mode = mavutil.mode_string_v10(msg)
            elif t == "BATTERY_STATUS":
                if msg.battery_remaining >= 0:
                    self.battery = float(msg.battery_remaining)
            elif t == "SYS_STATUS":
                if msg.battery_remaining >= 0:
                    self.battery = float(msg.battery_remaining)
            elif t == "FENCE_STATUS":
                self.fence_breach = bool(msg.breach_status)
            elif t == "COMMAND_ACK" and msg.command == mavutil.mavlink.MAV_CMD_DO_REPOSITION:
                self.awaiting_reposition_ack = 0.0
                if msg.result != mavutil.mavlink.MAV_RESULT_ACCEPTED:
                    self.last_message = f"REFUSED: autopilot rejected the destination (result {msg.result}); onboard fence or mode"
                    print(f"[{self.id}] {self.last_message}", flush=True)
                else:
                    self.last_message = "destination accepted by autopilot"
            elif t == "GPS_RAW_INT":
                self.gps_fix = msg.fix_type
            elif t == "EKF_STATUS_REPORT":
                self.ekf_flags = msg.flags
            elif t == "STATUSTEXT":
                self.statustext.append(msg.text)
                self.statustext = self.statustext[-20:]
                if not msg.text.startswith(("Arming motors", "Disarming motors")) or True:
                    self.last_message = msg.text
                print(f"[{self.id}] AP: {msg.text}", flush=True)

    # ---- intent state machine -------------------------------------------------------------------
    @property
    def position_ready(self) -> bool:
        return self.gps_fix >= 3 and bool(self.ekf_flags & 16)  # EKF_POS_HORIZ_ABS

    def step(self) -> None:
        now = time.time()
        wants_flight = self.pending_goto is not None or self.manual_vel is not None
        if self.mode in ("RTL", "LAND") and self.armed:
            self.status = DroneStatus.returning
            return
        if not self.armed:
            self.status = DroneStatus.idle
            self.takeoff_target = None
            if wants_flight and self.position_ready:
                if self.mode != "GUIDED":
                    if now - self.last_mode_try > 1.0:
                        self.last_mode_try = now
                        self.set_mode("GUIDED")
                elif now - self.last_arm_try > 3.0:
                    self.last_arm_try = now
                    self.arm()
            return
        # armed
        self.status = DroneStatus.manual_control if self.intent == "manual" else DroneStatus.on_mission if self.intent == "mission" else self.status
        if self.mode != "GUIDED" and wants_flight and now - self.last_mode_try > 1.0:
            self.last_mode_try = now
            self.set_mode("GUIDED")
            return
        if self.alt < 0.5 and wants_flight and self.takeoff_target is None:
            self.takeoff_target = self.pending_goto[2] if self.pending_goto else TAKEOFF_ALT_DEFAULT
            self.takeoff_sent_at = now
            self.takeoff(self.takeoff_target)
            return
        if self.takeoff_target is not None:
            if self.alt < min(self.takeoff_target - 1.0, 2.5):
                if now - self.takeoff_sent_at > 5.0:  # takeoff not accepted: retry
                    self.takeoff_sent_at = now
                    self.takeoff(self.takeoff_target)
                return
            self.takeoff_target = None
        if self.pending_goto is not None:
            lat, lon, alt = self.pending_goto
            self.send_position(lat, lon, alt)
            self.pending_goto = None
        if self.manual_vel is not None and now - self.last_vel_send > 1.0 / VEL_RESEND_HZ:
            self.send_velocity(*self.manual_vel)
            self.last_vel_send = now

    def handle(self, cmd) -> Ack:
        if isinstance(cmd, Goto):
            self.intent = "mission" if self.intent != "manual" else "manual"
            self.manual_vel = None
            if self.last_message.startswith("REFUSED"):
                self.last_message = ""
            self.pending_goto = (cmd.lat, cmd.lon, cmd.alt)
            return Ack(cmd_id=cmd.cmd_id, ok=True, detail="arming and taking off" if not self.armed else "")
        if isinstance(cmd, Hover):
            self.pending_goto = None
            self.manual_vel = (0.0, 0.0, 0.0, 0.0) if self.armed else None
            return Ack(cmd_id=cmd.cmd_id, ok=True)
        if isinstance(cmd, SetVelocity):
            self.intent = "manual"
            self.pending_goto = None
            self.manual_vel = (cmd.velocity_ned.vx, cmd.velocity_ned.vy, cmd.velocity_ned.vz, cmd.yaw_rate_dps)
            self.last_vel_send = 0.0
            return Ack(cmd_id=cmd.cmd_id, ok=True)
        if isinstance(cmd, LookAt):
            self.gimbal = max(-30.0, min(90.0, cmd.pitch_deg))
            return Ack(cmd_id=cmd.cmd_id, ok=True)
        if isinstance(cmd, ReturnHome):
            self.intent = "rth"
            self.pending_goto = None
            self.manual_vel = None
            if self.armed:
                self.set_mode("RTL")
            return Ack(cmd_id=cmd.cmd_id, ok=True)
        if isinstance(cmd, CaptureFrame):
            return Ack(cmd_id=cmd.cmd_id, ok=True, detail="frames come from the Renderer")
        return Ack(cmd_id=cmd.cmd_id, ok=False, detail=f"unsupported {cmd.type}")

    def state(self) -> DroneState:
        return DroneState(drone_id=self.id, lat=self.lat, lon=self.lon, alt=max(0.0, self.alt), heading_deg=self.hdg % 360.0,
                          velocity_ned=VelocityNED(vx=self.vned[0], vy=self.vned[1], vz=self.vned[2]), battery_pct=max(0.0, min(100.0, self.battery)),
                          status=self.status, mission_id=None, gimbal_pitch_deg=self.gimbal, armed=self.armed, mode=self.mode, message=self.last_message, ts=datetime.now(UTC))

    # ---- main loop -------------------------------------------------------------------------------
    async def run(self, hub_url: str) -> None:
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self.wait_heartbeat)
        while True:
            try:
                async with websockets.connect(hub_url, max_size=16 * 1024 * 1024) as ws:
                    await ws.send(Hello(role="drone", id=self.id, sim="ardupilot").model_dump_json())
                    print(f"[{self.id}] connected to hub", flush=True)

                    async def telemetry() -> None:
                        tick = 1.0 / TELEMETRY_HZ
                        while True:
                            self.pump()
                            self.step()
                            if self.lat != 0.0:
                                await ws.send(Telemetry(state=self.state()).model_dump_json())
                            await asyncio.sleep(tick / 5)  # pump often, send when due
                            for _ in range(4):
                                self.pump()
                                self.step()
                                await asyncio.sleep(tick / 5)

                    async def commands() -> None:
                        async for raw in ws:
                            cmd = hub_message.validate_json(raw)
                            await ws.send(self.handle(cmd).model_dump_json())

                    done, pending = await asyncio.wait([asyncio.create_task(telemetry()), asyncio.create_task(commands())], return_when=asyncio.FIRST_EXCEPTION)
                    for t in pending:
                        t.cancel()
                    for t in done:
                        t.result()
            except Exception as e:  # noqa: BLE001
                print(f"[{self.id}] hub link lost ({e}); retrying", flush=True)
                await asyncio.sleep(1.0)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", default="drone-1")
    ap.add_argument("--mavlink", default="tcp:127.0.0.1:5760")
    ap.add_argument("--hub", default=os.environ.get("ARGUS_HUB_WS", "ws://127.0.0.1:8000/ws/controller"))
    a = ap.parse_args()
    print(f"[bridge] {a.id} <- {a.mavlink} -> {a.hub}", flush=True)
    asyncio.run(Bridge(a.id, a.mavlink).run(a.hub))


if __name__ == "__main__":
    main()
