"""
============================================================================
Eye in the Sky -- MANUAL-PILOTING ACCEPTANCE TEST (manual_test.py)
----------------------------------------------------------------------------
Headless test of the manual-control safety behaviour (PRD 6.1, 6.3, 11, 13),
driven entirely through the WebSocket contract -- no internal companion imports.

Preconditions (same stack as e2e, see sim/README.md):
  terminal 1:  ./sim/run_sitl.sh
  terminal 2:  EIS_CONFIG=companion/config/sitl.yaml python -m eis_companion.app

Sequence:
  arm -> takeoff -> engageTracking
    -> ASSERT engageManual is REJECTED if not armed+airborne (negative check up front)
    -> engageManual -> ASSERT tracking auto-releases AND controlSource=='manual'
    -> stream manualInput frames -> ASSERT attitude/heading/relAlt/position respond
       AND stay within the clamped limits (axes clamped like guidance)
    -> STOP sending input -> ASSERT the WATCHDOG zeroes the setpoint and the
       vehicle HOLDS within the watchdog timeout (no runaway on last command)
    -> disengageManual -> ASSERT auto-hold + controlSource=='auto'
    -> emergencyStop -> ASSERT it overrides manual instantly

Run either way:
  python sim/manual_test.py              # standalone, prints PASS/FAIL + exits
  pytest sim/manual_test.py              # pytest-compatible

Env knobs:
  EIS_WS_URL   (default ws://127.0.0.1:8765)
  EIS_TAKEOFF_ALT (default 10.0 m)
  EIS_MAX_SPEED / EIS_MAX_CLIMB / EIS_MAX_YAW (clamp limits, defaults from PRD 9)
  EIS_WATCHDOG_MS (default 500)
============================================================================
"""
from __future__ import annotations

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from headless_client import HeadlessClient  # noqa: E402


# --- tunables (env-overridable, defaults mirror shared DEFAULTS / PRD 9) ----
WS_URL = os.environ.get("EIS_WS_URL", "ws://127.0.0.1:8765")
TAKEOFF_ALT = float(os.environ.get("EIS_TAKEOFF_ALT", "10.0"))
MAX_SPEED = float(os.environ.get("EIS_MAX_SPEED", "2.0"))       # m/s horizontal
MAX_CLIMB = float(os.environ.get("EIS_MAX_CLIMB", "1.5"))       # m/s vertical
MAX_YAW = float(os.environ.get("EIS_MAX_YAW", "45.0"))          # deg/s
WATCHDOG_MS = int(os.environ.get("EIS_WATCHDOG_MS", "500"))     # ms

# Margins: FC controllers and the wire add overshoot/noise; allow headroom but
# keep it tight enough that an UNCLAMPED axis would clearly fail.
SPEED_MARGIN = 0.6      # m/s over the configured horizontal cap
CLIMB_MARGIN = 0.6      # m/s over the configured climb cap
YAW_MARGIN = 20.0       # deg/s over the configured yaw cap


