"""Ack semantics on the control WebSocket (shared/shared.py, PRD 5.1).

The contract makes an asymmetric promise that is easy to break by accident:

  * every ``command`` is acked -- success or failure, handler present or not,
    handler well-behaved or raising. An operator waiting on an ack must never
    wait forever.
  * ``manualInput`` is acked NEVER. It is the high-rate rail (~20-50 Hz), and
    a per-frame ack is backpressure by another name.
  * the planner rails carry their own ack shape -- requestId / status / reason
    -- and ``planHeartbeat``, ``rfEvent`` and ``fleet`` carry none at all.

These tests drive ``ApiServer._on_message`` directly with a fake socket, so
they exercise the real admission pipeline and the real routing table without a
network.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from eis_companion.api.server import _ROUTES, ApiServer

VEHICLE = "eis-1"


def run(coro):
    return asyncio.run(coro)


class FakeSocket:
    """Records what the server sent to this one client."""

    def __init__(self) -> None:
        self.sent: list = []
        self.closed = False

    async def send(self, data):
        self.sent.append(data)

    async def close(self):
        self.closed = True

    def frames(self) -> list:
        return [json.loads(item) for item in self.sent]

    def of_type(self, wire_type: str) -> list:
        return [f for f in self.frames() if f.get("type") == wire_type]


def server(**kwargs) -> ApiServer:
    return ApiServer(host="127.0.0.1", port=0, vehicle_id=VEHICLE, **kwargs)


def connected(srv: ApiServer) -> FakeSocket:
    """A client that receives broadcasts as well as direct sends."""
    client = FakeSocket()
    srv._clients.add(client)
    return client


def deliver(srv: ApiServer, client: FakeSocket, message: dict) -> None:
    message.setdefault("vehicleId", VEHICLE)
    run(srv._on_message(client, json.dumps(message)))


def command(name: str, **params) -> dict:
    frame = {"type": "command", "vehicleId": VEHICLE, "command": name}
    if params:
        frame["params"] = params
    return frame


# ==========================================================================
# Every command is acked, whatever the handler does
# ==========================================================================
def test_a_successful_command_is_acked_with_the_handlers_own_ack():
    def handler(msg):
        return {
            "type": "ack", "vehicleId": VEHICLE,
            "command": msg["command"], "success": True, "message": "armed",
        }

    srv = server(command_handler=handler)
    client = connected(srv)
    deliver(srv, client, command("arm"))

    acks = client.of_type("ack")
    assert len(acks) == 1
    assert acks[0]["command"] == "arm"
    assert acks[0]["success"] is True
    assert acks[0]["message"] == "armed"


def test_a_failing_command_is_acked_as_a_failure_not_dropped():
    srv = server(command_handler=lambda msg: {
        "type": "ack", "vehicleId": VEHICLE, "command": msg["command"],
        "success": False, "message": "arm refused: no GPS",
    })
    client = connected(srv)
    deliver(srv, client, command("arm"))

    ack = client.of_type("ack")[-1]
    assert ack["success"] is False
    assert "no GPS" in ack["message"]


def test_a_raising_handler_still_produces_an_ack():
    """A handler that explodes must not leave the operator waiting."""
    def boom(msg):
        raise RuntimeError("dispatch exploded")

    srv = server(command_handler=boom)
    client = connected(srv)
    deliver(srv, client, command("takeoff", altitude=5.0))

    ack = client.of_type("ack")[-1]
    assert ack["command"] == "takeoff"
    assert ack["success"] is False
    assert "dispatch exploded" in ack["message"]


def test_a_handler_that_returns_nothing_still_produces_an_ack():
    srv = server(command_handler=lambda msg: None)
    client = connected(srv)
    deliver(srv, client, command("land"))

    ack = client.of_type("ack")[-1]
    assert ack["command"] == "land"
    assert ack["success"] is False
    assert "no ack" in ack["message"]


def test_no_registered_handler_is_a_refusal_not_silence():
    srv = server()
    client = connected(srv)
    deliver(srv, client, command("rtl"))

    ack = client.of_type("ack")[-1]
    assert ack["command"] == "rtl"
    assert ack["success"] is False
    assert "no command handler" in ack["message"]


def test_an_async_command_handler_is_awaited():
    async def handler(msg):
        await asyncio.sleep(0)
        return {
            "type": "ack", "vehicleId": VEHICLE, "command": msg["command"],
            "success": True, "message": "ok",
        }

    srv = server(command_handler=handler)
    client = connected(srv)
    deliver(srv, client, command("disarm"))
    assert client.of_type("ack")[-1]["success"] is True


def test_every_ack_carries_the_contract_envelope():
    """type / ts / vehicleId / command / success / message -- all of them."""
    srv = server(command_handler=lambda msg: {
        "type": "ack", "command": msg["command"],
        "success": True, "message": "ok",
    })
    client = connected(srv)
    deliver(srv, client, command("engageTracking"))

    ack = client.of_type("ack")[-1]
    for field in ("type", "ts", "vehicleId", "command", "success", "message"):
        assert field in ack, f"CommandAck must carry {field}"
    assert ack["vehicleId"] == VEHICLE
    assert isinstance(ack["ts"], int) and ack["ts"] > 0


def test_acks_correlate_by_command_name_and_carry_no_request_id():
    """The contract is explicit: acks are FIFO by command NAME. A requestId on
    the ack path would invite the ground to correlate on a field the companion
    never promised."""
    srv = server(command_handler=lambda msg: {
        "type": "ack", "vehicleId": VEHICLE, "command": msg["command"],
        "success": True, "message": "ok",
    })
    client = connected(srv)
    deliver(srv, client, command("engageManual"))
    deliver(srv, client, command("disengageManual"))

    acks = client.of_type("ack")
    assert [a["command"] for a in acks] == ["engageManual", "disengageManual"]
    assert all("requestId" not in a for a in acks)


# ==========================================================================
# manualInput: the fire-and-forget rail
# ==========================================================================
def test_manual_input_reaches_its_handler_but_is_never_acked():
    seen: list = []
    srv = server(manual_handler=seen.append)
    client = connected(srv)
    deliver(srv, client, {
        "type": "manualInput", "throttle": 0.2, "yaw": -0.1,
        "pitch": 0.5, "roll": 0.0,
    })

    assert len(seen) == 1 and seen[0]["pitch"] == 0.5
    assert client.of_type("ack") == [], "manualInput must never be acked"
    assert client.sent == [], "manualInput must produce NO frame at all"


def test_a_burst_of_manual_input_produces_no_outbound_traffic():
    """The whole point of the rail: 50 stick frames cost zero acks."""
    seen: list = []
    srv = server(manual_handler=seen.append)
    client = connected(srv)
    for step in range(50):
        deliver(srv, client, {
            "type": "manualInput", "throttle": step / 50.0,
            "yaw": 0.0, "pitch": 0.0, "roll": 0.0,
        })

    assert len(seen) == 50
    assert client.sent == []


def test_a_raising_manual_handler_is_swallowed_and_still_not_acked():
    def boom(msg):
        raise ValueError("bad stick frame")

    srv = server(manual_handler=boom)
    client = connected(srv)
    deliver(srv, client, {"type": "manualInput", "pitch": 0.1})
    assert client.sent == []


def test_manual_input_with_no_handler_is_silent():
    srv = server()
    client = connected(srv)
    deliver(srv, client, {"type": "manualInput", "pitch": 0.1})
    assert client.sent == []


def test_manual_input_still_feeds_the_ground_link_deadman():
    """Not acking it is not the same as ignoring it: sticks are liveness."""
    beats: list = []
    srv = server(manual_handler=lambda msg: None, heartbeat_hook=beats.append)
    client = connected(srv)
    deliver(srv, client, {"type": "manualInput", "pitch": 0.1})
    assert len(beats) == 1
    assert srv.last_inbound_ms > 0.0


@pytest.mark.parametrize("wire_type", ["manualInput", "planHeartbeat", "fleet", "rfEvent"])
def test_the_ackless_rails_are_declared_ackless_in_the_routing_table(wire_type):
    """Structural, not just behavioural: the no-ack rule is a property of the
    route table, so it cannot be undone by adding a branch."""
    assert _ROUTES[wire_type].ack_type == ""
    assert _ROUTES[wire_type].broadcast_ack is False


# ==========================================================================
# The planner rails carry a DIFFERENT ack shape
# ==========================================================================
def test_plan_command_is_acked_with_request_id_status_and_reason():
    srv = server(plan_command_handler=lambda msg: {
        "type": "planCommandAck", "vehicleId": VEHICLE,
        "requestId": msg["requestId"], "status": "accepted", "reason": "",
    })
    client = connected(srv)
    deliver(srv, client, {
        "type": "planCommand", "requestId": "req-7",
        "tool": "hold", "args": {}, "profile": "standard",
    })

    ack = client.of_type("planCommandAck")[-1]
    assert ack["requestId"] == "req-7"
    assert ack["status"] == "accepted"


def test_a_plan_command_with_no_handler_is_rejected_with_a_reason():
    srv = server()
    client = connected(srv)
    deliver(srv, client, {"type": "planCommand", "requestId": "req-8"})

    ack = client.of_type("planCommandAck")[-1]
    assert ack["requestId"] == "req-8"
    assert ack["status"] == "rejected"
    assert "no handler" in ack["reason"]


def test_a_raising_plan_command_handler_is_rejected_not_silent():
    def boom(msg):
        raise RuntimeError("validator exploded")

    srv = server(plan_command_handler=boom)
    client = connected(srv)
    deliver(srv, client, {"type": "planCommand", "requestId": "req-9"})

    ack = client.of_type("planCommandAck")[-1]
    assert ack["status"] == "rejected"
    assert "validator exploded" in ack["reason"]


def test_plan_heartbeat_and_fleet_reach_their_handlers_unacked():
    beats: list = []
    peers: list = []
    srv = server(plan_heartbeat_handler=beats.append, fleet_handler=peers.append)
    client = connected(srv)
    deliver(srv, client, {"type": "planHeartbeat"})
    deliver(srv, client, {"type": "fleet", "vehicles": []})

    assert len(beats) == 1 and len(peers) == 1
    assert client.sent == []


# ==========================================================================
# Frames that never reach a handler at all
# ==========================================================================
def test_a_frame_for_another_vehicle_is_refused_and_never_dispatched():
    seen: list = []
    srv = server(command_handler=lambda msg: seen.append(msg) or {
        "type": "ack", "command": "arm", "success": True, "message": "",
    })
    client = connected(srv)
    run(srv._on_message(client, json.dumps({
        "type": "command", "vehicleId": "eis-2", "command": "arm",
    })))

    assert seen == []
    assert client.of_type("ack") == []
    assert "vehicleId" in client.of_type("statusText")[-1]["text"]


def test_an_unknown_wire_type_is_liveness_only():
    """A ping counts for the deadman and is otherwise ignored -- no ack, no
    statusText, no complaint."""
    beats: list = []
    srv = server(heartbeat_hook=beats.append)
    client = connected(srv)
    deliver(srv, client, {"type": "ping"})

    assert len(beats) == 1
    assert client.sent == []
