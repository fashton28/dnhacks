"""Generate build-resources/icon.ico — the Eye in the Sky brand mark
(camera-aperture ring + target reticle), multi-size for the Windows installer.
Run: python make_icon.py   (requires Pillow)."""
import os
from PIL import Image, ImageDraw

BG = (11, 13, 17, 0)          # transparent
BLUE = (47, 129, 247, 255)
BLUE_BRIGHT = (90, 160, 255, 255)
INK = (11, 13, 17, 255)

S = 256
img = Image.new("RGBA", (S, S), BG)
d = ImageDraw.Draw(img)
c = S / 2

# outer ring
d.ellipse([c - 86, c - 86, c + 86, c + 86], outline=BLUE, width=11)
# axis ticks (N/E/S/W)
for dx, dy in [(0, -1), (0, 1), (-1, 0), (1, 0)]:
    x0 = c + dx * 100
    y0 = c + dy * 100
    x1 = c + dx * 70
    y1 = c + dy * 70
    d.line([x0, y0, x1, y1], fill=BLUE, width=11)
# corner reticle brackets
for sx, sy in [(-1, -1), (1, -1), (-1, 1), (1, 1)]:
    bx = c + sx * 96
    by = c + sy * 96
    d.line([bx, by, bx - sx * 22, by], fill=BLUE_BRIGHT, width=9)
    d.line([bx, by, bx, by - sy * 22], fill=BLUE_BRIGHT, width=9)
# center pupil
d.ellipse([c - 32, c - 32, c + 32, c + 32], fill=BLUE)
d.ellipse([c - 12, c - 12, c + 12, c + 12], fill=INK)

out = os.path.join(os.path.dirname(__file__), "icon.ico")
img.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("wrote", out)