async def _run(client: HeadlessClient) -> None:
    print(f"[manual] connecting to {WS_URL} ...")
    await client.connect()
    await client.wait_for_telemetry(lambda t: True, timeout=20.0, desc="first telemetry")

    # --- 0. NEGATIVE: engageManual rejected when not armed+airborne --------
    # We are on the ground / disarmed at this point. Manual must be refused.
    print("[manual] (negative) engageManual must be REJECTED before armed+airborne ...")
    ack = await client.send_command("engageManual", timeout=10.0)
    assert not ack.get("success"), (
        "engageManual was ACCEPTED while not armed+airborne -- this violates "
        "the manual-control safety precondition (PRD 11)."
    )
    assert client.control_source != "manual", (
        "controlSource became 'manual' despite engageManual being refused."
    )
    print(f"[manual]   correctly rejected: {ack.get('message')!r}")

    # --- 1. arm + takeoff + airborne --------------------------------------
    print("[manual] arming + taking off ...")
    await client.send_command("arm", expect_success=True, timeout=15.0)
    await client.wait_for_telemetry(lambda t: bool(t.get("armed")), timeout=20.0, desc="armed")
    await client.send_command("takeoff", {"altitude": TAKEOFF_ALT}, expect_success=True, timeout=15.0)
    await client.wait_for_telemetry(
        lambda t: t.get("position", {}).get("relAlt", 0.0) >= TAKEOFF_ALT - 1.5,
        timeout=60.0,
        desc="airborne",
    )
    print(f"[manual] airborne at relAlt={client.last_telemetry['position']['relAlt']:.2f} m.")

    # --- 2. engageTracking first (so we can prove manual RELEASES it) ------
    print("[manual] engageTracking (so manual can prove it auto-releases) ...")
    await client.send_command("engageTracking", expect_success=True, timeout=15.0)
    await client.wait_for_telemetry(
        lambda t: t.get("controlSource") == "tracking",
        timeout=20.0,
        desc="controlSource=='tracking'",
    )
    print("[manual] tracking engaged (controlSource=='tracking').")

    # --- 3. engageManual -> tracking auto-releases + controlSource=='manual'
    print("[manual] engageManual ...")
    ack = await client.send_command("engageManual", expect_success=True, timeout=10.0)
    assert ack["success"], f"engageManual rejected while armed+airborne: {ack.get('message')}"

    await client.wait_for_telemetry(
        lambda t: t.get("controlSource") == "manual",
        timeout=10.0,
        desc="controlSource=='manual'",
    )
    # Tracking must have auto-released (mutually exclusive control sources).
    rel = await client.wait_for_tracking(
        lambda tr: tr.get("state") != "locked" or tr.get("lockedTargetId") is None,
        timeout=10.0,
        desc="tracking auto-released by engageManual",
    )
    print(
        f"[manual] manual engaged: controlSource=='manual', tracking released "
        f"(state={rel.get('state')})."
    )

    # --- 4. stream manualInput -> vehicle responds + stays within clamps ---
    await _assert_sticks_drive_within_clamps(client)

    # --- 5. STOP input -> watchdog zeroes setpoint + holds -----------------
    await _assert_watchdog_holds(client)

    # --- 6. disengageManual -> auto-hold + controlSource=='auto' -----------
    print("[manual] disengageManual ...")
    ack = await client.send_command("disengageManual", expect_success=True, timeout=10.0)
    assert ack["success"], f"disengageManual rejected: {ack.get('message')}"
    await client.wait_for_telemetry(
        lambda t: t.get("controlSource") == "auto",
        timeout=10.0,
        desc="controlSource=='auto' after release",
    )
    # Auto-hold: groundspeed should settle low (not continuing prior motion).
    await asyncio.sleep(max(1.5, 2 * WATCHDOG_MS / 1000.0))
    gs = client.last_telemetry.get("velocity", {}).get("groundspeed", 0.0)
    assert gs <= MAX_SPEED + SPEED_MARGIN, (
        f"after release the vehicle is still moving fast ({gs:.2f} m/s) -- "
        f"auto-hold did not zero the setpoint."
    )
    print(f"[manual] released: controlSource=='auto', groundspeed={gs:.2f} m/s (auto-hold).")

    # --- 7. re-engage manual, then emergencyStop overrides instantly -------
    await _assert_emergency_stop_overrides_manual(client)

    print("[manual] PASS -- manual safety behaviours all verified.")


