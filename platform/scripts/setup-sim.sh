#!/usr/bin/env bash
# ============================================================================
# Drone Safety Platform -- simulator bootstrap (Linux / WSL2 / macOS)
# ----------------------------------------------------------------------------
# One command to get from a fresh clone to a box that can run the acceptance
# gate. Idempotent: every stage is a no-op once it has succeeded, so re-run it
# after any dependency bump.
#
# STAGES
#   1  find a Python >= 3.10 interpreter
#   2  create companion/.venv if it is absent
#   3  pip install -e companion[dev]   (editable, dev extras)
#   4  make ArduPilot SITL available: reuse an existing checkout, otherwise
#      clone $ARDUPILOT_TAG and build it -- and when the box cannot build
#      (no git, no compiler) print the manual recipe and stop cleanly
#   5  print what to run next
#
# USAGE
#   bash scripts/setup-sim.sh
#   bash scripts/setup-sim.sh --check     # report state, install nothing
#   bash scripts/setup-sim.sh --help
#   # From PowerShell on Windows:
#   wsl -d Ubuntu -- bash -lc "cd /mnt/c/path/to/repository/platform && bash scripts/setup-sim.sh"
#
# PINNED (bump here, nowhere else)
#   ArduPilot tag  : Copter-4.5.7
#   Python minimum : 3.10
#
# EXIT CODES
#   0  ready, or "cannot build SITL here" with the manual recipe printed
#   1  no usable Python interpreter
# ============================================================================
set -euo pipefail
IFS=$'\n\t'

readonly PYTHON_MIN_MAJOR=3
readonly PYTHON_MIN_MINOR=10
readonly ARDUPILOT_TAG="Copter-4.5.7"
readonly ARDUPILOT_REPO="https://github.com/ArduPilot/ardupilot.git"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPANION_DIR="$REPO_ROOT/companion"
VENV_DIR="$COMPANION_DIR/.venv"
AP_HOME="${ARDUPILOT_HOME:-$HOME/ardupilot}"

CHECK_ONLY=0
PYTHON=""

step() { echo; echo "==> $*"; }
ok()   { echo "    [OK] $*"; }
info() { echo "    $*"; }
warn() { echo "    [WARN] $*" >&2; }

usage() {
    cat <<EOF
Drone Safety Platform -- simulator bootstrap

  bash scripts/setup-sim.sh [--check | --help]

    --check   report Python / venv / ArduPilot state and exit; installs nothing
    --help    this text

Creates companion/.venv, installs companion[dev] into it, and makes ArduPilot
SITL ($ARDUPILOT_TAG) available at \${ARDUPILOT_HOME:-~/ardupilot}.

Exit codes: 0 ready (or manual SITL recipe printed) / 1 no Python >= ${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR}
EOF
}

# ---------------------------------------------------------------------------
# The manual recipe. Defined before anything can call it -- an early-exit path
# that forward-references a helper is an early-exit path that does not work.
# ---------------------------------------------------------------------------
print_manual_sitl_recipe() {
    cat >&2 <<EOF

  -----------------------------------------------------------------------
  MANUAL SITL SETUP (perform these steps once, then re-run this script):
  -----------------------------------------------------------------------
  git clone --branch $ARDUPILOT_TAG --depth 1 --recurse-submodules \\
      $ARDUPILOT_REPO $AP_HOME
  cd $AP_HOME
  Tools/environment_install/install-prereqs-ubuntu.sh -y  # or -mac
  . ~/.profile
  python3 waf configure --board sitl
  python3 waf copter
  echo 'export PATH=\$PATH:$AP_HOME/Tools/autotest' >> ~/.bashrc
  export ARDUPILOT_HOME=$AP_HOME
  -----------------------------------------------------------------------
  Then: bash scripts/setup-sim.sh
  -----------------------------------------------------------------------
EOF
}

