#!/usr/bin/env bash
# ============================================================================
# Drone Safety Platform -- Ground Station Setup (Linux)
# ----------------------------------------------------------------------------
# Idempotent bootstrap for a Linux ground-station dev box (LINUX_PRD §8).
# The Linux counterpart of scripts/setup-ground.ps1.
#
# What it does
#   1. Verifies Node.js >= 20.
#   2. npm install  in ground/planner     (deterministic planner + verifier)
#   3. npm install  in ground/ui          (shared React renderer)
#   4. npm install  in ground/app/linux   (Electron shell, Linux electron binary)
#   5. Builds ground/planner -> ground/planner/dist   (FM-83)
#   6. Builds the UI (tsc + vite build) into ground/ui/dist
#   7. Builds the Electron shell -> ground/app/linux/dist-electron  (FM-132)
#   8. Asserts every built artefact exists, then prints next steps.
#
# BUILD ORDER MATTERS. The Electron main process `require`s
# ground/planner/dist/index.js at runtime and package.json's `main` is
# dist-electron/main.js; both are gitignored, so a fresh clone has NEITHER
# until this script produces them. Before FM-83/FM-132 this script installed
# and built only ground/ui, so a fresh clone gave "Cannot find module
# dist-electron/main.js" at launch, or a "Planning failed" toast the moment the
# inspection button was pressed.
#
# Usage (from anywhere):
#   bash scripts/setup-ground-linux.sh
#
# Environment variables honoured:
#   EIS_SKIP_BUILD=1   -- install deps but skip every build (artefact
#                         assertions are skipped with it)
# ============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLANNER_DIR="$REPO_ROOT/ground/planner"
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

# 2. Planner deps -------------------------------------------------------------
# The Electron main process loads ground/planner/dist at runtime; without its
# node_modules there is nothing to build it with (FM-83).
[ -d "$PLANNER_DIR" ] || fail "ground/planner not found at $PLANNER_DIR"
cyan "Installing ground/planner dependencies"
( cd "$PLANNER_DIR" && npm install --prefer-offline )
ok "ground/planner node_modules ready"

# 3. UI deps ------------------------------------------------------------------
[ -d "$UI_DIR" ] || fail "ground/ui not found at $UI_DIR"
cyan "Installing ground/ui dependencies"
( cd "$UI_DIR" && npm install --prefer-offline )
ok "ground/ui node_modules ready"

# 4. App (linux) deps ---------------------------------------------------------
[ -d "$APP_DIR" ] || fail "ground/app/linux not found at $APP_DIR"
cyan "Installing ground/app/linux dependencies"
( cd "$APP_DIR" && npm install --prefer-offline )
ok "ground/app/linux node_modules ready"

# 5-7. Build everything the shell loads at runtime (unless skipped) -----------
# Order: planner -> ui -> electron, the order they are loaded in, so a failure
# points at the thing that failed.
if [ "${EIS_SKIP_BUILD:-0}" = "1" ]; then
  printf '    EIS_SKIP_BUILD=1: skipping every build (planner, UI, Electron shell).\n'
  printf '    The ground station will NOT start until these are built.\n'
else
  cyan "Building ground/planner (deterministic planner + verifier) -> dist/"
  ( cd "$PLANNER_DIR" && npm run build )
  ok "ground/planner built -> ground/planner/dist/"

  cyan "Building ground/ui (TypeScript typecheck + Vite build)"
  ( cd "$UI_DIR" && npm run build )
  ok "ground/ui built -> ground/ui/dist/"

  cyan "Building the Electron shell -> ground/app/linux/dist-electron/"
  ( cd "$APP_DIR" && npm run build:electron )
  ok "Electron main/preload built -> dist-electron/"

  # Artefact assertions. Every path here is loaded at RUNTIME; a build that
  # "succeeded" without producing them fails at launch instead — which is what
  # FM-83 and FM-132 both were.
  cyan "Verifying built artefacts"
  assert_artefact() {
    [ -f "$1" ] || fail "MISSING $2: $1"
    ok "$2 -> $1"
  }
  assert_artefact "$PLANNER_DIR/dist/index.js"      "planner bundle (phase3Host require)"
  assert_artefact "$UI_DIR/dist/index.html"         "built UI (main.ts loadFile)"
  assert_artefact "$APP_DIR/dist-electron/main.js"    "Electron main (package.json main)"
  assert_artefact "$APP_DIR/dist-electron/preload.js" "Electron preload (webPreferences)"
fi

# 8. Next steps ---------------------------------------------------------------
cat <<'EOF'

============================================================
 Drone Safety Platform -- Linux ground station ready!
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

  After editing ground/planner or the shell's TypeScript, RE-RUN this script
  (or rebuild by hand) — the shell loads the BUILT artefacts, so an unbuilt
  edit silently runs the previous build.
EOF
