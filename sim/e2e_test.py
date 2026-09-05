"""
============================================================================
Eye in the Sky -- END-TO-END ACCEPTANCE TEST (e2e_test.py)
----------------------------------------------------------------------------
THE PRIMARY ACCEPTANCE GATE (PRD 6.3, 13). Runs against a live companion that
is reachable on the control WebSocket port. It drives the WHOLE system through
the contract only -- no internal companion imports.

Preconditions (start these first, see sim/README.md):
  terminal 1:  ./sim/run_sitl.sh                     # ArduCopter SITL @ udp 14550
  terminal 2:  EIS_CONFIG=companion/config/sitl.yaml python -m eis_companion.app
               (config selects camera 'sim' so SimTargetSource drives a
                synthetic moving person into the guidance stack)

Sequence (PRD acceptance):
  connect -> arm -> takeoff(alt) -> wait airborne
    -> engageTracking + setStandoff + setMaxSpeed
    -> ASSERT the vehicle YAWS toward the target
    -> ASSERT estimatedDistance APPROACHES then HOLDS at standoff
       and NEVER breaches it (>= standoff - epsilon once converged)
    -> ASSERT groundspeed stays within maxSpeed (+ margin)
    -> disengageTracking -> rtl/land

Run either way:
  python sim/e2e_test.py                 # standalone, prints PASS/FAIL + exits
  pytest sim/e2e_test.py                 # pytest-compatible

Env knobs:
  EIS_WS_URL   (default ws://127.0.0.1:8765)
  EIS_STANDOFF (default 5.0 m)           EIS_MAXSPEED (default 2.0 m/s)
  EIS_TAKEOFF_ALT (default 10.0 m)       EIS_CONVERGE_S (default 35 s)
============================================================================
"""
from __future__ import annotations

import asyncio
import math
import os
import sys

# Allow `python sim/e2e_test.py` from anywhere: add this dir to sys.path.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from headless_client import HeadlessClient  # noqa: E402


# --- tunable acceptance params (env-overridable) ---------------------------
WS_URL = os.environ.get("EIS_WS_URL", "ws://127.0.0.1:8765")
STANDOFF = float(os.environ.get("EIS_STANDOFF", "5.0"))
MAX_SPEED = float(os.environ.get("EIS_MAXSPEED", "2.0"))
TAKEOFF_ALT = float(os.environ.get("EIS_TAKEOFF_ALT", "10.0"))
CONVERGE_S = float(os.environ.get("EIS_CONVERGE_S", "35.0"))

# Standoff is a HARD limit: once converged, estimatedDistance must never dip
# more than this small epsilon below the configured standoff.
STANDOFF_EPSILON = 0.6   # m, allowance for distance-estimate noise
SPEED_MARGIN = 0.5       # m/s, allowance over maxSpeed for FC overshoot/noise
HEADING_IMPROVE_DEG = 5.0  # min heading slew to count as "yawed toward"


