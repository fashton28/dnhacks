"""
============================================================================
Drone Safety Platform -- COMPANION control API sub-package
----------------------------------------------------------------------------
The control WebSocket server implementing the shared contract (PRD 5):

    companion -> ground:  telemetry (~10 Hz), tracking (~10 Hz), statusText, ack
    ground -> companion:  command (acked), manualInput (fire-and-forget)

``ApiServer`` (server.py) broadcasts the four outbound message types to every
connected client, routes inbound ``command`` frames to a callback that returns a
``CommandAck`` (which is then broadcast), and routes high-rate ``manualInput``
frames to a separate callback WITHOUT acking. It also tracks per-client connect/
disconnect and the last-inbound-message time so the orchestrator's ground-link
deadman can see the link's liveness.
============================================================================
"""
from __future__ import annotations

from .server import ApiServer, CommandHandler, ManualHandler

__all__ = ["ApiServer", "CommandHandler", "ManualHandler"]
