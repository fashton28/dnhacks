"""
============================================================================
Drone Safety Platform -- COMPANION configuration loader
----------------------------------------------------------------------------
Loads a layered, typed configuration for the companion:

    1. hard-coded safe defaults (mirrors shared DEFAULTS / PRD 9), then
    2. a YAML file (``EIS_CONFIG`` or ``config/default.yaml``), then
    3. environment overrides (the ``EIS_*`` keys documented in ``.env.example``;
       a ``.env`` file is loaded first if present, via python-dotenv when
       available -- otherwise we fall back to a tiny built-in parser so the
       companion still configures on a box without python-dotenv).

The result is a single immutable-ish ``AppConfig`` the orchestrator reads. The
safety envelope is surfaced as an ``eis_companion.types.Limits`` so guidance /
manual / safety all clamp to the same numbers, and the FC geofence params
(``mavlink.failsafe_param_map``) derive from it too.

Pure stdlib + pyyaml (+ optional python-dotenv). No hardware imports, so config
loading is unit-testable on any box.

LAYERING RULE: later layers override earlier ones, but the *safe* defaults are
the floor -- anything missing everywhere falls back to the conservative value.
We NEVER silently relax a safety limit below its hard floor (standoff floor,
speed cap), even if a YAML/env value asks to: ``Limits`` clamping + the
``max_speed_cap`` ceiling are re-asserted after loading.
============================================================================
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from .types import Limits

try:  # pyyaml is a pinned dependency, but degrade gracefully if absent.
    import yaml  # type: ignore
    _HAVE_YAML = True
except Exception:  # pragma: no cover - exercised only on a broken install
    yaml = None  # type: ignore
    _HAVE_YAML = False


# ==========================================================================
# Hard ceilings (PRD 9 / shared DEFAULTS). These are the absolute bounds that
# no config layer may exceed -- the conservative envelope of the whole system.
# ==========================================================================
MAX_SPEED_CAP: float = 8.0       # m/s -- the hard ceiling for max_speed
MIN_STANDOFF_FLOOR: float = 3.0  # m  -- standoff may never be set below this
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

_shared_profile_cache: Optional[Dict[str, float]] = None


def _shared_profile_speeds() -> Dict[str, float]:
    """PROFILE_SPEED_MPS from the shared contract file (shared/shared.py).

    ``shared/`` is not an installed package, so it is loaded by path from the
    monorepo root (the same ``parents[N]`` idiom ``site.py`` uses). Any failure
    (partial checkout, packaged install) falls back to the literal mirror.
    Values are still safety-clamped afterwards in ``_enforce_safety_floor``.
    """
    global _shared_profile_cache
    if _shared_profile_cache is None:
        speeds = dict(PROFILE_SPEED_FALLBACK)
        try:
            import importlib.util
            shared_py = Path(__file__).resolve().parents[3] / "shared" / "shared.py"
            spec = importlib.util.spec_from_file_location("_eis_shared_contract", shared_py)
            if spec is not None and spec.loader is not None:
                import sys
                mod = importlib.util.module_from_spec(spec)
                sys.modules[spec.name] = mod
                spec.loader.exec_module(mod)
                loaded = getattr(mod, "PROFILE_SPEED_MPS", None)
                if isinstance(loaded, dict) and loaded:
                    speeds = {str(k): float(v) for k, v in loaded.items()}
        except Exception:
            pass  # fall back to the mirror; the floor clamp still applies
        _shared_profile_cache = speeds
    return dict(_shared_profile_cache)


# ==========================================================================
# Typed sub-configs
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
    host: str = "0.0.0.0"          # bind address for the control WS server
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

        Honours an explicit override; otherwise builds an RTSP URL from the
        configured host/port. In SITL with no camera this may be empty (the UI
        then renders its mock canvas).
        """
        if self.network.video_url:
            return self.network.video_url
        if self.camera.source in ("sim", "mock"):
            return ""
        return f"rtsp://0.0.0.0:{self.network.video_port}/stream"


# ==========================================================================
# .env loading (python-dotenv if available, else a tiny built-in parser)
# ==========================================================================
def _load_dotenv(start: Optional[Path] = None) -> None:
    """Populate ``os.environ`` from a ``.env`` file if one exists.

    Existing environment variables WIN over the file (so an explicitly exported
    ``EIS_*`` always overrides ``.env``). Walks up from ``start`` (or cwd) to
    find the nearest ``.env``. Never raises.
    """
    try:
        from dotenv import load_dotenv, find_dotenv  # type: ignore
        path = find_dotenv(usecwd=True)
        if path:
            load_dotenv(path, override=False)
        return
    except Exception:
        pass  # fall through to the built-in parser

    # Built-in fallback: find the nearest .env walking upward.
    here = (start or Path.cwd()).resolve()
    for d in [here, *here.parents]:
        candidate = d / ".env"
        if candidate.is_file():
            _parse_env_file(candidate)
            return


