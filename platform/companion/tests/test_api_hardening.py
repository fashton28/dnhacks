"""Control-WebSocket hardening (FM-36, FM-40, FM-112).

FM-36  `json.dumps` emits bare NaN/Infinity, which `JSON.parse` rejects -- the
       ground silently loses the whole frame, with no companion-side error.
FM-40  every inbound frame must pass the signing layer BEFORE it counts as
       ground liveness, or a peer on the LAN can hold the deadman open.
FM-112 `max_queue` bounds the INCOMING queue; the documented outbound
       backpressure protection did not exist in either direction.
"""
from __future__ import annotations

import asyncio
import json

from eis_companion.api.server import (
    DEFAULT_MAX_FRAME_BYTES,
    ApiServer,
    _dumps,
    _finite_json,
)


def run(coro):
    return asyncio.run(coro)


class FakeSocket:
    """A client that accepts, refuses, or never finishes a send."""

    def __init__(self, *, mode="ok") -> None:
        self.mode = mode
        self.sent: list = []
        self.closed = False

    async def send(self, data):
        if self.mode == "raise":
            raise ConnectionError("client is gone")
        if self.mode == "stall":
            await asyncio.sleep(3600)
        self.sent.append(data)

    async def close(self):
        self.closed = True


def server(**kwargs) -> ApiServer:
    return ApiServer(host="127.0.0.1", port=0, **kwargs)


# ==========================================================================
# FM-36: outbound JSON is always parseable
# ==========================================================================
def test_non_finite_values_are_serialised_as_null_not_as_bare_nan():
    payload = {
        "type": "telemetry",
        "standoffDistance": float("inf"),
        "estimatedDistance": float("nan"),
        "nested": {"values": [1.0, float("-inf")]},
    }
    data = _dumps(payload)
    assert "NaN" not in data and "Infinity" not in data
    decoded = json.loads(data)      # strict: would raise on bare NaN/Infinity
    assert decoded["standoffDistance"] is None
    assert decoded["estimatedDistance"] is None
    assert decoded["nested"]["values"] == [1.0, None]


def test_finite_values_survive_untouched():
    payload = {"a": 1.5, "b": [2, 3], "c": {"d": "text"}}
    assert _finite_json(payload) == payload
    assert json.loads(_dumps(payload)) == payload


def test_a_broadcast_with_a_non_finite_field_still_reaches_the_client():
    srv = server()
    client = FakeSocket()
    srv._clients.add(client)
    run(srv.broadcast({"type": "capabilities", "max_standoff_m": float("inf")}))
    assert client.sent, "the frame must be sent, not silently dropped"
    assert json.loads(client.sent[0])["max_standoff_m"] is None


# ==========================================================================
# FM-112: outbound backpressure and frame bounds
# ==========================================================================
def test_a_stalled_client_is_dropped_instead_of_backpressuring_telemetry():
    srv = server(send_timeout_s=0.05)
    good, stalled = FakeSocket(), FakeSocket(mode="stall")
    srv._clients.update({good, stalled})
    run(srv.broadcast({"type": "telemetry", "ts": 1}))
    assert good.sent, "a healthy client must still receive the frame"
    assert stalled not in srv._clients
    assert srv.dropped_clients == 1
    assert srv.dropped_frames == 1


def test_a_dead_client_is_dropped_without_taking_the_server_down():
    srv = server()
    dead = FakeSocket(mode="raise")
    srv._clients.add(dead)
    run(srv.broadcast({"type": "telemetry", "ts": 1}))
    assert dead not in srv._clients
    assert srv.dropped_clients == 1


def test_the_inbound_frame_size_is_bounded_explicitly():
    srv = server()
    assert srv._max_frame_bytes == DEFAULT_MAX_FRAME_BYTES
    assert srv._max_frame_bytes < 1_048_576, "tighter than the 1 MiB default"


# ==========================================================================
# FM-40: authorization runs before liveness
# ==========================================================================
def test_an_unauthorized_frame_never_feeds_the_ground_link_deadman():
    beats: list = []
    srv = server(
        vehicle_id="eis-1",
        heartbeat_hook=beats.append,
        authorize_hook=lambda msg: "refused: unsigned",
    )
    client = FakeSocket()
    run(srv._on_message(client, json.dumps({"type": "command", "vehicleId": "eis-1"})))
    assert beats == [], "an unauthorized frame must not count as ground liveness"
    assert srv.last_inbound_ms == 0.0
    assert client.sent and "refused" in client.sent[0]


def test_an_authorized_frame_does_feed_the_deadman():
    beats: list = []
    srv = server(vehicle_id="eis-1", heartbeat_hook=beats.append,
                 authorize_hook=lambda msg: "")
    client = FakeSocket()
    run(srv._on_message(client, json.dumps({"type": "ping", "vehicleId": "eis-1"})))
    assert len(beats) == 1
    assert srv.last_inbound_ms > 0.0


def test_an_authorizer_that_raises_is_a_refusal_not_a_pass():
    def boom(msg):
        raise RuntimeError("verifier exploded")

    beats: list = []
    srv = server(vehicle_id="eis-1", heartbeat_hook=beats.append, authorize_hook=boom)
    client = FakeSocket()
    run(srv._on_message(client, json.dumps({"type": "command", "vehicleId": "eis-1"})))
    assert beats == []


def test_a_frame_carrying_a_bare_nan_literal_is_refused_at_the_door():
    handled: list = []
    srv = server(vehicle_id="eis-1", manual_handler=handled.append)
    client = FakeSocket()
    run(srv._on_message(
        client, '{"type":"manualInput","vehicleId":"eis-1","pitch":NaN}'
    ))
    assert handled == [], "a non-finite JSON literal must never reach a handler"
    assert client.sent and "malformed" in client.sent[0]


def test_a_normal_manual_frame_still_reaches_its_handler():
    """Control: the parser guard must not reject valid traffic."""
    handled: list = []
    srv = server(vehicle_id="eis-1", manual_handler=handled.append)
    client = FakeSocket()
    run(srv._on_message(
        client,
        json.dumps({"type": "manualInput", "vehicleId": "eis-1", "pitch": 0.5}),
    ))
    assert len(handled) == 1
    assert handled[0]["pitch"] == 0.5


def test_the_server_reports_whether_it_is_loopback_only():
    assert server().loopback_only is True
    assert ApiServer(host="0.0.0.0", port=0).loopback_only is False
