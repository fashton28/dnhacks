"""
============================================================================
Eye in the Sky -- Simulated target source (SimTargetSource)
----------------------------------------------------------------------------
Produces synthetic person detections (1–2 people moving around the frame)
WITHOUT a physical camera.  Used by:

  * ``Capture`` when source='mock'/'sim'  (supplies rendered BGR frames)
  * ``sim/`` end-to-end tests             (supplies raw TargetObservation lists)

This lets the full guidance + tracking stack run against SITL with no
hardware at all.  Motion is deterministic/seedable so tests are reproducible.

Design notes
------------
Each simulated person is an independent 2-D bouncing "puck" whose position is
driven by a sine wave in x and a different-frequency sine wave in y so that
the paths are varied but never truly random.  A seed parameter makes the
initial phase offsets reproducible.  The "frame" is normalised 0..1 for
TargetObservation bboxes.

Synthetic person parameters:
  * bbox height ~0.40 of frame height  (person takes up ~40 % of frame height
    when at standoff -- generous so guidance has a clear signal)
  * bbox aspect ratio 0.40 (person width / height, typical portrait-view)
  * slow oscillation: ~0.05–0.15 normalised units per second so the drone
    has a meaningful tracking target

API
---
::

    src = SimTargetSource(num_targets=2, seed=42)
    # --- per-frame usage ---
    obs: list[TargetObservation] = src.get_observations()
    frame: np.ndarray             = src.render_frame()   # BGR HxWx3 uint8

Both calls advance the internal time by 1/fps seconds (default 30 fps).
Call ``advance(dt)`` to use a wall-clock time step instead.
============================================================================
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from eis_companion.types import TargetObservation


# ---------------------------------------------------------------------------
# Internal simulated person state
# ---------------------------------------------------------------------------

@dataclass
class _SimPerson:
    """State of one synthetic person in the simulated scene."""
    # Centre position in normalised frame coords [0..1]
    cx: float
    cy: float
    # Amplitude and frequency of the Lissajous oscillation
    ax: float   # x amplitude  (normalised)
    ay: float   # y amplitude  (normalised)
    fx: float   # x frequency  (Hz)
    fy: float   # y frequency  (Hz)
    px: float   # x phase      (radians)
    py: float   # y phase      (radians)
    # Bounding-box dimensions in normalised coords (constant for simplicity)
    bw: float = 0.16   # bbox width
    bh: float = 0.40   # bbox height
    # Person appearance: BGR colour for the rectangle fill
    colour: tuple = (80, 160, 80)

    def position_at(self, t: float) -> tuple[float, float]:
        """Return (cx, cy) at time *t* (seconds since epoch of this source)."""
        cx = self.cx + self.ax * math.sin(2 * math.pi * self.fx * t + self.px)
        cy = self.cy + self.ay * math.sin(2 * math.pi * self.fy * t + self.py)
        # Clamp so the person stays fully inside the frame
        cx = max(self.bw / 2.0 + 0.01, min(1.0 - self.bw / 2.0 - 0.01, cx))
        cy = max(self.bh / 2.0 + 0.01, min(1.0 - self.bh / 2.0 - 0.01, cy))
        return cx, cy

    def bbox_at(self, t: float) -> tuple[float, float, float, float]:
        """Return (x, y, w, h) normalised bbox at time *t*.

        x, y is the top-left corner of the bounding box.
        """
        cx, cy = self.position_at(t)
        x = cx - self.bw / 2.0
        y = cy - self.bh / 2.0
        return x, y, self.bw, self.bh


# ---------------------------------------------------------------------------
# SimTargetSource
# ---------------------------------------------------------------------------

_PERSON_COLOURS = [
    (60, 140, 220),   # warm orange-ish (BGR)
    (220, 80, 60),    # blue-ish (BGR)
]


class SimTargetSource:
    """Synthetic person detection source -- no camera required.

    Parameters
    ----------
    num_targets:
        1 or 2 synthetic persons.  Default 2.
    seed:
        RNG seed for reproducible motion phase offsets.  Default 42.
    frame_width, frame_height:
        Pixel dimensions of the optional rendered frame.  Default 1280×720.
    fps:
        Frames per second used by ``get_observations()`` / ``render_frame()``
        to advance internal time.  Default 30.
    base_confidence:
        Simulated detector confidence (fixed per detection).  Default 0.92.
    """

    def __init__(
        self,
        num_targets: int = 2,
        seed: int = 42,
        frame_width: int = 1280,
        frame_height: int = 720,
        fps: float = 30.0,
        base_confidence: float = 0.92,
    ) -> None:
        if num_targets < 1 or num_targets > 2:
            raise ValueError("SimTargetSource supports 1 or 2 targets.")

        self._frame_width = frame_width
        self._frame_height = frame_height
        self._fps = fps
        self._dt = 1.0 / max(fps, 1.0)
        self._base_conf = float(base_confidence)
        self._t: float = 0.0           # internal simulation time (seconds)

        # Build deterministic persons from seed
        rng = np.random.default_rng(seed)

        def _rand(lo: float, hi: float) -> float:
            return float(rng.uniform(lo, hi))

        persons_cfg = [
            # Person 0 -- starts left-of-centre, moderate motion
            dict(
                cx=_rand(0.25, 0.40), cy=_rand(0.40, 0.60),
                ax=_rand(0.10, 0.18), ay=_rand(0.05, 0.10),
                fx=_rand(0.06, 0.12), fy=_rand(0.04, 0.09),
                px=_rand(0.0, 2 * math.pi), py=_rand(0.0, 2 * math.pi),
                colour=_PERSON_COLOURS[0],
            ),
            # Person 1 -- starts right-of-centre, slightly different cadence
            dict(
                cx=_rand(0.60, 0.75), cy=_rand(0.35, 0.55),
                ax=_rand(0.08, 0.15), ay=_rand(0.06, 0.12),
                fx=_rand(0.05, 0.10), fy=_rand(0.07, 0.13),
                px=_rand(0.0, 2 * math.pi), py=_rand(0.0, 2 * math.pi),
                colour=_PERSON_COLOURS[1],
            ),
        ]

        self._persons: list[_SimPerson] = [
            _SimPerson(**persons_cfg[i]) for i in range(num_targets)
        ]

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def advance(self, dt: float) -> None:
        """Advance internal time by *dt* seconds (use for wall-clock stepping)."""
        self._t += dt

    def get_observations(self) -> list[TargetObservation]:
        """Return a list of TargetObservation for the *current* simulation time.

        Also advances internal time by 1/fps seconds.  Call ``advance(dt)``
        instead if you are driving from a real clock.
        """
        ts = time.time()
        obs: list[TargetObservation] = []
        for person in self._persons:
            bbox = person.bbox_at(self._t)
            # Add a tiny jitter to confidence to make it feel live
            conf = min(1.0, max(0.5, self._base_conf + float(
                math.sin(self._t * 7.3 + id(person) % 10) * 0.02
            )))
            obs.append(TargetObservation(bbox=bbox, conf=conf, ts=ts))
        self._t += self._dt
        return obs

    def observe(self) -> list[TargetObservation]:
        """Perception-loop interface the orchestrator expects
        (``source.observe() -> [TargetObservation]``). Alias of
        :meth:`get_observations`."""
        return self.get_observations()

    def render_frame(self) -> np.ndarray:
        """Render a synthetic BGR frame showing the simulated persons.

        Returns a HxWx3 uint8 numpy array that Capture can forward to the
        detector / stream / overlay pipeline.

        The frame is:
          * A dark grey background (sky / indoor wall analogue).
          * Each simulated person drawn as a coloured filled rectangle with a
            white border (representing a "person silhouette" placeholder).
          * A small timestamp burn-in in the corner.
        """
        frame = np.full(
            (self._frame_height, self._frame_width, 3),
            fill_value=40,   # dark grey
            dtype=np.uint8,
        )

        for person in self._persons:
            bx, by, bw, bh = person.bbox_at(self._t)
            # Convert normalised to pixel coords
            px1 = int(bx * self._frame_width)
            py1 = int(by * self._frame_height)
            px2 = int((bx + bw) * self._frame_width)
            py2 = int((by + bh) * self._frame_height)
            px1, py1 = max(0, px1), max(0, py1)
            px2 = min(self._frame_width - 1, px2)
            py2 = min(self._frame_height - 1, py2)

            # Filled body rectangle
            frame[py1:py2, px1:px2] = person.colour

            # White border (1-pixel line simulation via slicing)
            thickness = 2
            frame[py1:py1 + thickness, px1:px2] = (255, 255, 255)
            frame[py2 - thickness:py2, px1:px2] = (255, 255, 255)
            frame[py1:py2, px1:px1 + thickness] = (255, 255, 255)
            frame[py1:py2, px2 - thickness:px2] = (255, 255, 255)

            # Head circle approximation (top quarter of bbox)
            head_cx = (px1 + px2) // 2
            head_cy = py1 + (py2 - py1) // 6
            head_r = max(4, (px2 - px1) // 3)
            # Draw head as a filled circle using a fast rasterisation trick
            y_idx, x_idx = np.ogrid[0:self._frame_height, 0:self._frame_width]
            mask = (x_idx - head_cx) ** 2 + (y_idx - head_cy) ** 2 <= head_r ** 2
            frame[mask] = (200, 200, 230)

        # Timestamp burn-in (top-left, simple pixel text via numpy -- no cv2 dep)
        self._draw_timestamp(frame)

        # Advance internal time (render_frame and get_observations share the clock)
        self._t += self._dt
        return frame

    @property
    def current_time(self) -> float:
        """Current internal simulation time in seconds."""
        return self._t

    @property
    def num_persons(self) -> int:
        return len(self._persons)

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _draw_timestamp(self, frame: np.ndarray) -> None:
        """Burn a very simple timestamp string into the frame corner.

        We do NOT import cv2 here to keep this module pure-numpy.  Instead
        we draw a tiny white rectangle as a placeholder.  If cv2 is available
        in the final deployment it can be used by the stream overlay.
        """
        # Draw a small white indicator strip at the top-left corner.
        h_strip = 4
        w_strip = int(self._frame_width * (self._t % 1.0))
        w_strip = max(0, min(self._frame_width - 1, w_strip))
        if w_strip > 0:
            frame[0:h_strip, 0:w_strip] = (200, 200, 200)
