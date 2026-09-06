"""
============================================================================
Drone Safety Platform -- Simulated target source (SimTargetSource)
----------------------------------------------------------------------------
Synthetic person detections (1-2 people) with no physical camera.  Two
consumers:

  * ``Capture`` in 'mock'/'sim' mode        -- rendered BGR frames
  * the ``sim/`` acceptance clients          -- raw ``TargetObservation`` lists

Together they let the whole perception -> tracking -> guidance stack fly
against SITL on a laptop.  Everything here is deterministic for a given
``seed`` so a failing acceptance run reproduces exactly.

Motion model
------------
Each person walks a **closed patrol loop**: a ring of waypoints laid out
around a per-person home position, traversed at a constant arc-length rate
with cosine easing into and out of every waypoint (so the corners read as a
turn rather than a teleport), plus a slow vertical sway that stands in for
gait bob.  Nothing is sampled per frame -- position is a pure function of
simulation time, which is what makes replay exact.

Target geometry (kept fixed: the tracker's IoU association and the distance
estimator are both calibrated against it)
  * bbox height  0.40 of frame height  -- a person filling ~40 % of the frame
  * bbox width   0.16 (aspect 0.40)    -- typical portrait-view person
  * patrol speed 0.05-0.15 normalised units/s, so consecutive frames overlap
    heavily and the tracker locks within its ``min_hits``

API
---
::

    src = SimTargetSource(num_targets=2, seed=42)
    obs: list[TargetObservation] = src.get_observations()   # or src.observe()
    frame: np.ndarray             = src.render_frame()      # BGR HxWx3 uint8

``get_observations()`` and ``render_frame()`` share one clock and each advance
it by 1/fps.  Drive from a real clock with ``advance(dt)`` instead.
============================================================================
"""
from __future__ import annotations

import bisect
import math
import random
import time
from dataclasses import dataclass, field

import numpy as np

from eis_companion.types import TargetObservation

# --- fixed target geometry (normalised frame units) ------------------------
BBOX_WIDTH: float = 0.16
BBOX_HEIGHT: float = 0.40

#: Keeps the whole bbox off the frame edge, so a clamped walker is still a
#: complete box rather than a truncated one.
_EDGE_MARGIN: float = 0.01

#: Per-person body colour, BGR (the renderer's palette, not a contract).
_PALETTE: tuple[tuple[int, int, int], ...] = (
    (60, 140, 220),    # warm orange
    (220, 80, 60),     # cool blue
)
_HEAD_COLOUR = (200, 200, 230)
_OUTLINE_COLOUR = (255, 255, 255)
_CLOCK_ON = (120, 220, 120)
_CLOCK_SWEEP = (200, 200, 200)


# ---------------------------------------------------------------------------
# One synthetic person
# ---------------------------------------------------------------------------

@dataclass
class _Walker:
    """A person walking a closed waypoint loop at constant arc-length rate."""

    route: tuple[tuple[float, float], ...]
    speed: float          # normalised units per second along the loop
    offset: float         # arc-length position at t = 0
    sway_amp: float       # vertical gait bob (normalised)
    sway_hz: float        # gait frequency (Hz)
    phase: float          # per-person phase for sway + confidence ripple
    colour: tuple[int, int, int]
    bw: float = BBOX_WIDTH
    bh: float = BBOX_HEIGHT
    # Derived at construction; not constructor arguments.
    _marks: list[float] = field(default_factory=list, init=False, repr=False)
    perimeter: float = field(default=0.0, init=False)

    def __post_init__(self) -> None:
        marks = [0.0]
        count = len(self.route)
        for index in range(count):
            ax, ay = self.route[index]
            bx, by = self.route[(index + 1) % count]
            marks.append(marks[-1] + math.hypot(bx - ax, by - ay))
        self._marks = marks
        self.perimeter = marks[-1]

    # -- geometry -------------------------------------------------------
    def centre_at(self, t: float) -> tuple[float, float]:
        """Centre of the person, normalised, at simulation time *t*."""
        if self.perimeter <= 0.0:
            cx, cy = self.route[0]
        else:
            travelled = (self.offset + self.speed * t) % self.perimeter
            leg = bisect.bisect_right(self._marks, travelled) - 1
            leg = min(max(leg, 0), len(self.route) - 1)
            span = self._marks[leg + 1] - self._marks[leg]
            frac = 0.0 if span <= 0.0 else (travelled - self._marks[leg]) / span
            # Cosine ease: zero rate at each waypoint, peak mid-leg.
            eased = 0.5 - 0.5 * math.cos(math.pi * frac)
            ax, ay = self.route[leg]
            bx, by = self.route[(leg + 1) % len(self.route)]
            cx = ax + (bx - ax) * eased
            cy = ay + (by - ay) * eased
        cy += self.sway_amp * math.sin(2.0 * math.pi * self.sway_hz * t + self.phase)
        return _clamp_centre(cx, cy, self.bw, self.bh)

    def bbox_at(self, t: float) -> tuple[float, float, float, float]:
        """``(x, y, w, h)`` normalised bbox (top-left origin) at time *t*."""
        cx, cy = self.centre_at(t)
        return cx - self.bw / 2.0, cy - self.bh / 2.0, self.bw, self.bh

    # -- detector-facing --------------------------------------------------
    def confidence_at(self, t: float, base: float) -> float:
        """Detector confidence with a small deterministic ripple."""
        ripple = 0.02 * math.sin(7.3 * t + self.phase)
        return min(1.0, max(0.5, base + ripple))