def _parse_env_file(path: Path) -> None:
    """Minimal KEY=VALUE .env parser (no shell interpolation). Never raises."""
    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            # strip an inline comment and surrounding quotes
            val = val.split("#", 1)[0].strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val
    except Exception:
        pass


# ==========================================================================
# Env coercion helpers
# ==========================================================================
def _env(name: str) -> Optional[str]:
    v = os.environ.get(name)
    if v is None:
        return None
    v = v.strip()
    return v if v != "" else None


def _env_float(name: str) -> Optional[float]:
    v = _env(name)
    if v is None:
        return None
    try:
        return float(v)
    except ValueError:
        return None


def _env_int(name: str) -> Optional[int]:
    v = _env_float(name)
    return None if v is None else int(v)


def _env_bool(name: str) -> Optional[bool]:
    v = _env(name)
    if v is None:
        return None
    return v.lower() in ("1", "true", "yes", "on")


# ==========================================================================
# YAML loading
# ==========================================================================
def _read_yaml(path: Path) -> Dict[str, Any]:
    """Read a YAML mapping. Returns {} for a missing/empty file. Raises on bad YAML."""
    if not path.is_file():
        return {}
    text = path.read_text(encoding="utf-8")
    if not _HAVE_YAML:
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


def _section(d: Dict[str, Any], key: str) -> Dict[str, Any]:
    v = d.get(key)
    return v if isinstance(v, dict) else {}


def _g(d: Dict[str, Any], key: str, default: Any) -> Any:
    """Get d[key] if present and not None, else default."""
    v = d.get(key, None)
    return default if v is None else v


# ==========================================================================
# The public entry point
# ==========================================================================
DEFAULT_CONFIG_REL = "config/default.yaml"


def _resolve_config_path(explicit: Optional[str]) -> Optional[Path]:
    """Resolve which YAML to load: explicit arg, then EIS_CONFIG, then default."""
    candidate = explicit or _env("EIS_CONFIG") or DEFAULT_CONFIG_REL
    p = Path(candidate)
    if p.is_file():
        return p
    # try resolving relative to the package's companion root (src/.. -> companion/)
    pkg_root = Path(__file__).resolve().parents[2]  # .../companion
    alt = pkg_root / candidate
    if alt.is_file():
        return alt
    # last resort: the conventional companion/config/<name>
    alt2 = pkg_root / "config" / Path(candidate).name
    if alt2.is_file():
        return alt2
    return None


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
    raw: Dict[str, Any] = _read_yaml(cfg_path) if cfg_path is not None else {}

    cfg = _from_yaml(raw)
    cfg.source_path = str(cfg_path) if cfg_path is not None else None

    if use_env:
        _apply_env_overrides(cfg)

    _enforce_safety_floor(cfg)
    return cfg


