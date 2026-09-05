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
  (2b) envelope monitor @20 Hz: an INDEPENDENT coroutine fed by telemetry and
        the verified mission record. It checks the certified corridor, the
        altitude band, the geofence margin, NFZ buffers, the standoff floor,
        the sortie budget and inter-vehicle separation, and routes its action
        requests to the FAILSAFE state machine -- never to guidance. Guidance
        can neither read nor write monitor state; the monitor cannot be
        disabled by anything it watches.
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
  * The envelope monitor is INDEPENDENT: its own coroutine, its own inputs,
    its requests reaching the flight state only through control/failsafe.py.
    Manual engage suspends its ACTIONS (a hands-on operator wins) but never
    its evaluation or its logging -- the audit trail stays unbroken.
  * Privileged commands (enterUnattended / exitUnattended / setGimbal) are
    refused unless signed, fresh and unreplayed. Unattended mode is entered
    only by a signed command and reverts the instant an operator connects.
  * A mission record whose hash does not verify is REFUSED, not flown: the
    monitor never runs against a record it cannot check.
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


def _test_hooks_enabled(config: AppConfig) -> bool:
    """SITL + an explicit opt-in. Every test hook is OFF by default."""
    return bool(
        config.sitl
        and os.environ.get("EIS_ENABLE_TEST_HOOKS", "").lower() == "true"
    )


