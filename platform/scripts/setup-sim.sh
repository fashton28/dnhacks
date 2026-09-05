#!/usr/bin/env bash
# ============================================================================
# Drone Safety Platform -- Simulator Setup (Linux / WSL2 / macOS)
# ----------------------------------------------------------------------------
# Idempotent one-command bootstrap for the SITL + companion development
# environment. Run once, re-run any time to pick up dependency updates.
#
# What it does
#   1. Creates a Python virtual-env at companion/.venv (if absent).
#   2. pip install -e companion[dev]  (editable, with dev extras).
#   3. Checks for ArduPilot SITL; if missing, clones + builds it (or prints
#      the manual steps when the build env is not available).
#   4. Prints next-step instructions.
#
# Usage:
#   bash scripts/setup-sim.sh
#   # From PowerShell on Windows:
#   wsl -d Ubuntu -- bash -lc "cd /mnt/c/path/to/repository/platform && bash scripts/setup-sim.sh"
#
# Pinned versions (update here when bumping):
#   ArduPilot tag  : Copter-4.5.7
#   Python minimum : 3.10
# ============================================================================
set -euo pipefail
IFS=$'\n\t'

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
COMPANION_DIR="$REPO_ROOT/companion"
VENV_DIR="$COMPANION_DIR/.venv"
ARDUPILOT_TAG="Copter-4.5.7"
ARDUPILOT_REPO="https://github.com/ArduPilot/ardupilot.git"

step() { echo; echo "==> $*"; }
ok()   { echo "    [OK] $*"; }
info() { echo "    $*"; }
warn() { echo "    [WARN] $*" >&2; }

