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

The names below resolve on first use (PEP 562), so importing this package does
not drag in the ``websockets`` stack -- the pure-logic tests and the offline
tooling import it without a server dependency.
============================================================================
"""
from __future__ import annotations

from importlib import import_module
from typing import Any, Dict, List

#: exported name -> the module inside this package that defines it
_EXPORTED_BY: Dict[str, str] = {
    "ApiServer": "server",
    "CommandHandler": "server",
    "ManualHandler": "server",
}


def __getattr__(name: str) -> Any:
    """Resolve a re-exported name the first time it is read."""
    origin = _EXPORTED_BY.get(name)
    if origin is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(f".{origin}", __name__), name)
    globals()[name] = value      # bind it, so later reads skip this hook
    return value


def __dir__() -> List[str]:
    return sorted(set(globals()) | set(_EXPORTED_BY))


__all__ = ["ApiServer", "CommandHandler", "ManualHandler"]
