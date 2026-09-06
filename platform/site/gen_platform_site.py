#!/usr/bin/env python3
"""
============================================================================
Generate platform/site/site.stub.json from the ARGUS Meridian Station model.
----------------------------------------------------------------------------
The team's one site is **Meridian Station** (fictional, anchored at
lat 41.2000 / lon -98.4000). It is authored once, in the ARGUS tree:

  * ``contracts/site.py``        -- the anchor and the ENU <-> lat/lon helpers
  * ``sim/site/site.json``       -- the world model in ENU metres (buildings,
                                    switchyard, fences, road, pads, trees)
  * ``sim/site/site.geojson``    -- the derived WGS84 features (site footprint,
                                    geofence + altitude band, no-fly zone,
                                    helipads)
  * ``sim/common/site_limits.py``-- the altitude band every Drone enforces

The platform stack consumes a site through ONE file in ITS own schema
(``platform/docs/SITE_CONTRACT.md``). This script is the one-way conversion
between the two, so the stub is reproducible rather than hand-typed:

    python platform/site/gen_platform_site.py            # writes site.stub.json
    python platform/site/gen_platform_site.py --check    # verify, write nothing

Everything the platform schema needs but the ARGUS model does not carry --
the NFZ route buffer, the LiDAR-degraded clear altitude, the fixed CCTV
cameras, the no-image zone and the staging points -- is declared HERE, in the
PLATFORM_* blocks below, in ENU metres from the same anchor, so it stays inside
the same geometry. Nothing in this file is survey data: it is an integration
stub (``image_kind: scripted_placeholder``).
============================================================================
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence, Tuple

PLATFORM_SITE_DIR = Path(__file__).resolve().parent
PLATFORM_ROOT = PLATFORM_SITE_DIR.parent
REPO_ROOT = PLATFORM_ROOT.parent

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from contracts.site import SITE_NAME, enu_to_latlon  # noqa: E402

ARGUS_SITE_JSON = REPO_ROOT / "sim" / "site" / "site.json"
ARGUS_SITE_GEOJSON = REPO_ROOT / "sim" / "site" / "site.geojson"
OUT_FILE = PLATFORM_SITE_DIR / "site.stub.json"

#: Coordinates are rounded to 1e-7 deg (~1 cm) -- the precision the ARGUS
#: geojson already publishes, and far finer than anything here is surveyed to.
PRECISION = 7

LatLon = Tuple[float, float]

# --------------------------------------------------------------------------
# Platform-owned additions (ENU metres from the Meridian Station anchor).
# The ARGUS model has no notion of these; the platform schema requires them.
# --------------------------------------------------------------------------

#: Horizontal stand-off applied around every NFZ for route and orbit checks.
#: docs/SITE_CONTRACT.md pins the stub and verifier default at exactly 25 m.
PLATFORM_NFZ_BUFFER_M = 25

#: Minimum AGL flown after LiDAR obstacle avoidance is lost. Inside the site's
#: altitude band and deliberately above the baseline companion's configured
#: 30 m maximum, so a LiDAR-degraded mission is REFUSED rather than silently
#: clamped down to an unsafe altitude (docs/SITE_CONTRACT.md).
PLATFORM_CLEAR_ALTITUDE_M = 45.0

#: Fixed CCTV infrastructure, mast-mounted on the surveyed site boundary and
#: looking west into the plant. Both masts stand OUTSIDE the operational
#: geofence, which docs/SITE_CONTRACT.md explicitly allows -- camera geometry is
#: never a flight constraint, and a pixel cue that projects back onto the mast
#: side of the fence is a miscalibration to refuse rather than a discovery.
#: (x, y) ENU metres; heading is a true bearing, 0 = north, clockwise.
PLATFORM_CAMERAS: Sequence[Dict[str, Any]] = (
    {
        "id": "cam-east-north",
        "xy": (300.0, 70.0),
        "heading_deg": 270,
        "fov_deg": 90,
        "range_m": 250,
        "zones": (
            {"name": "east-fence-north", "rect": (120.0, 20.0, 160.0, 120.0)},
        ),
    },
    {
        "id": "cam-east-south",
        "xy": (300.0, -70.0),
        "heading_deg": 270,
        "fov_deg": 90,
        "range_m": 250,
        "zones": (
            {"name": "east-fence-south", "rect": (120.0, -120.0, 160.0, -20.0)},
            {"name": "switchyard-approach", "rect": (100.0, -20.0, 140.0, 20.0)},
        ),
    },
)

#: Imaging restriction (NOT a flight restriction): the control building is
#: staffed office space, so imagery whose footprint intersects it may not be
#: captured, retained or displayed. Transit over it stays permitted.
PLATFORM_NO_IMAGE_ZONES: Sequence[Dict[str, Any]] = (
    {"name": "control-building", "building": "control_building", "pad_m": 6.0},
)

#: Pre-surveyed observation points with paired scripted fixtures. Both sit
#: inside the geofence and outside every buffered NFZ.
PLATFORM_STAGING: Sequence[Dict[str, Any]] = (
    {
        "id": "meridian-south-service-road",
        "xy": (0.0, -180.0),          # on the south approach road
        "image": "site/staging/stage-a.png",
        "thermal_image": "site/staging/stage-a-thermal.png",
        "image_kind": "scripted_placeholder",
        "required_sensors": ("rgb", "thermal", "lidar"),
        "truth": "vehicle",
    },
    {
        "id": "meridian-east-yard",
        "xy": (100.0, -30.0),         # inside cam-east-south/switchyard-approach
        "image": "site/staging/stage-b.png",
        "thermal_image": "site/staging/stage-b-thermal.png",
        "image_kind": "scripted_placeholder",
        "required_sensors": ("rgb", "thermal", "lidar"),
        "truth": "false_alarm",
    },
)

#: The switchyard is a second no-fly zone: a live 400 kV bay is not overflown.
#: Its footprint is the extent of the stack field in sim/site/site.json plus a
#: structural margin.
PLATFORM_SWITCHYARD_MARGIN_M = 2.5


# --------------------------------------------------------------------------
# Conversion helpers
# --------------------------------------------------------------------------
def latlon(x: float, y: float) -> List[float]:
    """ENU metres from the Meridian anchor -> a rounded ``[lat, lon]`` pair."""
    lat, lon = enu_to_latlon(x, y)
    return [round(lat, PRECISION), round(lon, PRECISION)]


def rect(x0: float, y0: float, x1: float, y1: float) -> List[List[float]]:
    """An axis-aligned ENU rectangle as an OPEN [lat, lon] ring (CCW)."""
    return [latlon(x0, y0), latlon(x1, y0), latlon(x1, y1), latlon(x0, y1)]


def box(cx: float, cy: float, w: float, h: float, pad: float = 0.0) -> List[List[float]]:
    """A centred ENU box footprint (``size`` from sim/site/site.json)."""
    return rect(cx - w / 2 - pad, cy - h / 2 - pad, cx + w / 2 + pad, cy + h / 2 + pad)


def open_ring(geojson_ring: Iterable[Sequence[float]]) -> List[List[float]]:
    """A GeoJSON [lon, lat] ring -> the platform's OPEN [lat, lon] ring."""
    coords = [list(c) for c in geojson_ring]
    if len(coords) > 1 and coords[0] == coords[-1]:
        coords = coords[:-1]
    return [[round(lat, PRECISION), round(lon, PRECISION)] for lon, lat in coords]