# ---------------------------------------------------------------------------
# Stage 1 -- interpreter selection
# ---------------------------------------------------------------------------
# Numeric major/minor comparison; no `sort -V`, which BusyBox and older
# coreutils do not carry.
python_is_new_enough() {
    local interpreter="$1" major minor
    # Local IFS: the file-level IFS deliberately excludes the space.
    IFS=' ' read -r major minor <<<"$("$interpreter" -c \
        'import sys; print(sys.version_info[0], sys.version_info[1])' 2>/dev/null || echo "0 0")"
    if (( major > PYTHON_MIN_MAJOR )); then
        return 0
    fi
    if (( major == PYTHON_MIN_MAJOR && minor >= PYTHON_MIN_MINOR )); then
        return 0
    fi
    return 1
}

select_python() {
    local candidate
    for candidate in python3.12 python3.11 python3.10 python3 python; do
        command -v "$candidate" >/dev/null 2>&1 || continue
        if python_is_new_enough "$candidate"; then
            PYTHON="$candidate"
            return 0
        fi
    done
    return 1
}

require_python() {
    step "Checking Python >= ${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR}"
    if ! select_python; then
        {
            echo "ERROR: Python >= ${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR} not found."
            echo "  Ubuntu/Debian: sudo apt install python3.11 python3.11-venv python3.11-dev"
            echo "  macOS:         brew install python@3.11"
        } >&2
        exit 1
    fi
    ok "Using $PYTHON ($("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])'))"
}

# ---------------------------------------------------------------------------
# Stages 2 + 3 -- virtual-env and the companion package
# ---------------------------------------------------------------------------
ensure_venv() {
    step "Setting up Python virtual-env at companion/.venv"
    if [[ -d "$VENV_DIR" ]]; then
        ok "venv already exists"
    else
        "$PYTHON" -m venv "$VENV_DIR"
        ok "Created new venv"
    fi
    "$VENV_DIR/bin/pip" install --quiet --upgrade pip wheel
}

install_companion() {
    step "Installing companion[dev] (editable)"
    "$VENV_DIR/bin/pip" install -e "$COMPANION_DIR[dev]"
    ok "eis_companion installed"
}

# ---------------------------------------------------------------------------
# Stage 4 -- ArduPilot SITL
# ---------------------------------------------------------------------------
locate_sim_vehicle() {
    local found
    if found="$(command -v sim_vehicle.py 2>/dev/null)"; then
        printf '%s' "$found"
        return 0
    fi
    if [[ -x "$AP_HOME/Tools/autotest/sim_vehicle.py" ]]; then
        printf '%s' "$AP_HOME/Tools/autotest/sim_vehicle.py"
        return 0
    fi
    return 1
}

have_compiler() {
    command -v gcc >/dev/null 2>&1 || command -v clang >/dev/null 2>&1
}

cpu_count() {
    nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2
}

clone_ardupilot() {
    if [[ -d "$AP_HOME" ]]; then
        info "ArduPilot directory exists at $AP_HOME, skipping clone."
        info "To pin to $ARDUPILOT_TAG inside that checkout:"
        info "  cd $AP_HOME && git checkout $ARDUPILOT_TAG && git submodule update --init --recursive"
        return 0
    fi
    step "Cloning ArduPilot ($ARDUPILOT_TAG) -> $AP_HOME"
    git clone --branch "$ARDUPILOT_TAG" --depth 1 --recurse-submodules \
        "$ARDUPILOT_REPO" "$AP_HOME"
    ok "Cloned"
}

install_ardupilot_prereqs() {
    local script
    for script in \
        "$AP_HOME/Tools/environment_install/install-prereqs-ubuntu.sh" \
        "$AP_HOME/Tools/environment_install/install-prereqs-mac.sh"
    do
        [[ -f "$script" ]] || continue
        step "Running ArduPilot prerequisites installer"
        info "This may prompt for sudo (package installation)."
        bash "$script" -y || warn "Prereq script exited non-zero; continuing anyway."
        # Pick up PATH additions the installer wrote.
        if [[ -f "$HOME/.profile" ]]; then
            # shellcheck source=/dev/null
            source "$HOME/.profile" || true
        fi
        return 0
    done
    warn "Prereq script not found in $AP_HOME -- ensure build tools are installed."
}

