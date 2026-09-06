"""
============================================================================
Drone Safety Platform -- COMPANION control WebSocket server (the shared contract)
----------------------------------------------------------------------------
An asyncio ``websockets`` server on the control port (default 8765) speaking
the JSON contract declared in ``shared/shared.py`` and mirrored by
``ground/ui/src/contract``.

    companion -> ground   telemetry | tracking | statusText | ack   (push)
    ground -> companion   command   (acked)  |  manualInput (never acked)

The module is organised around three explicit pieces rather than one long
handler:

``_ADMISSION``
    An ordered tuple of admission gates. Every inbound frame walks the same
    list -- decode, shape, addressing, authorization -- and the FIRST gate to
    return a verdict ends the frame. Liveness is credited only once the whole
    list has passed, which is what keeps an unsigned frame from holding the
    ground-link deadman open (FM-40).

``_ROUTES``
    A table keyed by the wire ``type`` discriminant. Each entry names the
    handler slot to call and whether that type has an ack channel at all.
    ``manualInput`` and ``fleet`` are declared ackless in the table itself, so
    the fire-and-forget rule (PRD 5.1: a per-stick-frame ack is backpressure)
    is a property of the routing data, not of a branch someone could add an
    ack to by accident.

``_Fanout``
    Outbound delivery. One serialisation, then a bounded concurrent send per
    client. A reader that will not drain is evicted rather than queued, so a
    stalled renderer cannot slow the telemetry pump for everybody else.

Only stdlib + ``websockets``. The orchestrator supplies the handlers and calls
the ``push_*`` helpers; nothing here knows about MAVLink or vision.
============================================================================
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Iterable, Optional, Set, Union

import websockets
from websockets.server import WebSocketServerProtocol

log = logging.getLogger("eis.api")

# A command handler takes the inbound command dict and returns a CommandAck dict
# (the ``type:'ack'`` shape). It may be sync or async.
CommandHandler = Callable[[Dict[str, Any]], Union[Dict[str, Any], Awaitable[Dict[str, Any]]]]
# A manual handler takes the inbound manualInput dict and returns nothing.
ManualHandler = Callable[[Dict[str, Any]], Union[None, Awaitable[None]]]
# Heartbeat callback: called (with the inbound ms timestamp) on every frame.
HeartbeatHook = Callable[[float], None]
MessageHandler = Callable[[Dict[str, Any]], Union[None, Dict[str, Any], Awaitable[Any]]]
ConnectMessages = Callable[[], Union[list[Dict[str, Any]], Awaitable[list[Dict[str, Any]]]]]
# Operator presence: called with the resulting client count when a ground
# session appears or disappears. This is the liveness signal behind attendance
# mode -- an operator connecting reverts unattended mode to attended.
PresenceHook = Callable[[int], Union[None, Awaitable[None]]]

#: Message types persisted to the hash-chained audit log. These are the
#: durable record of what the vehicle decided and why: health transitions,
#: attendance-mode changes, and escalations.
_AUDITED_TYPES = frozenset({"healthEvent", "mode", "escalation"})

#: Authorization hook: called for EVERY inbound frame BEFORE it counts as
#: ground liveness and before it reaches any handler. Returns "" to accept, or
#: a refusal reason. This is the seam the signed-command layer plugs into, so
#: no wire message can reach the orchestrator unauthorized (FM-40).
AuthorizeHook = Callable[[Dict[str, Any]], Union[str, Awaitable[str]]]

#: Loopback addresses. Binding anywhere else exposes the control socket to the
#: venue LAN, which is what makes signing mandatory rather than optional.
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "::1", "localhost"})

#: Largest inbound frame we will parse. The websockets default is 1 MiB; a
#: mission plan is a few KiB. Bounding it explicitly means one client cannot
#: make the companion buffer a megabyte per frame (FM-112).
DEFAULT_MAX_FRAME_BYTES = 262_144

#: How long one client may take to accept a broadcast before it is dropped as
#: a stalled reader. The websockets ``max_queue`` bounds the INCOMING queue --
#: the opposite direction from the backpressure the docs claimed (FM-112).
DEFAULT_SEND_TIMEOUT_S = 2.0

#: How many replayed audit entries a freshly connected client is handed, and
#: how deep the in-memory audit ring runs behind them.
_REPLAY_TAIL = 100
_AUDIT_RING = 1000

#: Chain bookkeeping that lives in the journal file but is not a wire field.
_CHAIN_KEYS = ("prev", "hash")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _reject_constant(token: str):
    """``json.loads`` hook: refuse the bare NaN/Infinity literals.

    Python's JSON parser accepts ``NaN``, ``Infinity`` and ``-Infinity`` by
    default. Those tokens are not legal JSON, and a non-finite stick axis or
    setpoint is a full-scale command once it meets a naive clamp (FM-05). The
    frame is rejected at the door rather than sanitised in ten places.
    """
    raise ValueError(f"non-finite JSON literal {token!r} is not accepted")


def _finite_json(value: Any) -> Any:
    """Recursively replace non-finite floats with ``None`` for the wire.

    ``json.dumps`` emits bare ``NaN``/``Infinity`` by default, which
    ``JSON.parse`` in the renderer rejects -- the ground silently loses the
    whole frame (FM-36). ``None`` is a value the contract's optional fields
    already tolerate, and a missing number is honest about a value we do not
    have.
    """
    if isinstance(value, dict):
        return {key: _finite_json(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite_json(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def _dumps(message: Dict[str, Any]) -> str:
    """Serialise one outbound frame, guaranteeing parseable JSON.

    The fast path is a strict dump: ``allow_nan=False`` makes the encoder
    raise rather than emit a token ``JSON.parse`` will refuse. Only when that
    raises do we pay for the recursive sanitising walk, so the ordinary
    telemetry frame is encoded exactly once.
    """
    try:
        return json.dumps(message, separators=(",", ":"), allow_nan=False)
    except (ValueError, TypeError):
        return json.dumps(
            _finite_json(message), separators=(",", ":"), allow_nan=False,
            default=str,
        )


async def _resolve(value: Any) -> Any:
    """Await a hook's result when it produced one; otherwise pass it through."""
    if asyncio.iscoroutine(value):
        return await value
    return value


