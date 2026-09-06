"""
============================================================================
Drone Safety Platform -- COMPANION video stream sub-package
----------------------------------------------------------------------------
Low-latency video from the Jetson camera to the ground UI. ``VideoStream``
(video.py) launches ``mediamtx`` (RTSP on 8554 + WebRTC/WHEP on 8889) and a
GStreamer pipeline that publishes the camera to ``rtsp://0.0.0.0:8554/stream``.
It degrades gracefully (logs + no-ops) when mediamtx / GStreamer are absent, so
the rest of the companion still runs in SITL on a dev box with no camera.

Both names resolve on first use (PEP 562): the orchestrator imports this
package only on the branch that actually starts a stream, and nothing else
should pay for that import.
============================================================================
"""
from __future__ import annotations

from importlib import import_module
from typing import Any, Dict, List

#: exported name -> the module inside this package that defines it
_EXPORTED_BY: Dict[str, str] = {
    "VideoStream": "video",
    "StreamConfig": "video",
}


def __getattr__(name: str) -> Any:
    """Import ``video`` on the first read of a re-exported name."""
    origin = _EXPORTED_BY.get(name)
    if origin is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(f".{origin}", __name__), name)
    globals()[name] = value      # bind it, so later reads skip this hook
    return value


def __dir__() -> List[str]:
    return sorted(set(globals()) | set(_EXPORTED_BY))


__all__ = ["VideoStream", "StreamConfig"]
