#!/usr/bin/env bash
# ============================================================================
# Behavioural tests for scripts/run-sim-e2e.sh
# ----------------------------------------------------------------------------
# The acceptance gate's own contract is its EXIT CODES and the order it starts
# and stops things -- and neither was covered anywhere. These tests pin them
# without ArduPilot, without a companion and without a network, by building a
# throwaway repo whose `python` is a shim:
#
#   <tmp>/scripts/run-sim-e2e.sh      the real script, copied verbatim
#   <tmp>/sim/run_sitl.sh             a fake SITL that idles (or dies)
#   <tmp>/sim/{e2e,manual}_test.py    inert; the shim decides their exit codes
#   <tmp>/companion/.venv/bin/python  the shim
#
# The shim answers every way the script uses python: the `import websockets`
# capability probe, the readiness probe, `-m eis_companion.app`, and the two
# sim clients -- logging each call so the assertions can read them back.
# Readiness is a file the fake companion touches, so no port is ever bound.
#
# Usage:  bash scripts/test/scripts-run-sim-e2e.test.sh
# Exit:   0 all assertions passed, 1 otherwise
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_SCRIPT="$HERE/../run-sim-e2e.sh"

PASSED=0
FAILED=0

pass() { PASSED=$((PASSED + 1)); printf '  ok   %s\n' "$1"; }
flunk() { FAILED=$((FAILED + 1)); printf '  FAIL %s\n     %s\n' "$1" "$2"; }

expect_eq() {
    local what="$1" want="$2" got="$3"
    if [[ "$want" == "$got" ]]; then
        pass "$what"
    else
        flunk "$what" "want [$want], got [$got]"
    fi
}

expect_contains() {
    local what="$1" needle="$2" haystack="$3"
    if [[ "$haystack" == *"$needle"* ]]; then
        pass "$what"
    else
        flunk "$what" "expected to find [$needle] in: $haystack"
    fi
}

expect_absent() {
    local what="$1" needle="$2" haystack="$3"
    if [[ "$haystack" != *"$needle"* ]]; then
        pass "$what"
    else
        flunk "$what" "did not expect [$needle] in: $haystack"
    fi
}

# ---------------------------------------------------------------------------
# Fixture: a repo-shaped tree whose python is a shim.
# ---------------------------------------------------------------------------
make_fixture() {
    local root="$1" sitl_mode="${2:-idle}"

    mkdir -p "$root/scripts" "$root/sim" "$root/companion/config" \
             "$root/companion/.venv/bin"
    cp "$REAL_SCRIPT" "$root/scripts/run-sim-e2e.sh"
    : >"$root/companion/config/sitl.yaml"
    : >"$root/sim/e2e_test.py"
    : >"$root/sim/manual_test.py"

    if [[ "$sitl_mode" == "die" ]]; then
        printf '#!/usr/bin/env bash\nexit 3\n' >"$root/sim/run_sitl.sh"
    else
        printf '#!/usr/bin/env bash\nwhile true; do sleep 1; done\n' >"$root/sim/run_sitl.sh"
    fi
    chmod +x "$root/sim/run_sitl.sh"

    cat >"$root/companion/.venv/bin/python" <<'SHIM'
#!/usr/bin/env bash
# Stand-in for companion/.venv/bin/python. Every branch corresponds to one way
# run-sim-e2e.sh invokes python.
log() { printf '%s\n' "$*" >>"$FAKE_LOG"; }

# One-second granularity, so a SIGTERM from the gate's teardown is acted on
# within a second. A single long `sleep` would make bash defer the signal
# until it returned, and teardown's `wait` would block for its whole duration.
nap() {
    local remaining="${1:-0}"
    while [[ "$remaining" -gt 0 ]]; do
        sleep 1
        remaining=$((remaining - 1))
    done
}

case "${1:-}" in
  -c)
    case "${2:-}" in
      *websockets*) exit "${FAKE_WEBSOCKETS_RC:-0}" ;;
    esac
    exit 0
    ;;
  -m)
    if [[ "${2:-}" == "eis_companion.app" ]]; then
      log "companion cwd=$PWD config=${EIS_CONFIG:-} camera=${EIS_CAMERA_SOURCE:-}"
      nap "${FAKE_COMPANION_DELAY:-0}"
      if [[ "${FAKE_COMPANION_DIES:-0}" == "1" ]]; then
        log "companion exited"
        exit 9
      fi
      : >"$FAKE_READY_FILE"
      log "companion ready"
      nap 3600
    fi
    exit 0
    ;;