def _from_yaml(raw: Dict[str, Any]) -> AppConfig:
    """Build an AppConfig from a parsed YAML mapping (missing keys -> defaults)."""
    lim_d = _section(raw, "limits")
    limits = Limits(
        max_speed=float(_g(lim_d, "max_speed", 2.0)),
        min_speed=float(_g(lim_d, "min_speed", 0.5)),
        max_climb_rate=float(_g(lim_d, "max_climb_rate", 1.5)),
        max_yaw_rate=float(_g(lim_d, "max_yaw_rate", 45.0)),
        max_altitude=float(_g(lim_d, "max_altitude", 30.0)),
        standoff=float(_g(lim_d, "standoff", 5.0)),
        min_standoff=float(_g(lim_d, "min_standoff", 3.0)),
        deadzone=float(_g(lim_d, "deadzone", 0.09)),
        manual_watchdog_ms=int(_g(lim_d, "manual_watchdog_ms", 500)),
        ground_link_timeout_ms=int(_g(lim_d, "ground_link_timeout_ms", 2000)),
    )

    g_d = _section(raw, "guidance")
    gains_d = _section(g_d, "gains")
    gains = GuidanceGains(
        yaw=_gain(gains_d.get("yaw"), GainTriple(90.0, 0.0, 4.0)),
        altitude=_gain(gains_d.get("altitude"), GainTriple(2.0, 0.0, 0.1)),
        forward=_gain(gains_d.get("forward"), GainTriple(0.6, 0.0, 0.05)),
    )

    cam_d = _section(raw, "camera")
    camera = CameraConfig(
        source=str(_g(cam_d, "source", "csi")),
        device=str(_g(cam_d, "device", "/dev/video0")),
        file=str(_g(cam_d, "file", "")),
        width=int(_g(cam_d, "width", 1280)),
        height=int(_g(cam_d, "height", 720)),
        fps=int(_g(cam_d, "fps", 30)),
        vfov_deg=float(_g(cam_d, "vfov_deg", 41.0)),
    )

    det_d = _section(raw, "detector")
    detector = DetectorConfig(
        model_path=str(_g(det_d, "model_path", "weights/yolo11n.pt")),
        engine_path=str(_g(det_d, "engine_path", "weights/yolo11n.engine")),
        conf=float(_g(det_d, "conf", 0.4)),
        person_height_m=float(_g(det_d, "person_height_m", 1.7)),
    )

    net_d = _section(raw, "network")
    network = NetworkConfig(
        host=str(_g(net_d, "host", "0.0.0.0")),
        control_port=int(_g(net_d, "control_port", 8765)),
        video_port=int(_g(net_d, "video_port", 8554)),
        webrtc_port=int(_g(net_d, "webrtc_port", 8889)),
        video_bitrate_kbps=int(_g(net_d, "video_bitrate_kbps", 2500)),
        video_url=str(_g(net_d, "video_url", "")),
    )

    fc_d = _section(raw, "fc")
    fc = FcConfig(
        connection=str(_g(fc_d, "connection", "udp:127.0.0.1:14550")),
        baud=int(_g(fc_d, "baud", 921600)),
        sysid=int(_g(fc_d, "sysid", 1)),
        gcs_sysid=int(_g(fc_d, "gcs_sysid", 255)),
    )

    trk_d = _section(raw, "tracking")
    tracking = TrackingConfig(
        lost_timeout=float(_g(trk_d, "lost_timeout", 1.0)),
        max_age=float(_g(trk_d, "max_age", 1.5)),
        iou_threshold=float(_g(trk_d, "iou_threshold", 0.3)),
        min_hits=int(_g(trk_d, "min_hits", 2)),
    )

    saf_d = _section(raw, "safety")
    safety = SafetyConfig(
        geofence_radius_m=float(_g(saf_d, "geofence_radius_m", GEOFENCE_RADIUS_DEFAULT)),
        low_battery_action=str(_g(saf_d, "low_battery_action", "rtl")),
        critical_battery_action=str(_g(saf_d, "critical_battery_action", "land")),
        min_battery_remaining=float(_g(saf_d, "min_battery_remaining", 20.0)),
        rc_override_primacy=bool(_g(saf_d, "rc_override_primacy", True)),
    )

    bat_d = _section(raw, "battery")
    battery = BatteryConfig(
        nominal_endurance_s=float(_g(bat_d, "nominal_endurance_s", 1500.0)),
        reserve_pct=float(_g(bat_d, "reserve_pct", 25.0)),
        max_sortie_s=float(_g(bat_d, "max_sortie_s", MAX_SORTIE_CAP_S)),
        dispatch_min_soc_pct=float(
            _g(bat_d, "dispatch_min_soc_pct", MIN_DISPATCH_SOC_PCT)
        ),
        cell_imbalance_max_v=float(
            _g(bat_d, "cell_imbalance_max_v", MAX_CELL_IMBALANCE_V)
        ),
        batt_temp_max_c=float(_g(bat_d, "batt_temp_max_c", MAX_BATT_TEMP_C)),
        capacity_mah=float(_g(bat_d, "capacity_mah", 5000.0)),
        cell_count=int(_g(bat_d, "cell_count", 4)),
        demo_charge_scale_s=float(_g(bat_d, "demo_charge_scale_s", 30.0)),
        estimated_return_s=float(_g(bat_d, "estimated_return_s", 30.0)),
    )

    pl_d = _section(raw, "planner")
    speeds = _shared_profile_speeds()
    speeds_raw = pl_d.get("profile_speed_mps")
    if isinstance(speeds_raw, dict):
        for k, v in speeds_raw.items():
            try:
                speeds[str(k)] = float(v)
            except (TypeError, ValueError):
                pass  # bad YAML value -> keep the shared default for this profile
    planner = PlannerConfig(
        profile_speed_mps=speeds,
        site_file=str(_g(pl_d, "site_file", "")),
        arrival_radius_m=float(_g(pl_d, "arrival_radius_m", 2.0)),
        staging_arrival_radius_m=float(_g(pl_d, "staging_arrival_radius_m", 15.0)),
        heartbeat_timeout_ms=int(_g(pl_d, "heartbeat_timeout_ms", 2000)),
    )

    env_d = _section(raw, "envelope")
    envelope = EnvelopeConfig(
        hz=float(_g(env_d, "hz", ENVELOPE_HZ)),
        publish_hz=float(_g(env_d, "publish_hz", ENVELOPE_PUBLISH_HZ)),
        geofence_margin_m=float(
            _g(env_d, "geofence_margin_m", ENVELOPE_GEOFENCE_MARGIN_FLOOR_M)
        ),
        nfz_buffer_m=float(_g(env_d, "nfz_buffer_m", ENVELOPE_NFZ_BUFFER_FLOOR_M)),
        separation_m=float(_g(env_d, "separation_m", ENVELOPE_SEPARATION_FLOOR_M)),
        separation_stale_m=float(
            _g(env_d, "separation_stale_m", ENVELOPE_SEPARATION_STALE_FLOOR_M)
        ),
        peer_stale_s=float(_g(env_d, "peer_stale_s", ENVELOPE_PEER_STALE_CAP_S)),
        peer_hold_s=float(_g(env_d, "peer_hold_s", ENVELOPE_PEER_HOLD_CAP_S)),
        escalate_after_s=float(
            _g(env_d, "escalate_after_s", ENVELOPE_ESCALATE_CAP_S)
        ),
        breach_multiple=float(
            _g(env_d, "breach_multiple", ENVELOPE_BREACH_MULTIPLE_CAP)
        ),
        hysteresis_m=float(_g(env_d, "hysteresis_m", 2.0)),
        recovery_s=float(_g(env_d, "recovery_s", 2.0)),
    )

    un_d = _section(raw, "unattended")
    profiles_raw = un_d.get("profiles")
    profiles = UNATTENDED_PROFILES_ALLOWED
    if isinstance(profiles_raw, (list, tuple)) and profiles_raw:
        profiles = tuple(str(p).strip().lower() for p in profiles_raw if str(p).strip())
    unattended = UnattendedConfig(
        min_alt_m=float(_g(un_d, "min_alt_m", UNATTENDED_MIN_ALT_FLOOR_M)),
        max_alt_m=float(_g(un_d, "max_alt_m", UNATTENDED_MAX_ALT_CEIL_M)),
        max_laps=float(_g(un_d, "max_laps", UNATTENDED_MAX_LAPS_CAP)),
        max_hold_s=float(_g(un_d, "max_hold_s", UNATTENDED_MAX_HOLD_CAP_S)),
        max_sorties_per_hour=int(
            _g(un_d, "max_sorties_per_hour", UNATTENDED_MAX_SORTIES_PER_HOUR_CAP)
        ),
        max_wind_mps=float(_g(un_d, "max_wind_mps", UNATTENDED_MAX_WIND_CAP_MPS)),
        profiles=profiles,
    )

    gim_d = _section(raw, "gimbal")
    gimbal = GimbalConfig(
        enabled=bool(_g(gim_d, "enabled", True)),
        pitch_min_deg=float(_g(gim_d, "pitch_min_deg", GIMBAL_PITCH_MIN_DEG)),
        pitch_max_deg=float(_g(gim_d, "pitch_max_deg", GIMBAL_PITCH_MAX_DEG)),
        slew_rate_dps=float(_g(gim_d, "slew_rate_dps", 30.0)),
        use_gimbal_manager=bool(_g(gim_d, "use_gimbal_manager", False)),
    )

    sec_d = _section(raw, "security")
    security = SecurityConfig(
        session_key_env=str(_g(sec_d, "session_key_env", "EIS_SESSION_KEY")),
        max_command_age_ms=int(_g(sec_d, "max_command_age_ms", 30_000)),
        require_signed_commands=bool(_g(sec_d, "require_signed_commands", False)),
        audit_path=str(_g(sec_d, "audit_path", "")),
    )

    return AppConfig(
        sitl=bool(_g(raw, "sitl", True)),
        limits=limits,
        gains=gains,
        camera=camera,
        detector=detector,
        network=network,
        fc=fc,
        tracking=tracking,
        safety=safety,
        battery=battery,
        planner=planner,
        envelope=envelope,
        unattended=unattended,
        gimbal=gimbal,
        security=security,
        vehicle_id=str(_g(raw, "vehicle_id", "eis-1")),
    )