def _clamp_centre(cx: float, cy: float, bw: float, bh: float) -> tuple[float, float]:
    """Hold the whole bbox inside the frame."""
    half_w = bw / 2.0 + _EDGE_MARGIN
    half_h = bh / 2.0 + _EDGE_MARGIN
    return (
        min(max(cx, half_w), 1.0 - half_w),
        min(max(cy, half_h), 1.0 - half_h),
    )


def _patrol_route(
    rng: random.Random,
    home: tuple[float, float],
    radius: tuple[float, float],
    vertices: int,
) -> tuple[tuple[float, float], ...]:
    """Lay *vertices* waypoints on a jittered ellipse around *home*."""
    rx, ry = radius
    route: list[tuple[float, float]] = []
    for index in range(vertices):
        angle = 2.0 * math.pi * index / vertices
        wobble = rng.uniform(0.75, 1.15)
        x = home[0] + rx * wobble * math.cos(angle)
        y = home[1] + ry * wobble * math.sin(angle)
        route.append(_clamp_centre(x, y, BBOX_WIDTH, BBOX_HEIGHT))
    return tuple(route)


def _build_walkers(num_targets: int, seed: int) -> list[_Walker]:
    """Deterministically lay out ``num_targets`` patrol loops."""
    rng = random.Random(seed)
    # Per-person layout: (home box, radius box, waypoint count).
    layouts = (
        ((0.28, 0.40), (0.42, 0.56), (0.10, 0.18), (0.05, 0.10), 5),
        ((0.58, 0.72), (0.38, 0.54), (0.08, 0.15), (0.06, 0.12), 7),
    )
    walkers: list[_Walker] = []
    for index in range(num_targets):
        home_x, home_y, rad_x, rad_y, vertices = layouts[index]
        home = (rng.uniform(*home_x), rng.uniform(*home_y))
        radius = (rng.uniform(*rad_x), rng.uniform(*rad_y))
        route = _patrol_route(rng, home, radius, vertices)
        walker = _Walker(
            route=route,
            speed=rng.uniform(0.05, 0.15),
            offset=rng.uniform(0.0, 1.0),
            sway_amp=rng.uniform(0.004, 0.012),
            sway_hz=rng.uniform(0.8, 1.4),
            phase=rng.uniform(0.0, 2.0 * math.pi),
            colour=_PALETTE[index % len(_PALETTE)],
        )
        # A degenerate loop would park the person; nudge the offset onto the
        # loop so ``offset`` is always a real arc-length position.
        if walker.perimeter > 0.0:
            walker.offset *= walker.perimeter
        walkers.append(walker)
    return walkers


# ---------------------------------------------------------------------------
# SimTargetSource
# ---------------------------------------------------------------------------

