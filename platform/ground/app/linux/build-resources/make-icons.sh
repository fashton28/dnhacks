#!/bin/sh
# Drone Safety Platform — rasterise the Linux app icon from the brand SVG (LINUX_PRD §3).
#
# Source : platform/assets/logo-mark.svg (resolved relative to this script, so
#          it works from any working directory)
# Output : icon.png next to this script, 512×512 by default; electron-builder
#          derives the smaller freedesktop sizes from it.
#
#   ./build-resources/make-icons.sh            # → build-resources/icon.png
#   ./build-resources/make-icons.sh out.png    # explicit output path
#   ICON_SIZE=1024 ./build-resources/make-icons.sh
#
# Needs one rasteriser on PATH: rsvg-convert (librsvg) or inkscape. The
# committed icon.png is a placeholder so packaging works out of the box —
# regenerate it from the real logo before shipping.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
SVG="$here/../../../../assets/logo-mark.svg"   # platform/assets/logo-mark.svg
SIZE="${ICON_SIZE:-512}"
OUT="${1:-$here/icon.png}"

die() { echo "make-icons: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

case "$SIZE" in
  ''|*[!0-9]*) die "ICON_SIZE must be a positive integer, got '$SIZE'" ;;
esac
[ -f "$SVG" ] || die "brand SVG not found at $SVG"

# Pick the first available backend; each writes $OUT at $SIZE×$SIZE.
if have rsvg-convert; then
  backend=rsvg-convert
  rasterise() { rsvg-convert -w "$SIZE" -h "$SIZE" "$SVG" -o "$OUT"; }
elif have inkscape; then
  backend=inkscape
  rasterise() {
    inkscape "$SVG" --export-type=png --export-width="$SIZE" --export-height="$SIZE" -o "$OUT"
  }
else
  die "need rsvg-convert (librsvg) or inkscape on PATH to rasterise $SVG -> $OUT"
fi

rasterise
[ -s "$OUT" ] || die "$backend produced no output at $OUT"
echo "Wrote $OUT (${SIZE}x${SIZE}) via $backend from $SVG"