# ==========================================================================
# Inbound admission: one ordered list of gates, shared by every frame type
# ==========================================================================
@dataclass(frozen=True)
class _Verdict:
    """The outcome of one admission gate.

    ``payload`` carries the decoded frame forward once decoding succeeds;
    ``refusal`` ends the frame with a ``statusText`` back to that one client.
    A gate that is happy returns neither.
    """
    refusal: str = ""
    payload: Optional[Dict[str, Any]] = None

    @property
    def refused(self) -> bool:
        return bool(self.refusal)


_PASS = _Verdict()


# ==========================================================================
# Outbound routing table
# ==========================================================================
@dataclass(frozen=True)
class _Route:
    """How one inbound wire ``type`` is delivered to the orchestrator.

    ``slot``     -- the ApiServer attribute holding the handler.
    ``ack_type`` -- the wire type of the ack channel, or "" for a type that
                    has NO ack at all. ``manualInput`` (high-rate sticks) and
                    ``fleet`` (hub-relayed peer view, ADR D26) are ackless by
                    declaration: acking either would build backpressure on a
                    path whose whole value is that it never blocks.
    ``broadcast_ack`` -- True when the handler's returned dict is the ack and
                    must be fanned out to every client (the ``command`` and
                    ``planCommand`` paths).
    """
    slot: str
    ack_type: str = ""
    broadcast_ack: bool = False


_ROUTES: Dict[str, _Route] = {
    "command": _Route("_command_handler", ack_type="ack", broadcast_ack=True),
    "manualInput": _Route("_manual_handler"),
    "planCommand": _Route(
        "_plan_command_handler", ack_type="planCommandAck", broadcast_ack=True,
    ),
    "planHeartbeat": _Route("_plan_heartbeat_handler"),
    "rfEvent": _Route("_rf_event_handler"),
    "fleet": _Route("_fleet_handler"),
}