def _gain(raw: Any, default: GainTriple) -> GainTriple:
    """Parse a gain triple from a YAML mapping {kp,ki,kd} or a [kp,ki,kd] list."""
    if isinstance(raw, dict):
        return GainTriple(
            kp=float(_g(raw, "kp", default.kp)),
            ki=float(_g(raw, "ki", default.ki)),
            kd=float(_g(raw, "kd", default.kd)),
        )
    if isinstance(raw, (list, tuple)) and len(raw) >= 3:
        return GainTriple(float(raw[0]), float(raw[1]), float(raw[2]))
    return replace(default)


def _apply_env_overrides(cfg: AppConfig) -> None:
    """Apply ``EIS_*`` environment overrides documented in .env.example."""
    # link / sitl
    b = _env_bool("EIS_SITL")
    if b is not None:
        cfg.sitl = b

    # network
    p = _env_int("EIS_CONTROL_PORT")
    if p is not None:
        cfg.network.control_port = p
    p = _env_int("EIS_VIDEO_PORT")
    if p is not None:
        cfg.network.video_port = p
    p = _env_int("EIS_WEBRTC_PORT")
    if p is not None:
        cfg.network.webrtc_port = p
    p = _env_int("EIS_VIDEO_BITRATE")
    if p is not None:
        cfg.network.video_bitrate_kbps = p
    u = _env("EIS_VIDEO_URL")
    if u is not None:
        cfg.network.video_url = u

    # fc link
    c = _env("EIS_FC_CONNECTION")
    if c is not None:
        cfg.fc.connection = c
    i = _env_int("EIS_FC_BAUD")
    if i is not None:
        cfg.fc.baud = i
    i = _env_int("EIS_MAVLINK_SYSID")
    if i is not None:
        cfg.fc.sysid = i
    i = _env_int("EIS_GCS_SYSID")
    if i is not None:
        cfg.fc.gcs_sysid = i

    # camera / detector
    s = _env("EIS_CAMERA_SOURCE")
    if s is not None:
        cfg.camera.source = s
    s = _env("EIS_CAMERA_DEVICE")
    if s is not None:
        cfg.camera.device = s
    i = _env_int("EIS_CAMERA_WIDTH")
    if i is not None:
        cfg.camera.width = i
    i = _env_int("EIS_CAMERA_HEIGHT")
    if i is not None:
        cfg.camera.height = i
    i = _env_int("EIS_CAMERA_FPS")
    if i is not None:
        cfg.camera.fps = i
    s = _env("EIS_MODEL_PATH")
    if s is not None:
        cfg.detector.model_path = s
    s = _env("EIS_ENGINE_PATH")
    if s is not None:
        cfg.detector.engine_path = s
    f = _env_float("EIS_DETECT_CONF")
    if f is not None:
        cfg.detector.conf = f

    # limits / safety
    f = _env_float("EIS_STANDOFF_M")
    if f is not None:
        cfg.limits.standoff = f
    f = _env_float("EIS_MAX_SPEED_MPS")
    if f is not None:
        cfg.limits.max_speed = f
    f = _env_float("EIS_MAX_ALT_M")
    if f is not None:
        cfg.limits.max_altitude = f
    f = _env_float("EIS_GEOFENCE_RADIUS_M")
    if f is not None:
        cfg.safety.geofence_radius_m = f
    f = _env_float("EIS_MAX_SORTIE_S")
    if f is not None:
        cfg.battery.max_sortie_s = f
    f = _env_float("EIS_DISPATCH_MIN_SOC_PCT")
    if f is not None:
        cfg.battery.dispatch_min_soc_pct = f
    f = _env_float("EIS_CELL_IMBALANCE_MAX_V")
    if f is not None:
        cfg.battery.cell_imbalance_max_v = f
    f = _env_float("EIS_BATT_TEMP_MAX_C")
    if f is not None:
        cfg.battery.batt_temp_max_c = f
    f = _env_float("DEMO_CHARGE_SCALE")
    if f is not None:
        cfg.battery.demo_charge_scale_s = f
    s = _env("EIS_VEHICLE_ID")
    if s is not None:
        cfg.vehicle_id = s

    # runtime envelope monitor (may only tighten -- see _enforce_safety_floor)
    f = _env_float("EIS_ENVELOPE_SEPARATION_M")
    if f is not None:
        cfg.envelope.separation_m = f
    f = _env_float("EIS_ENVELOPE_SEPARATION_STALE_M")
    if f is not None:
        cfg.envelope.separation_stale_m = f
    f = _env_float("EIS_ENVELOPE_PEER_STALE_S")
    if f is not None:
        cfg.envelope.peer_stale_s = f
    f = _env_float("EIS_ENVELOPE_PEER_HOLD_S")
    if f is not None:
        cfg.envelope.peer_hold_s = f
    f = _env_float("EIS_ENVELOPE_ESCALATE_AFTER_S")
    if f is not None:
        cfg.envelope.escalate_after_s = f
    f = _env_float("EIS_ENVELOPE_GEOFENCE_MARGIN_M")
    if f is not None:
        cfg.envelope.geofence_margin_m = f
    f = _env_float("EIS_ENVELOPE_NFZ_BUFFER_M")
    if f is not None:
        cfg.envelope.nfz_buffer_m = f

    # UNATTENDED_ENVELOPE (may only tighten)
    f = _env_float("EIS_UNATTENDED_MIN_ALT_M")
    if f is not None:
        cfg.unattended.min_alt_m = f
    f = _env_float("EIS_UNATTENDED_MAX_ALT_M")
    if f is not None:
        cfg.unattended.max_alt_m = f
    f = _env_float("EIS_UNATTENDED_MAX_HOLD_S")
    if f is not None:
        cfg.unattended.max_hold_s = f
    i = _env_int("EIS_UNATTENDED_MAX_SORTIES_PER_HOUR")
    if i is not None:
        cfg.unattended.max_sorties_per_hour = i
    f = _env_float("EIS_UNATTENDED_MAX_WIND_MPS")
    if f is not None:
        cfg.unattended.max_wind_mps = f

    # gimbal
    b = _env_bool("EIS_GIMBAL_ENABLED")
    if b is not None:
        cfg.gimbal.enabled = b
    f = _env_float("EIS_GIMBAL_PITCH_MIN_DEG")
    if f is not None:
        cfg.gimbal.pitch_min_deg = f
    f = _env_float("EIS_GIMBAL_PITCH_MAX_DEG")
    if f is not None:
        cfg.gimbal.pitch_max_deg = f
    f = _env_float("EIS_GIMBAL_SLEW_RATE_DPS")
    if f is not None:
        cfg.gimbal.slew_rate_dps = f
    b = _env_bool("EIS_GIMBAL_MANAGER")
    if b is not None:
        cfg.gimbal.use_gimbal_manager = b

    # command signing / audit
    s = _env("EIS_SESSION_KEY_ENV")
    if s is not None:
        cfg.security.session_key_env = s
    i = _env_int("EIS_COMMAND_MAX_AGE_MS")
    if i is not None:
        cfg.security.max_command_age_ms = i
    b = _env_bool("EIS_REQUIRE_SIGNED_COMMANDS")
    if b is not None:
        cfg.security.require_signed_commands = b
    s = _env("EIS_AUDIT_PATH")
    if s is not None:
        cfg.security.audit_path = s

    # planner / site model
    s = _env("EIS_SITE_FILE")
    if s is not None:
        cfg.planner.site_file = s
    f = _env_float("EIS_STAGING_RADIUS_M")
    if f is not None:
        cfg.planner.staging_arrival_radius_m = f
    i = _env_int("EIS_PLANNER_HEARTBEAT_TIMEOUT_MS")
    if i is not None:
        cfg.planner.heartbeat_timeout_ms = i