async def _run(client: HeadlessClient) -> None:
    # --- 0. connect + baseline telemetry -----------------------------------
    print(f"[e2e] connecting to {WS_URL} ...")
    await client.connect()
    tel = await client.wait_for_telemetry(lambda t: True, timeout=20.0, desc="first telemetry")
    print(f"[e2e] connected. mode={tel.get('mode')} armed={tel.get('armed')}")

    # --- 1. arm ------------------------------------------------------------
    print("[e2e] arming ...")
    ack = await client.send_command("arm", expect_success=True, timeout=15.0)
    assert ack["success"], f"arm rejected: {ack.get('message')}"
    await client.wait_for_telemetry(lambda t: bool(t.get("armed")), timeout=20.0, desc="armed=true")
    print("[e2e] armed.")

    # --- 2. takeoff + wait airborne ----------------------------------------
    print(f"[e2e] takeoff to {TAKEOFF_ALT:.1f} m ...")
    ack = await client.send_command(
        "takeoff", {"altitude": TAKEOFF_ALT}, expect_success=True, timeout=15.0
    )
    assert ack["success"], f"takeoff rejected: {ack.get('message')}"

    # Airborne = climbed to within ~1.5 m of the requested altitude.
    def _airborne(t: dict) -> bool:
        rel = t.get("position", {}).get("relAlt", 0.0)
        return rel >= TAKEOFF_ALT - 1.5

    await client.wait_for_telemetry(_airborne, timeout=60.0, desc="airborne at takeoff alt")
    rel = client.last_telemetry["position"]["relAlt"]
    print(f"[e2e] airborne at relAlt={rel:.2f} m.")

    # --- 3. configure standoff + max speed, then engage tracking -----------
    print(f"[e2e] setStandoff {STANDOFF:.1f} m, setMaxSpeed {MAX_SPEED:.1f} m/s ...")
    await client.send_command("setStandoff", {"meters": STANDOFF}, expect_success=True)
    await client.send_command("setMaxSpeed", {"mps": MAX_SPEED}, expect_success=True)

    print("[e2e] engageTracking ...")
    ack = await client.send_command("engageTracking", expect_success=True, timeout=15.0)
    assert ack["success"], f"engageTracking rejected: {ack.get('message')}"

    # controlSource must become 'tracking' (exactly one active source).
    await client.wait_for_telemetry(
        lambda t: t.get("controlSource") == "tracking",
        timeout=20.0,
        desc="controlSource=='tracking'",
    )
    # Tracking must lock onto the synthetic person.
    locked = await client.wait_for_tracking(
        lambda tr: tr.get("state") == "locked" and tr.get("lockedTargetId") is not None,
        timeout=30.0,
        desc="tracking locked",
    )
    print(f"[e2e] tracking locked on target id={locked.get('lockedTargetId')}.")

    # Confirm the configured standoff is reflected back on the tracking msg.
    assert abs(locked.get("standoffDistance", -1) - STANDOFF) < 1e-6, (
        f"tracking.standoffDistance={locked.get('standoffDistance')} "
        f"!= requested {STANDOFF}"
    )

    # --- 4. ASSERT the vehicle yaws toward the target ----------------------
    print("[e2e] verifying the vehicle yaws toward the target ...")
    yawed = await _assert_yaws_toward_target(client)
    assert yawed, (
        "vehicle did not yaw toward the target: the locked bbox horizontal "
        "error never decreased and heading never slewed -- guidance yaw axis "
        "appears inactive."
    )
    print("[e2e] yaw-toward-target confirmed.")

    # --- 5. ASSERT distance approaches then holds at standoff (HARD) -------
    print(
        f"[e2e] verifying estimatedDistance converges to standoff "
        f"({STANDOFF:.1f} m) and NEVER breaches it ..."
    )
    await _assert_distance_converges_and_holds(client)
    print("[e2e] standoff convergence + hold confirmed; standoff never breached.")

    # --- 6. ASSERT groundspeed within configured maxSpeed ------------------
    speeds = [
        t.get("velocity", {}).get("groundspeed", 0.0)
        for t in list(client.telemetry_log)[-200:]
    ]
    worst = max(speeds) if speeds else 0.0
    assert worst <= MAX_SPEED + SPEED_MARGIN, (
        f"groundspeed {worst:.2f} m/s exceeded configured maxSpeed "
        f"{MAX_SPEED:.2f} m/s (+{SPEED_MARGIN} margin)"
    )
    print(f"[e2e] peak groundspeed {worst:.2f} m/s within maxSpeed cap.")

    # --- 7. disengage + land ----------------------------------------------
    print("[e2e] disengageTracking ...")
    await client.send_command("disengageTracking", expect_success=True)
    await client.wait_for_telemetry(
        lambda t: t.get("controlSource") == "auto",
        timeout=15.0,
        desc="controlSource back to 'auto'",
    )

    print("[e2e] rtl/land ...")
    # Prefer RTL; fall back to land if the companion rejects RTL.
    ack = await client.send_command("rtl", timeout=15.0)
    if not ack.get("success"):
        await client.send_command("land", expect_success=True, timeout=15.0)

    print("[e2e] PASS -- approached, held at standoff without breaching, landed.")


async def _assert_yaws_toward_target(client: HeadlessClient) -> bool:
    """Return True if the vehicle demonstrably yaws toward the locked target.

    Two independent signals (either suffices):
      (a) the locked target's bbox horizontal centre moves toward 0.5 (the
          image centre) -- i.e. |cx - 0.5| decreases meaningfully; OR
      (b) the vehicle heading slews by more than HEADING_IMPROVE_DEG while the
          target is off-centre (guidance is actively commanding yaw rate).
    """

    def _locked_cx(tr: dict) -> "float | None":
        tid = tr.get("lockedTargetId")
        for tgt in tr.get("targets", []):
            if tgt.get("id") == tid or tgt.get("isLocked"):
                bbox = tgt.get("bbox") or [0, 0, 0, 0]
                # bbox = [x, y, w, h]; centre x = x + w/2
                return bbox[0] + bbox[2] / 2.0
        return None

    # Initial off-centre error + heading.
    start_tr = client.last_tracking or await client.wait_for_tracking(
        lambda tr: tr.get("state") == "locked", timeout=10.0
    )
    cx0 = _locked_cx(start_tr)
    err0 = abs((cx0 if cx0 is not None else 0.5) - 0.5)
    h0 = (client.last_telemetry or {}).get("heading", 0.0)

    best_err = err0
    max_heading_slew = 0.0

    # Observe for up to ~12 s for the yaw response to develop.
    deadline = asyncio.get_event_loop().time() + 12.0
    while asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.25)
        tr = client.last_tracking
        if tr is not None:
            cx = _locked_cx(tr)
            if cx is not None:
                best_err = min(best_err, abs(cx - 0.5))
        h = (client.last_telemetry or {}).get("heading", h0)
        slew = abs(((h - h0 + 540.0) % 360.0) - 180.0)
        max_heading_slew = max(max_heading_slew, slew)

        # Early success: image error shrank clearly toward centre.
        if err0 > 0.05 and best_err <= err0 * 0.6:
            return True

    # Either the image error improved, or the vehicle slewed while off-centre.
    improved = err0 > 0.05 and best_err < err0 - 0.02
    slewed = err0 > 0.05 and max_heading_slew >= HEADING_IMPROVE_DEG
    # If the target started essentially centred, a near-zero error counts.
    already_centred = err0 <= 0.05 and best_err <= 0.08
    return improved or slewed or already_centred