# ==========================================================================
# Outbound delivery
# ==========================================================================
class _Fanout:
    """Bounded, concurrent delivery of one serialised frame to many clients.

    Serial delivery meant the first stalled reader cost every later client the
    full send timeout. Here each socket gets its own bounded send and the
    results are collected together, so one dead renderer costs the pump the
    timeout ONCE rather than once per client.
    """

    __slots__ = ("timeout_s", "stalled", "broken")

    def __init__(self, timeout_s: float) -> None:
        self.timeout_s = timeout_s
        self.stalled: int = 0
        self.broken: Set[Any] = set()

    async def deliver(self, sockets: Iterable[Any], data: str) -> Set[Any]:
        """Send ``data`` to each socket; return the set that must be evicted."""
        targets = list(sockets)
        if not targets:
            return set()
        outcomes = await asyncio.gather(
            *(self._send_one(ws, data) for ws in targets),
            return_exceptions=False,
        )
        for ws, stalled in zip(targets, outcomes):
            if stalled is None:
                continue
            if stalled:
                self.stalled += 1
                log.warning(
                    "dropping stalled ground client: send blocked > %.1fs",
                    self.timeout_s,
                )
            self.broken.add(ws)
        return self.broken

    async def _send_one(self, ws: Any, data: str) -> Optional[bool]:
        """None = delivered. True = timed out. False = the socket errored."""
        try:
            await asyncio.wait_for(ws.send(data), timeout=self.timeout_s)
        except asyncio.TimeoutError:
            return True
        except Exception:
            return False
        return None


# ==========================================================================
# Audit journal
# ==========================================================================
class _AuditJournal:
    """The in-memory replay ring in front of the hash-chained audit file.

    Two jobs, kept apart: what a reconnecting UI is shown (``replay_tail``, a
    healthEvent-only view) and what is durably chained (every audited type).
    The chain is what makes suppression DETECTABLE -- an entry removed or
    edited after the fact breaks the link to its successor
    (docs/THREAT_MODEL.md A7).
    """

    __slots__ = ("path", "events", "chain")

    def __init__(self, path: Optional[Path]) -> None:
        self.path = path
        self.events: list[Dict[str, Any]] = []
        self.chain = _build_chain(path)
        self._replay_from_disk()

    # -- reading ---------------------------------------------------------
    def _replay_from_disk(self) -> None:
        """Load the recent healthEvent tail so a reconnecting UI sees history.

        Only ``healthEvent`` entries are replayed to clients (that is what the
        UI's event log consumes); the chain itself covers every audited type.
        Stored records carry ``prev``/``hash``, which are chain metadata and
        not wire fields, so they are stripped before anything is sent.
        """
        path = self.path
        if path is None or not path.exists():
            return
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except Exception:
            log.exception("could not load local health-event audit")
            return
        for line in lines[-_REPLAY_TAIL:]:
            try:
                item = json.loads(line)
            except Exception:
                continue
            if isinstance(item, dict) and item.get("type") == "healthEvent":
                self.events.append(_without_chain(item))

    def replay_tail(self) -> list[Dict[str, Any]]:
        return [dict(event) for event in self.events[-_REPLAY_TAIL:]]

    @property
    def head(self) -> str:
        return self.chain.head if self.chain is not None else ""

    def verify(self) -> bool:
        return True if self.chain is None else self.chain.verify()

    # -- writing ---------------------------------------------------------
    def record(self, event: Dict[str, Any]) -> None:
        self.events.append(dict(event))
        if len(self.events) > _AUDIT_RING:
            del self.events[:-_AUDIT_RING]
        if self.chain is None:
            return
        try:
            self.chain.append(event)
        except Exception:
            log.exception("could not persist the audit entry")


