#!/usr/bin/env bash
# ============================================================================
# Drone Safety Platform -- Linux ground-station bootstrap (LINUX_PRD §8)
# ----------------------------------------------------------------------------
# The Linux counterpart of scripts/setup-ground.ps1. Idempotent: re-run it
# whenever dependencies move or the TypeScript changes.
#
# THE PIPELINE IS A TABLE, NOT A SCRIPT. Three workspaces are declared once,
# in the order the Electron shell loads them at RUNTIME, each with the build
# script that produces its artefacts and the artefacts themselves:
#
#     ground/planner    npm run build           dist/index.js
#     ground/ui         npm run build           dist/index.html
#     ground/app/linux  npm run build:electron  dist-electron/{main,preload}.js
#
# Everything below walks that table: install every workspace, then build every
# workspace, then assert every artefact exists.
#
# WHY THE ORDER AND THE ASSERTIONS MATTER (FM-83, FM-132)
# `ground/planner/dist` and `dist-electron/` are gitignored, and package.json's
# `main` is `dist-electron/main.js` while the main process `require`s
# `ground/planner/dist/index.js` on the first plan. A fresh clone has NEITHER.
# Installing and building only ground/ui produced a tree that started and then
# failed: "Cannot find module dist-electron/main.js" at launch, or a "Planning
# failed" toast the moment the inspection button was pressed. A build that
# "succeeds" without emitting its artefacts is the same failure deferred, so
# the artefacts are asserted rather than assumed.
#
# USAGE
#   bash scripts/setup-ground-linux.sh
#   bash scripts/setup-ground-linux.sh --check   # report state, install nothing
#   bash scripts/setup-ground-linux.sh --help
#
# ENVIRONMENT
#   EIS_SKIP_BUILD=1   install dependencies but skip every build (the artefact
#                      assertions are skipped with it)
#
# EXIT CODES
#   0  dependencies installed and (unless skipped) every artefact present
#   1  Node/npm too old or missing, a workspace missing, or a build failed
# ============================================================================
set -euo pipefail

readonly NODE_MIN_MAJOR=20

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# label | path relative to the repo root | build script | artefacts (comma-sep)
WORKSPACES=(
  "ground/planner|ground/planner|build|dist/index.js"
  "ground/ui|ground/ui|build|dist/index.html"
  "ground/app/linux|ground/app/linux|build:electron|dist-electron/main.js,dist-electron/preload.js"
)

# What each artefact is FOR -- named in the failure message so a missing file
# points at the thing that will break rather than at a path.
artefact_purpose() {
    case "$1" in
        dist/index.js)              echo "planner bundle (phase3Host require)" ;;
        dist/index.html)            echo "built UI (main.ts loadFile)" ;;
        dist-electron/main.js)      echo "Electron main (package.json main)" ;;
        dist-electron/preload.js)   echo "Electron preload (webPreferences)" ;;
        *)                          echo "build output" ;;
    esac
}

