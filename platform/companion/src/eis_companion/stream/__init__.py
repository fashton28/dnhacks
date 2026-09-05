"""
============================================================================
Drone Safety Platform -- COMPANION video stream sub-package
----------------------------------------------------------------------------
Low-latency video from the Jetson camera to the ground UI. ``VideoStream``
(video.py) launches ``mediamtx`` (RTSP on 8554 + WebRTC/WHEP on 8889) and a
GStreamer pipeline that publishes the camera to ``rtsp://0.0.0.0:8554/stream``.
It degrades gracefully (logs + no-ops) when mediamtx / GStreamer are absent, so
the rest of the companion still runs in SITL on a dev box with no camera.
============================================================================
"""
from __future__ import annotations

from .video import VideoStream, StreamConfig

__all__ = ["VideoStream", "StreamConfig"]
