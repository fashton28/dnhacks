"""The Site layout and the Site GeoJSON come from one generator and agree with each other."""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_generator_outputs_agree(tmp_path):
    subprocess.run([sys.executable, str(ROOT / "sim/site/gen_site.py"), "--fleet", "3"], check=True, cwd=ROOT)
    scene = json.loads((ROOT / "sim/site/site.json").read_text())
    geo = json.loads((ROOT / "sim/site/site.geojson").read_text())
    scene_ids = {s["id"] for f in ("outer", "inner") for s in scene["fences"][f]["sections"]}
    geo_ids = {f["properties"]["name"] for f in geo["features"] if f["properties"]["kind"] == "fence_section"}
    assert scene_ids == geo_ids and len(scene_ids) == 200
    pads = [f for f in geo["features"] if f["properties"]["kind"] == "helipad"]
    assert [p["properties"]["drone_id"] for p in pads][:3] == ["drone-1", "drone-2", "drone-3"]
    assert len(scene["fleet"]) == 3
    fence = next(f for f in geo["features"] if f["properties"]["kind"] == "geofence")
    assert fence["properties"]["alt_ceiling_m"] == scene["limits"]["alt_ceiling_m"]


def test_site_limits_load_and_clamp():
    from sim.common.site_limits import SiteLimits
    lim = SiteLimits.load()
    assert lim.inside(0, 0) and lim.inside(200, 0) and not lim.inside(500, 0)
    x, y, clamped = lim.clamp_point(500, 0)
    assert clamped and lim.inside(x, y)
    assert lim.clamp_alt(100)[0] == 60
