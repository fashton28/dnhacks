#!/usr/bin/env bash
# ============================================================================
# Drone Safety Platform :: ArduCopter SITL launcher
# ----------------------------------------------------------------------------
# Brings up ArduCopter SITL and publishes MAVLink on udp:127.0.0.1:14550, which
# is the endpoint companion/config/sitl.yaml points `mav_url` at. A spare feed
# on udp:127.0.0.1:14551 is offered for MAVProxy / a second GCS, so attaching a
# debugger never steals the companion's link.
#
# The simulated airframe is parameterised from sim/params/eis-sitl.parm so it
# matches the flashed FC: GUIDED enabled, geofence, failsafes, EKF3.
#
# BACKENDS (probed in this order, first hit wins)
#   sim_vehicle  ArduPilot's sim_vehicle.py from a source checkout. Preferred:
#                it wires both --out endpoints itself and we exec into it.
#   binary       A prebuilt `arducopter` SITL binary. It only speaks
#                tcp:127.0.0.1:5760, so mavproxy.py is used to bridge that TCP
#                endpoint out to the two UDP feeds above.
#
# EXIT CODES
#   0    SITL ran (or --preflight found a usable backend)
#   1    the parameter file is missing
#   127  neither backend is installed
#
# USAGE
#   ./run_sitl.sh                       # GUIDED-ready copter on udp:14550
#   ./run_sitl.sh --preflight           # report the chosen backend, run nothing
#   ./run_sitl.sh --help
#   EIS_SITL_SPEEDUP=5 ./run_sitl.sh
#   ARDUPILOT_HOME=~/ardupilot ./run_sitl.sh
#
#   A leading --help/--preflight is consumed by this script; every other
#   argument is forwarded verbatim to sim_vehicle.py.
#
# ENVIRONMENT
#   EIS_SITL_PARAMS   parameter file            [sim/params/eis-sitl.parm]
#   EIS_SITL_SPEEDUP  1 = realtime, >1 faster   [1]
#   EIS_SITL_HOME     lat,lon,alt,heading       [41.1992364,-98.3995821,550,0]
#   EIS_SITL_BIN      explicit arducopter binary (skips the search)
#   ARDUPILOT_HOME    ArduPilot checkout        [~/ardupilot]
#
# ----------------------------------------------------------------------------
# ONE-TIME ArduPilot install (Linux / WSL2 / macOS) -- do this ONCE:
#
#   git clone --recurse-submodules https://github.com/ArduPilot/ardupilot.git
#   cd ardupilot
#   Tools/environment_install/install-prereqs-ubuntu.sh -y     # (or -mac)
#   . ~/.profile
#   ./waf configure --board sitl
#   ./waf copter
#   # add Tools/autotest to PATH so sim_vehicle.py is found:
#   echo 'export PATH=$PATH:$HOME/ardupilot/Tools/autotest' >> ~/.bashrc
#   export ARDUPILOT_HOME=$HOME/ardupilot
#
# Pin a known-good tag for reproducibility, e.g.:
#   git checkout Copter-4.5.7 && git submodule update --init --recursive
#
# WINDOWS NOTE (.ps1 equivalent):
#   ArduPilot SITL is best run under WSL2 (Ubuntu) on Windows. From PowerShell:
#       wsl -d Ubuntu -- bash -lc "cd /mnt/c/path/to/repository/platform && ./sim/run_sitl.sh"
#   The UDP port (14550) is reachable from Windows-side processes because WSL2
#   forwards localhost. If you prefer a native binary, build arducopter for
#   Windows (Cygwin/MSYS2) per ArduPilot docs and set EIS_SITL_BIN to it; this
#   script's fallback path will use it. There is no pure-PowerShell SITL build.
# ============================================================================
set -euo pipefail

# --- fixed wire facts (never derived, never overridable) --------------------
readonly VEHICLE="ArduCopter"
readonly FRAME="quad"
readonly MAV_OUT_COMPANION="udp:127.0.0.1:14550"
readonly MAV_OUT_GCS="udp:127.0.0.1:14551"
readonly SITL_TCP="tcp:127.0.0.1:5760"

readonly EXIT_NO_PARAMS=1
readonly EXIT_NO_BACKEND=127

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- operator knobs ---------------------------------------------------------
PARAMS="${EIS_SITL_PARAMS:-$SCRIPT_DIR/params/eis-sitl.parm}"
SPEEDUP="${EIS_SITL_SPEEDUP:-1}"
# Default home is the Meridian Station pad: lat,lon,alt,heading. It matches the
# site model in site/site.stub.json, so plans, fences and detections line up with
# the aircraft. Override with EIS_SITL_HOME for a different site.
HOME_LOC="${EIS_SITL_HOME:-41.1992364,-98.3995821,550,0}"