def _enforce_safety_floor(cfg: AppConfig) -> None:
    """Re-assert the hard safety envelope after all layering (PRD 9 / 11).

    No config layer may set max_speed above the cap, push standoff below its
    floor, or invert the speed band. This runs last so neither YAML nor env can
    relax a safety limit below its hard bound.
    """
    L = cfg.limits

    # standoff floor (never below the hard min, and the floor itself never below
    # the system-wide MIN_STANDOFF_FLOOR)
    L.min_standoff = max(MIN_STANDOFF_FLOOR, float(L.min_standoff))
    L.standoff = max(L.min_standoff, float(L.standoff))

    # speed band: clamp the configurable cap to the hard ceiling, keep min sane
    L.max_speed = max(0.1, min(float(L.max_speed), MAX_SPEED_CAP))
    L.min_speed = max(0.0, min(float(L.min_speed), L.max_speed))

    # climb / yaw / altitude must be positive
    L.max_climb_rate = max(0.1, float(L.max_climb_rate))
    L.max_yaw_rate = max(1.0, float(L.max_yaw_rate))
    L.max_altitude = max(1.0, float(L.max_altitude))

    # watchdogs must be positive
    L.manual_watchdog_ms = max(50, int(L.manual_watchdog_ms))
    L.ground_link_timeout_ms = max(200, int(L.ground_link_timeout_ms))

    # geofence radius floor
    cfg.safety.geofence_radius_m = max(10.0, float(cfg.safety.geofence_radius_m))

    # These are hard safety bounds: overrides may only tighten them.
    cfg.battery.max_sortie_s = max(
        1.0, min(float(cfg.battery.max_sortie_s), MAX_SORTIE_CAP_S)
    )
    cfg.battery.dispatch_min_soc_pct = min(
        100.0, max(float(cfg.battery.dispatch_min_soc_pct), MIN_DISPATCH_SOC_PCT)
    )
    cfg.battery.cell_imbalance_max_v = max(
        0.001,
        min(float(cfg.battery.cell_imbalance_max_v), MAX_CELL_IMBALANCE_V),
    )
    cfg.battery.batt_temp_max_c = max(
        1.0, min(float(cfg.battery.batt_temp_max_c), MAX_BATT_TEMP_C)
    )
    cfg.battery.nominal_endurance_s = max(1.0, float(cfg.battery.nominal_endurance_s))
    cfg.battery.reserve_pct = min(99.0, max(0.0, float(cfg.battery.reserve_pct)))
    cfg.battery.capacity_mah = max(1.0, float(cfg.battery.capacity_mah))
    cfg.battery.cell_count = max(1, int(cfg.battery.cell_count))
    cfg.battery.demo_charge_scale_s = max(1.0, float(cfg.battery.demo_charge_scale_s))
    cfg.battery.estimated_return_s = max(0.0, float(cfg.battery.estimated_return_s))
    cfg.planner.heartbeat_timeout_ms = max(200, int(cfg.planner.heartbeat_timeout_ms))
    cfg.vehicle_id = str(cfg.vehicle_id).strip() or "eis-1"

    # planner profile speeds: every profile is clamped UNDER the hard speed cap
    # (profiles may only tighten the envelope). A malformed/non-finite value
    # degrades to 0.0 = no motion, the safe direction; negative -> 0.0. The
    # PlannerExecutor re-clamps to limits.max_speed at every emitted setpoint.
    speeds = cfg.planner.profile_speed_mps
    for name in list(speeds.keys()):
        try:
            v = float(speeds[name])
        except (TypeError, ValueError):
            v = 0.0
        if not math.isfinite(v):
            v = 0.0
        speeds[name] = max(0.0, min(v, MAX_SPEED_CAP))

    # planner thresholds must stay sane (arrival radii can't collapse to 0)
    cfg.planner.arrival_radius_m = max(0.5, float(cfg.planner.arrival_radius_m))
    cfg.planner.staging_arrival_radius_m = max(
        1.0, float(cfg.planner.staging_arrival_radius_m)
    )

    _enforce_envelope_floor(cfg)
    _enforce_unattended_floor(cfg)
    _enforce_gimbal_floor(cfg)
    cfg.security.max_command_age_ms = max(
        1_000, min(300_000, int(cfg.security.max_command_age_ms))
    )
    cfg.security.session_key_env = (
        str(cfg.security.session_key_env).strip() or "EIS_SESSION_KEY"
    )