# ---------------------------------------------------------------------------
# Helper: version comparison (a >= b)
# ---------------------------------------------------------------------------
version_gte() {
    # Returns 0 (true) if $1 >= $2 as version strings
    [ "$(printf '%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

# ---------------------------------------------------------------------------
# 1. Python check
# ---------------------------------------------------------------------------
step "Checking Python >= 3.10"
PYTHON=""
for cand in python3.12 python3.11 python3.10 python3 python; do
    if command -v "$cand" &>/dev/null; then
        ver=$("$cand" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
        if version_gte "$ver" "3.10"; then
            PYTHON="$cand"
            ok "Using $cand ($ver)"
            break
        fi
    fi
done

if [[ -z "$PYTHON" ]]; then
    echo "ERROR: Python >= 3.10 not found." >&2
    echo "  Ubuntu/Debian: sudo apt install python3.11 python3.11-venv python3.11-dev" >&2
    echo "  macOS:         brew install python@3.11" >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# 2. Virtual environment
# ---------------------------------------------------------------------------
step "Setting up Python virtual-env at companion/.venv"

if [[ ! -d "$VENV_DIR" ]]; then
    "$PYTHON" -m venv "$VENV_DIR"
    ok "Created new venv"
else
    ok "venv already exists"
fi

VENV_PIP="$VENV_DIR/bin/pip"
VENV_PYTHON="$VENV_DIR/bin/python"

# Upgrade pip+wheel inside the venv (silent on re-run)
"$VENV_PIP" install --quiet --upgrade pip wheel

# ---------------------------------------------------------------------------
# 3. Install companion package (editable) + dev extras
# ---------------------------------------------------------------------------
step "Installing companion[dev] (editable)"
"$VENV_PIP" install -e "$COMPANION_DIR[dev]"
ok "eis_companion installed"

# ---------------------------------------------------------------------------
# 4. ArduPilot SITL
# ---------------------------------------------------------------------------
step "Checking for ArduPilot SITL"

# Resolve ARDUPILOT_HOME: prefer env var, then ~/ardupilot
AP_HOME="${ARDUPILOT_HOME:-$HOME/ardupilot}"
SIM_VEHICLE=""

# Check if sim_vehicle.py is already on PATH or inside AP_HOME
if command -v sim_vehicle.py &>/dev/null; then
    SIM_VEHICLE="$(command -v sim_vehicle.py)"
elif [[ -x "$AP_HOME/Tools/autotest/sim_vehicle.py" ]]; then
    SIM_VEHICLE="$AP_HOME/Tools/autotest/sim_vehicle.py"
fi

if [[ -n "$SIM_VEHICLE" ]]; then
    ok "sim_vehicle.py found: $SIM_VEHICLE"
    info "(ArduPilot SITL is already set up)"
else
    info "sim_vehicle.py not found -- attempting to clone + build ArduPilot."
    info "This takes ~10-20 min the first time; subsequent runs are instant."
    echo

    # Check git is available
    if ! command -v git &>/dev/null; then
        warn "git not found; cannot clone ArduPilot."
        _print_manual_sitl_steps "$AP_HOME" "$ARDUPILOT_TAG"
        exit 0
    fi

    # Check compiler
    if ! command -v gcc &>/dev/null && ! command -v clang &>/dev/null; then
        warn "No C compiler found; cannot build SITL."
        _print_manual_sitl_steps "$AP_HOME" "$ARDUPILOT_TAG"
        exit 0
    fi

    if [[ ! -d "$AP_HOME" ]]; then
        step "Cloning ArduPilot ($ARDUPILOT_TAG) -> $AP_HOME"
        git clone --branch "$ARDUPILOT_TAG" --depth 1 --recurse-submodules \
            "$ARDUPILOT_REPO" "$AP_HOME"
        ok "Cloned"
    else
        info "ArduPilot directory exists at $AP_HOME, skipping clone."
        info "To pin to $ARDUPILOT_TAG inside that checkout:"
        info "  cd $AP_HOME && git checkout $ARDUPILOT_TAG && git submodule update --init --recursive"
    fi

    # Install build prerequisites if the helper script is present
    PREREQ_SCRIPT=""
    for cand in \
        "$AP_HOME/Tools/environment_install/install-prereqs-ubuntu.sh" \
        "$AP_HOME/Tools/environment_install/install-prereqs-mac.sh"; do
        if [[ -f "$cand" ]]; then
            PREREQ_SCRIPT="$cand"
            break
        fi
    done

    if [[ -n "$PREREQ_SCRIPT" ]]; then
        step "Running ArduPilot prerequisites installer"
        info "This may prompt for sudo (package installation)."
        bash "$PREREQ_SCRIPT" -y || warn "Prereq script exited non-zero; continuing anyway."
        # Reload profile to pick up PATH additions
        # shellcheck source=/dev/null
        [[ -f "$HOME/.profile" ]] && source "$HOME/.profile" || true
    else
        warn "Prereq script not found in $AP_HOME -- ensure build tools are installed."
    fi

    # waf configure + build
    step "Building ArduPilot SITL (./waf configure && ./waf copter)"
    (
        cd "$AP_HOME"
        python3 waf configure --board sitl
        python3 waf copter -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)"
    )
    ok "ArduCopter SITL binary built"

    # Add autotest to PATH hint
    AP_AUTOTEST="$AP_HOME/Tools/autotest"
    if [[ -d "$AP_AUTOTEST" ]]; then
        if ! grep -q "$AP_AUTOTEST" "${HOME}/.bashrc" 2>/dev/null; then
            echo "export PATH=\$PATH:$AP_AUTOTEST" >> "$HOME/.bashrc"
            info "Added $AP_AUTOTEST to ~/.bashrc PATH"
        fi
        export PATH="$PATH:$AP_AUTOTEST"
    fi
    export ARDUPILOT_HOME="$AP_HOME"
    ok "ArduPilot SITL ready at $AP_HOME"
fi

# ---------------------------------------------------------------------------
# 5. Next steps
# ---------------------------------------------------------------------------
echo
echo "============================================================"
echo " Drone Safety Platform -- SITL environment ready!"
echo "============================================================"
echo
echo "  Activate the venv:"
echo "    source companion/.venv/bin/activate"
echo
echo "  Start the SITL (background terminal):"
echo "    bash sim/run_sitl.sh"
echo
echo "  Start the companion (SITL mode):"
echo "    EIS_CONFIG=companion/config/sitl.yaml python -m eis_companion"
echo
echo "  Run the full acceptance e2e:"
echo "    bash scripts/run-sim-e2e.sh"
echo
echo "  Or via make:"
echo "    make e2e"
echo

# ---------------------------------------------------------------------------
# Helper (defined after use so the early-exit paths can reference it)
# ---------------------------------------------------------------------------
_print_manual_sitl_steps() {
    local ap_home="$1"
    local tag="$2"
    cat >&2 <<EOF

  -----------------------------------------------------------------------
  MANUAL SITL SETUP (perform these steps once, then re-run this script):
  -----------------------------------------------------------------------
  git clone --branch $tag --depth 1 --recurse-submodules \\
      $ARDUPILOT_REPO $ap_home
  cd $ap_home
  Tools/environment_install/install-prereqs-ubuntu.sh -y  # or -mac
  . ~/.profile
  python3 waf configure --board sitl
  python3 waf copter
  echo 'export PATH=\$PATH:$ap_home/Tools/autotest' >> ~/.bashrc
  export ARDUPILOT_HOME=$ap_home
  -----------------------------------------------------------------------
  Then: bash scripts/setup-sim.sh
  -----------------------------------------------------------------------
EOF
}
