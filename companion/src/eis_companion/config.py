"""
============================================================================
Eye in the Sky -- COMPANION configuration loader
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
GEOFENCE_RADIUS_DEFAULT: float = 60.0  # m

# Fallback mirror of the shared contract's PROFILE_SPEED_MPS (shared/shared.py /
# shared/shared.ts). The authoritative copy is loaded from shared/shared.py at
# config time when the monorepo checkout is present (_shared_profile_speeds);
# this literal keeps the companion configurable on a partial install. Either
# way every value is clamped under MAX_SPEED_CAP in _enforce_safety_floor --
# mission profiles may only TIGHTEN the speed envelope, never relax it.
PROFILE_SPEED_FALLBACK: Dict[str, float] = {
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
                mod = importlib.util.module_from_spec(spec)
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
    planner: PlannerConfig = field(default_factory=PlannerConfig)
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
        planner=planner,
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

    # planner / site model
    s = _env("EIS_SITE_FILE")
    if s is not None:
        cfg.planner.site_file = s
    f = _env_float("EIS_STAGING_RADIUS_M")
    if f is not None:
        cfg.planner.staging_arrival_radius_m = f


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
    "PlannerConfig",
    "load_config",
    "MAX_SPEED_CAP",
    "MIN_STANDOFF_FLOOR",
    "PROFILE_SPEED_FALLBACK",
]
