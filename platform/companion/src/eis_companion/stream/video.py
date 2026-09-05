"""
============================================================================
Drone Safety Platform -- COMPANION video stream (mediamtx + GStreamer)
----------------------------------------------------------------------------
Publishes the Jetson camera as a low-latency RTSP stream and exposes WebRTC/WHEP
for the ground UI:

    camera --(GStreamer encode + rtspclientsink)--> mediamtx :8554 (RTSP)
                                                            \\-> :8889 (WebRTC/WHEP)

The ground UI plays ``rtsp://<jetson>:8554/stream`` directly or, lowest-latency,
``http://<jetson>:8889/stream/whep`` over WebRTC. mediamtx is the RTSP/WebRTC
server; GStreamer encodes the camera and pushes into it.

DEGRADE GRACEFULLY (PRD): if the ``mediamtx`` binary or ``gst-launch-1.0`` are
not present (e.g. a Windows/dev box running SITL with no camera), ``start()``
logs a warning and becomes a no-op instead of raising -- the control loop and
the contract API still run, and the UI falls back to its mock canvas. Nothing
here is required for the SITL acceptance demo.

Pipeline notes
  * On the Orin Nano with a CSI camera we use ``nvarguscamerasrc`` +
    ``nvv4l2h264enc`` (hardware H.264). For a USB/V4L2 cam we use ``v4l2src`` +
    ``x264enc`` (software) as a portable fallback.
  * H.264 baseline, zerolatency tuning, short keyframe interval for fast WebRTC
    start. Bitrate / resolution / fps are configurable.

This module shells out to subprocesses; it imports only stdlib so it is import-
safe everywhere. It does not touch MAVLink / vision.
============================================================================
"""
from __future__ import annotations

import logging
import shutil
import signal
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional

log = logging.getLogger("eis.stream")

# The mediamtx config shipped alongside this module (rtsp 8554, webrtc 8889).
_MEDIAMTX_YML = Path(__file__).with_name("mediamtx.yml")

# Stream path name (the UI appends this): rtsp://host:8554/<PATH>
STREAM_PATH = "stream"


@dataclass
class StreamConfig:
    """Video stream configuration."""
    source: str = "csi"            # csi | v4l2 | file | sim | mock
    device: str = "/dev/video0"    # used when source == v4l2
    file: str = ""                 # used when source == file
    width: int = 1280
    height: int = 720
    fps: int = 30
    bitrate_kbps: int = 2500
    rtsp_port: int = 8554
    webrtc_port: int = 8889
    mediamtx_bin: str = "mediamtx"
    gst_bin: str = "gst-launch-1.0"
    mediamtx_config: Optional[str] = None  # override the shipped mediamtx.yml

    @property
    def has_video(self) -> bool:
        """Whether a real video source is configured (sim/mock => no stream)."""
        return self.source not in ("sim", "mock", "")

    @property
    def rtsp_url(self) -> str:
        return f"rtsp://127.0.0.1:{self.rtsp_port}/{STREAM_PATH}"