async def _assert_sticks_drive_within_clamps(client: HeadlessClient) -> None:
    """Stream manualInput and assert the vehicle responds AND stays clamped.

    We push each axis in turn at FULL deflection (|axis|=1.0). A correctly
    clamped companion converts that to <= the configured max for that axis,
    so observed groundspeed/vspeed/yaw-rate must stay within cap+margin while
    STILL showing a clear response (non-trivial motion / heading change).
    """
    print("[manual] streaming manualInput; asserting response within clamps ...")
    loop = asyncio.get_event_loop()

    # Snapshot starting state.
    t0 = client.last_telemetry
    h_start = t0.get("heading", 0.0)
    alt_start = t0.get("position", {}).get("relAlt", 0.0)
    lat_start = t0.get("position", {}).get("lat", 0.0)
    lon_start = t0.get("position", {}).get("lon", 0.0)

    max_gs = 0.0
    max_vs = 0.0
    max_yaw_rate = 0.0
    headings: list[float] = []
    last_h = h_start
    last_t = loop.time()

    stop = asyncio.Event()

    async def _monitor() -> None:
        nonlocal max_gs, max_vs, max_yaw_rate, last_h, last_t
        while not stop.is_set():
            await asyncio.sleep(0.1)
            tel = client.last_telemetry
            if not tel:
                continue
            gs = tel.get("velocity", {}).get("groundspeed", 0.0)
            vs = abs(tel.get("velocity", {}).get("verticalSpeed", 0.0))
            h = tel.get("heading", last_h)
            now = loop.time()
            dt = max(1e-3, now - last_t)
            dh = ((h - last_h + 540.0) % 360.0) - 180.0
            yaw_rate = abs(dh) / dt
            max_gs = max(max_gs, gs)
            max_vs = max(max_vs, vs)
            # Ignore the first sample's spurious rate.
            if headings:
                max_yaw_rate = max(max_yaw_rate, yaw_rate)
            headings.append(h)
            last_h, last_t = h, now

    mon = asyncio.ensure_future(_monitor())

    # Drive a scripted sequence: forward, then yaw, then climb. Each ~2.5s of
    # full deflection at 25 Hz. axes(elapsed) -> (throttle, yaw, pitch, roll).
    def axes(elapsed: float) -> "tuple[float, float, float, float]":
        if elapsed < 2.5:
            return (0.0, 0.0, 1.0, 0.0)     # full forward pitch
        if elapsed < 5.0:
            return (0.0, 1.0, 0.0, 0.0)     # full right yaw
        if elapsed < 7.5:
            return (1.0, 0.0, 0.0, 0.0)     # full climb throttle
        return (0.0, 0.0, 0.0, 1.0)         # full right roll

    await client.stream_manual_input(axes, duration=10.0, rate_hz=25.0, stop=stop)
    stop.set()
    await mon

    tel = client.last_telemetry
    h_end = tel.get("heading", h_start)
    alt_end = tel.get("position", {}).get("relAlt", alt_start)
    lat_end = tel.get("position", {}).get("lat", lat_start)
    lon_end = tel.get("position", {}).get("lon", lon_start)

    # --- responded? --------------------------------------------------------
    moved_horiz = (abs(lat_end - lat_start) + abs(lon_end - lon_start)) > 1e-6 or max_gs > 0.3
    turned = abs(((h_end - h_start + 540.0) % 360.0) - 180.0) > 3.0 or max_yaw_rate > 3.0
    climbed = abs(alt_end - alt_start) > 0.5 or max_vs > 0.2
    assert moved_horiz, (
        "manual sticks did not move the vehicle horizontally "
        f"(max groundspeed {max_gs:.2f} m/s, no position change) -- "
        "pitch/roll axes appear inactive."
    )
    assert turned, (
        "manual yaw stick did not change heading "
        f"(heading {h_start:.1f}->{h_end:.1f}, max yaw-rate {max_yaw_rate:.1f} deg/s)."
    )
    assert climbed, (
        "manual throttle stick did not change altitude "
        f"(relAlt {alt_start:.2f}->{alt_end:.2f}, max vspeed {max_vs:.2f} m/s)."
    )

    # --- within clamps? ----------------------------------------------------
    assert max_gs <= MAX_SPEED + SPEED_MARGIN, (
        f"manual horizontal speed {max_gs:.2f} m/s EXCEEDED clamp "
        f"{MAX_SPEED:.2f} m/s (+{SPEED_MARGIN}) -- axis not clamped to limits."
    )
    assert max_vs <= MAX_CLIMB + CLIMB_MARGIN, (
        f"manual climb rate {max_vs:.2f} m/s EXCEEDED clamp "
        f"{MAX_CLIMB:.2f} m/s (+{CLIMB_MARGIN}) -- throttle axis not clamped."
    )
    assert max_yaw_rate <= MAX_YAW + YAW_MARGIN, (
        f"manual yaw rate {max_yaw_rate:.1f} deg/s EXCEEDED clamp "
        f"{MAX_YAW:.1f} deg/s (+{YAW_MARGIN}) -- yaw axis not clamped."
    )
    print(
        f"[manual]   responded + clamped: gs<= {max_gs:.2f} (cap {MAX_SPEED}), "
        f"vs<= {max_vs:.2f} (cap {MAX_CLIMB}), yaw<= {max_yaw_rate:.1f} deg/s (cap {MAX_YAW})."
    )


async def _assert_watchdog_holds(client: HeadlessClient) -> None:
    """Push full forward, STOP sending input, assert the watchdog zeroes + holds.

    The vehicle must NOT keep coasting at the last commanded velocity. Within a
    few watchdog periods groundspeed must collapse toward zero and position must
    stop advancing.
    """
    print(
        f"[manual] driving forward then STOPPING input; "
        f"asserting watchdog ({WATCHDOG_MS}ms) zeroes + holds ..."
    )

    # Drive full-forward briefly so there's real velocity to arrest.
    def axes(_e: float) -> "tuple[float, float, float, float]":
        return (0.0, 0.0, 1.0, 0.0)

    await client.stream_manual_input(axes, duration=2.0, rate_hz=25.0)

    # Record state at the instant we stop sending.
    t_stop = client.last_telemetry
    lat0 = t_stop.get("position", {}).get("lat", 0.0)
    lon0 = t_stop.get("position", {}).get("lon", 0.0)

    # Now send NOTHING. Wait several watchdog periods for it to engage + settle.
    settle = max(2.0, 4 * WATCHDOG_MS / 1000.0)
    await asyncio.sleep(settle)

    gs = client.last_telemetry.get("velocity", {}).get("groundspeed", 0.0)
    # After the watchdog + settle, the vehicle should be essentially stopped.
    assert gs <= 0.8, (
        f"WATCHDOG FAILURE: {settle:.1f}s after stopping manualInput the vehicle "
        f"is still moving at {gs:.2f} m/s -- it must zero the setpoint and hold, "
        f"never continue the last commanded velocity (PRD 11)."
    )

    # Position should be roughly stationary over a follow-up window (holding).
    lat1 = client.last_telemetry.get("position", {}).get("lat", lat0)
    lon1 = client.last_telemetry.get("position", {}).get("lon", lon0)
    await asyncio.sleep(2.0)
    lat2 = client.last_telemetry.get("position", {}).get("lat", lat1)
    lon2 = client.last_telemetry.get("position", {}).get("lon", lon1)
    drift = (abs(lat2 - lat1) + abs(lon2 - lon1))
    # ~1e-5 deg ~ 1.1 m; holding should drift far less than continued flight.
    assert drift < 5e-5, (
        f"after the watchdog engaged the vehicle kept drifting (Δlat+Δlon="
        f"{drift:.2e} deg over 2s) -- it is not holding position."
    )
    print(f"[manual]   watchdog held: groundspeed {gs:.2f} m/s, position drift {drift:.2e} deg.")


