"""
============================================================================
Eye in the Sky -- COMPANION site-model loader (docs/SITE_CONTRACT.md)
----------------------------------------------------------------------------
Loads the plant site model (home, perimeter geofence, no-fly zones, altitude
band, staging points) from the single site JSON file that the whole system
shares. Nothing outside ``site/`` may hardcode plant geometry -- consumers get
it from here as plain dataclasses.

File selection (mirrors docs/SITE_CONTRACT.md):
  * ``load_site(path)`` takes an EXPLICIT path -- the orchestrator passes the
    configured value.
  * ``resolve_site_path()`` resolves the conventional location: explicit arg,
    then the ``EIS_SITE_FILE`` env var, then the default ``site/site.json`` --
    relative paths are anchored at the repo root.
  * ``load_site_from_env()`` composes the two for callers that just want the
    conventional file.

Schema semantics (binding, see docs/SITE_CONTRACT.md):
  * Coordinates are WGS84, ordered ``[lat, lon]`` (never lon-first).
  * Polygons are open rings (closing edge implicit); either winding is fine,
    so this loader preserves vertex order verbatim.
  * ``alt_band_m`` is metres AGL relative to home; it may only tighten, never
    relax, the hard limits asserted in ``config.py`` (enforced there, not here).
  * ``nfz[].ceiling_m``: flight inside the polygon at/below the ceiling is
    forbidden; overflight above it is permitted.
  * ``perimeter`` is the outer geofence -- uploaded to ArduPilot's polygon
    fence on connect (``Vehicle.upload_geofence``) and checked independently
    ground-side.

This module deliberately lives OUTSIDE ``control/``: it does file I/O.
Pure-logic control code must receive site data as plain arguments, never read
the file itself. Pure stdlib only (json / os / pathlib / dataclasses).

Validation errors raise ``ValueError`` with a message naming the offending
field. A missing file raises the natural ``FileNotFoundError``.
============================================================================
"""
from __future__ import annotations

import json
import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, List, Optional, Tuple

# Env var + default location per docs/SITE_CONTRACT.md ("File selection").
SITE_FILE_ENV = "EIS_SITE_FILE"
DEFAULT_SITE_REL = "site/site.json"

# Ground-truth labels a staging point may carry (SITE_CONTRACT schema).
TRUTH_LABELS = ("vehicle", "breach", "structure", "false_alarm")

LatLon = Tuple[float, float]


# --------------------------------------------------------------------------
# Parsed site model -- simple dataclasses, plain data only
# --------------------------------------------------------------------------
@dataclass
class Home:
    """The home/launch point. ``alt_m`` is terrain elevation in metres AMSL."""
    lat: float
    lon: float
    alt_m: float


@dataclass
class NoFlyZone:
    """A polygon NFZ: flight inside at or below ``ceiling_m`` AGL is forbidden."""
    name: str
    polygon: List[LatLon]        # open ring, [lat, lon] order preserved
    ceiling_m: float


@dataclass
class AltBand:
    """Permitted flight band in metres AGL relative to home."""
    min_m: float
    max_m: float


@dataclass
class StagingPoint:
    """A pre-surveyed observation point with its still image + truth label."""
    id: str
    lat: float
    lon: float
    image: str                   # repo-root-relative path to the still
    truth: str                   # one of TRUTH_LABELS


@dataclass
class Site:
    """The full parsed site model (docs/SITE_CONTRACT.md schema)."""
    home: Home
    perimeter: List[LatLon]      # outer geofence, open ring of (lat, lon)
    nfz: List[NoFlyZone] = field(default_factory=list)
    alt_band: AltBand = field(default_factory=lambda: AltBand(0.0, 0.0))
    staging: List[StagingPoint] = field(default_factory=list)
    source_path: Optional[str] = None   # where this model was loaded from


# --------------------------------------------------------------------------
# Path resolution (explicit arg > EIS_SITE_FILE > site/site.json @ repo root)
# --------------------------------------------------------------------------
def _repo_root() -> Path:
    """The monorepo root (…/companion/src/eis_companion -> up 3)."""
    return Path(__file__).resolve().parents[3]


def resolve_site_path(explicit: Optional[str] = None) -> Path:
    """Resolve which site JSON to load. Does not require the file to exist.

    Order: ``explicit`` arg, then the ``EIS_SITE_FILE`` env var, then the
    default ``site/site.json``. Relative candidates that don't resolve from
    the current working directory are anchored at the repo root, per
    docs/SITE_CONTRACT.md ("path … relative to the repo root").
    """
    candidate = explicit or os.environ.get(SITE_FILE_ENV) or DEFAULT_SITE_REL
    p = Path(candidate)
    if p.is_absolute() or p.is_file():
        return p
    return _repo_root() / candidate


# --------------------------------------------------------------------------
# Loading + validation
# --------------------------------------------------------------------------
def load_site(path: "str | os.PathLike[str]") -> Site:
    """Parse + validate the site JSON at ``path`` into a :class:`Site`.

    The path is EXPLICIT -- the caller passes its configured value (use
    :func:`resolve_site_path` / :func:`load_site_from_env` for the
    conventional env-var lookup). Raises ``ValueError`` on schema violations
    and ``FileNotFoundError`` when the file is missing.
    """
    p = Path(path)
    with p.open("r", encoding="utf-8") as f:
        try:
            raw = json.load(f)
        except json.JSONDecodeError as exc:
            raise ValueError(f"site: {p} is not valid JSON: {exc}") from exc
    if not isinstance(raw, dict):
        raise ValueError(f"site: {p} must contain a JSON object at the top level")

    home = _parse_home(raw.get("home"))
    perimeter = _parse_polygon(raw.get("perimeter"), "perimeter")
    nfz = _parse_nfz(raw.get("nfz"))
    alt_band = _parse_alt_band(raw.get("alt_band_m"))
    staging = _parse_staging(raw.get("staging"))

    return Site(
        home=home,
        perimeter=perimeter,
        nfz=nfz,
        alt_band=alt_band,
        staging=staging,
        source_path=str(p),
    )


