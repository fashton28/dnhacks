"""Standalone renderer for the local Meridian Station simulation.

This is a renderer-role controller for the Hub.  Unlike the Three.js Console it
has no Node, browser, asset-download, or dashboard dependency.  It renders the
same scenario state into a deterministic overhead PNG using Pillow, which makes
it useful for the end-to-end ARGUS demo when the visual Console is unavailable.

Run in its own terminal and leave it running:
  ./.venv/bin/python scripts/sim_renderer.py --hub http://127.0.0.1:8000
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import websockets
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from contracts.site import enu_to_latlon

SITE = json.loads((ROOT / "sim" / "site" / "site.json").read_text())
HALF = float(SITE["overhead"]["half"])
PX = int(SITE["overhead"]["px"])


def ws_url(hub: str) -> str:
    parsed = urlparse(hub)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    return f"{scheme}://{parsed.netloc}/ws/controller"


def xy(x: float, y: float) -> tuple[int, int]:
    """Simulator ENU metres to north-up pixel coordinates."""
    return (round((x + HALF) / (2 * HALF) * PX), round((HALF - y) / (2 * HALF) * PX))


def scale(metres: float) -> int:
    return max(1, round(metres / (2 * HALF) * PX))


def rect(draw: ImageDraw.ImageDraw, x: float, y: float, width: float, height: float, fill: str, outline: str = "#25303a") -> None:
    cx, cy = xy(x, y)
    w, h = scale(width), scale(height)
    draw.rectangle((cx - w // 2, cy - h // 2, cx + w // 2, cy + h // 2), fill=fill, outline=outline, width=2)


def footprint() -> list[list[float]]:
    return [list(enu_to_latlon(x, y)) for x, y in [(-HALF, HALF), (HALF, HALF), (HALF, -HALF), (-HALF, -HALF)]]


def render(scene: dict[str, Any]) -> bytes:
    image = Image.new("RGB", (PX, PX), "#779462")
    draw = ImageDraw.Draw(image)
    # Mown site area, access road, two fence lines, and fixed buildings.
    rect(draw, 0, 0, 300, 300, "#9bb47a", "#78905e")
    rect(draw, 0, -15, 12, 285, "#50554f", "#454a45")
    for half, color in ((140, "#c5b35a"), (110, "#e0cc69")):
        a, b = xy(-half, half), xy(half, -half)
        draw.rectangle((a[0], a[1], b[0], b[1]), outline=color, width=4)
    # Reactor exclusion ring.
    cx, cy = xy(0, 55)
    r = scale(45)
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), outline="#dd6262", width=3)
    for building in SITE["buildings"]:
        x, y = float(building["x"]), float(building["y"])
        if building["kind"] == "cylinder":
            cx, cy = xy(x, y)
            r = scale(float(building["radius"]))
            draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill="#aeb7bd", outline="#59636b", width=2)
        else:
            width, depth, _ = building["size"]
            rect(draw, x, y, float(width), float(depth), "#8e989e")
    # Scenario props are intentionally distinct physical objects, not hidden metadata.
    for prop in scene.get("props", []):
        x, y = float(prop["x"]), float(prop["y"])
        if prop["kind"] == "vehicle":
            rect(draw, x, y, 15, 8, "#b72f2f", "#451010")
            cx, cy = xy(x, y)
            draw.rectangle((cx - scale(4), cy - scale(2), cx + scale(4), cy + scale(2)), fill="#b8d4df")
        elif prop["kind"] == "crate":
            rect(draw, x, y, 7, 7, "#e3942f", "#5e3b16")
            cx, cy = xy(x, y)
            d = scale(2)
            draw.line((cx - d, cy - d, cx + d, cy + d), fill="#5e3b16", width=2)
            draw.line((cx - d, cy + d, cx + d, cy - d), fill="#5e3b16", width=2)
    # An open fence becomes a clearly visible red break at its actual section location.
    sections = {s["id"]: s for s in SITE["fences"]["outer"]["sections"]}
    for section_id in scene.get("open_fences", []):
        section = sections.get(section_id)
        if section:
            cx, cy = xy(float(section["x"]), float(section["y"]))
            d = scale(float(section["length"]) / 2)
            draw.line((cx - d, cy - d, cx + d, cy + d), fill="#e74343", width=7)
    # A small provenance mark makes it explicit that these are authorised simulation frames.
    draw.rounded_rectangle((14, 14, 258, 50), radius=8, fill="#1c2630", outline="#9fb4c3")
    draw.text((26, 24), "MERIDIAN STATION · SIMULATION", fill="#e9f0f2")
    out = io.BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--hub", default="http://127.0.0.1:8000")
    args = parser.parse_args()
    scene: dict[str, Any] = {"props": [], "open_fences": [], "scenario_ids": []}
    async with websockets.connect(ws_url(args.hub), max_size=32 * 1024 * 1024) as socket:
        await socket.send(json.dumps({"type": "hello", "role": "renderer", "id": "sim-renderer", "sim": "headless"}))
        print(f"[sim-renderer] connected to {args.hub} as renderer", flush=True)
        async for raw in socket:
            command = json.loads(raw)
            kind = command.get("type")
            if kind == "scene":
                scene = command["state"]
                await socket.send(json.dumps({"type": "ack", "cmd_id": command["cmd_id"], "ok": True}))
            elif kind == "capture_overhead":
                png = base64.b64encode(render(scene)).decode()
                await socket.send(json.dumps({"type": "ack", "cmd_id": command["cmd_id"], "ok": True}))
                await socket.send(json.dumps({
                    "type": "overhead", "ref": command["ref"], "png_b64": png, "width": PX, "height": PX,
                    "footprint": footprint(), "ts": datetime.now(UTC).isoformat(), "cmd_id": command["cmd_id"],
                }))
                print(f"[sim-renderer] captured {command['ref']}", flush=True)
            elif kind == "render_frame":
                # Fake drones supply their own frames. This fallback keeps SITL runs protocol-complete.
                png = base64.b64encode(render(scene)).decode()
                await socket.send(json.dumps({"type": "ack", "cmd_id": command["cmd_id"], "ok": True}))
                await socket.send(json.dumps({
                    "type": "frame", "drone_id": command["drone_id"], "jpeg_b64": png, "width": PX, "height": PX,
                    "lat": SITE["anchor"]["lat"], "lon": SITE["anchor"]["lon"], "alt": 30.0,
                    "heading_deg": 0.0, "gimbal_pitch_deg": 45.0, "ts": datetime.now(UTC).isoformat(), "cmd_id": command["cmd_id"],
                }))


if __name__ == "__main__":
    asyncio.run(main())