cyan() { printf '\033[36m==> %s\033[0m\n' "$1"; }
ok()   { printf '    [OK] %s\n' "$1"; }
miss() { printf '    [--] %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }
fail() { printf '\033[31m    [FAIL] %s\033[0m\n' "$1" >&2; exit 1; }

usage() {
    cat <<EOF
Drone Safety Platform -- Linux ground-station bootstrap

  bash scripts/setup-ground-linux.sh [--check | --help]

    --check   report Node/npm, workspaces and built artefacts; install nothing
    --help    this text

Environment:
  EIS_SKIP_BUILD=1   install dependencies only (artefact assertions skipped)

Exit codes: 0 ready / 1 prerequisite missing or a build failed
EOF
}

# --- record accessors -------------------------------------------------------
ws_label()     { printf '%s' "${1%%|*}"; }
ws_dir()       { local r="${1#*|}"; printf '%s/%s' "$REPO_ROOT" "${r%%|*}"; }
ws_script()    { local r="${1#*|}"; r="${r#*|}"; printf '%s' "${r%%|*}"; }
ws_artefacts() { printf '%s' "${1##*|}"; }

each_artefact() {
    # each_artefact <record> -> one relative artefact path per line.
    # The trailing newline is load-bearing: without it `read` drops the last
    # entry, which is exactly the artefact whose absence must be reported.
    printf '%s\n' "$(ws_artefacts "$1")" | tr ',' '\n'
}

# ---------------------------------------------------------------------------
# 1. Toolchain
# ---------------------------------------------------------------------------
node_major() {
    node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

require_toolchain() {
    cyan "Checking Node.js version (require >= $NODE_MIN_MAJOR)"
    command -v node >/dev/null 2>&1 || \
        fail "Node.js not found. Install Node >= $NODE_MIN_MAJOR (e.g. via nvm or your distro)."

    local major
    major="$(node_major)"
    [ -n "$major" ] || fail "could not read a version out of 'node --version'."
    [ "$major" -ge "$NODE_MIN_MAJOR" ] || \
        fail "Node.js $(node --version) is too old (need >= $NODE_MIN_MAJOR)."
    ok "Node.js $(node --version)"

    command -v npm >/dev/null 2>&1 || fail "npm not found (ships with Node)."
    ok "npm $(npm --version)"
}

# ---------------------------------------------------------------------------
# 2-4. Dependencies, one workspace at a time
# ---------------------------------------------------------------------------
install_workspaces() {
    local record label dir
    for record in "${WORKSPACES[@]}"; do
        label="$(ws_label "$record")"
        dir="$(ws_dir "$record")"
        [ -d "$dir" ] || fail "$label not found at $dir"
        cyan "Installing $label dependencies"
        ( cd "$dir" && npm install --prefer-offline )
        ok "$label node_modules ready"
    done
}

# ---------------------------------------------------------------------------
# 5-7. Builds, in load order, so a failure names the thing that failed
# ---------------------------------------------------------------------------
build_workspaces() {
    local record label dir script
    for record in "${WORKSPACES[@]}"; do
        label="$(ws_label "$record")"
        dir="$(ws_dir "$record")"
        script="$(ws_script "$record")"
        cyan "Building $label (npm run $script)"
        ( cd "$dir" && npm run "$script" ) || fail "$label build failed (npm run $script)"
        ok "$label built"
    done
}

# ---------------------------------------------------------------------------
# 8. Artefact assertions -- every path here is loaded at RUNTIME
# ---------------------------------------------------------------------------
assert_artefacts() {
    local record dir relative absolute
    cyan "Verifying built artefacts"
    for record in "${WORKSPACES[@]}"; do
        dir="$(ws_dir "$record")"
        while IFS= read -r relative; do
            [ -n "$relative" ] || continue
            absolute="$dir/$relative"
            [ -f "$absolute" ] || fail "MISSING $(artefact_purpose "$relative"): $absolute"
            ok "$(artefact_purpose "$relative") -> $absolute"
        done < <(each_artefact "$record")
    done
}

print_next_steps() {
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
}

# ---------------------------------------------------------------------------
# --check: report, install nothing, build nothing.
# ---------------------------------------------------------------------------
report_state() {
    local record label dir relative major
    cyan "Ground-station report (--check: nothing will be installed or built)"

    if command -v node >/dev/null 2>&1; then
        major="$(node_major)"
        if [ -n "$major" ] && [ "$major" -ge "$NODE_MIN_MAJOR" ]; then
            ok "Node.js $(node --version)"
        else
            miss "Node.js $(node --version) is older than $NODE_MIN_MAJOR"
        fi
    else
        miss "node not on PATH"
    fi
    if command -v npm >/dev/null 2>&1; then ok "npm $(npm --version)"; else miss "npm not on PATH"; fi

    for record in "${WORKSPACES[@]}"; do
        label="$(ws_label "$record")"
        dir="$(ws_dir "$record")"
        if [ -d "$dir" ]; then ok "workspace $label"; else miss "workspace missing: $dir"; continue; fi
        if [ -d "$dir/node_modules" ]; then ok "  node_modules present"; else miss "  node_modules absent"; fi
        while IFS= read -r relative; do
            [ -n "$relative" ] || continue
            if [ -f "$dir/$relative" ]; then
                ok "  $relative"
            else
                miss "  $relative (not built)"
            fi
        done < <(each_artefact "$record")
    done
    echo
}

main() {
    case "${1:-}" in
        -h|--help) usage; return 0 ;;
        --check)   report_state; return 0 ;;
        "")        ;;
        *)         usage >&2; printf 'unknown option: %s\n' "$1" >&2; return 1 ;;
    esac

    require_toolchain
    install_workspaces

    if [ "${EIS_SKIP_BUILD:-0}" = "1" ]; then
        note "EIS_SKIP_BUILD=1: skipping every build (planner, UI, Electron shell)."
        note "The ground station will NOT start until these are built."
    else
        build_workspaces
        assert_artefacts
    fi

    print_next_steps
}

main "$@"
