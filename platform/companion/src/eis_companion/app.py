"""
============================================================================
Drone Safety Platform -- COMPANION orchestrator + CLI entry point
----------------------------------------------------------------------------
    python -m eis_companion.app   [--config PATH] [--sitl]

This module is GLUE, and deliberately nothing else. The control math lives in
the pure-logic ``control`` package, the MAVLink protocol in ``mavlink.Vehicle``,
the detector in ``vision``. What is here is composition plus the invariants that
only exist BETWEEN those components -- the ones no single component can enforce
on its own, because each of them can only see itself.

Structure
---------
``_Cadence`` + ``Companion._drive``
    One scheduler behind all four loops. A loop body is the work it does; the
    driver owns the stop condition, the tick delta and the promise that a
    raising tick is contained and answered with that loop's safe state.

``Companion._ARBITRATION``
    The control tick's priority ladder, written down as an ordered list of
    gates: e-stop, ground-link deadman, hands-on manual, the failsafe ladder,
    the takeoff window, then the SITL override hook. The first gate that
    handles the tick ends it. Anything that clears the whole ladder reaches
    source arbitration, which picks the ONE active source and emits one
    clamped setpoint.

``Companion._COMMANDS``
    The command surface as a table: name -> method, whether it takes params,
    and whether it is exempt from the failsafe gate. Adding a command is a row
    plus a method, never another branch in a dispatch chain.

``Companion._COMPONENT_SLOTS``
    Every component ``setup()`` builds. Each one may legitimately be ``None``:
    a companion with no camera, no FC and no video still boots, and it boots
    HELD. Degrading is always preferred to refusing to start.

The four tasks
--------------
  (1) telemetry pump @10 Hz -- read the FC, run the health ladder, stamp the
      frame with the authoritative control source, push it.
  (2) perception @~10 Hz -- frames -> detect -> tracker -> push 'tracking',
      with staging-point still images spliced in while a plan is flying.
  (2b) envelope monitor @20 Hz -- an INDEPENDENT coroutine fed by telemetry and
      the verified mission record. It checks the certified corridor, the
      altitude band, the geofence margin, NFZ buffers, the standoff floor, the
      sortie budget and inter-vehicle separation, and routes its requests to
      the FAILSAFE state machine -- never to guidance. Guidance can neither
      read nor write monitor state, and the monitor cannot be disabled by
      anything it watches.
  (3) control loop @20 Hz -- the ladder above, then a clamped body-velocity
      setpoint (or, for a goto leg, a global position target through
      ``Vehicle.goto_global``, which clamps again on its own path).
  (4) command dispatch -- event-driven, through the API handler.

SAFETY INVARIANTS enforced here (PRD 11)
----------------------------------------
  * Exactly one controlSource is ever active (auto | tracking | manual | planner),
    and it is reported in every telemetry frame.
  * standoff is a hard limit -- delegated to Guidance, never overridden here.
  * Every setpoint is clamped to Limits before it reaches the FC.
  * Manual + ground-link watchdogs zero-and-hold on input/link loss; the
    ground-link deadman covers planner flight too.
  * emergencyStop/disarm need no confirmation and override everything, and the
    e-stop LATCH clears only on an observed disarm on the ground.
  * Default to the safe (hold) state on startup and on ANY exception.
  * Manual engage suspends the monitor's ACTIONS (a hands-on operator wins) but
    never its evaluation or its logging -- the audit trail stays unbroken.
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
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

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
    """Clamp to [lo, hi]; a NON-FINITE input collapses to 0.0, never to ``hi``.

    Written as explicit comparisons rather than ``max(lo, min(hi, v))`` on
    purpose. Every comparison against NaN is False, so the nested min/max form
    silently returns ``hi``: it is a NaN-to-full-throttle amplifier, turning
    one unusable axis into +max_speed / +max_climb_rate / +max_yaw_rate on all
    four axes at once (FM-06). Zero is the only defensible answer for a number
    we cannot order, so it is decided FIRST and the ordering never sees it.
    """
    if not math.isfinite(v):
        return 0.0
    low, high = (lo, hi) if lo <= hi else (hi, lo)
    if v < low:
        return low
    return high if v > high else v


#: Mean Earth radius, metres. Fixed by the haversine formulation below.
_EARTH_RADIUS_M = 6_371_000.0


def _is_geographic(lat: float, lon: float) -> bool:
    """True when (lat, lon) is a finite, in-range WGS-84 coordinate pair."""
    return (
        math.isfinite(lat) and math.isfinite(lon)
        and -90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0
    )


def _great_circle_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Return surface distance in metres, or infinity for malformed positions.

    ``inf`` for anything we cannot place on the globe is deliberate: every
    caller compares the result against a radius or a margin, and an unplaceable
    position must read as "further away than any limit", never as zero.
    """
    try:
        a_lat, a_lon = float(lat1), float(lon1)
        b_lat, b_lon = float(lat2), float(lon2)
    except (TypeError, ValueError):
        return math.inf
    if not (_is_geographic(a_lat, a_lon) and _is_geographic(b_lat, b_lon)):
        return math.inf
    phi_a, phi_b = math.radians(a_lat), math.radians(b_lat)
    half_dphi = 0.5 * (phi_b - phi_a)
    half_dlambda = 0.5 * math.radians(b_lon - a_lon)
    hav = (
        math.sin(half_dphi) ** 2
        + math.cos(phi_a) * math.cos(phi_b) * math.sin(half_dlambda) ** 2
    )
    # Round-off can push hav a hair outside [0, 1]; asin would then raise.
    return 2.0 * _EARTH_RADIUS_M * math.asin(math.sqrt(min(1.0, max(0.0, hav))))


class _Cadence:
    """The clock for one orchestrator loop: a fixed rate plus the tick delta.

    Each of the four loops used to carry its own copy of ``t0 = monotonic();
    tick; sleep(period - elapsed)``, and the control loop additionally tracked
    ``last`` by hand to derive ``dt``. Both jobs live here so a loop body is
    only the work it does, and so "how fast does this run" is a value that can
    be read, logged and (for the envelope monitor) taken from config.
    """

    __slots__ = ("name", "period", "_previous")

    def __init__(self, name: str, hz: float) -> None:
        self.name = name
        self.period = 1.0 / max(0.001, float(hz))
        self._previous: Optional[float] = None

    def tick(self, now: float) -> float:
        """Seconds since the previous tick. The FIRST tick reports 0.0 -- there
        is no elapsed interval before the loop started, and inventing one would
        hand every PID a bogus first derivative."""
        previous, self._previous = self._previous, now
        return 0.0 if previous is None else max(0.0, now - previous)


#: What one loop does when its tick raises. The orchestrator's rule is "default
#: to the safe state on ANY exception", but the safe state differs per loop:
#: telemetry/perception simply lose a frame, the control loop must hold, and
#: the envelope monitor must request a hold it cannot otherwise justify.
_TickFailure = Callable[[BaseException], Awaitable[None]]


