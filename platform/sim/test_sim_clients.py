"""Unit tests for the sim acceptance clients (sim-clients area).

These run WITHOUT SITL and without the companion: a fake in-process WebSocket
server speaks the shared contract (``shared/shared.py``) back at
``headless_client.HeadlessClient``, and the acceptance gates' evaluators are
exercised as pure functions.

    platform/companion/.venv/Scripts/python.exe -m pytest sim/test_sim_clients.py -q

What is pinned here:
  * ack correlation by command NAME, first-match FIFO, and the ack timeout
  * manualInput is fire-and-forget: shaped per contract and NEVER acked
  * every outbound frame carries vehicleId (the companion drops frames without)
  * the standoff gate fails loudly on a single breaching frame
  * CLI flags (--ws-url) and process exit codes, which scripts/run-sim-e2e.*
    depend on from the other side
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import pytest
import websockets

SIM_DIR = Path(__file__).resolve().parent
if str(SIM_DIR) not in sys.path:
    sys.path.insert(0, str(SIM_DIR))

import e2e_test  # noqa: E402
import manual_test  # noqa: E402
from headless_client import (  # noqa: E402
    EXIT_ASSERT,
    EXIT_ERROR,
    EXIT_LINK,
    EXIT_OK,
    CommandTimeout,
    HeadlessClient,
    PhaseMachine,
    drive_acceptance,
    run_acceptance,
)

VEHICLE_ID = "eis-1"


def run(coro):
    return asyncio.run(coro)


# ==========================================================================
# Fake companion: the contract, nothing else
# ==========================================================================
class FakeCompanion:
    """In-process control server that records inbound frames and pushes frames.

    ``ack_policy(command) -> (success, message)`` decides how commands are
    acked; ``auto_ack=False`` leaves acking entirely to the test.
    """

    def __init__(
        self,
        *,
        auto_ack: bool = True,
        ack_policy: Optional[Callable[[str], Any]] = None,
    ) -> None:
        self.auto_ack = auto_ack
        self.ack_policy = ack_policy or (lambda _c: (True, "ok"))
        self.received: List[dict] = []
        self.clients: set = set()
        self.url = ""
        self._server = None
        self._arrival = asyncio.Event()

    async def __aenter__(self) -> "FakeCompanion":
        self._server = await websockets.serve(self._serve, "127.0.0.1", 0)
        port = self._server.sockets[0].getsockname()[1]
        self.url = f"ws://127.0.0.1:{port}"
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        for socket in list(self.clients):
            await socket.close()
        self._server.close()
        await self._server.wait_closed()

    async def _serve(self, socket, *_args) -> None:
        self.clients.add(socket)
        self._arrival.set()
        try:
            async for raw in socket:
                frame = json.loads(raw)
                self.received.append(frame)
                if self.auto_ack and frame.get("type") == "command":
                    success, message = self.ack_policy(frame.get("command", ""))
                    await self.push(ack(frame.get("command", ""), success, message))
        except Exception:
            pass
        finally:
            self.clients.discard(socket)

    async def wait_for_client(self, timeout: float = 2.0) -> None:
        await asyncio.wait_for(self._arrival.wait(), timeout)

    async def push(self, frame: dict) -> None:
        for socket in list(self.clients):
            await socket.send(json.dumps(frame))

    def frames(self, kind: str) -> List[dict]:
        return [f for f in self.received if f.get("type") == kind]


# --- contract-shaped frame factories --------------------------------------
def telemetry(**over: Any) -> dict:
    frame: Dict[str, Any] = {
        "type": "telemetry",
        "ts": 1_700_000_000_000,
        "vehicleId": VEHICLE_ID,
        "armed": False,
        "mode": "GUIDED",
        "controlSource": "auto",
        "heading": 0.0,
        "position": {"lat": 1.0, "lon": 2.0, "alt": 100.0, "relAlt": 0.0},
        "velocity": {"groundspeed": 0.0, "verticalSpeed": 0.0},
    }
    position = over.pop("position", None)
    velocity = over.pop("velocity", None)
    if position:
        frame["position"].update(position)
    if velocity:
        frame["velocity"].update(velocity)
    frame.update(over)
    return frame


def tracking(**over: Any) -> dict:
    frame: Dict[str, Any] = {
        "type": "tracking",
        "ts": 1_700_000_000_000,
        "vehicleId": VEHICLE_ID,
        "state": "locked",
        "targets": [{"id": 7, "bbox": [0.4, 0.4, 0.2, 0.4], "confidence": 0.9, "isLocked": True}],
        "lockedTargetId": 7,
        "standoffDistance": 5.0,
        "estimatedDistance": 12.0,
        "maxSpeed": 2.0,
    }
    frame.update(over)
    return frame


def ack(command: str, success: bool = True, message: str = "ok") -> dict:
    return {
        "type": "ack",
        "ts": 1_700_000_000_000,
        "vehicleId": VEHICLE_ID,
        "command": command,
        "success": success,
        "message": message,
    }


def status(text: str, severity: str = "info") -> dict:
    return {
        "type": "statusText",
        "ts": 1_700_000_000_000,
        "vehicleId": VEHICLE_ID,
        "severity": severity,
        "text": text,
    }


# ==========================================================================
# Client: inbound routing
# ==========================================================================
def test_inbound_frames_route_to_their_own_stream():
    async def scenario():
        async with FakeCompanion() as server:
            async with HeadlessClient(server.url) as client:
                await server.wait_for_client()
                await server.push(telemetry(armed=True, controlSource="tracking"))
                await server.push(tracking(estimatedDistance=6.5))
                await server.push(status("standoff reached"))
                await client.wait_for_telemetry(lambda t: t.get("armed"), timeout=2.0)
                await client.wait_for_tracking(lambda _t: True, timeout=2.0)
                await client.wait_for_status(lambda s: "standoff" in s["text"], timeout=2.0)
                return (
                    client.control_source,
                    client.estimated_distance,
                    len(client.telemetry_log),
                    len(client.tracking_log),
                    len(client.status_log),
                )

    source, distance, tel_n, trk_n, txt_n = run(scenario())
    assert source == "tracking"
    assert distance == 6.5
    assert (tel_n, trk_n, txt_n) == (1, 1, 1)


def test_unknown_and_malformed_frames_are_ignored():
    async def scenario():
        async with FakeCompanion() as server:
            async with HeadlessClient(server.url) as client:
                await server.wait_for_client()
                for socket in list(server.clients):
                    await socket.send("not json at all")
                    await socket.send(json.dumps([1, 2, 3]))
                    await socket.send(json.dumps({"type": "fleet", "vehicleId": VEHICLE_ID}))
                await server.push(telemetry(armed=True))
                await client.wait_for_telemetry(lambda t: t.get("armed"), timeout=2.0)
                return len(client.telemetry_log), client.connected

    count, connected = run(scenario())
    assert count == 1
    assert connected is True


def test_history_is_bounded_but_latest_survives():
    async def scenario():
        async with FakeCompanion() as server:
            async with HeadlessClient(server.url, history=5) as client:
                await server.wait_for_client()
                for index in range(12):
                    await server.push(telemetry(heading=float(index)))
                await client.wait_for_telemetry(lambda t: t["heading"] == 11.0, timeout=2.0)
                return len(client.telemetry_log), client.last_telemetry["heading"]

    kept, latest = run(scenario())
    assert kept == 5
    assert latest == 11.0


# ==========================================================================
# Client: commands and acks
# ==========================================================================
def test_command_frame_carries_vehicle_id_and_params():
    async def scenario():
        async with FakeCompanion() as server:
            async with HeadlessClient(server.url, vehicle_id="eis-9") as client:
                await server.wait_for_client()
                result = await client.send_command(
                    "takeoff", {"altitude": 10.0}, timeout=2.0, expect_success=True
                )
                return server.frames("command"), result

    sent, result = run(scenario())
    assert sent == [
        {
            "type": "command",
            "vehicleId": "eis-9",
            "command": "takeoff",
            "params": {"altitude": 10.0},
        }
    ]
    assert result["success"] is True


def test_ack_matches_by_command_name_and_ignores_others():
    async def scenario():
        async with FakeCompanion(auto_ack=False) as server:
            async with HeadlessClient(server.url) as client:
                await server.wait_for_client()
                pending = asyncio.ensure_future(client.send_command("arm", timeout=3.0))
                await asyncio.sleep(0.05)
                await server.push(ack("takeoff", True, "wrong command"))
                await server.push(ack("arm", True, "armed"))
                return await pending

    assert run(scenario())["message"] == "armed"


def test_same_command_acks_resolve_first_in_first_out():
    async def scenario():
        async with FakeCompanion(auto_ack=False) as server:
            async with HeadlessClient(server.url) as client:
                await server.wait_for_client()
                first = asyncio.ensure_future(client.send_command("setStandoff", {"meters": 5.0}, timeout=3.0))
                await asyncio.sleep(0.05)
                second = asyncio.ensure_future(client.send_command("setStandoff", {"meters": 6.0}, timeout=3.0))
                await asyncio.sleep(0.05)
                await server.push(ack("setStandoff", True, "first"))
                await server.push(ack("setStandoff", False, "second"))
                return await first, await second

    first, second = run(scenario())
    assert first["message"] == "first"
    assert second["message"] == "second"


def test_missing_ack_raises_command_timeout():
    async def scenario():
        async with FakeCompanion(auto_ack=False) as server:
            async with HeadlessClient(server.url) as client:
                await server.wait_for_client()
                with pytest.raises(CommandTimeout) as caught:
                    await client.send_command("arm", timeout=0.15)
                # A late ack must not resolve the abandoned waiter.
                await server.push(ack("arm"))
                await asyncio.sleep(0.05)
                return str(caught.value)

    assert "No ack for command 'arm'" in run(scenario())


def test_expect_success_turns_a_refusal_into_an_assertion():
    async def scenario():
        async with FakeCompanion(ack_policy=lambda _c: (False, "not armed")) as server:
            async with HeadlessClient(server.url) as client:
                await server.wait_for_client()
                refused = await client.send_command("engageManual", timeout=2.0)
                with pytest.raises(AssertionError) as caught:
                    await client.send_command("engageManual", timeout=2.0, expect_success=True)
                return refused, str(caught.value)

    refused, message = run(scenario())
    assert refused["success"] is False
    assert "was rejected: not armed" in message


def test_close_fails_pending_acks_instead_of_hanging():
    async def scenario():
        async with FakeCompanion(auto_ack=False) as server:
            client = HeadlessClient(server.url)
            await client.connect()
            await server.wait_for_client()
            pending = asyncio.ensure_future(client.send_command("arm", timeout=5.0))
            await asyncio.sleep(0.05)
            await client.close()
            with pytest.raises(ConnectionError):
                await pending
            await client.close()  # idempotent

    run(scenario())


def test_connect_retries_then_reports_the_unreachable_companion():
    async def scenario():
        client = HeadlessClient("ws://127.0.0.1:9")
        with pytest.raises(ConnectionError) as caught:
            await client.connect(retries=2, retry_delay=0.01)
        return str(caught.value)

    assert "Could not connect to companion at ws://127.0.0.1:9" in run(scenario())


def test_sending_without_a_link_raises_connection_error():
    async def scenario():
        client = HeadlessClient("ws://127.0.0.1:9")
        with pytest.raises(ConnectionError):
            await client.send_command("arm")
        with pytest.raises(ConnectionError):
            await client.send_manual_input(pitch=1.0)

    run(scenario())


# ==========================================================================
# Client: manualInput is high-rate and never acked
# ==========================================================================
def test_manual_input_is_shaped_per_contract_and_never_acked():
    async def scenario():
        async with FakeCompanion() as server:
            async with HeadlessClient(server.url) as client:
                await server.wait_for_client()
                await client.send_manual_input(throttle=0.5, yaw=-1, pitch=1, roll=0)
                await asyncio.sleep(0.1)
                return server.frames("manualInput"), len(client.ack_log)

    sent, acks = run(scenario())
    assert len(sent) == 1
    frame = sent[0]
    assert frame["vehicleId"] == VEHICLE_ID
    assert (frame["throttle"], frame["yaw"], frame["pitch"], frame["roll"]) == (0.5, -1.0, 1.0, 0.0)
    assert isinstance(frame["ts"], int)
    # Per-frame acks build backpressure: the companion sends none and the
    # client awaits none.
    assert acks == 0


def test_stream_manual_input_honours_rate_duration_and_stop():
    async def scenario():
        async with FakeCompanion() as server:
            async with HeadlessClient(server.url) as client:
                await server.wait_for_client()
                sent = await client.stream_manual_input(
                    manual_test.full_forward, duration=0.25, rate_hz=40.0
                )
                halt = asyncio.Event()

                async def stop_soon():
                    await asyncio.sleep(0.05)
                    halt.set()

                stopper = asyncio.ensure_future(stop_soon())
                interrupted = await client.stream_manual_input(
                    manual_test.full_forward, duration=5.0, rate_hz=40.0, stop=halt
                )
                await stopper
                await asyncio.sleep(0.05)
                return sent, interrupted, len(server.frames("manualInput"))

    sent, interrupted, delivered = run(scenario())
    assert 6 <= sent <= 14          # ~10 frames at 40 Hz for 0.25 s
    assert 0 < interrupted < 40     # the stop event cut it short
    assert delivered == sent + interrupted


def test_scripted_sticks_walk_one_axis_at_a_time():
    assert manual_test.scripted_sticks(0.0) == (0.0, 0.0, 1.0, 0.0)
    assert manual_test.scripted_sticks(3.0) == (0.0, 1.0, 0.0, 0.0)
    assert manual_test.scripted_sticks(6.0) == (1.0, 0.0, 0.0, 0.0)
    assert manual_test.scripted_sticks(9.0) == (0.0, 0.0, 0.0, 1.0)


# ==========================================================================
# Client: waiting and following
# ==========================================================================
def test_wait_for_matches_already_buffered_frames():
    async def scenario():
        async with FakeCompanion() as server:
            async with HeadlessClient(server.url) as client:
                await server.wait_for_client()
                await server.push(telemetry(armed=True, mode="GUIDED"))
                await asyncio.sleep(0.1)
                return await client.wait_for_telemetry(
                    lambda t: t.get("armed"), timeout=0.5, desc="armed=true"
                )

    assert run(scenario())["armed"] is True


def test_wait_for_times_out_with_the_description():
    async def scenario():
        async with FakeCompanion() as server:
            async with HeadlessClient(server.url) as client:
                await server.wait_for_client()
                await server.push(telemetry())
                with pytest.raises(CommandTimeout) as caught:
                    await client.wait_for_telemetry(
                        lambda t: t["controlSource"] == "manual",
                        timeout=0.2,
                        desc="controlSource=='manual'",
                    )
                return str(caught.value)

    assert "controlSource=='manual'" in run(scenario())


def test_a_raising_predicate_is_a_non_match_not_a_crash():
    async def scenario():
        async with FakeCompanion() as server:
            async with HeadlessClient(server.url) as client:
                await server.wait_for_client()
                await server.push(telemetry())
                with pytest.raises(CommandTimeout):
                    await client.wait_for_telemetry(
                        lambda t: t["nope"]["missing"], timeout=0.2
                    )

    run(scenario())


def test_follow_yields_every_published_frame():
    async def scenario():
        async with FakeCompanion() as server:
            async with HeadlessClient(server.url) as client:
                await server.wait_for_client()

                async def publish():
                    for index in range(20):
                        await server.push(tracking(estimatedDistance=float(index)))
                        await asyncio.sleep(0.005)

                publisher = asyncio.ensure_future(publish())
                seen = []
                async for frame in client.follow("tracking", timeout=1.0):
                    seen.append(frame["estimatedDistance"])
                    if len(seen) == 20:
                        break
                await publisher
                return seen

    assert run(scenario()) == [float(i) for i in range(20)]


def test_collect_telemetry_returns_only_the_window():
    async def scenario():
        async with FakeCompanion() as server:
            async with HeadlessClient(server.url) as client:
                await server.wait_for_client()
                await server.push(telemetry(heading=1.0))
                await asyncio.sleep(0.1)

                async def publish():
                    await asyncio.sleep(0.02)
                    for heading in (2.0, 3.0):
                        await server.push(telemetry(heading=heading))

                publisher = asyncio.ensure_future(publish())
                window = await client.collect_telemetry(0.3)
                await publisher
                return [f["heading"] for f in window]

    assert run(scenario()) == [2.0, 3.0]


def test_follow_rejects_an_unknown_stream_kind():
    async def scenario():
        client = HeadlessClient("ws://127.0.0.1:9")
        with pytest.raises(ValueError):
            await client.wait_for("weather", lambda _f: True, timeout=0.1)

    run(scenario())


# ==========================================================================
# PhaseMachine + exit codes (the scripts' half of the contract)
# ==========================================================================
def test_phase_machine_visits_phases_in_order():
    log: List[str] = []

    async def first():
        log.append("first")
        return "second"

    async def second():
        log.append("second")
        return None

    machine = PhaseMachine(
        tag="unit", phases={"first": first, "second": second}, start="first", echo=lambda _m: None
    )
    assert run(machine.run()) == ["first", "second"]
    assert log == ["first", "second"]


def test_phase_machine_rejects_an_unknown_successor():
    async def only():
        return "nowhere"

    machine = PhaseMachine(
        tag="unit", phases={"only": only}, start="only", echo=lambda _m: None
    )
    with pytest.raises(KeyError):
        run(machine.run())


def test_phase_machine_breaks_a_loop_instead_of_spinning():
    async def loop():
        return "loop"

    machine = PhaseMachine(
        tag="unit",
        phases={"loop": loop},
        start="loop",
        echo=lambda _m: None,
        max_transitions=5,
    )
    with pytest.raises(AssertionError):
        run(machine.run())


def _machine_that(raiser) -> PhaseMachine:
    async def phase():
        raise raiser

    return PhaseMachine(
        tag="unit", phases={"only": phase}, start="only", echo=lambda _m: None
    )


def test_exit_codes_distinguish_assertion_link_and_unexpected_failures():
    client = HeadlessClient("ws://127.0.0.1:9")
    assert run_acceptance("unit", client, _machine_that(AssertionError("nope"))) == EXIT_ASSERT
    assert run_acceptance("unit", client, _machine_that(ConnectionError("down"))) == EXIT_LINK
    assert run_acceptance("unit", client, _machine_that(CommandTimeout("late"))) == EXIT_LINK
    assert run_acceptance("unit", client, _machine_that(RuntimeError("boom"))) == EXIT_ERROR


def test_a_clean_run_exits_zero_and_closes_the_link():
    closed: List[str] = []

    async def phase():
        return None

    class Recording(HeadlessClient):
        async def close(self):
            closed.append("closed")
            await super().close()

    client = Recording("ws://127.0.0.1:9")
    machine = PhaseMachine(
        tag="unit", phases={"only": phase}, start="only", echo=lambda _m: None
    )
    assert run_acceptance("unit", client, machine) == EXIT_OK
    assert closed == ["closed"]


def test_on_exit_hook_runs_before_the_link_closes():
    order: List[str] = []

    async def phase():
        order.append("phase")
        return None

    async def safe(_client):
        order.append("safe-state")

    client = HeadlessClient("ws://127.0.0.1:9")
    machine = PhaseMachine(
        tag="unit", phases={"only": phase}, start="only", echo=lambda _m: None
    )
    run(drive_acceptance(client, machine, on_exit=safe))
    assert order == ["phase", "safe-state"]


# ==========================================================================
# e2e evaluators
# ==========================================================================
def test_converge_band_is_a_quarter_of_standoff_with_a_one_metre_floor():
    assert e2e_test.AcceptanceParams(standoff=5.0).converge_band == 1.25
    assert e2e_test.AcceptanceParams(standoff=3.0).converge_band == 1.0
    assert e2e_test.AcceptanceParams(standoff=5.0).breach_floor == pytest.approx(4.4)


def test_locked_centre_x_uses_the_locked_target_bbox():
    assert e2e_test.locked_centre_x(tracking()) == pytest.approx(0.5)
    off = tracking(
        lockedTargetId=3,
        targets=[
            {"id": 2, "bbox": [0.0, 0.0, 0.1, 0.1], "confidence": 0.5, "isLocked": False},
            {"id": 3, "bbox": [0.7, 0.1, 0.2, 0.4], "confidence": 0.9, "isLocked": True},
        ],
    )
    assert e2e_test.locked_centre_x(off) == pytest.approx(0.8)
    assert e2e_test.locked_centre_x(tracking(targets=[], lockedTargetId=None)) is None


def test_standoff_breach_fails_loudly_in_both_phases():
    params = e2e_test.AcceptanceParams(standoff=5.0)
    e2e_test.check_standoff_not_breached(4.5, params, "approach")  # inside epsilon
    with pytest.raises(AssertionError) as approach:
        e2e_test.check_standoff_not_breached(4.21, params, "approach")
    with pytest.raises(AssertionError) as hold:
        e2e_test.check_standoff_not_breached(2.0, params, "hold")
    assert "STANDOFF BREACH during approach: estimatedDistance=4.21 m" in str(approach.value)
    assert "hard standoff safety limit" in str(hold.value)


def test_approach_must_converge_and_must_actually_close_in():
    params = e2e_test.AcceptanceParams(standoff=5.0)
    stalled = e2e_test.ApproachTrace(first=20.0, closest=19.0, converged=False, samples=9)
    with pytest.raises(AssertionError) as never:
        e2e_test.evaluate_approach(stalled, params)
    assert "did not converge to standoff" in str(never.value)

    teleported = e2e_test.ApproachTrace(first=20.0, closest=20.0, converged=True, samples=9)
    with pytest.raises(AssertionError) as no_approach:
        e2e_test.evaluate_approach(teleported, params)
    assert "vehicle never approached" in str(no_approach.value)

    good = e2e_test.ApproachTrace(first=20.0, closest=5.4, converged=True, samples=40)
    e2e_test.evaluate_approach(good, params)


def test_hold_needs_enough_samples_and_must_stay_near_standoff():
    params = e2e_test.AcceptanceParams(standoff=5.0)
    with pytest.raises(AssertionError) as sparse:
        e2e_test.evaluate_hold([5.0] * 3, params)
    assert "too few estimatedDistance samples" in str(sparse.value)

    with pytest.raises(AssertionError) as drifted:
        e2e_test.evaluate_hold([40.0] * 30, params)
    assert "did not HOLD at standoff" in str(drifted.value)

    stats = e2e_test.evaluate_hold([5.0, 5.2, 4.9] * 10, params)
    assert stats.count == 30
    assert stats.mean == pytest.approx(5.0333, abs=1e-3)


def test_speed_cap_allows_the_margin_but_not_more():
    params = e2e_test.AcceptanceParams(max_speed=2.0)
    assert e2e_test.evaluate_speed([0.5, 2.4, 1.0], params) == 2.4
    with pytest.raises(AssertionError) as caught:
        e2e_test.evaluate_speed([0.5, 3.1], params)
    assert "exceeded configured maxSpeed" in str(caught.value)
    assert e2e_test.evaluate_speed([], params) == 0.0


def test_yaw_evidence_accepts_image_error_or_heading_slew():
    # (a) the bbox error shrinks toward the image centre
    improving = e2e_test.YawEvidence(initial_error=0.30, initial_heading=0.0)
    improving.observe_tracking(
        tracking(lockedTargetId=7, targets=[{"id": 7, "bbox": [0.45, 0.1, 0.1, 0.4], "isLocked": True}])
    )
    assert improving.verdict(5.0)[0] is True

    # (b) the heading slews while the target is still off-centre
    slewing = e2e_test.YawEvidence(initial_error=0.30, initial_heading=350.0)
    slewing.observe_heading(5.0)  # wraps: 15 deg of slew
    passed, reason = slewing.verdict(5.0)
    assert passed is True
    assert "heading slewed 15.0 deg" in reason

    # neither: the yaw axis is inactive
    inert = e2e_test.YawEvidence(initial_error=0.30, initial_heading=0.0)
    inert.observe_heading(1.0)
    assert inert.verdict(5.0)[0] is False

    # a target that starts centred and stays centred is fine
    centred = e2e_test.YawEvidence(initial_error=0.01, initial_heading=0.0)
    assert centred.verdict(5.0)[0] is True


def test_yaw_evidence_ignores_frames_without_a_locked_bbox():
    evidence = e2e_test.YawEvidence(initial_error=0.30, initial_heading=0.0)
    evidence.observe_tracking(None)
    evidence.observe_tracking(tracking(targets=[], lockedTargetId=None))
    evidence.observe_heading(None)
    assert evidence.best_error == 0.30
    assert evidence.max_slew == 0.0


# ==========================================================================
# e2e gate against the fake companion (client + gate together)
# ==========================================================================
def _e2e_gate(url: str, **over):
    params = e2e_test.AcceptanceParams(ws_url=url, standoff=5.0, converge_s=2.0, **over)
    client = HeadlessClient(url)
    gate = e2e_test.E2EGate(client, params, echo=lambda _m: None)
    return client, gate


def test_approach_phase_fails_on_a_single_breaching_frame():
    async def scenario():
        async with FakeCompanion() as server:
            client, gate = _e2e_gate(server.url)
            async with client:
                await server.wait_for_client()

                async def publish():
                    for distance in (12.0, 9.0, 7.0, 4.0):
                        await server.push(tracking(estimatedDistance=distance))
                        await asyncio.sleep(0.01)

                publisher = asyncio.ensure_future(publish())
                with pytest.raises(AssertionError) as caught:
                    await gate._approach()
                await publisher
                return str(caught.value)

    assert "STANDOFF BREACH during approach: estimatedDistance=4.00 m" in run(scenario())


def test_approach_phase_converges_on_a_clean_run():
    async def scenario():
        async with FakeCompanion() as server:
            client, gate = _e2e_gate(server.url)
            async with client:
                await server.wait_for_client()

                async def publish():
                    for distance in (12.0, 9.0, 7.0, 5.4):
                        await server.push(tracking(estimatedDistance=distance))
                        await asyncio.sleep(0.01)

                publisher = asyncio.ensure_future(publish())
                trace = await gate._approach()
                await publisher
                return trace

    trace = run(scenario())
    assert trace.converged is True
    assert trace.first == 12.0
    assert trace.closest == 5.4
    e2e_test.evaluate_approach(trace, e2e_test.AcceptanceParams(standoff=5.0))


def test_hold_phase_collects_every_frame_and_skips_null_distances():
    async def scenario():
        async with FakeCompanion() as server:
            client, gate = _e2e_gate(server.url)
            async with client:
                await server.wait_for_client()

                async def publish():
                    for distance in (5.1, None, 5.0, 4.9, 5.2):
                        await server.push(tracking(estimatedDistance=distance))
                        await asyncio.sleep(0.01)

                publisher = asyncio.ensure_future(publish())
                samples = await gate._hold_for(0.3)
                await publisher
                return samples

    assert run(scenario()) == [5.1, 5.0, 4.9, 5.2]


def test_engage_phase_rejects_a_mismatched_standoff_echo():
    async def scenario():
        async with FakeCompanion() as server:
            client, gate = _e2e_gate(server.url)
            async with client:
                await server.wait_for_client()

                async def publish():
                    await asyncio.sleep(0.02)
                    await server.push(telemetry(armed=True, controlSource="tracking"))
                    await server.push(tracking(standoffDistance=9.0))

                publisher = asyncio.ensure_future(publish())
                with pytest.raises(AssertionError) as caught:
                    await gate.engage()
                await publisher
                return str(caught.value)

    assert "tracking.standoffDistance=9.0 != requested 5.0" in run(scenario())


# ==========================================================================
# manual evaluators
# ==========================================================================
def test_axis_envelope_differentiates_yaw_rate_from_the_wire_clock():
    envelope = manual_test.AxisEnvelope()
    for index, heading in enumerate((10.0, 20.0, 35.0)):
        envelope.observe(
            telemetry(
                ts=1_700_000_000_000 + index * 100,  # 100 ms apart
                heading=heading,
                velocity={"groundspeed": 1.0 + index, "verticalSpeed": -0.5},
            )
        )
    assert envelope.frames == 3
    assert envelope.peak_groundspeed == 3.0
    assert envelope.peak_climb == 0.5
    # 15 deg in 100 ms == 150 deg/s
    assert envelope.peak_yaw_rate == pytest.approx(150.0)
    assert envelope.heading_travel == pytest.approx(25.0)


def test_axis_envelope_ignores_implausible_timestamp_gaps():
    envelope = manual_test.AxisEnvelope()
    envelope.observe(telemetry(ts=1_000, heading=0.0))
    envelope.observe(telemetry(ts=1_000, heading=90.0))       # dt == 0
    envelope.observe(telemetry(ts=1_000_000, heading=180.0))  # dt way too large
    assert envelope.peak_yaw_rate == 0.0


def test_stick_response_names_the_inactive_axis():
    still = manual_test.StickOutcome(
        envelope=manual_test.AxisEnvelope(),
        heading_start=0.0,
        heading_end=0.0,
        alt_start=10.0,
        alt_end=10.0,
        moved_deg=0.0,
        frames_sent=250,
    )
    with pytest.raises(AssertionError) as horizontal:
        manual_test.evaluate_stick_response(still)
    assert "pitch/roll axes appear inactive" in str(horizontal.value)

    moved = manual_test.AxisEnvelope(peak_groundspeed=1.5)
    with pytest.raises(AssertionError) as yaw:
        manual_test.evaluate_stick_response(
            manual_test.StickOutcome(
                envelope=moved,
                heading_start=0.0,
                heading_end=0.0,
                alt_start=10.0,
                alt_end=10.0,
                moved_deg=1e-4,
                frames_sent=250,
            )
        )
    assert "did not change heading" in str(yaw.value)

    turned = manual_test.AxisEnvelope(peak_groundspeed=1.5, peak_yaw_rate=30.0)
    with pytest.raises(AssertionError) as climb:
        manual_test.evaluate_stick_response(
            manual_test.StickOutcome(
                envelope=turned,
                heading_start=0.0,
                heading_end=40.0,
                alt_start=10.0,
                alt_end=10.0,
                moved_deg=1e-4,
                frames_sent=250,
            )
        )
    assert "did not change altitude" in str(climb.value)

    healthy = manual_test.AxisEnvelope(
        peak_groundspeed=1.5, peak_yaw_rate=30.0, peak_climb=1.0
    )
    manual_test.evaluate_stick_response(
        manual_test.StickOutcome(
            envelope=healthy,
            heading_start=0.0,
            heading_end=40.0,
            alt_start=10.0,
            alt_end=12.0,
            moved_deg=1e-4,
            frames_sent=250,
        )
    )


def test_stick_clamps_reject_any_unclamped_axis():
    params = manual_test.ManualParams(max_speed=2.0, max_climb=1.5, max_yaw=45.0)
    manual_test.evaluate_stick_clamps(
        manual_test.AxisEnvelope(peak_groundspeed=2.5, peak_climb=2.0, peak_yaw_rate=64.0),
        params,
    )
    with pytest.raises(AssertionError) as speed:
        manual_test.evaluate_stick_clamps(
            manual_test.AxisEnvelope(peak_groundspeed=6.0), params
        )
    assert "axis not clamped to limits" in str(speed.value)

    with pytest.raises(AssertionError) as climb:
        manual_test.evaluate_stick_clamps(manual_test.AxisEnvelope(peak_climb=4.0), params)
    assert "throttle axis not clamped" in str(climb.value)

    with pytest.raises(AssertionError) as yaw:
        manual_test.evaluate_stick_clamps(
            manual_test.AxisEnvelope(peak_yaw_rate=200.0), params
        )
    assert "yaw axis not clamped" in str(yaw.value)


def test_watchdog_requires_a_stop_and_a_hold():
    manual_test.evaluate_watchdog(0.2, 1e-6, 2.0)
    with pytest.raises(AssertionError) as coasting:
        manual_test.evaluate_watchdog(1.9, 1e-6, 2.0)
    assert "WATCHDOG FAILURE" in str(coasting.value)
    with pytest.raises(AssertionError) as drifting:
        manual_test.evaluate_watchdog(0.2, 1e-3, 2.0)
    assert "not holding position" in str(drifting.value)


def test_auto_hold_and_emergency_stop_verdicts():
    params = manual_test.ManualParams(max_speed=2.0)
    manual_test.evaluate_auto_hold(1.0, params)
    with pytest.raises(AssertionError) as moving:
        manual_test.evaluate_auto_hold(9.0, params)
    assert "auto-hold did not zero the setpoint" in str(moving.value)

    manual_test.evaluate_emergency_stop("auto", "LAND", True)
    manual_test.evaluate_emergency_stop("auto", "GUIDED", False)
    with pytest.raises(AssertionError) as still_manual:
        manual_test.evaluate_emergency_stop("manual", "LAND", True)
    assert "did NOT override manual" in str(still_manual.value)
    with pytest.raises(AssertionError) as unsafe:
        manual_test.evaluate_emergency_stop("auto", "GUIDED", True)
    assert "safe stop state" in str(unsafe.value)


def test_manual_watchdog_settle_windows_track_the_configured_period():
    fast = manual_test.ManualParams(watchdog_ms=500)
    slow = manual_test.ManualParams(watchdog_ms=1500)
    assert fast.watchdog_settle_s == 2.0      # floor
    assert slow.watchdog_settle_s == 6.0      # 4 periods
    assert fast.release_settle_s == 1.5       # floor
    assert slow.release_settle_s == 3.0


def test_reject_phase_fails_when_manual_is_accepted_on_the_ground():
    async def scenario():
        async with FakeCompanion() as server:  # acks everything with success
            params = manual_test.ManualParams(ws_url=server.url)
            client = HeadlessClient(server.url)
            gate = manual_test.ManualGate(client, params, echo=lambda _m: None)
            async with client:
                await server.wait_for_client()
                with pytest.raises(AssertionError) as caught:
                    await gate.reject_before_airborne()
                return str(caught.value)

    assert "violates the manual-control safety precondition" in run(scenario())


def test_reject_phase_passes_when_manual_is_refused():
    async def scenario():
        async with FakeCompanion(ack_policy=lambda _c: (False, "not armed")) as server:
            params = manual_test.ManualParams(ws_url=server.url)
            client = HeadlessClient(server.url)
            gate = manual_test.ManualGate(client, params, echo=lambda _m: None)
            async with client:
                await server.wait_for_client()
                return await gate.reject_before_airborne()

    assert run(scenario()) == "arm"


# ==========================================================================
# CLI surface: what scripts/run-sim-e2e.{sh,ps1} invoke
# ==========================================================================
def test_e2e_cli_accepts_the_ws_url_flag_the_scripts_pass():
    params = e2e_test.AcceptanceParams.from_args(["--ws-url", "ws://10.0.0.5:8765"])
    assert params.ws_url == "ws://10.0.0.5:8765"
    assert params.standoff == e2e_test.STANDOFF
    assert params.max_speed == e2e_test.MAX_SPEED


def test_manual_cli_accepts_the_ws_url_flag_the_scripts_pass():
    params = manual_test.ManualParams.from_args(["--ws-url", "ws://10.0.0.5:8765"])
    assert params.ws_url == "ws://10.0.0.5:8765"
    assert params.max_speed == manual_test.MAX_SPEED
    assert params.watchdog_ms == manual_test.WATCHDOG_MS


def test_cli_overrides_every_env_knob():
    e2e_params = e2e_test.AcceptanceParams.from_args(
        [
            "--ws-url", "ws://host:1",
            "--standoff", "7.5",
            "--max-speed", "1.25",
            "--takeoff-alt", "20",
            "--converge-s", "45",
            "--vehicle-id", "eis-4",
        ]
    )
    assert (e2e_params.standoff, e2e_params.max_speed) == (7.5, 1.25)
    assert (e2e_params.takeoff_alt, e2e_params.converge_s) == (20.0, 45.0)
    assert e2e_params.vehicle_id == "eis-4"

    manual_params = manual_test.ManualParams.from_args(
        [
            "--ws-url", "ws://host:1",
            "--takeoff-alt", "12",
            "--max-speed", "3",
            "--max-climb", "2",
            "--max-yaw", "60",
            "--watchdog-ms", "750",
        ]
    )
    assert manual_params.max_climb == 2.0
    assert manual_params.max_yaw == 60.0
    assert manual_params.watchdog_ms == 750


def test_env_knobs_are_the_cli_defaults(monkeypatch):
    monkeypatch.setenv("EIS_STANDOFF", "8")
    monkeypatch.setenv("EIS_WS_URL", "ws://from-env:9")
    from headless_client import default_ws_url, env_float

    assert env_float("EIS_STANDOFF", 5.0) == 8.0
    assert default_ws_url() == "ws://from-env:9"
    monkeypatch.setenv("EIS_STANDOFF", "not-a-number")
    assert env_float("EIS_STANDOFF", 5.0) == 5.0


def test_unreachable_companion_exits_with_the_link_code(monkeypatch):
    """main() maps an unreachable companion onto exit 2, not a traceback."""
    original = HeadlessClient.connect

    async def connect_once(self, *, retries=1, retry_delay=0.0):
        return await original(self, retries=1, retry_delay=0.0)

    monkeypatch.setattr(HeadlessClient, "connect", connect_once)
    assert e2e_test.main(["--ws-url", "ws://127.0.0.1:9"]) == EXIT_LINK
    assert manual_test.main(["--ws-url", "ws://127.0.0.1:9"]) == EXIT_LINK


def test_gate_builders_wire_the_client_to_the_parsed_url():
    client, machine = e2e_test.build_gate(
        e2e_test.AcceptanceParams(ws_url="ws://host:1", vehicle_id="eis-2")
    )
    assert client.url == "ws://host:1"
    assert client.vehicle_id == "eis-2"
    assert machine.start == "connect"
    assert list(machine.phases) == [
        "connect", "arm", "takeoff", "configure", "engage",
        "yaw", "standoff", "speed", "disengage", "recover",
    ]

    manual_client, manual_machine = manual_test.build_gate(
        manual_test.ManualParams(ws_url="ws://host:2")
    )
    assert manual_client.url == "ws://host:2"
    assert list(manual_machine.phases) == [
        "connect", "reject", "arm", "takeoff", "track",
        "manual", "sticks", "watchdog", "release", "estop",
    ]


def test_the_gates_never_import_companion_internals():
    """The acceptance clients must verify the seam, not reach behind it."""
    for module in (e2e_test, manual_test, HeadlessClient.__module__):
        path = Path(
            sys.modules[module].__file__ if isinstance(module, str) else module.__file__
        )
        source = path.read_text(encoding="utf-8")
        for line in source.splitlines():
            statement = line.strip()
            assert not statement.startswith(("import eis_companion", "from eis_companion")), (
                f"{path.name} imports companion internals: {statement}"
            )
        assert os.path.dirname(os.path.abspath(str(path))) == str(SIM_DIR)
