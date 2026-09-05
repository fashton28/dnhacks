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
import os
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


def _great_circle_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Return surface distance in metres, or infinity for malformed positions."""
    values = (lat1, lon1, lat2, lon2)
    if not all(math.isfinite(float(value)) for value in values):
        return math.inf
    if not (-90.0 <= lat1 <= 90.0 and -90.0 <= lat2 <= 90.0):
        return math.inf
    if not (-180.0 <= lon1 <= 180.0 and -180.0 <= lon2 <= 180.0):
        return math.inf
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = phi2 - phi1
    dlambda = math.radians(lon2 - lon1)
    hav = math.sin(dphi / 2.0) ** 2 + (
        math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2.0) ** 2
    )
    return 2.0 * 6_371_000.0 * math.asin(math.sqrt(min(1.0, max(0.0, hav))))


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
        self._site_valid: bool = False
        self._last_planner_heartbeat_ms: float = 0.0
        self._last_fc_heartbeat_sent_s: float = 0.0
        self._last_rf_interference_ms: float = 0.0
        self._failsafe_decision: Any = None
        self._battery_snapshot: Any = None
        self._nav_snapshot: Any = None
        self._last_readiness_signature: Optional[Tuple[Any, ...]] = None
        self._last_readiness_push_ms: float = 0.0
        self._wind_above_since_ms: float = 0.0
        self._route_through_clutter: bool = False
        self._night_mission: bool = False
        self._lidar_clear_reached: bool = False
        self._was_armed: bool = False
        self._charge_started_ms: float = 0.0
        self._charge_curve: Any = None
        self._faults: Dict[str, Any] = {
            "gps_loss": False,
            "rf_interference": False,
            "hostile_drone": False,
            "link_loss": False,
            "planner_heartbeat": False,
            "camera": False,
            "thermal": False,
            "lidar": False,
            "battery_fault": False,
            "sortie_expiry": False,
            "charge": False,
            "wind": False,
        }
        self._fault_values: Dict[str, float] = {}
        self._last_applied_failsafe: str = "none"
        self._last_battery_event: str = ""
        self._fc_ready: bool = False
        self._last_sim_truth: Optional[Tuple[float, float, float, float]] = None
        self._planner_tracking_tool: str = ""
        self._planner_resume_context: Optional[Dict[str, Any]] = None
        self._takeoff_target_alt: float = 0.0
        self._takeoff_deadline_ms: float = 0.0
        self._camera_observation_valid: Optional[bool] = None
        self._thermal_observation_valid: Optional[bool] = None
        self._lidar_observation_valid: Optional[bool] = None

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
        self.sensor_suite: Optional[Any] = None
        self.battery_health: Optional[Any] = None
        self.nav_health: Optional[Any] = None
        self.failsafe: Optional[Any] = None
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
        self.sensor_suite = self._build_sensor_suite()

        from .control.battery_health import BatteryHealth, BatteryPolicy
        from .control.failsafe import FailsafeMachine
        from .control.nav_health import NavHealth

        bat = cfg.battery
        self.battery_health = BatteryHealth(BatteryPolicy(
            nominal_endurance_s=bat.nominal_endurance_s,
            reserve_pct=bat.reserve_pct,
            max_sortie_s=bat.max_sortie_s,
            dispatch_min_soc_pct=bat.dispatch_min_soc_pct,
            cell_imbalance_max_v=bat.cell_imbalance_max_v,
            batt_temp_max_c=bat.batt_temp_max_c,
            capacity_mah=bat.capacity_mah,
            cell_count=bat.cell_count,
            require_cell_telemetry=not cfg.sitl,
            require_temperature_telemetry=not cfg.sitl,
        ))
        self.nav_health = NavHealth()
        self.failsafe = FailsafeMachine()

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
            plan_command_handler=self._handle_plan_command,
            plan_heartbeat_handler=self._handle_plan_heartbeat,
            rf_event_handler=self._handle_rf_event,
            connect_messages=self._connect_messages,
            vehicle_id=cfg.vehicle_id,
            audit_path=str(Path(__file__).resolve().parents[3] / "logs" / "companion-audit.jsonl"),
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
            self._site_valid = True
            log.info(
                "site model loaded: %s (%d perimeter vertices, %d staging points)",
                site.source_path, len(site.perimeter), len(site.staging),
            )
            return site
        except FileNotFoundError:
            self._site_valid = False
            log.warning(
                "site file not found (planner.site_file / EIS_SITE_FILE / "
                "site/site.json); planner runs without site constraints"
            )
            return None
        except Exception:
            self._site_valid = False
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
                 "image": s.image, "thermal_image": s.thermal_image,
                 "image_kind": s.image_kind,
                 "required_sensors": list(s.required_sensors), "truth": s.truth}
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

    def _build_sensor_suite(self) -> Optional[Any]:
        if self.site is None or not getattr(self.site, "staging", None):
            return None
        try:
            from .vision.multimodal import StagedSensorSuite
            staging = [
                {
                    "id": point.id,
                    "lat": point.lat,
                    "lon": point.lon,
                    "image": point.image,
                    "thermal_image": point.thermal_image,
                    "image_kind": point.image_kind,
                    "required_sensors": list(point.required_sensors),
                    "truth": point.truth,
                }
                for point in self.site.staging
            ]
            suite = StagedSensorSuite(
                staging,
                home=(self.site.home.lat, self.site.home.lon),
                perimeter=self.site.perimeter,
                arrival_radius_m=self.config.planner.staging_arrival_radius_m,
                image_root=str(Path(__file__).resolve().parents[3]),
            )
            health = suite.initial_health()
            self._camera_observation_valid = health["rgb"]
            self._thermal_observation_valid = health["thermal"]
            self._lidar_observation_valid = health["lidar"]
            return suite
        except Exception:
            log.exception("failed to construct staged sensor suite")
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
            heartbeat_now = time.monotonic()
            if (
                hasattr(self.vehicle, "send_heartbeat")
                and heartbeat_now - self._last_fc_heartbeat_sent_s >= 1.0
            ):
                try:
                    await _maybe_await(self.vehicle.send_heartbeat())
                    self._last_fc_heartbeat_sent_s = heartbeat_now
                except Exception:
                    log.exception("companion MAVLink heartbeat failed")
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

        home_distance_m = math.inf
        if self.site is not None:
            home_distance_m = _great_circle_distance_m(
                self._vehicle_state.lat,
                self._vehicle_state.lon,
                self.site.home.lat,
                self.site.home.lon,
            )
            home = telem.setdefault("home", {})
            home["lat"] = self.site.home.lat
            home["lon"] = self.site.home.lon
            if math.isfinite(home_distance_m):
                home["distance"] = home_distance_m

        await self._health_tick(telem, home_distance_m=home_distance_m)

        # Stamp the authoritative active control source (single source of truth).
        telem["controlSource"] = self._control_source
        telem.setdefault("type", "telemetry")
        telem.setdefault("ts", _now_ms())
        telem["vehicleId"] = self.config.vehicle_id
        nav = self._nav_snapshot
        telem["navSource"] = getattr(nav, "source", "gps")
        gps = telem.get("gps") or {}
        telem["gpsHealth"] = {
            "fix": int(gps.get("fixType", 0)),
            "sats": int(gps.get("satellites", 0)),
            "hdop": float(gps.get("hdop", 99.0)),
        }
        decision = self._failsafe_decision
        telem["failsafeState"] = getattr(decision, "state", "none")
        telem["failsafeReason"] = getattr(decision, "reason", "")
        if self._battery_snapshot is not None:
            bat = self._battery_snapshot
            telem["battery"] = {
                "soc_pct": bat.soc_pct,
                "voltage_v": bat.voltage_v,
                "current_a": bat.current_a,
                "cell_delta_v": bat.cell_delta_v,
                "temp_c": bat.temp_c,
                "remaining_s": bat.remaining_s,
                "charge_state": bat.charge_state,
                "voltage": bat.voltage_v,
                "current": bat.current_a,
                "remaining": bat.soc_pct,
                **({"fault": bat.fault} if bat.fault else {}),
            }
            telem["sortie"] = (
                {
                    "elapsed_s": bat.elapsed_sortie_s,
                    "cap_s": bat.cap_s,
                    "must_rtl_by_s": bat.must_rtl_by_s,
                }
                if self._vehicle_state.armed else None
            )
        if self.api is not None:
            await self.api.push_telemetry(telem)

    async def _health_tick(
        self, telem: Dict[str, Any], *, home_distance_m: Optional[float] = None
    ) -> None:
        """Feed plain MAVLink inputs through the pure battery/nav/failsafe logic."""
        from .control.battery_health import (
            BatterySample, ScriptedChargeCurve, estimate_return_time_s,
        )
        from .control.failsafe import FailsafeSignals
        from .control.nav_health import NavSample

        now_s = time.monotonic()
        raw: Dict[str, Any] = {}
        if self.vehicle is not None and hasattr(self.vehicle, "health_inputs"):
            try:
                raw = await _maybe_await(self.vehicle.health_inputs()) or {}
            except Exception:
                log.exception("MAVLink health input translation failed")

        raw_battery = dict(raw.get("battery") or {})
        self._fc_ready = bool(raw.get("fc_ready", False))
        legacy_battery = telem.get("battery") or {}
        reported_soc = raw_battery.get("reported_soc_pct")
        if reported_soc is None:
            reported_soc = legacy_battery.get("remaining")
        voltage = float(raw_battery.get("voltage_v", legacy_battery.get("voltage", 0.0)))
        current = float(raw_battery.get("current_a", legacy_battery.get("current", 0.0)))

        armed = bool(self._vehicle_state.armed)
        airborne = bool(self._vehicle_state.airborne)
        if self._was_armed and not armed and self.config.sitl:
            self._charge_started_ms = _now_ms()
            self._charge_curve = ScriptedChargeCurve(
                getattr(self._battery_snapshot, "soc_pct", reported_soc or 0.0),
                self.config.battery.demo_charge_scale_s,
            )
        self._was_armed = armed
        charging = bool(self._faults["charge"] or self._charge_curve is not None)
        if charging and not armed:
            if self._charge_curve is None:
                self._charge_started_ms = _now_ms()
                self._charge_curve = ScriptedChargeCurve(
                    getattr(self._battery_snapshot, "soc_pct", reported_soc or 0.0),
                    self.config.battery.demo_charge_scale_s,
                )
            elapsed = max(0.0, (_now_ms() - self._charge_started_ms) / 1000.0)
            reported_soc, current = self._charge_curve.sample(elapsed)
            voltage = self.config.battery.cell_count * (3.3 + 0.9 * float(reported_soc) / 100.0)

        if self.battery_health is not None:
            self._battery_snapshot = self.battery_health.update(BatterySample(
                voltage_v=voltage,
                current_a=current,
                temp_c=float(raw_battery.get("temp_c", math.nan)),
                reported_soc_pct=(None if reported_soc is None else float(reported_soc)),
                cell_voltages_v=tuple(raw_battery.get("cell_voltages_v") or ()),
                armed=armed,
                airborne=airborne,
                landed=not airborne,
                external_power=charging,
                charge_requested=charging,
                pack_fault="injected pack fault" if self._faults["battery_fault"] else "",
                timestamp_s=now_s,
            ), estimated_return_s=estimate_return_time_s(
                (
                    float(home_distance_m)
                    if home_distance_m is not None
                    else float((telem.get("home") or {}).get("distance", math.inf))
                ),
                self._vehicle_state.relAlt,
                cruise_speed_mps=max(0.5, self.limits.max_speed * 0.75),
                descent_rate_mps=max(0.25, self.limits.max_climb_rate),
            ))

        raw_nav = dict(raw.get("nav") or {})
        if (
            self.config.sitl and self.vehicle is not None
            and self.site is not None and hasattr(self.vehicle, "sim_truth_inputs")
        ):
            truth = await _maybe_await(self.vehicle.sim_truth_inputs())
            if truth is not None:
                radius = 6_371_000.0
                x = math.radians(float(truth["lon"]) - self.site.home.lon) * radius * math.cos(
                    math.radians(self.site.home.lat)
                )
                y = math.radians(float(truth["lat"]) - self.site.home.lat) * radius
                z = -(float(truth["alt_amsl_m"]) - self.site.home.alt_m)
                vx = vy = vz = 0.0
                if self._last_sim_truth is not None:
                    last_ts, last_x, last_y, last_z = self._last_sim_truth
                    truth_dt = now_s - last_ts
                    if truth_dt > 0.0:
                        vx, vy, vz = (
                            (x - last_x) / truth_dt, (y - last_y) / truth_dt,
                            (z - last_z) / truth_dt,
                        )
                self._last_sim_truth = (now_s, x, y, z)
                extnav_sent = bool(await _maybe_await(self.vehicle.send_extnav_odometry(
                    x, y, z, vx=vx, vy=vy, vz=vz, quality=100
                )))
                if extnav_sent:
                    raw_nav.update({
                        "extnav_fresh": True,
                        "extnav_age_s": float(truth.get("age_s", 0.0)),
                        "extnav_position_variance_m2": 0.04,
                    })
        gps = telem.get("gps") or {}
        if self._faults["gps_loss"]:
            raw_nav.update({"gps_fix": 0, "gps_sats": 0, "gps_hdop": math.inf,
                            "gps_speed_accuracy_mps": math.inf, "ekf_ok": False})
        if self.nav_health is not None:
            self._nav_snapshot = self.nav_health.evaluate(NavSample(
                timestamp_s=now_s,
                gps_fix=int(raw_nav.get("gps_fix", gps.get("fixType", 0))),
                gps_sats=int(raw_nav.get("gps_sats", gps.get("satellites", 0))),
                gps_hdop=float(raw_nav.get("gps_hdop", gps.get("hdop", math.inf))),
                gps_speed_accuracy_mps=float(raw_nav.get("gps_speed_accuracy_mps", math.inf)),
                ekf_ok=bool(raw_nav.get("ekf_ok", False)),
                gps_age_s=float(raw_nav.get("gps_age_s", math.inf)),
                ekf_age_s=float(raw_nav.get("ekf_age_s", math.inf)),
                extnav_fresh=bool(raw_nav.get("extnav_fresh", False)),
                extnav_age_s=float(raw_nav.get("extnav_age_s", math.inf)),
                extnav_position_variance_m2=float(
                    raw_nav.get("extnav_position_variance_m2", math.inf)
                ),
                optflow_quality=float(raw_nav.get("optflow_quality", 0.0)),
                optflow_innovation_mps=float(
                    raw_nav.get("optflow_innovation_mps", math.inf)
                ),
            ))
            requested = self._nav_snapshot.requested_source
            if requested and self.vehicle is not None:
                accepted = bool(await _maybe_await(self.vehicle.set_ekf_source(requested)))
                changed = self.nav_health.confirm_source(requested, accepted)
                if changed:
                    await self._health_event("gps", "source_changed", requested)

        wind = float(raw.get("wind_mps", 0.0))
        if self._faults["wind"]:
            wind = max(13.0, self._fault_values.get("wind", 13.0))
        if wind > 12.0:
            self._wind_above_since_ms = self._wind_above_since_ms or _now_ms()
        else:
            self._wind_above_since_ms = 0.0
        wind_persistent = bool(
            self._wind_above_since_ms
            and _now_ms() - self._wind_above_since_ms >= 5000.0
        )

        if self._faults["lidar"] and airborne and self.site is not None:
            if self._vehicle_state.relAlt >= self.site.clear_altitude_m:
                self._lidar_clear_reached = True
        else:
            self._lidar_clear_reached = False

        bat = self._battery_snapshot
        nav = self._nav_snapshot
        planner_lost = bool(
            self._planner_engaged
            and (
                self._faults["planner_heartbeat"]
                or not self._last_planner_heartbeat_ms
                or _now_ms() - self._last_planner_heartbeat_ms
                > self.config.planner.heartbeat_timeout_ms
            )
        )
        signals = FailsafeSignals(
            airborne=airborne,
            site_valid=self._site_valid,
            readiness_ok=bool(getattr(bat, "ready", False) or armed),
            battery_fault=bool(getattr(bat, "fault", "")),
            battery_should_rtl=bool(getattr(bat, "reserve_should_rtl", False)),
            sortie_should_rtl=bool(
                self._faults["sortie_expiry"]
                or getattr(bat, "sortie_should_rtl", False)
            ),
            datalink_lost=bool(self._faults["link_loss"] or self._actual_datalink_lost()),
            planner_heartbeat_lost=planner_lost,
            gps_healthy=bool(getattr(nav, "gps_healthy", False)),
            rf_interference_recent=bool(
                self._faults["rf_interference"]
                or self._last_rf_interference_ms
                and _now_ms() - self._last_rf_interference_ms <= 60_000
            ),
            hostile_drone=bool(self._faults["hostile_drone"]),
            wind_above_limit=wind > 12.0,
            wind_persistent=wind_persistent,
            camera_failed=bool(
                self._faults["camera"] or self._camera_observation_valid is False
            ),
            thermal_failed=bool(
                self._faults["thermal"] or self._thermal_observation_valid is False
            ),
            night_mission=self._night_mission,
            lidar_failed=bool(
                (self._faults["lidar"] or self._lidar_observation_valid is False)
                and not self._lidar_clear_reached
            ),
            route_through_clutter=self._route_through_clutter,
            charge_stalled=bool(
                bat and "battery charge_stalled" in getattr(bat, "reasons", ())
            ),
            soc_degraded=bool(getattr(bat, "degraded_estimate", False)),
            manual_engaged=False,
        )
        if self.failsafe is not None:
            self._failsafe_decision = self.failsafe.evaluate(signals)

        if bat is not None:
            readiness = self._readiness_message()
            signature = (
                readiness["ready"], tuple(readiness["reasons"]),
                round(readiness["eta_ready_s"], 1),
            )
            due = not armed and _now_ms() - self._last_readiness_push_ms >= 5000
            if signature != self._last_readiness_signature or due:
                self._last_readiness_signature = signature
                self._last_readiness_push_ms = _now_ms()
                if self.api is not None:
                    await self.api.broadcast(readiness)
            if bat.event and bat.event != self._last_battery_event:
                self._last_battery_event = bat.event
                await self._health_event("battery", bat.event.split()[-1], bat.event)
            elif not bat.event:
                self._last_battery_event = ""

    def _readiness_message(self) -> Dict[str, Any]:
        bat = self._battery_snapshot
        reasons = list(getattr(bat, "reasons", ("battery telemetry unavailable",)))
        if not self._site_valid:
            reasons.append("site model invalid")
        if self.vehicle is not None and not self._fc_ready:
            reasons.append("flight controller not ready")
        if self._nav_snapshot is None:
            reasons.append("navigation health unavailable")
        elif getattr(self._nav_snapshot, "refuse_missions", True):
            reasons.append(getattr(self._nav_snapshot, "reason", "navigation unavailable"))
        return {
            "type": "readiness",
            "ts": _now_ms(),
            "vehicleId": self.config.vehicle_id,
            "ready": not reasons,
            "reasons": reasons,
            "eta_ready_s": float(getattr(bat, "eta_ready_s", -1.0)),
        }

    def _connect_messages(self) -> List[Dict[str, Any]]:
        profiles = []
        for name, speed in self.config.planner.profile_speed_mps.items():
            minimum = {"follow": 8.0, "inspect": 5.0, "survey": 8.0}.get(
                name, self.limits.min_standoff
            )
            profiles.append({
                "profile": name,
                "min_standoff_m": max(self.limits.min_standoff, minimum),
                "max_standoff_m": max(self.limits.standoff, 15.0),
                "max_speed_mps": min(self.limits.max_speed, speed),
                "max_altitude_m": self.limits.max_altitude,
            })
        messages = [{
            "type": "capabilities",
            "ts": _now_ms(),
            "vehicleId": self.config.vehicle_id,
            "profiles": profiles,
            "sensors": ["rgb", "thermal", "lidar"],
            "night_capable": bool(
                self.sensor_suite is not None
                and not self._faults["thermal"]
                and self._thermal_observation_valid is not False
            ),
            "max_sortie_s": self.config.battery.max_sortie_s,
            "dispatch_min_soc_pct": self.config.battery.dispatch_min_soc_pct,
        }, self._readiness_message()]
        for component, healthy in (
            ("camera", self._camera_observation_valid),
            ("thermal", self._thermal_observation_valid),
            ("lidar", self._lidar_observation_valid),
        ):
            messages.append({
                "type": "healthEvent", "ts": _now_ms(),
                "vehicleId": self.config.vehicle_id, "component": component,
                "state": "ready" if healthy else "unavailable",
                "detail": "scripted fixture/source validated" if healthy else "health evidence unavailable",
            })
        return messages

    async def _health_event(self, component: str, state: str, detail: str) -> None:
        if self.api is not None:
            await self.api.broadcast({
                "type": "healthEvent",
                "ts": _now_ms(),
                "vehicleId": self.config.vehicle_id,
                "component": component,
                "state": state,
                "detail": detail,
            })

    def _actual_datalink_lost(self) -> bool:
        if self.safety is None or self._control_source not in {
            ControlSource.TRACKING.value,
            ControlSource.MANUAL.value,
            ControlSource.PLANNER.value,
        }:
            return False
        try:
            result = self.safety.evaluate_link(
                self._control_source, airborne=self._vehicle_state.airborne
            )
            return bool(result.tripped)
        except Exception:
            return True

    async def _handle_plan_heartbeat(self, msg: Dict[str, Any]) -> None:
        self._last_planner_heartbeat_ms = _now_ms()

    async def _handle_plan_command(self, msg: Dict[str, Any]) -> Dict[str, Any]:
        request_id = str(msg.get("requestId", ""))
        tool = str(msg.get("tool", ""))
        args = msg.get("args")
        profile = str(msg.get("profile", "standard"))
        response = {
            "type": "planCommandAck", "ts": _now_ms(),
            "vehicleId": self.config.vehicle_id, "requestId": request_id,
            "status": "rejected", "reason": "",
        }
        if not request_id or not isinstance(args, dict):
            response["reason"] = "requestId and args are required"
            return response
        if profile not in self.config.planner.profile_speed_mps:
            response["reason"] = f"unknown profile {profile!r}"
            return response
        decision = self._failsafe_decision
        if decision is not None and getattr(decision, "state", "refuse") != "none":
            response["reason"] = f"failsafe {decision.state}: {decision.reason}"
            return response

        if tool in {"follow", "orbit"}:
            track_id = args.get("track_id", args.get("trackId"))
            if not isinstance(track_id, int) or isinstance(track_id, bool):
                response["reason"] = f"{tool} requires integer track_id"
                return response
            if self.tracker is not None:
                self.tracker.select(track_id)
            minimum = {"follow": 8.0, "inspect": 5.0, "survey": 8.0}.get(profile, 8.0)
            requested = float(args.get("radius", args.get("standoff", minimum)))
            applied = max(self.limits.min_standoff, minimum, requested)
            self.limits.standoff = applied
            self._sync_safety_limits()
            self._tracking_engaged = False
            self._planner_engaged = True
            self._planner_tracking_tool = tool
            self._last_planner_heartbeat_ms = _now_ms()
            self._planner_resume_context = {"kind": "tracking", "tool": tool, "track_id": track_id}
            self._set_control_source(ControlSource.PLANNER.value)
            response["status"] = "clamped" if applied != requested else "accepted"
            response["reason"] = f"{tool} track {track_id} at {applied:.1f} m"
            return response

        normal = dict(args)
        normal["tool"] = tool
        if tool == "goto_relative":
            try:
                dx, dy, dz = (float(normal[name]) for name in ("dx", "dy", "dz"))
            except (KeyError, TypeError, ValueError):
                response["reason"] = "goto_relative requires finite dx/dy/dz"
                return response
            if not all(math.isfinite(v) for v in (dx, dy, dz)):
                response["reason"] = "goto_relative requires finite dx/dy/dz"
                return response
            lat_scale = 111_320.0
            lon_scale = max(1.0, lat_scale * math.cos(math.radians(self._vehicle_state.lat)))
            normal = {
                "tool": "goto_gps",
                "lat": self._vehicle_state.lat + dx / lat_scale,
                "lon": self._vehicle_state.lon + dy / lon_scale,
                "alt": self._vehicle_state.relAlt + dz,
            }
        plan = {
            "requestId": request_id, "anomalyId": "direct-command",
            "tools": [normal], "profile": profile,
            "rationale": "validated direct planner command",
        }
        ok, reason = await self._execute_plan({"plan": plan})
        response["status"] = "accepted" if ok else "rejected"
        response["reason"] = reason
        return response

    async def _handle_rf_event(self, msg: Dict[str, Any]) -> None:
        source = msg.get("source")
        kind = msg.get("kind")
        confidence = msg.get("confidence")
        if source not in {"sdr", "rf_drone"}:
            raise ValueError("invalid RF source")
        if kind not in {"gnss_interference", "drone_link", "remote_id", "hostile_drone"}:
            raise ValueError("invalid RF event kind")
        if not isinstance(confidence, (int, float)) or not 0.0 <= float(confidence) <= 1.0:
            raise ValueError("RF confidence must be in [0,1]")
        for key in ("lat", "pilot_lat"):
            if key in msg and not -90.0 <= float(msg[key]) <= 90.0:
                raise ValueError(f"invalid {key}")
        for key in ("lon", "pilot_lon"):
            if key in msg and not -180.0 <= float(msg[key]) <= 180.0:
                raise ValueError(f"invalid {key}")
        event = {key: msg[key] for key in (
            "type", "ts", "vehicleId", "source", "kind", "band", "confidence",
            "power_delta_db", "lat", "lon", "pilot_lat", "pilot_lon"
        ) if key in msg}
        if kind == "gnss_interference":
            self._last_rf_interference_ms = _now_ms()
            await self._health_event("sdr", "interference", "GNSS and RF interference correlated")
        if kind == "hostile_drone" and float(confidence) >= 0.5:
            self._faults["hostile_drone"] = True
            await self._health_event("sdr", "hostile_drone", "operator continue or RTL required")
        if self.api is not None:
            await self.api.broadcast(event)

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
                self._camera_observation_valid = True
            except Exception:
                observations = []
                self._camera_observation_valid = False

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

        if self._planner_engaged and self.sensor_suite is not None:
            try:
                staged = await asyncio.to_thread(
                    self.sensor_suite.observe,
                    self._vehicle_state.lat,
                    self._vehicle_state.lon,
                    fail_rgb=bool(self._faults["camera"]),
                    fail_thermal=bool(self._faults["thermal"]),
                    fail_lidar=bool(self._faults["lidar"]),
                    observation_radius_m=max(
                        self.config.planner.staging_arrival_radius_m,
                        float(getattr(self.planner, "current_observation_radius_m", 0.0)),
                    ),
                )
                if staged is not None:
                    from .vision.multimodal import observation_message
                    self._camera_observation_valid = staged.sensors["rgb"] == "ok"
                    self._thermal_observation_valid = staged.sensors["thermal"] == "ok"
                    self._lidar_observation_valid = staged.sensors["lidar"] == "ok"
                    if staged.lidar_ranges_m and self.vehicle is not None:
                        closest = min(staged.lidar_ranges_m)
                        if hasattr(self.vehicle, "send_distance_sensor"):
                            await _maybe_await(self.vehicle.send_distance_sensor(closest))
                        if hasattr(self.vehicle, "send_obstacle_distance"):
                            fan = [int(min(65534, max(20, closest * 100.0)))] * 72
                            await _maybe_await(self.vehicle.send_obstacle_distance(fan))
                    if self.api is not None and staged.valid:
                        await self.api.broadcast(
                            observation_message(staged, self.config.vehicle_id)
                        )
                    elif self.api is not None:
                        await self._health_event(
                            "camera", "failed", "no observation: all staged sensor frames invalid"
                        )
            except Exception:
                log.exception("staged multi-sensor observation failed")
                await self._health_event("camera", "failed", "no observation")

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
            "vehicleId": self.config.vehicle_id,
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

        # A hands-on operator is authoritative after the link watchdog passes.
        # Automated holds never overwrite fresh manual sticks.
        if self._manual_engaged:
            sp = self._clamp_setpoint(await self._manual_setpoint(dt))
            await self._send_setpoint(sp)
            return

        # NAV_TAKEOFF owns the GUIDED target until climb completes. Sending
        # the ordinary zero-velocity idle frame here would overwrite it.
        if self._takeoff_deadline_ms:
            if (
                self._vehicle_state.armed
                and _now_ms() < self._takeoff_deadline_ms
                and self._vehicle_state.relAlt < 0.9 * self._takeoff_target_alt
            ):
                return
            self._takeoff_deadline_ms = 0.0

        decision = self._failsafe_decision
        failure = getattr(decision, "state", "none")
        reason = getattr(decision, "reason", "")
        if failure == "rtl":
            if self._last_applied_failsafe != f"rtl:{reason}":
                self._last_applied_failsafe = f"rtl:{reason}"
                self._release_all(ControlSource.AUTO.value)
                await self._status("critical", reason)
                if self.vehicle is not None:
                    await _maybe_await(self.vehicle.set_mode("RTL"))
            await self._send_hold(reason)
            return
        if failure in {"hold", "refuse"} or (
            failure == "escalate" and reason == "probable interference"
        ):
            self._last_applied_failsafe = f"{failure}:{reason}"
            if (
                "LiDAR failed" in reason
                and self.site is not None
                and self._vehicle_state.relAlt < self.site.clear_altitude_m
                and self._guidance_preconditions_ok()
            ):
                climb = VelocitySetpoint(
                    vz=-min(self.limits.max_climb_rate, 1.0), valid=True
                )
                await self._send_setpoint(self._clamp_setpoint(climb))
            else:
                await self._send_hold(reason)
            return
        self._last_applied_failsafe = "none"

        sp = VelocitySetpoint.hold()

        if self._planner_engaged and self._planner_tracking_tool and self._guidance_preconditions_ok():
            sp = self._guidance_setpoint(dt)
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
        """Upload the site's operational polygon geofence (best-effort).

        The perimeter is the site's outer geofence (docs/SITE_CONTRACT.md).
        A failed upload degrades loudly (statusText warning) but never blocks
        startup -- the FC's own fence/failsafe params remain the backstop."""
        if self.vehicle is None:
            return
        if self.site is None or not getattr(self.site, "geofence", None):
            await self._status("warning", "no site model; polygon geofence not uploaded")
            return
        try:
            ok = bool(await _maybe_await(
                self.vehicle.upload_geofence(self.site.geofence)
            ))
        except Exception:
            log.exception("geofence upload raised")
            ok = False
        if ok:
            await self._status(
                "info",
                f"site geofence uploaded ({len(self.site.geofence)} vertices)",
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
            "vehicleId": self.config.vehicle_id,
            "command": command,
            "success": bool(ok),
            "message": message,
        }

    async def _dispatch(self, command: str, params: Dict[str, Any]):
        v = self.vehicle

        # ---- emergencyStop: overrides EVERYTHING, no confirmation ----------
        if command == "emergencyStop":
            return await self._emergency_stop()

        if command == "continueMission":
            return await self._continue_mission()
        if command == "testFault":
            return await self._test_fault(params)
        # Recovery, operator takeover, and explicit return commands remain
        # available during a failsafe. New autonomous work does not.
        decision = self._failsafe_decision
        if (
            decision is not None
            and getattr(decision, "state", "none") != "none"
            and command not in {"rtl", "land", "disarm", "engageManual", "disengageManual"}
        ):
            return False, f"command rejected during {decision.state}: {decision.reason}"

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
            result = await self._vehicle_action("takeoff", lambda: v.takeoff(alt))
            if result[0]:
                self._takeoff_target_alt = alt
                self._takeoff_deadline_ms = _now_ms() + 60_000.0
            return result
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
        readiness = self._readiness_message()
        if not readiness["ready"]:
            return False, "arm refused: " + "; ".join(readiness["reasons"])
        if self._failsafe_decision is not None and getattr(
            self._failsafe_decision, "state", "refuse"
        ) != "none":
            return False, f"arm refused: {self._failsafe_decision.reason}"
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
        if not self._site_valid:
            return False, "plan refused: site model invalid"
        if self._manual_engaged:
            return False, "release manual control before executing a plan"
        if not self._vehicle_state.armed and not self._readiness_message()["ready"]:
            return False, "plan refused: " + "; ".join(self._readiness_message()["reasons"])
        injected_night = bool(
            self.config.sitl
            and os.environ.get("EIS_ENABLE_TEST_HOOKS", "").lower() == "true"
            and os.environ.get("EIS_DEMO_NIGHT", "").lower() == "true"
        )
        requested_night = bool(params.get("night", False) or injected_night)
        requested_clutter = bool(params.get("routeThroughClutter", False))
        if requested_night and (
            self._faults["thermal"] or self._thermal_observation_valid is False
            or self.sensor_suite is None
        ):
            return False, "plan refused: healthy thermal required at night"
        if requested_clutter and (
            self._faults["lidar"] or self._lidar_observation_valid is False
            or self.sensor_suite is None
        ):
            return False, "plan refused: healthy LiDAR required through clutter"
        if self._failsafe_decision is not None and getattr(
            self._failsafe_decision, "state", "refuse"
        ) != "none":
            return False, f"plan refused: {self._failsafe_decision.reason}"
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
        self._last_planner_heartbeat_ms = _now_ms()
        self._planner_tracking_tool = ""
        self._night_mission = requested_night
        self._route_through_clutter = requested_clutter
        self._planner_resume_context = {"kind": "plan", "params": dict(params)}

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
        self._planner_tracking_tool = ""
        if self.planner is not None:
            _safe_call(getattr(self.planner, "abort", None))
        if not was_engaged:
            return True, "no active plan (abortPlan is idempotent)"
        await self._send_hold("abortPlan")
        self._set_control_source(ControlSource.AUTO.value)
        await self._status("info", "mission plan aborted -> hold")
        return True, "plan aborted -> auto hold"

    async def _continue_mission(self):
        if self.failsafe is None or not self.failsafe.hostile_latched:
            return False, "no hostile-drone hold is latched"
        self._faults["hostile_drone"] = False
        resolved = self.failsafe.resolve_hostile("continue")
        # Re-evaluate on the next health tick. Only a still-loaded, explicitly
        # approved mission can resume; a released/aborted mission stays held.
        if not self._planner_engaged or self._planner_resume_context is None:
            await self._send_hold("operator continue without approved mission")
            return False, "hold cleared, but no approved mission remains"
        self._failsafe_decision = resolved
        await self._health_event("sdr", "operator_continue", resolved.reason)
        return True, "hostile-drone hold cleared; approved mission resumed"

    async def _test_fault(self, params: Dict[str, Any]):
        if not (self.config.sitl and os.environ.get("EIS_ENABLE_TEST_HOOKS", "").lower() == "true"):
            return False, "testFault is disabled (requires SITL and EIS_ENABLE_TEST_HOOKS=true)"
        fault = str(params.get("fault", ""))
        enabled = params.get("enabled")
        allowed = set(self._faults) | {"battery_drain", "raw_out_of_fence"}
        if fault not in allowed or not isinstance(enabled, bool):
            return False, "testFault requires a supported fault and boolean enabled"
        if "value" in params:
            try:
                value = float(params["value"])
            except (TypeError, ValueError):
                return False, "testFault value must be finite"
            if not math.isfinite(value):
                return False, "testFault value must be finite"
            self._fault_values[fault] = value
        if fault in self._faults:
            self._faults[fault] = enabled

        ok = True
        if self.vehicle is not None and fault == "gps_loss":
            ok = bool(await _maybe_await(self.vehicle.set_param(
                "SIM_GPS1_ENABLE", 0.0 if enabled else 1.0
            )))
        elif self.vehicle is not None and fault == "battery_drain":
            voltage = self._fault_values.get(fault, 9.9) if enabled else 12.6
            ok = bool(await _maybe_await(self.vehicle.set_param("SIM_BATT_VOLTAGE", voltage)))
        elif enabled and self.vehicle is not None and fault == "raw_out_of_fence":
            if self.site is None:
                return False, "site unavailable"
            lat = max(point[0] for point in self.site.perimeter) + 0.001
            lon = max(point[1] for point in self.site.perimeter) + 0.001
            ok = bool(await _maybe_await(self.vehicle.send_raw_global_target(
                lat, lon, min(self.limits.max_altitude, self.site.alt_band.max_m)
            )))
        await self._health_event("site_model" if fault == "raw_out_of_fence" else "planner",
                                 "injected" if enabled else "cleared", fault)
        return ok, f"test fault {fault} {'enabled' if enabled else 'cleared'}"

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
            result = await _maybe_await(fn())
            if result is False:
                return False, f"{name}: flight controller rejected command"
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