async def _assert_distance_converges_and_holds(client: HeadlessClient) -> None:
    """Assert estimatedDistance approaches standoff, then HOLDS at/above it.

    Phase A (approach): within CONVERGE_S, estimatedDistance must come within
      a convergence band of the standoff.
    Phase B (hold): for a sustained window after convergence, estimatedDistance
      must stay >= standoff - STANDOFF_EPSILON at ALL times (HARD limit) and
      remain roughly centred on standoff (no breach, no drift away).
    """
    converge_band = max(1.0, 0.25 * STANDOFF)  # within ~25% of standoff counts
    loop = asyncio.get_event_loop()

    # --- Phase A: approach + converge -------------------------------------
    deadline = loop.time() + CONVERGE_S
    converged = False
    first_dist: "float | None" = None
    min_seen = math.inf
    while loop.time() < deadline:
        tr = client.last_tracking
        d = tr.get("estimatedDistance") if tr else None
        if isinstance(d, (int, float)):
            if first_dist is None:
                first_dist = float(d)
            min_seen = min(min_seen, float(d))
            # HARD limit holds even during approach: never close inside standoff.
            assert d >= STANDOFF - STANDOFF_EPSILON, (
                f"STANDOFF BREACH during approach: estimatedDistance={d:.2f} m "
                f"< standoff {STANDOFF:.1f} m - eps {STANDOFF_EPSILON}"
            )
            if abs(d - STANDOFF) <= converge_band:
                converged = True
                break
        await asyncio.sleep(0.2)

    assert converged, (
        f"estimatedDistance did not converge to standoff {STANDOFF:.1f} m "
        f"within {CONVERGE_S:.0f}s (first={first_dist}, closest={min_seen:.2f}). "
        f"Guidance forward axis appears not to approach the target."
    )
    # The target should be APPROACHED: closest distance must be less than where
    # we started (unless we started already at standoff).
    if first_dist is not None and first_dist > STANDOFF + converge_band:
        assert min_seen < first_dist - 0.5, (
            f"vehicle never approached: started at {first_dist:.2f} m, "
            f"closest only {min_seen:.2f} m"
        )

    # --- Phase B: hold at standoff, never breaching ------------------------
    hold_window = 12.0
    samples: "list[float]" = []
    deadline = loop.time() + hold_window
    while loop.time() < deadline:
        tr = client.last_tracking
        d = tr.get("estimatedDistance") if tr else None
        if isinstance(d, (int, float)):
            samples.append(float(d))
            assert d >= STANDOFF - STANDOFF_EPSILON, (
                f"STANDOFF BREACH during hold: estimatedDistance={d:.2f} m "
                f"< standoff {STANDOFF:.1f} m - eps {STANDOFF_EPSILON}. "
                f"This violates the hard standoff safety limit."
            )
        await asyncio.sleep(0.2)

    assert len(samples) >= 10, (
        f"too few estimatedDistance samples during hold window "
        f"({len(samples)}); is the companion publishing tracking @ ~10Hz?"
    )
    mean_hold = sum(samples) / len(samples)
    # Holding means hovering near standoff, not drifting far away.
    assert mean_hold <= STANDOFF + converge_band + 1.0, (
        f"vehicle did not HOLD at standoff: mean held distance {mean_hold:.2f} m "
        f"is well beyond standoff {STANDOFF:.1f} m (band {converge_band:.1f})"
    )
    print(
        f"[e2e]   hold samples={len(samples)} mean={mean_hold:.2f} m "
        f"min={min(samples):.2f} m max={max(samples):.2f} m (standoff {STANDOFF:.1f})"
    )


# --------------------------------------------------------------------------
# pytest entry point
# --------------------------------------------------------------------------
def test_e2e_tracking_standoff() -> None:
    """pytest wrapper: runs the full acceptance sequence, fails on any assert."""
    client = HeadlessClient(WS_URL)
    asyncio.run(_main(client))


async def _main(client: HeadlessClient) -> None:
    try:
        await _run(client)
    finally:
        await client.close()


# --------------------------------------------------------------------------
# standalone entry point
# --------------------------------------------------------------------------
def main() -> int:
    client = HeadlessClient(WS_URL)
    try:
        asyncio.run(_main(client))
    except AssertionError as exc:
        print(f"\n[e2e] FAIL -- {exc}", file=sys.stderr)
        return 1
    except (ConnectionError, TimeoutError) as exc:
        print(f"\n[e2e] FAIL (link/timeout) -- {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001
        print(f"\n[e2e] FAIL (unexpected) -- {exc!r}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
