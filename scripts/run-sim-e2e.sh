#!/usr/bin/env bash
# ============================================================================
# Eye in the Sky -- Acceptance Demo: full SITL end-to-end test
# ----------------------------------------------------------------------------
# Starts SITL + companion (mock target), waits for readiness, runs both
# automated test scripts, then tears everything down.
#
# Exit codes:
#   0  all tests passed
#   1  one or more tests failed
#   2  setup failure (SITL / companion did not start)
#
# Usage:
#   bash scripts/run-sim-e2e.sh
#   # or via make:
#   make e2e
#
# Environment variables honoured:
#   EIS_E2E_WS_URL    WebSocket URL for the companion  [ws://127.0.0.1:8765]
#   EIS_E2E_TIMEOUT   Seconds to wait for companion ready  [60]
#   EIS_CONFIG        Companion config file  [companion/config/sitl.yaml]
#   EIS_SKIP_MANUAL   Set to 1 to skip manual_test.py  [unset]
#   ARDUPILOT_HOME    Path to ArduPilot checkout  [~/ardupilot]
# ============================================================================
set -uo pipefail
IFS=$'\n\t'

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

WS_URL="${EIS_E2E_WS_URL:-ws://127.0.0.1:8765}"
COMPANION_READY_TIMEOUT="${EIS_E2E_TIMEOUT:-60}"
EIS_CONFIG="${EIS_CONFIG:-$REPO_ROOT/companion/config/sitl.yaml}"
VENV_PYTHON="$REPO_ROOT/companion/.venv/bin/python"

step()  { echo; echo "==> $*"; }
ok()    { echo "    [OK] $*"; }
fail()  { echo "    [FAIL] $*" >&2; }
info()  { echo "    $*"; }

SITL_PID=""
COMPANION_PID=""

# ---------------------------------------------------------------------------
# Cleanup trap
# ---------------------------------------------------------------------------
cleanup() {
    local rc=$?
    echo
    step "Tearing down..."
    if [[ -n "$COMPANION_PID" ]] && kill -0 "$COMPANION_PID" 2>/dev/null; then
        info "Stopping companion (PID $COMPANION_PID)"
        kill "$COMPANION_PID" 2>/dev/null || true
        wait "$COMPANION_PID" 2>/dev/null || true
    fi
    if [[ -n "$SITL_PID" ]] && kill -0 "$SITL_PID" 2>/dev/null; then
        info "Stopping SITL (PID $SITL_PID)"
        kill "$SITL_PID" 2>/dev/null || true
        wait "$SITL_PID" 2>/dev/null || true
    fi
    if [[ $rc -eq 0 ]]; then
        echo
        echo "============================================================"
        echo " ALL E2E TESTS PASSED"
        echo "============================================================"
    else
        echo
        echo "============================================================"
        echo " E2E TESTS FAILED (exit $rc)"
        echo "============================================================"
    fi
    exit $rc
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. Python environment
# ---------------------------------------------------------------------------
step "Checking Python environment"

if [[ ! -x "$VENV_PYTHON" ]]; then
    echo "ERROR: venv not found at $REPO_ROOT/companion/.venv" >&2
    echo "  Run:  bash scripts/setup-sim.sh" >&2
    exit 2
fi
ok "$VENV_PYTHON"

# ---------------------------------------------------------------------------
# 2. Start SITL
# ---------------------------------------------------------------------------
step "Starting ArduCopter SITL (background)"
info "SITL script: $REPO_ROOT/sim/run_sitl.sh"

bash "$REPO_ROOT/sim/run_sitl.sh" &
SITL_PID=$!
ok "SITL PID $SITL_PID"
info "Waiting 8 s for SITL to initialise MAVLink..."
sleep 8

if ! kill -0 "$SITL_PID" 2>/dev/null; then
    echo "ERROR: SITL exited prematurely. Check sim/run_sitl.sh output." >&2
    exit 2
fi
ok "SITL running"

# ---------------------------------------------------------------------------
# 3. Start companion (SITL config, mock target source)
# ---------------------------------------------------------------------------
step "Starting companion (SITL mode, mock camera)"

if [[ ! -f "$EIS_CONFIG" ]]; then
    echo "ERROR: companion config not found: $EIS_CONFIG" >&2
    echo "  Expected: companion/config/sitl.yaml" >&2
    exit 2
fi

(
    cd "$REPO_ROOT"
    EIS_CONFIG="$EIS_CONFIG" \
    EIS_CAMERA_SOURCE=mock \
        "$VENV_PYTHON" -m eis_companion
) &
COMPANION_PID=$!
ok "Companion PID $COMPANION_PID"

# ---------------------------------------------------------------------------
# 4. Wait for companion WebSocket to become ready
# ---------------------------------------------------------------------------
step "Waiting for companion WebSocket to be ready ($WS_URL, up to ${COMPANION_READY_TIMEOUT}s)"

WAITED=0
READY=0
while [[ $WAITED -lt $COMPANION_READY_TIMEOUT ]]; do
    # Python one-liner: try connecting and immediately closing
    if "$VENV_PYTHON" -c "
import asyncio, sys
try:
    import websockets
    async def _check():
        async with websockets.connect('$WS_URL', open_timeout=2) as ws:
            pass
    asyncio.run(_check())
    sys.exit(0)
except Exception:
    sys.exit(1)
" 2>/dev/null; then
        READY=1
        break
    fi

    if ! kill -0 "$COMPANION_PID" 2>/dev/null; then
        echo "ERROR: Companion exited before becoming ready." >&2
        exit 2
    fi
    sleep 2
    WAITED=$((WAITED + 2))
    info "  ...${WAITED}s"
done

if [[ $READY -eq 0 ]]; then
    echo "ERROR: Companion WebSocket not ready after ${COMPANION_READY_TIMEOUT}s." >&2
    exit 2
fi
ok "Companion WebSocket ready"

# ---------------------------------------------------------------------------
# 5. Run e2e_test.py (primary acceptance gate)
# ---------------------------------------------------------------------------
step "Running sim/e2e_test.py"

"$VENV_PYTHON" "$REPO_ROOT/sim/e2e_test.py" \
    --ws-url "$WS_URL"
ok "e2e_test.py PASSED"

# ---------------------------------------------------------------------------
# 6. Run manual_test.py (manual-piloting acceptance gate)
# ---------------------------------------------------------------------------
if [[ "${EIS_SKIP_MANUAL:-0}" == "1" ]]; then
    info "EIS_SKIP_MANUAL=1: skipping manual_test.py"
else
    step "Running sim/manual_test.py"
    "$VENV_PYTHON" "$REPO_ROOT/sim/manual_test.py" \
        --ws-url "$WS_URL"
    ok "manual_test.py PASSED"
fi

# cleanup trap handles teardown and exit
