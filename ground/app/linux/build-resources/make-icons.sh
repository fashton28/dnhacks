#!/bin/sh
# Eye in the Sky — generate the Linux app icon from the brand SVG (LINUX_PRD §3).
# Produces a 512×512 icon.png in this directory (electron-builder derives the
# smaller sizes). Run on the build host before `npm run package:linux`.
#
#   ./build-resources/make-icons.sh
#
# Requires librsvg (rsvg-convert) or Inkscape. The committed icon.png is a
# placeholder so the build works out of the box — regenerate it from the real
# logo before shipping.
set -e

cd "$(dirname "$0")"
SVG="../../../../assets/logo-mark.svg"   # repo-root assets/logo-mark.svg
OUT="icon.png"

if [ ! -f "$SVG" ]; then
  echo "Brand SVG not found at $SVG" >&2
  exit 1
fi

if command -v rsvg-convert >/dev/null 2>&1; then
  rsvg-convert -w 512 -h 512 "$SVG" -o "$OUT"
elif command -v inkscape >/dev/null 2>&1; then
  inkscape "$SVG" --export-type=png --export-width=512 --export-height=512 -o "$OUT"
else
  echo "Need rsvg-convert (librsvg) or inkscape to rasterize $SVG -> $OUT" >&2
  exit 1
fi

echo "Wrote $OUT (512x512)"
