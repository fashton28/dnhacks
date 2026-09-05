"""
============================================================================
Drone Safety Platform -- COMPANION control WebSocket server (the shared contract)
----------------------------------------------------------------------------
An asyncio ``websockets`` server on the control port (default 8765) that speaks
the JSON contract in ``shared/shared.py`` / ``ground/ui/src/contract``:

  companion -> ground (push):  telemetry, tracking, statusText, ack
  ground -> companion:         command  (routed to a handler -> CommandAck, acked)
                               manualInput (routed to a handler, FIRE-AND-FORGET)

Design
  * One ``ApiServer`` per process. It owns the set of connected clients and
    broadcasts every outbound frame to all of them (telemetry/tracking are
    pushed ~10 Hz by the orchestrator; statusText/ack on demand).
  * Inbound frames are dispatched by ``type``:
      - ``command``     -> the registered command handler (sync or async),
                           whose returned ``CommandAck`` dict is broadcast.
      - ``manualInput`` -> the registered manual handler, with NO ack. This is
                           the high-rate path (PRD 5.1): never block on / build
                           backpressure from a per-stick-frame ack.
  * Every inbound message bumps ``last_inbound_ms`` (and notifies an optional
    heartbeat callback) so the orchestrator's ground-link deadman sees the link
    as alive -- a command OR a manualInput OR a ping all count.
  * Robust by construction: a handler raising never kills the socket or the
    server; malformed JSON is answered with a statusText, not a crash. Default
    to the safe behaviour on any error.

Only depends on stdlib + ``websockets``. The orchestrator wires the handlers and
calls the ``push_*`` helpers; this module knows nothing about MAVLink / vision.
============================================================================
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Optional, Set, Union

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


def _now_ms() -> int:
    return int(time.time() * 1000)


class ApiServer:
    """Control + telemetry WebSocket server implementing the shared contract."""

    def __init__(
        self,
        host: str = "0.0.0.0",
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
    ) -> None:
        """
        Args:
          host/port: bind address for the control WS server.
          command_handler: called for every ``command`` frame; returns the ack
            dict to broadcast. May be sync or async. Settable later via
            ``set_command_handler``.
          manual_handler: called for every ``manualInput`` frame; NOT acked.
          heartbeat_hook: called with the inbound ms ts on every received frame
            (wire it to SafetyManager.note_ground_heartbeat for the deadman).
          max_queue: per-client outbound send queue depth before we drop the
            slow client (prevents one stalled UI from backpressuring telemetry).
        """
        self.host = host
        self.port = port
        self._command_handler = command_handler
        self._manual_handler = manual_handler
        self._heartbeat_hook = heartbeat_hook
        self._plan_command_handler = plan_command_handler
        self._plan_heartbeat_handler = plan_heartbeat_handler
        self._rf_event_handler = rf_event_handler
        self._fleet_handler = fleet_handler
        self._connect_messages = connect_messages
        self._client_connected_hook = client_connected_hook
        self._client_disconnected_hook = client_disconnected_hook
        self.vehicle_id = str(vehicle_id).strip() or "eis-1"
        self._audit_path = Path(audit_path) if audit_path else None
        self._audit_events: list[Dict[str, Any]] = []
        self._chain = _build_chain(self._audit_path)
        self._load_audit()
        self._max_queue = max_queue

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
        if self._last_inbound_ms <= 0.0:
            return float("inf")
        return _now_ms() - self._last_inbound_ms

    # ---- lifecycle --------------------------------------------------------
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
        )
        log.info("control WS listening on ws://%s:%d", self.host, self.port)

    async def stop(self) -> None:
        """Stop serving and close all client connections."""
        if self._server is not None:
            self._server.close()
            try:
                await self._server.wait_closed()
            except Exception:
                pass
            self._server = None
        # close any stragglers
        for ws in list(self._clients):
            try:
                await ws.close()
            except Exception:
                pass
        self._clients.clear()
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
            result = hook(len(self._clients))
            if asyncio.iscoroutine(result):
                await result
        except Exception:
            log.exception("presence hook failed")

    async def _on_message(self, ws: WebSocketServerProtocol, raw: Any) -> None:
        try:
            msg = json.loads(raw)
        except (ValueError, TypeError):
            await self._send(ws, _status_text("warning", "ignored malformed JSON frame", self.vehicle_id))
            return
        if not isinstance(msg, dict):
            await self._send(ws, _status_text("warning", "ignored non-object frame", self.vehicle_id))
            return

        if msg.get("vehicleId") != self.vehicle_id:
            await self._send(
                ws,
                _status_text(
                    "warning",
                    "ignored frame with missing or mismatched vehicleId",
                    self.vehicle_id,
                ),
            )
            return

        # Only a validated frame for this vehicle counts as ground liveness.
        ts = _now_ms()
        self._last_inbound_ms = ts
        if self._heartbeat_hook is not None:
            try:
                self._heartbeat_hook(ts)
            except Exception:
                log.exception("heartbeat hook failed")

        mtype = msg.get("type")
        if mtype == "command":
            await self._dispatch_command(msg)
        elif mtype == "manualInput":
            await self._dispatch_manual(msg)
        elif mtype == "planCommand":
            await self._dispatch_message(self._plan_command_handler, msg, ack_type="planCommandAck")
        elif mtype == "planHeartbeat":
            await self._dispatch_message(self._plan_heartbeat_handler, msg)
        elif mtype == "rfEvent":
            await self._dispatch_message(self._rf_event_handler, msg)
        elif mtype == "fleet":
            # The hub-relayed peer view (ADR D26): the ONLY cross-vehicle input.
            # Fire-and-forget like manualInput -- there is nothing to ack, and
            # a peer update must never block the telemetry pump.
            await self._dispatch_message(self._fleet_handler, msg)
        else:
            # Unknown / ping / heartbeat frames: counted for liveness, ignored.
            log.debug("ignoring inbound frame type=%r", mtype)

    async def _dispatch_command(self, msg: Dict[str, Any]) -> None:
        """Route a command to the handler and broadcast its CommandAck."""
        handler = self._command_handler
        cmd_name = msg.get("command", "")
        if handler is None:
            ack = _ack(cmd_name, False, "no command handler registered", self.vehicle_id)
            await self.push_ack(ack)
            return
        try:
            result = handler(msg)
            if asyncio.iscoroutine(result):
                result = await result
            ack = result if isinstance(result, dict) else _ack(cmd_name, False, "handler returned no ack", self.vehicle_id)
        except Exception as exc:  # safe default: report failure, never crash
            log.exception("command handler raised for %r", cmd_name)
            ack = _ack(cmd_name, False, f"command failed: {exc}", self.vehicle_id)
        await self.push_ack(ack)

    async def _dispatch_manual(self, msg: Dict[str, Any]) -> None:
        """Route a high-rate manualInput frame. FIRE-AND-FORGET: never acked."""
        handler = self._manual_handler
        if handler is None:
            return
        try:
            result = handler(msg)
            if asyncio.iscoroutine(result):
                await result
        except Exception:  # a bad stick frame must never disrupt the link
            log.exception("manual handler raised")

    async def _dispatch_message(
        self,
        handler: Optional[MessageHandler],
        msg: Dict[str, Any],
        *,
        ack_type: str = "",
    ) -> None:
        if handler is None:
            if ack_type:
                await self.broadcast({
                    "type": ack_type,
                    "ts": _now_ms(),
                    "vehicleId": self.vehicle_id,
                    "requestId": str(msg.get("requestId", "")),
                    "status": "rejected",
                    "reason": "no handler registered",
                })
            return
        try:
            result = handler(msg)
            if asyncio.iscoroutine(result):
                result = await result
            if ack_type and isinstance(result, dict):
                await self.broadcast(result)
        except Exception as exc:
            log.exception("%s handler raised", msg.get("type"))
            if ack_type:
                await self.broadcast({
                    "type": ack_type,
                    "ts": _now_ms(),
                    "vehicleId": self.vehicle_id,
                    "requestId": str(msg.get("requestId", "")),
                    "status": "rejected",
                    "reason": str(exc),
                })

    # ---- outbound broadcast helpers --------------------------------------
    async def broadcast(self, message: Dict[str, Any]) -> None:
        """Send one JSON message to every connected client (best-effort)."""
        message.setdefault("vehicleId", self.vehicle_id)
        message.setdefault("ts", _now_ms())
        if message.get("type") in _AUDITED_TYPES:
            self._persist_audit(message)
        if not self._clients:
            return
        data = json.dumps(message, separators=(",", ":"))
        dead: Set[WebSocketServerProtocol] = set()
        # snapshot to avoid mutation during iteration
        for ws in list(self._clients):
            try:
                await ws.send(data)
            except Exception:
                dead.add(ws)
        for ws in dead:
            self._clients.discard(ws)
            try:
                await ws.close()
            except Exception:
                pass

    async def _send(self, ws: WebSocketServerProtocol, message: Dict[str, Any]) -> None:
        try:
            await ws.send(json.dumps(message, separators=(",", ":")))
        except Exception:
            self._clients.discard(ws)

    # -- typed push helpers (the orchestrator calls these) -----------------
    async def push_telemetry(self, telemetry: Dict[str, Any]) -> None:
        """Broadcast a contract ``telemetry`` message (ensures type+ts)."""
        telemetry.setdefault("type", "telemetry")
        telemetry.setdefault("ts", _now_ms())
        await self.broadcast(telemetry)

    async def push_tracking(self, tracking: Dict[str, Any]) -> None:
        """Broadcast a contract ``tracking`` message (ensures type+ts)."""
        tracking.setdefault("type", "tracking")
        tracking.setdefault("ts", _now_ms())
        await self.broadcast(tracking)

    async def push_status(self, severity: str, text: str) -> None:
        """Broadcast a contract ``statusText`` message."""
        await self.broadcast(_status_text(severity, text, self.vehicle_id))

    async def push_ack(self, ack: Dict[str, Any]) -> None:
        """Broadcast a contract ``ack`` message (ensures type+ts)."""
        ack.setdefault("type", "ack")
        ack.setdefault("ts", _now_ms())
        await self.broadcast(ack)

    async def _send_initial(self, ws: WebSocketServerProtocol) -> None:
        for event in self._audit_events[-100:]:
            await self._send(ws, dict(event))
        if self._connect_messages is None:
            return
        result = self._connect_messages()
        if asyncio.iscoroutine(result):
            result = await result
        for message in result or []:
            message.setdefault("vehicleId", self.vehicle_id)
            message.setdefault("ts", _now_ms())
            await self._send(ws, message)

    def _load_audit(self) -> None:
        """Replay the recent audit tail so a reconnecting UI sees history.

        Only ``healthEvent`` entries are replayed to clients (that is what the
        UI's event log consumes); the chain itself covers every audited type.
        Stored records carry ``prev``/``hash``, which are chain metadata and
        not wire fields, so they are stripped before anything is sent.
        """
        if self._audit_path is None or not self._audit_path.exists():
            return
        try:
            for line in self._audit_path.read_text(encoding="utf-8").splitlines()[-100:]:
                item = json.loads(line)
                if isinstance(item, dict) and item.get("type") == "healthEvent":
                    self._audit_events.append(_without_chain(item))
        except Exception:
            log.exception("could not load local health-event audit")

    @property
    def audit_head(self) -> str:
        """Hash of the newest audit entry -- the chain's head."""
        return self._chain.head if self._chain is not None else ""

    def verify_audit_chain(self) -> bool:
        """True when every loaded link hashes to its successor's ``prev``."""
        return True if self._chain is None else self._chain.verify()

    def _persist_audit(self, event: Dict[str, Any]) -> None:
        """Append one event to the hash-chained, append-only audit log.

        The chain is what makes suppression DETECTABLE: an entry removed or
        edited after the fact breaks the link to its successor
        (docs/THREAT_MODEL.md A7). Every entry already carries ``vehicleId``
        -- ``broadcast`` stamps it before we get here.
        """
        self._audit_events.append(dict(event))
        self._audit_events = self._audit_events[-1000:]
        if self._chain is None:
            return
        try:
            self._chain.append(event)
        except Exception:
            log.exception("could not persist the audit entry")


# ==========================================================================
# Small contract-shape builders
# ==========================================================================
def _without_chain(entry: Dict[str, Any]) -> Dict[str, Any]:
    """Strip the audit chain's own bookkeeping from a replayed wire message."""
    return {k: v for k, v in entry.items() if k not in ("prev", "hash")}


def _build_chain(path: Optional[Path]):
    """The hash-chained audit sink; ``None`` if the security module is absent."""
    try:
        from ..security import AuditChain
    except Exception:  # pragma: no cover - only on a broken install
        log.warning("security.AuditChain unavailable; audit chaining disabled")
        return None
    return AuditChain(str(path) if path is not None else None)


def _ack(command: str, success: bool, message: str, vehicle_id: str = "eis-1") -> Dict[str, Any]:
    return {
        "type": "ack",
        "ts": _now_ms(),
        "vehicleId": vehicle_id,
        "command": command,
        "success": bool(success),
        "message": str(message),
    }


def _status_text(severity: str, text: str, vehicle_id: str = "eis-1") -> Dict[str, Any]:
    return {
        "type": "statusText",
        "ts": _now_ms(),
        "vehicleId": vehicle_id,
        "severity": severity,
        "text": str(text),
    }


__all__ = ["ApiServer", "CommandHandler", "ManualHandler"]
