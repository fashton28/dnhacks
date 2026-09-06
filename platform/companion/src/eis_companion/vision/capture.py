"""
============================================================================
Drone Safety Platform -- Video capture (Capture)
----------------------------------------------------------------------------
One façade (``Capture``) in front of a family of interchangeable *frame
sources*.  The façade owns nothing but settings and lifecycle state; each
backend owns exactly one way of getting pixels:

    cap = Capture(config)               # dict of settings, or keyword args
    cap.open()
    ok, frame = cap.read()              # HxWx3 uint8 BGR ndarray, or None
    cap.release()

Backends (selected by ``source``)
  'csi'  -- Jetson CSI camera through the nvarguscamerasrc GStreamer pipeline
            built by :func:`_csi_pipeline`.  Needs a cv2 built with GStreamer
            support (standard on JetPack).
  'v4l2' -- USB / V4L2 camera through ``cv2.VideoCapture(index_or_path)``.
  'file' -- Video file (bench testing / replay).  The file's own geometry
            wins, and is published back through ``Capture.width/height``.
  'mock' -- Synthetic scene rendered by ``SimTargetSource``; no camera, and
  'sim'     no OpenCV, so the SITL/dev box works unmodified.

Settings (accepted either as a mapping or as keyword arguments; every one is
optional and falls back to the default shown)
  source    str      'csi' | 'v4l2' | 'file' | 'mock' | 'sim'   ('csi')
  width     int      requested frame width  in pixels           (1280)
  height    int      requested frame height in pixels           (720)
  fps       int      requested framerate                        (30)
  device    int|str  v4l2 device index or node path             (0)
  file_path str      path for 'file' mode ('file' is an alias)  ('')
  flip      int      nvarguscamerasrc flip-method, 0=none 2=180 (0)
  sensor_id int      CSI sensor index                           (0)

An unrecognised setting raises ``TypeError`` rather than being ignored: a
silently-dropped knob is a camera that runs with the wrong geometry and no
evidence of why.

CSI pipeline (low-latency 720p), assembled stage-by-stage below::

  nvarguscamerasrc sensor-id=0 !
    video/x-raw(memory:NVMM),width=1280,height=720,framerate=30/1,format=NV12 !
    nvvidconv flip-method=0 !
    video/x-raw,width=1280,height=720,format=BGRx !
    videoconvert !
    video/x-raw,format=BGR !
    appsink drop=1 max-buffers=1

``drop=1 max-buffers=1`` keeps the appsink at the live edge: a slow consumer
loses frames instead of accumulating latency behind a growing queue.  For
1080p raise width/height in BOTH the sensor caps and the nvvidconv caps.  A
cv2 without GStreamer support cannot open this pipeline at all -- install
``python3-opencv`` from the JetPack apt overlay, or rebuild cv2 with
``-DWITH_GSTREAMER=ON``.
============================================================================
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, fields, replace
from typing import Any, Mapping, Optional, Tuple

import numpy as np

log = logging.getLogger(__name__)

# OpenCV is a hardware-side optional dependency: the synthetic backend must
# stay importable and usable on a box that has never seen a camera.
try:
    import cv2  # type: ignore
    _CV2_AVAILABLE = True
except ImportError:  # pragma: no cover - exercised on Jetson/CI with cv2
    cv2 = None  # type: ignore
    _CV2_AVAILABLE = False


#: ``(ok, frame)`` -- the pair every backend and ``Capture.read()`` returns.
ReadResult = Tuple[bool, Optional[np.ndarray]]

#: Sources served by the synthetic renderer instead of a real device.
SYNTHETIC_SOURCES = frozenset({"mock", "sim"})

DEFAULT_SOURCE = "csi"

# Settings whose spelling differs between the YAML config (``file``) and this
# module's historical key (``file_path``).  Both are accepted.
_SETTING_ALIASES = {"file": "file_path", "flip_method": "flip"}


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class CaptureSettings:
    """Normalised, validated capture settings.

    Immutable so a backend cannot quietly retune the façade underneath the
    caller; ``Capture`` publishes a *new* instance when a backend reports
    different real geometry (the 'file' source does).
    """

    source: str = DEFAULT_SOURCE
    width: int = 1280
    height: int = 720
    fps: int = 30
    device: Any = 0
    file_path: str = ""
    flip: int = 0
    sensor_id: int = 0

    @classmethod
    def resolve(
        cls,
        config: Optional[Mapping[str, Any]] = None,
        **overrides: Any,
    ) -> "CaptureSettings":
        """Merge a settings mapping with keyword overrides.

        ``None`` values are treated as "not supplied" so a caller can forward
        optional config fields without special-casing each one.
        """
        merged: dict[str, Any] = {}
        for layer in (config or {}, overrides):
            for key, value in layer.items():
                if value is None:
                    continue
                merged[_SETTING_ALIASES.get(key, key)] = value

        known = {f.name for f in fields(cls)}
        unknown = sorted(set(merged) - known)
        if unknown:
            raise TypeError(
                f"unknown capture setting(s): {', '.join(unknown)}; "
                f"known settings are {', '.join(sorted(known))}"
            )

        return cls(
            source=str(merged.get("source", DEFAULT_SOURCE)).strip().lower(),
            width=int(merged.get("width", 1280)),
            height=int(merged.get("height", 720)),
            fps=int(merged.get("fps", 30)),
            device=merged.get("device", 0),
            file_path=str(merged.get("file_path", "")),
            flip=int(merged.get("flip", 0)),
            sensor_id=int(merged.get("sensor_id", 0)),
        )

    @property
    def frame_size(self) -> Tuple[int, int]:
        """``(width, height)`` in pixels."""
        return self.width, self.height


def _csi_pipeline(settings: CaptureSettings) -> str:
    """Assemble the nvarguscamerasrc -> appsink pipeline for *settings*.

    Built as an ordered list of stages so the caps negotiated at each hop are
    readable next to the element that needs them.
    """
    stages = [
        f"nvarguscamerasrc sensor-id={settings.sensor_id}",
        (
            f"video/x-raw(memory:NVMM),width={settings.width},"
            f"height={settings.height},framerate={settings.fps}/1,format=NV12"
        ),
        f"nvvidconv flip-method={settings.flip}",
        f"video/x-raw,width={settings.width},height={settings.height},format=BGRx",
        "videoconvert",
        "video/x-raw,format=BGR",
        "appsink drop=1 max-buffers=1",
    ]
    return " ! ".join(stages)


# ---------------------------------------------------------------------------
# Frame sources
# ---------------------------------------------------------------------------

class _FrameSource:
    """One way of producing frames.  Subclasses implement three methods."""

    #: Whether this backend needs OpenCV to be importable.
    needs_cv2 = True
    #: Human label used in log lines.
    label = "frame source"

    def __init__(self, settings: CaptureSettings, sim_source: Any = None) -> None:
        self.settings = settings
        self._sim_source = sim_source
        #: Geometry the backend actually delivers; may differ from the request.
        self.frame_size: Tuple[int, int] = settings.frame_size

    def open(self) -> bool:
        raise NotImplementedError

    def read(self) -> ReadResult:
        raise NotImplementedError

    def close(self) -> None:
        """Release any device handle.  Must never raise."""


class _CvFrameSource(_FrameSource):
    """Shared plumbing for every backend that ends in a ``cv2.VideoCapture``."""

    def __init__(self, settings: CaptureSettings, sim_source: Any = None) -> None:
        super().__init__(settings, sim_source)
        self._handle: Any = None

    # -- subclass hooks ------------------------------------------------
    def _acquire(self) -> Any:
        """Return an opened ``cv2.VideoCapture`` (or one that failed to open)."""
        raise NotImplementedError

    def _configure(self, handle: Any) -> None:
        """Post-open tuning; the default does nothing."""

    def _failure_hint(self) -> str:
        return "check the device path/permissions"

    # -- _FrameSource --------------------------------------------------
    def open(self) -> bool:
        handle = self._acquire()
        if handle is None or not handle.isOpened():
            log.error("failed to open %s -- %s", self.label, self._failure_hint())
            if handle is not None:
                try:
                    handle.release()
                except Exception:
                    pass
            return False
        self._configure(handle)
        self._handle = handle
        log.info(
            "%s opened (%dx%d @ %d fps).",
            self.label, self.frame_size[0], self.frame_size[1], self.settings.fps,
        )
        return True

    def read(self) -> ReadResult:
        if self._handle is None:
            return False, None
        ok, frame = self._handle.read()
        if not ok or frame is None:
            return False, None
        want_w, want_h = self.frame_size
        if frame.shape[1] != want_w or frame.shape[0] != want_h:
            frame = cv2.resize(frame, (want_w, want_h))
        return True, frame

    def close(self) -> None:
        if self._handle is None:
            return
        try:
            self._handle.release()
        except Exception:
            pass
        self._handle = None


class _CsiFrameSource(_CvFrameSource):
    """Jetson CSI camera driven through a GStreamer appsink."""

    label = "CSI camera"

    def _acquire(self) -> Any:
        pipeline = _csi_pipeline(self.settings)
        log.info("opening CSI camera with GStreamer pipeline:\n  %s", pipeline)
        return cv2.VideoCapture(pipeline, cv2.CAP_GSTREAMER)

    def _failure_hint(self) -> str:
        return (
            "the JetPack GStreamer plugins must be installed, cv2 must be "
            "built with GStreamer support, and the ribbon cable must be seated"
        )


class _V4l2FrameSource(_CvFrameSource):
    """USB / V4L2 camera addressed by index or device node."""

    label = "V4L2 camera"

    def _device(self) -> Any:
        device = self.settings.device
        if isinstance(device, str) and device.isdigit():
            return int(device)
        return device

    def _acquire(self) -> Any:
        device = self._device()
        log.info("opening V4L2 device: %s", device)
        return cv2.VideoCapture(device)

    def _configure(self, handle: Any) -> None:
        cfg = self.settings
        handle.set(cv2.CAP_PROP_FRAME_WIDTH, cfg.width)
        handle.set(cv2.CAP_PROP_FRAME_HEIGHT, cfg.height)
        handle.set(cv2.CAP_PROP_FPS, cfg.fps)

    def _failure_hint(self) -> str:
        return f"device {self._device()!r} did not open"


class _FileFrameSource(_CvFrameSource):
    """Video file playback -- the file's own geometry wins."""

    label = "video file"

    def _acquire(self) -> Any:
        path = self.settings.file_path
        if not path:
            log.error("capture source is 'file' but no file_path was provided.")
            return None
        log.info("opening video file: %s", path)
        return cv2.VideoCapture(path)

    def _configure(self, handle: Any) -> None:
        width = int(handle.get(cv2.CAP_PROP_FRAME_WIDTH)) or self.frame_size[0]
        height = int(handle.get(cv2.CAP_PROP_FRAME_HEIGHT)) or self.frame_size[1]
        # Publish the real geometry so read() stops resizing and the caller's
        # normalised bboxes map back onto the right pixel grid.
        self.frame_size = (width, height)

    def _failure_hint(self) -> str:
        return f"{self.settings.file_path!r} is missing or not decodable"


