"""
============================================================================
Drone Safety Platform -- COMPANION video stream (mediamtx + GStreamer)
----------------------------------------------------------------------------
Publishes the Jetson camera as low-latency RTSP and exposes WebRTC/WHEP for
the ground UI:

    camera --(GStreamer encode + rtspclientsink)--> mediamtx :8554 (RTSP)
                                                            \\-> :8889 (WebRTC/WHEP)

The UI plays ``rtsp://<jetson>:8554/stream``, or -- lowest latency --
``http://<jetson>:8889/stream/whep`` over WebRTC.  mediamtx is the server;
GStreamer is the publisher that feeds it.

DEGRADE GRACEFULLY (PRD).  Two independent external binaries can be missing,
and each absence has its own answer:

    mediamtx missing        -> nothing to publish INTO. start() is a no-op.
    gst-launch-1.0 missing  -> the server still runs; an external publisher
                               may push to it, so we keep mediamtx up and say
                               so rather than tearing everything down.
    source is sim/mock      -> there is no camera at all; the UI falls back to
                               its mock canvas.

``start()`` returns whether a stream was launched and never raises; neither
does ``stop()``.  On a Windows/dev box running SITL with no camera the whole
module is inert and the control loop plus contract API are unaffected.

Pipeline notes
  * Orin Nano + CSI: ``nvarguscamerasrc`` -> ``nvv4l2h264enc`` (hardware).
  * USB/V4L2 or a file: ``v4l2src``/``filesrc`` -> ``x264enc`` (software),
    the portable fallback.
  * H.264, zerolatency tuning, 15-frame keyframe interval so a WebRTC viewer
    gets its first picture quickly.  Bitrate / resolution / fps configurable.

stdlib only -- no MAVLink, no vision, import-safe everywhere.
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
from typing import List, Optional, Sequence

log = logging.getLogger("eis.stream")

# The mediamtx config shipped alongside this module (rtsp 8554, webrtc 8889).
_MEDIAMTX_YML = Path(__file__).with_name("mediamtx.yml")

# Stream path name (the UI appends this): rtsp://host:8554/<PATH>
STREAM_PATH = "stream"

#: Sources that mean "there is no camera on this machine".
_SOURCELESS = frozenset({"sim", "mock", ""})

#: Seconds a child gets to exit politely before it is killed.
_STOP_GRACE_S = 3.0


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
        return self.source not in _SOURCELESS

    @property
    def rtsp_url(self) -> str:
        """Where the publisher pushes -- loopback, mediamtx re-serves it."""
        return f"rtsp://127.0.0.1:{self.rtsp_port}/{STREAM_PATH}"

    @property
    def whep_url(self) -> str:
        """The WebRTC/WHEP endpoint mediamtx exposes for the same path."""
        return f"http://0.0.0.0:{self.webrtc_port}/{STREAM_PATH}/whep"

    def resolved_mediamtx_config(self) -> Optional[str]:
        """The config file mediamtx should be started with, if any."""
        if self.mediamtx_config:
            return self.mediamtx_config
        return str(_MEDIAMTX_YML) if _MEDIAMTX_YML.is_file() else None


class _Child:
    """One supervised external process.

    Owns the whole lifecycle of a single binary so ``VideoStream`` deals in
    "children" rather than in two ad-hoc ``Popen`` slots -- adding, ordering
    or restarting one is then a list operation.
    """

    def __init__(self, name: str, argv: Sequence[str]) -> None:
        self.name = name
        self.argv = list(argv)
        self._proc: Optional[subprocess.Popen] = None

    def spawn(self) -> None:
        """Launch the process.  Raises whatever ``Popen`` raises."""
        log.info("launching %s: %s", self.name, " ".join(self.argv))
        self._proc = subprocess.Popen(
            self.argv,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.STDOUT,
        )

    @property
    def alive(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def shutdown(self, grace: float = _STOP_GRACE_S) -> None:
        """Ask politely, then insist.  Never raises."""
        proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            if proc.poll() is not None:
                return
            # SIGINT is what mediamtx and gst-launch treat as a clean stop;
            # Windows has no SIGINT delivery to a child, so terminate there.
            if sys.platform == "win32":
                proc.terminate()
            else:
                proc.send_signal(signal.SIGINT)
            try:
                proc.wait(timeout=grace)
            except subprocess.TimeoutExpired:
                log.warning("%s ignored the stop signal; killing it", self.name)
                proc.kill()
        except Exception:
            pass


class VideoStream:
    """Launches + supervises mediamtx and the GStreamer publisher.

    Use ``start()`` / ``stop()``. Both are safe to call when the tooling is
    missing -- they degrade to no-ops and log, never raise, so the companion
    keeps running headless.
    """

    def __init__(self, config: StreamConfig) -> None:
        self.config = config
        # Launch order; teardown walks it in reverse so the publisher stops
        # before the server it is pushing into.
        self._children: List[_Child] = []
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

        if not self._launch("mediamtx", self._mediamtx_argv()):
            log.error("failed to launch mediamtx; video stream disabled")
            self._teardown()
            return False

        # From here the server is up: every later failure keeps it up, because
        # an external publisher can still feed it.
        self._started = True

        if shutil.which(cfg.gst_bin) is None:
            log.warning(
                "%r not found; mediamtx is up but no GStreamer publisher. "
                "An external publisher may still push to %s.",
                cfg.gst_bin, cfg.rtsp_url,
            )
            return True

        if not self._launch("gstreamer publisher", self._gst_argv()):
            log.error("failed to launch GStreamer publisher; mediamtx left running")
            return True

        log.info(
            "video stream up: RTSP %s  |  WebRTC/WHEP %s",
            cfg.rtsp_url, cfg.whep_url,
        )
        return True

    def stop(self) -> None:
        """Stop the GStreamer publisher and mediamtx. Never raises."""
        self._teardown()
        self._started = False
        log.info("video stream stopped")

    @property
    def running(self) -> bool:
        return self._started

    def child_status(self) -> dict[str, bool]:
        """``{child name: still alive}`` -- for health reporting/diagnostics."""
        return {child.name: child.alive for child in self._children}

    # ---- subprocess management -------------------------------------------
    def _launch(self, name: str, argv: Sequence[str]) -> bool:
        child = _Child(name, argv)
        try:
            child.spawn()
        except Exception:
            log.exception("could not spawn %s", name)
            return False
        self._children.append(child)
        return True

    def _teardown(self) -> None:
        while self._children:
            self._children.pop().shutdown()

    def _mediamtx_argv(self) -> List[str]:
        argv = [self.config.mediamtx_bin]
        config_path = self.config.resolved_mediamtx_config()
        if config_path:
            argv.append(config_path)
        return argv

    def _gst_argv(self) -> List[str]:
        return [self.config.gst_bin, "-q", *build_gst_pipeline(self.config)]


# ---------------------------------------------------------------------------
# GStreamer pipeline construction
# ---------------------------------------------------------------------------

def _join(stages: Sequence[Sequence[str]]) -> List[str]:
    """Splice element stages together with the ``!`` separator gst expects."""
    argv: List[str] = []
    for index, stage in enumerate(stages):
        if index:
            argv.append("!")
        argv.extend(stage)
    return argv


def _software_encoder(cfg: StreamConfig) -> List[List[str]]:
    """x264 stages shared by every non-Jetson source."""
    caps = f"video/x-raw,width={cfg.width},height={cfg.height},framerate={cfg.fps}/1"
    return [
        ["videoconvert"],
        ["videoscale"],
        [caps],
        [
            "x264enc", "tune=zerolatency", "speed-preset=ultrafast",
            f"bitrate={cfg.bitrate_kbps}", "key-int-max=15",
        ],
    ]


def _rtsp_sink(cfg: StreamConfig) -> List[List[str]]:
    """Parse + push into mediamtx."""
    return [
        ["h264parse"],
        ["rtspclientsink", f"location={cfg.rtsp_url}", "latency=0"],
    ]


def build_gst_pipeline(cfg: StreamConfig) -> List[str]:
    """Build the GStreamer pipeline (as argv tokens) for the configured source.

    Encodes H.264 with low-latency tuning and pushes to mediamtx over RTSP via
    ``rtspclientsink``. Uses the Jetson hardware encoder for the CSI path and a
    portable software encoder for V4L2/file fallbacks.
    """
    if cfg.source == "csi":
        # Jetson CSI: nvarguscamerasrc -> NVENC H.264 (hardware), staying in
        # NVMM memory until the encoder so nothing round-trips through the CPU.
        bitrate_bps = max(200_000, cfg.bitrate_kbps * 1000)
        stages = [
            ["nvarguscamerasrc"],
            [
                f"video/x-raw(memory:NVMM),width={cfg.width},height={cfg.height},"
                f"framerate={cfg.fps}/1"
            ],
            ["nvvidconv"],
            [
                "nvv4l2h264enc",
                f"bitrate={bitrate_bps}", "insert-sps-pps=true",
                "iframeinterval=15", "maxperf-enable=true",
            ],
        ]
    elif cfg.source == "file":
        # Loop a local file (handy for bench testing without a camera).
        stages = [
            ["filesrc", f"location={cfg.file}"],
            ["decodebin"],
            *_software_encoder(cfg),
        ]
    else:
        # Default: V4L2 USB camera -> software x264 (portable fallback).
        stages = [
            ["v4l2src", f"device={cfg.device}"],
            *_software_encoder(cfg),
        ]

    return _join([*stages, *_rtsp_sink(cfg)])


__all__ = ["VideoStream", "StreamConfig", "build_gst_pipeline", "STREAM_PATH"]