def _safe(value: Any, fallback: float) -> float:
    """Coerce to a finite float, degrading to ``fallback`` (the safe value)."""
    try:
        result = float(value)
    except (TypeError, ValueError):
        return float(fallback)
    return result if math.isfinite(result) else float(fallback)


def _enforce_envelope_floor(cfg: AppConfig) -> None:
    """Envelope-monitor thresholds: config may only make the monitor STRICTER.

    Distances that protect (separation, geofence margin, NFZ buffer) may only
    grow; timers that delay a response (staleness tolerance, escalation dwell)
    may only shrink; the drift multiple that decides hold may only tighten.
    """
    e = cfg.envelope
    e.separation_m = max(ENVELOPE_SEPARATION_FLOOR_M, _safe(
        e.separation_m, ENVELOPE_SEPARATION_FLOOR_M))
    e.separation_stale_m = max(
        ENVELOPE_SEPARATION_STALE_FLOOR_M,
        e.separation_m,
        _safe(e.separation_stale_m, ENVELOPE_SEPARATION_STALE_FLOOR_M),
    )
    e.peer_stale_s = max(0.1, min(
        ENVELOPE_PEER_STALE_CAP_S, _safe(e.peer_stale_s, ENVELOPE_PEER_STALE_CAP_S)))
    e.peer_hold_s = max(e.peer_stale_s, min(
        ENVELOPE_PEER_HOLD_CAP_S, _safe(e.peer_hold_s, ENVELOPE_PEER_HOLD_CAP_S)))
    e.escalate_after_s = max(0.1, min(
        ENVELOPE_ESCALATE_CAP_S, _safe(e.escalate_after_s, ENVELOPE_ESCALATE_CAP_S)))
    e.breach_multiple = max(1.0, min(
        ENVELOPE_BREACH_MULTIPLE_CAP,
        _safe(e.breach_multiple, ENVELOPE_BREACH_MULTIPLE_CAP),
    ))
    e.geofence_margin_m = max(ENVELOPE_GEOFENCE_MARGIN_FLOOR_M, _safe(
        e.geofence_margin_m, ENVELOPE_GEOFENCE_MARGIN_FLOOR_M))
    e.nfz_buffer_m = max(ENVELOPE_NFZ_BUFFER_FLOOR_M, _safe(
        e.nfz_buffer_m, ENVELOPE_NFZ_BUFFER_FLOOR_M))
    e.hysteresis_m = max(0.0, _safe(e.hysteresis_m, 2.0))
    e.recovery_s = max(0.0, _safe(e.recovery_s, 2.0))
    # Rates: the monitor runs at the control rate and publishes no faster than
    # it ticks. Neither can be configured to zero (that would be an off switch).
    e.hz = max(1.0, min(50.0, _safe(e.hz, ENVELOPE_HZ)))
    e.publish_hz = max(0.5, min(e.hz, _safe(e.publish_hz, ENVELOPE_PUBLISH_HZ)))