class Companion:
    """The orchestrator. Owns the components + the shared mutable runtime state
    (active control source, tracking-engaged flag, latest setpoint) and runs the
    asyncio task graph."""

    #: Every component slot ``setup()`` fills, and what fills it. Declared as
    #: data so "what does the orchestrator compose" is a list rather than a
    #: scroll -- and so the degrade-to-None contract is stated once: EVERY
    #: entry here may legitimately be ``None`` at runtime, and every caller
    #: must cope. Nothing outside setup() creates one of these.
    _COMPONENT_SLOTS: Dict[str, str] = {
        "vehicle": "mavlink.Vehicle -- the FC link (None without pymavlink)",
        "source": "vision source: SimTargetSource or _CameraSource",
        "tracker": "control.Tracker -- single-target lock",
        "guidance": "control.Guidance -- visual servoing",
        "manual": "control.ManualPilot -- sticks -> setpoint",
        "planner": "control.PlannerExecutor -- mission-plan legs",
        "site": "site.Site -- perimeter, NFZ, staging (may be None)",
        "staging_observer": "vision.StagingObserver -- still-image detections",
        "sensor_suite": "vision.multimodal.StagedSensorSuite",
        "battery_health": "control.BatteryHealth",
        "nav_health": "control.NavHealth",
        "failsafe": "control.FailsafeMachine -- the ladder",
        "envelope": "control.envelope.EnvelopeMonitor -- independent monitor",
        "attendance": "control.mode.AttendanceMachine",
        "unattended_envelope": "control.mode.UnattendedEnvelope",
        "gimbal": "control.gimbal.GimbalController -- pure pointing",
        "verifier": "security.CommandVerifier -- signed commands",
        "safety": "mavlink.SafetyManager -- deadman, arming, e-stop",
        "api": "api.ApiServer -- the control WebSocket contract",
        "video": "stream.VideoStream -- RTSP/WebRTC",
    }

    #: The SITL fault-injection rails, all OFF. The KEYS are the contract:
    #: ``testFault`` names one of these and nothing else, and the health
    #: ladder reads them by the same names.
    _FAULT_RAILS = (
        "gps_loss", "rf_interference", "hostile_drone", "link_loss",
        "planner_heartbeat", "camera", "thermal", "lidar",
        "battery_fault", "sortie_expiry", "charge", "wind",
    )

    def __init__(self, config: AppConfig) -> None:
        self.config = config
        self.limits: Limits = config.limits
        # Runtime state is grouped by WHO WRITES IT, not by type: each group
        # below has one owner, and that is what makes the invariants
        # checkable. The components themselves are created empty here and
        # filled by setup().
        self._init_authority_state()
        self._init_link_state()
        self._init_health_state()
        self._init_envelope_state()
        self._init_mission_state()
        self._stop = asyncio.Event()
        self._tasks: List[asyncio.Task] = []
        for slot in self._COMPONENT_SLOTS:
            setattr(self, slot, None)

    def _init_authority_state(self) -> None:
        """Who is flying, and what the last thing we heard from them was.

        ``_control_source`` is the single source of truth reported in every
        telemetry frame; the three engagement flags are what elect it, and
        exactly one of them may be set (PRD 11).
        """
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
        self._planner_tracking_tool: str = ""
        self._planner_resume_context: Optional[Dict[str, Any]] = None
        self._takeoff_target_alt: float = 0.0
        self._takeoff_deadline_ms: float = 0.0
        # Standoff the operator configured, restored when a plan releases the
        # shared Limits it borrowed (FM-11).
        self._operator_standoff_m: Optional[float] = None

    def _init_link_state(self) -> None:
        """The two links -- ground and FC -- and the latches over them.

        The ground-link deadman latch lives HERE, in orchestrator state,
        rather than in the SafetyManager (FM-03). The deadman used to silence
        its own trigger: ``_on_deadman`` reset the control source to 'auto',
        and ``SafetyManager.evaluate_link`` only trips for
        tracking/manual/planner, so from the very next tick the link looked
        fine, ``datalink_lost`` went False, and exactly one unverified RTL
        attempt was ever made. Living out here, the latch survives the source
        reset; only a fresh, AUTHORIZED ground heartbeat clears it.
        """
        self._link_lost_latched: bool = False
        self._link_lost_since_ms: float = 0.0
        self._deadman_rtl_attempt_ms: float = 0.0
        self._last_applied_failsafe: str = "none"
        # RTL is latched only once the FC is OBSERVED in RTL (FM-01/FM-02).
        self._rtl_requested_reason: str = ""
        self._rtl_last_attempt_ms: float = 0.0
        self._last_fc_heartbeat_sent_s: float = 0.0
        self._last_planner_heartbeat_ms: float = 0.0
        self._last_rf_interference_ms: float = 0.0
        self._fc_link_lost: bool = False
        self._fc_link_event: str = ""
        self._fc_ready: bool = False
        # What we can prove about the FC geofence (FM-14/FM-15). None until an
        # upload has been attempted.
        self._fence_enforced: Optional[bool] = None
        self._fence_detail: str = ""
        self._site_valid: bool = False

    def _init_health_state(self) -> None:
        """Every rail the health ladder reads, plus the SITL fault injectors.

        THREE separate camera-health facts are kept apart (FM-25 / FM-100):
          * ``_camera_source_valid``      -- the live capture rail this tick;
          * ``_camera_fixture_valid``     -- the scripted staging assets at boot;
          * ``_camera_observation_valid`` -- the last STAGED observation's RGB.
        They used to be one field, so the 10 Hz perception loop (running a
        'sim' source that cannot fail) overwrote the fixture verdict ~100 ms
        after boot, and the startup health report was a lie by the time any
        operator connected.

        ``_wind_known`` is deliberately TRI-STATE: None = the FC layer has
        never reported on the WIND rail; False = it reported that no estimate
        exists; True = an estimate is live. Only an explicit False refuses an
        unattended dispatch (FM-20).
        """
        self._failsafe_decision: Any = None
        self._battery_snapshot: Any = None
        self._nav_snapshot: Any = None
        self._last_readiness_signature: Optional[Tuple[Any, ...]] = None
        self._last_readiness_push_ms: float = 0.0
        self._wind_above_since_ms: float = 0.0
        self._wind_known: Optional[bool] = None
        self._route_through_clutter: bool = False
        self._night_mission: bool = False
        self._lidar_clear_reached: bool = False
        self._was_armed: bool = False
        self._charge_started_ms: float = 0.0
        self._charge_curve: Any = None
        self._last_battery_event: str = ""
        self._last_sim_truth: Optional[Tuple[float, float, float, float]] = None
        self._camera_source_valid: Optional[bool] = None
        self._camera_fixture_valid: Optional[bool] = None
        self._camera_observation_valid: Optional[bool] = None
        self._thermal_observation_valid: Optional[bool] = None
        self._lidar_observation_valid: Optional[bool] = None
        self._sensor_fixture_gaps: Dict[str, Tuple[str, ...]] = {}
        self._detector_capabilities: Dict[str, Any] = {}
        self._faults: Dict[str, Any] = {rail: False for rail in self._FAULT_RAILS}
        self._fault_values: Dict[str, float] = {}

    def _init_envelope_state(self) -> None:
        """The monitor's outputs -- and NOTHING the monitor reads.

        The first three flags are the ONLY channel from the runtime envelope
        monitor to the flight state, and they are consumed exclusively by
        control/failsafe.py. Guidance never reads them; nothing writes them
        but ``_envelope_tick``.
        """
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

    def _init_mission_state(self) -> None:
        """Attendance mode, the durable mission record, and the gimbal."""
        self._mission_record: Optional[Dict[str, Any]] = None
        self._sortie_starts_ms: List[int] = []
        self._mode_signature: Optional[Tuple[str, bool]] = None
        self._gimbal_reported_pitch: Optional[float] = None
        self._gimbal_leg_index: int = -1
        self._gimbal_last_sent: Optional[float] = None

    # ======================================================================
    # Construction / teardown
    # ======================================================================
    #: The build order, as phases. Order is a DEPENDENCY, not a preference:
    #: the site model must exist before the planner and the envelope monitor
    #: that read its geometry, and the safety manager before the API handlers
    #: that consult it. Each phase is independently readable, and a phase that
    #: degrades leaves ``None`` in its slots rather than aborting the boot.
    _BUILD_PHASES = (
        "_build_control_core",
        "_build_site_layer",
        "_build_health_layer",
        "_build_supervision_layer",
        "_build_io_layer",
    )

    def setup(self) -> None:
        """Instantiate every component, in dependency order.

        Pure-logic + API + safety are built unconditionally; the
        hardware-facing Vehicle / vision / video degrade to no-ops if their
        dependencies (pymavlink, camera, mediamtx) are absent, so the
        companion still boots into a safe held state.
        """
        for phase in self._BUILD_PHASES:
            getattr(self, phase)()

    def _build_control_core(self) -> None:
        """The pure-logic core: tracker, guidance, manual pilot.

        numpy + stdlib only. Nothing here touches I/O, which is why it is
        unit-testable with no hardware and why it is built first.
        """
        from .control.guidance import Guidance
        from .control.tracker import Tracker

        cfg = self.config
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

    def _build_site_layer(self) -> None:
        """Site model, then everything derived from it.

        ``site`` does file I/O and lives OUTSIDE control/, so its data is
        handed to the pure-logic PlannerExecutor / StagingObserver as plain
        numbers. The load MUST precede the three builders below, each of which
        reads the loaded geometry.
        """
        self.site = self._load_site()
        self.planner = self._build_planner()
        self.staging_observer = self._build_staging_observer()
        self.sensor_suite = self._build_sensor_suite()

    def _build_health_layer(self) -> None:
        """Battery, navigation and the failsafe state machine.

        The two ``require_*_telemetry`` flags are inverted SITL: on real
        hardware, missing cell or temperature telemetry is a fault; in SITL it
        is simply not modelled, and demanding it would ground every sim run.
        """
        from .control.battery_health import BatteryHealth, BatteryPolicy
        from .control.failsafe import FailsafeMachine
        from .control.nav_health import NavHealth

        cfg = self.config
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

    def _build_supervision_layer(self) -> None:
        """Envelope monitor, attendance mode, gimbal, verifier, safety manager.

        These are the components that CONSTRAIN rather than fly: none of them
        produces a setpoint, and none of them is reachable from guidance.
        """
        from .mavlink import SafetyManager

        self.envelope = self._build_envelope_monitor()
        self.attendance = self._build_attendance()
        self.unattended_envelope = self._build_unattended_envelope()
        self.gimbal = self._build_gimbal()
        self.verifier = self._build_verifier()
        self.safety = SafetyManager(self.limits)

    def _build_io_layer(self) -> None:
        """The outward-facing rails: FC link, vision, control socket, video.

        Built LAST so every handler the API server is wired to already has the
        components it consults. The FC link and the vision source degrade to
        ``None``; the control socket does not, because a companion no operator
        can reach is worse than one with no camera.
        """
        cfg = self.config
        self.vehicle = self._build_vehicle()
        self.source = self._build_vision_source()

        from .api import ApiServer
        self.api = ApiServer(
            host=cfg.network.host,
            port=cfg.network.control_port,
            command_handler=self._handle_command,
            manual_handler=self._handle_manual_input,
            # The deadman latch and the SafetyManager timestamp clear TOGETHER
            # (FM-03): clearing only one is how a latch becomes write-only.
            heartbeat_hook=self._note_ground_heartbeat,
            # EVERY inbound frame passes the signed-command layer before it
            # counts as liveness or reaches a handler (FM-40).
            authorize_hook=self._authorize_frame,
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
        self.video = self._build_video()

    @staticmethod
    def _optional(what: str, factory, *, degraded: str) -> Optional[Any]:
        """Construct one degradable component, or return ``None`` saying why.

        Two failures are reported differently on purpose. An ImportError is
        an ABSENT dependency -- expected on a dev box, a warning. Anything the
        factory itself raises is a construction BUG and gets a traceback. The
        pattern is shared by every hardware-facing and optional-control
        component so the companion always boots into a held state rather than
        refusing to boot at all.
        """
        try:
            return factory()
        except ImportError:
            log.warning("%s unavailable; %s", what, degraded)
        except Exception:
            log.exception("failed to construct %s; %s", what, degraded)
        return None

    def _build_manual_pilot(self) -> Optional[Any]:
        """Build the ManualPilot from the control package (documented path)."""
        def build():
            from .control.manual import ManualPilot  # control-core agent's module
            return ManualPilot()

        return self._optional(
            "control.manual.ManualPilot", build,
            degraded="manual piloting disabled",
        )

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
        """The FC link. Absent pymavlink degrades to a held, link-less boot."""
        cfg = self.config

        def build():
            from .mavlink import Vehicle  # lazily imports pymavlink
            return Vehicle(
                connection=cfg.fc.connection,
                baud=cfg.fc.baud,
                source_system=cfg.fc.gcs_sysid,
                target_system=cfg.fc.sysid,
                # goto_global clamps to THIS envelope (the global-position
                # path's second clamp); share the live Limits object BY
                # REFERENCE so runtime edits (setMaxSpeed) apply immediately.
                limits=self.limits,
            )

        return self._optional(
            "mavlink.Vehicle (pymavlink missing?)", build,
            degraded="FC link disabled",
        )

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
            # The FIXTURE verdict is kept in its own field so the perception
            # loop cannot overwrite it, and the per-point detail is kept so an
            # operator is told WHICH asset is bad rather than losing a whole
            # rail to one unreadable file (FM-25).
            self._camera_fixture_valid = health["rgb"]
            self._thermal_observation_valid = health["thermal"]
            self._lidar_observation_valid = health["lidar"]
            try:
                self._sensor_fixture_gaps = {
                    rail: tuple(ids)
                    for rail, ids in suite.unhealthy_points().items()
                }
            except Exception:
                self._sensor_fixture_gaps = {}
            return suite
        except Exception:
            log.exception("failed to construct staged sensor suite")
            return None

    #: Camera sources that need no hardware at all.
    _SYNTHETIC_CAMERA_SOURCES = frozenset({"sim", "mock"})

    def _build_vision_source(self) -> Optional[Any]:
        """The perception front end: a synthetic source, or a real camera.

        The real-camera path separates THREE failure classes, and the
        separation stays in this one method because it is what the honesty
        tests read. Missing extra, wiring bug and runtime failure each get
        their own branch: the parameter is ``conf_threshold``, and calling it
        ``conf=`` raised TypeError on EVERY real-camera build. A blanket
        ``except`` reported that construction bug as "no hardware", so
        perception was silently disabled for the whole flight with a log line
        as the only evidence (FM-101).
        """
        cfg = self.config
        if cfg.camera.source in self._SYNTHETIC_CAMERA_SOURCES:
            def build_sim():
                from .vision import SimTargetSource
                return SimTargetSource()

            return self._optional(
                "vision.SimTargetSource", build_sim,
                degraded="perception disabled",
            )
        try:
            from .vision import Capture, PersonDetector
        except ImportError:
            # The optional [detect] extra is genuinely absent -- expected on a
            # dev box, and distinct from a construction BUG.
            log.warning(
                "vision backend unavailable (companion[detect] not installed); "
                "perception disabled"
            )
            return None
        try:
            capture = Capture(
                source=cfg.camera.source,
                device=cfg.camera.device,
                width=cfg.camera.width,
                height=cfg.camera.height,
                fps=cfg.camera.fps,
            )
            detector = PersonDetector(
                model_path=cfg.detector.model_path,
                engine_path=cfg.detector.engine_path,
                conf_threshold=cfg.detector.conf,
            )
        except TypeError:
            # A wiring bug, NOT missing hardware. Loud and distinguishable.
            log.exception(
                "camera+detector construction is MISWIRED (TypeError); this is a "
                "bug, not absent hardware -- perception disabled"
            )
            return None
        except Exception:
            log.exception("failed to build camera+detector; perception disabled")
            return None
        return _CameraSource(capture, detector)

    def _build_video(self) -> Optional[Any]:
        """The RTSP/WebRTC rail. Never gates flight, so it degrades quietly."""
        cfg = self.config

        def build():
            from .stream import StreamConfig, VideoStream
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

        return self._optional("stream.VideoStream", build, degraded="video disabled")

    # ======================================================================
    # Run / shutdown
    # ======================================================================
    async def run(self) -> None:
        """Bring the vehicle up in phases, then run until stopped.

        The phase order is the boot invariant: the aircraft is held before
        anything can command it, the control socket is up before the fence and
        failsafe parameters are pushed (so their outcome is reportable), and
        the loops start last -- nothing ticks against a half-built system.
        Every phase degrades rather than aborts: a companion that boots into a
        held state with no FC is still safer than one that does not boot.
        """
        self.setup()
        fc_connected = await self._connect_flight_controller()

        if self.api is not None:
            await self.api.start()

        # Site perimeter + NFZ exclusions -> FC polygon fences, then the
        # derived failsafe envelope. Both AFTER connect and both verified.
        if fc_connected:
            await self._apply_failsafe_params()
            await self._upload_site_fence()

        self._start_video()

        # Launch the task graph. The envelope monitor is its OWN task: it must
        # keep evaluating even if perception stalls or the control loop is
        # held, and it must not be schedulable by anything it watches. The four
        # names are spelled out here rather than built from a table because
        # test_envelope_wiring reads THIS source to prove the monitor got a
        # task of its own.
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

    async def _connect_flight_controller(self) -> bool:
        """Open the FC link. A failure is degraded operation, not a stop."""
        if self.vehicle is None:
            return False
        try:
            await _maybe_await(self.vehicle.connect())
        except Exception:
            log.exception("FC connect failed; continuing in degraded/SITL mode")
            return False
        log.info("connected to FC: %s", self.config.fc.connection)
        return True

    def _start_video(self) -> None:
        """Video is a convenience rail: it never gates flight."""
        if self.video is None:
            return
        try:
            self.video.start()
        except Exception:
            log.exception("video stream failed to start (non-fatal)")

    async def shutdown(self) -> None:
        """Stop all tasks, zero the setpoint, hold, and tear down components.

        Order is the whole point: the loops stop FIRST so nothing re-commands
        motion behind the hold, the hold goes out SECOND, and only then are
        the I/O rails closed. Every teardown step is independently guarded --
        a component that cannot close must not strand the ones after it.
        """
        log.info("companion shutting down -> safe state")
        await self._cancel_loops()

        # Default to the safe state: zero setpoint + hold.
        await self._send_hold("shutdown")

        if self.video is not None:
            _safe_call(getattr(self.video, "stop", None))
        for closer in (
            self.api.stop if self.api is not None else None,
            self.vehicle.close if self.vehicle is not None else None,
        ):
            if closer is None:
                continue
            try:
                await _maybe_await(closer())
            except Exception:
                pass

    async def _cancel_loops(self) -> None:
        """Cancel every loop task and wait for it to actually be gone."""
        tasks, self._tasks = self._tasks, []
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    def request_stop(self) -> None:
        self._stop.set()

    # ======================================================================
    # Task 1: telemetry pump @ 10 Hz
    # ======================================================================
    async def _drive(
        self,
        cadence: _Cadence,
        tick: Callable[[float], Awaitable[None]],
        on_failure: _TickFailure,
    ) -> None:
        """Run one loop at ``cadence`` until the stop event is set.

        The single driver behind all four tasks. It owns exactly three things:
        the stop condition, the per-tick delta, and the promise that a raising
        tick is contained -- it never escapes to cancel the task, and each loop
        supplies its own safe-state reaction through ``on_failure``.
        """
        while not self._stop.is_set():
            t0 = time.monotonic()
            dt = cadence.tick(t0)
            try:
                await tick(dt)
            except Exception as exc:
                await on_failure(exc)
            await self._sleep_remaining(t0, cadence.period)

    @staticmethod
    def _log_tick_failure(what: str) -> _TickFailure:
        """The default reaction: record it and take the next tick."""
        async def report(exc: BaseException) -> None:
            log.error("%s tick failed", what, exc_info=exc)
        return report

    async def _telemetry_loop(self) -> None:
        await self._drive(
            _Cadence("telemetry", TELEMETRY_HZ),
            lambda _dt: self._telemetry_tick(),
            self._log_tick_failure("telemetry"),
        )

    async def _telemetry_tick(self) -> None:
        """Read the FC, run the health ladder, stamp the frame, push it.

        The frame is assembled in stages so each stamp has one owner: the FC
        layer supplies what it can see, the site supplies home, and the
        orchestrator overwrites the fields it -- and only it -- is the
        authority for (the active control source above all).
        """
        await self._pump_fc_heartbeat()
        telem = await self._read_fc_telemetry()
        home_distance_m = self._stamp_home(telem)

        # The health ladder runs BEFORE the stamps that report its verdict.
        await self._health_tick(telem, home_distance_m=home_distance_m)

        self._stamp_identity(telem)
        self._stamp_health(telem)
        self._stamp_battery(telem)
        self._stamp_gimbal(telem)
        if self.api is not None:
            await self.api.push_telemetry(telem)

    async def _pump_fc_heartbeat(self) -> None:
        """The companion's own 1 Hz MAV_TYPE_GCS heartbeat -- SUPPRESSED on a
        tripped ground link.

        The companion IS the FC's GCS, so pumping this unconditionally kept
        FS_GCS_ENABLE's timer alive and made the ground outage invisible to
        the firmware: the documented "ArduPilot GCS failsafe -> RTL" backstop
        could never fire, because this process was suppressing its own trigger
        (FM-03).
        """
        vehicle = self.vehicle
        if vehicle is None or not hasattr(vehicle, "send_heartbeat"):
            return
        if self._link_lost_latched:
            return
        now = time.monotonic()
        if now - self._last_fc_heartbeat_sent_s < 1.0:
            return
        try:
            await _maybe_await(vehicle.send_heartbeat())
        except Exception:
            log.exception("companion MAVLink heartbeat failed")
            return
        self._last_fc_heartbeat_sent_s = now

    async def _read_fc_telemetry(self) -> Dict[str, Any]:
        """Refresh the cached VehicleState and return a telemetry frame.

        Each read is independently guarded: a Vehicle that can report state
        but not a full telemetry dict still gets a well-formed frame built
        from the state, rather than no frame at all.
        """
        vehicle = self.vehicle
        if vehicle is None:
            return _telemetry_from_state(self._vehicle_state)
        try:
            self._vehicle_state = await _maybe_await(vehicle.get_state())
        except Exception:
            pass
        try:
            telem = await _maybe_await(vehicle.get_telemetry())
        except Exception:
            telem = None
        return telem if telem is not None else _telemetry_from_state(self._vehicle_state)

    def _stamp_home(self, telem: Dict[str, Any]) -> float:
        """Overwrite ``home`` with the SITE home and return the distance to it.

        Returns ``inf`` when there is no site model, or when the position
        cannot be placed -- the health ladder reads that as "not near home",
        which is the conservative answer.
        """
        if self.site is None:
            return math.inf
        home_lat, home_lon = self.site.home.lat, self.site.home.lon
        distance = _great_circle_distance_m(
            self._vehicle_state.lat, self._vehicle_state.lon, home_lat, home_lon,
        )
        home = telem.setdefault("home", {})
        home["lat"] = home_lat
        home["lon"] = home_lon
        if math.isfinite(distance):
            home["distance"] = distance
        return distance

    def _stamp_identity(self, telem: Dict[str, Any]) -> None:
        """Who this frame is from, and who is flying.

        ``controlSource`` and ``vehicleId`` are ASSIGNED, not defaulted: the
        orchestrator is the single source of truth for both, and an FC layer
        that guessed at either must not win (PRD 11).
        """
        telem["controlSource"] = self._control_source
        telem["vehicleId"] = self.config.vehicle_id
        telem.setdefault("type", "telemetry")
        telem.setdefault("ts", _now_ms())

    def _stamp_health(self, telem: Dict[str, Any]) -> None:
        """Navigation source, GPS health digest, and the failsafe verdict."""
        telem["navSource"] = getattr(self._nav_snapshot, "source", "gps")
        gps = telem.get("gps") or {}
        telem["gpsHealth"] = {
            "fix": int(gps.get("fixType", 0)),
            "sats": int(gps.get("satellites", 0)),
            "hdop": float(gps.get("hdop", 99.0)),
        }
        decision = self._failsafe_decision
        telem["failsafeState"] = getattr(decision, "state", "none")
        telem["failsafeReason"] = getattr(decision, "reason", "")

    def _stamp_battery(self, telem: Dict[str, Any]) -> None:
        """The battery block plus the sortie budget.

        The compatibility aliases (voltage/current/remaining) are emitted
        alongside the canonical fields because the contract still declares
        both while existing panels migrate. ``sortie`` is None on the ground:
        a budget only means something once a sortie is under way.
        """
        bat = self._battery_snapshot
        if bat is None:
            return
        battery: Dict[str, Any] = {
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
        }
        if bat.fault:
            battery["fault"] = bat.fault
        telem["battery"] = battery
        telem["sortie"] = {
            "elapsed_s": bat.elapsed_sortie_s,
            "cap_s": bat.cap_s,
            "must_rtl_by_s": bat.must_rtl_by_s,
        } if self._vehicle_state.armed else None

    def _stamp_gimbal(self, telem: Dict[str, Any]) -> None:
        """Optional in the contract: an airframe with no commandable mount
        omits the field rather than reporting a fictional 0."""
        pitch = self._gimbal_pitch_for_telemetry()
        if pitch is not None:
            telem["gimbal"] = {"pitchDeg": round(float(pitch), 2)}

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
        # FC/MAVLink link health (FM-08). Nothing consumed the heartbeat age
        # before: `_connected` only recorded that a socket opened once, so a
        # dead link kept re-stamping cached messages with a fresh ts and the
        # degraded fallback even hardcoded latencyMs 0.0 -- a PERFECT link
        # readout while the link was dead.
        self._fc_link_lost = bool(raw.get("fc_link_lost", False))
        legacy_battery = telem.get("battery") or {}
        reported_soc = raw_battery.get("reported_soc_pct")
        if reported_soc is None:
            reported_soc = legacy_battery.get("remaining")
        voltage = float(raw_battery.get("voltage_v", legacy_battery.get("voltage", 0.0)))
        # None means "the FC reported current as not-measured" -- distinct from
        # a measured 0 A, which is what it used to collapse into (FM-19).
        raw_current = raw_battery.get(
            "current_a", legacy_battery.get("current", 0.0)
        )
        current: Optional[float] = (
            None if raw_current is None else float(raw_current)
        )
        battery_age_s = float(raw_battery.get("age_s", 0.0) or 0.0)

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
            battery_age_s = 0.0   # the scripted curve is generated, not cached

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
                age_s=battery_age_s,
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
                accepted = bool(await self._vehicle_call(
                    self.vehicle.set_ekf_source, requested
                ))
                changed = self.nav_health.confirm_source(requested, accepted)
                if changed:
                    await self._health_event("gps", "source_changed", requested)

        # A missing/stale WIND message yields None, which is NOT calm air: the
        # wind ladder used to be permanently dead outside the --wind injection
        # because an absent estimate degraded to 0.0 m/s (FM-20). Attended
        # flight continues (an operator is watching and the FC has its own
        # limits), but the fact is reported, and an UNATTENDED dispatch -- where
        # nobody can take over -- refuses on an unknown wind.
        raw_wind = raw.get("wind_mps", None) if raw else None
        if "wind_present" in raw:
            # The FC layer positively reported on the WIND rail, so we know
            # whether an estimate exists. A vehicle layer that says nothing
            # about wind leaves this None ("never sampled"), which is not the
            # same claim as "the FC is not streaming WIND".
            self._wind_known = bool(raw.get("wind_present"))
        wind = float(raw_wind) if raw_wind is not None else 0.0
        if self._faults["wind"]:
            wind = max(13.0, self._fault_values.get("wind", 13.0))
            self._wind_known = True
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

        # The clear-altitude latch must be SYMMETRIC with the trip. It used to
        # be gated on the INJECTED fault only, so a real LiDAR failure (which
        # sets _lidar_observation_valid False, not _faults["lidar"]) took the
        # else branch and reset the latch on every telemetry tick -- the hold
        # latched permanently and the vehicle climbed to clear altitude and
        # stayed there with no path back into the mission (FM-17).
        lidar_unhealthy = bool(
            self._faults["lidar"] or self._lidar_observation_valid is False
        )
        clear_alt = self._lidar_clear_altitude_m()
        if lidar_unhealthy and airborne and clear_alt is not None:
            if self._vehicle_state.relAlt >= clear_alt:
                self._lidar_clear_reached = True
        elif not lidar_unhealthy:
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
                self._faults["camera"]
                or self._camera_source_valid is False
                or self._camera_observation_valid is False
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
            # The FC link is a SEPARATE link from the ground datalink and has
            # its own row in the ladder now: with MAVLink dead the companion
            # cannot command anything, so it holds and SAYS SO rather than
            # serving cached telemetry as live (FM-08).
            fc_link_lost=bool(self._fc_link_lost),
        )
        if self.failsafe is not None:
            self._failsafe_decision = self.failsafe.evaluate(signals)

        # One healthEvent per FC-link transition (audited + replayed).
        fc_state = "lost" if self._fc_link_lost else "ok"
        if fc_state != self._fc_link_event:
            self._fc_link_event = fc_state
            age = float(raw.get("fc_heartbeat_age_s", math.inf) or math.inf)
            await self._health_event(
                "fc_link", fc_state,
                (
                    f"no flight-controller heartbeat for {age:.1f} s; telemetry "
                    "is last-known, not live"
                ) if self._fc_link_lost else "flight-controller link healthy",
            )

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
        if self._fc_link_lost:
            reasons.append("flight controller link lost")
        if self._fence_enforced is False:
            # A fence upload that was ATTEMPTED and failed is the only lateral
            # containment this vehicle has, gone. It gates arming instead of
            # producing a warning nobody consumes (FM-15).
            reasons.append(
                self._fence_detail or "geofence not enforced by the flight controller"
            )
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
        # What the DETECTION BACKEND can actually produce. The live detector is
        # person-only, so at a vehicle- or structure-truth staging point it
        # returns nothing and the scripted detection silently disappears --
        # installing the optional extra made the system detect LESS, with
        # nothing saying so. It is a capability now, not a surprise (FM-98).
        detector_caps = dict(self._detector_capabilities)
        if not detector_caps and self.staging_observer is not None:
            try:
                detector_caps = dict(self.staging_observer.capabilities())
                self._detector_capabilities = detector_caps
            except Exception:
                detector_caps = {}
        messages = [{
            "type": "capabilities",
            "ts": _now_ms(),
            "vehicleId": self.config.vehicle_id,
            "profiles": profiles,
            "sensors": ["rgb", "thermal", "lidar"],
            "detector": detector_caps,
            "night_capable": bool(
                self.sensor_suite is not None
                and not self._faults["thermal"]
                and self._thermal_observation_valid is not False
            ),
            "wind_estimate_available": (
                None if self._wind_known is None else bool(self._wind_known)
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
        # Per-rail health, naming the SPECIFIC bad fixture. The camera rail
        # reports the fixture verdict AND the live-source verdict separately:
        # they used to share one field, so a 'sim' source that cannot fail
        # overwrote the fixture verdict ~100 ms after boot and every operator
        # who connected later was told the fixtures were fine (FM-25).
        gaps = self._sensor_fixture_gaps or {}
        for component, healthy, rail in (
            ("camera", self._camera_fixture_valid, "rgb"),
            ("thermal", self._thermal_observation_valid, "thermal"),
            ("lidar", self._lidar_observation_valid, ""),
        ):
            bad = gaps.get(rail, ()) if rail else ()
            if healthy:
                detail = "scripted fixture validated"
            elif bad:
                detail = f"fixture missing or unreadable at: {', '.join(bad)}"
            else:
                detail = "health evidence unavailable"
            messages.append({
                "type": "healthEvent", "ts": _now_ms(),
                "vehicleId": self.config.vehicle_id, "component": component,
                "state": "ready" if healthy else "unavailable",
                "detail": detail,
            })
        if self._camera_source_valid is not None:
            messages.append({
                "type": "healthEvent", "ts": _now_ms(),
                "vehicleId": self.config.vehicle_id, "component": "camera",
                "state": "ready" if self._camera_source_valid else "failed",
                "detail": (
                    "live capture rail delivering frames"
                    if self._camera_source_valid
                    else "no observation: live capture rail is not delivering frames"
                ),
            })
        unsupported = list(detector_caps.get("unsupported_truths", ()) or ())
        if unsupported:
            messages.append({
                "type": "healthEvent", "ts": _now_ms(),
                "vehicleId": self.config.vehicle_id, "component": "camera",
                "state": "capability_gap",
                "detail": (
                    f"detection backend {detector_caps.get('backend', '?')} cannot "
                    f"produce truth(s): {', '.join(unsupported)}"
                ),
            })
        if self._fence_enforced is not None:
            messages.append({
                "type": "healthEvent", "ts": _now_ms(),
                "vehicleId": self.config.vehicle_id, "component": "geofence",
                "state": "enforced" if self._fence_enforced else "not_enforced",
                "detail": self._fence_detail or "",
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
        """Is the ground link lost RIGHT NOW, or has it been lost since?

        The source gate that used to live here is GONE. It duplicated
        ``SafetyManager.evaluate_link``'s own ``link_matters`` test, and
        because ``_on_deadman`` resets the source to 'auto' the duplicate
        short-circuited to False from the tick after the trip -- so the
        catalogue's ``hold`` for "vehicle datalink lost" never latched and the
        wire reported ``failsafeState: none`` throughout a real outage (FM-03).

        The LATCH is what survives the source reset. Arming still requires a
        link-mattering source (evaluate_link's job), so a companion nobody has
        ever connected to does not sit in a permanent hold.
        """
        if self._link_lost_latched:
            return True
        if self.safety is None:
            return False
        try:
            result = self.safety.evaluate_link(
                self._control_source, airborne=self._vehicle_state.airborne
            )
            return bool(result.tripped)
        except Exception:
            return True

    def _note_ground_heartbeat(self, ts_ms: float) -> None:
        """One authorized inbound frame: the ground link is alive again.

        Wired as the API server's heartbeat hook so the deadman latch and the
        SafetyManager's timestamp clear together -- clearing only one of them
        is how a latch becomes write-only.
        """
        if self.safety is not None:
            try:
                self.safety.note_ground_heartbeat(ts_ms)
            except Exception:
                log.exception("note_ground_heartbeat failed")
        if self._link_lost_latched:
            self._link_lost_latched = False
            self._link_lost_since_ms = 0.0
            self._deadman_rtl_attempt_ms = 0.0
            log.warning("ground link RESTORED; deadman latch cleared")

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
            # MUTUAL EXCLUSION, same as every other engage path. This branch
            # returns before _execute_plan, so it never reached that guard:
            # a planCommand arriving mid-manual set _planner_engaged while
            # _manual_engaged was still True and stamped controlSource
            # 'planner' -- the single-active-source invariant violated in
            # state, telemetry lying about who was flying, and on release the
            # aircraft flew a follow/orbit leg the operator never authorised
            # with the ground-link deadman silenced (FM-12).
            if self._manual_engaged:
                response["reason"] = "release manual control before a follow/orbit command"
                return response
            if self._estop_latched:
                response["reason"] = "emergency stop is latched"
                return response
            if not self._site_valid:
                response["reason"] = "site model invalid"
                return response
            if not self._vehicle_state.armed and not self._readiness_message()["ready"]:
                response["reason"] = "; ".join(self._readiness_message()["reasons"])
                return response
            track_id = args.get("track_id", args.get("trackId"))
            if not isinstance(track_id, int) or isinstance(track_id, bool):
                response["reason"] = f"{tool} requires integer track_id"
                return response
            minimum = {"follow": 8.0, "inspect": 5.0, "survey": 8.0}.get(profile, 8.0)
            try:
                requested = float(args.get("radius", args.get("standoff", minimum)))
            except (TypeError, ValueError):
                response["reason"] = f"{tool} radius must be a finite number"
                return response
            if not math.isfinite(requested):
                # inf is reachable from PLAIN JSON (1e400 parses to inf), and
                # max(floor, inf) is inf: the shared Limits object took an
                # unbounded standoff, guidance retreated at -max_speed
                # indefinitely, and the value leaked into the advertised
                # capabilities envelope (FM-11).
                response["reason"] = f"{tool} radius must be finite"
                return response
            # Clamped into the standoff BAND -- floor AND ceiling.
            applied = self.limits.clamp_standoff(max(minimum, requested))
            if self._operator_standoff_m is None:
                # Remember what the operator had, so releasing the plan gives
                # the shared envelope back instead of poisoning it for the rest
                # of the process (FM-11).
                self._operator_standoff_m = float(self.limits.standoff)
            if self.tracker is not None:
                self.tracker.select(track_id)
            self.limits.standoff = applied
            self._sync_safety_limits()
            self._tracking_engaged = False
            self._planner_engaged = True
            self._planner_tracking_tool = tool
            self._last_planner_heartbeat_ms = _now_ms()
            self._planner_resume_context = {"kind": "tracking", "tool": tool, "track_id": track_id}
            self._set_control_source(ControlSource.PLANNER.value)
            clamped = abs(applied - requested) > 1e-9
            response["status"] = "clamped" if clamped else "accepted"
            response["reason"] = (
                f"{tool} track {track_id} at {applied:.1f} m"
                + (f" (requested {requested:.1f} m, clamped)" if clamped else "")
            )
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
        await self._drive(
            _Cadence("perception", TRACKING_HZ),
            lambda _dt: self._perception_tick(),
            self._log_tick_failure("perception"),
        )

    async def _perception_tick(self) -> None:
        """One perception pass: gather observations, then publish tracking.

        Split into three collectors so the LIVE camera rail and the two
        plan-only staging rails cannot share a failure mode. Each collector
        owns its own health reporting and returns observations; none of them
        can take the tick down.
        """
        observations = await self._observe_live_camera()
        observations.extend(self._observe_staging_points())
        await self._observe_staged_sensors()
        await self._publish_tracking(observations)

    async def _observe_live_camera(self) -> List[TargetObservation]:
        """The live vision source, with the camera health rail it drives.

        A MISSING or FAILED frame is "no observation", NOT a healthy frame
        containing zero tracks. The two support opposite incident verdicts: a
        valid empty frame supports false_alarm, a dead camera must escalate.
        _CameraSource used to swallow a failed read and return [], which set
        the rail HEALTHY and could close an incident on evidence never
        captured (FM-100).
        """
        if self.source is None:
            return []
        try:
            observations = await _maybe_await(self.source.observe())
        except FrameUnavailable as exc:
            await self._camera_rail_failed(f"no observation: {exc}")
            return []
        except Exception:
            log.exception("vision source failed")
            await self._camera_rail_failed("no observation: vision source raised")
            return []
        # Only a returned frame -- empty or not -- restores the rail.
        if self._camera_source_valid is False:
            await self._health_event("camera", "ready", "camera frames flowing again")
        self._camera_source_valid = True
        return list(observations or [])

    async def _camera_rail_failed(self, detail: str) -> None:
        """Mark the live camera rail down, announcing the EDGE only once."""
        if self._camera_source_valid is not False:
            await self._health_event("camera", "failed", detail)
        self._camera_source_valid = False

    def _observe_staging_points(self) -> List[TargetObservation]:
        """Staging-point vision: ONLY while a mission plan is flying.

        The observer emits still-image detections when the vehicle arrives at
        a site staging point; they ride the normal tracker -> 'tracking' path.
        """
        if not (self._planner_engaged and self.staging_observer is not None):
            return []
        st = self._vehicle_state
        try:
            return list(self.staging_observer.observe(st.lat, st.lon, st.relAlt) or [])
        except Exception:
            log.exception("staging observer failed")
            return []

    async def _observe_staged_sensors(self) -> None:
        """The multi-sensor staged observation rail (plan-only, own wire type)."""
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
                    # NO PROXIMITY DATA IS PUBLISHED FROM A STAGED FRAME.
                    # The ranges are computed in a frame centred on the STAGING
                    # POINT, not on the vehicle, and publishing min(ranges) into
                    # all 72 OBSTACLE_DISTANCE sectors described a wall in every
                    # direction (measured 10.0 / 9.5 / 204.7 m). With avoidance
                    # enabled ArduPilot would refuse to move. Sending nothing is
                    # the honest answer for a rail that is not vehicle-relative
                    # (FM-118); a real vehicle-frame LiDAR would publish here.
                    if staged.lidar_ranges_m:
                        log.debug(
                            "staged LiDAR ranges are %s-frame, not vehicle-frame: "
                            "not published as proximity", staged.range_frame,
                        )
                    if self.api is not None and staged.valid:
                        await self.api.broadcast(
                            observation_message(staged, self.config.vehicle_id)
                        )
                        failed = [
                            rail for rail, state in staged.sensors.items()
                            if state == "failed"
                        ]
                        if failed:
                            # A partially-failed observation used to surface
                            # only as a buried field; the dead rail now raises
                            # its own audited event (FM-25).
                            await self._health_event(
                                "camera" if "rgb" in failed else failed[0],
                                "degraded",
                                f"staged observation at {staged.staging_id}: "
                                f"rail(s) failed: {', '.join(sorted(failed))}",
                            )
                    elif self.api is not None:
                        await self._health_event(
                            "camera", "failed", "no observation: all staged sensor frames invalid"
                        )
            except Exception:
                log.exception("staged multi-sensor observation failed")
                await self._health_event("camera", "failed", "no observation")

    @staticmethod
    def _person_observations(
        observations: List[TargetObservation],
    ) -> List[TargetObservation]:
        """ROUTE BY CLASS: only ``person`` boxes reach the person tracker.

        The person-following tracker and the 'tracking' wire message carry no
        class, so a vehicle or structure box spliced in from the staging rail
        was rendered by the UI as a locked PERSON target (FM-122). Non-person
        detections stay on the observation rail, which does carry a class.
        """
        kept = [
            obs for obs in observations
            if str(getattr(obs, "cls", "person")).strip().lower() == "person"
        ]
        dropped = len(observations) - len(kept)
        if dropped:
            log.debug(
                "%d non-person staging observation(s) kept off the person-tracking "
                "wire", dropped,
            )
        return kept

    async def _publish_tracking(self, observations: List[TargetObservation]) -> None:
        """Feed the tracker and broadcast the contract 'tracking' message."""
        if self.tracker is None:
            return
        result = self.tracker.update(
            self._person_observations(observations), ts=time.time()
        )
        self._latest_tracking = result
        if self.api is not None:
            await self.api.push_tracking(self._tracking_message(result))

    @staticmethod
    def _detected_target(track: Any) -> Dict[str, Any]:
        """One contract DetectedTarget: bbox normalised 0..1, [x, y, w, h]."""
        box = track.bbox
        return {
            "id": int(track.id),
            "bbox": [float(box[0]), float(box[1]), float(box[2]), float(box[3])],
            "confidence": float(track.confidence),
            "isLocked": bool(track.is_locked),
        }

    def _tracking_message(self, result: Any) -> Dict[str, Any]:
        """The contract 'tracking' frame.

        ``standoffDistance`` and ``maxSpeed`` are the LIVE limits, not the
        configured ones: the operator's ring is whatever the envelope says it
        is right now, and reporting the config value would let the UI draw a
        ring the aircraft is not actually holding. ``estimatedDistance`` stays
        None rather than 0 when there is no range -- "we do not know" and
        "you are on top of the subject" must never render the same.
        """
        distance = result.estimated_distance
        return {
            "type": "tracking",
            "ts": _now_ms(),
            "vehicleId": self.config.vehicle_id,
            "state": _wire_value(result.state),
            "targets": [self._detected_target(t) for t in result.targets],
            "lockedTargetId": result.locked_target_id,
            "standoffDistance": float(self.limits.standoff),
            "estimatedDistance": None if distance is None else float(distance),
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
        await self._drive(
            _Cadence("envelope", max(1.0, float(self.config.envelope.hz))),
            lambda _dt: self._envelope_tick(),
            self._envelope_tick_failed,
        )

    async def _envelope_tick_failed(self, exc: BaseException) -> None:
        """A monitor that cannot evaluate must not leave its last verdict up.

        Not knowing where the edges are is indistinguishable, from the
        aircraft's point of view, from being at one. So the failure path asks
        for the same thing a breach would: stop moving, and say so in the
        audited record.
        """
        log.error("envelope tick failed -> request hold", exc_info=exc)
        self._envelope_hold = True
        self._envelope_rtl = False
        self._envelope_speed_scale = 0.0
        await self._health_event(
            "envelope", "unavailable", "envelope monitor tick failed"
        )

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
    #: The arbitration ladder, in priority order. Each name is an async method
    #: taking ``dt`` and returning True when it has FULLY handled the tick --
    #: emitted whatever setpoint it wanted, or deliberately emitted nothing.
    #: The order is the safety argument, written down once:
    #:   e-stop      beats everything, including a hands-on operator;
    #:   deadman     beats the operator it can no longer hear;
    #:   manual      beats every automated hold below it;
    #:   failsafe    beats the takeoff window (FM-04) and all guidance;
    #:   takeoff     suppresses only the idle EMISSION, never the ladder;
    #:   override    is the SITL monitor-independence hook, below the monitor.
    #: Anything that clears the whole ladder reaches source arbitration.
    _ARBITRATION = (
        "_arb_emergency_stop",
        "_arb_ground_link",
        "_arb_manual",
        "_arb_failsafe",
        "_arb_takeoff_window",
        "_arb_test_override",
    )

    async def _control_loop(self) -> None:
        await self._drive(
            _Cadence("control", CONTROL_HZ),
            self._control_tick,
            self._control_tick_failed,
        )

    async def _control_tick_failed(self, exc: BaseException) -> None:
        """SAFE DEFAULT: any control-tick error -> hold."""
        log.error("control tick failed -> hold", exc_info=exc)
        await self._send_hold("control error")

    async def _control_tick(self, dt: float) -> None:
        """One 20 Hz pass: point the mount, walk the ladder, then arbitrate.

        The mount is pointed every tick, whatever the flight state: where the
        camera looks is never a control input, so it is decided up front and
        cannot feed back into guidance.
        """
        await self._gimbal_tick(dt)
        for stage in self._ARBITRATION:
            if await getattr(self, stage)(dt):
                return
        await self._fly_active_source(dt)

    # ---- arbitration ladder ----------------------------------------------
    async def _arb_emergency_stop(self, dt: float) -> bool:
        """While latched, never command motion.

        The latch clears only on the observed physical state (disarmed, on the
        ground), never inside the coroutine that set it (FM-24).
        """
        self._maybe_clear_estop()
        if not self._estop_latched:
            return False
        await self._send_hold("emergency stop latched")
        return True

    async def _arb_ground_link(self, dt: float) -> bool:
        """Ground-link deadman: the LATCH is checked beside the live evaluation.

        Once tripped the deadman keeps acting even though the release reset
        the control source to 'auto', which is precisely the state
        ``evaluate_link`` stops tripping on (FM-03).
        """
        if self.safety is None:
            return False
        link = self.safety.evaluate_link(
            self._control_source,
            airborne=self._vehicle_state.airborne,
        )
        if not (link.tripped or self._link_lost_latched):
            return False
        await self._on_deadman(link)
        return True

    async def _arb_manual(self, dt: float) -> bool:
        """A hands-on operator is authoritative once the link watchdog passes.

        Automated holds never overwrite fresh manual sticks.
        """
        if not self._manual_engaged:
            return False
        await self._send_setpoint(
            self._clamp_setpoint(await self._manual_setpoint(dt))
        )
        return True

    async def _arb_failsafe(self, dt: float) -> bool:
        """The failsafe ladder, evaluated BEFORE the takeoff window.

        The takeoff early-return used to sit above this block, so every
        takeoff suspended the entire ladder for up to 60 s -- battery/sortie/
        wind RTL, GPS-denied hold, hostile-drone hold, LiDAR climb and
        site-invalid refuse were all inert during the climb, and the window is
        longest exactly when a climb is failing (FM-04).
        """
        decision = self._failsafe_decision
        failure = getattr(decision, "state", "none")
        reason = getattr(decision, "reason", "")
        if failure == "rtl":
            await self._failsafe_return(reason)
            return True
        # Anything below is not an RTL, so a previously requested one is over.
        self._rtl_requested_reason = ""
        if self._is_holding_failure(failure, reason):
            await self._failsafe_hold(failure, reason)
            return True
        self._last_applied_failsafe = "none"
        return False

    @staticmethod
    def _is_holding_failure(failure: str, reason: str) -> bool:
        """Failsafe states that stop the aircraft where it is.

        ``escalate`` normally takes no control action -- it is a report. The
        one exception is probable RF interference, which is a reason to stop
        moving even before it becomes a hold.
        """
        if failure in ("hold", "refuse"):
            return True
        return failure == "escalate" and reason == "probable interference"

    async def _failsafe_return(self, reason: str) -> None:
        """Failsafe RTL: announce once, then re-assert until the FC obeys."""
        # Any failsafe RTL abandons the climb: the NAV_TAKEOFF target is what
        # we are getting away from.
        self._takeoff_deadline_ms = 0.0
        if self._rtl_requested_reason != reason:
            self._rtl_requested_reason = reason
            self._rtl_last_attempt_ms = 0.0
            self._release_all(ControlSource.AUTO.value)
            await self._status("critical", reason)
            await self._health_event("link", "rtl", reason)
        # Re-assert until the FC is OBSERVED in RTL. The latch used to be
        # stamped BEFORE the call, so a refused or dropped RTL was never
        # retried: the vehicle hovered in GUIDED while telemetry reported
        # failsafeState=rtl (FM-01).
        confirmed = await self._assert_rtl(f"failsafe {reason}")
        self._last_applied_failsafe = (
            f"rtl:{reason}" if confirmed else f"rtl-pending:{reason}"
        )
        await self._send_hold(reason)

    async def _failsafe_hold(self, failure: str, reason: str) -> None:
        """Stop where we are -- or climb, when the reason is a blind LiDAR."""
        self._takeoff_deadline_ms = 0.0
        self._last_applied_failsafe = f"{failure}:{reason}"
        climb = self._lidar_recovery_climb(reason)
        if climb is None:
            await self._send_hold(reason)
        else:
            await self._send_setpoint(self._clamp_setpoint(climb))

    def _lidar_recovery_climb(self, reason: str) -> Optional[VelocitySetpoint]:
        """The gentle climb a failed LiDAR asks for, or ``None`` to hold.

        Only offered when there IS a surveyed clear altitude above us and the
        guidance preconditions hold; every other case holds instead.
        """
        if "LiDAR failed" not in reason:
            return None
        clear_alt = self._lidar_clear_altitude_m()
        if clear_alt is None or self._vehicle_state.relAlt >= clear_alt:
            return None
        if not self._guidance_preconditions_ok():
            return None
        return VelocitySetpoint(vz=-min(self.limits.max_climb_rate, 1.0), valid=True)

    async def _arb_takeoff_window(self, dt: float) -> bool:
        """NAV_TAKEOFF owns the GUIDED target until the climb completes.

        Sending the ordinary zero-velocity idle frame would overwrite it, so
        the window suppresses the EMISSION only -- after the ladder above has
        already had its say.
        """
        if not self._takeoff_deadline_ms:
            return False
        st = self._vehicle_state
        climbing = (
            st.armed
            and _now_ms() < self._takeoff_deadline_ms
            and st.relAlt < 0.9 * self._takeoff_target_alt
        )
        if climbing:
            return True
        self._takeoff_deadline_ms = 0.0
        return False

    async def _arb_test_override(self, dt: float) -> bool:
        """SITL-only, triple-gated: fly straight out of the certified corridor.

        It sits BELOW the failsafe branches precisely so the monitor's
        hold/RTL wins over it -- that suppression IS the proof that the
        monitor is independent of guidance.
        """
        if not self._guidance_override_active():
            return False
        await self._send_setpoint(self._clamp_setpoint(
            VelocitySetpoint(vx=self.limits.max_speed, valid=True)
        ))
        return True

    # ---- source arbitration ----------------------------------------------
    async def _fly_active_source(self, dt: float) -> None:
        """Pick the ONE active control source and emit its clamped setpoint.

        Exactly one branch produces the setpoint (PRD 11). ``None`` from the
        planner means that tick emitted a different flavour itself -- a global
        position target, an RTL handoff, or plan completion -- and a
        body-velocity frame on top of it would override the position target.
        """
        setpoint = await self._active_setpoint(dt)
        if setpoint is None:
            return
        await self._send_setpoint(self._clamp_setpoint(setpoint))

    async def _active_setpoint(self, dt: float) -> Optional[VelocitySetpoint]:
        if not self._guidance_preconditions_ok():
            return VelocitySetpoint.hold()
        if self._planner_engaged:
            # A plan flying a tracking tool (follow/orbit-on-track) is still
            # visually servoed: the planner chose the subject, guidance flies
            # to it, and the standoff floor applies exactly as it does under
            # operator tracking.
            if self._planner_tracking_tool:
                return self._guidance_setpoint(dt)
            return await self._planner_tick(dt)
        if self._tracking_engaged:
            return self._guidance_setpoint(dt)
        return VelocitySetpoint.hold()

    def _lidar_clear_altitude_m(self) -> Optional[float]:
        """The altitude the LiDAR-degraded climb may target, or ``None``.

        It is the site's ``clear_altitude_m`` INTERSECTED with
        ``limits.max_altitude``. The site file validates clear_altitude_m only
        against its own alt_band, and the climb was a raw body-velocity command
        -- a path with no altitude term anywhere (``_clamp_setpoint`` bounds the
        RATE, ``send_body_velocity`` explicitly bounds nothing). With the
        shipped default.yaml ceiling of 30 m and the stub site's 45 m clear
        altitude, that commanded a sustained climb straight through the FC's
        own FENCE_ALT_MAX and out of GUIDED mid-failsafe (FM-17).

        ``None`` means "no clear altitude to climb to" -- hold instead.
        """
        ceiling = float(self.limits.max_altitude)
        if self.site is None:
            # No site model: there is no surveyed obstacle-clear altitude, so
            # there is nothing to climb TO. Hold rather than invent one.
            return None
        try:
            declared = float(self.site.clear_altitude_m)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(declared) or declared <= 0.0:
            return None
        target = min(declared, ceiling)
        if declared > ceiling:
            log.warning(
                "site clear_altitude_m %.1f m exceeds limits.max_altitude "
                "%.1f m; climbing only to the altitude limit",
                declared, ceiling,
            )
        return target

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
        """Visual servoing toward the locked track.

        The STANDOFF is not applied here and never has been: it is a hard
        limit inside ``control/guidance.py``, which is handed the live
        ``Limits`` and is the only component allowed to decide how close the
        aircraft gets. The orchestrator passes inputs and takes a setpoint.
        """
        tracking = self._latest_tracking
        if self.guidance is None or tracking is None:
            return VelocitySetpoint.hold()
        return self.guidance.update(
            tracking.state,
            tracking.locked_bbox,
            tracking.estimated_distance,
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
            # No executor at all: there was never a corridor to give back, so
            # the monitor's arming is left exactly as it was.
            return self._end_plan("no planner", disarm=False)
        try:
            out = self.planner.update(self._vehicle_state, dt)
        except Exception:
            log.exception("planner update failed -> hold")
            return VelocitySetpoint.hold()

        kind = _wire_value(out.kind)
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
                # Verified + retried, like every other RTL on the failsafe path.
                await self._assert_rtl("plan rtl")
            await self._send_hold("plan rtl")
            return None
        if kind == "done":
            self._end_plan("complete")
            await self._status("info", "mission plan complete -> hold")
            await self._send_hold("plan complete")
            return None
        # idle / unexpected while engaged: release and hold (safe default).
        return self._end_plan(f"unexpected planner output {kind!r}")

    def _end_plan(self, why: str, *, disarm: bool = True) -> VelocitySetpoint:
        """Disengage the plan, drop its corridor, and hand back a hold.

        The corridor goes with the plan (``_disarm_envelope``); the site
        containment the monitor also enforces does not, because it applies
        whether or not a plan is loaded.
        """
        log.debug("mission plan disengaged: %s", why)
        self._planner_engaged = False
        if disarm:
            self._disarm_envelope()
        self._set_control_source(ControlSource.AUTO.value)
        return VelocitySetpoint.hold()

    #: How long a latched goto target may stand before it is re-sent, seconds.
    #: ArduPilot LATCHES a position target, so re-sending at 20 Hz would only
    #: spam DO_CHANGE_SPEED; re-sending never would leave a dropped target
    #: silently unflown.
    _GOTO_REFRESH_S = 1.0

    async def _stream_goto(self, goto: Any) -> None:
        """Send/refresh the GUIDED global position target for a goto leg.

        While a goto is active the control tick deliberately does NOT emit the
        body-velocity hold -- a zero-velocity frame would override the
        position target the FC is holding.
        """
        if self.vehicle is None:
            return
        # Rounded so floating-point noise in an unchanged target does not read
        # as a new one every tick.
        target = (
            round(float(goto.lat), 7), round(float(goto.lon), 7),
            round(float(goto.alt), 2), round(float(goto.speed), 2),
        )
        now = time.monotonic()
        unchanged = target == self._last_goto
        if unchanged and (now - self._last_goto_ts) < self._GOTO_REFRESH_S:
            return
        self._last_goto = target
        self._last_goto_ts = now
        try:
            accepted = await _maybe_await(self.vehicle.goto_global(
                goto.lat, goto.lon, goto.alt, goto.speed,
            ))
        except Exception:
            log.exception("goto_global failed")
            await self._send_hold("goto failed")
            return
        if not accepted:
            # Refused (e.g. zero-speed leg / bad target): emit the canonical
            # zero-and-hold so any PREVIOUSLY latched position target in the
            # FC cannot keep the vehicle moving.
            log.warning("goto_global refused target %s -> hold", target)
            await self._send_hold("goto refused")

    async def _manual_setpoint(self, dt: float) -> VelocitySetpoint:
        """Manual setpoint via ManualPilot, gated by the input watchdog.

        If no manualInput frame has arrived within ``manual_watchdog_ms``, zero
        the setpoint and hold -- never continue the last commanded velocity.
        """
        if self._manual_input_stale():
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

    def _manual_input_stale(self) -> bool:
        """True when no stick frame has landed inside ``manual_watchdog_ms``.

        Never having received one counts as stale: the watchdog opens CLOSED,
        so engaging manual and then losing the stream before the first frame
        holds rather than waiting indefinitely for a timeout that never starts.
        """
        stamp = self._last_manual_input_ms
        if not stamp:
            return True
        return (_now_ms() - stamp) > float(self.limits.manual_watchdog_ms)

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
        axes = (sp.vx, sp.vy, sp.vz, sp.yaw_rate)
        # A non-finite axis collapses the WHOLE setpoint to hold. Clamping it
        # per-axis is not enough: a component that produced one unusable number
        # produced an unusable command, and the belt-and-braces clamp must not
        # be the thing that renders it as maximum output (FM-06). This mirrors
        # planner_exec._clamp_setpoint, which had the guard all along on a path
        # neither manual nor tracking ever takes.
        if not all(math.isfinite(axis) for axis in axes):
            log.error("non-finite setpoint (%r, %r, %r, %r) -> HOLD", *axes)
            return VelocitySetpoint.hold()
        speed_cap, climb_cap, yaw_cap = self._axis_caps()
        return VelocitySetpoint(
            vx=_clamp(sp.vx, -speed_cap, speed_cap),
            vy=_clamp(sp.vy, -speed_cap, speed_cap),
            vz=_clamp(sp.vz, -climb_cap, climb_cap),
            yaw_rate=_clamp(sp.yaw_rate, -yaw_cap, yaw_cap),
            valid=True,
        )

    def _axis_caps(self) -> Tuple[float, float, float]:
        """(translational, vertical, yaw) magnitude caps for this tick.

        The envelope monitor's ``speed_scale`` is folded in here and nowhere
        else. It is bounded to [0, 1] on the way in, so a monitor bug can only
        ever make the aircraft slower than ``Limits`` allows, never faster --
        the scale cannot become an amplifier.
        """
        limits = self.limits
        scale = min(1.0, max(0.0, float(self._envelope_speed_scale)))
        return (
            float(limits.max_speed) * scale,
            float(limits.max_climb_rate) * scale,
            float(limits.max_yaw_rate),
        )

    async def _send_setpoint(self, sp: VelocitySetpoint) -> None:
        """Hand one body-velocity frame to the FC.

        ``valid`` is passed when the Vehicle layer accepts it and dropped when
        it does not: an older signature must degrade to sending the axes, not
        to sending nothing at all.
        """
        if self.vehicle is None:
            return
        axes = (sp.vx, sp.vy, sp.vz, sp.yaw_rate)
        try:
            await _maybe_await(
                self.vehicle.send_body_velocity(*axes, valid=sp.valid)
            )
            return
        except TypeError:
            pass  # no 'valid' kwarg on this Vehicle: retry without it
        except Exception:
            log.exception("send_body_velocity failed")
            return
        try:
            await _maybe_await(self.vehicle.send_body_velocity(*axes))
        except Exception:
            log.exception("send_body_velocity failed")

    async def _send_hold(self, reason: str = "") -> None:
        """Emit the canonical safe setpoint: all-zero, valid=False (hold)."""
        await self._send_setpoint(VelocitySetpoint.hold())

    async def _on_deadman(self, link: Any) -> None:
        """Ground-link deadman: hold, release, escalate, and KEEP escalating.

        Runs EVERY tick while the latch is set, not once. The original was a
        one-shot: it fired a single unverified ``set_mode("RTL")``, reset the
        control source, and thereby silenced its own trigger, so a refused or
        dropped RTL left an airborne vehicle hovering on a dead link with no
        further attempt, no failsafe state, and no audit record (FM-03).

        Four things changed:
          * the latch is set FIRST, so the failsafe signal survives the
            source reset and telemetry reports ``hold`` for the whole outage;
          * the release goes through ``_release_all`` -- the hand-rolled
            version skipped ``guidance.reset()``/``manual.reset()`` and left
            wound-up PID state to be inherited by the next engage;
          * RTL is RE-ASSERTED (throttled) until the FC is observed in RTL,
            because ``set_mode`` can be refused and now says so;
          * the escalation is a ``healthEvent`` -- audited and replayed on
            reconnect -- not only a ``statusText`` broadcast to the zero
            clients a link outage guarantees.
        """
        # ZERO FIRST. Whatever else this tick decides, the aircraft stops
        # being commanded before any of it is worked out.
        first_trip = self._latch_link_lost()
        await self._send_hold("deadman")

        reason = getattr(link, "reason", "") or "ground link lost -> hold/RTL"
        if first_trip:
            await self._announce_deadman(reason)

        # A tripped deadman means the operator is gone: releasing to auto is
        # correct, and the LATCH (not the source) is what keeps the deadman
        # awake afterwards.
        self._release_all(ControlSource.AUTO.value)
        self._takeoff_deadline_ms = 0.0

        action = getattr(link.action, "value", str(link.action))
        if self.vehicle is None:
            return
        if action == "rtl" or bool(self._vehicle_state.airborne):
            await self._assert_rtl("deadman")

    def _latch_link_lost(self) -> bool:
        """Set the ground-link latch; True when this is the first trip.

        The latch is orchestrator state rather than SafetyManager state
        precisely so it SURVIVES the release to 'auto' -- the source
        ``evaluate_link`` stops tripping on (FM-03).
        """
        if self._link_lost_latched:
            return False
        self._link_lost_latched = True
        self._link_lost_since_ms = _now_ms()
        return True

    async def _announce_deadman(self, reason: str) -> None:
        """Say it once, on both rails.

        The healthEvent, not the statusText, is the load-bearing half: this is
        the one message that MUST survive an outage whose defining property is
        that nobody is listening. It is hash-chained into the audit and
        replayed to the next client that connects.
        """
        await self._status("critical", reason)
        await self._health_event("link", "deadman", reason)

    def _observed_mode(self) -> str:
        return str(getattr(self._vehicle_state, "mode", "")).upper()

    async def _assert_rtl(self, why: str, *, throttle_ms: float = 1000.0) -> bool:
        """Command RTL and keep commanding it until the FC is OBSERVED in RTL.

        Returns True only once the mode READBACK confirms RTL. A ``set_mode``
        that returns False (ArduCopter refuses RTL without a home position,
        for one) or raises does not count as done: the caller must not latch
        anything on an unverified mode change (FM-01 / FM-02). Retries are
        throttled so a refusing FC is asked once a second, not 20 times.
        """
        if self._observed_mode() == "RTL":
            return True
        if self.vehicle is None or self._rtl_attempt_throttled(throttle_ms):
            return False
        try:
            accepted = await self._vehicle_call(self.vehicle.set_mode, "RTL")
        except Exception:
            log.exception("%s RTL command failed", why)
            return False
        if accepted is False:
            log.error("%s RTL REFUSED by the flight controller; will retry", why)
            await self._health_event(
                "link", "rtl_refused",
                f"{why}: flight controller refused RTL; retrying",
            )
            return False
        return True

    def _rtl_attempt_throttled(self, throttle_ms: float) -> bool:
        """True to skip this attempt; otherwise stamp it and let it through."""
        now = _now_ms()
        if self._rtl_last_attempt_ms and now - self._rtl_last_attempt_ms < throttle_ms:
            return True
        self._rtl_last_attempt_ms = now
        return False

    async def _apply_failsafe_params(self) -> None:
        """Push the derived envelope to the FC so the clamp has a firmware half.

        ``failsafe_param_map`` existed, was exported, was tabled in the docs --
        and had no runtime caller at all, so FENCE_ALT_MAX / FENCE_RADIUS /
        RTL_ALT / BATT_FS_* / FS_GCS_* were whatever the ``.parm`` or the
        firmware default happened to be. Several rows of the response contract
        name "ArduPilot firmware" as the authority for a behaviour nothing
        armed (FM-16).
        """
        if self.vehicle is None or not hasattr(self.vehicle, "apply_failsafe_params"):
            return
        try:
            applied, attempted, failures = await self._vehicle_call(
                self.vehicle.apply_failsafe_params,
                cell_count=int(self.config.battery.cell_count),
                # The FC's circular fence must contain the SITE, not the launch
                # pad: a stock 60 m circle around home fences a plant-scale
                # perimeter into its own pad, so the first outbound leg
                # breaches and the firmware RTLs mid-mission (FM-155).
                geofence_radius_m=self._site_containment_radius_m(),
            )
        except Exception:
            log.exception("failsafe param application raised")
            await self._health_event(
                "fc_link", "params_failed",
                "could not push the derived failsafe parameters to the FC",
            )
            return
        if failures:
            detail = (
                f"{applied}/{attempted} failsafe params applied; unconfirmed: "
                f"{', '.join(failures)}"
            )
            await self._status("warning", detail)
            await self._health_event("fc_link", "params_partial", detail)
        else:
            await self._health_event(
                "fc_link", "params_applied",
                f"all {attempted} derived failsafe params verified on the FC",
            )

    def _site_containment_radius_m(self) -> Optional[float]:
        """Home -> farthest perimeter vertex, plus a margin. ``None`` if unknown.

        This is what the FC's CIRCULAR fence must be set to for the polygon it
        also holds to be reachable. The polygon (FENCE_TYPE bit2) is the real
        containment; the circle is the fallback that applies when the polygon
        upload has not (yet) succeeded, and it must not be tighter than the
        site the vehicle was dispatched to fly.
        """
        if self.site is None or not getattr(self.site, "perimeter", None):
            return None
        home = (self.site.home.lat, self.site.home.lon)
        distances = [
            _great_circle_distance_m(home[0], home[1], float(v[0]), float(v[1]))
            for v in self.site.perimeter
        ]
        finite = [d for d in distances if math.isfinite(d)]
        if not finite:
            return None
        return max(finite) * 1.1        # 10 % margin on the farthest vertex

    def _nfz_exclusion_polygons(self) -> List[List[Tuple[float, float]]]:
        """The site's NFZs as plain polygons for the FC exclusion fence."""
        if self.site is None:
            return []
        polygons: List[List[Tuple[float, float]]] = []
        for zone in getattr(self.site, "nfz", ()) or ():
            polygon = [tuple(v) for v in getattr(zone, "polygon", ()) or ()]
            if len(polygon) >= 3:
                polygons.append(polygon)
        return polygons

    async def _upload_site_fence(self) -> None:
        """Upload the site geofence AND the NFZ exclusion zones, then VERIFY.

        The perimeter is the site's outer inclusion fence
        (docs/SITE_CONTRACT.md); each NFZ goes up as its own EXCLUSION polygon,
        because an NFZ breach INSIDE the perimeter used to trigger nothing on
        the vehicle or in the firmware -- NFZs were enforced only by the ground
        verifier, so any plan that reached the companion another way was
        uncontained (FM-13).

        The result is RECORDED, not discarded. "Stored" is not "enforced":
        FENCE_ENABLE is verified by value readback, and a stored-but-disabled
        fence gates arming and dispatch instead of producing a green
        statusText that says the opposite of the truth (FM-14 / FM-15).
        """
        if self.vehicle is None:
            return
        if self.site is None or not getattr(self.site, "geofence", None):
            self._fence_enforced = False
            self._fence_detail = "no site model; no polygon geofence uploaded"
            await self._status("warning", self._fence_detail)
            await self._health_event("geofence", "unavailable", self._fence_detail)
            return
        exclusions = self._nfz_exclusion_polygons()
        try:
            await self._vehicle_call(
                self.vehicle.upload_geofence,
                self.site.geofence,
                exclusions=exclusions,
            )
        except TypeError:
            # A Vehicle without exclusion support still gets the perimeter.
            try:
                await self._vehicle_call(
                    self.vehicle.upload_geofence, self.site.geofence
                )
            except Exception:
                log.exception("geofence upload raised")
        except Exception:
            log.exception("geofence upload raised")

        status = {}
        if hasattr(self.vehicle, "fence_status"):
            try:
                status = dict(await _maybe_await(self.vehicle.fence_status()) or {})
            except Exception:
                log.exception("fence_status failed")
        enforced = status.get("enforced")
        detail = str(status.get("detail", "") or "")
        if not status:
            # A Vehicle that cannot report fence state tells us nothing; we
            # record "unknown", never "enforced".
            self._fence_enforced = None
            self._fence_detail = "fence state not reported by this FC layer"
            return
        self._fence_enforced = bool(enforced)
        self._fence_detail = detail
        if enforced:
            await self._status(
                "info",
                f"site geofence ENFORCED ({len(self.site.geofence)} vertices, "
                f"{len(exclusions)} NFZ exclusion zone(s))",
            )
            await self._health_event("geofence", "enforced", detail)
        else:
            await self._status(
                "critical",
                f"geofence NOT enforced: {detail}. Arming and dispatch are refused.",
            )
            await self._health_event("geofence", "not_enforced", detail)

    # ======================================================================
    # Task 4: command dispatch (event-driven via the API handler)
    # ======================================================================
    async def _handle_command(self, msg: Dict[str, Any]) -> Dict[str, Any]:
        """Route one inbound command to its action and return a CommandAck dict.

        Runs inside the API server's receive loop. Never raises (the API server
        also guards, but we keep our own try so the ack message is meaningful)."""
        command = str(msg.get("command", ""))
        refusal = await self._verify_command(msg, command)
        if refusal is not None:
            return refusal
        try:
            ok, message = await self._dispatch(command, msg.get("params") or {})
        except Exception as exc:
            log.exception("command %r failed", command)
            ok, message = False, f"{command} failed: {exc}"
        return self._ack(command, ok, message)

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

    def _authorize_frame(self, msg: Dict[str, Any]) -> str:
        """Gate EVERY inbound wire frame, not just ``command`` envelopes.

        ``manualInput``, ``planCommand``, ``planHeartbeat``, ``rfEvent`` and
        ``fleet`` all move the aircraft or feed a watchdog, and none of them
        passed through the signing layer -- so any host that could reach the
        socket could fly the vehicle AND hold the ground-link deadman open,
        masking a real operator outage (FM-40).

        Loopback + unsigned stays the default developer/demo posture; the
        moment the socket is bound wider, ``config._enforce_bind_policy``
        turns ``require_signed_commands`` on and this refuses everything
        unsigned.
        """
        verifier = self.verifier
        if verifier is None:
            return ""
        try:
            result = verifier.verify_frame(msg)
        except Exception:
            log.exception("frame verification raised")
            return "frame refused: verification failed"
        if result.ok:
            return ""
        return f"{msg.get('type', 'frame')} refused: {result.reason}"

    def _ack(self, command: str, ok: bool, message: str) -> Dict[str, Any]:
        """The one CommandAck builder. Acks correlate by command NAME, FIFO --
        the contract puts no requestId on the ack path."""
        return {
            "type": "ack",
            "ts": _now_ms(),
            "vehicleId": self.config.vehicle_id,
            "command": command,
            "success": bool(ok),
            "message": message,
        }

    #: Commands that RELEASE authority or move the vehicle toward safety. They
    #: stay available during a failsafe: refusing the operator's least
    #: disruptive stop while the plan keeps commanding motion is worse than the
    #: failsafe itself (FM-18). ``abortPlan`` and ``disengageTracking`` are
    #: release-to-safe and belong here as much as ``rtl``/``land`` do.
    _FAILSAFE_SAFE_COMMANDS = frozenset({
        "rtl", "land", "disarm",
        "engageManual", "disengageManual",
        "abortPlan", "disengageTracking",
    })

    #: Modes an operator may still select during a failsafe. All of them park
    #: or recover the aircraft; GUIDED/AUTO (resuming autonomous work) do not.
    _FAILSAFE_SAFE_MODES = frozenset({"RTL", "LAND", "BRAKE", "LOITER", "ALT_HOLD"})

    #: Commands accepted while the emergency-stop latch is set. Everything else
    #: is refused until the aircraft is disarmed on the ground -- the latch used
    #: to clear itself inside the same coroutine, so commanding resumed on the
    #: very next tick (FM-24).
    _ESTOP_ALLOWED = frozenset({"emergencyStop", "disarm", "land", "rtl"})

    #: The command surface, as data. Every CommandName in shared.py appears
    #: here exactly once, mapped to the method that performs it. ``emergencyStop``
    #: is deliberately absent: it precedes the e-stop latch gate itself and is
    #: handled before the table is consulted.
    #:
    #: ``exempt`` marks the commands that bypass the failsafe gate -- signed
    #: attendance transitions, camera pointing, the SITL fault hooks and the
    #: operator's own "carry on". Everything else, INCLUDING an unrecognised
    #: name, is gated: an unknown command during a failsafe is answered with
    #: the failsafe, not with a lecture about the name.
    _COMMANDS: Dict[str, Tuple[str, bool, bool]] = {
        # name:            (method,               takes params, exempt)
        "continueMission": ("_continue_mission",  False, True),
        "testFault":       ("_test_fault",        True,  True),
        "enterUnattended": ("_enter_unattended",  True,  True),
        "exitUnattended":  ("_exit_unattended",   True,  True),
        "setGimbal":       ("_set_gimbal",        True,  True),

        "arm":             ("_do_arm",            False, False),
        "disarm":          ("_cmd_disarm",        False, False),
        "takeoff":         ("_cmd_takeoff",       True,  False),
        "land":            ("_cmd_land",          False, False),
        "rtl":             ("_cmd_rtl",           False, False),
        "setMode":         ("_cmd_set_mode",      True,  False),

        "engageTracking":    ("_engage_tracking",    False, False),
        "disengageTracking": ("_disengage_tracking", False, False),
        "selectTarget":      ("_cmd_select_target",  True,  False),
        "setStandoff":       ("_cmd_set_standoff",   True,  False),
        "setMaxSpeed":       ("_cmd_set_max_speed",  True,  False),

        "engageManual":    ("_engage_manual",     False, False),
        "disengageManual": ("_disengage_manual",  False, False),

        "executePlan":     ("_execute_plan",      True,  False),
        "abortPlan":       ("_abort_plan",        False, False),
    }

    async def _dispatch(self, command: str, params: Dict[str, Any]):
        """Route one verified command through the gates, then the table."""
        # emergencyStop overrides EVERYTHING and takes no confirmation. It is
        # above the latch gate because it is what SETS the latch.
        if command == "emergencyStop":
            return await self._emergency_stop()

        spec = self._COMMANDS.get(command)
        for gate in (self._gate_estop, self._gate_failsafe):
            refusal = gate(command, params, spec)
            if refusal is not None:
                return refusal
        if spec is None:
            return False, f"unknown command {command!r}"

        method, wants_params, _exempt = spec
        action = getattr(self, method)
        return await _maybe_await(action(params) if wants_params else action())

    # ---- dispatch gates ---------------------------------------------------
    def _gate_estop(self, command, params, spec):
        """Nothing re-commands motion until the e-stop latch clears.

        The latch used to clear itself inside the same coroutine that set it,
        so setMode GUIDED / takeoff / engageTracking / executePlan were
        accepted on the very next tick and cancelled the FC LAND (FM-24).
        """
        if not self._estop_latched or command in self._ESTOP_ALLOWED:
            return None
        return False, (
            "emergency stop is latched: only disarm/land/rtl are accepted "
            "until the vehicle is disarmed on the ground"
        )

    def _gate_failsafe(self, command, params, spec):
        """Refuse NEW autonomous work while a failsafe is in force.

        Recovery, operator takeover and explicit return commands stay
        available: refusing the operator's least disruptive stop while the
        plan keeps commanding motion is worse than the failsafe itself
        (FM-18). Privileged transitions carry their own ``exempt`` flag --
        pointing the camera and returning to supervision are both things an
        operator may need while the vehicle is held.
        """
        if spec is not None and spec[2]:
            return None
        decision = self._failsafe_decision
        if decision is None or getattr(decision, "state", "none") == "none":
            return None
        if command in self._FAILSAFE_SAFE_COMMANDS:
            return None
        # setMode is admitted for RECOVERY modes only: a plain `escalate`
        # (camera failed, thermal degraded, soc_degraded) takes no control
        # action, so the plan keeps flying while the operator's graceful
        # stops were being refused -- and a soc_degraded escalate could hold
        # that lockout for the rest of the sortie (FM-18).
        if command == "setMode" and str(
            (params or {}).get("mode", "")
        ).upper() in self._FAILSAFE_SAFE_MODES:
            return None
        return False, f"command rejected during {decision.state}: {decision.reason}"

    # ---- flight commands (-> Vehicle) ------------------------------------
    async def _cmd_disarm(self):
        self._release_all(ControlSource.AUTO.value)
        await self._send_hold("disarm")
        return await self._vehicle_action("disarm", self.vehicle.disarm
                                          if self.vehicle is not None else None)

    async def _cmd_takeoff(self, params: Dict[str, Any]):
        """Climb to a requested altitude, capped by the geofence ceiling.

        The takeoff WINDOW is armed only on an accepted command: arming it on
        a refusal would suppress setpoint emission for 60 s over a climb that
        never began.
        """
        altitude = min(float(params.get("altitude", 2.0)), self.limits.max_altitude)
        vehicle = self.vehicle
        ok, message = await self._vehicle_action(
            "takeoff",
            (lambda: vehicle.takeoff(altitude)) if vehicle is not None else None,
        )
        if ok:
            self._takeoff_target_alt = altitude
            self._takeoff_deadline_ms = _now_ms() + 60_000.0
        return ok, message

    async def _cmd_land(self):
        self._release_all(ControlSource.AUTO.value)
        return await self._vehicle_action("land", self.vehicle.land
                                          if self.vehicle is not None else None)

    async def _cmd_rtl(self):
        self._release_all(ControlSource.AUTO.value)
        vehicle = self.vehicle
        return await self._vehicle_action(
            "rtl", (lambda: vehicle.set_mode("RTL")) if vehicle is not None else None,
        )

    async def _cmd_set_mode(self, params: Dict[str, Any]):
        mode = str(params.get("mode", "")).upper()
        if not mode:
            return False, "setMode requires params.mode"
        vehicle = self.vehicle
        return await self._vehicle_action(
            "setMode", (lambda: vehicle.set_mode(mode)) if vehicle is not None else None,
        )

    # ---- tracking / guidance (-> Guidance / Tracker) ---------------------
    def _cmd_select_target(self, params: Dict[str, Any]):
        target_id = params.get("targetId")
        if self.tracker is not None:
            self.tracker.select(None if target_id is None else int(target_id))
        return True, f"target {target_id} selected"

    def _cmd_set_standoff(self, params: Dict[str, Any]):
        """Move the standoff ring. The FLOOR is not negotiable from the wire."""
        meters = float(params.get("meters", self.limits.standoff))
        applied = (
            self.guidance.set_standoff(meters, self.limits) if self.guidance
            else self.limits.clamp_standoff(meters)
        )
        self._sync_safety_limits()
        return True, (
            f"standoff set to {applied:.1f} m "
            f"(floor {self.limits.min_standoff:.0f} m)"
        )

    def _cmd_set_max_speed(self, params: Dict[str, Any]):
        """Runtime mirror of the config-time hard cap (_enforce_safety_floor).

        The wire may LOWER the live max_speed, never raise it past the 8 m/s
        envelope. ``guidance.set_max_speed`` itself only floors at min_speed
        (control/ stays cap-agnostic), so the cap is applied here -- the same
        idiom as setStandoff's floor. A NON-FINITE request falls back to the
        cap rather than being propagated: ``min()`` would carry a NaN straight
        into the live Limits.
        """
        requested = float(params.get("mps", self.limits.max_speed))
        bounded = min(requested, MAX_SPEED_CAP) if math.isfinite(requested) else MAX_SPEED_CAP
        applied = (
            self.guidance.set_max_speed(bounded, self.limits) if self.guidance
            else self.limits.clamp_speed(bounded)
        )
        self._sync_safety_limits()
        return True, (
            f"max speed set to {applied:.1f} m/s (cap {MAX_SPEED_CAP:.0f} m/s)"
        )

    # ---- command helpers -------------------------------------------------
    async def _do_arm(self):
        """Arm, but only past THREE independent refusals (PRD 11).

        Readiness, the failsafe ladder and the SafetyManager's arming check
        each get a veto, and each of them says why in its own words. Refusing
        an arm is cheap; arming an aircraft that one of the three would have
        stopped is not, so any one "no" is the answer.
        """
        readiness = self._readiness_message()
        if not readiness["ready"]:
            return False, "arm refused: " + "; ".join(readiness["reasons"])

        decision = self._failsafe_decision
        if decision is not None and getattr(decision, "state", "refuse") != "none":
            return False, f"arm refused: {decision.reason}"

        if self.safety is not None:
            check = self.safety.check_arming(
                self._vehicle_state,
                min_battery_remaining=self.config.safety.min_battery_remaining,
                require_gps=not self.config.sitl,  # SITL bring-up may lack a fix
            )
            if not check.ok:
                await self._status("warning", check.message)
                return False, check.message

        vehicle = self.vehicle
        return await self._vehicle_action(
            "arm", vehicle.arm if vehicle is not None else None,
        )

    def _engage_tracking(self):
        """engageTracking: only from an unclaimed aircraft.

        Tracking does not preempt anything. An operator with sticks in hand
        and a dispatched mission plan are both stronger claims than a fresh
        tracking request, so this refuses rather than stealing.
        """
        for engaged, refusal in (
            (self._manual_engaged, "release manual control before engaging tracking"),
            (self._planner_engaged,
             "abort the active mission plan before engaging tracking"),
        ):
            if engaged:
                return False, refusal
        self._tracking_engaged = True
        self._set_control_source(ControlSource.TRACKING.value)
        if self.guidance is not None:
            self.guidance.reset()
        return True, "tracking engaged"

    def _disengage_tracking(self):
        """disengageTracking: idempotent, and it never relabels someone else.

        The source release is guarded on WAS-engaged (the same hazard as
        abortPlan): a stray disengage arriving while manual or a plan is
        flying must not relabel the active source, because telemetry would
        then lie about who is flying and the deadman would stop tripping.
        """
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

        # Mutual exclusion: tracking AND any mission plan release immediately.
        # The hands-on operator always wins -- this is the one engage that
        # preempts rather than refusing.
        self._tracking_engaged = False
        self._planner_engaged = False
        if self.planner is not None:
            _safe_call(getattr(self.planner, "abort", None))
        if self.guidance is not None:
            self.guidance.reset()
        if self.manual is not None:
            _safe_call(getattr(self.manual, "reset", None))

        await self._ensure_guided_for_manual(st)

        self._manual_engaged = True
        # Seed the watchdog so the first ticks don't instantly time out on an
        # operator who has not moved a stick yet.
        self._last_manual_input_ms = _now_ms()
        self._set_control_source(ControlSource.MANUAL.value)
        return True, "manual control engaged (GUIDED)"

    async def _ensure_guided_for_manual(self, st: VehicleState) -> None:
        """Put the FC in GUIDED so body-velocity setpoints take effect.

        A REFUSAL is reported loudly and does not abort the engage: the
        operator has asked for the sticks, and telling them the mode change
        failed is more useful than silently leaving the aircraft on whatever
        was flying it before.
        """
        if self.vehicle is None or str(st.mode).upper() == "GUIDED":
            return
        try:
            accepted = await self._vehicle_call(self.vehicle.set_mode, "GUIDED")
        except Exception:
            log.exception("could not switch to GUIDED for manual control")
            return
        if accepted is False:
            log.error(
                "flight controller REFUSED GUIDED for manual control; "
                "setpoints will not take effect"
            )
            await self._status(
                "critical",
                "manual control engaged but the flight controller refused "
                "GUIDED -- setpoints may not take effect",
            )

    async def _disengage_manual(self):
        """releaseManualControl: zero setpoints + auto-hold; controlSource=auto.

        Like ``_disengage_tracking``, the release (hold + source=auto) only
        runs when manual WAS engaged -- a stray disengage must not stomp an
        active tracking/planner source (deadman silencing hazard).
        """
        was_engaged = self._manual_engaged
        self._manual_engaged = False
        if self.manual is not None:
            _safe_call(getattr(self.manual, "reset", None))
        if was_engaged:
            # auto-hold in GUIDED: a zero-velocity frame, not a mode change.
            await self._send_hold("release manual")
            self._set_control_source(ControlSource.AUTO.value)
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
            return await self._refuse_plan("mission planner unavailable")
        if not self._site_valid:
            return await self._refuse_plan("plan refused: site model invalid")
        if self._estop_latched:
            return await self._refuse_plan("plan refused: emergency stop is latched")
        if self._manual_engaged:
            return await self._refuse_plan(
                "release manual control before executing a plan"
            )
        if self._fence_enforced is False:
            # The fence upload was ATTEMPTED and could not be verified as
            # enforced, so the vehicle has no lateral containment at all. That
            # used to gate nothing (FM-15).
            return await self._refuse_plan(
                "plan refused: " + (
                    self._fence_detail
                    or "the flight controller is not enforcing the site geofence"
                )
            )
        if not self._vehicle_state.armed and not self._readiness_message()["ready"]:
            return await self._refuse_plan(
                "plan refused: " + "; ".join(self._readiness_message()["reasons"])
            )
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
            return await self._refuse_plan(
                "plan refused: healthy thermal required at night"
            )
        if requested_clutter and (
            self._faults["lidar"] or self._lidar_observation_valid is False
            or self.sensor_suite is None
        ):
            return await self._refuse_plan(
                "plan refused: healthy LiDAR required through clutter"
            )
        if self._failsafe_decision is not None and getattr(
            self._failsafe_decision, "state", "refuse"
        ) != "none":
            return await self._refuse_plan(
                f"plan refused: {self._failsafe_decision.reason}"
            )
        plan = params.get("plan")
        if not isinstance(plan, dict):
            return await self._refuse_plan(
                "executePlan requires params.plan (MissionPlan)"
            )

        # COMPANION-SIDE NFZ containment, before anything is loaded or flown.
        nfz = self._plan_nfz_violation(plan)
        if nfz:
            return await self._refuse_plan(f"plan refused: {nfz}")

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
            return await self._refuse_plan(f"plan rejected: {message}")

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
                if await self._vehicle_call(self.vehicle.set_mode, "GUIDED") is False:
                    return await self._refuse_plan(
                        "plan refused: the flight controller would not enter GUIDED"
                    )
            except Exception:
                log.exception("could not switch to GUIDED for the mission plan")

        self._planner_engaged = True
        self._set_control_source(ControlSource.PLANNER.value)
        await self._arm_envelope(plan, params.get("missionRecord"))
        await self._status("info", f"mission plan engaged: {message}")
        return True, message

    async def _refuse_plan(self, reason: str) -> Tuple[bool, str]:
        """Refuse a dispatch AND make the refusal durable.

        The ack alone is not enough: the ground half discards executePlan acks
        and reports success unconditionally, so a companion refusal was
        invisible in the mission audit trail while the operator saw "Mission
        approved" and a drawn mission that never launched (FM-42). A
        ``healthEvent`` is hash-chained into the audit and replayed to the next
        client that connects, so the refusal survives the UI that dropped it.
        """
        await self._health_event("planner", "refused", reason)
        await self._status("warning", reason)
        return False, reason

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
        if self._wind_known is False:
            # UNATTENDED means nobody can take manual control, and the wind
            # limit up there is HALF the attended one. An absent WIND rail
            # degrades to 0.0 m/s -- indistinguishable from calm -- so an
            # unknown estimate must refuse rather than pass the check by
            # default (FM-20).
            return False, (
                "unattended dispatch refused: no wind estimate available "
                "(the flight controller is not streaming WIND)"
            )
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

    def _plan_nfz_violation(self, plan: Dict[str, Any]) -> str:
        """"" when no plan target breaches a buffered NFZ, else the reason.

        COMPANION-SIDE containment. ``planner_exec`` validates lat/lon range,
        the altitude band and speed, and has zero polygon awareness; only the
        perimeter went to the FC as an inclusion fence. So an NFZ breach INSIDE
        the perimeter triggered nothing at all on the vehicle -- NFZs were
        enforced solely by the ground verifier, and any plan that reached the
        companion another way (raw executePlan, a teammate dispatch, a replay,
        a ground bug, goto_relative) was uncontained (FM-13).

        The zone geometry arrives as PLAIN DATA from ``site.py``; the polygon
        maths lives in the pure ``control.envelope`` helpers, so ``control/``
        stays free of file I/O.
        """
        if self.site is None:
            return ""
        zones = [
            (str(getattr(z, "name", "nfz")), [tuple(v) for v in getattr(z, "polygon", ())],
             float(getattr(z, "ceiling_m", 0.0)))
            for z in (getattr(self.site, "nfz", ()) or ())
        ]
        zones = [z for z in zones if len(z[1]) >= 3]
        if not zones:
            return ""
        from .control.envelope import point_in_polygon, signed_distance_inside_m

        buffer_m = max(
            float(getattr(self.site, "nfz_buffer_m", 0.0) or 0.0),
            float(self.config.envelope.nfz_buffer_m),
        )
        for index, tool in enumerate(plan.get("tools") or ()):
            if not isinstance(tool, dict):
                continue
            lat, lon = tool.get("lat"), tool.get("lon")
            if lat is None or lon is None:
                continue
            try:
                point = (float(lat), float(lon))
            except (TypeError, ValueError):
                return f"tool {index}: non-numeric coordinates"
            if not all(math.isfinite(v) for v in point):
                return f"tool {index}: non-finite coordinates"
            alt = None
            for key in ("alt", "alt_m", "altitude"):
                if key in tool:
                    try:
                        alt = float(tool[key])
                    except (TypeError, ValueError):
                        alt = None
                    break
            for name, polygon, ceiling in zones:
                # Overflight ABOVE the ceiling is permitted (SITE_CONTRACT); at
                # or below it, the buffered polygon is forbidden. An unknown
                # altitude is treated as inside the ceiling -- "we could not
                # tell" must not read as "it was above".
                if alt is not None and alt > ceiling:
                    continue
                inside = point_in_polygon(point, polygon)
                clearance = signed_distance_inside_m(point, polygon)
                # signed_distance_inside_m is positive INSIDE the polygon; a
                # point outside within the buffer has |clearance| < buffer.
                if inside or abs(clearance) < buffer_m:
                    where = "inside" if inside else f"within {buffer_m:.0f} m of"
                    return (
                        f"tool {index} is {where} no-fly zone {name!r} "
                        f"(ceiling {ceiling:.0f} m)"
                    )
        return ""

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
        self._restore_operator_standoff()
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
        if not _test_hooks_enabled(self.config):
            return False, "testFault is disabled (requires SITL and EIS_ENABLE_TEST_HOOKS=true)"
        if self.api is not None and not getattr(self.api, "loopback_only", True):
            # A fault injector reachable from the network is a remote control
            # for unsafe behaviour. Three gates: SITL, the env opt-in, AND a
            # loopback-only socket (FM-40).
            return False, "testFault is disabled while the control socket is not loopback"
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
        ok = True
        if self.vehicle is not None and fault == "gps_loss":
            # Copter >= 4.5 renamed the parameter. Try the modern name, then
            # the legacy one: without the fallback the fault acked failure, the
            # injector raised SystemExit, and the whole scheduled sequence
            # stopped on older firmware (FM-139).
            ok = bool(await self._vehicle_call(
                self.vehicle.set_param, "SIM_GPS1_ENABLE", 0.0 if enabled else 1.0
            ))
            if not ok:
                log.warning(
                    "SIM_GPS1_ENABLE not accepted; trying legacy SIM_GPS_DISABLE"
                )
                ok = bool(await self._vehicle_call(
                    self.vehicle.set_param,
                    "SIM_GPS_DISABLE", 1.0 if enabled else 0.0,
                ))
        elif self.vehicle is not None and fault == "battery_drain":
            voltage = self._fault_values.get(fault, 9.9) if enabled else 12.6
            ok = bool(await self._vehicle_call(
                self.vehicle.set_param, "SIM_BATT_VOLTAGE", voltage
            ))
        elif enabled and self.vehicle is not None and fault == "raw_out_of_fence":
            if self.site is None:
                return False, "site unavailable"
            lat = max(point[0] for point in self.site.perimeter) + 0.001
            lon = max(point[1] for point in self.site.perimeter) + 0.001
            ok = bool(await _maybe_await(self.vehicle.send_raw_global_target(
                lat, lon, min(self.limits.max_altitude, self.site.alt_band.max_m)
            )))

        # The internal flag is set only when the SIMULATOR actually took the
        # injection. Setting it regardless left the companion believing in a
        # fault the simulator never had -- two divergent worlds, one of them
        # driving the failsafe ladder (FM-139).
        if fault in self._faults:
            if ok:
                self._faults[fault] = enabled
            else:
                log.error(
                    "test fault %r NOT applied to the simulator; companion state "
                    "left unchanged to avoid diverging from the vehicle", fault,
                )
        await self._health_event(
            "site_model" if fault == "raw_out_of_fence" else "planner",
            ("injected" if enabled else "cleared") if ok else "injection_failed",
            fault,
        )
        if not ok:
            return False, f"test fault {fault} could not be applied to the simulator"
        return ok, f"test fault {fault} {'enabled' if enabled else 'cleared'}"

    async def _emergency_stop(self):
        """emergencyStop: LATCH, release everything, zero setpoints, LAND/BRAKE.

        No confirmation; overrides all (PRD 11). The LATCH IS THE POINT: it
        used to be set and cleared inside this one coroutine, so it was a
        few-tick pulse rather than a state -- ``_dispatch`` had no e-stop gate
        at all, and setMode GUIDED / takeoff / engageTracking / executePlan were
        accepted on the very next tick, cancelling the FC LAND (FM-24).

        The latch clears only when the aircraft is OBSERVED disarmed and on the
        ground (see ``_maybe_clear_estop``): a physical acknowledgement, since
        the contract has no ``clearEmergencyStop`` command to require one.

        The vehicle action's RESULT IS CHECKED. ``land()``/``set_mode()`` can
        be refused (an unknown mode map, a dead link, LAND while disarmed); the
        old path swallowed that and still acked ``success: true``, i.e. the
        ordinary ``land`` command was verified harder than the emergency one.
        """
        # LATCH FIRST, unconditionally. Everything below may fail; the latch
        # may not, because it is what stops the next tick re-commanding motion.
        self._estop_latched = True
        self._takeoff_deadline_ms = 0.0
        try:
            self._release_all(ControlSource.AUTO.value)
        except Exception:
            log.exception("emergencyStop release failed; latch stays set")
        await self._send_hold("emergencyStop")

        plan = self._emergency_stop_plan()
        action = getattr(getattr(plan, "action", None), "value", "land")
        await self._status("critical", "EMERGENCY STOP")
        await self._health_event(
            "link", "emergency_stop", f"emergency stop latched -> {action}"
        )
        if self.vehicle is None:
            return False, "emergency stop LATCHED but no FC link: nothing commanded"

        try:
            accepted = await self._command_emergency(plan, action)
        except Exception as exc:
            log.exception("emergencyStop vehicle action failed")
            return False, f"emergency stop LATCHED but {action} failed: {exc}"
        if not accepted:
            await self._health_event(
                "link", "emergency_stop_refused",
                f"flight controller refused the emergency {action}",
            )
            return False, (
                f"emergency stop LATCHED but the flight controller refused {action}"
            )
        return True, f"emergency stop -> {action} (latched until disarmed on the ground)"

    def _emergency_stop_plan(self) -> Optional[Any]:
        """Ask the SafetyManager what to do; ``None`` means "default to LAND"."""
        if self.safety is None:
            return None
        try:
            return self.safety.emergency_stop_plan(self._vehicle_state)
        except Exception:
            log.exception("emergency_stop_plan failed; defaulting to LAND")
            return None

    async def _command_emergency(self, plan: Any, action: str) -> bool:
        """Issue the emergency action and REPORT whether the FC took it.

        The result is checked, unlike the original path: ``land()`` /
        ``set_mode()`` can be refused (an unknown mode map, a dead link, LAND
        while disarmed), and swallowing that acked ``success: true`` -- the
        ordinary ``land`` command was verified harder than the emergency one.
        """
        if action == "disarm" or getattr(plan, "force_disarm", False):
            result = await self._vehicle_call(self.vehicle.disarm, force=True)
        elif action == "land":
            result = await self._vehicle_call(self.vehicle.land)
        else:
            result = await self._vehicle_call(self.vehicle.set_mode, "BRAKE")
        return result is not False

    def _maybe_clear_estop(self) -> None:
        """Clear the e-stop latch once the aircraft is down and disarmed.

        The contract carries no ``clearEmergencyStop`` command, so requiring an
        explicit operator acknowledgement over the wire would be a contract
        change. The safe substitute is a PHYSICAL acknowledgement: an emergency
        stop is over when the vehicle is disarmed and not airborne. Anything
        less would let the same tick that commanded the stop resume commanding
        motion. (The wire-level acknowledgement remains an open contract gap.)
        """
        if not self._estop_latched:
            return
        st = self._vehicle_state
        if st.armed or st.airborne:
            return
        self._estop_latched = False
        log.warning("emergency-stop latch cleared: vehicle disarmed on the ground")

    async def _vehicle_action(self, name: str, fn):
        """Run one FC-bound action and turn its outcome into an ack pair.

        Three outcomes, three messages: no link, the FC said no, and it
        worked. The call goes OFF the event loop -- arm/disarm/takeoff wait on
        a COMMAND_ACK and set_mode waits on a mode readback, so calling them
        inline froze the 20 Hz control loop and every watchdog with it (FM-09).
        """
        if self.vehicle is None:
            return False, f"{name}: no FC link"
        try:
            accepted = await self._vehicle_call(fn)
        except Exception as exc:
            log.exception("%s failed", name)
            return False, f"{name} failed: {exc}"
        if accepted is False:
            return False, f"{name}: flight controller rejected command"
        return True, f"{name} ok"

    # ---- manualInput (high-rate, FIRE-AND-FORGET, NEVER acked) -----------
    def _handle_manual_input(self, msg: Dict[str, Any]) -> None:
        """Consume one high-rate manualInput frame. No ack, no await blocking.

        We record the arrival time (feeds the watchdog) but only forward the
        sticks to the pilot when manual control is actually engaged -- a stray
        frame can never command motion in auto/tracking.

        A frame with a NON-FINITE axis is dropped WHOLE and does not refresh
        the watchdog, so a stream of them ages out into the zero-and-hold. The
        wire parser already rejects the bare NaN/Infinity JSON literals; this
        is the second gate, because ``_clamp01(nan)`` used to read as FULL
        stick deflection -- full climb, full forward, max yaw (FM-05)."""
        sticks = self._usable_sticks(msg)
        if sticks is None:
            return
        # Only a WHOLE usable frame refreshes the watchdog, so a stream of
        # broken ones ages out into the zero-and-hold instead of holding the
        # watchdog open on garbage.
        self._last_manual_input_ms = _now_ms()
        if not self._manual_engaged or self.manual is None:
            return
        try:
            self.manual.set_input(**sticks)
        except Exception:
            log.exception("manual set_input failed")

    #: The four stick axes, in the contract's ManualInputMessage order.
    _STICK_AXES = ("throttle", "yaw", "pitch", "roll")

    @classmethod
    def _usable_sticks(cls, msg: Dict[str, Any]) -> Optional[Dict[str, float]]:
        """The four axes as finite floats, or ``None`` to drop the frame whole.

        A partially usable stick frame is not a stick frame: an aircraft
        commanded on three axes and NaN on the fourth is not being flown, it
        is being guessed at. The wire parser already rejects the bare
        NaN/Infinity JSON literals; this is the second gate, because
        ``_clamp01(nan)`` used to read as FULL stick deflection -- full climb,
        full forward, max yaw (FM-05).
        """
        sticks: Dict[str, float] = {}
        broken: Dict[str, Any] = {}
        for axis in cls._STICK_AXES:
            try:
                value = float(msg.get(axis, 0.0))
            except (TypeError, ValueError):
                log.warning("manualInput dropped: non-numeric axis %r", axis)
                return None
            if math.isfinite(value):
                sticks[axis] = value
            else:
                broken[axis] = value
        if broken:
            log.warning(
                "manualInput dropped: non-finite axis %r (watchdog NOT refreshed)",
                broken,
            )
            return None
        return sticks

    # ======================================================================
    # State helpers (single active control source)
    # ======================================================================
    def _set_control_source(self, source: str) -> None:
        """The ONE place the active source is written.

        The orchestrator field and the telemetry-facing VehicleState field are
        set together so the wire can never disagree with the arbiter about who
        is flying (PRD 11).
        """
        self._control_source = source
        self._vehicle_state.control_source = source

    #: Every engagement flag, cleared together by _release_all. Keeping the
    #: list here rather than in the body is what makes "exactly one control
    #: source" auditable: a new source has to appear in this tuple to be
    #: releasable, and a release can never miss one by omission.
    _ENGAGEMENT_FLAGS = ("_tracking_engaged", "_manual_engaged", "_planner_engaged")

    def _release_all(self, source: str) -> None:
        """Drop every claim on the aircraft and land on ``source``.

        rtl / land / disarm / e-stop / deadman all come through here. Each of
        them used to leave the takeoff window ARMED, so the control tick kept
        returning early (armed, below 0.9x target) and emitted no setpoints at
        all for the remainder of the 60 s (FM-04 / FM-24).
        """
        for flag in self._ENGAGEMENT_FLAGS:
            setattr(self, flag, False)
        self._takeoff_deadline_ms = 0.0
        self._planner_tracking_tool = ""
        # Wind-down, in order: PID state, stick smoothing, then the plan
        # itself. A plan must never survive a failsafe/release, and neither
        # must the integrator state the next engage would otherwise inherit.
        if self.guidance is not None:
            self.guidance.reset()
        for component in (self.manual, self.planner):
            if component is not None:
                _safe_call(getattr(component, "reset", None))
        self._restore_operator_standoff()
        self._disarm_envelope()
        self._set_control_source(source)

    def _restore_operator_standoff(self) -> None:
        """Give the shared envelope back after a plan borrowed it (FM-11).

        ``Limits`` is shared by reference with guidance, the SafetyManager and
        the Vehicle, so a follow/orbit standoff written into it outlived the
        plan and applied to a later operator-initiated engageTracking too.
        """
        if self._operator_standoff_m is None:
            return
        self.limits.standoff = self.limits.clamp_standoff(self._operator_standoff_m)
        self._operator_standoff_m = None
        self._sync_safety_limits()

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
        """Push the live Limits to every component that clamps against them.

        ``Limits`` is shared by reference, but the SafetyManager and the
        Vehicle each keep derived numbers; ``goto_global`` clamps to the
        Vehicle-held copy, which is the global-position path's second clamp.
        A holder that cannot take the update must not stop the others.
        """
        for holder in (self.safety, self.vehicle):
            if holder is None:
                continue
            try:
                holder.update_limits(self.limits)
            except Exception:
                pass

    async def _status(self, severity: str, text: str) -> None:
        """Broadcast one statusText. Never fatal: it is a courtesy rail, and a
        broken socket must not take down whatever was reporting through it."""
        if self.api is None:
            return
        try:
            await self.api.push_status(severity, text)
        except Exception:
            pass

    # ======================================================================
    # timing
    # ======================================================================
    async def _vehicle_call(self, fn, *args, **kwargs):
        """Run a BLOCKING MAVLink call OFF the event loop.

        ``set_mode``'s verification, ``set_param``'s retries, the fence upload
        and every ``_wait_command_ack`` block on ``recv_match`` for up to a few
        seconds. Called inline they froze the single event loop -- the 20 Hz
        control loop, the telemetry pump and every watchdog stopped, exactly
        while a failsafe was being handled (FM-09). ``_maybe_await`` never
        helped: it only awaits something already awaitable.
        """
        if fn is None:
            return None
        if asyncio.iscoroutinefunction(fn):
            return await fn(*args, **kwargs)
        return await _maybe_await(await asyncio.to_thread(fn, *args, **kwargs))

    async def _sleep_remaining(self, t0: float, period: float) -> None:
        """Sleep out the rest of ``period``. An overrunning tick sleeps 0 --
        the next one starts immediately rather than accumulating a debt."""
        await asyncio.sleep(max(0.0, period - (time.monotonic() - t0)))


# ==========================================================================
# Adapters / helpers
# ==========================================================================
class FrameUnavailable(RuntimeError):
    """No usable sensor frame this tick: missing, stale, failed, or invalid.

    Distinct from "a valid frame containing zero detections", which is a real
    observation and may support a ``false_alarm`` verdict. The catalogue's
    observation-state invariant turns on exactly this distinction, and
    collapsing the two was FM-100.
    """


class _CameraSource:
    """Adapts Capture + PersonDetector to the ``observe() -> [TargetObservation]``
    interface the perception loop expects."""

    def __init__(self, capture: Any, detector: Any) -> None:
        self._cap = capture
        self._det = detector

    async def observe(self) -> List[TargetObservation]:
        """One frame -> detections, RAISING when there was no usable frame.

        Every failure on this path raises ``FrameUnavailable`` rather than
        returning []. Returning [] made a dead camera present as a healthy
        empty observation, which is the evidence a ``false_alarm`` verdict is
        allowed to rest on (FM-100).
        """
        frame = self._frame(await _maybe_await(self._cap.read()))
        if frame is None:
            raise FrameUnavailable("camera read failed")
        detections = await _maybe_await(self._det.detect(frame))
        if getattr(self._det, "last_inference_failed", False):
            raise FrameUnavailable("detector inference failed")
        return list(detections or [])

    @staticmethod
    def _frame(read_result: Any) -> Any:
        """Unpack ``Capture.read()``: an (ok, frame) pair or a bare frame."""
        if isinstance(read_result, tuple):
            ok, frame = read_result
            return frame if ok else None
        return read_result


async def _maybe_await(value: Any) -> Any:
    """Await ``value`` if it is awaitable, else return it. Lets the orchestrator
    call sync OR async component methods uniformly."""
    if asyncio.iscoroutine(value) or isinstance(value, asyncio.Future):
        return await value
    return value


def _wire_value(value: Any) -> str:
    """The wire string for an enum-or-string field (``.value`` when present)."""
    return value.value if hasattr(value, "value") else str(value)


def _safe_call(fn) -> None:
    """Invoke an OPTIONAL no-arg hook. A missing or raising hook is not news:
    every caller is already on a path whose next step is the safe state."""
    if not callable(fn):
        return
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


#: What a degraded frame reports for a link it cannot measure. This path is
#: only reached when the FC layer could NOT supply telemetry: reporting a 0 ms
#: latency there advertised a PERFECT link at exactly the moment the link was
#: dead -- the inverse of the truth (FM-08).
_DEAD_LINK_LATENCY_MS = 9999.0


def _telemetry_from_state(st: VehicleState) -> Dict[str, Any]:
    """Build a minimal contract telemetry dict from a VehicleState.

    Used when the Vehicle layer doesn't supply a full telemetry dict (e.g. in a
    degraded/no-FC dev run) so the UI still receives well-formed frames. Every
    value it cannot know is stated as unknown-and-bad rather than as a
    plausible default."""
    heading = float(st.heading)
    lat, lon = float(st.lat), float(st.lon)
    rel_alt = float(st.relAlt)
    return {
        "type": "telemetry",
        "ts": _now_ms(),
        "armed": bool(st.armed),
        "mode": str(st.mode),
        "controlSource": str(st.control_source),
        "attitude": {
            "roll": float(st.roll), "pitch": float(st.pitch), "yaw": heading,
        },
        "position": {
            "lat": lat, "lon": lon, "relAlt": rel_alt, "absAlt": rel_alt,
        },
        "velocity": {
            "groundspeed": float(st.groundspeed),
            "verticalSpeed": float(st.vspeed),
        },
        "heading": heading,
        "battery": {"voltage": 0.0, "current": 0.0, "remaining": 0.0},
        "gps": {"fixType": 0, "satellites": 0, "hdop": 99.0},
        "home": {"lat": lat, "lon": lon, "distance": 0.0},
        "link": {"rssi": 0.0, "latencyMs": _DEAD_LINK_LATENCY_MS},
        "fcLink": {
            "lost": True,
            "heartbeatAgeS": _DEAD_LINK_LATENCY_MS,
            "telemetryStale": True,
        },
    }


# ==========================================================================
# CLI entry point
# ==========================================================================
def _parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m eis_companion.app",
        description="Drone Safety Platform -- Jetson companion orchestrator.",
    )
    parser.add_argument(
        "--config", default=None,
        help="path to a config YAML (else EIS_CONFIG / default.yaml)",
    )
    parser.add_argument(
        "--sitl", action="store_true", help="force SITL mode (overrides config)",
    )
    parser.add_argument(
        "--log-level", default="INFO",
        help="logging level (DEBUG/INFO/WARNING/...)",
    )
    return parser.parse_args(argv)


def _install_signal_handlers(companion: "Companion") -> None:
    """Ask for a graceful stop on SIGINT/SIGTERM where the loop supports it.

    Windows and non-main threads do not; there the KeyboardInterrupt caught in
    ``main`` is the fallback, which is why this never raises.
    """
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, companion.request_stop)
        except (NotImplementedError, ValueError):
            pass


async def _amain(argv: Optional[List[str]] = None) -> None:
    args = _parse_args(argv)
    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
    config = load_config(args.config)
    # --sitl is a one-way override: the flag can turn SITL ON, never off, so a
    # hardware config cannot be talked into SITL leniency by omitting it.
    if args.sitl:
        config.sitl = True

    companion = Companion(config)
    _install_signal_handlers(companion)
    await companion.run()


def main(argv: Optional[List[str]] = None) -> None:
    """Console entry point (also ``python -m eis_companion.app``)."""
    try:
        asyncio.run(_amain(argv))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
