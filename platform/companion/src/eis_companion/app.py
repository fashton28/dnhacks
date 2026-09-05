"""
============================================================================
Drone Safety Platform -- COMPANION orchestrator + CLI entry point
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
        (+ staging-point still-image detections spliced in while a plan flies)
  (3) control loop @10-20 Hz: pick the ONE active control source and emit a
        clamped body-velocity setpoint:
          manual active            -> ManualPilot setpoint (watchdog-gated)
          plan engaged+armed+GUIDED -> PlannerExecutor output (velocity legs
                                       through the same clamp path; goto legs
                                       through Vehicle.goto_global, which
                                       clamps again; rtl -> existing rtl path)
          tracking engaged+armed+GUIDED -> Guidance setpoint
          else                     -> hold (zero, valid=False)
        then clamp + Vehicle.send_body_velocity.
  (4) command dispatch (event-driven via the API handler).

SAFETY INVARIANTS enforced here (PRD 11)
  * Exactly one controlSource is ever active (auto | tracking | manual | planner).
  * standoff is a hard limit -- delegated to Guidance, never overridden here.
  * Every setpoint is clamped to Limits before it reaches the FC.
  * Manual + ground-link watchdogs zero-and-hold on input/link loss (the
    ground-link deadman also covers planner flight).
  * emergencyStop/disarm need no confirmation and override everything.
  * Default to the safe (hold) state on startup and on ANY exception.
============================================================================
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import math
import signal
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .config import MAX_SPEED_CAP, AppConfig, load_config
from .types import (
    ControlSource,
    Limits,
    TargetObservation,
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
        self._planner_engaged: bool = False
        self._estop_latched: bool = False
        self._vehicle_state: VehicleState = VehicleState()
        self._last_manual_input_ms: float = 0.0
        self._latest_tracking: Optional[Any] = None  # TrackingResult
        # goto-leg streaming state (re-send throttle for position targets)
        self._last_goto: Optional[Tuple[float, float, float, float]] = None
        self._last_goto_ts: float = 0.0

        self._stop = asyncio.Event()
        self._tasks: List[asyncio.Task] = []

        # ---- components (built in setup()) ----------------------------------
        self.vehicle: Optional[Any] = None
        self.source: Optional[Any] = None          # vision source
        self.tracker: Optional[Any] = None
        self.guidance: Optional[Any] = None
        self.manual: Optional[Any] = None
        self.planner: Optional[Any] = None         # control.PlannerExecutor
        self.site: Optional[Any] = None            # site.Site (may be None)
        self.staging_observer: Optional[Any] = None  # vision.StagingObserver
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

        # --- site model + mission-plan executor + staging vision ----------
        # (site is I/O and lives OUTSIDE control/; its data is passed into the
        # pure-logic PlannerExecutor / StagingObserver as plain numbers.)
        self.site = self._load_site()
        self.planner = self._build_planner()
        self.staging_observer = self._build_staging_observer()

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
                # goto_global clamps to THIS envelope (the global-position
                # path's second clamp); share the live Limits object so
                # runtime edits (setMaxSpeed) apply immediately.
                limits=self.limits,
            )
        except Exception:
            log.exception("failed to construct Vehicle; FC link disabled")
            return None

    def _load_site(self) -> Optional[Any]:
        """Load the site model (docs/SITE_CONTRACT.md): perimeter geofence,
        altitude band, staging points. A missing/invalid site degrades with a
        warning -- the companion still boots (no fence upload, default alt
        band, no staging vision)."""
        try:
            from .site import load_site_from_env
        except Exception:
            log.warning("site module unavailable; no site model")
            return None
        try:
            site = load_site_from_env(self.config.planner.site_file or None)
            log.info(
                "site model loaded: %s (%d perimeter vertices, %d staging points)",
                site.source_path, len(site.perimeter), len(site.staging),
            )
            return site
        except FileNotFoundError:
            log.warning(
                "site file not found (planner.site_file / EIS_SITE_FILE / "
                "site/site.json); planner runs without site constraints"
            )
            return None
        except Exception:
            log.exception("failed to load site model; planner runs without site constraints")
            return None

    def _build_planner(self) -> Optional[Any]:
        """Build the pure-logic PlannerExecutor (mirrors _build_manual_pilot).

        Gets the live Limits by reference, the config-clamped profile speed
        map, and the site altitude band as plain numbers -- planner_exec never
        reads config/site itself."""
        try:
            from .control.planner_exec import PlannerExecutor
        except Exception:
            log.warning("control.planner_exec unavailable; mission plans disabled")
            return None
        band_min, band_max = 0.0, float("inf")
        if self.site is not None:
            band_min = float(self.site.alt_band.min_m)
            band_max = float(self.site.alt_band.max_m)
        speeds = dict(self.config.planner.profile_speed_mps)
        try:
            return PlannerExecutor(
                self.limits,
                speeds.get("standard", 0.0),  # default cap; plans resolve their own profile
                alt_band_min=band_min,
                alt_band_max=band_max,
                profile_speeds=speeds,
                arrival_radius_m=self.config.planner.arrival_radius_m,
            )
        except Exception:
            log.exception("failed to construct PlannerExecutor; mission plans disabled")
            return None

    def _build_staging_observer(self) -> Optional[Any]:
        """Staging-point vision: still-image detections on arrival at the site's
        pre-surveyed points, spliced into the normal perception stream while a
        mission plan is flying (and only then)."""
        if self.site is None or not getattr(self.site, "staging", None):
            return None
        try:
            from .vision import StagingObserver
        except Exception:
            log.warning("vision.StagingObserver unavailable; staging vision disabled")
            return None
        try:
            # site.py's StagingPoint dataclass is a DIFFERENT type from
            # vision/staging.py's same-named one and is not a Mapping, so it
            # must not be passed through raw -- convert to the plain-dict
            # lingua franca (site.json key names) the observer coerces from.
            staging = [
                {"id": s.id, "lat": s.lat, "lon": s.lon,
                 "image": s.image, "truth": s.truth}
                for s in self.site.staging
            ]
            return StagingObserver(
                staging,
                arrival_radius_m=self.config.planner.staging_arrival_radius_m,
                # staging image paths are repo-root-relative (SITE_CONTRACT)
                image_root=str(Path(__file__).resolve().parents[3]),
            )
        except Exception:
            log.exception("failed to construct StagingObserver; staging vision disabled")
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
        fc_connected = False
        if self.vehicle is not None:
            try:
                await _maybe_await(self.vehicle.connect())
                fc_connected = True
                log.info("connected to FC: %s", self.config.fc.connection)
            except Exception:
                log.exception("FC connect failed; continuing in degraded/SITL mode")

        if self.api is not None:
            await self.api.start()

        # Site perimeter -> FC polygon geofence (best-effort, after connect).
        if fc_connected:
            await self._upload_site_fence()

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

        # Staging-point vision: ONLY while a mission plan is flying. The
        # observer emits still-image detections when the vehicle arrives at a
        # site staging point; they ride the normal tracker -> 'tracking' path.
        if self._planner_engaged and self.staging_observer is not None:
            try:
                st = self._vehicle_state
                extra = self.staging_observer.observe(st.lat, st.lon, st.relAlt)
                if extra:
                    observations = list(observations) + list(extra)
            except Exception:
                log.exception("staging observer failed")

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
        elif self._planner_engaged and self._guidance_preconditions_ok():
            planner_sp = await self._planner_tick(dt)
            if planner_sp is None:
                # goto / rtl / completion handled their own emission this tick
                # (a body-velocity frame would override the position target).
                return
            sp = planner_sp
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

    async def _planner_tick(self, dt: float) -> Optional[VelocitySetpoint]:
        """One mission-plan control tick (source == planner).

        Returns a VelocitySetpoint to route through the NORMAL clamp+send path
        (orbit / hold / defensive-hold legs), or ``None`` when this tick
        emitted a different flavor itself:
          * goto legs stream an absolute position target via
            Vehicle.goto_global -- clamped in planner_exec AND again inside
            goto_global (the global path's "clamped twice", since
            _clamp_setpoint only sees body velocities);
          * an rtl tool hands off to the existing rtl path and releases;
          * plan completion pushes statusText and releases to hold.
        The ground-link deadman ran before this (planner is a link-matters
        source), so a tripped link never reaches here.
        """
        if self.planner is None:
            self._planner_engaged = False
            self._set_control_source(ControlSource.AUTO.value)
            return VelocitySetpoint.hold()
        try:
            out = self.planner.update(self._vehicle_state, dt)
        except Exception:
            log.exception("planner update failed -> hold")
            return VelocitySetpoint.hold()

        kind = getattr(out.kind, "value", str(out.kind))
        if kind == "velocity":
            return out.setpoint
        if kind == "goto" and out.goto is not None:
            await self._stream_goto(out.goto)
            return None
        if kind == "rtl":
            # Terminal tool: mirror the 'rtl' command (release, then RTL).
            self._release_all(ControlSource.AUTO.value)
            await self._status("info", "mission plan: RTL -> returning to launch")
            if self.vehicle is not None:
                try:
                    await _maybe_await(self.vehicle.set_mode("RTL"))
                except Exception:
                    log.exception("plan RTL failed")
            await self._send_hold("plan rtl")
            return None
        if kind == "done":
            self._planner_engaged = False
            self._set_control_source(ControlSource.AUTO.value)
            await self._status("info", "mission plan complete -> hold")
            await self._send_hold("plan complete")
            return None
        # idle / unexpected while engaged: release and hold (safe default).
        self._planner_engaged = False
        self._set_control_source(ControlSource.AUTO.value)
        return VelocitySetpoint.hold()

    async def _stream_goto(self, goto: Any) -> None:
        """Send/refresh the GUIDED global position target for a goto leg.

        ArduPilot latches a position target, so re-send only when the target
        changes or every ~1 s as belt-and-braces (re-sending at 20 Hz would
        spam DO_CHANGE_SPEED). While a goto is active the control tick
        deliberately does NOT emit the body-velocity hold -- a zero-velocity
        frame would override the position target."""
        if self.vehicle is None:
            return
        key = (
            round(float(goto.lat), 7), round(float(goto.lon), 7),
            round(float(goto.alt), 2), round(float(goto.speed), 2),
        )
        now = time.monotonic()
        if key == self._last_goto and (now - self._last_goto_ts) < 1.0:
            return
        self._last_goto = key
        self._last_goto_ts = now
        try:
            ok = await _maybe_await(self.vehicle.goto_global(
                goto.lat, goto.lon, goto.alt, goto.speed,
            ))
            if not ok:
                # Refused (e.g. zero-speed leg / bad target): emit the
                # canonical zero-and-hold so any PREVIOUSLY latched position
                # target in the FC cannot keep the vehicle moving.
                log.warning("goto_global refused target %s -> hold", key)
                await self._send_hold("goto refused")
        except Exception:
            log.exception("goto_global failed")
            await self._send_hold("goto failed")

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
        # Manual/tracking/planner are no longer authoritative once the
        # operator is gone -- an approved plan still requires a live link.
        self._manual_engaged = False
        self._tracking_engaged = False
        self._planner_engaged = False
        if self.planner is not None:
            _safe_call(getattr(self.planner, "reset", None))
        self._control_source = ControlSource.AUTO.value

    async def _upload_site_fence(self) -> None:
        """Upload the site perimeter as the FC polygon geofence (best-effort).

        The perimeter is the site's outer geofence (docs/SITE_CONTRACT.md).
        A failed upload degrades loudly (statusText warning) but never blocks
        startup -- the FC's own fence/failsafe params remain the backstop."""
        if self.vehicle is None:
            return
        if self.site is None or not getattr(self.site, "perimeter", None):
            await self._status("warning", "no site model; polygon geofence not uploaded")
            return
        try:
            ok = bool(await _maybe_await(
                self.vehicle.upload_geofence(self.site.perimeter)
            ))
        except Exception:
            log.exception("geofence upload raised")
            ok = False
        if ok:
            await self._status(
                "info",
                f"site geofence uploaded ({len(self.site.perimeter)} vertices)",
            )
        else:
            await self._status(
                "warning",
                "site geofence upload failed; FC fence params are the backstop",
            )

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
            # Runtime mirror of the config-time hard cap (_enforce_safety_floor):
            # the wire may LOWER the live max_speed, never raise it past the
            # 8 m/s envelope. guidance.set_max_speed itself only floors at
            # min_speed (control/ stays cap-agnostic), so clamp here -- the
            # same idiom as setStandoff's floor. NaN falls back to the cap
            # (min() would propagate it into the live Limits otherwise).
            mps = min(mps, MAX_SPEED_CAP) if math.isfinite(mps) else MAX_SPEED_CAP
            val = self.guidance.set_max_speed(mps, self.limits) if self.guidance else \
                self.limits.clamp_speed(mps)
            self._sync_safety_limits()
            return True, f"max speed set to {val:.1f} m/s (cap {MAX_SPEED_CAP:.0f} m/s)"

        # ---- manual piloting (-> ManualPilot) ------------------------------
        if command == "engageManual":
            return await self._engage_manual()
        if command == "disengageManual":
            return await self._disengage_manual()

        # ---- mission planner (-> PlannerExecutor) --------------------------
        if command == "executePlan":
            return await self._execute_plan(params)
        if command == "abortPlan":
            return await self._abort_plan()

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
        if self._planner_engaged:
            return False, "abort the active mission plan before engaging tracking"
        self._tracking_engaged = True
        self._set_control_source(ControlSource.TRACKING.value)
        if self.guidance is not None:
            self.guidance.reset()
        return True, "tracking engaged"

    def _disengage_tracking(self):
        # Guard the source release on was-engaged (same hazard as abortPlan:
        # a stray disengage must not relabel an active manual/planner source).
        was_engaged = self._tracking_engaged
        self._tracking_engaged = False
        if self.guidance is not None:
            self.guidance.reset()
        if was_engaged:
            self._set_control_source(ControlSource.AUTO.value)
        return True, "tracking disengaged -> auto hold"

    async def _engage_manual(self):
        """takeManualControl: only when armed + airborne; releases tracking;
        keeps the vehicle in GUIDED; sets controlSource=manual (PRD 6.1)."""
        st = self._vehicle_state
        if not (st.armed and st.airborne):
            msg = "manual control requires the vehicle to be armed and airborne"
            await self._status("warning", msg)
            return False, msg

        # mutual exclusion: tracking AND any mission plan release immediately
        # (the hands-on operator always wins).
        self._tracking_engaged = False
        self._planner_engaged = False
        if self.planner is not None:
            _safe_call(getattr(self.planner, "abort", None))
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
        """releaseManualControl: zero setpoints + auto-hold; controlSource=auto.
        The release (hold + source=auto) only runs when manual WAS engaged --
        a stray disengage must not stomp an active tracking/planner source
        (deadman silencing hazard; see _abort_plan)."""
        was_engaged = self._manual_engaged
        self._manual_engaged = False
        if self.manual is not None:
            _safe_call(getattr(self.manual, "reset", None))
        if was_engaged:
            await self._send_hold("release manual")
            self._set_control_source(ControlSource.AUTO.value)
        # auto-hold in GUIDED (zero-velocity); optionally LOITER if available.
        return True, "manual control released -> auto hold"

    async def _execute_plan(self, params: Dict[str, Any]):
        """executePlan: validate params.plan through PlannerExecutor.load_plan
        (the companion-side INDEPENDENT validator the trust layer requires --
        unknown tools / malformed fields reject with a failed ack) and engage
        the planner control source.

        Mutual exclusion mirrors the existing engage paths: manual (hands-on
        operator) wins and must be released first; tracking force-releases.
        The control tick gates on the same armed+airborne+GUIDED preconditions
        as tracking, so a plan accepted on the ground holds until the vehicle
        is flying in GUIDED."""
        if self.planner is None:
            return False, "mission planner unavailable"
        if self._manual_engaged:
            return False, "release manual control before executing a plan"
        plan = params.get("plan")
        if not isinstance(plan, dict):
            return False, "executePlan requires params.plan (MissionPlan)"

        # planner_exec resolves plan/leg profiles via the config-clamped
        # profile_speeds mapping it was constructed with; a rejected load
        # leaves any previously armed plan untouched.
        ok, message = self.planner.load_plan(plan)
        if not ok:
            return False, f"plan rejected: {message}"

        # Exactly one control source: tracking releases immediately.
        self._tracking_engaged = False
        if self.guidance is not None:
            self.guidance.reset()
        # Fresh mission context: re-arm the staging points.
        if self.staging_observer is not None:
            _safe_call(getattr(self.staging_observer, "reset", None))
        self._last_goto = None  # force the first goto target to stream

        # Ensure GUIDED so setpoints/position targets take effect (manual idiom).
        st = self._vehicle_state
        if (self.vehicle is not None and st.armed and st.airborne
                and str(st.mode).upper() != "GUIDED"):
            try:
                await _maybe_await(self.vehicle.set_mode("GUIDED"))
            except Exception:
                log.exception("could not switch to GUIDED for the mission plan")

        self._planner_engaged = True
        self._set_control_source(ControlSource.PLANNER.value)
        await self._status("info", f"mission plan engaged: {message}")
        return True, message

    async def _abort_plan(self):
        """abortPlan: zero-and-hold + release back to auto (disengage idiom).
        Idempotent -- aborting with no active plan still acks success, but the
        release itself (hold frame + controlSource=auto) only runs when the
        planner WAS engaged: a stray abortPlan while tracking/manual is active
        must never stomp the source label to 'auto', or the ground-link
        deadman (which only 'matters' for tracking/manual/planner) is silenced
        while guidance keeps commanding motion -- and telemetry lies."""
        was_engaged = self._planner_engaged
        self._planner_engaged = False
        if self.planner is not None:
            _safe_call(getattr(self.planner, "abort", None))
        if not was_engaged:
            return True, "no active plan (abortPlan is idempotent)"
        await self._send_hold("abortPlan")
        self._set_control_source(ControlSource.AUTO.value)
        await self._status("info", "mission plan aborted -> hold")
        return True, "plan aborted -> auto hold"

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
        self._planner_engaged = False
        if self.guidance is not None:
            self.guidance.reset()
        if self.manual is not None:
            _safe_call(getattr(self.manual, "reset", None))
        if self.planner is not None:
            # Full reset: a plan must never survive a failsafe/release.
            _safe_call(getattr(self.planner, "reset", None))
        self._set_control_source(source)

    def _sync_safety_limits(self) -> None:
        if self.safety is not None:
            try:
                self.safety.update_limits(self.limits)
            except Exception:
                pass
        if self.vehicle is not None:
            # goto_global clamps to the Vehicle-held Limits; keep it current.
            try:
                self.vehicle.update_limits(self.limits)
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
        description="Drone Safety Platform -- Jetson companion orchestrator.",
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