def _enforce_unattended_floor(cfg: AppConfig) -> None:
    """UNATTENDED_ENVELOPE (ADR D23): config may only TIGHTEN, never widen.

    A band that inverts under tightening (min pushed above max) collapses to
    the hard band rather than becoming empty-and-silent: a refusal the
    operator can read beats a configuration that quietly grounds the vehicle.
    """
    u = cfg.unattended
    u.min_alt_m = max(UNATTENDED_MIN_ALT_FLOOR_M, _safe(
        u.min_alt_m, UNATTENDED_MIN_ALT_FLOOR_M))
    u.max_alt_m = min(UNATTENDED_MAX_ALT_CEIL_M, _safe(
        u.max_alt_m, UNATTENDED_MAX_ALT_CEIL_M))
    if u.min_alt_m > u.max_alt_m:
        u.min_alt_m, u.max_alt_m = UNATTENDED_MIN_ALT_FLOOR_M, UNATTENDED_MAX_ALT_CEIL_M
    u.max_laps = max(0.0, min(
        UNATTENDED_MAX_LAPS_CAP, _safe(u.max_laps, UNATTENDED_MAX_LAPS_CAP)))
    u.max_hold_s = max(0.0, min(
        UNATTENDED_MAX_HOLD_CAP_S, _safe(u.max_hold_s, UNATTENDED_MAX_HOLD_CAP_S)))
    try:
        sorties = int(u.max_sorties_per_hour)
    except (TypeError, ValueError):
        sorties = UNATTENDED_MAX_SORTIES_PER_HOUR_CAP
    u.max_sorties_per_hour = max(0, min(UNATTENDED_MAX_SORTIES_PER_HOUR_CAP, sorties))
    u.max_wind_mps = max(0.0, min(
        UNATTENDED_MAX_WIND_CAP_MPS, _safe(u.max_wind_mps, UNATTENDED_MAX_WIND_CAP_MPS)))
    # Profiles are a subset, never an extension: an unknown or wider profile
    # list falls back to the hard-allowed set rather than admitting it.
    allowed = tuple(p for p in u.profiles if p in UNATTENDED_PROFILES_ALLOWED)
    u.profiles = allowed or UNATTENDED_PROFILES_ALLOWED


def _enforce_gimbal_floor(cfg: AppConfig) -> None:
    """Gimbal travel: config may narrow it, never widen past -30..90 deg."""
    g = cfg.gimbal
    lo = max(GIMBAL_PITCH_MIN_DEG, _safe(g.pitch_min_deg, GIMBAL_PITCH_MIN_DEG))
    hi = min(GIMBAL_PITCH_MAX_DEG, _safe(g.pitch_max_deg, GIMBAL_PITCH_MAX_DEG))
    if lo > hi:
        lo, hi = GIMBAL_PITCH_MIN_DEG, GIMBAL_PITCH_MAX_DEG
    g.pitch_min_deg, g.pitch_max_deg = lo, hi
    g.slew_rate_dps = max(1.0, min(
        GIMBAL_SLEW_RATE_CAP_DPS, _safe(g.slew_rate_dps, 30.0)))


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
    "MAX_SPEED_CAP",
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