def _test_hook(config: AppConfig, name: str) -> bool:
    """One named test hook: SITL, hooks enabled, AND the hook's own env var.

    Three gates rather than one, because these hooks deliberately produce
    unsafe behaviour (flying outside the corridor, delivering an unverified
    plan) to prove the safety machinery catches it. Nothing here is reachable
    on a real vehicle, and nothing here is reachable by a wire message.
    """
    return bool(
        _test_hooks_enabled(config)
        and os.environ.get(name, "").lower() == "true"
    )


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

        # ---- runtime envelope monitor (its own coroutine; see _envelope_loop)
        # These three flags are the ONLY channel from the monitor to the flight
        # state, and they are consumed exclusively by control/failsafe.py.
        # Guidance never reads them; nothing writes them but _envelope_tick.
        self._envelope_hold: bool = False
        self._envelope_rtl: bool = False
        self._envelope_escalate: bool = False
        self._envelope_speed_scale: float = 1.0
        self._envelope_decision: Any = None
        self._envelope_signature: Optional[Tuple[str, str, str]] = None
        self._envelope_last_publish_ms: float = 0.0
        self._envelope_escalation_key: str = ""
        self._peer_vehicle: Optional[Dict[str, Any]] = None
        self._peer_received_s: float = 0.0
        self._wind_mps: float = 0.0

        # ---- attendance mode + mission record -------------------------------
        self._mission_record: Optional[Dict[str, Any]] = None
        self._sortie_starts_ms: List[int] = []
        self._mode_signature: Optional[Tuple[str, bool]] = None

        # ---- gimbal ---------------------------------------------------------
        self._gimbal_reported_pitch: Optional[float] = None
        self._gimbal_leg_index: int = -1
        self._gimbal_last_sent: Optional[float] = None

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
        self.envelope: Optional[Any] = None        # control.envelope.EnvelopeMonitor
        self.attendance: Optional[Any] = None      # control.mode.AttendanceMachine
        self.unattended_envelope: Optional[Any] = None
        self.gimbal: Optional[Any] = None          # control.gimbal.GimbalController
        self.verifier: Optional[Any] = None        # security.CommandVerifier
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

        # --- runtime envelope monitor + attendance mode + gimbal -----------
        self.envelope = self._build_envelope_monitor()
        self.attendance = self._build_attendance()
        self.unattended_envelope = self._build_unattended_envelope()
        self.gimbal = self._build_gimbal()
        self.verifier = self._build_verifier()

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
            fleet_handler=self._handle_fleet,
            connect_messages=self._connect_messages,
            client_connected_hook=self._on_operator_connected,
            client_disconnected_hook=self._on_operator_disconnected,
            vehicle_id=cfg.vehicle_id,
            audit_path=self._audit_path(),
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

    def _audit_path(self) -> str:
        """Where this vehicle's hash-chained audit log lives.

        PER VEHICLE by default (ADR D26): two companions sharing one file would
        interleave two chains into one that verifies as neither. The historical
        single-vehicle name is kept for ``eis-1`` so an existing log keeps its
        continuity.
        """
        configured = str(self.config.security.audit_path or "").strip()
        if configured:
            return configured
        vehicle = str(self.config.vehicle_id or "eis-1")
        name = (
            "companion-audit.jsonl" if vehicle == "eis-1"
            else f"companion-audit-{vehicle}.jsonl"
        )
        return str(Path(__file__).resolve().parents[3] / "logs" / name)

    def _build_envelope_monitor(self) -> Optional[Any]:
        """The runtime envelope monitor (control/envelope.py).

        Built from the CONFIG-FLOORED thresholds and the site containment
        geometry. It gets no reference to guidance, the planner, the tracker
        or the API -- the orchestrator hands it samples and takes back a
        decision, and that is the whole of its coupling to the rest of the
        system.
        """
        try:
            from .control.envelope import EnvelopeLimits, EnvelopeMonitor
        except Exception:
            log.exception("control.envelope unavailable; envelope monitoring disabled")
            return None
        e = self.config.envelope
        try:
            monitor = EnvelopeMonitor(EnvelopeLimits(
                standoff_floor_m=self.limits.min_standoff,
                geofence_margin_m=e.geofence_margin_m,
                nfz_buffer_m=e.nfz_buffer_m,
                separation_m=e.separation_m,
                separation_stale_m=e.separation_stale_m,
                peer_stale_s=e.peer_stale_s,
                peer_hold_s=e.peer_hold_s,
                escalate_after_s=e.escalate_after_s,
                breach_multiple=e.breach_multiple,
                hysteresis_m=e.hysteresis_m,
                recovery_s=e.recovery_s,
            ))
        except Exception:
            log.exception("failed to construct EnvelopeMonitor")
            return None
        monitor.set_geometry(self._site_geometry())
        return monitor

    def _site_geometry(self) -> Any:
        """Convert the loaded Site into the monitor's plain-data geometry.

        site.py does file I/O and lives outside control/, so the pure monitor
        never sees it -- this is the one place the two shapes meet.
        """
        from .control.envelope import MonitoredZone, SiteGeometry
        if self.site is None:
            return SiteGeometry(nfz_buffer_m=self.config.envelope.nfz_buffer_m)
        zones = tuple(
            MonitoredZone(
                name=zone.name,
                polygon=tuple(tuple(v) for v in zone.polygon),
                ceiling_m=float(zone.ceiling_m),
            )
            for zone in getattr(self.site, "nfz", ())
        )
        return SiteGeometry(
            geofence=tuple(tuple(v) for v in getattr(self.site, "geofence", ())),
            nfz=zones,
            # The site file may only TIGHTEN the buffer: the config floor wins
            # whenever it is larger.
            nfz_buffer_m=max(
                float(getattr(self.site, "nfz_buffer_m", 0.0)),
                float(self.config.envelope.nfz_buffer_m),
            ),
        )

    def _build_attendance(self) -> Optional[Any]:
        """The attended/unattended state machine (control/mode.py).

        Starts ATTENDED with no operator recorded: the safe default is that
        nobody has authorised unattended flight, and only a signed command
        changes that.
        """
        try:
            from .control.mode import AttendanceMachine
        except Exception:
            log.exception("control.mode unavailable; attendance mode disabled")
            return None
        return AttendanceMachine(now_ms=_now_ms(), operator_present=False)

    def _build_unattended_envelope(self) -> Optional[Any]:
        """UNATTENDED_ENVELOPE, tightened by config (never widened)."""
        try:
            from .control.mode import UnattendedEnvelope
        except Exception:
            return None
        u = self.config.unattended
        return UnattendedEnvelope().tightened(
            min_alt_m=u.min_alt_m,
            max_alt_m=u.max_alt_m,
            max_laps=u.max_laps,
            max_hold_s=u.max_hold_s,
            max_sorties_per_hour=u.max_sorties_per_hour,
            max_wind_mps=u.max_wind_mps,
            profiles=u.profiles,
        )

    def _build_gimbal(self) -> Optional[Any]:
        """The pure pointing controller (control/gimbal.py). No MAVLink here."""
        if not self.config.gimbal.enabled:
            return None
        try:
            from .control.gimbal import GimbalController, GimbalLimits
        except Exception:
            log.exception("control.gimbal unavailable; gimbal pointing disabled")
            return None
        g = self.config.gimbal
        try:
            return GimbalController(GimbalLimits(
                min_pitch_deg=g.pitch_min_deg,
                max_pitch_deg=g.pitch_max_deg,
                slew_rate_dps=g.slew_rate_dps,
            ))
        except Exception:
            log.exception("failed to construct GimbalController")
            return None

    def _build_verifier(self) -> Optional[Any]:
        """The signed-command verifier (per vehicle: its own key env var)."""
        try:
            from .security import CommandVerifier
        except Exception:
            log.exception("security.CommandVerifier unavailable")
            return None
        s = self.config.security
        return CommandVerifier.from_env(
            s.session_key_env,
            max_age_ms=s.max_command_age_ms,
            require_all=s.require_signed_commands,
        )

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

        # Launch the task graph. The envelope monitor is its OWN task: it must
        # keep evaluating even if perception stalls or the control loop is
        # held, and it must not be schedulable by anything it watches.
        self._tasks = [
            asyncio.create_task(self._telemetry_loop(), name="telemetry"),
            asyncio.create_task(self._perception_loop(), name="perception"),
            asyncio.create_task(self._control_loop(), name="control"),
            asyncio.create_task(self._envelope_loop(), name="envelope"),
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
        gimbal_pitch = self._gimbal_pitch_for_telemetry()
        if gimbal_pitch is not None:
            # Optional in the contract: an airframe with no commandable mount
            # omits the field rather than reporting a fictional 0.
            telem["gimbal"] = {"pitchDeg": round(float(gimbal_pitch), 2)}
        if self.api is not None:
            await self.api.push_telemetry(telem)

    def _gimbal_pitch_for_telemetry(self) -> Optional[float]:
        """Reported mount pitch, falling back to the commanded angle.

        Preference order is deliberate: what the mount SAYS it is doing beats
        what we asked for, because the gap between the two is the interesting
        failure. With no mount and no controller there is nothing to report.
        """
        if self.vehicle is not None and hasattr(self.vehicle, "gimbal_pitch_deg"):
            try:
                reported = self.vehicle.gimbal_pitch_deg()
            except Exception:
                reported = None
            if reported is not None and math.isfinite(float(reported)):
                self._gimbal_reported_pitch = float(reported)
                return float(reported)
        if self.gimbal is not None:
            return float(self.gimbal.commanded_pitch_deg)
        return self._gimbal_reported_pitch

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
        # Kept for the UNATTENDED_ENVELOPE check, whose wind limit is half the
        # attended one (ADR D23) -- nobody can take manual control up there.
        self._wind_mps = wind
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
            # The envelope monitor's ONLY route into the flight state. It runs
            # in its own coroutine and writes these three flags; nothing in
            # guidance or the planner can read, set or clear them.
            envelope_hold=bool(self._envelope_hold),
            envelope_rtl=bool(self._envelope_rtl),
            envelope_escalate=bool(self._envelope_escalate),
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
        if self.attendance is not None:
            # A reconnecting UI must be told the attendance mode outright --
            # it is not inferable from telemetry, and guessing "attended"
            # would be the dangerous guess.
            messages.append(
                self.attendance.message(self.config.vehicle_id, _now_ms())
            )
        if self._envelope_decision is not None:
            messages.append(self._envelope_decision.to_message(
                self.config.vehicle_id, _now_ms()
            ))
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

    # ---- fleet (the ONLY cross-vehicle input, ADR D26) --------------------
    async def _handle_fleet(self, msg: Dict[str, Any]) -> None:
        """Consume one hub-relayed fleet frame and keep the peer position.

        Star topology: there is no vehicle-to-vehicle radio and no peer-to-peer
        negotiation, so this frame is the only way this vehicle learns about
        the other one -- which is exactly what makes the staleness rule
        enforceable (the age is measurable because there is one path).

        Malformed or self-only frames leave the previous peer in place and
        therefore let it AGE, which widens separation and eventually holds.
        Silently forgetting a peer would do the opposite.
        """
        vehicles = msg.get("vehicles")
        if not isinstance(vehicles, list):
            return
        for entry in vehicles:
            if not isinstance(entry, dict):
                continue
            vid = str(entry.get("vehicleId", ""))
            if not vid or vid == self.config.vehicle_id:
                continue
            position = entry.get("position") or {}
            try:
                lat = float(position.get("lat"))
                lon = float(position.get("lon"))
            except (TypeError, ValueError):
                continue
            if not (math.isfinite(lat) and math.isfinite(lon)):
                continue
            self._peer_vehicle = {
                "vehicleId": vid,
                "lat": lat,
                "lon": lon,
                "relAlt": float(position.get("relAlt", 0.0) or 0.0),
            }
            self._peer_received_s = time.monotonic()
            return

    # ---- operator presence -> attendance mode (ADR D23) ------------------
    async def _on_operator_connected(self, client_count: int) -> None:
        """An operator session appeared: revert to attended, immediately.

        No command, no confirmation, no signature: moving toward supervision
        is always allowed and always automatic.
        """
        if self.attendance is None:
            return
        transition = self.attendance.operator_connected(_now_ms())
        if transition.changed:
            await self._status(
                "warning", "operator connected: reverted to attended mode"
            )
        await self._publish_mode(force=transition.changed)

    async def _on_operator_disconnected(self, client_count: int) -> None:
        """The last operator session went away. The mode does NOT change.

        Losing the operator makes the vehicle unsupervised, not authorised:
        only a signed enterUnattended does that.
        """
        if self.attendance is None or client_count > 0:
            return
        self.attendance.operator_disconnected(_now_ms())
        await self._publish_mode()

    async def _publish_mode(self, *, force: bool = False) -> None:
        """Emit the contract 'mode' message when attendance state changes."""
        if self.api is None or self.attendance is None:
            return
        signature = (self.attendance.mode, self.attendance.operator_present)
        if not force and signature == self._mode_signature:
            return
        self._mode_signature = signature
        await self.api.broadcast(
            self.attendance.message(self.config.vehicle_id, _now_ms())
        )

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
    # Task 2b: runtime envelope monitor @ 20 Hz -- INDEPENDENT of guidance
    # ======================================================================
    async def _envelope_loop(self) -> None:
        """Run the monitor on its own clock, whatever else is happening.

        A tick that raises does NOT leave the last verdict standing: if the
        monitor cannot evaluate, we cannot claim to be inside the envelope, so
        the safe answer is a hold request. That is the same "default to the
        safe state on any exception" rule the control loop follows, applied to
        the component whose whole job is knowing where the edges are.
        """
        period = 1.0 / max(1.0, float(self.config.envelope.hz))
        while not self._stop.is_set():
            t0 = time.monotonic()
            try:
                await self._envelope_tick()
            except Exception:
                log.exception("envelope tick failed -> request hold")
                self._envelope_hold = True
                self._envelope_rtl = False
                self._envelope_speed_scale = 0.0
                await self._health_event(
                    "envelope", "unavailable", "envelope monitor tick failed"
                )
            await self._sleep_remaining(t0, period)

    async def _envelope_tick(self) -> None:
        """One monitor evaluation: sample -> decision -> failsafe request + wire."""
        monitor = self.envelope
        if monitor is None:
            return
        from .control.envelope import EnvelopeSample

        st = self._vehicle_state
        bat = self._battery_snapshot
        sample = EnvelopeSample(
            t_s=time.monotonic(),
            lat=st.lat,
            lon=st.lon,
            rel_alt_m=st.relAlt,
            airborne=bool(st.airborne),
            standoff_m=self._observed_standoff_m(),
            sortie_elapsed_s=float(getattr(bat, "elapsed_sortie_s", 0.0) or 0.0),
            sortie_cap_s=float(getattr(bat, "cap_s", math.inf) or math.inf),
        )
        # A hands-on operator preempts everything: the monitor keeps evaluating
        # and logging (the record must not go dark mid-flight) but its action
        # requests are suspended until manual is released.
        decision = monitor.update(
            sample, peer=self._peer_sample(), suspended=bool(self._manual_engaged)
        )
        self._envelope_decision = decision
        self._apply_envelope_decision(decision)
        await self._publish_envelope(decision)

    def _observed_standoff_m(self) -> float:
        """Measured distance to the observed subject, or ``inf`` if none.

        ``inf`` means "the standoff constraint does not apply this tick" --
        deliberately NOT 0, which would read as a breach every time the tracker
        loses lock.
        """
        result = self._latest_tracking
        if result is None:
            return math.inf
        distance = getattr(result, "estimated_distance", None)
        if distance is None:
            return math.inf
        try:
            value = float(distance)
        except (TypeError, ValueError):
            return math.inf
        return value if math.isfinite(value) and value > 0.0 else math.inf

    def _peer_sample(self) -> Optional[Any]:
        """The peer vehicle from the last fleet message (ADR D26).

        The age is measured from OUR receipt of the fleet frame, which is the
        only path peer state takes -- there is no vehicle-to-vehicle radio, so
        there is no second, unobservable source to disagree with.
        """
        from .control.envelope import PeerSample
        peer = self._peer_vehicle
        if not peer:
            return None
        return PeerSample(
            vehicle_id=str(peer.get("vehicleId", "")),
            lat=float(peer.get("lat", 0.0)),
            lon=float(peer.get("lon", 0.0)),
            rel_alt_m=float(peer.get("relAlt", 0.0)),
            age_s=max(0.0, time.monotonic() - self._peer_received_s),
            valid=True,
        )

    def _apply_envelope_decision(self, decision: Any) -> None:
        """Route the monitor's request to the failsafe machine. Nothing else.

        These flags are read ONLY by ``_health_tick`` when it builds
        ``FailsafeSignals``. There is no path from here to guidance, the
        planner or a setpoint: the monitor constrains, it never guides.
        """
        if getattr(decision, "suspended", False):
            self._envelope_hold = False
            self._envelope_rtl = False
            self._envelope_escalate = False
            self._envelope_speed_scale = 1.0
            return
        action = decision.wire_action
        self._envelope_rtl = action == "rtl"
        self._envelope_hold = action == "hold"
        self._envelope_escalate = bool(decision.escalated)
        self._envelope_speed_scale = float(decision.speed_scale)

    async def _publish_envelope(self, decision: Any) -> None:
        """Emit 'envelope' at ~5 Hz while airborne, plus every state change.

        A change is published immediately whatever the rate: an operator
        should see a breach the tick it happens, not up to 200 ms later.
        """
        if self.api is None:
            return
        signature = decision.signature
        changed = signature != self._envelope_signature
        now = _now_ms()
        period_ms = 1000.0 / max(0.5, float(self.config.envelope.publish_hz))
        due = (
            self._vehicle_state.airborne
            and now - self._envelope_last_publish_ms >= period_ms
        )
        if changed:
            self._envelope_signature = signature
            await self._on_envelope_change(decision)
        if changed or due:
            self._envelope_last_publish_ms = now
            await self.api.broadcast(
                decision.to_message(self.config.vehicle_id, now)
            )

    async def _on_envelope_change(self, decision: Any) -> None:
        """Health event on every envelope state change; escalate on persistence."""
        detail = decision.detail or decision.constraint or "envelope nominal"
        suffix = " (actions suspended: manual control)" if decision.suspended else ""
        await self._health_event(
            "envelope",
            decision.state if not decision.escalated else "escalated",
            f"{detail}{suffix}",
        )
        if decision.escalated:
            key = f"{decision.constraint}:{decision.state}"
            if key != self._envelope_escalation_key:
                self._envelope_escalation_key = key
                await self._escalate_envelope(decision)
        elif decision.state == "in_envelope":
            self._envelope_escalation_key = ""

    async def _escalate_envelope(self, decision: Any) -> None:
        """Raise the contract ``escalation`` for a breach that persisted 5 s.

        An escalation is a message to humans and NEVER a change of flight
        state: the hold or RTL underneath it was decided by the companion and
        stays decided by the companion whether or not anyone reads this.
        """
        if self.api is None:
            return
        record = self._mission_record or {}
        await self.api.broadcast({
            "type": "escalation",
            "ts": _now_ms(),
            "vehicleId": self.config.vehicle_id,
            "missionId": str(record.get("missionId", "")),
            "channel": "console",
            "payload": {
                "kind": "envelope_breach",
                "constraint": decision.constraint,
                "state": decision.state,
                "action": decision.wire_action,
                "marginM": decision.wire_margin_m,
                "detail": decision.detail,
                "durationS": round(float(decision.breach_duration_s), 1),
                "mode": self._attendance_mode(),
            },
        })

    def _attendance_mode(self) -> str:
        return str(getattr(self.attendance, "mode", "attended"))

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
        # The mount is pointed every tick, whatever the flight state: where the
        # camera looks is never a control input, so it is decided here and
        # cannot feed back into guidance.
        await self._gimbal_tick(dt)

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

        # SITL-only, triple-gated: command motion straight out of the certified
        # corridor to prove the monitor is independent of guidance. It sits
        # AFTER the failsafe branches above precisely so the monitor's hold/RTL
        # wins over it -- that suppression IS the proof.
        if self._guidance_override_active():
            await self._send_setpoint(self._clamp_setpoint(
                VelocitySetpoint(vx=self.limits.max_speed, valid=True)
            ))
            return

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

    def _guidance_override_active(self) -> bool:
        """EIS_TEST_GUIDANCE_OVERRIDE: the monitor-independence demo hook.

        OFF by default and unreachable from the wire: it needs SITL,
        EIS_ENABLE_TEST_HOOKS=true AND its own env var, and there is no command
        that sets any of them. It only bites while a mission is actually being
        flown, so it cannot move a parked vehicle.
        """
        if not _test_hook(self.config, "EIS_TEST_GUIDANCE_OVERRIDE"):
            return False
        return bool(
            (self._planner_engaged or self._tracking_engaged)
            and self._guidance_preconditions_ok()
        )

    # ---- gimbal -----------------------------------------------------------
    async def _gimbal_tick(self, dt: float) -> None:
        """Point the mount: auto-geometry during observation legs, or override.

        The auto target is pure trigonometry from the orbit centre's ground
        distance and our altitude (control/gimbal.py). No model is consulted
        and no plan field selects the angle -- an LLM cannot influence where
        the camera looks any more than it can influence where the aircraft
        goes. A new leg clears an operator override.
        """
        if self.gimbal is None:
            return
        leg_index = int(getattr(self.planner, "tool_index", -1))
        if self._planner_engaged and leg_index != self._gimbal_leg_index:
            self._gimbal_leg_index = leg_index
            self.gimbal.clear_override()
        elif not self._planner_engaged:
            self._gimbal_leg_index = -1

        if not self.gimbal.override_active:
            self.gimbal.set_auto_target(self._auto_gimbal_target())

        pitch = self.gimbal.update(dt)
        await self._send_gimbal(pitch)

    def _auto_gimbal_target(self) -> Optional[float]:
        """Deterministic pointing angle for the active observation leg.

        Returns ``None`` (leave the mount where it is) unless a plan is flying
        an orbit: transit legs have nothing to look at, and swinging the mount
        on every goto would only smear the imagery that matters.
        """
        if not self._planner_engaged or self.planner is None:
            return None
        centre = getattr(self.planner, "current_observation_center", None)
        if not centre:
            return None
        from .control.gimbal import auto_pitch_from_ground_deg
        ground = _great_circle_distance_m(
            self._vehicle_state.lat, self._vehicle_state.lon, centre[0], centre[1]
        )
        if not math.isfinite(ground):
            return None
        return auto_pitch_from_ground_deg(
            ground, self._vehicle_state.relAlt, self.gimbal.limits
        )

    async def _send_gimbal(self, pitch_deg: float) -> None:
        """Send the mount command, throttled to actual movement."""
        if self.vehicle is None or not hasattr(self.vehicle, "set_gimbal_pitch"):
            return
        if (
            self._gimbal_last_sent is not None
            and abs(pitch_deg - self._gimbal_last_sent) < 0.25
        ):
            return
        self._gimbal_last_sent = pitch_deg
        try:
            await _maybe_await(self.vehicle.set_gimbal_pitch(
                pitch_deg,
                use_gimbal_manager=bool(self.config.gimbal.use_gimbal_manager),
            ))
        except Exception:
            log.exception("gimbal pitch command failed")

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
            self._disarm_envelope()
            self._set_control_source(ControlSource.AUTO.value)
            await self._status("info", "mission plan complete -> hold")
            await self._send_hold("plan complete")
            return None
        # idle / unexpected while engaged: release and hold (safe default).
        self._planner_engaged = False
        self._disarm_envelope()
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
        envelope so no component can ever push the FC past it.

        The envelope monitor's slow-down request is applied HERE, at the last
        clamp, and not inside guidance. That placement is the point: guidance
        neither reads nor writes monitor state, and the orchestrator -- whose
        job is enforcing invariants between components -- scales what guidance
        already produced. The scale never exceeds 1.0, so it can only tighten.
        """
        if not sp.valid:
            return VelocitySetpoint.hold()
        L = self.limits
        scale = min(1.0, max(0.0, float(self._envelope_speed_scale)))
        speed_cap = L.max_speed * scale
        climb_cap = L.max_climb_rate * scale
        return VelocitySetpoint(
            vx=_clamp(sp.vx, -speed_cap, speed_cap),
            vy=_clamp(sp.vy, -speed_cap, speed_cap),
            vz=_clamp(sp.vz, -climb_cap, climb_cap),
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
        self._disarm_envelope()
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
        verdict = await self._verify_command(msg, command)
        if verdict is not None:
            return verdict
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

    async def _verify_command(
        self, msg: Dict[str, Any], command: str
    ) -> Optional[Dict[str, Any]]:
        """Refuse unsigned, replayed or stale privileged commands.

        Returns a failed CommandAck to send back, or ``None`` to continue to
        dispatch. Unsigned / invalid / replayed / stale are four DIFFERENT
        refusal reasons because they are four different attacks, and every
        rejected privileged command is itself reportable -- an attempt is the
        event (docs/THREAT_MODEL.md A6/A7), so it lands in the hash-chained
        audit as a healthEvent.
        """
        verifier = self.verifier
        if verifier is None:
            # No verifier at all: only privileged commands are affected, and
            # they fail closed rather than falling through unverified.
            from .security import PRIVILEGED_COMMANDS
            if command in PRIVILEGED_COMMANDS:
                await self._health_event(
                    "link", "refused", f"{command} refused: no command verifier"
                )
                return self._ack(command, False, f"{command} refused: no verifier")
            return None
        result = verifier.verify(msg)
        if result.ok:
            return None
        await self._health_event(
            "link", f"refused_{result.failure or 'unsigned'}",
            f"{command}: {result.reason}",
        )
        await self._status("warning", f"{command} refused: {result.reason}")
        return self._ack(command, False, f"{command} refused: {result.reason}")

    def _ack(self, command: str, ok: bool, message: str) -> Dict[str, Any]:
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

        # ---- privileged transitions (already signature-checked) ------------
        # These stay available during a failsafe: pointing the camera and
        # returning to supervision are both things an operator may need while
        # the vehicle is held.
        if command == "enterUnattended":
            return await self._enter_unattended(params)
        if command == "exitUnattended":
            return await self._exit_unattended(params)
        if command == "setGimbal":
            return await self._set_gimbal(params)
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

    # ---- attendance mode (signed) ----------------------------------------
    async def _enter_unattended(self, params: Dict[str, Any]):
        """enterUnattended: the ONLY way into unattended mode, and it is signed.

        The signature was already checked in ``_verify_command`` -- reaching
        here means the envelope was authentic, fresh and unreplayed. An
        operator being connected still blocks entry: unattended means nobody
        is watching, and someone is.
        """
        if self.attendance is None:
            return False, "attendance mode unavailable"
        operator = str(params.get("operatorId", "") or "")
        transition = self.attendance.enter_unattended(
            signature_ok=True, now_ms=_now_ms(), operator_id=operator,
        )
        if not transition.ok:
            await self._health_event("link", "refused", transition.reason)
            return False, transition.reason
        await self._health_event(
            "link", "unattended", f"unattended mode entered by {operator or 'operator'}"
        )
        await self._publish_mode(force=True)
        return True, transition.reason

    async def _exit_unattended(self, params: Dict[str, Any]):
        """exitUnattended: back to supervision. Always permitted."""
        if self.attendance is None:
            return False, "attendance mode unavailable"
        operator = str(params.get("operatorId", "") or "")
        transition = self.attendance.exit_unattended(
            signature_ok=True, now_ms=_now_ms(), operator_id=operator,
        )
        if transition.changed:
            await self._health_event(
                "link", "attended", f"attended mode restored by {operator or 'operator'}"
            )
            await self._publish_mode(force=True)
        return True, transition.reason

    async def _set_gimbal(self, params: Dict[str, Any]):
        """setGimbal: hold a pitch until the next leg (signed, then clamped).

        A valid signature buys the right to ASK; it does not buy travel past
        the mechanical envelope, so the angle is clamped exactly like every
        other operator input.
        """
        if self.gimbal is None:
            return False, "gimbal unavailable"
        try:
            requested = float(params.get("pitchDeg"))
        except (TypeError, ValueError):
            return False, "setGimbal requires params.pitchDeg"
        if not math.isfinite(requested):
            return False, "setGimbal pitchDeg must be finite"
        applied = self.gimbal.set_override(requested)
        clamped = abs(applied - requested) > 1e-6
        note = " (clamped)" if clamped else ""
        return True, (
            f"gimbal pitch {applied:.1f} deg{note}; holds until the next leg"
        )

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

        # The mission record is what the monitor is measured against, so it is
        # checked BEFORE anything is loaded: a record whose hash does not match
        # its content is refused, never flown (FAILURE_MODES, "Monitor input
        # stale -- mission record hash mismatch").
        record = params.get("missionRecord")
        ok, message = await self._verify_dispatch_record(record)
        if not ok:
            return False, message

        # Unattended dispatch must fit UNATTENDED_ENVELOPE (ADR D23). Outside
        # it the answer is REFUSE -- never a clamp into range -- and the
        # refusal escalates, because an unattended request the system declined
        # is precisely what a human needs to see.
        ok, message = await self._check_unattended_dispatch(plan, params)
        if not ok:
            return False, message

        plan = self._maybe_corrupt_plan(plan)

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
        await self._arm_envelope(plan, params.get("missionRecord"))
        await self._status("info", f"mission plan engaged: {message}")
        return True, message

    # ---- dispatch-time trust checks --------------------------------------
    async def _verify_dispatch_record(
        self, record: Optional[Any]
    ) -> Tuple[bool, str]:
        """Verify the mission record's hash chain before anything is dispatched.

        A record that declares a hash must match its own content; a mismatch
        REFUSES the dispatch and raises a health event, because the monitor
        would otherwise be measuring the flight against a record nobody can
        vouch for. A dispatch with no record at all is still accepted (the
        ground half stamps records incrementally), and that is the only reason
        this is not simply mandatory.
        """
        try:
            from .security import verify_mission_record
        except Exception:
            return True, ""
        check = verify_mission_record(record, required=False)
        if check.ok:
            return True, ""
        await self._health_event("envelope", "refused", check.reason)
        await self._status("critical", f"dispatch refused: {check.reason}")
        return False, f"plan refused: {check.reason}"

    async def _check_unattended_dispatch(
        self, plan: Dict[str, Any], params: Dict[str, Any]
    ) -> Tuple[bool, str]:
        """Gate an unattended dispatch on UNATTENDED_ENVELOPE (ADR D23)."""
        if self.attendance is None or not self.attendance.unattended:
            return True, ""
        if self.unattended_envelope is None:
            return False, "plan refused: unattended envelope unavailable"
        from .control.mode import DispatchRequest, check_unattended

        alt, laps, hold_s = _plan_envelope_shape(plan)
        request = DispatchRequest(
            profile=str(plan.get("profile", "")),
            altitude_m=alt,
            laps=laps,
            hold_s=hold_s,
            inside_perimeter=self._plan_inside_perimeter(plan),
            nav_source=str(getattr(self._nav_snapshot, "source", "gps")),
            rf_interference=bool(
                self._faults["rf_interference"]
                or (
                    self._last_rf_interference_ms
                    and _now_ms() - self._last_rf_interference_ms <= 60_000
                )
            ),
            hostile_drone=bool(self._faults["hostile_drone"]),
            night=bool(params.get("night", False)),
            thermal_healthy=not (
                self._faults["thermal"] or self._thermal_observation_valid is False
            ),
            wind_mps=float(self._wind_mps),
            recent_sortie_starts_ms=tuple(self._sortie_starts_ms),
            now_ms=_now_ms(),
        )
        check = check_unattended(request, self.unattended_envelope)
        if check.ok:
            return True, ""
        reason = f"unattended dispatch refused: {check.reason}"
        await self._health_event("envelope", "refused", reason)
        await self._escalate_unattended_refusal(check)
        return False, reason

    async def _escalate_unattended_refusal(self, check: Any) -> None:
        """Every envelope refusal escalates -- there is nobody there to tell."""
        if self.api is None:
            return
        await self.api.broadcast({
            "type": "escalation",
            "ts": _now_ms(),
            "vehicleId": self.config.vehicle_id,
            "missionId": str((self._mission_record or {}).get("missionId", "")),
            "channel": "console",
            "payload": {
                "kind": "unattended_envelope_refusal",
                "violations": list(check.violations),
                "mode": self._attendance_mode(),
            },
        })

    def _plan_inside_perimeter(self, plan: Dict[str, Any]) -> bool:
        """Does every coordinate in the plan lie inside the site perimeter?

        With no site model the answer is False, not True: "we cannot check"
        must never read as "it is fine" for an unattended dispatch.
        """
        if self.site is None or not getattr(self.site, "perimeter", None):
            return False
        from .control.envelope import point_in_polygon
        perimeter = [tuple(v) for v in self.site.perimeter]
        for tool in plan.get("tools") or ():
            if not isinstance(tool, dict):
                continue
            lat, lon = tool.get("lat"), tool.get("lon")
            if lat is None or lon is None:
                continue
            try:
                point = (float(lat), float(lon))
            except (TypeError, ValueError):
                return False
            if not point_in_polygon(point, perimeter):
                return False
        return True

    def _maybe_corrupt_plan(self, plan: Dict[str, Any]) -> Dict[str, Any]:
        """EIS_TEST_BAD_PLAN: deliver a NON-planner plan and watch it bounce.

        OFF by default and triple-gated like the guidance-override hook. It
        substitutes a tool no deterministic planner can emit, so the companion's
        own validator rejects it at ``planner_exec.load_plan`` -- proving the
        companion re-validates rather than trusting whatever arrived over the
        wire. It corrupts a COPY; the caller's plan is untouched.
        """
        if not _test_hook(self.config, "EIS_TEST_BAD_PLAN"):
            return plan
        log.warning("EIS_TEST_BAD_PLAN active: injecting a non-planner tool")
        corrupted = dict(plan)
        corrupted["tools"] = [
            {"tool": "teleport", "lat": 0.0, "lon": 0.0},
            *list(plan.get("tools") or ()),
        ]
        return corrupted

    async def _arm_envelope(
        self, plan: Dict[str, Any], record: Optional[Any]
    ) -> None:
        """Install the certified corridor and open the mission record.

        The corridor comes from the mission record when it carries one, else
        from the plan. It is what the monitor checks -- NOT the waypoint list
        and never the planner's own arithmetic (ADR D21).
        """
        from .control.envelope import Corridor

        raw_record = dict(record) if isinstance(record, dict) else {}
        corridor_raw = raw_record.get("corridor") or plan.get("corridor")
        corridor = Corridor.from_wire(corridor_raw)
        if self.envelope is not None:
            self.envelope.set_geometry(self._site_geometry())
            self.envelope.arm(corridor)
        self._envelope_signature = None
        self._envelope_escalation_key = ""

        started = _now_ms()
        self._sortie_starts_ms = [
            ts for ts in self._sortie_starts_ms if started - ts <= 3_600_000
        ][-16:]
        self._sortie_starts_ms.append(started)

        # Every dispatch is tagged with the attendance mode in force, so the
        # record answers "was anyone watching?" without inference.
        self._mission_record = {
            **raw_record,
            "missionId": str(raw_record.get("missionId", plan.get("requestId", ""))),
            "vehicleId": self.config.vehicle_id,
            "anomalyId": str(raw_record.get("anomalyId", plan.get("anomalyId", ""))),
            "startedAt": started,
            "mode": self._attendance_mode(),
        }
        if not corridor.has_shape:
            await self._health_event(
                "envelope", "degraded",
                "no corridor in the mission record; only site containment is monitored",
            )
        await self._publish_mode()

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
        self._disarm_envelope()
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
        self._disarm_envelope()
        self._set_control_source(source)

    def _disarm_envelope(self) -> None:
        """Drop the mission corridor when the plan goes away.

        The monitor keeps running -- site containment (geofence, NFZ buffers,
        standoff, separation) applies whether or not a plan is loaded. Only
        the corridor, which belongs to a specific dispatch, is dropped, and
        with it the action requests that corridor raised.
        """
        if self.envelope is not None:
            _safe_call(getattr(self.envelope, "disarm", None))
        self._envelope_hold = False
        self._envelope_rtl = False
        self._envelope_escalate = False
        self._envelope_speed_scale = 1.0
        self._envelope_signature = None
        self._envelope_escalation_key = ""
        if self.gimbal is not None:
            _safe_call(getattr(self.gimbal, "clear_override", None))
        self._gimbal_leg_index = -1

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


def _plan_envelope_shape(plan: Dict[str, Any]) -> Tuple[float, float, float]:
    """(altitude_m, laps, hold_s) -- the shape UNATTENDED_ENVELOPE checks.

    The WORST case of each is returned (highest altitude, most laps, longest
    hold): an envelope check has to be answered by the part of the plan that
    comes closest to the limit, not by its average. A plan that declares no
    altitude yields NaN, which fails the band test -- "we could not tell" must
    not read as "it was fine" when nobody is watching.
    """
    altitude = math.nan
    laps = 0.0
    hold_s = 0.0
    for tool in plan.get("tools") or ():
        if not isinstance(tool, dict):
            continue
        name = str(tool.get("tool", ""))
        for key in ("alt", "alt_m", "altitude"):
            if key in tool:
                try:
                    value = float(tool[key])
                except (TypeError, ValueError):
                    continue
                if math.isfinite(value):
                    altitude = value if math.isnan(altitude) else max(altitude, value)
        if name in ("orbit", "orbit_point"):
            try:
                laps = max(laps, float(tool.get("laps", 1.0)))
            except (TypeError, ValueError):
                laps = max(laps, 1.0)
        if name == "hold":
            for key in ("durationS", "duration_s"):
                if key in tool:
                    try:
                        hold_s = max(hold_s, float(tool[key]))
                    except (TypeError, ValueError):
                        pass
    return (altitude, laps, hold_s)


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
