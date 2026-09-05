"""
============================================================================
Eye in the Sky -- Video capture (Capture)
----------------------------------------------------------------------------
Wraps camera / video-file / simulated sources behind a unified interface:

    cap = Capture(config)
    cap.open()
    ok, frame = cap.read()   # frame is a HxWx3 uint8 BGR numpy array, or None
    cap.release()

Supported modes (config['source']):
  'csi'  -- Jetson CSI camera via nvarguscamerasrc GStreamer pipeline.
            Requires cv2 built with GStreamer support (standard on JetPack).
            Low-latency 720p pipeline documented below.
  'v4l2' -- USB/V4L2 camera via cv2.VideoCapture(device_index_or_path).
  'file' -- Video file (development / replay).
  'mock' -- Delegates to SimTargetSource; no real camera needed.
  'sim'  -- Alias for 'mock'.

Config dict keys (all optional, with sensible defaults):
  source    str   'csi' | 'v4l2' | 'file' | 'mock' | 'sim'  (default 'csi')
  width     int   frame width  in pixels (default 1280)
  height    int   frame height in pixels (default 720)
  fps       int   requested framerate   (default 30)
  device    int|str  v4l2 device index or path (default 0)
  file_path str   path for 'file' mode
  flip      int   nvarguscamerasrc flip-method 0=none,2=180° (default 0)

GStreamer pipeline (CSI / nvarguscamerasrc, low-latency 720p):
  nvarguscamerasrc sensor-id=0 !
    video/x-raw(memory:NVMM),width=1280,height=720,framerate=30/1,format=NV12 !
    nvvidconv flip-method=0 !
    video/x-raw,width=1280,height=720,format=BGRx !
    videoconvert !
    video/x-raw,format=BGR !
    appsink drop=1 max-buffers=1

Notes:
  * ``drop=1 max-buffers=1`` keeps the pipeline live; we always get the
    most-recent frame rather than a growing buffer queue.
  * For 1080p, change the width/height in both the sensor and the nvvidconv
    stages.
  * If GStreamer support is absent from your cv2 build you will get a broken
    capture (ok=False every read); install ``python3-opencv`` from the
    JetPack apt overlay or build cv2 with ``-DWITH_GSTREAMER=ON``.
============================================================================
"""
from __future__ import annotations

import logging
from typing import Any, Optional, Tuple

import numpy as np

log = logging.getLogger(__name__)

# cv2 is hardware-optional; sim/mock mode must work without it.
try:
    import cv2  # type: ignore
    _CV2_AVAILABLE = True
except ImportError:
    cv2 = None  # type: ignore
    _CV2_AVAILABLE = False


# ---------------------------------------------------------------------------
# GStreamer pipeline builder
# ---------------------------------------------------------------------------

def _gstreamer_pipeline(
    width: int,
    height: int,
    fps: int,
    sensor_id: int = 0,
    flip_method: int = 0,
) -> str:
    """Return the low-latency nvarguscamerasrc GStreamer pipeline string.

    This pipeline is optimised for the Jetson Orin Nano + IMX219 (or compatible
    CSI camera).  ``drop=1 max-buffers=1`` in the appsink ensures we always
    consume the freshest frame and never accumulate latency behind a slow
    consumer.
    """
    return (
        f"nvarguscamerasrc sensor-id={sensor_id} ! "
        f"video/x-raw(memory:NVMM),width={width},height={height},"
        f"framerate={fps}/1,format=NV12 ! "
        f"nvvidconv flip-method={flip_method} ! "
        f"video/x-raw,width={width},height={height},format=BGRx ! "
        "videoconvert ! "
        "video/x-raw,format=BGR ! "
        "appsink drop=1 max-buffers=1"
    )


# ---------------------------------------------------------------------------
# Capture
# ---------------------------------------------------------------------------

