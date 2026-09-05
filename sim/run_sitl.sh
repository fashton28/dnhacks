#!/usr/bin/env bash
# ============================================================================
# Eye in the Sky -- ArduCopter SITL launcher (run_sitl.sh)
# ----------------------------------------------------------------------------
# Launches ArduCopter SITL and exposes MAVLink over udp:127.0.0.1:14550 for the
# companion (eis_companion). Loads sim/params/eis-sitl.parm so the simulated
# vehicle matches the flashed FC (GUIDED, geofence, failsafes, EKF3).
#
# Two backends, tried in order:
#   1. sim_vehicle.py from an ArduPilot source checkout  (PREFERRED -- richest)
#   2. the prebuilt `arducopter` SITL binary             (FALLBACK)
#
# Usage:
#   ./run_sitl.sh                 # default: GUIDED-ready copter @ udp 14550
#   EIS_SITL_SPEEDUP=5 ./run_sitl.sh
#   ARDUPILOT_HOME=~/ardupilot ./run_sitl.sh
#
# Output link for the companion:
#   The companion connects to udp:127.0.0.1:14550 (config/sitl.yaml: mav_url).
#   A second out is offered on udp:127.0.0.1:14551 for a separate GCS/MAVProxy.
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
#       wsl -d Ubuntu -- bash -lc "cd /mnt/c/Users/User/Documents/eyeinthesky && ./sim/run_sitl.sh"
#   The UDP port (14550) is reachable from Windows-side processes because WSL2
#   forwards localhost. If you prefer a native binary, build arducopter for
#   Windows (Cygwin/MSYS2) per ArduPilot docs and set EIS_SITL_BIN to it; this
#   script's fallback path will use it. There is no pure-PowerShell SITL build.
# ============================================================================
set -euo pipefail

# --- configurable knobs ------------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARAMS="${EIS_SITL_PARAMS:-$HERE/params/eis-sitl.parm}"
SPEEDUP="${EIS_SITL_SPEEDUP:-1}"          # 1 = realtime; >1 = faster-than-real
# Default home: a clear open field (lat,lon,alt,heading). Override with EIS_SITL_HOME.
HOME_LOC="${EIS_SITL_HOME:-14.5995,120.9842,10,0}"   # Manila-ish; any open spot works
MAV_OUT_COMPANION="udp:127.0.0.1:14550"   # the companion connects here
MAV_OUT_GCS="udp:127.0.0.1:14551"         # spare out for a separate GCS
VEHICLE="ArduCopter"

echo "== Eye in the Sky :: ArduCopter SITL =="
echo "   params : $PARAMS"
echo "   home   : $HOME_LOC"
echo "   speedup: ${SPEEDUP}x"
echo "   out    : $MAV_OUT_COMPANION (companion), $MAV_OUT_GCS (spare GCS)"
echo

if [[ ! -f "$PARAMS" ]]; then
  echo "!! params file not found: $PARAMS" >&2
  exit 1
fi

# --- backend 1: sim_vehicle.py (preferred) ----------------------------------
SIM_VEHICLE=""
if command -v sim_vehicle.py >/dev/null 2>&1; then
  SIM_VEHICLE="$(command -v sim_vehicle.py)"
elif [[ -n "${ARDUPILOT_HOME:-}" && -x "$ARDUPILOT_HOME/Tools/autotest/sim_vehicle.py" ]]; then
  SIM_VEHICLE="$ARDUPILOT_HOME/Tools/autotest/sim_vehicle.py"
elif [[ -x "$HOME/ardupilot/Tools/autotest/sim_vehicle.py" ]]; then
  SIM_VEHICLE="$HOME/ardupilot/Tools/autotest/sim_vehicle.py"
fi

if [[ -n "$SIM_VEHICLE" ]]; then
  echo ">> using sim_vehicle.py: $SIM_VEHICLE"
  # --out adds extra MAVLink endpoints; --map/--console suppressed for headless.
  exec python3 "$SIM_VEHICLE" \
    -v "$VEHICLE" \
    -f quad \
    --speedup "$SPEEDUP" \
    --custom-location="$HOME_LOC" \
    --add-param-file="$PARAMS" \
    --out="$MAV_OUT_COMPANION" \
    --out="$MAV_OUT_GCS" \
    --no-mavproxy \
    "$@"
fi

# --- backend 2: prebuilt arducopter binary (fallback) -----------------------
# Locate the SITL binary. Override with EIS_SITL_BIN.
SITL_BIN="${EIS_SITL_BIN:-}"
if [[ -z "$SITL_BIN" ]]; then
  for cand in \
    "$(command -v arducopter 2>/dev/null || true)" \
    "${ARDUPILOT_HOME:-$HOME/ardupilot}/build/sitl/bin/arducopter" \
    "$HOME/ardupilot/build/sitl/bin/arducopter"; do
    if [[ -n "$cand" && -x "$cand" ]]; then SITL_BIN="$cand"; break; fi
  done
fi

if [[ -z "$SITL_BIN" || ! -x "$SITL_BIN" ]]; then
  cat >&2 <<'EOF'
!! Could not find sim_vehicle.py OR an arducopter SITL binary.

   Install ArduPilot once (see the header of this script), then either:
     * put Tools/autotest on PATH (so sim_vehicle.py is found), OR
     * build the SITL binary (./waf copter) and set:
         export EIS_SITL_BIN=/path/to/build/sitl/bin/arducopter

   On Windows, run this script inside WSL2 (Ubuntu).
EOF
  exit 127
fi

echo ">> using SITL binary: $SITL_BIN"
echo ">> NOTE: the raw binary emits MAVLink on tcp:127.0.0.1:5760."
echo "   Bridging tcp:5760 -> $MAV_OUT_COMPANION via mavproxy if available."

# The raw binary serves a TCP MAVLink endpoint on 5760. The companion wants
# UDP 14550, so bridge with mavproxy (preferred) or instruct the user.
RUNDIR="$(mktemp -d)"
trap 'rm -rf "$RUNDIR"' EXIT
cp "$PARAMS" "$RUNDIR/eeprom-params.parm"

# Start SITL binary in the background.
"$SITL_BIN" \
  --model quad \
  --home "$HOME_LOC" \
  --speedup "$SPEEDUP" \
  --defaults "$PARAMS" \
  &
SITL_PID=$!
trap 'kill "$SITL_PID" 2>/dev/null || true; rm -rf "$RUNDIR"' EXIT

# Give SITL a moment to open its TCP server.
sleep 3

if command -v mavproxy.py >/dev/null 2>&1; then
  echo ">> mavproxy bridging tcp:127.0.0.1:5760 -> $MAV_OUT_COMPANION / $MAV_OUT_GCS"
  exec mavproxy.py \
    --master=tcp:127.0.0.1:5760 \
    --out="$MAV_OUT_COMPANION" \
    --out="$MAV_OUT_GCS" \
    --load-module=param \
    --cmd="param load $PARAMS" \
    --daemon --non-interactive
else
  cat >&2 <<EOF
!! mavproxy.py not found to bridge TCP->UDP.

   The SITL binary is running and serving MAVLink on tcp:127.0.0.1:5760.
   Either install mavproxy ('pip install MAVProxy') so this script can bridge
   to $MAV_OUT_COMPANION, or point the companion at tcp:127.0.0.1:5760 by
   setting mav_url in companion/config/sitl.yaml accordingly.

   Keeping SITL alive in the foreground (Ctrl-C to stop)...
EOF
  wait "$SITL_PID"
fi