class SimTargetSource:
    """Synthetic person detection source -- no camera required.

    Parameters
    ----------
    num_targets:
        1 or 2 synthetic persons.  Default 2.
    seed:
        Seed for the deterministic patrol layout.  Default 42.
    frame_width, frame_height:
        Pixel dimensions of the rendered frame.  Default 1280x720.
    fps:
        Rate at which ``get_observations()`` / ``render_frame()`` advance the
        internal clock.  Default 30.
    base_confidence:
        Centre of the simulated detector confidence.  Default 0.92.
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

        self._frame_width = int(frame_width)
        self._frame_height = int(frame_height)
        self._fps = fps
        self._dt = 1.0 / max(fps, 1.0)
        self._base_conf = float(base_confidence)
        self._t: float = 0.0
        self._walkers = _build_walkers(num_targets, seed)
        self._backdrop: np.ndarray | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def advance(self, dt: float) -> None:
        """Advance the internal clock by *dt* seconds (wall-clock stepping)."""
        self._t += dt

    def get_observations(self) -> list[TargetObservation]:
        """Detections for the current simulation time, then step the clock."""
        ts = time.time()
        now = self._t
        observations = [
            TargetObservation(
                bbox=walker.bbox_at(now),
                conf=walker.confidence_at(now, self._base_conf),
                ts=ts,
            )
            for walker in self._walkers
        ]
        self._t += self._dt
        return observations

    def observe(self) -> list[TargetObservation]:
        """Perception-loop interface (``source.observe() -> [TargetObservation]``).

        Alias of :meth:`get_observations`.
        """
        return self.get_observations()

    def render_frame(self) -> np.ndarray:
        """Render the scene as a HxWx3 uint8 BGR frame, then step the clock.

        The scene is a dark graded backdrop with a horizon line; each person is
        a coloured torso block under a lighter head disc, outlined in white and
        sitting on a darkened ground shadow.  A small clock is burned into the
        top-left corner so a recorded stream can be lined up with a log.
        """
        frame = self._backdrop_template().copy()
        now = self._t
        for walker in self._walkers:
            self._draw_walker(frame, walker, now)
        self._burn_in_clock(frame)
        self._t += self._dt
        return frame

    @property
    def current_time(self) -> float:
        """Current internal simulation time in seconds."""
        return self._t

    @property
    def num_persons(self) -> int:
        return len(self._walkers)

    @property
    def frame_size(self) -> tuple[int, int]:
        """``(width, height)`` of the rendered frame in pixels."""
        return self._frame_width, self._frame_height

    # ------------------------------------------------------------------
    # Rendering
    # ------------------------------------------------------------------

    def _backdrop_template(self) -> np.ndarray:
        """Build (once) the static background every frame is stamped from."""
        if self._backdrop is not None:
            return self._backdrop

        height, width = self._frame_height, self._frame_width
        # Vertical grade: darker overhead, lighter toward the ground.
        grade = np.linspace(26.0, 58.0, height, dtype=np.float32)
        plane = np.repeat(grade[:, None], width, axis=1)
        backdrop = np.stack([plane + 10.0, plane + 4.0, plane], axis=2)
        backdrop = np.clip(backdrop, 0.0, 255.0).astype(np.uint8)

        horizon = int(height * 0.62)
        if 0 <= horizon < height:
            backdrop[horizon:horizon + 2, :] = (90, 84, 74)

        self._backdrop = backdrop
        return backdrop

    def _pixel_box(self, walker: _Walker, t: float) -> tuple[int, int, int, int]:
        """Walker bbox in pixel coords, clipped to the frame."""
        bx, by, bw, bh = walker.bbox_at(t)
        width, height = self._frame_width, self._frame_height
        x0 = max(0, min(width - 1, int(round(bx * width))))
        y0 = max(0, min(height - 1, int(round(by * height))))
        x1 = max(0, min(width, int(round((bx + bw) * width))))
        y1 = max(0, min(height, int(round((by + bh) * height))))
        return x0, y0, x1, y1

    def _draw_walker(self, frame: np.ndarray, walker: _Walker, t: float) -> None:
        x0, y0, x1, y1 = self._pixel_box(walker, t)
        box_w, box_h = x1 - x0, y1 - y0
        if box_w < 4 or box_h < 4:
            return

        # Ground shadow first, so the body draws over its near edge.
        shadow_h = max(2, box_h // 24)
        shadow_y = min(self._frame_height, y1 + shadow_h)
        if shadow_y > y1:
            shadow = frame[y1:shadow_y, x0:x1]
            shadow //= 2

        body = frame[y0:y1, x0:x1]
        head_r = max(2, min(box_w // 3, box_h // 6))

        # Torso block below the head, then the outline, then the head on top.
        body[head_r:, :] = walker.colour
        body[0:2, :] = _OUTLINE_COLOUR
        body[-2:, :] = _OUTLINE_COLOUR
        body[:, 0:2] = _OUTLINE_COLOUR
        body[:, -2:] = _OUTLINE_COLOUR

        head = body[0:2 * head_r, :]
        rows, cols = head.shape[0], head.shape[1]
        y_idx, x_idx = np.ogrid[0:rows, 0:cols]
        disc = (x_idx - cols // 2) ** 2 + (y_idx - head_r) ** 2 <= head_r ** 2
        head[disc] = _HEAD_COLOUR

    def _burn_in_clock(self, frame: np.ndarray) -> None:
        """Burn a pure-numpy clock into the top-left corner (no cv2 needed).

        Ten fixed slots count whole seconds modulo 10; the bar beneath them
        sweeps once per second.  Together they identify any single frame of a
        recording to within a tenth of a second.
        """
        width = self._frame_width
        slot_w = max(2, width // 80)
        gap = max(1, slot_w // 3)
        lit = int(self._t) % 10 + 1
        x = 0
        for index in range(10):
            if x + slot_w > width:
                break
            if index < lit:
                frame[2:5, x:x + slot_w] = _CLOCK_ON
            x += slot_w + gap

        sweep = int(width * (self._t % 1.0))
        sweep = max(0, min(width, sweep))
        if sweep > 0:
            frame[7:9, 0:sweep] = _CLOCK_SWEEP


__all__ = ["SimTargetSource", "BBOX_WIDTH", "BBOX_HEIGHT"]