# --- teardown bookkeeping ---------------------------------------------------
SITL_PID=""
SCRATCH_DIR=""

say()  { printf '%s\n' "$*"; }
note() { printf '>> %s\n' "$*"; }
oops() { printf '!! %s\n' "$*" >&2; }

teardown() {
    if [[ -n "$SITL_PID" ]]; then
        kill "$SITL_PID" 2>/dev/null || true
    fi
    if [[ -n "$SCRATCH_DIR" && -d "$SCRATCH_DIR" ]]; then
        rm -rf "$SCRATCH_DIR"
    fi
}

usage() {
    cat <<EOF
Drone Safety Platform :: ArduCopter SITL launcher

  run_sitl.sh [--help | --preflight] [sim_vehicle.py args...]

Publishes MAVLink on $MAV_OUT_COMPANION (companion) and $MAV_OUT_GCS (spare
GCS). A leading --help/--preflight is consumed here; anything else is passed
straight to sim_vehicle.py.

Backends, in probe order:
  1. sim_vehicle.py  (PATH, \$ARDUPILOT_HOME/Tools/autotest, ~/ardupilot/...)
  2. arducopter binary (\$EIS_SITL_BIN, PATH, <ardupilot>/build/sitl/bin)
     bridged from $SITL_TCP to the UDP feeds by mavproxy.py

Environment:
  EIS_SITL_PARAMS   parameter file            [sim/params/eis-sitl.parm]
  EIS_SITL_SPEEDUP  1 = realtime, >1 faster   [1]
  EIS_SITL_HOME     lat,lon,alt,heading       [41.1992364,-98.3995821,550,0]
  EIS_SITL_BIN      explicit arducopter binary
  ARDUPILOT_HOME    ArduPilot checkout        [~/ardupilot]

Exit codes: 0 ran / $EXIT_NO_PARAMS params missing / $EXIT_NO_BACKEND no backend installed
EOF
}

