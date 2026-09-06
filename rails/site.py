"""
rails/site — the site model, loaded and validated the way the contract says.

Reference of ``platform/ground/planner/src/site.ts``. The schema is
``platform/docs/SITE_CONTRACT.md``:

  * coordinates are WGS84 and ordered ``[lat, lon]`` in the JSON (lat FIRST),
  * polygons are OPEN rings (the closing edge is implicit), either winding,
  * ``alt_band_m`` and NFZ ``ceiling_m`` are metres AGL relative to home,
  * ``perimeter`` is the outer geofence, ``geofence`` the operational one,
  * flight inside an NFZ polygon at or below ``ceiling_m`` is forbidden;
    overflight strictly above it is permitted (ADR D3).

Nothing here hardcodes plant geometry: every coordinate the oracle uses is read
from the site file the fixture names.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

Point = Tuple[float, float]   # (lat, lon)

TRUTH_VALUES = ("vehicle", "breach", "structure", "false_alarm")


@dataclass(frozen=True)
class SiteNfz:
    name: str
    polygon: Tuple[Point, ...]
    ceilingM: float


@dataclass(frozen=True)
class SiteClutter:
    name: str
    polygon: Tuple[Point, ...]


@dataclass(frozen=True)
class SiteStagingPoint:
    id: str
    lat: float
    lon: float
    image: str
    thermalImage: str
    imageKind: str
    requiredSensors: Tuple[str, ...]
    truth: str


@dataclass(frozen=True)
class SiteHome:
    lat: float
    lon: float
    altM: float


@dataclass(frozen=True)
class SiteModel:
    home: SiteHome
    perimeter: Tuple[Point, ...]
    geofence: Tuple[Point, ...]
    nfzBufferM: float
    nfz: Tuple[SiteNfz, ...]
    altBandMin: float
    altBandMax: float
    clearAltitudeM: float
    clutter: Tuple[SiteClutter, ...] = ()
    staging: Tuple[SiteStagingPoint, ...] = ()

    def with_override(self, override: Optional[Mapping[str, Any]]) -> "SiteModel":
        """Patch the VALIDATED model, the way a fixture's ``siteOverride`` does.

        Patching past the loader is deliberate: a case can present geometry the
        loader would have refused, which proves the verifier re-checks the site
        itself rather than trusting whoever handed it over.
        """
        if not override:
            return self
        patch: Dict[str, Any] = {}
        for key, value in override.items():
            if key == "geofence":
                patch["geofence"] = tuple(_ring_from_objects(value))
            elif key == "perimeter":
                patch["perimeter"] = tuple(_ring_from_objects(value))
            elif key == "nfzBufferM":
                patch["nfzBufferM"] = float(value)
            elif key == "clearAltitudeM":
                patch["clearAltitudeM"] = float(value)
            elif key == "altBandM" and isinstance(value, Mapping):
                patch["altBandMin"] = float(value["min"])
                patch["altBandMax"] = float(value["max"])
            elif key == "home" and isinstance(value, Mapping):
                patch["home"] = SiteHome(
                    lat=float(value["lat"]), lon=float(value["lon"]),
                    altM=float(value.get("altM", value.get("alt_m", 0.0))),
                )
            elif key == "nfz":
                patch["nfz"] = tuple(
                    SiteNfz(name=str(z.get("name", "")),
                            polygon=tuple(_ring_from_objects(z.get("polygon", ()))),
                            ceilingM=float(z.get("ceilingM", z.get("ceiling_m", math.inf))))
                    for z in value
                )
            elif key == "clutter":
                patch["clutter"] = tuple(
                    SiteClutter(name=str(c.get("name", "")),
                                polygon=tuple(_ring_from_objects(c.get("polygon", ()))))
                    for c in value
                )
            # Any other key is not geometry the oracle reads; ignore it rather
            # than guess at a shape.
        return replace(self, **patch) if patch else self


def _ring_from_objects(raw: Any) -> List[Point]:
    """A ring given as `[{lat, lon}, ...]` (the VALIDATED in-memory shape)."""
    out: List[Point] = []
    for item in raw or ():
        if isinstance(item, Mapping):
            out.append((float(item["lat"]), float(item["lon"])))
        elif isinstance(item, Sequence) and len(item) == 2:
            out.append((float(item[0]), float(item[1])))
    return out


def _is_finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _assert_lat(value: Any, ctx: str) -> float:
    if not _is_finite(value) or value < -90 or value > 90:
        raise ValueError(f"invalid site JSON: {ctx} must be a latitude in [-90, 90], got {value!r}")
    return float(value)


def _assert_lon(value: Any, ctx: str) -> float:
    if not _is_finite(value) or value < -180 or value > 180:
        raise ValueError(f"invalid site JSON: {ctx} must be a longitude in [-180, 180], got {value!r}")
    return float(value)


def _parse_ring(raw: Any, ctx: str) -> Tuple[Point, ...]:
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)) or len(raw) < 3:
        raise ValueError(f"invalid site JSON: {ctx} must be an array of >= 3 [lat, lon] pairs")
    ring: List[Point] = []
    for i, pair in enumerate(raw):
        if not isinstance(pair, Sequence) or isinstance(pair, (str, bytes)) or len(pair) != 2:
            raise ValueError(f"invalid site JSON: {ctx}[{i}] must be a [lat, lon] pair")
        ring.append((_assert_lat(pair[0], f"{ctx}[{i}][0]"), _assert_lon(pair[1], f"{ctx}[{i}][1]")))
    return tuple(ring)


def validate_site(data: Any) -> SiteModel:
    """Reference of ``site.ts::validateSite``. Raises on any schema violation."""
    from .geometry import point_in_or_on_polygon   # local: geometry imports nothing from here

    if not isinstance(data, Mapping):
        raise ValueError("invalid site JSON: root must be an object")

    home = data.get("home")
    if not isinstance(home, Mapping):
        raise ValueError('invalid site JSON: missing "home" object')
    home_lat = _assert_lat(home.get("lat"), "home.lat")
    home_lon = _assert_lon(home.get("lon"), "home.lon")
    if not _is_finite(home.get("alt_m")):
        raise ValueError("invalid site JSON: home.alt_m must be a finite number (meters AMSL)")

    perimeter = _parse_ring(data.get("perimeter"), "perimeter")
    geofence = _parse_ring(data.get("geofence"), "geofence")
    buffer_m = data.get("nfz_buffer_m")
    if not _is_finite(buffer_m) or buffer_m < 0:
        raise ValueError("invalid site JSON: nfz_buffer_m must be a finite number >= 0")

    nfz_raw = data.get("nfz")
    if not isinstance(nfz_raw, Sequence) or isinstance(nfz_raw, (str, bytes)):
        raise ValueError('invalid site JSON: "nfz" must be an array (may be empty)')
    nfz: List[SiteNfz] = []
    for i, zone in enumerate(nfz_raw):
        if not isinstance(zone, Mapping) or not isinstance(zone.get("name"), str):
            raise ValueError(f'invalid site JSON: nfz[{i}] must be an object with a string "name"')
        ceiling = zone.get("ceiling_m")
        if not _is_finite(ceiling) or ceiling < 0:
            raise ValueError(f"invalid site JSON: nfz[{i}].ceiling_m must be a number >= 0 (meters AGL)")
        nfz.append(SiteNfz(name=zone["name"],
                           polygon=_parse_ring(zone.get("polygon"), f"nfz[{i}].polygon"),
                           ceilingM=float(ceiling)))

    band = data.get("alt_band_m")
    if not isinstance(band, Mapping) or not _is_finite(band.get("min")) or not _is_finite(band.get("max")):
        raise ValueError('invalid site JSON: "alt_band_m" must be { min, max } in meters AGL')
    if band["min"] < 0 or band["min"] >= band["max"]:
        raise ValueError(
            f"invalid site JSON: alt_band_m requires 0 <= min < max, "
            f"got min={band['min']} max={band['max']}"
        )
    clear = data.get("clear_altitude_m")
    if not _is_finite(clear) or clear < band["min"] or clear > band["max"]:
        raise ValueError(
            f"invalid site JSON: clear_altitude_m must be inside alt_band_m "
            f"[{band['min']}, {band['max']}]"
        )

    clutter_raw = data.get("clutter")
    if not isinstance(clutter_raw, Sequence) or isinstance(clutter_raw, (str, bytes)):
        raise ValueError('invalid site JSON: "clutter" must be an array (may be empty)')
    clutter: List[SiteClutter] = []
    for i, area in enumerate(clutter_raw):
        if not isinstance(area, Mapping):
            raise ValueError(f"invalid site JSON: clutter[{i}] must be an object")
        if not isinstance(area.get("name"), str) or not area["name"]:
            raise ValueError(f"invalid site JSON: clutter[{i}].name must be a non-empty string")
        clutter.append(SiteClutter(name=area["name"],
                                   polygon=_parse_ring(area.get("polygon"), f"clutter[{i}].polygon")))

    staging_raw = data.get("staging")
    if not isinstance(staging_raw, Sequence) or isinstance(staging_raw, (str, bytes)):
        raise ValueError('invalid site JSON: "staging" must be an array (may be empty)')
    staging: List[SiteStagingPoint] = []
    seen_ids = set()
    for i, point in enumerate(staging_raw):
        if (not isinstance(point, Mapping) or not isinstance(point.get("id"), str) or
                not isinstance(point.get("image"), str) or
                not isinstance(point.get("thermal_image"), str) or
                not isinstance(point.get("image_kind"), str) or
                point.get("truth") not in TRUTH_VALUES):
            raise ValueError(
                f"invalid site JSON: staging[{i}] must have string id/image/thermal_image/"
                "image_kind and truth in vehicle|breach|structure|false_alarm"
            )
        if point["id"] in seen_ids:
            raise ValueError(f"invalid site JSON: duplicate staging id {point['id']!r}")
        seen_ids.add(point["id"])
        sensors = point.get("required_sensors")
        if (not isinstance(sensors, Sequence) or isinstance(sensors, (str, bytes)) or
                any(sensor not in ("rgb", "thermal", "lidar") for sensor in sensors)):
            raise ValueError(
                f"invalid site JSON: staging[{i}].required_sensors must contain only rgb|thermal|lidar"
            )
        staging.append(SiteStagingPoint(
            id=point["id"],
            lat=_assert_lat(point.get("lat"), f"staging[{i}].lat"),
            lon=_assert_lon(point.get("lon"), f"staging[{i}].lon"),
            image=point["image"], thermalImage=point["thermal_image"],
            imageKind=point["image_kind"], requiredSensors=tuple(sensors), truth=point["truth"],
        ))

    if any(not point_in_or_on_polygon(point, perimeter) for point in geofence):
        raise ValueError("invalid site JSON: geofence must be wholly inside or equal to perimeter")

    return SiteModel(
        home=SiteHome(lat=home_lat, lon=home_lon, altM=float(home["alt_m"])),
        perimeter=perimeter,
        geofence=geofence,
        nfzBufferM=float(buffer_m),
        nfz=tuple(nfz),
        altBandMin=float(band["min"]),
        altBandMax=float(band["max"]),
        clearAltitudeM=float(clear),
        clutter=tuple(clutter),
        staging=tuple(staging),
    )


def load_site(path: Path) -> SiteModel:
    """Load + validate the site JSON at ``path``."""
    return validate_site(json.loads(Path(path).read_text(encoding="utf-8")))


__all__ = [
    "SiteClutter", "SiteHome", "SiteModel", "SiteNfz", "SiteStagingPoint",
    "load_site", "validate_site",
]