def load_site_from_env(explicit: Optional[str] = None) -> Site:
    """Load the site model from the conventional location.

    ``explicit`` (if given) wins, else ``EIS_SITE_FILE``, else
    ``site/site.json`` relative to the repo root.
    """
    return load_site(resolve_site_path(explicit))


# --------------------------------------------------------------------------
# Field parsers -- each raises ValueError naming the offending field
# --------------------------------------------------------------------------
def _num(value: Any, ctx: str) -> float:
    """A finite float, or ValueError."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"site: {ctx} must be a number, got {value!r}")
    f = float(value)
    if not math.isfinite(f):
        raise ValueError(f"site: {ctx} must be finite, got {value!r}")
    return f


def _latlon(lat: Any, lon: Any, ctx: str) -> LatLon:
    """A valid (lat, lon) pair, or ValueError. Order is [lat, lon] always."""
    lat_f = _num(lat, f"{ctx}.lat")
    lon_f = _num(lon, f"{ctx}.lon")
    if not -90.0 <= lat_f <= 90.0:
        raise ValueError(f"site: {ctx}.lat out of range [-90, 90]: {lat_f}")
    if not -180.0 <= lon_f <= 180.0:
        raise ValueError(f"site: {ctx}.lon out of range [-180, 180]: {lon_f}")
    return (lat_f, lon_f)


def _parse_home(raw: Any) -> Home:
    if not isinstance(raw, dict):
        raise ValueError("site: 'home' object is required")
    lat, lon = _latlon(raw.get("lat"), raw.get("lon"), "home")
    return Home(lat=lat, lon=lon, alt_m=_num(raw.get("alt_m"), "home.alt_m"))


def _parse_polygon(raw: Any, ctx: str, *, min_vertices: int = 3) -> List[LatLon]:
    """An open ring of [lat, lon] pairs (vertex order preserved verbatim)."""
    if not isinstance(raw, list):
        raise ValueError(f"site: '{ctx}' must be a list of [lat, lon] pairs")
    if len(raw) < min_vertices:
        raise ValueError(
            f"site: '{ctx}' needs at least {min_vertices} vertices, got {len(raw)}"
        )
    ring: List[LatLon] = []
    for i, pair in enumerate(raw):
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            raise ValueError(f"site: {ctx}[{i}] must be a [lat, lon] pair")
        ring.append(_latlon(pair[0], pair[1], f"{ctx}[{i}]"))
    return ring


def _parse_nfz(raw: Any) -> List[NoFlyZone]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("site: 'nfz' must be a list")
    zones: List[NoFlyZone] = []
    for i, z in enumerate(raw):
        if not isinstance(z, dict):
            raise ValueError(f"site: nfz[{i}] must be an object")
        name = z.get("name")
        if not isinstance(name, str) or not name:
            raise ValueError(f"site: nfz[{i}].name must be a non-empty string")
        ceiling = _num(z.get("ceiling_m"), f"nfz[{i}].ceiling_m")
        if ceiling < 0.0:
            raise ValueError(f"site: nfz[{i}].ceiling_m must be >= 0, got {ceiling}")
        polygon = _parse_polygon(z.get("polygon"), f"nfz[{i}].polygon")
        zones.append(NoFlyZone(name=name, polygon=polygon, ceiling_m=ceiling))
    return zones


def _parse_alt_band(raw: Any) -> AltBand:
    if not isinstance(raw, dict):
        raise ValueError("site: 'alt_band_m' object is required")
    lo = _num(raw.get("min"), "alt_band_m.min")
    hi = _num(raw.get("max"), "alt_band_m.max")
    if lo < 0.0:
        raise ValueError(f"site: alt_band_m.min must be >= 0, got {lo}")
    if hi < lo:
        raise ValueError(f"site: alt_band_m.max ({hi}) < min ({lo})")
    return AltBand(min_m=lo, max_m=hi)


def _parse_staging(raw: Any) -> List[StagingPoint]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise ValueError("site: 'staging' must be a list")
    points: List[StagingPoint] = []
    seen_ids: set = set()
    for i, s in enumerate(raw):
        if not isinstance(s, dict):
            raise ValueError(f"site: staging[{i}] must be an object")
        sid = s.get("id")
        if not isinstance(sid, str) or not sid:
            raise ValueError(f"site: staging[{i}].id must be a non-empty string")
        if sid in seen_ids:
            raise ValueError(f"site: staging[{i}].id duplicates {sid!r}")
        seen_ids.add(sid)
        lat, lon = _latlon(s.get("lat"), s.get("lon"), f"staging[{i}]")
        image = s.get("image")
        if not isinstance(image, str) or not image:
            raise ValueError(f"site: staging[{i}].image must be a non-empty path")
        truth = s.get("truth")
        if truth not in TRUTH_LABELS:
            raise ValueError(
                f"site: staging[{i}].truth must be one of {TRUTH_LABELS}, "
                f"got {truth!r}"
            )
        points.append(StagingPoint(id=sid, lat=lat, lon=lon, image=image, truth=truth))
    return points


__all__ = [
    "SITE_FILE_ENV",
    "DEFAULT_SITE_REL",
    "TRUTH_LABELS",
    "Home",
    "NoFlyZone",
    "AltBand",
    "StagingPoint",
    "Site",
    "resolve_site_path",
    "load_site",
    "load_site_from_env",
]
