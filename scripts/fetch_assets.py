"""Download CC0 assets from Poly Haven into console/public/assets and write the license manifest.

Run:  uv run python scripts/fetch_assets.py
Idempotent: skips files already present.
"""
from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "console" / "public" / "assets"
API = "https://api.polyhaven.com/files/"

# asset id -> (kind, resolution)
TEXTURES = {
    "leafy_grass": "2k",           # maintained lawn inside the Site
    "sparse_grass": "1k",          # worn grass patches
    "aerial_grass_rock": "2k",     # rough ground outside the fences
    "forest_ground_04": "1k",      # ground variation under trees
    "gravelly_sand": "1k",         # switchyard / apron
    "asphalt_02": "1k",            # road
    "concrete_wall_008": "1k",     # control building
    "precast_concrete_wall": "1k", # containment
    "corrugated_iron_02": "1k",    # turbine hall, shed
    "metal_plate": "1k",           # transformers, switchyard stacks
}
TEXTURE_MAPS = {"Diffuse": "diffuse", "nor_gl": "normal", "Rough": "roughness", "AO": "ao"}
HDRIS = {"kloofendal_48d_partly_cloudy_puresky": "4k"}
MODELS = {"wooden_crate_01": "1k", "modular_chainlink_fence": "1k", "power_box_01": "1k"}  # Poly Haven trees are 0.5-1 GB of geometry: unusable in the browser


UA = {"User-Agent": "Mozilla/5.0 argus-fetch/1.0"}


def get(url: str) -> dict:
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return json.load(r)


def download(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  {dest.relative_to(ROOT)}  <-  {url}", flush=True)
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r:
        dest.write_bytes(r.read())


def main() -> int:
    manifest: list[dict] = []
    for aid, res in TEXTURES.items():
        files = get(API + aid)
        entry = {"id": aid, "kind": "texture", "source": f"https://polyhaven.com/a/{aid}", "license": "CC0", "files": {}}
        for key, name in TEXTURE_MAPS.items():
            node = files.get(key, {}).get(res, {})
            f = node.get("jpg") or node.get("png")
            if not f:
                continue
            ext = "jpg" if node.get("jpg") else "png"
            dest = OUT / "textures" / aid / f"{name}.{ext}"
            download(f["url"], dest)
            entry["files"][name] = str(dest.relative_to(OUT))
        manifest.append(entry)
    for aid, res in HDRIS.items():
        files = get(API + aid)
        f = files["hdri"][res]["hdr"]
        dest = OUT / "hdri" / f"{aid}_{res}.hdr"
        download(f["url"], dest)
        manifest.append({"id": aid, "kind": "hdri", "source": f"https://polyhaven.com/a/{aid}", "license": "CC0", "files": {"hdr": str(dest.relative_to(OUT))}})
    for aid, res in MODELS.items():
        files = get(API + aid)
        node = files["gltf"][res]["gltf"]
        dest_dir = OUT / "models" / aid
        download(node["url"], dest_dir / Path(node["url"]).name)
        for rel, inc in node.get("include", {}).items():
            download(inc["url"], dest_dir / rel)
        manifest.append({"id": aid, "kind": "model", "source": f"https://polyhaven.com/a/{aid}", "license": "CC0", "files": {"gltf": str((dest_dir / Path(node["url"]).name).relative_to(OUT))}})
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    lines = ["# Assets", "", "All assets below are CC0 from Poly Haven (https://polyhaven.com/license). Downloaded by `scripts/fetch_assets.py`.", ""]
    for e in manifest:
        lines.append(f"- {e['kind']}: [{e['id']}]({e['source']}), CC0")
    (ROOT / "docs" / "ASSETS.md").write_text("\n".join(lines) + "\n")
    total = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"done: {len(manifest)} assets, {total/1e6:.1f} MB under console/public/assets")
    return 0


if __name__ == "__main__":
    sys.exit(main())