def feature(geo: Dict[str, Any], kind: str, name: str | None = None) -> Dict[str, Any]:
    for f in geo["features"]:
        props = f.get("properties") or {}
        if props.get("kind") != kind:
            continue
        if name is not None and props.get("name") != name:
            continue
        return f
    raise SystemExit(f"gen_platform_site: no '{kind}' feature in {ARGUS_SITE_GEOJSON}")


def cone(x: float, y: float, heading_deg: float, fov_deg: float,
         range_m: float) -> List[List[float]]:
    """The ground footprint of a camera cone: apex first, then the left edge,
    the optical axis and the right edge at ``range_m`` (docs/SITE_CONTRACT.md:
    derived from the other four fields, so a consumer may recompute it)."""
    half = fov_deg / 2.0
    out = [latlon(x, y)]
    for bearing in (heading_deg + half, heading_deg, heading_deg - half):
        rad = math.radians(bearing)
        out.append(latlon(x + range_m * math.sin(rad), y + range_m * math.cos(rad)))
    return out


# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------
def build() -> Dict[str, Any]:
    world = json.loads(ARGUS_SITE_JSON.read_text(encoding="utf-8"))
    geo = json.loads(ARGUS_SITE_GEOJSON.read_text(encoding="utf-8"))

    if world.get("name") != SITE_NAME:
        raise SystemExit(
            f"gen_platform_site: {ARGUS_SITE_JSON} names {world.get('name')!r}, "
            f"expected {SITE_NAME!r}"
        )

    buildings = {b["id"]: b for b in world["buildings"]}

    # -- home + pads: the ARGUS helipad row, pads[0] restating home ----------
    pads_geo = [f for f in geo["features"]
                if (f.get("properties") or {}).get("kind") == "helipad"]
    pads = []
    for i, f in enumerate(pads_geo, start=1):
        lon, lat = f["geometry"]["coordinates"]
        pads.append({
            "id": f"pad-{i}",
            "lat": round(lat, PRECISION),
            "lon": round(lon, PRECISION),
        })
    if not pads:
        raise SystemExit("gen_platform_site: the ARGUS geojson declares no helipads")
    home = {
        "lat": pads[0]["lat"],
        "lon": pads[0]["lon"],
        "alt_m": float(world["anchor"]["alt_msl"]),
    }

    # -- perimeter / geofence / altitude band -------------------------------
    footprint = feature(geo, "site_footprint")
    fence = feature(geo, "geofence")
    perimeter = open_ring(footprint["geometry"]["coordinates"][0])
    geofence = open_ring(fence["geometry"]["coordinates"][0])
    alt_band = {
        "min": float(fence["properties"]["alt_floor_m"]),
        "max": float(fence["properties"]["alt_ceiling_m"]),
    }

    # -- no-fly zones -------------------------------------------------------
    # The reactor exclusion comes straight from the ARGUS geojson; closed at
    # every altitude the site permits, so its ceiling is the band maximum.
    reactor = feature(geo, "no_fly_zone", "reactor_exclusion")
    stacks = world["switchyard"]["stacks"]
    sx = [s["x"] for s in stacks]
    sy = [s["y"] for s in stacks]
    swx = max(s["size"][0] for s in stacks) / 2 + PLATFORM_SWITCHYARD_MARGIN_M
    swy = max(s["size"][1] for s in stacks) / 2 + PLATFORM_SWITCHYARD_MARGIN_M
    nfz = [
        {
            "name": "reactor-exclusion",
            "polygon": open_ring(reactor["geometry"]["coordinates"][0]),
            "ceiling_m": alt_band["max"],
        },
        {
            "name": "switchyard",
            "polygon": rect(min(sx) - swx, min(sy) - swy, max(sx) + swx, max(sy) + swy),
            "ceiling_m": alt_band["max"],
        },
    ]

    # -- clutter: every structure, plus the tree lines ----------------------
    clutter: List[Dict[str, Any]] = []
    for b in world["buildings"]:
        name = b["id"].replace("_", "-")
        if b["kind"] == "cylinder":
            r = float(b["radius"])
            clutter.append({"name": name, "polygon": box(b["x"], b["y"], 2 * r, 2 * r)})
        else:
            w, h = float(b["size"][0]), float(b["size"][1])
            clutter.append({"name": name, "polygon": box(b["x"], b["y"], w, h)})
    for i, band in enumerate(world["trees"]["bands"], start=1):
        x0, y0, x1, y1 = (float(v) for v in band)
        clutter.append({"name": f"tree-line-{i}", "polygon": rect(x0, y0, x1, y1)})

    # -- cameras ------------------------------------------------------------
    cameras = []
    for cam in PLATFORM_CAMERAS:
        x, y = cam["xy"]
        lat, lon = latlon(x, y)
        cameras.append({
            "id": cam["id"],
            "lat": lat,
            "lon": lon,
            "heading_deg": cam["heading_deg"],
            "fov_deg": cam["fov_deg"],
            "range_m": cam["range_m"],
            "fov_polygon": cone(x, y, cam["heading_deg"], cam["fov_deg"], cam["range_m"]),
            "zones": [{"name": z["name"], "polygon": rect(*z["rect"])} for z in cam["zones"]],
        })

    # -- no-image zones -----------------------------------------------------
    no_image_zones = []
    for zone in PLATFORM_NO_IMAGE_ZONES:
        b = buildings[zone["building"]]
        no_image_zones.append({
            "name": zone["name"],
            "polygon": box(b["x"], b["y"], float(b["size"][0]), float(b["size"][1]),
                           pad=zone["pad_m"]),
        })

    # -- staging ------------------------------------------------------------
    staging = []
    for point in PLATFORM_STAGING:
        lat, lon = latlon(*point["xy"])
        staging.append({
            "id": point["id"],
            "lat": lat,
            "lon": lon,
            "image": point["image"],
            "thermal_image": point["thermal_image"],
            "image_kind": point["image_kind"],
            "required_sensors": list(point["required_sensors"]),
            "truth": point["truth"],
        })

    return {
        "home": home,
        "perimeter": perimeter,
        "geofence": geofence,
        "nfz_buffer_m": PLATFORM_NFZ_BUFFER_M,
        "nfz": nfz,
        "alt_band_m": alt_band,
        "clear_altitude_m": PLATFORM_CLEAR_ALTITUDE_M,
        "clutter": clutter,
        "cameras": cameras,
        "pads": pads,
        "no_image_zones": no_image_zones,
        "staging": staging,
    }