esac

case "$(basename "${1:-}")" in
  probe_ws.py)
    log "probe ws"
    [[ -f "$FAKE_READY_FILE" ]] && exit 0
    exit 1
    ;;
  probe_tcp.py)
    log "probe tcp"
    [[ -f "$FAKE_READY_FILE" ]] && exit 0
    exit 1
    ;;
  e2e_test.py)
    log "client e2e_test.py argv=${*:2} EIS_WS_URL=${EIS_WS_URL:-unset}"
    exit "${FAKE_E2E_RC:-0}"
    ;;
  manual_test.py)
    log "client manual_test.py argv=${*:2} EIS_WS_URL=${EIS_WS_URL:-unset}"
    exit "${FAKE_MANUAL_RC:-0}"
    ;;
esac
exit 0
SHIM
    chmod +x "$root/companion/.venv/bin/python"
}

# run_gate <root> [extra args...] -> sets GATE_RC, GATE_OUT, GATE_LOG
run_gate() {
    local root="$1"; shift
    export FAKE_LOG="$root/calls.log"
    export FAKE_READY_FILE="$root/ready.flag"
    : >"$FAKE_LOG"
    rm -f "$FAKE_READY_FILE"

    GATE_OUT="$(bash "$root/scripts/run-sim-e2e.sh" "$@" 2>&1)"
    GATE_RC=$?
    GATE_LOG="$(cat "$FAKE_LOG" 2>/dev/null || true)"
}

with_tmp() {
    local dir
    dir="$(mktemp -d)"
    printf '%s' "$dir"
}

# ---------------------------------------------------------------------------
echo "run-sim-e2e.sh"

# --- both clients pass -> 0, and both actually ran ------------------------
T1="$(with_tmp)"; make_fixture "$T1"
( unset FAKE_E2E_RC FAKE_MANUAL_RC FAKE_WEBSOCKETS_RC FAKE_COMPANION_DELAY || true )
FAKE_E2E_RC=0 FAKE_MANUAL_RC=0 run_gate "$T1"
expect_eq   "green run exits 0" 0 "$GATE_RC"
expect_contains "e2e_test.py ran"      "client e2e_test.py"    "$GATE_LOG"
expect_contains "manual_test.py ran"   "client manual_test.py" "$GATE_LOG"
expect_contains "clients get --ws-url" "argv=--ws-url ws://127.0.0.1:8765" "$GATE_LOG"
expect_contains "clients get EIS_WS_URL" "EIS_WS_URL=ws://127.0.0.1:8765"  "$GATE_LOG"
expect_contains "companion gets the SITL config"  "config=$T1/companion/config/sitl.yaml" "$GATE_LOG"
expect_contains "companion gets the mock camera"  "camera=mock" "$GATE_LOG"
expect_contains "companion runs from the repo root" "cwd=$T1" "$GATE_LOG"
expect_contains "summary reports the pass" "ALL E2E TESTS PASSED" "$GATE_OUT"
rm -rf "$T1"

# --- a failing client -> 1 (this is the regression the old gate swallowed) --
T2="$(with_tmp)"; make_fixture "$T2"
FAKE_E2E_RC=1 FAKE_MANUAL_RC=0 run_gate "$T2"
expect_eq "failing e2e_test.py exits 1" 1 "$GATE_RC"
expect_contains "ledger records the failure" "e2e_test.py FAIL" "$GATE_OUT"
expect_contains "manual_test.py still runs"  "client manual_test.py" "$GATE_LOG"
rm -rf "$T2"

# --- a failing manual client also fails the gate ---------------------------
T3="$(with_tmp)"; make_fixture "$T3"
FAKE_E2E_RC=0 FAKE_MANUAL_RC=1 run_gate "$T3"
expect_eq "failing manual_test.py exits 1" 1 "$GATE_RC"
expect_contains "ledger records the manual failure" "manual_test.py FAIL" "$GATE_OUT"
rm -rf "$T3"

# --- --skip-manual runs only the acceptance client -------------------------
T4="$(with_tmp)"; make_fixture "$T4"
FAKE_E2E_RC=0 run_gate "$T4" --skip-manual
expect_eq "skip-manual still exits 0" 0 "$GATE_RC"
expect_absent "manual_test.py did not run" "client manual_test.py" "$GATE_LOG"
expect_contains "ledger records the skip" "manual_test.py SKIP" "$GATE_OUT"
rm -rf "$T4"

