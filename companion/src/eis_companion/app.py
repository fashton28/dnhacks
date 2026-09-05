"""
============================================================================
Eye in the Sky -- COMPANION orchestrator + CLI entry point
----------------------------------------------------------------------------
    python -m eis_companion.app   [--config PATH] [--sitl]

Wires the whole vehicle-side system together and runs it as a set of asyncio
tasks. This is the *glue*: it owns no control math (that lives in the pure-logic
``control`` package), no MAVLink protocol (``mavlink.Vehicle``), and no detector
(``vision``) -- it composes them and enforces the safety invariants between them.

Components built here
  * config            -> typed AppConfig (config.load_config)
  * Vehicle           -> mavlink.Vehicle (FC link; UDP in SITL, UART on HW)
  * vision source     -> Capture+PersonDetector (real cam) OR SimTargetSource
  * Tracker           -> control.Tracker  (single-target lock)
  * Guidance          -> control.Guidance (visual servoing)
  * ManualPilot       -> control.ManualPilot (manualInput -> setpoint + watchdog)
  * SafetyManager     -> mavlink.SafetyManager (deadman, arming, e-stop, fence)
  * ApiServer         -> api.ApiServer (the control WebSocket contract)
  * VideoStream       -> stream.VideoStream (RTSP/WebRTC)

asyncio tasks
  (1) telemetry pump @10 Hz : read vehicle telemetry, stamp controlSource, push.
  (2) perception+tracking   : frames -> detect -> tracker -> push 'tracking' @~10 Hz.
  (3) control loop @10-20 Hz: pick the ONE active control source and emit a
        clamped body-velocity setpoint:
          manual active            -> ManualPilot setpoint (watchdog-gated)
          tracking engaged+armed+GUIDED -> Guidance setpoint
          else                     -> hold (zero, valid=False)
        then clamp + Vehicle.send_body_velocity.
  (4) command dispatch (event-driven via the API handler).

SAFETY INVARIANTS enforced here (PRD 11)
  * Exactly one controlSource is ever active (auto | tracking | manual).
  * standoff is a hard limit -- delegated to Guidance, never overridden here.
  * Every setpoint is clamped to Limits before it reaches the FC.
  * Manual + ground-link watchdogs zero-and-hold on input/link loss.
  * emergencyStop/disarm need no confirmation and override everything.
  * Default to the safe (hold) state on startup and on ANY exception.
============================================================================
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import signal
import time
from typing import Any, Dict, List, Optional

from .config import AppConfig, load_config
from .types import (
    ControlSource,
    Limits,
    TargetObservation,
    TrackingState,
    VehicleState,
    VelocitySetpoint,
)

log = logging.getLogger("eis.app")

# Loop rates (Hz)
TELEMETRY_HZ = 10.0
TRACKING_HZ = 10.0
CONTROL_HZ = 20.0


def _now_ms() -> int:
    return int(time.time() * 1000)


def _clamp(v: float, lo: float, hi: float) -> float:
    if lo > hi:
        lo, hi = hi, lo
    return max(lo, min(hi, v))


class Companion:
    """The orchestrator. Owns the components + the shared mutable runtime state
    (active control source, tracking-engaged flag, latest setpoint) and runs the
    asyncio task graph."""

    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self.limits: Limits = config.limits

        # ---- runtime state (the single source of truth for "who is flying") --
        self._control_source: str = ControlSource.AUTO.value
        self._tracking_engaged: bool = False
        self._manual_engaged: bool = False
        self._estop_latched: bool = False
        self._vehicle_state: VehicleState = VehicleState()
        self._last_manual_input_ms: float = 0.0
        self._latest_tracking: Optional[Any] = None  # TrackingResult

        self._stop = asyncio.Event()
        self._tasks: List[asyncio.Task] = []

        # ---- components (built in setup()) ----------------------------------
        self.vehicle: Optional[Any] = None
        self.source: Optional[Any] = None          # vision source
        self.tracker: Optional[Any] = None
        self.guidance: Optional[Any] = None
        self.manual: Optional[Any] = None
        self.safety: Optional[Any] = None
        self.api: Optional[Any] = None
        self.video: Optional[Any] = None

    # ======================================================================
    # Construction / teardown
    # ======================================================================
    def setup(self) -> None:
        """Instantiate every component. Pure-logic + API + safety are built
        unconditionally; the hardware-facing Vehicle / vision / video degrade to
        no-ops if their dependencies (pymavlink, camera, mediamtx) are absent so
        the companion still boots into a safe held state."""
        cfg = self.config

        # --- pure-logic control core --------------------------------------
        from .control.tracker import Tracker
        from .control.guidance import Guidance

        self.tracker = Tracker(
            iou_threshold=cfg.tracking.iou_threshold,
            max_age=cfg.tracking.max_age,
            lost_timeout=cfg.tracking.lost_timeout,
            min_hits=cfg.tracking.min_hits,
            vfov_deg=cfg.camera.vfov_deg,
            frame_h_px=cfg.camera.height,
            person_height_m=cfg.detector.person_height_m,
        )
        self.guidance = Guidance(
            yaw_gains=cfg.gains.yaw.as_tuple(),
            vz_gains=cfg.gains.altitude.as_tuple(),
            vx_gains=cfg.gains.forward.as_tuple(),
        )
        self.manual = self._build_manual_pilot()

        # --- safety manager (pure stdlib) ---------------------------------
        from .mavlink import SafetyManager
        self.safety = SafetyManager(self.limits)

        # --- vehicle (pymavlink; degrade if missing) ----------------------
        self.vehicle = self._build_vehicle()

        # --- vision source -------------------------------------------------
        self.source = self._build_vision_source()

        # --- control WebSocket API ----------------------------------------
        from .api import ApiServer
        self.api = ApiServer(
            host=cfg.network.host,
            port=cfg.network.control_port,
            command_handler=self._handle_command,
            manual_handler=self._handle_manual_input,
            heartbeat_hook=self.safety.note_ground_heartbeat,
        )

        # --- video stream --------------------------------------------------
        self.video = self._build_video()

    def _build_manual_pilot(self) -> Optional[Any]:
        """Build the ManualPilot from the control package (documented path)."""
        try:
            from .control.manual import ManualPilot  # control-core agent's module
        except Exception:
            log.warning("control.manual.ManualPilot unavailable; manual piloting disabled")
            return None
        try:
            return ManualPilot()
        except Exception:
            log.exception("failed to construct ManualPilot; manual piloting disabled")
            return None

    def _build_vehicle(self) -> Optional[Any]:
        cfg = self.config
        try:
            from .mavlink import Vehicle  # lazily imports pymavlink
        except Exception:
            log.warning("mavlink.Vehicle unavailable (pymavlink missing?); FC link disabled")
            return None
        try:
            return Vehicle(
                connection=cfg.fc.connection,
                baud=cfg.fc.baud,
                source_system=cfg.fc.gcs_sysid,
                target_system=cfg.fc.sysid,
            )
        except Exception:
            log.exception("failed to construct Vehicle; FC link disabled")
            return None

    def _build_vision_source(self) -> Optional[Any]:
        cfg = self.config
        if cfg.camera.source in ("sim", "mock"):
            try:
                from .vision import SimTargetSource
                return SimTargetSource()
            except Exception:
                log.exception("failed to build SimTargetSource; perception disabled")
                return None
        # real camera path: Capture + PersonDetector
        try:
            from .vision import Capture, PersonDetector
            cap = Capture(
                source=cfg.camera.source,
                device=cfg.camera.device,
                width=cfg.camera.width,
                height=cfg.camera.height,
                fps=cfg.camera.fps,
            )
            det = PersonDetector(
                model_path=cfg.detector.model_path,
                engine_path=cfg.detector.engine_path,
                conf=cfg.detector.conf,
            )
            return _CameraSource(cap, det)
        except Exception:
            log.exception("failed to build camera+detector; perception disabled")
            return None

    def _build_video(self) -> Optional[Any]:
        cfg = self.config
        try:
            from .stream import VideoStream, StreamConfig
            return VideoStream(StreamConfig(
                source=cfg.camera.source,
                device=cfg.camera.device,
                file=cfg.camera.file,
                width=cfg.camera.width,
                height=cfg.camera.height,
                fps=cfg.camera.fps,
                bitrate_kbps=cfg.network.video_bitrate_kbps,
                rtsp_port=cfg.network.video_port,
                webrtc_port=cfg.network.webrtc_port,
            ))
        except Exception:
            log.exception("failed to build VideoStream; video disabled")
            return None

    # ======================================================================
    # Run / shutdown
    # ======================================================================
    async def run(self) -> None:
        """Start everything and run until stopped. Safe state on any error."""
        self.setup()

        # Connect the FC first; default to a held setpoint regardless.
        if self.vehicle is not None:
            try:
                await _maybe_await(self.vehicle.connect())
                log.info("connected to FC: %s", self.config.fc.connection)
            except Exception:
                log.exception("FC connect failed; continuing in degraded/SITL mode")

        if self.api is not None:
            await self.api.start()

        if self.video is not None:
            try:
                self.video.start()
            except Exception:
                log.exception("video stream failed to start (non-fatal)")

        # Launch the task graph.
        self._tasks = [
            asyncio.create_task(self._telemetry_loop(), name="telemetry"),
            asyncio.create_task(self._perception_loop(), name="perception"),
            asyncio.create_task(self._control_loop(), name="control"),
        ]
        log.info("companion running (sitl=%s)", self.config.sitl)
        await self._status("info", "Companion online")

        try:
            await self._stop.wait()
        finally:
            await self.shutdown()

    async def shutdown(self) -> None:
        """Stop all tasks, zero the setpoint, hold, and tear down components."""
        log.info("companion shutting down -> safe state")
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        self._tasks = []

        # Default to the safe state: zero setpoint + hold.
        await self._send_hold("shutdown")

        if self.video is not None:
            try:
                self.video.stop()
            except Exception:
                pass
        if self.api is not None:
            try:
                await self.api.stop()
            except Exception:
                pass
        if self.vehicle is not None:
            try:
                await _maybe_await(self.vehicle.close())
            except Exception:
                pass

    def request_stop(self) -> None:
        self._stop.set()

    # ======================================================================
    # Task 1: telemetry pump @ 10 Hz
    # ======================================================================
    async def _telemetry_loop(self) -> None:
        period = 1.0 / TELEMETRY_HZ
        while not self._stop.is_set():
            t0 = time.monotonic()
            try:
                await self._telemetry_tick()
            except Exception:
                log.exception("telemetry tick failed")
            await self._sleep_remaining(t0, period)

    async def _telemetry_tick(self) -> None:
        telem: Optional[Dict[str, Any]] = None
        if self.vehicle is not None:
            try:
                self._vehicle_state = await _maybe_await(self.vehicle.get_state())
            except Exception:
                pass
            try:
                telem = await _maybe_await(self.vehicle.get_telemetry())
            except Exception:
                telem = None

        if telem is None:
            telem = _telemetry_from_state(self._vehicle_state)

        # Stamp the authoritative active control source (single source of truth).
        telem["controlSource"] = self._control_source
        telem.setdefault("type", "telemetry")
        telem.setdefault("ts", _now_ms())
        if self.api is not None:
            await self.api.push_telemetry(telem)

    # ======================================================================
    # Task 2: perception + tracking @ ~10 Hz
    # ======================================================================
    async def _perception_loop(self) -> None:
        period = 1.0 / TRACKING_HZ
        while not self._stop.is_set():
            t0 = time.monotonic()
            try:
                await self._perception_tick()
            except Exception:
                log.exception("perception tick failed")
            await self._sleep_remaining(t0, period)

    async def _perception_tick(self) -> None:
        observations: List[TargetObservation] = []
        if self.source is not None:
            try:
                observations = await _maybe_await(self.source.observe())
            except Exception:
                observations = []

        if self.tracker is None:
            return
        result = self.tracker.update(observations, ts=time.time())
        self._latest_tracking = result

        # Build + push the contract tracking message.
        if self.api is not None:
            await self.api.push_tracking(self._tracking_message(result))

    def _tracking_message(self, result: Any) -> Dict[str, Any]:
        targets = [
            {
                "id": int(t.id),
                "bbox": [float(t.bbox[0]), float(t.bbox[1]),
                         float(t.bbox[2]), float(t.bbox[3])],
                "confidence": float(t.confidence),
                "isLocked": bool(t.is_locked),
            }
            for t in result.targets
        ]
        state = result.state.value if hasattr(result.state, "value") else str(result.state)
        return {
            "type": "tracking",
            "ts": _now_ms(),
            "state": state,
            "targets": targets,
            "lockedTargetId": result.locked_target_id,
            "standoffDistance": float(self.limits.standoff),
            "estimatedDistance": (
                None if result.estimated_distance is None
                else float(result.estimated_distance)
            ),
            "maxSpeed": float(self.limits.max_speed),
        }

    # ======================================================================
    # Task 3: control loop @ 10-20 Hz -- the ONE active control source wins
    # ======================================================================
    async def _control_loop(self) -> None:
        period = 1.0 / CONTROL_HZ
        last = time.monotonic()
        while not self._stop.is_set():
            t0 = time.monotonic()
            dt = max(0.0, t0 - last)
            last = t0
            try:
                await self._control_tick(dt)
            except Exception:
                # SAFE DEFAULT: any control-tick error -> hold.
                log.exception("control tick failed -> hold")
                await self._send_hold("control error")
            await self._sleep_remaining(t0, period)

    async def _control_tick(self, dt: float) -> None:
        # E-stop latch: while latched, never command motion.
        if self._estop_latched:
            await self._send_hold("emergency stop latched")
            return

        # --- ground-link deadman --------------------------------------------
        if self.safety is not None:
            link = self.safety.evaluate_link(
                self._control_source,
                airborne=self._vehicle_state.airborne,
            )
            if link.tripped:
                await self._on_deadman(link)
                return

        sp = VelocitySetpoint.hold()

        if self._manual_engaged:
            sp = await self._manual_setpoint(dt)
        elif self._tracking_engaged and self._guidance_preconditions_ok():
            sp = self._guidance_setpoint(dt)
        else:
            sp = VelocitySetpoint.hold()

        sp = self._clamp_setpoint(sp)
        await self._send_setpoint(sp)

    def _guidance_preconditions_ok(self) -> bool:
        """Guidance only runs armed + airborne + GUIDED (PRD 6.1)."""
        st = self._vehicle_state
        return bool(st.armed and st.airborne and str(st.mode).upper() == "GUIDED")

    def _guidance_setpoint(self, dt: float) -> VelocitySetpoint:
        if self.guidance is None or self._latest_tracking is None:
            return VelocitySetpoint.hold()
        res = self._latest_tracking
        return self.guidance.update(
            res.state,
            res.locked_bbox,
            res.estimated_distance,
            self.limits,
            dt,
        )

    async def _manual_setpoint(self, dt: float) -> VelocitySetpoint:
        """Manual setpoint via ManualPilot, gated by the input watchdog.

        If no manualInput frame has arrived within ``manual_watchdog_ms``, zero
        the setpoint and hold -- never continue the last commanded velocity.
        """
        watchdog_ms = float(self.limits.manual_watchdog_ms)
        age = _now_ms() - self._last_manual_input_ms if self._last_manual_input_ms else float("inf")
        if age > watchdog_ms:
            # Watchdog: zero + hold. Reset the pilot so smoothing doesn't coast.
            if self.manual is not None:
                _safe_call(getattr(self.manual, "reset", None))
            return VelocitySetpoint.hold()

        if self.manual is None:
            return VelocitySetpoint.hold()
        try:
            return self.manual.update(self.limits, dt)
        except Exception:
            log.exception("manual pilot update failed -> hold")
            return VelocitySetpoint.hold()

    def _clamp_setpoint(self, sp: VelocitySetpoint) -> VelocitySetpoint:
        """Final hard clamp of every axis to Limits (belt-and-braces).

        Guidance / ManualPilot already clamp, but the orchestrator re-asserts the
        envelope so no component can ever push the FC past it."""
        if not sp.valid:
            return VelocitySetpoint.hold()
        L = self.limits
        return VelocitySetpoint(
            vx=_clamp(sp.vx, -L.max_speed, L.max_speed),
            vy=_clamp(sp.vy, -L.max_speed, L.max_speed),
            vz=_clamp(sp.vz, -L.max_climb_rate, L.max_climb_rate),
            yaw_rate=_clamp(sp.yaw_rate, -L.max_yaw_rate, L.max_yaw_rate),
            valid=True,
        )

    async def _send_setpoint(self, sp: VelocitySetpoint) -> None:
        if self.vehicle is None:
            return
        try:
            await _maybe_await(self.vehicle.send_body_velocity(
                sp.vx, sp.vy, sp.vz, sp.yaw_rate, valid=sp.valid,
            ))
        except TypeError:
            # Vehicle.send_body_velocity may not take a 'valid' kwarg; retry.
            try:
                await _maybe_await(self.vehicle.send_body_velocity(
                    sp.vx, sp.vy, sp.vz, sp.yaw_rate,
                ))
            except Exception:
                log.exception("send_body_velocity failed")
        except Exception:
            log.exception("send_body_velocity failed")

    async def _send_hold(self, reason: str = "") -> None:
        """Emit the canonical safe setpoint: all-zero, valid=False (hold)."""
        await self._send_setpoint(VelocitySetpoint.hold())

    async def _on_deadman(self, link: Any) -> None:
        """Ground-link deadman tripped: stop guidance, hold, escalate."""
        await self._send_hold("deadman")
        action = getattr(link.action, "value", str(link.action))
        await self._status("critical", link.reason or "ground link lost -> hold/RTL")
        if action == "rtl" and self.vehicle is not None:
            try:
                await _maybe_await(self.vehicle.set_mode("RTL"))
            except Exception:
                log.exception("deadman RTL failed")
        # Manual/tracking are no longer authoritative once the operator is gone.
        self._manual_engaged = False
        self._tracking_engaged = False
        self._control_source = ControlSource.AUTO.value

    # ======================================================================
    # Task 4: command dispatch (event-driven via the API handler)
    # ======================================================================
    async def _handle_command(self, msg: Dict[str, Any]) -> Dict[str, Any]:
        """Route one inbound command to its action and return a CommandAck dict.

        Runs inside the API server's receive loop. Never raises (the API server
        also guards, but we keep our own try so the ack message is meaningful)."""
        command = str(msg.get("command", ""))
        params = msg.get("params") or {}
        try:
            ok, message = await self._dispatch(command, params)
        except Exception as exc:
            log.exception("command %r failed", command)
            ok, message = False, f"{command} failed: {exc}"
        return {
            "type": "ack",
            "ts": _now_ms(),
            "command": command,
            "success": bool(ok),
            "message": message,
        }

    async def _dispatch(self, command: str, params: Dict[str, Any]):
        v = self.vehicle

        # ---- emergencyStop: overrides EVERYTHING, no confirmation ----------
        if command == "emergencyStop":
            return await self._emergency_stop()

        # ---- flight commands (-> Vehicle) ----------------------------------
        if command == "arm":
            return await self._do_arm()
        if command == "disarm":
            self._release_all(ControlSource.AUTO.value)
            await self._send_hold("disarm")
            return await self._vehicle_action("disarm", lambda: v.disarm())
        if command == "takeoff":
            alt = float(params.get("altitude", 2.0))
            alt = min(alt, self.limits.max_altitude)
            return await self._vehicle_action("takeoff", lambda: v.takeoff(alt))
        if command == "land":
            self._release_all(ControlSource.AUTO.value)
            return await self._vehicle_action("land", lambda: v.land())
        if command == "rtl":
            self._release_all(ControlSource.AUTO.value)
            return await self._vehicle_action("rtl", lambda: v.set_mode("RTL"))
        if command == "setMode":
            mode = str(params.get("mode", "")).upper()
            if not mode:
                return False, "setMode requires params.mode"
            return await self._vehicle_action("setMode", lambda: v.set_mode(mode))

        # ---- tracking / guidance (-> Guidance / Tracker) -------------------
        if command == "engageTracking":
            return self._engage_tracking()
        if command == "disengageTracking":
            return self._disengage_tracking()
        if command == "selectTarget":
            tid = params.get("targetId")
            if self.tracker is not None:
                self.tracker.select(None if tid is None else int(tid))
            return True, f"target {tid} selected"
        if command == "setStandoff":
            meters = float(params.get("meters", self.limits.standoff))
            val = self.guidance.set_standoff(meters, self.limits) if self.guidance else \
                self.limits.clamp_standoff(meters)
            self._sync_safety_limits()
            return True, f"standoff set to {val:.1f} m (floor {self.limits.min_standoff:.0f} m)"
        if command == "setMaxSpeed":
            mps = float(params.get("mps", self.limits.max_speed))
            val = self.guidance.set_max_speed(mps, self.limits) if self.guidance else \
                self.limits.clamp_speed(mps)
            self._sync_safety_limits()
            return True, f"max speed set to {val:.1f} m/s"

        # ---- manual piloting (-> ManualPilot) ------------------------------
        if command == "engageManual":
            return await self._engage_manual()
        if command == "disengageManual":
            return await self._disengage_manual()

        return False, f"unknown command {command!r}"

    # ---- command helpers -------------------------------------------------
    async def _do_arm(self):
        """Arm with a conservative precondition check (PRD 11)."""
        if self.safety is not None:
            check = self.safety.check_arming(
                self._vehicle_state,
                min_battery_remaining=self.config.safety.min_battery_remaining,
                require_gps=not self.config.sitl,  # SITL bring-up may lack a fix
            )
            if not check.ok:
                await self._status("warning", check.message)
                return False, check.message
        return await self._vehicle_action("arm", lambda: self.vehicle.arm())

    def _engage_tracking(self):
        if self._manual_engaged:
            return False, "release manual control before engaging tracking"
        self._tracking_engaged = True
        self._set_control_source(ControlSource.TRACKING.value)
        if self.guidance is not None:
            self.guidance.reset()
        return True, "tracking engaged"

    def _disengage_tracking(self):
        self._tracking_engaged = False
        self._set_control_source(ControlSource.AUTO.value)
        if self.guidance is not None:
            self.guidance.reset()
        return True, "tracking disengaged -> auto hold"

    async def _engage_manual(self):
        """takeManualControl: only when armed + airborne; releases tracking;
        keeps the vehicle in GUIDED; sets controlSource=manual (PRD 6.1)."""
        st = self._vehicle_state
        if not (st.armed and st.airborne):
            msg = "manual control requires the vehicle to be armed and airborne"
            await self._status("warning", msg)
            return False, msg

        # mutual exclusion: tracking releases immediately.
        self._tracking_engaged = False
        if self.guidance is not None:
            self.guidance.reset()
        if self.manual is not None:
            _safe_call(getattr(self.manual, "reset", None))

        # ensure GUIDED so velocity setpoints take effect.
        if self.vehicle is not None and str(st.mode).upper() != "GUIDED":
            try:
                await _maybe_await(self.vehicle.set_mode("GUIDED"))
            except Exception:
                log.exception("could not switch to GUIDED for manual control")

        self._manual_engaged = True
        # seed the watchdog so the first ticks don't instantly time out.
        self._last_manual_input_ms = _now_ms()
        self._set_control_source(ControlSource.MANUAL.value)
        return True, "manual control engaged (GUIDED)"

    async def _disengage_manual(self):
        """releaseManualControl: zero setpoints + auto-hold; controlSource=auto."""
        self._manual_engaged = False
        if self.manual is not None:
            _safe_call(getattr(self.manual, "reset", None))
        await self._send_hold("release manual")
        self._set_control_source(ControlSource.AUTO.value)
        # auto-hold in GUIDED (zero-velocity); optionally LOITER if available.
        return True, "manual control released -> auto hold"

    async def _emergency_stop(self):
        """emergencyStop: release everything, zero setpoints, LAND/BRAKE.
        No confirmation; overrides all (PRD 11)."""
        self._estop_latched = True
        self._release_all(ControlSource.AUTO.value)
        await self._send_hold("emergencyStop")

        plan = None
        if self.safety is not None:
            plan = self.safety.emergency_stop_plan(self._vehicle_state)
        action = getattr(getattr(plan, "action", None), "value", "land")

        await self._status("critical", "EMERGENCY STOP")
        if self.vehicle is not None:
            try:
                if action == "disarm" or getattr(plan, "force_disarm", False):
                    await _maybe_await(self.vehicle.disarm(force=True))
                elif action == "land":
                    await _maybe_await(self.vehicle.land())
                else:
                    await _maybe_await(self.vehicle.set_mode("BRAKE"))
            except Exception:
                log.exception("emergencyStop vehicle action failed")
        # Clear the latch so the operator can re-take control after the stop has
        # been commanded (the stop itself has already been sent to the FC).
        self._estop_latched = False
        return True, f"emergency stop -> {action}"

    async def _vehicle_action(self, name: str, fn):
        if self.vehicle is None:
            return False, f"{name}: no FC link"
        try:
            await _maybe_await(fn())
            return True, f"{name} ok"
        except Exception as exc:
            log.exception("%s failed", name)
            return False, f"{name} failed: {exc}"

    # ---- manualInput (high-rate, FIRE-AND-FORGET, NEVER acked) -----------
    def _handle_manual_input(self, msg: Dict[str, Any]) -> None:
        """Consume one high-rate manualInput frame. No ack, no await blocking.

        We always record the arrival time (feeds the watchdog) but only forward
        the sticks to the pilot when manual control is actually engaged -- a
        stray frame can never command motion in auto/tracking."""
        self._last_manual_input_ms = _now_ms()
        if not self._manual_engaged or self.manual is None:
            return
        try:
            self.manual.set_input(
                throttle=float(msg.get("throttle", 0.0)),
                yaw=float(msg.get("yaw", 0.0)),
                pitch=float(msg.get("pitch", 0.0)),
                roll=float(msg.get("roll", 0.0)),
            )
        except Exception:
            log.exception("manual set_input failed")

    # ======================================================================
    # State helpers (single active control source)
    # ======================================================================
    def _set_control_source(self, source: str) -> None:
        self._control_source = source
        self._vehicle_state.control_source = source

    def _release_all(self, source: str) -> None:
        self._tracking_engaged = False
        self._manual_engaged = False
        if self.guidance is not None:
            self.guidance.reset()
        if self.manual is not None:
            _safe_call(getattr(self.manual, "reset", None))
        self._set_control_source(source)

    def _sync_safety_limits(self) -> None:
        if self.safety is not None:
            try:
                self.safety.update_limits(self.limits)
            except Exception:
                pass

    async def _status(self, severity: str, text: str) -> None:
        if self.api is not None:
            try:
                await self.api.push_status(severity, text)
            except Exception:
                pass

    # ======================================================================
    # timing
    # ======================================================================
    async def _sleep_remaining(self, t0: float, period: float) -> None:
        elapsed = time.monotonic() - t0
        await asyncio.sleep(max(0.0, period - elapsed))


# ==========================================================================
# Adapters / helpers
# ==========================================================================
class _CameraSource:
    """Adapts Capture + PersonDetector to the ``observe() -> [TargetObservation]``
    interface the perception loop expects."""

    def __init__(self, capture: Any, detector: Any) -> None:
        self._cap = capture
        self._det = detector

    async def observe(self) -> List[TargetObservation]:
        result = await _maybe_await(self._cap.read())
        # Capture.read() returns (ok, frame); tolerate a bare-frame impl too.
        if isinstance(result, tuple):
            ok, frame = result
        else:
            ok, frame = (result is not None), result
        if not ok or frame is None:
            return []
        dets = await _maybe_await(self._det.detect(frame))
        return list(dets) if dets else []


async def _maybe_await(value: Any) -> Any:
    """Await ``value`` if it is awaitable, else return it. Lets the orchestrator
    call sync OR async component methods uniformly."""
    if asyncio.iscoroutine(value) or isinstance(value, asyncio.Future):
        return await value
    return value


def _safe_call(fn) -> None:
    if callable(fn):
        try:
            fn()
        except Exception:
            pass


def _telemetry_from_state(st: VehicleState) -> Dict[str, Any]:
    """Build a minimal contract telemetry dict from a VehicleState.

    Used when the Vehicle layer doesn't supply a full telemetry dict (e.g. in a
    degraded/no-FC dev run) so the UI still receives well-formed frames."""
    return {
        "type": "telemetry",
        "ts": _now_ms(),
        "armed": bool(st.armed),
        "mode": str(st.mode),
        "controlSource": str(st.control_source),
        "attitude": {"roll": float(st.roll), "pitch": float(st.pitch), "yaw": float(st.heading)},
        "position": {"lat": float(st.lat), "lon": float(st.lon),
                     "relAlt": float(st.relAlt), "absAlt": float(st.relAlt)},
        "velocity": {"groundspeed": float(st.groundspeed), "verticalSpeed": float(st.vspeed)},
        "heading": float(st.heading),
        "battery": {"voltage": 0.0, "current": 0.0, "remaining": 0.0},
        "gps": {"fixType": 0, "satellites": 0, "hdop": 99.0},
        "home": {"lat": float(st.lat), "lon": float(st.lon), "distance": 0.0},
        "link": {"rssi": 0.0, "latencyMs": 0.0},
    }


# ==========================================================================
# CLI entry point
# ==========================================================================
def _parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="python -m eis_companion.app",
        description="Eye in the Sky -- Jetson companion orchestrator.",
    )
    p.add_argument("--config", default=None, help="path to a config YAML (else EIS_CONFIG / default.yaml)")
    p.add_argument("--sitl", action="store_true", help="force SITL mode (overrides config)")
    p.add_argument("--log-level", default="INFO", help="logging level (DEBUG/INFO/WARNING/...)")
    return p.parse_args(argv)


async def _amain(argv: Optional[List[str]] = None) -> None:
    args = _parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    config = load_config(args.config)
    if args.sitl:
        config.sitl = True

    companion = Companion(config)

    # graceful shutdown on SIGINT/SIGTERM where supported.
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, companion.request_stop)
        except (NotImplementedError, ValueError):
            pass  # Windows / non-main-thread: rely on KeyboardInterrupt below

    await companion.run()


def main(argv: Optional[List[str]] = None) -> None:
    """Console entry point (also ``python -m eis_companion.app``)."""
    try:
        asyncio.run(_amain(argv))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