# --------------------------------------------------------------------------
# Rendering: one [lat, lon] pair per line, like the file it replaces
# --------------------------------------------------------------------------
def _num(v: Any) -> str:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return json.dumps(v)
    if isinstance(v, float) and v.is_integer() and abs(v) < 1e15:
        return f"{v:.1f}"
    return repr(v)


def _ring(ring: Sequence[Sequence[float]], indent: str) -> str:
    rows = ",\n".join(f"{indent}  [{_num(p[0])}, {_num(p[1])}]" for p in ring)
    return "[\n" + rows + f"\n{indent}]"


def render(site: Dict[str, Any]) -> str:
    def poly_obj(obj: Dict[str, Any], indent: str, extra: Sequence[str] = ()) -> str:
        inner = indent + "  "
        parts = [f'{inner}"name": {json.dumps(obj["name"])}',
                 f'{inner}"polygon": {_ring(obj["polygon"], inner)}']
        parts.extend(f"{inner}{e}" for e in extra)
        return "{\n" + ",\n".join(parts) + f"\n{indent}}}"

    L: List[str] = ["{"]
    h = site["home"]
    L.append(f'  "home": {{ "lat": {_num(h["lat"])}, "lon": {_num(h["lon"])}, '
             f'"alt_m": {_num(h["alt_m"])} }},')
    L.append(f'  "perimeter": {_ring(site["perimeter"], "  ")},')
    L.append(f'  "geofence": {_ring(site["geofence"], "  ")},')
    L.append(f'  "nfz_buffer_m": {_num(site["nfz_buffer_m"])},')

    L.append('  "nfz": [')
    L.append(",\n".join(
        "    " + poly_obj(z, "    ", [f'"ceiling_m": {_num(z["ceiling_m"])}'])
        for z in site["nfz"]))
    L.append("  ],")

    band = site["alt_band_m"]
    L.append(f'  "alt_band_m": {{ "min": {_num(band["min"])}, "max": {_num(band["max"])} }},')
    L.append(f'  "clear_altitude_m": {_num(site["clear_altitude_m"])},')

    L.append('  "clutter": [')
    L.append(",\n".join("    " + poly_obj(c, "    ") for c in site["clutter"]))
    L.append("  ],")

    L.append('  "cameras": [')
    cams = []
    for cam in site["cameras"]:
        zones = ",\n".join("        " + poly_obj(z, "        ") for z in cam["zones"])
        cams.append(
            "    {\n"
            f'      "id": {json.dumps(cam["id"])},\n'
            f'      "lat": {_num(cam["lat"])},\n'
            f'      "lon": {_num(cam["lon"])},\n'
            f'      "heading_deg": {_num(cam["heading_deg"])},\n'
            f'      "fov_deg": {_num(cam["fov_deg"])},\n'
            f'      "range_m": {_num(cam["range_m"])},\n'
            f'      "fov_polygon": {_ring(cam["fov_polygon"], "      ")},\n'
            f'      "zones": [\n{zones}\n      ]\n'
            "    }"
        )
    L.append(",\n".join(cams))
    L.append("  ],")

    L.append('  "pads": [')
    L.append(",\n".join(
        f'    {{ "id": {json.dumps(p["id"])}, "lat": {_num(p["lat"])}, '
        f'"lon": {_num(p["lon"])} }}' for p in site["pads"]))
    L.append("  ],")

    L.append('  "no_image_zones": [')
    L.append(",\n".join("    " + poly_obj(z, "    ") for z in site["no_image_zones"]))
    L.append("  ],")

    L.append('  "staging": [')
    stages = []
    for s in site["staging"]:
        stages.append(
            "    {\n"
            f'      "id": {json.dumps(s["id"])},\n'
            f'      "lat": {_num(s["lat"])},\n'
            f'      "lon": {_num(s["lon"])},\n'
            f'      "image": {json.dumps(s["image"])},\n'
            f'      "thermal_image": {json.dumps(s["thermal_image"])},\n'
            f'      "image_kind": {json.dumps(s["image_kind"])},\n'
            f'      "required_sensors": {json.dumps(s["required_sensors"])},\n'
            f'      "truth": {json.dumps(s["truth"])}\n'
            "    }"
        )
    L.append(",\n".join(stages))
    L.append("  ]")
    L.append("}")
    return "\n".join(L) + "\n"