build_sitl() {
    step "Building ArduPilot SITL (waf configure --board sitl && waf copter)"
    (
        cd "$AP_HOME"
        python3 waf configure --board sitl
        python3 waf copter -j"$(cpu_count)"
    )
    ok "ArduCopter SITL binary built"
}

persist_autotest_on_path() {
    local autotest="$AP_HOME/Tools/autotest"
    [[ -d "$autotest" ]] || return 0
    if ! grep -q "$autotest" "$HOME/.bashrc" 2>/dev/null; then
        echo "export PATH=\$PATH:$autotest" >> "$HOME/.bashrc"
        info "Added $autotest to ~/.bashrc PATH"
    fi
    export PATH="$PATH:$autotest"
    export ARDUPILOT_HOME="$AP_HOME"
}

ensure_ardupilot() {
    local sim_vehicle
    step "Checking for ArduPilot SITL"

    if sim_vehicle="$(locate_sim_vehicle)"; then
        ok "sim_vehicle.py found: $sim_vehicle"
        info "(ArduPilot SITL is already set up)"
        return 0
    fi

    info "sim_vehicle.py not found -- attempting to clone + build ArduPilot."
    info "This takes ~10-20 min the first time; subsequent runs are instant."
    echo

    if ! command -v git >/dev/null 2>&1; then
        warn "git not found; cannot clone ArduPilot."
        print_manual_sitl_recipe
        exit 0
    fi
    if ! have_compiler; then
        warn "No C compiler found; cannot build SITL."
        print_manual_sitl_recipe
        exit 0
    fi

    clone_ardupilot
    install_ardupilot_prereqs
    build_sitl
    persist_autotest_on_path
    ok "ArduPilot SITL ready at $AP_HOME"
}

# ---------------------------------------------------------------------------
# Stage 5 -- what to do next
# ---------------------------------------------------------------------------
print_next_steps() {
    cat <<'EOF'

============================================================
 Drone Safety Platform -- SITL environment ready!
============================================================

  Activate the venv:
    source companion/.venv/bin/activate

  Start the SITL (background terminal):
    bash sim/run_sitl.sh

  Start the companion (SITL mode):
    EIS_CONFIG=companion/config/sitl.yaml python -m eis_companion.app

  Run the full acceptance e2e:
    bash scripts/run-sim-e2e.sh

  Or via make:
    make e2e

EOF
}

# ---------------------------------------------------------------------------
# --check: report, change nothing.
# ---------------------------------------------------------------------------
report_state() {
    local sim_vehicle
    step "Environment report (--check: nothing will be installed)"

    if select_python; then
        ok "python: $PYTHON ($("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])'))"
    else
        info "[--] no Python >= ${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR} on PATH"
    fi

    if [[ -x "$VENV_DIR/bin/python" ]]; then
        ok "venv: $VENV_DIR"
    else
        info "[--] venv absent: $VENV_DIR"
    fi

    if [[ -x "$VENV_DIR/bin/python" ]] && \
       "$VENV_DIR/bin/python" -c "import eis_companion" >/dev/null 2>&1; then
        ok "eis_companion importable in the venv"
    else
        info "[--] eis_companion not installed in the venv"
    fi

    if sim_vehicle="$(locate_sim_vehicle)"; then
        ok "sim_vehicle.py: $sim_vehicle"
    else
        info "[--] sim_vehicle.py not found (looked on PATH and in $AP_HOME)"
    fi

    command -v git >/dev/null 2>&1 && ok "git present" || info "[--] git absent"
    have_compiler && ok "C compiler present" || info "[--] no gcc/clang"
    echo
}

main() {
    case "${1:-}" in
        -h|--help) usage; return 0 ;;
        --check)   CHECK_ONLY=1 ;;
        "")        ;;
        *)         usage >&2; echo "unknown option: $1" >&2; return 1 ;;
    esac

    if (( CHECK_ONLY == 1 )); then
        report_state
        return 0
    fi

    require_python
    ensure_venv
    install_companion
    ensure_ardupilot
    print_next_steps
}

main "$@"
