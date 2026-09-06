"""
============================================================================
Drone Safety Platform -- COMPANION configuration loader
----------------------------------------------------------------------------
Resolves one typed ``AppConfig`` from three layers, in this order:

    1. the dataclass defaults below (the conservative fallback envelope),
    2. a YAML file (``EIS_CONFIG`` or ``config/default.yaml``),
    3. ``EIS_*`` environment overrides (a nearby ``.env`` is folded into the
       environment first, without ever overwriting an exported variable).

Rather than three hand-written passes that each repeat every field name, this
module is TABLE DRIVEN. ``SETTINGS`` declares each scalar once -- where it
lives (a dotted path that is simultaneously the YAML location and the
``AppConfig`` attribute), how to coerce it, and which environment variable may
override it -- and one loop applies the whole table to a default-constructed
``AppConfig``. Adding a knob is one row, and a knob can no longer be readable
from YAML but silently un-overridable from the environment.

The safety envelope is re-asserted afterwards by a second table, ``BOUNDS``.
Each row is a floor / ceiling pair (either may be another field's resolved
value, which is how bands such as ``min_standoff <= standoff <= max_standoff``
stay ordered), plus the value a non-numeric or non-finite entry degrades to.
Because the bounds run LAST, over values already written into the config, no
YAML file and no environment variable can relax a safety limit: a layer may
only ever move a number toward the conservative end of its band. Values that
are not scalars -- the standoff/altitude bands, the unattended profile list,
the per-profile cruise speeds, the bind-vs-authentication pairing -- are
reconciled by the named guards that run alongside the table.

Pure stdlib + pyyaml (+ optional python-dotenv), no hardware imports, so
loading configuration is unit-testable on any box.
============================================================================
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, Optional, Tuple

from .types import Limits

try:  # pyyaml is a pinned dependency, but degrade gracefully if absent.
    import yaml  # type: ignore
except Exception:  # pragma: no cover - exercised only on a broken install
    yaml = None  # type: ignore


# ==========================================================================
# Hard ceilings (PRD 9 / shared DEFAULTS). These are the absolute bounds that
# no config layer may exceed -- the conservative envelope of the whole system.
# ==========================================================================
MAX_SPEED_CAP: float = 8.0       # m/s -- the hard ceiling for max_speed
MIN_STANDOFF_FLOOR: float = 3.0  # m  -- standoff may never be set below this
# Standoff is a BAND, not a floor. An unbounded standoff is not "extra safe":
# guidance servos on ``est_distance - standoff``, so a huge value commands
# sustained full-speed RETREAT that the three standoff re-assertions cannot
# catch (they only ever forbid POSITIVE vx), and it leaks into the advertised
# capabilities envelope (FM-11).
MAX_STANDOFF_CEIL_M: float = 50.0

# --------------------------------------------------------------------------
# Control-socket bind policy (FM-40). Every real client is on the vehicle
# itself or reaches it over a point-to-point link, so the default bind is
# LOOPBACK. Opening the socket to the network is an explicit, single-purpose
# opt-in (network.host in YAML, or EIS_BIND_ALL=true) and it FORCES the
# signed-command requirement on: a socket any host on the venue LAN can reach
# is not one that may take unauthenticated arm/takeoff/executePlan frames.
# --------------------------------------------------------------------------
DEFAULT_CONTROL_HOST: str = "127.0.0.1"
LOOPBACK_HOSTS: Tuple[str, ...] = ("127.0.0.1", "::1", "localhost")
BIND_ALL_HOST: str = "0.0.0.0"
MAX_SORTIE_CAP_S: float = 480.0
MIN_DISPATCH_SOC_PCT: float = 80.0
MAX_CELL_IMBALANCE_V: float = 0.10
MAX_BATT_TEMP_C: float = 60.0
GEOFENCE_RADIUS_DEFAULT: float = 60.0  # m

# ==========================================================================
# UNATTENDED_ENVELOPE hard bounds (ADR D23). These sit alongside the speed /
# standoff / sortie / SoC floors above and obey the same rule: YAML and env
# may only TIGHTEN them. The widest unattended flight this system will ever
# accept is 30-50 m AGL, inspect profile, one lap, a 15 s hold, two sorties an
# hour, and half the attended wind limit -- because nobody is watching and
# nobody can take manual control.
#
# Mirrors the same constants in control/mode.py (the pure-logic owner);
# tests/test_mode.py pins the two copies equal. They are duplicated rather
# than imported so loading config stays a stdlib-only operation.
# ==========================================================================
UNATTENDED_MIN_ALT_FLOOR_M: float = 30.0     # may be raised, never lowered
UNATTENDED_MAX_ALT_CEIL_M: float = 50.0      # may be lowered, never raised
UNATTENDED_MAX_LAPS_CAP: float = 1.0
UNATTENDED_MAX_HOLD_CAP_S: float = 15.0
UNATTENDED_MAX_SORTIES_PER_HOUR_CAP: int = 2
UNATTENDED_MAX_WIND_CAP_MPS: float = 6.0     # half the attended 12 m/s limit
UNATTENDED_PROFILES_ALLOWED: Tuple[str, ...] = ("inspect",)

# ==========================================================================
# Runtime envelope-monitor bounds (ADR D21 / D22). Same rule again: a config
# layer may make the monitor stricter (wider separation, bigger buffers, a
# shorter escalation dwell) and can never make it more permissive. There is
# deliberately NO enable/disable knob: the monitor cannot be turned off.
# ==========================================================================
ENVELOPE_SEPARATION_FLOOR_M: float = 40.0        # nominal inter-vehicle gap
ENVELOPE_SEPARATION_STALE_FLOOR_M: float = 80.0  # peer data > peer_stale_s old
ENVELOPE_PEER_STALE_CAP_S: float = 3.0           # may only be shortened
ENVELOPE_PEER_HOLD_CAP_S: float = 10.0           # may only be shortened
ENVELOPE_ESCALATE_CAP_S: float = 5.0             # may only be shortened
ENVELOPE_BREACH_MULTIPLE_CAP: float = 2.0        # may only be tightened
ENVELOPE_GEOFENCE_MARGIN_FLOOR_M: float = 5.0    # may only be widened
ENVELOPE_NFZ_BUFFER_FLOOR_M: float = 25.0        # may only be widened
ENVELOPE_HZ: float = 20.0                        # monitor tick rate
ENVELOPE_PUBLISH_HZ: float = 5.0                 # 'envelope' message rate

# ==========================================================================
# Gimbal pitch envelope (shared contract GIMBAL_PITCH_MIN/MAX_DEG). -30 looks
# UP, 0 is level, +90 is straight DOWN. Config may narrow the travel; nothing
# may widen it past the mechanical envelope.
# ==========================================================================
GIMBAL_PITCH_MIN_DEG: float = -30.0
GIMBAL_PITCH_MAX_DEG: float = 90.0
GIMBAL_SLEW_RATE_CAP_DPS: float = 90.0

# Camera sources that synthesise their own frames: there is no encoder behind
# them, so there is no RTSP URL to advertise and the UI draws its mock canvas.
SYNTHETIC_CAMERA_SOURCES: Tuple[str, ...] = ("sim", "mock")
RTSP_ADVERTISE_HOST: str = "0.0.0.0"

# Fallback mirror of the shared contract's PROFILE_SPEED_MPS (shared/shared.py /
# shared/shared.ts). The authoritative copy is loaded from shared/shared.py at
# config time when the monorepo checkout is present (_shared_profile_speeds);
# this literal keeps the companion configurable on a partial install. Either
# way every value is clamped under MAX_SPEED_CAP in _enforce_safety_floor --
# mission profiles may only TIGHTEN the speed envelope, never relax it.
PROFILE_SPEED_FALLBACK: Dict[str, float] = {
    "follow": 2.0,
    "inspect": 4.0,
    "survey": 6.0,
    "slow": 2.0,
    "standard": 4.0,
    "fast": 6.0,
}

_PROFILE_SPEED_CACHE: Dict[str, Dict[str, float]] = {}


def _import_shared_contract() -> Any:
    """Import ``shared/shared.py`` by path, or return None.

    ``shared/`` is not an installed package (it is a monorepo sibling of
    ``companion/``), so there is nothing to import by name. Any failure --
    partial checkout, packaged install, a syntax error in a file this module
    is not responsible for -- is a None, never an exception: configuration
    must still load on a box that has only the companion.
    """
    contract = Path(__file__).resolve().parents[3] / "shared" / "shared.py"
    try:
        import importlib.util
        import sys

        spec = importlib.util.spec_from_file_location("_eis_shared_contract", contract)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module
    except Exception:
        return None


def _shared_profile_speeds() -> Dict[str, float]:
    """PROFILE_SPEED_MPS from the shared contract, else the literal mirror.

    Resolved once and memoised; every caller gets its own copy so a mutated
    ``PlannerConfig.profile_speed_mps`` cannot leak into the next load. The
    values are still safety-clamped in ``_enforce_safety_floor``.
    """
    resolved = _PROFILE_SPEED_CACHE.get("speeds")
    if resolved is None:
        resolved = dict(PROFILE_SPEED_FALLBACK)
        published = getattr(_import_shared_contract(), "PROFILE_SPEED_MPS", None)
        if isinstance(published, dict) and published:
            try:
                resolved = {str(k): float(v) for k, v in published.items()}
            except (TypeError, ValueError):
                resolved = dict(PROFILE_SPEED_FALLBACK)
        _PROFILE_SPEED_CACHE["speeds"] = resolved
    return dict(resolved)


# ==========================================================================
# Typed sub-configs. These are DECLARATIONS: the field names are the YAML
# keys and the defaults are layer 1 of the resolution above, so SETTINGS
# never has to repeat a default value.
# ==========================================================================
@dataclass
class GainTriple:
    """A single PID gain triple (kp, ki, kd)."""
    kp: float = 0.0
    ki: float = 0.0
    kd: float = 0.0

    def as_tuple(self) -> Tuple[float, float, float]:
        return (float(self.kp), float(self.ki), float(self.kd))


@dataclass
class GuidanceGains:
    """The three visual-servoing PID channels (yaw / altitude / forward)."""
    yaw: GainTriple = field(default_factory=lambda: GainTriple(90.0, 0.0, 4.0))
    altitude: GainTriple = field(default_factory=lambda: GainTriple(2.0, 0.0, 0.1))
    forward: GainTriple = field(default_factory=lambda: GainTriple(0.6, 0.0, 0.05))


@dataclass
class CameraConfig:
    """Camera capture configuration (see vision.Capture / SimTargetSource)."""
    source: str = "csi"            # csi | v4l2 | file | sim | mock
    device: str = "/dev/video0"    # used when source == v4l2
    file: str = ""                 # used when source == file
    width: int = 1280
    height: int = 720
    fps: int = 30
    vfov_deg: float = 41.0         # vertical FOV, feeds the distance estimator


@dataclass
class DetectorConfig:
    """Person-detector configuration (vision.PersonDetector)."""
    model_path: str = "weights/yolo11n.pt"
    engine_path: str = "weights/yolo11n.engine"
    conf: float = 0.4              # detection confidence threshold
    person_height_m: float = 1.7   # assumed real person height for distance est.


@dataclass
class NetworkConfig:
    """Control + video network ports / hosts."""
    host: str = DEFAULT_CONTROL_HOST   # bind address for the control WS server
    control_port: int = 8765       # control + telemetry WebSocket
    video_port: int = 8554         # RTSP port (mediamtx/GStreamer)
    webrtc_port: int = 8889        # mediamtx WebRTC/WHEP port
    video_bitrate_kbps: int = 2500
    video_url: str = ""            # advertised stream URL; "" => derive/mock


@dataclass
class FcConfig:
    """Flight-controller MAVLink link (serial on HW, UDP in SITL)."""
    connection: str = "udp:127.0.0.1:14550"   # /dev/ttyTHS1 on real hardware
    baud: int = 921600                         # ignored for udp/tcp
    sysid: int = 1                             # FC system id
    gcs_sysid: int = 255                       # this companion's GCS sysid


@dataclass
class TrackingConfig:
    """Tracker timing / behaviour knobs (control.Tracker)."""
    lost_timeout: float = 1.0      # s the locked track may coast before 'lost'
    max_age: float = 1.5           # s a track may coast before deletion
    iou_threshold: float = 0.3
    min_hits: int = 2


@dataclass
class SafetyConfig:
    """Failsafe actions + geofence beyond what Limits already carries."""
    geofence_radius_m: float = GEOFENCE_RADIUS_DEFAULT
    low_battery_action: str = "rtl"      # warn -> rtl -> land ladder action
    critical_battery_action: str = "land"
    min_battery_remaining: float = 20.0  # % gate for arming
    rc_override_primacy: bool = True     # documented invariant; never disabled


@dataclass
class BatteryConfig:
    """Payload-adjusted battery, charging, and sortie policy."""
    nominal_endurance_s: float = 1500.0
    reserve_pct: float = 25.0
    max_sortie_s: float = MAX_SORTIE_CAP_S
    dispatch_min_soc_pct: float = MIN_DISPATCH_SOC_PCT
    cell_imbalance_max_v: float = MAX_CELL_IMBALANCE_V
    batt_temp_max_c: float = MAX_BATT_TEMP_C
    capacity_mah: float = 5000.0
    cell_count: int = 4
    demo_charge_scale_s: float = 30.0
    estimated_return_s: float = 30.0


@dataclass
class PlannerConfig:
    """Mission-planner execution config (power-plant security retrofit).

    ``profile_speed_mps`` mirrors the shared contract's PROFILE_SPEED_MPS
    (slow/standard/fast cruise speeds). ``_enforce_safety_floor`` clamps every
    value under MAX_SPEED_CAP at load; the PlannerExecutor additionally
    re-clamps each emitted speed to ``limits.max_speed`` per tick, so a
    profile can only ever tighten the envelope.

    ``site_file`` selects the site model JSON (docs/SITE_CONTRACT.md):
    "" defers to the ``EIS_SITE_FILE`` env var, then ``site/site.json``
    (that resolution lives in ``eis_companion.site.resolve_site_path``).
    """
    profile_speed_mps: Dict[str, float] = field(default_factory=_shared_profile_speeds)
    site_file: str = ""                       # "" -> EIS_SITE_FILE, else site/site.json
    arrival_radius_m: float = 2.0             # goto_gps arrival threshold (m)
    staging_arrival_radius_m: float = 15.0    # staging-point vision trigger radius (m)
    heartbeat_timeout_ms: int = 2000


@dataclass
class EnvelopeConfig:
    """Runtime envelope-monitor thresholds (ADR D21 / D22).

    Every field is re-asserted in ``_enforce_safety_floor`` so a config layer
    can only make the monitor stricter. There is no on/off switch by design:
    the monitor is not something guidance, the planner, the ground station or
    a model is allowed to disable, so it is not something a YAML file gets to
    disable either.
    """
    hz: float = ENVELOPE_HZ                       # monitor tick rate
    publish_hz: float = ENVELOPE_PUBLISH_HZ       # 'envelope' wire message rate
    geofence_margin_m: float = ENVELOPE_GEOFENCE_MARGIN_FLOOR_M
    nfz_buffer_m: float = ENVELOPE_NFZ_BUFFER_FLOOR_M
    separation_m: float = ENVELOPE_SEPARATION_FLOOR_M
    separation_stale_m: float = ENVELOPE_SEPARATION_STALE_FLOOR_M
    peer_stale_s: float = ENVELOPE_PEER_STALE_CAP_S
    peer_hold_s: float = ENVELOPE_PEER_HOLD_CAP_S
    escalate_after_s: float = ENVELOPE_ESCALATE_CAP_S
    breach_multiple: float = ENVELOPE_BREACH_MULTIPLE_CAP
    hysteresis_m: float = 2.0                     # recovery margin
    recovery_s: float = 2.0                       # dwell inside tolerance


@dataclass
class UnattendedConfig:
    """UNATTENDED_ENVELOPE (ADR D23), hard-floored like the speed cap."""
    min_alt_m: float = UNATTENDED_MIN_ALT_FLOOR_M
    max_alt_m: float = UNATTENDED_MAX_ALT_CEIL_M
    max_laps: float = UNATTENDED_MAX_LAPS_CAP
    max_hold_s: float = UNATTENDED_MAX_HOLD_CAP_S
    max_sorties_per_hour: int = UNATTENDED_MAX_SORTIES_PER_HOUR_CAP
    max_wind_mps: float = UNATTENDED_MAX_WIND_CAP_MPS
    profiles: Tuple[str, ...] = UNATTENDED_PROFILES_ALLOWED


@dataclass
class GimbalConfig:
    """Camera-mount pointing envelope + the MAVLink targeting variant.

    ``use_gimbal_manager`` selects MAV_CMD_DO_GIMBAL_MANAGER_PITCHYAW instead
    of the classic MAV_CMD_DO_MOUNT_CONTROL; it is a flag because the two are
    not interchangeable across firmware and the classic form is what the
    demo airframe answers.
    """
    enabled: bool = True
    pitch_min_deg: float = GIMBAL_PITCH_MIN_DEG
    pitch_max_deg: float = GIMBAL_PITCH_MAX_DEG
    slew_rate_dps: float = 30.0
    use_gimbal_manager: bool = False


@dataclass
class SecurityConfig:
    """Command signing + the hash-chained audit (docs/THREAT_MODEL.md).

    ``session_key_env`` names the environment variable holding this vehicle's
    HMAC key -- per vehicle, so a second airframe has its own and neither can
    mint the other's privileged commands. Key custody is the deploying
    organisation's, not this system's.

    ``require_signed_commands`` extends the signature requirement to EVERY
    command. The privileged set (enterUnattended / exitUnattended / setGimbal)
    always requires one regardless of this flag -- that part is not a knob.
    """
    session_key_env: str = "EIS_SESSION_KEY"
    max_command_age_ms: int = 30_000
    require_signed_commands: bool = False
    audit_path: str = ""            # "" -> logs/companion-audit.jsonl


@dataclass
class AppConfig:
    """The whole companion configuration, fully resolved + typed."""
    sitl: bool = True
    limits: Limits = field(default_factory=Limits)
    gains: GuidanceGains = field(default_factory=GuidanceGains)
    camera: CameraConfig = field(default_factory=CameraConfig)
    detector: DetectorConfig = field(default_factory=DetectorConfig)
    network: NetworkConfig = field(default_factory=NetworkConfig)
    fc: FcConfig = field(default_factory=FcConfig)
    tracking: TrackingConfig = field(default_factory=TrackingConfig)
    safety: SafetyConfig = field(default_factory=SafetyConfig)
    battery: BatteryConfig = field(default_factory=BatteryConfig)
    planner: PlannerConfig = field(default_factory=PlannerConfig)
    envelope: EnvelopeConfig = field(default_factory=EnvelopeConfig)
    unattended: UnattendedConfig = field(default_factory=UnattendedConfig)
    gimbal: GimbalConfig = field(default_factory=GimbalConfig)
    security: SecurityConfig = field(default_factory=SecurityConfig)
    vehicle_id: str = "eis-1"
    source_path: Optional[str] = None     # the YAML path actually loaded

    # ---- convenience views ------------------------------------------------
    @property
    def video_url(self) -> str:
        """The video URL to advertise to the ground UI.

        An explicitly configured URL wins outright. Otherwise a synthetic
        camera advertises nothing (there is no encoder, so the UI falls back
        to its mock canvas) and a real camera advertises the RTSP endpoint
        the stream sub-package publishes.
        """
        if self.network.video_url:
            return self.network.video_url
        if self.camera.source in SYNTHETIC_CAMERA_SOURCES:
            return ""
        return f"rtsp://{RTSP_ADVERTISE_HOST}:{self.network.video_port}/stream"


# ==========================================================================
# Layer 3a: fold a nearby .env into the process environment
# ==========================================================================
def _discover_dotenv(start: Optional[Path]) -> Optional[Path]:
    """Nearest ``.env`` walking upward from ``start`` (or the cwd)."""
    try:
        origin = (start or Path.cwd()).resolve()
    except Exception:
        return None
    for directory in (origin, *origin.parents):
        candidate = directory / ".env"
        if candidate.is_file():
            return candidate
    return None


def _dotenv_pairs(path: Path) -> Dict[str, str]:
    """Parse ``path`` into KEY -> VALUE. Never raises; {} on any trouble.

    python-dotenv is used when installed (it understands ``export`` prefixes
    and quoting rules this project does not want to re-litigate); otherwise a
    minimal KEY=VALUE reader keeps the companion configurable on a box that
    has no dotenv.
    """
    try:
        from dotenv import dotenv_values  # type: ignore

        parsed = dotenv_values(str(path))
        return {k: v for k, v in parsed.items() if k and v is not None}
    except Exception:
        pass

    pairs: Dict[str, str] = {}
    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if line.startswith("export "):
                line = line[len("export "):].strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            if key:
                # drop an inline comment, then the surrounding quotes
                pairs[key] = value.split("#", 1)[0].strip().strip('"').strip("'")
    except Exception:
        return {}
    return pairs


def _load_dotenv(start: Optional[Path] = None) -> None:
    """Populate ``os.environ`` from the nearest ``.env``, never overriding.

    An exported ``EIS_*`` always beats the file, which is what makes a
    one-off ``EIS_CONFIG=... python -m eis_companion.app`` reliable on a box
    that also has a checked-out ``.env``.
    """
    path = _discover_dotenv(start)
    if path is None:
        return
    for key, value in _dotenv_pairs(path).items():
        os.environ.setdefault(key, value)


# ==========================================================================
# Coercion. Each kind knows how to read a YAML node and an environment string;
# an environment coercer returns None to mean "unusable, leave the layer
# below in place" so a typo never silently zeroes a limit.
# ==========================================================================
def _env_text(name: str) -> Optional[str]:
    """The stripped value of ``name``, or None when unset/blank."""
    raw = os.environ.get(name)
    if raw is None:
        return None
    stripped = raw.strip()
    return stripped or None


def _text_from_env(text: str) -> Optional[str]:
    return text


def _real_from_env(text: str) -> Optional[float]:
    try:
        return float(text)
    except ValueError:
        return None


def _whole_from_env(text: str) -> Optional[int]:
    number = _real_from_env(text)
    return None if number is None else int(number)


TRUE_TOKENS: Tuple[str, ...] = ("1", "true", "yes", "on")


def _bool_from_env(text: str) -> Optional[bool]:
    return text.lower() in TRUE_TOKENS


@dataclass(frozen=True)
class Kind:
    """How one scalar is read out of each layer."""
    from_yaml: Callable[[Any], Any]
    from_env: Callable[[str], Any]


TEXT = Kind(str, _text_from_env)
REAL = Kind(float, _real_from_env)
WHOLE = Kind(int, _whole_from_env)
BOOL = Kind(bool, _bool_from_env)


@dataclass(frozen=True)
class Setting:
    """One scalar knob.

    ``path`` is dotted and doubles as the YAML location (``limits.max_speed``
    -> ``{limits: {max_speed: ...}}``) and the attribute chain on AppConfig,
    so the two can never drift apart. ``env`` is the documented override name
    from .env.example, or None for a YAML-only knob.
    """
    path: str
    kind: Kind
    env: Optional[str] = None


SETTINGS: Tuple[Setting, ...] = (
    # ---- identity / mode -------------------------------------------------
    Setting("sitl", BOOL, "EIS_SITL"),
    Setting("vehicle_id", TEXT, "EIS_VEHICLE_ID"),

    # ---- hard safety + tuning envelope -----------------------------------
    Setting("limits.max_speed", REAL, "EIS_MAX_SPEED_MPS"),
    Setting("limits.min_speed", REAL),
    Setting("limits.max_climb_rate", REAL),
    Setting("limits.max_yaw_rate", REAL),
    Setting("limits.max_altitude", REAL, "EIS_MAX_ALT_M"),
    Setting("limits.standoff", REAL, "EIS_STANDOFF_M"),
    Setting("limits.min_standoff", REAL),
    Setting("limits.max_standoff", REAL),
    Setting("limits.deadzone", REAL),
    Setting("limits.manual_watchdog_ms", WHOLE),
    Setting("limits.ground_link_timeout_ms", WHOLE),

    # ---- camera / detector -----------------------------------------------
    Setting("camera.source", TEXT, "EIS_CAMERA_SOURCE"),
    Setting("camera.device", TEXT, "EIS_CAMERA_DEVICE"),
    Setting("camera.file", TEXT),
    Setting("camera.width", WHOLE, "EIS_CAMERA_WIDTH"),
    Setting("camera.height", WHOLE, "EIS_CAMERA_HEIGHT"),
    Setting("camera.fps", WHOLE, "EIS_CAMERA_FPS"),
    Setting("camera.vfov_deg", REAL),
    Setting("detector.model_path", TEXT, "EIS_MODEL_PATH"),
    Setting("detector.engine_path", TEXT, "EIS_ENGINE_PATH"),
    Setting("detector.conf", REAL, "EIS_DETECT_CONF"),
    Setting("detector.person_height_m", REAL),

    # ---- network ---------------------------------------------------------
    Setting("network.host", TEXT, "EIS_CONTROL_HOST"),
    Setting("network.control_port", WHOLE, "EIS_CONTROL_PORT"),
    Setting("network.video_port", WHOLE, "EIS_VIDEO_PORT"),
    Setting("network.webrtc_port", WHOLE, "EIS_WEBRTC_PORT"),
    Setting("network.video_bitrate_kbps", WHOLE, "EIS_VIDEO_BITRATE"),
    Setting("network.video_url", TEXT, "EIS_VIDEO_URL"),

    # ---- flight-controller link ------------------------------------------
    Setting("fc.connection", TEXT, "EIS_FC_CONNECTION"),
    Setting("fc.baud", WHOLE, "EIS_FC_BAUD"),
    Setting("fc.sysid", WHOLE, "EIS_MAVLINK_SYSID"),
    Setting("fc.gcs_sysid", WHOLE, "EIS_GCS_SYSID"),

    # ---- tracker ---------------------------------------------------------
    Setting("tracking.lost_timeout", REAL),
    Setting("tracking.max_age", REAL),
    Setting("tracking.iou_threshold", REAL),
    Setting("tracking.min_hits", WHOLE),

    # ---- failsafe actions + geofence -------------------------------------
    Setting("safety.geofence_radius_m", REAL, "EIS_GEOFENCE_RADIUS_M"),
    Setting("safety.low_battery_action", TEXT),
    Setting("safety.critical_battery_action", TEXT),
    Setting("safety.min_battery_remaining", REAL),
    Setting("safety.rc_override_primacy", BOOL),

    # ---- battery / sortie policy -----------------------------------------
    Setting("battery.nominal_endurance_s", REAL),
    Setting("battery.reserve_pct", REAL),
    Setting("battery.max_sortie_s", REAL, "EIS_MAX_SORTIE_S"),
    Setting("battery.dispatch_min_soc_pct", REAL, "EIS_DISPATCH_MIN_SOC_PCT"),
    Setting("battery.cell_imbalance_max_v", REAL, "EIS_CELL_IMBALANCE_MAX_V"),
    Setting("battery.batt_temp_max_c", REAL, "EIS_BATT_TEMP_MAX_C"),
    Setting("battery.capacity_mah", REAL),
    Setting("battery.cell_count", WHOLE),
    Setting("battery.demo_charge_scale_s", REAL, "DEMO_CHARGE_SCALE"),
    Setting("battery.estimated_return_s", REAL),

    # ---- mission planner --------------------------------------------------
    Setting("planner.site_file", TEXT, "EIS_SITE_FILE"),
    Setting("planner.arrival_radius_m", REAL),
    Setting("planner.staging_arrival_radius_m", REAL, "EIS_STAGING_RADIUS_M"),
    Setting("planner.heartbeat_timeout_ms", WHOLE, "EIS_PLANNER_HEARTBEAT_TIMEOUT_MS"),

    # ---- runtime envelope monitor ----------------------------------------
    Setting("envelope.hz", REAL),
    Setting("envelope.publish_hz", REAL),
    Setting("envelope.geofence_margin_m", REAL, "EIS_ENVELOPE_GEOFENCE_MARGIN_M"),
    Setting("envelope.nfz_buffer_m", REAL, "EIS_ENVELOPE_NFZ_BUFFER_M"),
    Setting("envelope.separation_m", REAL, "EIS_ENVELOPE_SEPARATION_M"),
    Setting("envelope.separation_stale_m", REAL, "EIS_ENVELOPE_SEPARATION_STALE_M"),
    Setting("envelope.peer_stale_s", REAL, "EIS_ENVELOPE_PEER_STALE_S"),
    Setting("envelope.peer_hold_s", REAL, "EIS_ENVELOPE_PEER_HOLD_S"),
    Setting("envelope.escalate_after_s", REAL, "EIS_ENVELOPE_ESCALATE_AFTER_S"),
    Setting("envelope.breach_multiple", REAL),
    Setting("envelope.hysteresis_m", REAL),
    Setting("envelope.recovery_s", REAL),

    # ---- UNATTENDED_ENVELOPE ---------------------------------------------
    Setting("unattended.min_alt_m", REAL, "EIS_UNATTENDED_MIN_ALT_M"),
    Setting("unattended.max_alt_m", REAL, "EIS_UNATTENDED_MAX_ALT_M"),
    Setting("unattended.max_laps", REAL),
    Setting("unattended.max_hold_s", REAL, "EIS_UNATTENDED_MAX_HOLD_S"),
    Setting(
        "unattended.max_sorties_per_hour",
        WHOLE,
        "EIS_UNATTENDED_MAX_SORTIES_PER_HOUR",
    ),
    Setting("unattended.max_wind_mps", REAL, "EIS_UNATTENDED_MAX_WIND_MPS"),

    # ---- gimbal ----------------------------------------------------------
    Setting("gimbal.enabled", BOOL, "EIS_GIMBAL_ENABLED"),
    Setting("gimbal.pitch_min_deg", REAL, "EIS_GIMBAL_PITCH_MIN_DEG"),
    Setting("gimbal.pitch_max_deg", REAL, "EIS_GIMBAL_PITCH_MAX_DEG"),
    Setting("gimbal.slew_rate_dps", REAL, "EIS_GIMBAL_SLEW_RATE_DPS"),
    Setting("gimbal.use_gimbal_manager", BOOL, "EIS_GIMBAL_MANAGER"),

    # ---- command signing / audit -----------------------------------------
    Setting("security.session_key_env", TEXT, "EIS_SESSION_KEY_ENV"),
    Setting("security.max_command_age_ms", WHOLE, "EIS_COMMAND_MAX_AGE_MS"),
    Setting("security.require_signed_commands", BOOL, "EIS_REQUIRE_SIGNED_COMMANDS"),
    Setting("security.audit_path", TEXT, "EIS_AUDIT_PATH"),
)


# ==========================================================================
# The safety envelope, re-asserted over whatever the layers produced
# ==========================================================================
@dataclass(frozen=True)
class Bound:
    """The band one resolved number is forced into.

    ``lo`` / ``hi`` are the hard literals. ``lo_ref`` / ``hi_ref`` name
    another already-bounded field whose value tightens this one further --
    that is how ``min_standoff <= standoff <= max_standoff`` and
    ``peer_stale_s <= peer_hold_s`` stay ordered no matter what a YAML file
    asks for. ``bad`` is the conservative value a non-numeric or non-finite
    entry degrades to; None means "the resulting floor".
    """
    path: str
    lo: Optional[float] = None
    hi: Optional[float] = None
    lo_ref: str = ""
    hi_ref: str = ""
    bad: Optional[float] = None
    whole: bool = False


# Order matters: a row whose floor/ceiling references another row must come
# after it, so the reference has already been forced into its own band.
BOUNDS: Tuple[Bound, ...] = (
    # standoff BAND -- closed at BOTH ends (FM-11)
    Bound("limits.min_standoff", lo=MIN_STANDOFF_FLOOR),
    Bound(
        "limits.max_standoff",
        hi=MAX_STANDOFF_CEIL_M,
        lo_ref="limits.min_standoff",
        bad=MAX_STANDOFF_CEIL_M,
    ),
    Bound("limits.standoff", lo_ref="limits.min_standoff", hi_ref="limits.max_standoff"),
    # speed band -- the configurable cap can never clear the hard ceiling
    Bound("limits.max_speed", lo=0.1, hi=MAX_SPEED_CAP),
    Bound("limits.min_speed", lo=0.0, hi_ref="limits.max_speed"),
    # climb / yaw / altitude must stay positive
    Bound("limits.max_climb_rate", lo=0.1),
    Bound("limits.max_yaw_rate", lo=1.0),
    Bound("limits.max_altitude", lo=1.0),
    # watchdogs must stay positive -- a zero watchdog is a disabled watchdog
    Bound("limits.manual_watchdog_ms", lo=50, whole=True),
    Bound("limits.ground_link_timeout_ms", lo=200, whole=True),
    # geofence radius floor
    Bound("safety.geofence_radius_m", lo=10.0),
    # battery / dispatch gates: overrides may only tighten them
    Bound("battery.max_sortie_s", lo=1.0, hi=MAX_SORTIE_CAP_S),
    Bound(
        "battery.dispatch_min_soc_pct",
        lo=MIN_DISPATCH_SOC_PCT,
        hi=100.0,
        bad=100.0,   # an unreadable dispatch gate refuses, it does not dispatch
    ),
    Bound("battery.cell_imbalance_max_v", lo=0.001, hi=MAX_CELL_IMBALANCE_V),
    Bound("battery.batt_temp_max_c", lo=1.0, hi=MAX_BATT_TEMP_C),
    Bound("battery.nominal_endurance_s", lo=1.0),
    Bound("battery.reserve_pct", lo=0.0, hi=99.0, bad=99.0),
    Bound("battery.capacity_mah", lo=1.0),
    Bound("battery.cell_count", lo=1, whole=True),
    Bound("battery.demo_charge_scale_s", lo=1.0),
    Bound("battery.estimated_return_s", lo=0.0),
    # planner thresholds must stay sane (arrival radii can't collapse to 0)
    Bound("planner.arrival_radius_m", lo=0.5),
    Bound("planner.staging_arrival_radius_m", lo=1.0),
    Bound("planner.heartbeat_timeout_ms", lo=200, whole=True),
    # envelope monitor: protective distances may only grow, timers only shrink
    Bound("envelope.separation_m", lo=ENVELOPE_SEPARATION_FLOOR_M),
    Bound(
        "envelope.separation_stale_m",
        lo=ENVELOPE_SEPARATION_STALE_FLOOR_M,
        lo_ref="envelope.separation_m",
        bad=ENVELOPE_SEPARATION_STALE_FLOOR_M,
    ),
    Bound(
        "envelope.peer_stale_s",
        lo=0.1,
        hi=ENVELOPE_PEER_STALE_CAP_S,
        bad=ENVELOPE_PEER_STALE_CAP_S,
    ),
    Bound(
        "envelope.peer_hold_s",
        hi=ENVELOPE_PEER_HOLD_CAP_S,
        lo_ref="envelope.peer_stale_s",
        bad=ENVELOPE_PEER_HOLD_CAP_S,
    ),
    Bound(
        "envelope.escalate_after_s",
        lo=0.1,
        hi=ENVELOPE_ESCALATE_CAP_S,
        bad=ENVELOPE_ESCALATE_CAP_S,
    ),
    Bound(
        "envelope.breach_multiple",
        lo=1.0,
        hi=ENVELOPE_BREACH_MULTIPLE_CAP,
        bad=ENVELOPE_BREACH_MULTIPLE_CAP,
    ),
    Bound("envelope.geofence_margin_m", lo=ENVELOPE_GEOFENCE_MARGIN_FLOOR_M),
    Bound("envelope.nfz_buffer_m", lo=ENVELOPE_NFZ_BUFFER_FLOOR_M),
    Bound("envelope.hysteresis_m", lo=0.0, bad=2.0),
    Bound("envelope.recovery_s", lo=0.0, bad=2.0),
    # rates: the monitor runs at the control rate and publishes no faster than
    # it ticks. Neither can be configured to zero (that would be an off switch).
    Bound("envelope.hz", lo=1.0, hi=50.0, bad=ENVELOPE_HZ),
    Bound("envelope.publish_hz", lo=0.5, hi_ref="envelope.hz", bad=ENVELOPE_PUBLISH_HZ),
    # UNATTENDED_ENVELOPE: config may only TIGHTEN (ADR D23)
    Bound("unattended.min_alt_m", lo=UNATTENDED_MIN_ALT_FLOOR_M),
    Bound("unattended.max_alt_m", hi=UNATTENDED_MAX_ALT_CEIL_M, bad=UNATTENDED_MAX_ALT_CEIL_M),
    Bound("unattended.max_laps", lo=0.0, hi=UNATTENDED_MAX_LAPS_CAP, bad=UNATTENDED_MAX_LAPS_CAP),
    Bound(
        "unattended.max_hold_s",
        lo=0.0,
        hi=UNATTENDED_MAX_HOLD_CAP_S,
        bad=UNATTENDED_MAX_HOLD_CAP_S,
    ),
    Bound(
        "unattended.max_sorties_per_hour",
        lo=0,
        hi=UNATTENDED_MAX_SORTIES_PER_HOUR_CAP,
        bad=UNATTENDED_MAX_SORTIES_PER_HOUR_CAP,
        whole=True,
    ),
    Bound(
        "unattended.max_wind_mps",
        lo=0.0,
        hi=UNATTENDED_MAX_WIND_CAP_MPS,
        bad=UNATTENDED_MAX_WIND_CAP_MPS,
    ),
    # gimbal travel: config may narrow it, never widen past -30..90 deg
    Bound("gimbal.pitch_min_deg", lo=GIMBAL_PITCH_MIN_DEG),
    Bound("gimbal.pitch_max_deg", hi=GIMBAL_PITCH_MAX_DEG, bad=GIMBAL_PITCH_MAX_DEG),
    Bound("gimbal.slew_rate_dps", lo=1.0, hi=GIMBAL_SLEW_RATE_CAP_DPS, bad=30.0),
    # a replay window can be shortened but never opened indefinitely
    Bound("security.max_command_age_ms", lo=1_000, hi=300_000, bad=30_000, whole=True),
)

# Bands that collapse to their hard endpoints when a config layer inverts them.
# An empty band would silently ground the vehicle; the hard band at least
# flies the documented envelope.
_INVERTIBLE_BANDS: Tuple[Tuple[str, str, float, float], ...] = (
    (
        "unattended.min_alt_m",
        "unattended.max_alt_m",
        UNATTENDED_MIN_ALT_FLOOR_M,
        UNATTENDED_MAX_ALT_CEIL_M,
    ),
    ("gimbal.pitch_min_deg", "gimbal.pitch_max_deg", GIMBAL_PITCH_MIN_DEG, GIMBAL_PITCH_MAX_DEG),
)

# Free-text fields that must never resolve to an empty string.
_NON_EMPTY_TEXT: Tuple[Tuple[str, str], ...] = (
    ("vehicle_id", "eis-1"),
    ("security.session_key_env", "EIS_SESSION_KEY"),
    ("network.host", DEFAULT_CONTROL_HOST),
)

_GAIN_CHANNELS: Tuple[str, ...] = ("yaw", "altitude", "forward")


# ==========================================================================
# Dotted-path plumbing shared by the two tables
# ==========================================================================
def _read_attr(cfg: AppConfig, path: str) -> Any:
    node: Any = cfg
    for part in path.split("."):
        node = getattr(node, part)
    return node


def _write_attr(cfg: AppConfig, path: str, value: Any) -> None:
    node: Any = cfg
    parts = path.split(".")
    for part in parts[:-1]:
        node = getattr(node, part)
    setattr(node, parts[-1], value)


def _yaml_at(raw: Dict[str, Any], path: str) -> Any:
    """The YAML node at a dotted path, or None when absent/not a mapping."""
    node: Any = raw
    for part in path.split("."):
        if not isinstance(node, dict):
            return None
        node = node.get(part)
    return node


# ==========================================================================
# YAML loading
# ==========================================================================
DEFAULT_CONFIG_REL = "config/default.yaml"


def _config_candidates(explicit: Optional[str]) -> Iterator[Path]:
    """Where a config file named ``explicit`` (or EIS_CONFIG) could live."""
    requested = Path(explicit or _env_text("EIS_CONFIG") or DEFAULT_CONFIG_REL)
    package_root = Path(__file__).resolve().parents[2]   # .../companion
    yield requested                                       # as given / cwd-relative
    yield package_root / requested                        # companion/<as given>
    yield package_root / "config" / requested.name        # companion/config/<name>


def _resolve_config_path(explicit: Optional[str]) -> Optional[Path]:
    """The first candidate that exists, or None when no YAML is available."""
    return next((p for p in _config_candidates(explicit) if p.is_file()), None)


def _read_yaml(path: Optional[Path]) -> Dict[str, Any]:
    """Read a YAML mapping. {} for a missing/empty file. Raises on bad YAML."""
    if path is None or not path.is_file():
        return {}
    text = path.read_text(encoding="utf-8")
    if yaml is None:
        raise RuntimeError(
            "pyyaml is required to load YAML config but is not installed; "
            "install it (it is a pinned dependency) or set EIS_* env vars only."
        )
    data = yaml.safe_load(text)
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ValueError(f"config file {path} must contain a YAML mapping at the top level")
    return data


# ==========================================================================
# The public entry point
# ==========================================================================
def load_config(
    path: Optional[str] = None,
    *,
    use_dotenv: bool = True,
    use_env: bool = True,
) -> AppConfig:
    """Load + resolve the layered companion configuration.

    Args:
      path: explicit YAML path; otherwise ``EIS_CONFIG`` then ``config/default.yaml``.
      use_dotenv: load a nearby ``.env`` into the environment first.
      use_env: apply ``EIS_*`` environment overrides on top of the YAML.

    Returns:
      A fully-resolved, safety-clamped ``AppConfig``.
    """
    if use_dotenv:
        _load_dotenv()

    cfg_path = _resolve_config_path(path)
    raw = _read_yaml(cfg_path)

    cfg = AppConfig()                 # layer 1: the conservative defaults
    _overlay_yaml(cfg, raw)           # layer 2
    cfg.source_path = str(cfg_path) if cfg_path is not None else None
    if use_env:
        _overlay_env(cfg)             # layer 3

    _enforce_safety_floor(cfg)        # and the envelope always wins
    return cfg


def _overlay_yaml(cfg: AppConfig, raw: Dict[str, Any]) -> None:
    """Write every YAML-provided value over the defaults already in ``cfg``."""
    for setting in SETTINGS:
        node = _yaml_at(raw, setting.path)
        if node is not None:
            _write_attr(cfg, setting.path, setting.kind.from_yaml(node))

    _overlay_gains(cfg.gains, _yaml_at(raw, "guidance.gains"))
    _overlay_profile_speeds(cfg.planner, _yaml_at(raw, "planner.profile_speed_mps"))
    _overlay_profiles(cfg.unattended, _yaml_at(raw, "unattended.profiles"))


def _overlay_env(cfg: AppConfig) -> None:
    """Apply the ``EIS_*`` overrides documented in .env.example."""
    for setting in SETTINGS:
        if setting.env is None:
            continue
        text = _env_text(setting.env)
        if text is None:
            continue
        value = setting.kind.from_env(text)
        if value is not None:
            _write_attr(cfg, setting.path, value)

    # EIS_BIND_ALL is deliberately applied AFTER EIS_CONTROL_HOST: it is the
    # blunt, single, explicit opt-in that opens the control socket beyond
    # loopback, so it decides the bind whichever order they were exported in.
    # _enforce_bind_policy then forces signed commands on.
    bind_all = _env_text("EIS_BIND_ALL")
    if bind_all is not None:
        opened = _bool_from_env(bind_all)
        cfg.network.host = BIND_ALL_HOST if opened else DEFAULT_CONTROL_HOST


def _overlay_gains(gains: GuidanceGains, raw: Any) -> None:
    """Overlay ``guidance.gains`` -- per channel, per term, over the defaults."""
    for channel in _GAIN_CHANNELS:
        spec = raw.get(channel) if isinstance(raw, dict) else None
        setattr(gains, channel, _gain_triple(spec, getattr(gains, channel)))


def _gain_triple(spec: Any, current: GainTriple) -> GainTriple:
    """One gain triple from a {kp,ki,kd} mapping or a [kp,ki,kd] sequence."""
    if isinstance(spec, dict):
        terms = []
        for name, fallback in zip(("kp", "ki", "kd"), current.as_tuple()):
            given = spec.get(name)
            terms.append(fallback if given is None else float(given))
        return GainTriple(*terms)
    if isinstance(spec, (list, tuple)) and len(spec) >= 3:
        return GainTriple(*(float(term) for term in spec[:3]))
    return GainTriple(*current.as_tuple())


def _overlay_profile_speeds(planner: PlannerConfig, raw: Any) -> None:
    """Merge per-profile cruise speeds over the shared-contract defaults.

    A profile the YAML does not mention keeps the shared value, and a value
    that will not parse keeps it too: a malformed line must not silently
    delete a profile the planner is about to be asked to fly.
    """
    if not isinstance(raw, dict):
        return
    for name, value in raw.items():
        try:
            planner.profile_speed_mps[str(name)] = float(value)
        except (TypeError, ValueError):
            continue


def _overlay_profiles(unattended: UnattendedConfig, raw: Any) -> None:
    """Overlay the unattended profile allow-list (still filtered later)."""
    if not isinstance(raw, (list, tuple)):
        return
    named = tuple(str(p).strip().lower() for p in raw if str(p).strip())
    if named:
        unattended.profiles = named


# ==========================================================================
# The safety floor -- runs last, over everything the layers produced
# ==========================================================================
def _enforce_safety_floor(cfg: AppConfig) -> None:
    """Re-assert the hard safety envelope after all layering (PRD 9 / 11).

    Every scalar in BOUNDS is forced back into its band, the bands that can
    invert are reconciled, the free-text fields are made non-empty, the
    per-profile speeds are capped, and the bind/authentication pair is
    resolved together. Because this runs after YAML and env, no layer can
    relax a safety limit: it can only tighten one.
    """
    for bound in BOUNDS:
        _apply_bound(cfg, bound)

    for lo_path, hi_path, hard_lo, hard_hi in _INVERTIBLE_BANDS:
        if _read_attr(cfg, lo_path) > _read_attr(cfg, hi_path):
            _write_attr(cfg, lo_path, hard_lo)
            _write_attr(cfg, hi_path, hard_hi)

    for path, fallback in _NON_EMPTY_TEXT:
        _write_attr(cfg, path, str(_read_attr(cfg, path)).strip() or fallback)

    _clamp_profile_speeds(cfg.planner)
    _restrict_unattended_profiles(cfg.unattended)
    _enforce_bind_policy(cfg)


def _edge(
    cfg: AppConfig, literal: Optional[float], ref: str, tighten: Callable[[float, float], float]
) -> Optional[float]:
    """One edge of a band: the literal, tightened by a referenced field."""
    if not ref:
        return literal
    referenced = float(_read_attr(cfg, ref))
    return referenced if literal is None else tighten(literal, referenced)


def _apply_bound(cfg: AppConfig, bound: Bound) -> None:
    """Force one resolved field back inside its band."""
    lo = _edge(cfg, bound.lo, bound.lo_ref, max)
    hi = _edge(cfg, bound.hi, bound.hi_ref, min)

    try:
        value = float(_read_attr(cfg, bound.path))
    except (TypeError, ValueError):
        value = math.nan
    if not math.isfinite(value):
        # Degrade to the conservative end, never to the permissive one: an
        # unreadable or infinite limit is a broken config, not a licence.
        fallback = bound.bad
        if fallback is None:
            fallback = lo if lo is not None else hi
        value = float(fallback if fallback is not None else 0.0)

    if hi is not None:
        value = min(value, hi)
    if lo is not None:
        value = max(lo, value)

    _write_attr(cfg, bound.path, int(value) if bound.whole else float(value))


def _clamp_profile_speeds(planner: PlannerConfig) -> None:
    """Every mission profile is capped UNDER the hard speed cap.

    A malformed or non-finite value degrades to 0.0 -- no motion, the safe
    direction -- and negatives collapse to 0.0 as well. The PlannerExecutor
    re-clamps to limits.max_speed at every emitted setpoint, so a profile can
    only ever tighten the envelope.
    """
    for name, raw in list(planner.profile_speed_mps.items()):
        try:
            speed = float(raw)
        except (TypeError, ValueError):
            speed = 0.0
        if not math.isfinite(speed):
            speed = 0.0
        planner.profile_speed_mps[name] = max(0.0, min(speed, MAX_SPEED_CAP))


def _restrict_unattended_profiles(unattended: UnattendedConfig) -> None:
    """Profiles are a SUBSET of the allowed set, never an extension.

    An unknown or wider list falls back to the hard-allowed set rather than
    admitting it, so nothing unattended flies a profile ADR D23 never cleared.
    """
    admitted = tuple(p for p in unattended.profiles if p in UNATTENDED_PROFILES_ALLOWED)
    unattended.profiles = admitted or UNATTENDED_PROFILES_ALLOWED


def is_loopback_host(host: str) -> bool:
    """True when ``host`` binds the socket to this machine only."""
    return str(host).strip() in LOOPBACK_HOSTS


def _enforce_bind_policy(cfg: AppConfig) -> None:
    """A non-loopback control socket REQUIRES signed commands (FM-40).

    The two settings are one decision, so they are resolved together rather
    than left for a deployer to get right twice. Widening the bind is allowed
    -- some deployments genuinely need it -- but it can only be done together
    with authentication, and it can never silently arm the SITL test hooks.
    """
    if not is_loopback_host(cfg.network.host):
        cfg.security.require_signed_commands = True


__all__ = [
    "AppConfig",
    "GuidanceGains",
    "GainTriple",
    "CameraConfig",
    "DetectorConfig",
    "NetworkConfig",
    "FcConfig",
    "TrackingConfig",
    "SafetyConfig",
    "BatteryConfig",
    "PlannerConfig",
    "EnvelopeConfig",
    "UnattendedConfig",
    "GimbalConfig",
    "SecurityConfig",
    "load_config",
    "is_loopback_host",
    "DEFAULT_CONTROL_HOST",
    "LOOPBACK_HOSTS",
    "MAX_SPEED_CAP",
    "MAX_STANDOFF_CEIL_M",
    "MIN_STANDOFF_FLOOR",
    "PROFILE_SPEED_FALLBACK",
    "ENVELOPE_BREACH_MULTIPLE_CAP",
    "ENVELOPE_ESCALATE_CAP_S",
    "ENVELOPE_GEOFENCE_MARGIN_FLOOR_M",
    "ENVELOPE_NFZ_BUFFER_FLOOR_M",
    "ENVELOPE_PEER_HOLD_CAP_S",
    "ENVELOPE_PEER_STALE_CAP_S",
    "ENVELOPE_SEPARATION_FLOOR_M",
    "ENVELOPE_SEPARATION_STALE_FLOOR_M",
    "GIMBAL_PITCH_MAX_DEG",
    "GIMBAL_PITCH_MIN_DEG",
    "UNATTENDED_MAX_ALT_CEIL_M",
    "UNATTENDED_MAX_HOLD_CAP_S",
    "UNATTENDED_MAX_LAPS_CAP",
    "UNATTENDED_MAX_SORTIES_PER_HOUR_CAP",
    "UNATTENDED_MAX_WIND_CAP_MPS",
    "UNATTENDED_MIN_ALT_FLOOR_M",
    "UNATTENDED_PROFILES_ALLOWED",
]