# --------------------------------------------------------------------------
# Self-check: the invariants docs/SITE_CONTRACT.md makes consumers refuse on
# --------------------------------------------------------------------------
def _point_in_polygon(point: Sequence[float], polygon: Sequence[Sequence[float]]) -> bool:
    y, x = point[0], point[1]
    inside = False
    for i, (y1, x1) in enumerate((p[0], p[1]) for p in polygon):
        y2, x2 = polygon[(i + 1) % len(polygon)][0], polygon[(i + 1) % len(polygon)][1]
        if (y1 > y) != (y2 > y):
            at_x = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < at_x:
                inside = not inside
    return inside


def _metres(a: Sequence[float], b: Sequence[float]) -> float:
    mlat = 111_320.0
    dy = (a[0] - b[0]) * mlat
    dx = (a[1] - b[1]) * mlat * math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot(dx, dy)


def _distance_to_polygon_m(p: Sequence[float], poly: Sequence[Sequence[float]]) -> float:
    if _point_in_polygon(p, poly):
        return 0.0
    best = float("inf")
    for i, a in enumerate(poly):
        b = poly[(i + 1) % len(poly)]
        ab = _metres(a, b)
        if ab == 0.0:
            best = min(best, _metres(p, a))
            continue
        # Project onto the segment in a local metre frame.
        mlat = 111_320.0
        mlon = mlat * math.cos(math.radians(p[0]))
        ax, ay = (a[1] - p[1]) * mlon, (a[0] - p[0]) * mlat
        bx, by = (b[1] - p[1]) * mlon, (b[0] - p[0]) * mlat
        dx, dy = bx - ax, by - ay
        t = max(0.0, min(1.0, -(ax * dx + ay * dy) / (dx * dx + dy * dy)))
        best = min(best, math.hypot(ax + t * dx, ay + t * dy))
    return best