class ApiServer:
    """Control + telemetry WebSocket server implementing the shared contract."""

    def __init__(
        self,
        # LOOPBACK BY DEFAULT (FM-40). This socket takes arm / takeoff /
        # executePlan / emergencyStop; binding it wider is an explicit config
        # decision that also forces signed commands on
        # (config._enforce_bind_policy).
        host: str = "127.0.0.1",
        port: int = 8765,
        *,
        command_handler: Optional[CommandHandler] = None,
        manual_handler: Optional[ManualHandler] = None,
        heartbeat_hook: Optional[HeartbeatHook] = None,
        plan_command_handler: Optional[MessageHandler] = None,
        plan_heartbeat_handler: Optional[MessageHandler] = None,
        rf_event_handler: Optional[MessageHandler] = None,
        fleet_handler: Optional[MessageHandler] = None,
        connect_messages: Optional[ConnectMessages] = None,
        client_connected_hook: Optional[PresenceHook] = None,
        client_disconnected_hook: Optional[PresenceHook] = None,
        vehicle_id: str = "eis-1",
        audit_path: Optional[str] = None,
        max_queue: int = 32,
        authorize_hook: Optional[AuthorizeHook] = None,
        max_frame_bytes: int = DEFAULT_MAX_FRAME_BYTES,
        send_timeout_s: float = DEFAULT_SEND_TIMEOUT_S,
    ) -> None:
        """
        Bind address
          host, port
            Where the control socket listens. Loopback unless deliberately
            widened, which also turns signed commands on (see ``loopback_only``).

        Handlers -- one per inbound wire type, resolved through ``_ROUTES``
          command_handler
            Every ``command`` frame. Returns the CommandAck dict to broadcast;
            may be sync or async. Settable later via ``set_command_handler``.
          manual_handler
            Every ``manualInput`` frame. Returns nothing and is NEVER acked.
          plan_command_handler, plan_heartbeat_handler
            The planner rails. ``planCommand`` has a requestId/status/reason
            ack channel; ``planHeartbeat`` has none.
          rf_event_handler, fleet_handler
            Spectrum events and the hub-relayed peer view (ADR D26). Both
            fire-and-forget.

        Cross-cutting hooks
          authorize_hook
            Runs over EVERY inbound frame before liveness and before any
            handler. "" accepts; anything else refuses (FM-40).
          heartbeat_hook
            Called with the inbound epoch-ms on every ADMITTED frame -- wire it
            to the ground-link deadman.
          connect_messages
            Snapshot frames handed to each client after the audit replay.
          client_connected_hook, client_disconnected_hook
            Operator presence, called with the resulting client count. This is
            the liveness signal behind attendance mode.

        Identity, audit and bounds
          vehicle_id
            Stamped on every outbound frame; inbound frames addressed to
            anyone else are dropped.
          audit_path
            The hash-chained journal file (per vehicle).
          max_queue
            Bounds the INCOMING queue depth per client.
          max_frame_bytes
            Bounds one inbound frame, tighter than the 1 MiB default.
          send_timeout_s
            How long one client may block a broadcast before it is evicted as
            a stalled reader.
        """
        self.host = host
        self.port = port
        self.vehicle_id = str(vehicle_id).strip() or "eis-1"

        # Handler slots. _ROUTES names these by string, so adding a wire type
        # is a table entry plus a slot -- never another branch in _on_message.
        self._command_handler = command_handler
        self._manual_handler = manual_handler
        self._plan_command_handler = plan_command_handler
        self._plan_heartbeat_handler = plan_heartbeat_handler
        self._rf_event_handler = rf_event_handler
        self._fleet_handler = fleet_handler

        self._heartbeat_hook = heartbeat_hook
        self._authorize_hook = authorize_hook
        self._connect_messages = connect_messages
        self._client_connected_hook = client_connected_hook
        self._client_disconnected_hook = client_disconnected_hook

        self._audit_path = Path(audit_path) if audit_path else None
        self._journal = _AuditJournal(self._audit_path)

        self._max_queue = max_queue
        self._max_frame_bytes = max(1024, int(max_frame_bytes))
        self._send_timeout_s = max(0.05, float(send_timeout_s))
        #: Broadcasts dropped because a client would not accept them. Surfaced
        #: so a stalled renderer is observable rather than silent (FM-112).
        self.dropped_clients: int = 0
        self.dropped_frames: int = 0

        self._clients: Set[WebSocketServerProtocol] = set()
        self._server: Optional[Any] = None
        self._last_inbound_ms: float = 0.0
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    # ---- handler wiring (may be set after construction) ------------------
    def set_command_handler(self, handler: CommandHandler) -> None:
        self._command_handler = handler

    def set_manual_handler(self, handler: ManualHandler) -> None:
        self._manual_handler = handler

    def set_heartbeat_hook(self, hook: HeartbeatHook) -> None:
        self._heartbeat_hook = hook

    # ---- liveness ---------------------------------------------------------
    @property
    def client_count(self) -> int:
        return len(self._clients)

    @property
    def last_inbound_ms(self) -> float:
        """Epoch-ms of the last inbound frame (any type). 0 if none yet."""
        return self._last_inbound_ms

    def inbound_age_ms(self) -> float:
        """Milliseconds since the last inbound frame (huge if none yet)."""
        stamp = self._last_inbound_ms
        return math.inf if stamp <= 0.0 else _now_ms() - stamp

    # ---- lifecycle --------------------------------------------------------
    @property
    def loopback_only(self) -> bool:
        """True when the socket is bound to a loopback address only."""
        return str(self.host).strip() in LOOPBACK_HOSTS

    async def start(self) -> None:
        """Start serving. Idempotent-ish: starts the websockets server once."""
        self._loop = asyncio.get_running_loop()
        self._server = await websockets.serve(
            self._handle_client,
            self.host,
            self.port,
            ping_interval=20,
            ping_timeout=20,
            max_queue=self._max_queue,
            # Bounds the INBOUND frame size. max_queue bounds the inbound
            # QUEUE; neither bounds the outbound direction, which is handled
            # by the per-send timeout in broadcast() (FM-112).
            max_size=self._max_frame_bytes,
        )
        if self.loopback_only:
            log.info("control WS listening on ws://%s:%d (loopback)", self.host, self.port)
        else:
            log.warning(
                "control WS listening on ws://%s:%d -- NOT loopback: every "
                "inbound frame must be signed", self.host, self.port,
            )

    async def stop(self) -> None:
        """Stop serving and close all client connections."""
        server, self._server = self._server, None
        if server is not None:
            server.close()
            try:
                await server.wait_closed()
            except Exception:
                pass
        # close any stragglers
        stragglers, self._clients = list(self._clients), set()
        for ws in stragglers:
            await _close_quietly(ws)
        log.info("control WS stopped")

    # ---- connection handling ---------------------------------------------
    async def _handle_client(self, ws: WebSocketServerProtocol) -> None:
        peer = getattr(ws, "remote_address", None)
        self._clients.add(ws)
        log.info("ground client connected: %s (clients=%d)", peer, len(self._clients))
        await self._notify_presence(self._client_connected_hook)
        try:
            await self._send_initial(ws)
            async for raw in ws:
                await self._on_message(ws, raw)
        except websockets.ConnectionClosed:
            pass
        except Exception:  # never let one client kill the server
            log.exception("error in client loop for %s", peer)
        finally:
            self._clients.discard(ws)
            log.info("ground client disconnected: %s (clients=%d)", peer, len(self._clients))
            await self._notify_presence(self._client_disconnected_hook)

    async def _notify_presence(self, hook: Optional[PresenceHook]) -> None:
        """Tell the orchestrator an operator session appeared/disappeared.

        A raising hook must never take down the socket: presence is an input
        to attendance mode, and a broken hook leaves the mode where it was
        rather than flipping it.
        """
        if hook is None:
            return
        try:
            await _resolve(hook(len(self._clients)))
        except Exception:
            log.exception("presence hook failed")

    # ---- admission gates --------------------------------------------------
    # Each gate takes the raw frame (or the decoded dict, once _gate_decode has
    # produced one) and returns a _Verdict. The list is walked in order and the
    # first refusal ends the frame; only a frame that clears ALL of them is
    # credited as ground liveness. Ordering is load-bearing: authorization sits
    # BEFORE the liveness credit, or a peer on the venue LAN could hold the
    # deadman open while the real operator's link is down (FM-40).
    def _gate_decode(self, raw: Any) -> _Verdict:
        try:
            # parse_constant refuses the bare NaN/Infinity literals Python's
            # JSON parser otherwise accepts: a non-finite axis is a full-scale
            # command once it meets a clamp (FM-05).
            decoded = json.loads(raw, parse_constant=_reject_constant)
        except (ValueError, TypeError):
            return _Verdict(refusal="ignored malformed JSON frame")
        if not isinstance(decoded, dict):
            return _Verdict(refusal="ignored non-object frame")
        return _Verdict(payload=decoded)

    def _gate_addressed_here(self, msg: Dict[str, Any]) -> _Verdict:
        if msg.get("vehicleId") != self.vehicle_id:
            return _Verdict(
                refusal="ignored frame with missing or mismatched vehicleId"
            )
        return _PASS

    async def _gate_authorized(self, msg: Dict[str, Any]) -> _Verdict:
        """Run the signed-command layer over one inbound frame.

        A hook that RAISES is a refusal, not a pass: an authorizer we cannot
        run is not an authorizer that said yes.
        """
        hook = self._authorize_hook
        if hook is None:
            return _PASS
        try:
            refusal = await _resolve(hook(msg))
        except Exception as exc:
            log.exception("authorize hook raised")
            return _Verdict(refusal=f"frame refused: authorization failed ({exc})")
        return _Verdict(refusal=str(refusal or ""))

    def _credit_liveness(self) -> None:
        """Stamp the ground-link deadman. Only fully admitted frames get here."""
        ts = _now_ms()
        self._last_inbound_ms = ts
        hook = self._heartbeat_hook
        if hook is None:
            return
        try:
            hook(ts)
        except Exception:
            log.exception("heartbeat hook failed")

    async def _on_message(self, ws: WebSocketServerProtocol, raw: Any) -> None:
        decoded = self._gate_decode(raw)
        if decoded.refused:
            await self._refuse(ws, decoded.refusal)
            return
        msg = decoded.payload or {}

        for gate in (self._gate_addressed_here, self._gate_authorized):
            verdict = await _resolve(gate(msg))
            if verdict.refused:
                await self._refuse(ws, verdict.refusal)
                return

        # Only a validated, authorized frame for this vehicle counts as
        # ground liveness.
        self._credit_liveness()

        mtype = msg.get("type")
        route = _ROUTES.get(str(mtype))
        if route is None:
            # Unknown / ping / heartbeat frames: counted for liveness, ignored.
            log.debug("ignoring inbound frame type=%r", mtype)
            return
        await self._route(route, msg)

    async def _refuse(self, ws: WebSocketServerProtocol, reason: str) -> None:
        await self._send(ws, _status_text("warning", reason, self.vehicle_id))

    # ---- routing ----------------------------------------------------------
    async def _route(self, route: _Route, msg: Dict[str, Any]) -> None:
        """Deliver one admitted frame to its handler.

        A route with no ack channel is FIRE-AND-FORGET all the way down: a
        missing handler is silence, a raising handler is a log line, and
        nothing is ever sent back per frame. That is the manualInput contract
        (PRD 5.1) expressed once, for every ackless type.
        """
        handler = getattr(self, route.slot, None)
        if handler is None:
            await self._ack_missing_handler(route, msg)
            return
        try:
            result = await _resolve(handler(msg))
        except Exception as exc:
            log.exception("%s handler raised", msg.get("type"))
            await self._ack_failure(route, msg, exc)
            return
        if not route.broadcast_ack:
            return
        if route.ack_type == "ack":
            # The command path always produces an ack, even when the handler
            # forgot to: an operator waiting on one must not wait forever.
            ack = result if isinstance(result, dict) else _ack(
                str(msg.get("command", "")), False,
                "handler returned no ack", self.vehicle_id,
            )
            await self.push_ack(ack)
        elif isinstance(result, dict):
            await self.broadcast(result)

    async def _ack_missing_handler(self, route: _Route, msg: Dict[str, Any]) -> None:
        if route.ack_type == "ack":
            await self.push_ack(_ack(
                str(msg.get("command", "")), False,
                "no command handler registered", self.vehicle_id,
            ))
        elif route.ack_type:
            await self.broadcast(self._reject(route, msg, "no handler registered"))

    async def _ack_failure(
        self, route: _Route, msg: Dict[str, Any], exc: BaseException,
    ) -> None:
        if route.ack_type == "ack":
            command = str(msg.get("command", ""))
            await self.push_ack(_ack(
                command, False, f"command failed: {exc}", self.vehicle_id,
            ))
        elif route.ack_type:
            await self.broadcast(self._reject(route, msg, str(exc)))

    def _reject(
        self, route: _Route, msg: Dict[str, Any], reason: str,
    ) -> Dict[str, Any]:
        """The generic requestId/status/reason refusal (planCommandAck shape)."""
        return {
            "type": route.ack_type,
            "ts": _now_ms(),
            "vehicleId": self.vehicle_id,
            "requestId": str(msg.get("requestId", "")),
            "status": "rejected",
            "reason": reason,
        }

    # ---- outbound broadcast helpers --------------------------------------
    async def broadcast(self, message: Dict[str, Any]) -> None:
        """Send one JSON message to every connected client (best-effort)."""
        message.setdefault("vehicleId", self.vehicle_id)
        message.setdefault("ts", _now_ms())
        if message.get("type") in _AUDITED_TYPES:
            self._persist_audit(message)
        if not self._clients:
            return
        fanout = _Fanout(self._send_timeout_s)
        # snapshot to avoid mutation during iteration
        dead = await fanout.deliver(list(self._clients), _dumps(message))
        if fanout.stalled:
            self.dropped_frames += fanout.stalled
        for ws in dead:
            self.dropped_clients += 1
            self._clients.discard(ws)
            await _close_quietly(ws)

    async def _send(self, ws: WebSocketServerProtocol, message: Dict[str, Any]) -> None:
        try:
            await asyncio.wait_for(
                ws.send(_dumps(message)), timeout=self._send_timeout_s
            )
        except Exception:
            self._clients.discard(ws)

    # -- typed push helpers (the orchestrator calls these) -----------------
    async def _push_typed(self, message: Dict[str, Any], wire_type: str) -> None:
        """Broadcast ``message`` as ``wire_type``, filling type+ts if absent."""
        message.setdefault("type", wire_type)
        message.setdefault("ts", _now_ms())
        await self.broadcast(message)

    async def push_telemetry(self, telemetry: Dict[str, Any]) -> None:
        """Broadcast a contract ``telemetry`` message (ensures type+ts)."""
        await self._push_typed(telemetry, "telemetry")

    async def push_tracking(self, tracking: Dict[str, Any]) -> None:
        """Broadcast a contract ``tracking`` message (ensures type+ts)."""
        await self._push_typed(tracking, "tracking")

    async def push_status(self, severity: str, text: str) -> None:
        """Broadcast a contract ``statusText`` message."""
        await self.broadcast(_status_text(severity, text, self.vehicle_id))

    async def push_ack(self, ack: Dict[str, Any]) -> None:
        """Broadcast a contract ``ack`` message (ensures type+ts)."""
        await self._push_typed(ack, "ack")

    async def _send_initial(self, ws: WebSocketServerProtocol) -> None:
        """Hand a fresh client the audit replay, then the connect snapshot."""
        for event in self._journal.replay_tail():
            await self._send(ws, event)
        if self._connect_messages is None:
            return
        snapshot = await _resolve(self._connect_messages())
        for message in snapshot or []:
            message.setdefault("vehicleId", self.vehicle_id)
            message.setdefault("ts", _now_ms())
            await self._send(ws, message)

    # ---- audit ------------------------------------------------------------
    @property
    def _audit_events(self) -> list[Dict[str, Any]]:
        """The in-memory audit ring (kept as an attribute for introspection)."""
        return self._journal.events

    @property
    def _chain(self):
        """The hash-chained audit sink, or ``None`` when unavailable."""
        return self._journal.chain

    def _load_audit(self) -> None:
        """Re-read the recent audit tail from disk (replay for a new client)."""
        self._journal.events.clear()
        self._journal._replay_from_disk()

    @property
    def audit_head(self) -> str:
        """Hash of the newest audit entry -- the chain's head."""
        return self._journal.head

    def verify_audit_chain(self) -> bool:
        """True when every loaded link hashes to its successor's ``prev``."""
        return self._journal.verify()

    def _persist_audit(self, event: Dict[str, Any]) -> None:
        """Append one event to the hash-chained, append-only audit log.

        Every entry already carries ``vehicleId`` -- ``broadcast`` stamps it
        before we get here.
        """
        self._journal.record(event)