class _SyntheticFrameSource(_FrameSource):
    """Frames rendered by ``SimTargetSource`` -- no camera, no OpenCV."""

    needs_cv2 = False
    label = "synthetic scene"

    def open(self) -> bool:
        if self._sim_source is None:
            # Imported here so the module stays importable when numpy-only
            # consumers never touch the synthetic path.
            from .sim_source import SimTargetSource

            width, height = self.frame_size
            self._sim_source = SimTargetSource(
                frame_width=width, frame_height=height,
            )
        log.info(
            "%s opened (%dx%d).", self.label, self.frame_size[0], self.frame_size[1],
        )
        return True

    def read(self) -> ReadResult:
        if self._sim_source is None:
            return False, None
        return True, self._sim_source.render_frame()

    @property
    def sim_source(self) -> Any:
        return self._sim_source


#: source name -> backend class.  ``Capture.open()`` is a table lookup, so a
#: new source is one entry plus one class.
_BACKENDS: dict[str, type[_FrameSource]] = {
    "csi": _CsiFrameSource,
    "v4l2": _V4l2FrameSource,
    "file": _FileFrameSource,
    **{name: _SyntheticFrameSource for name in SYNTHETIC_SOURCES},
}


# ---------------------------------------------------------------------------
# Capture
# ---------------------------------------------------------------------------