class Capture:
    """Unified video frame source.

    Parameters
    ----------
    config:
        Dictionary with capture settings (see module docstring for keys).
    sim_source:
        Optional pre-created :class:`~eis_companion.vision.sim_source.SimTargetSource`
        instance to use in 'mock'/'sim' mode.  If *None*, one is created
        automatically when the mode is 'mock' or 'sim'.
    """

    def __init__(
        self,
        config: Optional[dict[str, Any]] = None,
        sim_source: Any = None,
    ) -> None:
        cfg = config or {}
        self._source: str = str(cfg.get("source", "csi")).lower()
        self._width: int = int(cfg.get("width", 1280))
        self._height: int = int(cfg.get("height", 720))
        self._fps: int = int(cfg.get("fps", 30))
        self._device: Any = cfg.get("device", 0)
        self._file_path: str = str(cfg.get("file_path", ""))
        self._flip: int = int(cfg.get("flip", 0))
        self._sensor_id: int = int(cfg.get("sensor_id", 0))

        self._cap: Any = None           # cv2.VideoCapture
        self._sim: Any = sim_source     # SimTargetSource (lazy-created)
        self._opened: bool = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def open(self) -> bool:
        """Open the video source.  Returns True on success."""
        if self._source in ("mock", "sim"):
            return self._open_sim()
        if not _CV2_AVAILABLE:
            log.error("cv2 is not installed; cannot open '%s' source.", self._source)
            return False
        if self._source == "csi":
            return self._open_csi()
        if self._source == "v4l2":
            return self._open_v4l2()
        if self._source == "file":
            return self._open_file()
        log.error("Unknown capture source: '%s'", self._source)
        return False

    def release(self) -> None:
        """Release the underlying capture device."""
        if self._cap is not None:
            try:
                self._cap.release()
            except Exception:
                pass
            self._cap = None
        self._opened = False
        log.debug("Capture released (source=%s)", self._source)

    def is_opened(self) -> bool:
        """True if the source has been successfully opened."""
        return self._opened

    # ------------------------------------------------------------------
    # Frame read
    # ------------------------------------------------------------------

    def read(self) -> Tuple[bool, Optional[np.ndarray]]:
        """Read the next frame.

        Returns
        -------
        (ok, frame)
            ok    -- True if a valid frame was returned.
            frame -- HxWx3 uint8 BGR numpy array, or None on failure.
        """
        if not self._opened:
            return False, None

        if self._source in ("mock", "sim"):
            return self._read_sim()

        if self._cap is None:
            return False, None

        ok, frame = self._cap.read()
        if not ok or frame is None:
            log.warning("Capture.read(): failed to read frame (source=%s)", self._source)
            return False, None

        # Resize if the actual frame doesn't match requested size (file mode).
        if frame.shape[1] != self._width or frame.shape[0] != self._height:
            frame = cv2.resize(frame, (self._width, self._height))

        return True, frame

    # ------------------------------------------------------------------
    # Accessors
    # ------------------------------------------------------------------

    @property
    def width(self) -> int:
        return self._width

    @property
    def height(self) -> int:
        return self._height

    @property
    def fps(self) -> int:
        return self._fps

    @property
    def source(self) -> str:
        return self._source

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _open_csi(self) -> bool:
        pipeline = _gstreamer_pipeline(
            self._width, self._height, self._fps,
            sensor_id=self._sensor_id,
            flip_method=self._flip,
        )
        log.info("Opening CSI camera with GStreamer pipeline:\n  %s", pipeline)
        cap = cv2.VideoCapture(pipeline, cv2.CAP_GSTREAMER)
        if not cap.isOpened():
            log.error(
                "Failed to open CSI camera via GStreamer. "
                "Ensure JetPack GStreamer plugins are installed and the "
                "camera ribbon cable is seated."
            )
            return False
        self._cap = cap
        self._opened = True
        log.info("CSI camera opened (%dx%d @ %d fps).", self._width, self._height, self._fps)
        return True

    def _open_v4l2(self) -> bool:
        device = self._device
        if isinstance(device, str) and device.isdigit():
            device = int(device)
        log.info("Opening V4L2 device: %s", device)
        cap = cv2.VideoCapture(device)
        if not cap.isOpened():
            log.error("Failed to open V4L2 device: %s", device)
            return False
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self._width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self._height)
        cap.set(cv2.CAP_PROP_FPS, self._fps)
        self._cap = cap
        self._opened = True
        log.info(
            "V4L2 device %s opened (%dx%d @ %d fps).",
            device, self._width, self._height, self._fps,
        )
        return True

    def _open_file(self) -> bool:
        if not self._file_path:
            log.error("Capture source is 'file' but no file_path was provided.")
            return False
        log.info("Opening video file: %s", self._file_path)
        cap = cv2.VideoCapture(self._file_path)
        if not cap.isOpened():
            log.error("Failed to open video file: %s", self._file_path)
            return False
        # Read actual dimensions from the file.
        self._width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or self._width
        self._height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or self._height
        self._cap = cap
        self._opened = True
        log.info("Video file opened (%dx%d).", self._width, self._height)
        return True

    def _open_sim(self) -> bool:
        if self._sim is None:
            from .sim_source import SimTargetSource
            self._sim = SimTargetSource(
                frame_width=self._width,
                frame_height=self._height,
            )
        self._opened = True
        log.info(
            "Capture opened in sim/mock mode (%dx%d).",
            self._width, self._height,
        )
        return True

    def _read_sim(self) -> Tuple[bool, Optional[np.ndarray]]:
        """Return a synthetic BGR frame from the SimTargetSource."""
        frame = self._sim.render_frame()
        return True, frame

    # ------------------------------------------------------------------
    # Context manager support
    # ------------------------------------------------------------------

    def __enter__(self) -> "Capture":
        self.open()
        return self

    def __exit__(self, *_: Any) -> None:
        self.release()