def self_check(site: Dict[str, Any]) -> None:
    problems: List[str] = []

    for i, v in enumerate(site["geofence"]):
        if not _point_in_polygon(v, site["perimeter"]):
            problems.append(f"geofence[{i}] escapes the perimeter")

    band = site["alt_band_m"]
    if not band["min"] <= site["clear_altitude_m"] <= band["max"]:
        problems.append("clear_altitude_m is outside alt_band_m")

    buffered = site["nfz_buffer_m"]
    for pad in site["pads"]:
        p = (pad["lat"], pad["lon"])
        if not _point_in_polygon(p, site["geofence"]):
            problems.append(f"pad {pad['id']} is outside the geofence")
        for z in site["nfz"]:
            if _distance_to_polygon_m(p, z["polygon"]) < buffered:
                problems.append(f"pad {pad['id']} is inside the buffered NFZ {z['name']}")

    pad0 = site["pads"][0]
    if (pad0["lat"], pad0["lon"]) != (site["home"]["lat"], site["home"]["lon"]):
        problems.append("pads[0] does not restate home")

    for s in site["staging"]:
        p = (s["lat"], s["lon"])
        if not _point_in_polygon(p, site["geofence"]):
            problems.append(f"staging {s['id']} is outside the geofence")
        for z in site["nfz"]:
            if _distance_to_polygon_m(p, z["polygon"]) < buffered:
                problems.append(f"staging {s['id']} is inside the buffered NFZ {z['name']}")
        for z in site["no_image_zones"]:
            if _point_in_polygon(p, z["polygon"]):
                problems.append(f"staging {s['id']} sits inside no-image zone {z['name']}")
        if not (PLATFORM_SITE_DIR.parent / s["image"]).is_file():
            problems.append(f"staging {s['id']} names a missing image {s['image']}")
        if not (PLATFORM_SITE_DIR.parent / s["thermal_image"]).is_file():
            problems.append(f"staging {s['id']} names a missing thermal {s['thermal_image']}")

    names = [z["name"] for z in site["nfz"]] + [c["name"] for c in site["clutter"]]
    if len(set(names)) != len(names):
        problems.append("duplicate zone name")
    ids = [c["id"] for c in site["cameras"]] + [p["id"] for p in site["pads"]] \
        + [s["id"] for s in site["staging"]]
    if len(set(ids)) != len(ids):
        problems.append("duplicate id")

    if problems:
        raise SystemExit("gen_platform_site: " + "; ".join(problems))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true",
                    help="verify the committed file matches; write nothing")
    args = ap.parse_args()

    site = build()
    self_check(site)
    text = render(site)
    json.loads(text)  # the renderer must always emit valid JSON

    if args.check:
        current = OUT_FILE.read_text(encoding="utf-8") if OUT_FILE.is_file() else ""
        if current != text:
            print(f"gen_platform_site: {OUT_FILE} is STALE -- re-run without --check")
            return 1
        print(f"gen_platform_site: {OUT_FILE} is up to date")
        return 0

    OUT_FILE.write_text(text, encoding="utf-8")
    print(f"gen_platform_site: site        {SITE_NAME}")
    print(f"gen_platform_site: home        {site['home']['lat']}, {site['home']['lon']} "
          f"@ {site['home']['alt_m']} m AMSL")
    print(f"gen_platform_site: alt band    {site['alt_band_m']['min']}-"
          f"{site['alt_band_m']['max']} m AGL, clear {site['clear_altitude_m']} m")
    print(f"gen_platform_site: zones       {len(site['nfz'])} nfz, "
          f"{len(site['clutter'])} clutter, {len(site['no_image_zones'])} no-image")
    print(f"gen_platform_site: assets      {len(site['cameras'])} cameras, "
          f"{len(site['pads'])} pads, {len(site['staging'])} staging")
    print(f"gen_platform_site: wrote       {OUT_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