class Capture:
    """Unified video frame source.

    Parameters
    ----------
    config:
        Mapping of capture settings (see the module docstring).  Optional --
        every setting can equally be passed as a keyword argument, which is
        how the orchestrator constructs it.
    sim_source:
        A pre-built ``SimTargetSource`` for 'mock'/'sim' mode.  When *None*
        one is created on ``open()``.
    **overrides:
        Individual settings; they win over the same key in *config*.
    """

    def __init__(
        self,
        config: Optional[Mapping[str, Any]] = None,
        sim_source: Any = None,
        **overrides: Any,
    ) -> None:
        self._settings = CaptureSettings.resolve(config, **overrides)
        self._sim_source = sim_source
        self._backend: Optional[_FrameSource] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def open(self) -> bool:
        """Open the configured source.  Returns True on success."""
        if self._backend is not None:
            return True

        name = self._settings.source
        factory = _BACKENDS.get(name)
        if factory is None:
            log.error(
                "unknown capture source %r; known sources: %s",
                name, ", ".join(sorted(_BACKENDS)),
            )
            return False
        if factory.needs_cv2 and not _CV2_AVAILABLE:
            log.error("cv2 is not installed; cannot open '%s' source.", name)
            return False

        backend = factory(self._settings, sim_source=self._sim_source)
        try:
            opened = backend.open()
        except Exception:
            log.exception("capture backend %r raised while opening", name)
            opened = False
        if not opened:
            backend.close()
            return False

        # Adopt whatever geometry the backend actually delivers.
        width, height = backend.frame_size
        self._settings = replace(self._settings, width=width, height=height)
        self._backend = backend
        return True

    def release(self) -> None:
        """Release the underlying device.  Safe to call repeatedly."""
        if self._backend is not None:
            self._backend.close()
            self._backend = None
        log.debug("capture released (source=%s)", self._settings.source)

    def is_opened(self) -> bool:
        """True once :meth:`open` has succeeded and before :meth:`release`."""
        return self._backend is not None

    # ------------------------------------------------------------------
    # Frame read
    # ------------------------------------------------------------------

    def read(self) -> ReadResult:
        """Read the next frame.

        Returns
        -------
        (ok, frame)
            ``ok`` is True only when ``frame`` is a usable HxWx3 uint8 BGR
            array.  A failure returns ``(False, None)`` -- never a blank
            frame, because the orchestrator treats a failed read as "no
            observation" and a blank frame as a real one.
        """
        backend = self._backend
        if backend is None:
            return False, None
        try:
            ok, frame = backend.read()
        except Exception:
            log.exception("capture backend %r raised while reading", self._settings.source)
            return False, None
        if not ok or frame is None:
            log.warning(
                "Capture.read(): failed to read frame (source=%s)",
                self._settings.source,
            )
            return False, None
        return True, frame

    # ------------------------------------------------------------------
    # Accessors
    # ------------------------------------------------------------------

    @property
    def settings(self) -> CaptureSettings:
        """The resolved settings, including any geometry the source imposed."""
        return self._settings

    @property
    def width(self) -> int:
        return self._settings.width

    @property
    def height(self) -> int:
        return self._settings.height

    @property
    def fps(self) -> int:
        return self._settings.fps

    @property
    def source(self) -> str:
        return self._settings.source

    # ------------------------------------------------------------------
    # Context manager
    # ------------------------------------------------------------------

    def __enter__(self) -> "Capture":
        self.open()
        return self

    def __exit__(self, *_: Any) -> None:
        self.release()


__all__ = ["Capture", "CaptureSettings", "ReadResult", "SYNTHETIC_SOURCES"]
