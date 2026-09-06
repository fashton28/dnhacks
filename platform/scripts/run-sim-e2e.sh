#!/usr/bin/env bash
# ============================================================================
# Drone Safety Platform -- acceptance gate (SITL + companion + sim clients)
# ----------------------------------------------------------------------------
# Brings the whole vehicle-side stack up on this machine, waits until the
# control WebSocket actually answers, then drives it with the two sim clients
# that speak nothing but the wire contract:
#
#   sim/e2e_test.py     arm -> takeoff -> track -> hold at standoff -> land
#   sim/manual_test.py  take/release manual control, watchdog, e-stop
#
# Everything it starts, it stops -- including on Ctrl-C and on failure.
#
# EXIT CODES (the contract; `make e2e` and CI both read them)
#   0  every test passed
#   1  at least one test failed
#   2  setup failure -- SITL or the companion never came up
#
# USAGE
#   bash scripts/run-sim-e2e.sh                # the gate
#   bash scripts/run-sim-e2e.sh --preflight    # check the box, start nothing
#   bash scripts/run-sim-e2e.sh --skip-manual
#   bash scripts/run-sim-e2e.sh --ws-url ws://127.0.0.1:8765 --timeout 90
#   make e2e
#
# ENVIRONMENT (flags above override these)
#   EIS_E2E_WS_URL    companion control WebSocket  [ws://127.0.0.1:8765]
#   EIS_E2E_TIMEOUT   seconds to wait for it       [60]
#   EIS_CONFIG        companion config file        [companion/config/sitl.yaml]
#   EIS_SKIP_MANUAL   "1" skips manual_test.py     [unset]
#   ARDUPILOT_HOME    ArduPilot checkout, consumed by sim/run_sitl.sh
#
# The resolved WebSocket URL is exported as EIS_WS_URL for the sim clients --
# that is the variable they read -- and also passed as --ws-url, which is the
# flag their CLI pins.
# ============================================================================
set -uo pipefail
IFS=$'\n\t'

readonly EXIT_PASS=0
readonly EXIT_TEST_FAILED=1
readonly EXIT_SETUP_FAILED=2

readonly SITL_SETTLE_SECONDS=8   # MAVLink needs this long before it answers
readonly POLL_INTERVAL_SECONDS=2

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

VENV_PYTHON="$REPO_ROOT/companion/.venv/bin/python"
SITL_LAUNCHER="$REPO_ROOT/sim/run_sitl.sh"

WS_URL="${EIS_E2E_WS_URL:-ws://127.0.0.1:8765}"
READY_TIMEOUT="${EIS_E2E_TIMEOUT:-60}"
COMPANION_CONFIG="${EIS_CONFIG:-$REPO_ROOT/companion/config/sitl.yaml}"
SKIP_MANUAL="${EIS_SKIP_MANUAL:-0}"
PREFLIGHT_ONLY=0

# Parallel arrays: one entry per supervised background child.
CHILD_PIDS=()
CHILD_LABELS=()
# Test ledger, "<name> <PASS|FAIL|SKIP>" per entry.
RESULTS=()
WORK_DIR=""
PROBE_KIND="websockets"

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
step() { echo; echo "==> $*"; }
ok()   { echo "    [OK] $*"; }
fail() { echo "    [FAIL] $*" >&2; }
info() { echo "    $*"; }
rule() { echo "============================================================"; }

die_setup() {
    fail "$*"
    exit "$EXIT_SETUP_FAILED"
}

usage() {
    cat <<EOF
Drone Safety Platform -- acceptance gate

  bash scripts/run-sim-e2e.sh [options]

    --preflight        verify this box can run the gate, then stop
    --skip-manual      run e2e_test.py only
    --ws-url URL       companion control WebSocket  (env EIS_E2E_WS_URL)
    --timeout SECONDS  readiness budget             (env EIS_E2E_TIMEOUT)
    --config PATH      companion config file        (env EIS_CONFIG)
    -h, --help         this text

Exit codes: $EXIT_PASS pass / $EXIT_TEST_FAILED test failed / $EXIT_SETUP_FAILED setup failed
EOF
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --preflight)   PREFLIGHT_ONLY=1 ;;
            --skip-manual) SKIP_MANUAL=1 ;;
            --ws-url)      WS_URL="${2:-}"; shift ;;
            --timeout)     READY_TIMEOUT="${2:-}"; shift ;;
            --config)      COMPANION_CONFIG="${2:-}"; shift ;;
            -h|--help)     usage; exit "$EXIT_PASS" ;;
            *)             usage >&2; die_setup "unknown option: $1" ;;
        esac
        shift
    done
}