# --- EIS_SKIP_MANUAL=1 is equivalent to the flag ---------------------------
T5="$(with_tmp)"; make_fixture "$T5"
EIS_SKIP_MANUAL=1 FAKE_E2E_RC=0 run_gate "$T5"
expect_eq "EIS_SKIP_MANUAL=1 exits 0" 0 "$GATE_RC"
expect_absent "EIS_SKIP_MANUAL=1 skips manual_test.py" "client manual_test.py" "$GATE_LOG"
rm -rf "$T5"

# --- a missing venv is a SETUP failure (2), before anything is started ------
T6="$(with_tmp)"; make_fixture "$T6"
rm -rf "$T6/companion/.venv"
run_gate "$T6"
expect_eq "missing venv exits 2" 2 "$GATE_RC"
expect_absent "nothing was started" "companion cwd=" "$GATE_LOG"
rm -rf "$T6"

# --- a missing config is a SETUP failure (2) -------------------------------
T7="$(with_tmp)"; make_fixture "$T7"
rm -f "$T7/companion/config/sitl.yaml"
run_gate "$T7"
expect_eq "missing config exits 2" 2 "$GATE_RC"
rm -rf "$T7"

# --- a companion that never answers is a SETUP failure (2) -----------------
T8="$(with_tmp)"; make_fixture "$T8"
FAKE_COMPANION_DELAY=600 run_gate "$T8" --timeout 4
expect_eq "unready companion exits 2" 2 "$GATE_RC"
expect_contains "the timeout is reported" "not ready after 4s" "$GATE_OUT"
expect_absent "no client ran" "client e2e_test.py" "$GATE_LOG"
rm -rf "$T8"

# --- a companion that exits early is detected before the budget runs out ----
T9="$(with_tmp)"; make_fixture "$T9"
FAKE_COMPANION_DIES=1 run_gate "$T9" --timeout 30
expect_eq "dead companion exits 2" 2 "$GATE_RC"
expect_contains "the death is named" "exited before becoming ready" "$GATE_OUT"
rm -rf "$T9"

# --- SITL that exits during the settle window is a setup failure -----------
T10="$(with_tmp)"; make_fixture "$T10" die
run_gate "$T10"
expect_eq "dead SITL exits 2" 2 "$GATE_RC"
expect_contains "the SITL death is named" "SITL exited prematurely" "$GATE_OUT"
rm -rf "$T10"

# --- no websockets module -> the TCP probe is used, run still completes -----
T11="$(with_tmp)"; make_fixture "$T11"
FAKE_WEBSOCKETS_RC=1 FAKE_E2E_RC=0 FAKE_MANUAL_RC=0 run_gate "$T11"
expect_eq "TCP-probe fallback still exits 0" 0 "$GATE_RC"
expect_contains "the fallback is announced" "readiness falls back to a TCP probe" "$GATE_OUT"
expect_contains "the TCP probe is the one used" "probe tcp" "$GATE_LOG"
expect_absent "the websockets probe is not used" "probe ws" "$GATE_LOG"
rm -rf "$T11"

# --- --preflight starts nothing and reports success ------------------------
T12="$(with_tmp)"; make_fixture "$T12"
run_gate "$T12" --preflight
expect_eq "preflight exits 0" 0 "$GATE_RC"
expect_contains "preflight says so" "PREFLIGHT OK" "$GATE_OUT"
expect_absent "preflight starts no companion" "companion cwd=" "$GATE_LOG"
rm -rf "$T12"

# --- an unknown option is a setup failure, not a silent default ------------
T13="$(with_tmp)"; make_fixture "$T13"
run_gate "$T13" --nonsense
expect_eq "unknown option exits 2" 2 "$GATE_RC"
rm -rf "$T13"

# --- --help is free: no fixture needed, no side effects --------------------
HELP_OUT="$(bash "$REAL_SCRIPT" --help 2>&1)"; HELP_RC=$?
expect_eq "--help exits 0" 0 "$HELP_RC"
expect_contains "--help documents the exit codes" "Exit codes: 0 pass / 1 test failed / 2 setup failed" "$HELP_OUT"

echo
printf '%d passed, %d failed\n' "$PASSED" "$FAILED"
[[ $FAILED -eq 0 ]]