class VideoStream:
    """Launches + supervises mediamtx and the GStreamer publisher.

    Use ``start()`` / ``stop()``. Both are safe to call when the tooling is
    missing -- they degrade to no-ops and log, never raise, so the companion
    keeps running headless.
    """

    def __init__(self, config: StreamConfig) -> None:
        self.config = config
        self._mediamtx: Optional[subprocess.Popen] = None
        self._gst: Optional[subprocess.Popen] = None
        self._started = False

    # ---- lifecycle --------------------------------------------------------
    def start(self) -> bool:
        """Start mediamtx + the GStreamer publisher.

        Returns True if a stream was launched, False if it degraded to a no-op
        (no video source, or tooling absent). Never raises.
        """
        if self._started:
            return True
        cfg = self.config

        if not cfg.has_video:
            log.info("video stream disabled (source=%r) -- UI uses mock canvas", cfg.source)
            return False

        if shutil.which(cfg.mediamtx_bin) is None:
            log.warning(
                "mediamtx binary %r not found; video stream disabled. "
                "Install mediamtx or set the camera source to 'sim'.",
                cfg.mediamtx_bin,
            )
            return False

        try:
            self._start_mediamtx()
        except Exception:
            log.exception("failed to launch mediamtx; video stream disabled")
            self._kill_all()
            return False

        if shutil.which(cfg.gst_bin) is None:
            log.warning(
                "%r not found; mediamtx is up but no GStreamer publisher. "
                "An external publisher may still push to %s.",
                cfg.gst_bin, cfg.rtsp_url,
            )
            self._started = True
            return True

        try:
            self._start_gst()
        except Exception:
            log.exception("failed to launch GStreamer publisher; mediamtx left running")

        self._started = True
        log.info(
            "video stream up: RTSP %s  |  WebRTC/WHEP http://0.0.0.0:%d/%s/whep",
            cfg.rtsp_url, cfg.webrtc_port, STREAM_PATH,
        )
        return True

    def stop(self) -> None:
        """Stop the GStreamer publisher and mediamtx. Never raises."""
        self._kill_all()
        self._started = False
        log.info("video stream stopped")

    @property
    def running(self) -> bool:
        return self._started

    # ---- subprocess management -------------------------------------------
    def _start_mediamtx(self) -> None:
        cfg = self.config
        config_path = cfg.mediamtx_config or (
            str(_MEDIAMTX_YML) if _MEDIAMTX_YML.is_file() else None
        )
        cmd = [cfg.mediamtx_bin]
        if config_path:
            cmd.append(config_path)
        log.info("launching mediamtx: %s", " ".join(cmd))
        self._mediamtx = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.STDOUT,
        )

    def _start_gst(self) -> None:
        cfg = self.config
        pipeline = build_gst_pipeline(cfg)
        cmd = [cfg.gst_bin, "-q", *pipeline]
        log.info("launching GStreamer publisher: %s", " ".join(cmd))
        self._gst = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.STDOUT,
        )

    def _kill_all(self) -> None:
        for proc in (self._gst, self._mediamtx):
            if proc is None:
                continue
            try:
                if proc.poll() is None:
                    if sys.platform == "win32":
                        proc.terminate()
                    else:
                        proc.send_signal(signal.SIGINT)
                    try:
                        proc.wait(timeout=3.0)
                    except subprocess.TimeoutExpired:
                        proc.kill()
            except Exception:
                pass
        self._gst = None
        self._mediamtx = None


def build_gst_pipeline(cfg: StreamConfig) -> List[str]:
    """Build the GStreamer pipeline (as argv tokens) for the configured source.

    Encodes H.264 with low-latency tuning and pushes to mediamtx over RTSP via
    ``rtspclientsink``. Uses the Jetson hardware encoder for the CSI path and a
    portable software encoder for V4L2/file fallbacks.
    """
    bitrate_bps = max(200_000, cfg.bitrate_kbps * 1000)
    caps = f"video/x-raw,width={cfg.width},height={cfg.height},framerate={cfg.fps}/1"
    location = cfg.rtsp_url

    if cfg.source == "csi":
        # Jetson CSI: nvarguscamerasrc -> NVENC H.264 (hardware).
        return [
            "nvarguscamerasrc", "!",
            f"video/x-raw(memory:NVMM),width={cfg.width},height={cfg.height},"
            f"framerate={cfg.fps}/1", "!",
            "nvvidconv", "!",
            "nvv4l2h264enc",
            f"bitrate={bitrate_bps}", "insert-sps-pps=true",
            "iframeinterval=15", "maxperf-enable=true", "!",
            "h264parse", "!",
            "rtspclientsink", f"location={location}", "latency=0",
        ]

    if cfg.source == "file":
        # Loop a local file (handy for bench testing without a camera).
        return [
            "filesrc", f"location={cfg.file}", "!",
            "decodebin", "!", "videoconvert", "!",
            "videoscale", "!", caps, "!",
            "x264enc", "tune=zerolatency", "speed-preset=ultrafast",
            f"bitrate={cfg.bitrate_kbps}", "key-int-max=15", "!",
            "h264parse", "!",
            "rtspclientsink", f"location={location}", "latency=0",
        ]

    # Default: V4L2 USB camera -> software x264 (portable fallback).
    return [
        "v4l2src", f"device={cfg.device}", "!",
        "videoconvert", "!", "videoscale", "!", caps, "!",
        "x264enc", "tune=zerolatency", "speed-preset=ultrafast",
        f"bitrate={cfg.bitrate_kbps}", "key-int-max=15", "!",
        "h264parse", "!",
        "rtspclientsink", f"location={location}", "latency=0",
    ]


__all__ = ["VideoStream", "StreamConfig", "build_gst_pipeline", "STREAM_PATH"]