# ---------------------------------------------------------------------------
# Supervised children: spawn records them, teardown stops them in reverse.
# ---------------------------------------------------------------------------
spawn() {
    local label="$1"; shift
    "$@" &
    local pid=$!
    CHILD_PIDS+=("$pid")
    CHILD_LABELS+=("$label")
    ok "$label started (PID $pid)"
}

child_alive() {
    kill -0 "$1" 2>/dev/null
}

teardown() {
    local rc=$?
    local i pid label

    echo
    step "Tearing down..."
    for (( i = ${#CHILD_PIDS[@]} - 1; i >= 0; i-- )); do
        pid="${CHILD_PIDS[$i]}"
        label="${CHILD_LABELS[$i]}"
        if child_alive "$pid"; then
            info "Stopping $label (PID $pid)"
            kill "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
        fi
    done
    [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]] && rm -rf "$WORK_DIR"

    print_ledger
    echo
    rule
    if [[ $rc -eq $EXIT_PASS ]]; then
        echo " ALL E2E TESTS PASSED"
    else
        echo " E2E TESTS FAILED (exit $rc)"
    fi
    rule
    exit "$rc"
}

print_ledger() {
    local entry
    [[ ${#RESULTS[@]} -eq 0 ]] && return 0
    echo
    step "Results"
    for entry in "${RESULTS[@]}"; do
        info "$entry"
    done
}

# ---------------------------------------------------------------------------
# Preflight: everything that can be checked without starting a process.
# ---------------------------------------------------------------------------
check_environment() {
    step "Preflight"

    [[ -x "$VENV_PYTHON" ]] || die_setup \
        "venv not found at $REPO_ROOT/companion/.venv -- run: bash scripts/setup-sim.sh"
    ok "python: $VENV_PYTHON"

    [[ -f "$COMPANION_CONFIG" ]] || die_setup \
        "companion config not found: $COMPANION_CONFIG (expected companion/config/sitl.yaml)"
    ok "config: $COMPANION_CONFIG"

    [[ -f "$SITL_LAUNCHER" ]] || die_setup "SITL launcher missing: $SITL_LAUNCHER"
    ok "SITL launcher: $SITL_LAUNCHER"

    local client
    for client in e2e_test.py manual_test.py; do
        [[ -f "$REPO_ROOT/sim/$client" ]] || die_setup "sim client missing: sim/$client"
        ok "sim client: sim/$client"
    done

    if "$VENV_PYTHON" -c "import websockets" >/dev/null 2>&1; then
        ok "websockets importable -- readiness probe opens a real WebSocket"
    else
        PROBE_KIND="tcp"
        info "[WARN] websockets not importable; readiness falls back to a TCP probe"
    fi

    ok "target: $WS_URL (ready budget ${READY_TIMEOUT}s)"
}

# ---------------------------------------------------------------------------
# Readiness probes. Both are written once into WORK_DIR and re-run each poll.
# ---------------------------------------------------------------------------
write_probes() {
    WORK_DIR="$(mktemp -d)"

    cat >"$WORK_DIR/probe_ws.py" <<'PY'
import asyncio
import sys

import websockets


async def _touch(url: str) -> None:
    async with websockets.connect(url, open_timeout=2):
        pass


try:
    asyncio.run(_touch(sys.argv[1]))
except Exception:
    sys.exit(1)
sys.exit(0)
PY

    cat >"$WORK_DIR/probe_tcp.py" <<'PY'
import socket
import sys
from urllib.parse import urlsplit

parts = urlsplit(sys.argv[1])
host = parts.hostname or "127.0.0.1"
port = parts.port or 8765
try:
    with socket.create_connection((host, port), timeout=2):
        pass
except OSError:
    sys.exit(1)
sys.exit(0)
PY
}

companion_answers() {
    local probe="$WORK_DIR/probe_ws.py"
    [[ "$PROBE_KIND" == "tcp" ]] && probe="$WORK_DIR/probe_tcp.py"
    "$VENV_PYTHON" "$probe" "$WS_URL" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Stage 1: SITL
# ---------------------------------------------------------------------------
start_sitl() {
    step "Starting ArduCopter SITL (background)"
    info "SITL script: $SITL_LAUNCHER"
    spawn "SITL" bash "$SITL_LAUNCHER"

    info "Waiting ${SITL_SETTLE_SECONDS} s for SITL to initialise MAVLink..."
    sleep "$SITL_SETTLE_SECONDS"

    child_alive "${CHILD_PIDS[0]}" || die_setup \
        "SITL exited prematurely. Check sim/run_sitl.sh output."
    ok "SITL running"
}

# ---------------------------------------------------------------------------
# Stage 2: companion (SITL config, mock camera so no hardware is touched)
# ---------------------------------------------------------------------------
companion_process() {
    # `cd` here rather than with `env -C`: BSD/macOS env has no -C.
    cd "$REPO_ROOT" || return "$EXIT_SETUP_FAILED"
    EIS_CONFIG="$COMPANION_CONFIG" \
    EIS_CAMERA_SOURCE=mock \
        exec "$VENV_PYTHON" -m eis_companion.app
}

start_companion() {
    step "Starting companion (SITL mode, mock camera)"
    info "EIS_CONFIG=$COMPANION_CONFIG EIS_CAMERA_SOURCE=mock"
    spawn "companion" companion_process
}

wait_for_companion() {
    local companion_pid="${CHILD_PIDS[$(( ${#CHILD_PIDS[@]} - 1 ))]}"
    local waited=0

    step "Waiting for companion WebSocket ($WS_URL, up to ${READY_TIMEOUT}s, $PROBE_KIND probe)"

    while (( waited < READY_TIMEOUT )); do
        if companion_answers; then
            ok "Companion WebSocket ready after ${waited}s"
            return 0
        fi
        child_alive "$companion_pid" || die_setup \
            "Companion exited before becoming ready."
        sleep "$POLL_INTERVAL_SECONDS"
        waited=$(( waited + POLL_INTERVAL_SECONDS ))
        info "  ...${waited}s"
    done

    die_setup "Companion WebSocket not ready after ${READY_TIMEOUT}s."
}

# ---------------------------------------------------------------------------
# Stage 3: the sim clients. Their CLI is the contract: --ws-url, plus
# EIS_WS_URL in the environment.
# ---------------------------------------------------------------------------
run_sim_client() {
    local name="$1"
    local rc=0

    step "Running sim/$name"
    EIS_WS_URL="$WS_URL" "$VENV_PYTHON" "$REPO_ROOT/sim/$name" --ws-url "$WS_URL" || rc=$?

    if (( rc == 0 )); then
        ok "$name PASSED"
        RESULTS+=("$name PASS")
    else
        fail "$name FAILED (exit $rc)"
        RESULTS+=("$name FAIL (exit $rc)")
    fi
    return "$rc"
}

run_acceptance() {
    local worst=0

    run_sim_client e2e_test.py || worst="$EXIT_TEST_FAILED"

    if [[ "$SKIP_MANUAL" == "1" ]]; then
        info "manual_test.py skipped (EIS_SKIP_MANUAL=1 / --skip-manual)"
        RESULTS+=("manual_test.py SKIP")
    else
        run_sim_client manual_test.py || worst="$EXIT_TEST_FAILED"
    fi

    return "$worst"
}

# ---------------------------------------------------------------------------
main() {
    parse_args "$@"
    check_environment

    if (( PREFLIGHT_ONLY == 1 )); then
        echo
        rule
        echo " PREFLIGHT OK -- nothing was started"
        rule
        exit "$EXIT_PASS"
    fi

    trap teardown EXIT
    write_probes
    start_sitl
    start_companion
    wait_for_companion

    local rc=0
    run_acceptance || rc=$?
    exit "$rc"
}

main "$@"
