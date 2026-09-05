#!/usr/bin/env bash
# ============================================================================
# Eye in the Sky -- Ground Station Setup (Linux)
# ----------------------------------------------------------------------------
# Idempotent bootstrap for a Linux ground-station dev box (LINUX_PRD §8).
# The Linux counterpart of scripts/setup-ground.ps1.
#
# What it does
#   1. Verifies Node.js >= 20.
#   2. npm install  in ground/ui          (shared React renderer)
#   3. npm install  in ground/app/linux   (Electron shell, Linux electron binary)
#   4. Builds the UI (tsc + vite build) into ground/ui/dist
#   5. Prints next-step instructions.
#
# Usage (from anywhere):
#   bash scripts/setup-ground-linux.sh
#
# Environment variables honoured:
#   EIS_SKIP_BUILD=1   -- install deps but skip the UI build
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UI_DIR="$REPO_ROOT/ground/ui"
APP_DIR="$REPO_ROOT/ground/app/linux"

cyan()  { printf '\033[36m==> %s\033[0m\n' "$1"; }
ok()    { printf '    [OK] %s\n' "$1"; }
fail()  { printf '\033[31m    [FAIL] %s\033[0m\n' "$1" >&2; exit 1; }

# 1. Node.js version check ----------------------------------------------------
cyan "Checking Node.js version (require >= 20)"
command -v node >/dev/null 2>&1 || fail "Node.js not found. Install Node >= 20 (e.g. via nvm or your distro)."
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js $(node --version) is too old (need >= 20)."
ok "Node.js $(node --version)"
command -v npm >/dev/null 2>&1 || fail "npm not found (ships with Node)."
ok "npm $(npm --version)"

# 2. UI deps ------------------------------------------------------------------
[ -d "$UI_DIR" ] || fail "ground/ui not found at $UI_DIR"
cyan "Installing ground/ui dependencies"
( cd "$UI_DIR" && npm install --prefer-offline )
ok "ground/ui node_modules ready"

# 3. App (linux) deps ---------------------------------------------------------
[ -d "$APP_DIR" ] || fail "ground/app/linux not found at $APP_DIR"
cyan "Installing ground/app/linux dependencies"
( cd "$APP_DIR" && npm install --prefer-offline )
ok "ground/app/linux node_modules ready"

# 4. Build the UI (unless skipped) -------------------------------------------
if [ "${EIS_SKIP_BUILD:-0}" = "1" ]; then
  printf '    EIS_SKIP_BUILD=1: skipping UI build.\n'
else
  cyan "Building ground/ui (TypeScript typecheck + Vite build)"
  ( cd "$UI_DIR" && npm run build )
  ok "ground/ui built -> ground/ui/dist/"
fi

# 5. Next steps ---------------------------------------------------------------
cat <<'EOF'

============================================================
 Eye in the Sky -- Linux ground station ready!
============================================================

  Dev mode (UI hot-reload + Electron):
    cd ground/app/linux
    npm run dev

  Connect to SITL (run setup-sim.sh first):
    cp .env.example .env   # verify EIS_SITL=true
    npm run dev            (in ground/app/linux)

  Build Linux packages (AppImage + .deb + .rpm):
    ./build-resources/make-icons.sh   # first time: real icon from the brand SVG
    cd ground/app/linux && npm run package:linux

  Gamepad access (Manual Control): the .deb/.rpm installs a udev rule
  automatically; for the AppImage, see ground/app/linux/build-resources/.
EOF