# ==========================================================================
# Small contract-shape builders
# ==========================================================================
async def _close_quietly(ws: Any) -> None:
    """Close one socket; a close that fails is not worth a traceback."""
    try:
        await ws.close()
    except Exception:
        pass


def _without_chain(entry: Dict[str, Any]) -> Dict[str, Any]:
    """Strip the audit chain's own bookkeeping from a replayed wire message."""
    return {k: v for k, v in entry.items() if k not in _CHAIN_KEYS}


def _build_chain(path: Optional[Path]):
    """The hash-chained audit sink; ``None`` if the security module is absent."""
    try:
        from ..security import AuditChain
    except Exception:  # pragma: no cover - only on a broken install
        log.warning("security.AuditChain unavailable; audit chaining disabled")
        return None
    return AuditChain(str(path) if path is not None else None)


def _envelope(wire_type: str, vehicle_id: str) -> Dict[str, Any]:
    """The three fields every companion -> ground frame carries."""
    return {"type": wire_type, "ts": _now_ms(), "vehicleId": vehicle_id}


def _ack(command: str, success: bool, message: str, vehicle_id: str = "eis-1") -> Dict[str, Any]:
    frame = _envelope("ack", vehicle_id)
    frame["command"] = command
    frame["success"] = bool(success)
    frame["message"] = str(message)
    return frame


def _status_text(severity: str, text: str, vehicle_id: str = "eis-1") -> Dict[str, Any]:
    frame = _envelope("statusText", vehicle_id)
    frame["severity"] = severity
    frame["text"] = str(text)
    return frame


__all__ = ["ApiServer", "CommandHandler", "ManualHandler"]
