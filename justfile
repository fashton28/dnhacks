# ============================================================================
# Eye in the Sky -- justfile (https://github.com/casey/just)
# ----------------------------------------------------------------------------
# Alternative to the Makefile for users who prefer `just`. All recipes
# delegate to the same scripts as the Makefile; the two are kept in sync.
#
# Install just:
#   cargo install just   OR   brew install just   OR   scoop install just
#
# Usage:
#   just          # lists all recipes (default)
#   just setup    # first-time setup
#   just e2e      # run acceptance demo
# ============================================================================

# Default: list available recipes
default:
    @just --list

# ---------------------------------------------------------------------------
# Paths (resolved relative to this justfile)
# ---------------------------------------------------------------------------
repo_root  := justfile_directory()
companion  := repo_root / "companion"
ui_dir     := repo_root / "ground" / "ui"
app_win    := repo_root / "ground" / "app" / "windows"
app_linux  := repo_root / "ground" / "app" / "linux"
venv_py    := companion / ".venv" / "bin" / "python"
venv_pip   := companion / ".venv" / "bin" / "pip"

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

# Set up all environments (calls setup-sim.sh)
setup: setup-sim
    @echo "==> setup complete. Run 'just e2e' to prove the full loop."

# Python venv + ArduPilot SITL (Linux/WSL2/macOS)
setup-sim:
    bash {{repo_root}}/scripts/setup-sim.sh

# Windows ground station (run from PowerShell, or just prints instructions)
setup-ground:
    @echo "==> Run from PowerShell: .\\scripts\\setup-ground.ps1"

# Linux ground station (Node deps + UI build)
setup-ground-linux:
    bash {{repo_root}}/scripts/setup-ground-linux.sh

# Jetson Docker image + systemd (run on the Jetson itself)
setup-jetson:
    bash {{repo_root}}/scripts/setup-jetson.sh

# ---------------------------------------------------------------------------
# Simulation
# ---------------------------------------------------------------------------

# Launch SITL + companion in the foreground (Ctrl-C to stop)
sim:
    #!/usr/bin/env bash
    set -euo pipefail
    trap 'kill %2 %1 2>/dev/null || true' SIGINT SIGTERM
    bash {{repo_root}}/sim/run_sitl.sh &
    sleep 8
    EIS_CONFIG={{repo_root}}/companion/config/sitl.yaml \
    EIS_CAMERA_SOURCE=mock \
        {{venv_py}} -m eis_companion
    wait

# Full acceptance demo (SITL + companion + e2e tests)
e2e:
    bash {{repo_root}}/scripts/run-sim-e2e.sh

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

# Build ground/ui (tsc + vite) and typecheck the Windows shell
build-ground:
    cd {{ui_dir}} && npm run build
    cd {{app_win}} && npm run typecheck

# Build ground/ui (tsc + vite) and typecheck the Linux shell
build-ground-linux:
    cd {{ui_dir}} && npm run build
    cd {{app_linux}} && npm run typecheck

# Validate companion package install
build-companion:
    {{venv_pip}} install -e "{{companion}}[dev]" --quiet
    {{venv_py}} -c "import eis_companion; print('eis_companion OK')"

# Build Windows installer (run on Windows from ground/app/windows)
dist-win:
    @echo "==> Building Windows installer..."
    cd {{app_win}} && npm run dist

# Build Linux packages: AppImage + .deb + .rpm (run on Linux)
package-linux:
    @echo "==> Building Linux packages (AppImage + .deb + .rpm)..."
    cd {{app_linux}} && npm run package:linux

# ---------------------------------------------------------------------------
# Quality
# ---------------------------------------------------------------------------

# Lint: ruff (companion) + eslint (ground/ui)
lint:
    {{venv_py}} -m ruff check {{companion}}/src {{companion}}/tests {{repo_root}}/sim
    cd {{ui_dir}} && npm run lint

# Test: pytest (companion) + tsc typecheck (ground/ui)
test:
    {{venv_py}} -m pytest {{companion}}/tests -v
    cd {{ui_dir}} && npm run typecheck

# Lint + test in one shot
check: lint test

# ---------------------------------------------------------------------------
# Clean
# ---------------------------------------------------------------------------

# Remove build artefacts
clean:
    rm -rf {{ui_dir}}/dist {{ui_dir}}/node_modules/.cache
    rm -rf {{app_win}}/dist-electron {{app_win}}/dist-installer
    rm -rf {{app_linux}}/dist-electron {{app_linux}}/dist-installer
    find {{companion}} -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
    find {{companion}} -name "*.egg-info"  -type d -exec rm -rf {} + 2>/dev/null || true
    find {{repo_root}}/sim -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
    @echo "==> Clean done."
