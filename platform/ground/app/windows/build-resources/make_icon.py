"""Rasterise the Drone Safety Platform brand mark into build-resources/icon.ico.

The mark is a camera-aperture ring with four axis ticks, four corner reticle
brackets and a pupil, drawn in the brand blues on a transparent ground. It is
rendered once at high resolution and downsampled, so every size in the .ico
(16 through 256 px) gets anti-aliased edges instead of the jagged ones a direct
draw at 16 px produces.

Run from anywhere:  python make_icon.py [--out PATH] [--png PREVIEW.png]
Requires Pillow.
"""
from __future__ import annotations

import argparse
import math
import os
from typing import Sequence, Tuple

from PIL import Image, ImageDraw

RGBA = Tuple[int, int, int, int]

# Brand palette (design tokens) — transparent ground, two blues, ink.
CLEAR: RGBA = (11, 13, 17, 0)
BLUE: RGBA = (47, 129, 247, 255)
BLUE_BRIGHT: RGBA = (90, 160, 255, 255)
INK: RGBA = (11, 13, 17, 255)

# Sizes the Windows shell (electron-builder win.icon / NSIS) expects to find.
ICO_SIZES: Sequence[Tuple[int, int]] = (
    (16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256),
)

# Geometry as fractions of the canvas edge (the mark was designed on a 256 grid).
RING_RADIUS = 86 / 256
RING_STROKE = 11 / 256
TICK_INNER, TICK_OUTER, TICK_STROKE = 70 / 256, 100 / 256, 11 / 256
BRACKET_OFFSET, BRACKET_ARM, BRACKET_STROKE = 96 / 256, 22 / 256, 9 / 256
PUPIL_RADIUS, IRIS_RADIUS = 32 / 256, 12 / 256

MASTER_PX = 1024   # render size; downsampled to each ICO_SIZES entry


def _polar(centre: float, radius: float, angle_deg: float) -> Tuple[float, float]:
    """Point at `radius` from `centre` along `angle_deg` (0° = up, clockwise)."""
    rad = math.radians(angle_deg)
    return centre + radius * math.sin(rad), centre - radius * math.cos(rad)


def draw_mark(edge: int) -> Image.Image:
    """Draw the mark on a fresh `edge`×`edge` transparent canvas."""
    canvas = Image.new("RGBA", (edge, edge), CLEAR)
    pen = ImageDraw.Draw(canvas)
    c = edge / 2
    px = lambda fraction: fraction * edge  # noqa: E731 — tiny local scale helper

    def disc(radius: float, **style: object) -> None:
        r = px(radius)
        pen.ellipse([c - r, c - r, c + r, c + r], **style)

    # Aperture ring.
    disc(RING_RADIUS, outline=BLUE, width=round(px(RING_STROKE)))

    # N / E / S / W ticks straddling the ring.
    for heading in (0, 90, 180, 270):
        pen.line(
            [_polar(c, px(TICK_INNER), heading), _polar(c, px(TICK_OUTER), heading)],
            fill=BLUE, width=round(px(TICK_STROKE)),
        )

    # Corner reticle brackets: an L in each quadrant, arms pointing inward.
    off, arm, stroke = px(BRACKET_OFFSET), px(BRACKET_ARM), round(px(BRACKET_STROKE))
    for qx, qy in ((-1, -1), (1, -1), (-1, 1), (1, 1)):
        corner = (c + qx * off, c + qy * off)
        pen.line([corner, (corner[0] - qx * arm, corner[1])], fill=BLUE_BRIGHT, width=stroke)
        pen.line([corner, (corner[0], corner[1] - qy * arm)], fill=BLUE_BRIGHT, width=stroke)

    # Pupil and iris.
    disc(PUPIL_RADIUS, fill=BLUE)
    disc(IRIS_RADIUS, fill=INK)
    return canvas


def build_icon(out_path: str, preview_path: str | None = None) -> None:
    master = draw_mark(MASTER_PX)
    largest = max(size for size, _ in ICO_SIZES)
    base = master.resize((largest, largest), Image.LANCZOS)
    base.save(out_path, format="ICO", sizes=list(ICO_SIZES))
    if preview_path:
        base.save(preview_path, format="PNG")


def main(argv: Sequence[str] | None = None) -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default=os.path.join(here, "icon.ico"),
                        help="where to write the .ico (default: next to this script)")
    parser.add_argument("--png", default=None, metavar="PREVIEW",
                        help="also write a 256 px PNG preview to this path")
    args = parser.parse_args(argv)

    build_icon(args.out, args.png)
    print("wrote", args.out, "sizes", ", ".join(str(w) for w, _ in ICO_SIZES))
    if args.png:
        print("wrote", args.png)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