# ---------------------------------------------------------------------------
# Backend discovery. Each locator echoes an absolute path, or nothing.
# ---------------------------------------------------------------------------
locate_sim_vehicle() {
    local candidate
    if candidate="$(command -v sim_vehicle.py 2>/dev/null)"; then
        printf '%s' "$candidate"
        return 0
    fi
    for candidate in \
        "${ARDUPILOT_HOME:-}/Tools/autotest/sim_vehicle.py" \
        "$HOME/ardupilot/Tools/autotest/sim_vehicle.py"
    do
        [[ "$candidate" == /Tools/* ]] && continue   # ARDUPILOT_HOME unset
        if [[ -x "$candidate" ]]; then
            printf '%s' "$candidate"
            return 0
        fi
    done
    return 1
}

locate_sitl_binary() {
    local candidate
    if [[ -n "${EIS_SITL_BIN:-}" ]]; then
        [[ -x "$EIS_SITL_BIN" ]] || return 1
        printf '%s' "$EIS_SITL_BIN"
        return 0
    fi
    for candidate in \
        "$(command -v arducopter 2>/dev/null || true)" \
        "${ARDUPILOT_HOME:-$HOME/ardupilot}/build/sitl/bin/arducopter" \
        "$HOME/ardupilot/build/sitl/bin/arducopter"
    do
        if [[ -n "$candidate" && -x "$candidate" ]]; then
            printf '%s' "$candidate"
            return 0
        fi
    done
    return 1
}

no_backend_advice() {
    cat >&2 <<'EOF'
!! Could not find sim_vehicle.py OR an arducopter SITL binary.

   Install ArduPilot once (see the header of this script), then either:
     * put Tools/autotest on PATH (so sim_vehicle.py is found), OR
     * build the SITL binary (./waf copter) and set:
         export EIS_SITL_BIN=/path/to/build/sitl/bin/arducopter

   On Windows, run this script inside WSL2 (Ubuntu).
EOF
}

banner() {
    say "== Drone Safety Platform :: ArduCopter SITL =="
    say "   params : $PARAMS"
    say "   home   : $HOME_LOC"
    say "   speedup: ${SPEEDUP}x"
    say "   out    : $MAV_OUT_COMPANION (companion), $MAV_OUT_GCS (spare GCS)"
    say ""
}

require_params() {
    if [[ ! -f "$PARAMS" ]]; then
        oops "params file not found: $PARAMS"
        exit "$EXIT_NO_PARAMS"
    fi
    # sim_vehicle.py and mavproxy are launched from other directories; make the
    # path independent of the caller's cwd.
    PARAMS="$(cd "$(dirname "$PARAMS")" && pwd)/$(basename "$PARAMS")"
}

# ---------------------------------------------------------------------------
# Backend 1: sim_vehicle.py -- exec, so signals and exit status pass straight
# through to whoever launched this script.
# ---------------------------------------------------------------------------
launch_via_sim_vehicle() {
    local sim_vehicle="$1"; shift
    note "using sim_vehicle.py: $sim_vehicle"
    # --map/--console stay off: this runs headless under the e2e harness.
    exec python3 "$sim_vehicle" \
        -v "$VEHICLE" \
        -f "$FRAME" \
        --speedup "$SPEEDUP" \
        --custom-location="$HOME_LOC" \
        --add-param-file="$PARAMS" \
        --out="$MAV_OUT_COMPANION" \
        --out="$MAV_OUT_GCS" \
        --no-mavproxy \
        "$@"
}

# ---------------------------------------------------------------------------
# Backend 2: raw binary + mavproxy bridge.
# The binary serves MAVLink on tcp:127.0.0.1:5760 only; the companion wants
# udp:14550, so mavproxy fans the TCP master out to both UDP endpoints.
# ---------------------------------------------------------------------------
launch_via_binary() {
    local sitl_bin="$1"

    note "using SITL binary: $sitl_bin"
    note "NOTE: the raw binary emits MAVLink on $SITL_TCP."
    say  "   Bridging ${SITL_TCP#tcp:} -> $MAV_OUT_COMPANION via mavproxy if available."

    SCRATCH_DIR="$(mktemp -d)"
    trap teardown EXIT INT TERM
    cp "$PARAMS" "$SCRATCH_DIR/eeprom-params.parm"

    # Run the binary out of the scratch dir so its eeprom/log droppings do not
    # land in the caller's cwd. PARAMS was absolutised by require_params.
    (
        cd "$SCRATCH_DIR"
        exec "$sitl_bin" \
            --model "$FRAME" \
            --home "$HOME_LOC" \
            --speedup "$SPEEDUP" \
            --defaults "$PARAMS"
    ) &
    SITL_PID=$!

    # Give the binary a moment to open its TCP server before bridging.
    sleep 3

    if command -v mavproxy.py >/dev/null 2>&1; then
        note "mavproxy bridging ${SITL_TCP#tcp:} -> $MAV_OUT_COMPANION / $MAV_OUT_GCS"
        exec mavproxy.py \
            --master="$SITL_TCP" \
            --out="$MAV_OUT_COMPANION" \
            --out="$MAV_OUT_GCS" \
            --load-module=param \
            --cmd="param load $PARAMS" \
            --daemon --non-interactive
    fi

    cat >&2 <<EOF
!! mavproxy.py not found to bridge TCP->UDP.

   The SITL binary is running and serving MAVLink on ${SITL_TCP#tcp:}.
   Either install mavproxy ('pip install MAVProxy') so this script can bridge
   to $MAV_OUT_COMPANION, or point the companion at ${SITL_TCP#tcp:} by
   setting mav_url in companion/config/sitl.yaml accordingly.

   Keeping SITL alive in the foreground (Ctrl-C to stop)...
EOF
    wait "$SITL_PID"
}

# ---------------------------------------------------------------------------
# --preflight: answer "would this box start SITL?" without starting anything.
# ---------------------------------------------------------------------------
preflight() {
    local sim_vehicle sitl_bin
    banner
    require_params
    say "   [OK] params readable"

    if sim_vehicle="$(locate_sim_vehicle)"; then
        say "   [OK] backend: sim_vehicle.py -> $sim_vehicle"
        return 0
    fi
    say "   [--] sim_vehicle.py not found"

    if sitl_bin="$(locate_sitl_binary)"; then
        say "   [OK] backend: arducopter binary -> $sitl_bin"
        if command -v mavproxy.py >/dev/null 2>&1; then
            say "   [OK] mavproxy.py available to bridge ${SITL_TCP#tcp:} -> $MAV_OUT_COMPANION"
        else
            say "   [--] mavproxy.py missing: the companion would have to use ${SITL_TCP#tcp:}"
        fi
        return 0
    fi
    say "   [--] arducopter binary not found"
    no_backend_advice
    return "$EXIT_NO_BACKEND"
}

main() {
    local rc=0
    case "${1:-}" in
        -h|--help)
            usage
            return 0
            ;;
        --preflight)
            preflight || rc=$?
            return "$rc"
            ;;
    esac

    banner
    require_params

    local sim_vehicle sitl_bin
    if sim_vehicle="$(locate_sim_vehicle)"; then
        launch_via_sim_vehicle "$sim_vehicle" "$@"
    fi

    if sitl_bin="$(locate_sitl_binary)"; then
        launch_via_binary "$sitl_bin"
        return $?
    fi

    no_backend_advice
    return "$EXIT_NO_BACKEND"
}

main "$@"