async def _assert_emergency_stop_overrides_manual(client: HeadlessClient) -> None:
    """Re-engage manual, then assert emergencyStop overrides it INSTANTLY.

    emergencyStop must need no confirmation and supersede manual: it disengages
    manual control (controlSource leaves 'manual') and commands a safe stop
    (LAND/BRAKE/disarm) immediately.
    """
    print("[manual] re-engageManual, then emergencyStop must override instantly ...")
    ack = await client.send_command("engageManual", expect_success=True, timeout=10.0)
    assert ack["success"], f"re-engageManual failed: {ack.get('message')}"
    await client.wait_for_telemetry(
        lambda t: t.get("controlSource") == "manual",
        timeout=10.0,
        desc="controlSource=='manual' before emergencyStop",
    )

    # Keep sticks flowing so we can prove the stop overrides ACTIVE manual input.
    stop_streaming = asyncio.Event()

    async def _keep_streaming() -> None:
        def axes(_e: float) -> "tuple[float, float, float, float]":
            return (0.0, 0.0, 1.0, 0.0)  # full forward
        await client.stream_manual_input(
            axes, duration=8.0, rate_hz=25.0, stop=stop_streaming
        )

    streamer = asyncio.ensure_future(_keep_streaming())

    # Fire emergencyStop (acked or not, it must take effect).
    await client.send_command("emergencyStop", timeout=10.0)

    # Within a short window controlSource must no longer be 'manual'.
    try:
        await client.wait_for_telemetry(
            lambda t: t.get("controlSource") != "manual",
            timeout=6.0,
            desc="emergencyStop overrides manual (controlSource leaves 'manual')",
        )
    finally:
        stop_streaming.set()
        await streamer

    src = client.control_source
    mode = client.last_telemetry.get("mode")
    armed = client.last_telemetry.get("armed")
    assert src != "manual", (
        f"emergencyStop did NOT override manual: controlSource still {src!r}."
    )
    # A safe stop should be reflected as LAND/BRAKE/RTL and/or disarm.
    safe_mode = mode in ("LAND", "BRAKE", "RTL") or (armed is False)
    assert safe_mode, (
        f"emergencyStop did not put the vehicle in a safe stop state "
        f"(mode={mode!r}, armed={armed!r}); expected LAND/BRAKE/RTL or disarm."
    )
    print(
        f"[manual]   emergencyStop overrode manual: controlSource={src!r}, "
        f"mode={mode!r}, armed={armed!r}."
    )


# --------------------------------------------------------------------------
# pytest + standalone entry points
# --------------------------------------------------------------------------
def test_manual_piloting() -> None:
    """pytest wrapper: runs the full manual-safety sequence, fails on any assert."""
    client = HeadlessClient(WS_URL)
    asyncio.run(_main(client))


async def _main(client: HeadlessClient) -> None:
    try:
        await _run(client)
    finally:
        # Best-effort safe-state on the way out.
        try:
            await client.send_command("disarm", timeout=5.0)
        except Exception:
            pass
        await client.close()


def main() -> int:
    client = HeadlessClient(WS_URL)
    try:
        asyncio.run(_main(client))
    except AssertionError as exc:
        print(f"\n[manual] FAIL -- {exc}", file=sys.stderr)
        return 1
    except (ConnectionError, TimeoutError) as exc:
        print(f"\n[manual] FAIL (link/timeout) -- {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001
        print(f"\n[manual] FAIL (unexpected) -- {exc!r}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
