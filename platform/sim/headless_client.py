"""
============================================================================
Drone Safety Platform -- headless WebSocket client + acceptance scaffolding
----------------------------------------------------------------------------
``HeadlessClient`` is the Python stand-in for the ground-side TypeScript
``LiveDataProvider``. It speaks the shared control contract
(``shared/shared.py`` == ``ground/ui/src/contract/index.ts``) and NOTHING else:
the acceptance gates (``e2e_test.py``, ``manual_test.py``) import no companion
internals, so what they exercise is exactly the seam the real ground station
exercises.

Contract facts this module implements
-------------------------------------
inbound  (companion -> ground)   telemetry ~10 Hz, tracking ~10 Hz,
                                 statusText, ack
outbound (ground -> companion)   command   (acked, correlated by command NAME,
                                            first-match FIFO -- there is no
                                            requestId on the ack path)
                                 manualInput (HIGH-RATE ~20-50 Hz, NEVER acked
                                            per frame: per-frame acks build
                                            backpressure)
every frame carries ``vehicleId``; the companion drops frames whose vehicleId
is missing or does not match its own.

Command params (contract ``CommandParams``)::

    takeoff      -> {"altitude": meters}     setStandoff -> {"meters": float}
    setMode      -> {"mode": Mode}           setMaxSpeed -> {"mps": float}
    selectTarget -> {"targetId": int}

Structure
---------
``_Stream``   one inbound kind: bounded history + a monotonic sequence number,
              so a reader resumes exactly where it stopped instead of
              rescanning the whole log on every wake-up.
``_Signal``   edge-triggered broadcast used to wake parked readers.
``_AckGate``  per-command FIFO of futures awaiting the next matching ack.
``PhaseMachine`` / ``run_acceptance`` -- the explicit state-machine runner and
              exit-code mapping shared by the two acceptance gates.

Requires the ``websockets`` package (pinned by the companion's packaging).
Usage::

    async with HeadlessClient("ws://127.0.0.1:8765") as c:
        ack = await c.send_command("arm", expect_success=True)
        tel = await c.wait_for_telemetry(lambda t: t.get("armed"))
        async for tr in c.follow("tracking", timeout=10.0):
            ...

============================================================================
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import sys
import time
from collections import deque
from dataclasses import dataclass
from typing import (
    Any,
    AsyncIterator,
    Awaitable,
    Callable,
    Deque,
    Dict,
    List,
    Mapping,
    Optional,
    Sequence,
    Tuple,
)

try:
    import websockets
except Exception as exc:  # pragma: no cover - import-time guard
    raise SystemExit(
        "headless_client requires the 'websockets' package "
        "(pip install websockets). Original error: %r" % (exc,)
    )

try:  # websockets >= 13 moved/renamed the legacy client protocol type.
    from websockets.client import WebSocketClientProtocol as _ClientSocket
except Exception:  # pragma: no cover - typing convenience only
    _ClientSocket = Any  # type: ignore[assignment,misc]


# --- contract-level defaults ----------------------------------------------
DEFAULT_WS_URL = "ws://127.0.0.1:8765"
#: Mirrors ``shared.shared.DEFAULT_VEHICLE_ID``. Every outbound frame carries
#: it; the companion refuses frames addressed to another vehicle.
DEFAULT_VEHICLE_ID = "eis-1"

#: Longest a parked reader sleeps before re-checking liveness/deadline. The
#: wake-ups themselves are edge-triggered; this only bounds the shutdown and
#: timeout latency when the link goes quiet.
_WAIT_SLICE = 0.5

#: Kinds of inbound frame the client buffers.
STREAM_KINDS: Tuple[str, ...] = ("telemetry", "tracking", "statusText", "ack")

# --- process exit codes (the acceptance gates' contract with the scripts) ---
EXIT_OK = 0        # every assertion held
EXIT_ASSERT = 1    # an acceptance assertion failed
EXIT_LINK = 2      # link error / timeout: the gate could not be evaluated
EXIT_ERROR = 3     # anything else


def now_ms() -> int:
    """Wall-clock milliseconds, the contract's ``ts`` unit."""
    return int(time.time() * 1000)


def default_vehicle_id() -> str:
    """Vehicle this client addresses (``EIS_VEHICLE_ID`` overrides)."""
    return os.environ.get("EIS_VEHICLE_ID") or DEFAULT_VEHICLE_ID


def default_ws_url() -> str:
    """Companion control URL (``EIS_WS_URL`` overrides)."""
    return os.environ.get("EIS_WS_URL") or DEFAULT_WS_URL


# Predicate type aliases ----------------------------------------------------
TelemetryPred = Callable[[dict], bool]
TrackingPred = Callable[[dict], bool]
StatusPred = Callable[[dict], bool]
Axes = Callable[[float], Tuple[float, float, float, float]]


class CommandTimeout(TimeoutError):
    """Raised when an awaited ack does not arrive within the timeout."""


# ==========================================================================
# Inbound plumbing
# ==========================================================================
class _Signal:
    """Edge-triggered broadcast.

    ``fire()`` wakes every reader parked *before* the call and then installs a
    fresh event for the next generation, so there is no clear()/set() race and
    no reader can miss an edge it was already waiting on.
    """

    __slots__ = ("_event",)

    def __init__(self) -> None:
        self._event = asyncio.Event()

    def fire(self) -> None:
        event, self._event = self._event, asyncio.Event()
        event.set()

    async def wait(self, timeout: float) -> None:
        event = self._event
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(event.wait(), timeout)


class _Stream:
    """Bounded history of one inbound frame kind, addressed by sequence.

    Frames are numbered from 0 for the life of the client. ``history`` keeps
    only the most recent ``maxlen``; ``_first`` is the sequence number of
    ``history[0]``, which lets a reader ask for "everything after N" in O(new
    frames) instead of rescanning the whole buffer.
    """

    __slots__ = ("kind", "history", "latest", "_first", "_signal")

    def __init__(self, kind: str, history: int) -> None:
        self.kind = kind
        self.history: Deque[dict] = deque(maxlen=max(1, int(history)))
        self.latest: Optional[dict] = None
        self._first = 0
        self._signal = _Signal()

    @property
    def sequence(self) -> int:
        """Sequence number the NEXT frame will receive."""
        return self._first + len(self.history)

    @property
    def oldest(self) -> int:
        """Sequence number of the oldest still-buffered frame."""
        return self._first

    def publish(self, frame: dict) -> None:
        if len(self.history) == self.history.maxlen:
            self._first += 1
        self.history.append(frame)
        self.latest = frame
        self._signal.fire()

    def drain(self, cursor: int) -> Tuple[int, List[dict]]:
        """Frames at/after ``cursor``, plus the cursor to resume from."""
        offset = max(cursor - self._first, 0)
        if offset >= len(self.history):
            return self.sequence, []
        return self.sequence, list(self.history)[offset:]

    async def wait(self, timeout: float) -> None:
        await self._signal.wait(timeout)


class _AckGate:
    """Per-command FIFO of futures awaiting the next matching ack.

    Acks correlate by command NAME only (contract: ``CommandAck`` has no
    requestId), so two in-flight sends of the same command resolve in send
    order.
    """

    def __init__(self) -> None:
        self._queues: Dict[str, Deque[asyncio.Future]] = {}

    def expect(self, command: str) -> asyncio.Future:
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._queues.setdefault(command, deque()).append(future)
        return future

    def discard(self, command: str, future: asyncio.Future) -> None:
        queue = self._queues.get(command)
        if queue is not None:
            with contextlib.suppress(ValueError):
                queue.remove(future)

    def deliver(self, ack: Mapping[str, Any]) -> bool:
        queue = self._queues.get(ack.get("command"))
        while queue:
            future = queue.popleft()
            if not future.done():
                future.set_result(dict(ack))
                return True
        return False

    def abandon(self, error: BaseException) -> None:
        for queue in self._queues.values():
            while queue:
                future = queue.popleft()
                if not future.done():
                    future.set_exception(error)


# ==========================================================================
# The client
# ==========================================================================
class HeadlessClient:
    """Async contract-speaking WebSocket client (ground-station stand-in).

    Parameters
    ----------
    url:
        ws:// URL of the companion control port, e.g. ws://127.0.0.1:8765.
    ack_timeout:
        Seconds to await an ack for a sent command (default 5.0).
    history:
        How many frames of each inbound kind to retain (default 600 ~= 60 s at
        10 Hz), so a test can assert over a recent window.
    vehicle_id:
        Vehicle addressed by every outbound frame; defaults to
        ``EIS_VEHICLE_ID`` or ``eis-1``.
    """

    def __init__(
        self,
        url: str = DEFAULT_WS_URL,
        *,
        ack_timeout: float = 5.0,
        history: int = 600,
        vehicle_id: Optional[str] = None,
    ) -> None:
        self.url = url
        self.ack_timeout = float(ack_timeout)
        self.vehicle_id = vehicle_id or default_vehicle_id()

        self._streams: Dict[str, _Stream] = {
            kind: _Stream(kind, history) for kind in STREAM_KINDS
        }
        self._acks = _AckGate()
        self._ws: Optional[_ClientSocket] = None
        self._rx_task: Optional[asyncio.Task] = None
        self._closed = asyncio.Event()

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------
    async def connect(self, *, retries: int = 40, retry_delay: float = 0.5) -> None:
        """Open the socket, retrying until the companion is reachable."""
        if self._ws is not None:
            return
        attempts = max(1, int(retries))
        failure: Optional[BaseException] = None
        for attempt in range(attempts):
            try:
                socket = await websockets.connect(
                    self.url,
                    ping_interval=20,
                    ping_timeout=20,
                    max_queue=None,
                )
            except (OSError, asyncio.TimeoutError, websockets.WebSocketException) as exc:
                failure = exc
                if attempt + 1 < attempts:
                    await asyncio.sleep(retry_delay)
                continue
            self._ws = socket
            self._closed.clear()
            self._rx_task = asyncio.ensure_future(self._receive_forever(socket))
            return
        raise ConnectionError(
            f"Could not connect to companion at {self.url} after {attempts} tries: {failure!r}"
        )

    async def close(self) -> None:
        """Tear the link down. Idempotent; never raises."""
        self._closed.set()
        task, self._rx_task = self._rx_task, None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        socket, self._ws = self._ws, None
        if socket is not None:
            with contextlib.suppress(Exception):
                await socket.close()
        # Nobody awaiting an ack may hang once the link is gone.
        self._acks.abandon(ConnectionError("Link closed before ack"))

    @property
    def connected(self) -> bool:
        return self._ws is not None and not self._closed.is_set()

    async def __aenter__(self) -> "HeadlessClient":
        await self.connect()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    # ------------------------------------------------------------------
    # Inbound receive loop
    # ------------------------------------------------------------------
    async def _receive_forever(self, socket: Any) -> None:
        try:
            async for raw in socket:
                frame = _decode(raw)
                if frame is not None:
                    self._route(frame)
        except asyncio.CancelledError:
            raise
        except Exception:
            pass  # link dropped; fall through to the closed signal below
        finally:
            # Wake every parked reader so it can observe the closed link.
            self._closed.set()
            for stream in self._streams.values():
                stream._signal.fire()

    def _route(self, frame: dict) -> None:
        stream = self._streams.get(frame.get("type"))
        if stream is None:
            return  # a contract kind this client does not consume
        stream.publish(frame)
        if stream.kind == "ack":
            self._acks.deliver(frame)

    def _stream(self, kind: str) -> _Stream:
        try:
            return self._streams[kind]
        except KeyError:
            raise ValueError(
                f"unknown stream {kind!r}; expected one of {STREAM_KINDS}"
            ) from None

    # ------------------------------------------------------------------
    # Outbound: commands (acked) and manualInput (fire-and-forget)
    # ------------------------------------------------------------------
    async def _transmit(self, frame: Mapping[str, Any]) -> None:
        socket = self._ws
        if socket is None:
            raise ConnectionError("Not connected")
        await socket.send(json.dumps(frame))

    async def send_command(
        self,
        command: str,
        params: Optional[dict] = None,
        *,
        timeout: Optional[float] = None,
        expect_success: bool = False,
    ) -> dict:
        """Send a command and await the next matching ack (by command name).

        Returns the ack dict. With ``expect_success`` a failure ack raises
        AssertionError (so the gates fail with exit ``EXIT_ASSERT``); a missing
        ack raises ``CommandTimeout``.
        """
        if self._ws is None:
            raise ConnectionError("Not connected")
        limit = self.ack_timeout if timeout is None else float(timeout)

        pending = self._acks.expect(command)
        frame: Dict[str, Any] = {
            "type": "command",
            "vehicleId": self.vehicle_id,
            "command": command,
        }
        if params:
            frame["params"] = dict(params)
        try:
            await self._transmit(frame)
            ack = await asyncio.wait_for(pending, limit)
        except asyncio.TimeoutError as exc:
            self._acks.discard(command, pending)
            raise CommandTimeout(
                f"No ack for command '{command}' within {limit}s"
            ) from exc
        except BaseException:
            self._acks.discard(command, pending)
            raise

        if expect_success and not ack.get("success", False):
            raise AssertionError(
                f"Command '{command}' was rejected: {ack.get('message', '(no message)')}"
            )
        return ack

    async def send_manual_input(
        self,
        throttle: float = 0.0,
        yaw: float = 0.0,
        pitch: float = 0.0,
        roll: float = 0.0,
    ) -> None:
        """Send ONE high-rate manualInput frame. Fire-and-forget (NOT acked)."""
        await self._transmit(
            {
                "type": "manualInput",
                "vehicleId": self.vehicle_id,
                "throttle": float(throttle),
                "yaw": float(yaw),
                "pitch": float(pitch),
                "roll": float(roll),
                "ts": now_ms(),
            }
        )

    async def stream_manual_input(
        self,
        axes: Axes,
        *,
        duration: float,
        rate_hz: float = 25.0,
        stop: Optional[asyncio.Event] = None,
    ) -> int:
        """Stream manualInput frames at ``rate_hz`` for ``duration`` seconds.

        ``axes(elapsed)`` returns (throttle, yaw, pitch, roll) for that instant,
        letting a test script time-varying stick motion; this mirrors how the UI
        streams sticks at ~20-50 Hz. Returns early if ``stop`` is set. Frames are
        scheduled against an absolute grid (tick ``n`` is due at ``t0 + n *
        period``) so send latency does not accumulate into rate droop.

        Returns the number of frames actually sent.
        """
        period = 1.0 / max(float(rate_hz), 1.0)
        started = time.monotonic()
        sent = 0
        while True:
            elapsed = time.monotonic() - started
            if elapsed >= duration or (stop is not None and stop.is_set()):
                return sent
            throttle, yaw, pitch, roll = axes(elapsed)
            await self.send_manual_input(throttle, yaw, pitch, roll)
            sent += 1
            nap = (started + sent * period) - time.monotonic()
            if nap > 0:
                await asyncio.sleep(nap)

    # ------------------------------------------------------------------
    # Reading the inbound streams
    # ------------------------------------------------------------------
    async def follow(
        self,
        kind: str,
        *,
        timeout: float,
        include_buffered: bool = False,
    ) -> AsyncIterator[dict]:
        """Yield each frame of ``kind`` published from now until ``timeout``.

        Every published frame is seen exactly once (no sampling gaps), which is
        what the standoff monitor needs: a breach on a single frame must fail
        the gate even if it lasts less than one poll period.
        """
        stream = self._stream(kind)
        cursor = stream.oldest if include_buffered else stream.sequence
        deadline = time.monotonic() + timeout
        while True:
            cursor, batch = stream.drain(cursor)
            for frame in batch:
                yield frame
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            if self._closed.is_set():
                raise ConnectionError(f"Link closed while following {kind}")
            await stream.wait(min(remaining, _WAIT_SLICE))

    async def wait_for(
        self,
        kind: str,
        pred: Callable[[dict], bool],
        *,
        timeout: float = 30.0,
        desc: str = "",
    ) -> dict:
        """Await a frame of ``kind`` satisfying ``pred`` (buffered ones count)."""
        label = desc or kind
        self._stream(kind)  # fail fast on an unknown kind
        async with contextlib.aclosing(
            self.follow(kind, timeout=timeout, include_buffered=True)
        ) as frames:
            async for frame in frames:
                if _matches(pred, frame):
                    return frame
        raise CommandTimeout(f"Timed out waiting for {label} after {timeout}s")

    async def wait_for_telemetry(
        self, pred: TelemetryPred, *, timeout: float = 30.0, desc: str = ""
    ) -> dict:
        """Await a telemetry message satisfying ``pred``. Returns it."""
        return await self.wait_for(
            "telemetry", pred, timeout=timeout, desc=desc or "telemetry"
        )

    async def wait_for_tracking(
        self, pred: TrackingPred, *, timeout: float = 30.0, desc: str = ""
    ) -> dict:
        """Await a tracking message satisfying ``pred``. Returns it."""
        return await self.wait_for(
            "tracking", pred, timeout=timeout, desc=desc or "tracking"
        )

    async def wait_for_status(
        self, pred: StatusPred, *, timeout: float = 30.0, desc: str = ""
    ) -> dict:
        """Await a statusText message satisfying ``pred``. Returns it."""
        return await self.wait_for(
            "statusText", pred, timeout=timeout, desc=desc or "statusText"
        )

    async def collect_telemetry(self, duration: float) -> List[dict]:
        """Collect exactly the telemetry frames of the next ``duration`` s."""
        stream = self._stream("telemetry")
        cursor = stream.sequence
        await asyncio.sleep(duration)
        _, frames = stream.drain(cursor)
        return frames

    # --- snapshot accessors -------------------------------------------
    @property
    def last_telemetry(self) -> Optional[dict]:
        return self._streams["telemetry"].latest

    @property
    def last_tracking(self) -> Optional[dict]:
        return self._streams["tracking"].latest

    @property
    def telemetry_log(self) -> Deque[dict]:
        return self._streams["telemetry"].history

    @property
    def tracking_log(self) -> Deque[dict]:
        return self._streams["tracking"].history

    @property
    def status_log(self) -> Deque[dict]:
        return self._streams["statusText"].history

    @property
    def ack_log(self) -> Deque[dict]:
        return self._streams["ack"].history

    @property
    def control_source(self) -> Optional[str]:
        telemetry = self.last_telemetry
        return None if telemetry is None else telemetry.get("controlSource")

    @property
    def estimated_distance(self) -> Optional[float]:
        tracking = self.last_tracking
        return None if tracking is None else tracking.get("estimatedDistance")


def _decode(raw: Any) -> Optional[dict]:
    """Bytes/str -> contract frame, or None if it is not one."""
    if isinstance(raw, (bytes, bytearray)):
        try:
            raw = bytes(raw).decode("utf-8")
        except UnicodeDecodeError:
            return None
    try:
        frame = json.loads(raw)
    except (ValueError, TypeError):
        return None
    return frame if isinstance(frame, dict) else None


def _matches(pred: Callable[[dict], bool], frame: dict) -> bool:
    """A predicate that raises on an unexpected frame shape is a non-match."""
    try:
        return bool(pred(frame))
    except Exception:
        return False


# ==========================================================================
# Acceptance scaffolding shared by e2e_test.py and manual_test.py
# ==========================================================================
Phase = Callable[[], Awaitable[Optional[str]]]


@dataclass(frozen=True)
class PhaseMachine:
    """An explicit state machine over named acceptance phases.

    Each phase coroutine returns the name of the next phase, or ``None`` when
    the sequence is complete. Phases raise ``AssertionError`` to fail the gate.
    The transition log is printed so a failing run shows exactly how far the
    vehicle got.
    """

    tag: str
    phases: Mapping[str, Phase]
    start: str
    echo: Callable[[str], None] = print
    max_transitions: int = 64

    def __post_init__(self) -> None:
        if self.start not in self.phases:
            raise KeyError(f"start phase {self.start!r} is not defined")

    def say(self, message: str) -> None:
        self.echo(f"[{self.tag}] {message}")

    async def run(self) -> List[str]:
        """Drive the machine to completion; returns the phases visited."""
        visited: List[str] = []
        name: Optional[str] = self.start
        while name is not None:
            if len(visited) >= self.max_transitions:
                raise AssertionError(
                    f"{self.tag}: phase machine exceeded {self.max_transitions} "
                    f"transitions (loop via {name!r}?)"
                )
            try:
                phase = self.phases[name]
            except KeyError:
                raise KeyError(f"{self.tag}: no such phase {name!r}") from None
            visited.append(name)
            self.say(f"phase: {name}")
            name = await phase()
        return visited


async def drive_acceptance(
    client: HeadlessClient,
    machine: PhaseMachine,
    *,
    on_exit: Optional[Callable[[HeadlessClient], Awaitable[None]]] = None,
) -> List[str]:
    """Run one gate to completion, always tearing the link down afterwards."""
    try:
        return await machine.run()
    finally:
        if on_exit is not None:
            with contextlib.suppress(Exception):
                await on_exit(client)
        await client.close()


def run_acceptance(
    tag: str,
    client: HeadlessClient,
    machine: PhaseMachine,
    *,
    on_exit: Optional[Callable[[HeadlessClient], Awaitable[None]]] = None,
) -> int:
    """Standalone entry point: map an acceptance run onto a process exit code.

    ``EXIT_OK`` pass / ``EXIT_ASSERT`` assertion failed / ``EXIT_LINK`` link or
    timeout / ``EXIT_ERROR`` anything else. ``run-sim-e2e.sh`` and
    ``run-sim-e2e.ps1`` treat any non-zero code as a failed gate.
    """
    try:
        asyncio.run(drive_acceptance(client, machine, on_exit=on_exit))
    except AssertionError as exc:
        print(f"\n[{tag}] FAIL -- {exc}", file=sys.stderr)
        return EXIT_ASSERT
    except (ConnectionError, TimeoutError) as exc:
        print(f"\n[{tag}] FAIL (link/timeout) -- {exc}", file=sys.stderr)
        return EXIT_LINK
    except Exception as exc:  # noqa: BLE001
        print(f"\n[{tag}] FAIL (unexpected) -- {exc!r}", file=sys.stderr)
        return EXIT_ERROR
    return EXIT_OK


def link_arguments(parser: argparse.ArgumentParser) -> argparse.ArgumentParser:
    """Add the link flags every acceptance entry point accepts.

    ``--ws-url`` is the flag ``scripts/run-sim-e2e.{sh,ps1}`` pass; the
    ``EIS_WS_URL`` / ``EIS_VEHICLE_ID`` environment variables are the defaults.
    """
    parser.add_argument(
        "--ws-url",
        dest="ws_url",
        default=default_ws_url(),
        metavar="URL",
        help="companion control WebSocket URL (default: %(default)s)",
    )
    parser.add_argument(
        "--vehicle-id",
        dest="vehicle_id",
        default=default_vehicle_id(),
        metavar="ID",
        help="vehicleId stamped on every outbound frame (default: %(default)s)",
    )
    return parser


def env_float(name: str, default: float) -> float:
    """Read a float knob from the environment, ignoring unparseable values."""
    try:
        return float(os.environ[name])
    except (KeyError, TypeError, ValueError):
        return float(default)


def env_int(name: str, default: int) -> int:
    try:
        return int(float(os.environ[name]))
    except (KeyError, TypeError, ValueError):
        return int(default)


# --------------------------------------------------------------------------
# Smoke-test entry point: connect, watch briefly, print what arrived.
# --------------------------------------------------------------------------
async def _smoke(url: str, seconds: float, vehicle_id: str) -> None:
    async with HeadlessClient(url, vehicle_id=vehicle_id) as client:
        print(f"connected to {url}; collecting {seconds:.1f}s of telemetry/tracking...")
        await client.collect_telemetry(seconds)
        print("telemetry frames:", len(client.telemetry_log))
        print("tracking  frames:", len(client.tracking_log))
        telemetry = client.last_telemetry
        if telemetry:
            position = telemetry.get("position") or {}
            print(
                "  armed=%s mode=%s controlSource=%s relAlt=%.2f"
                % (
                    telemetry.get("armed"),
                    telemetry.get("mode"),
                    telemetry.get("controlSource"),
                    position.get("relAlt", float("nan")),
                )
            )


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = link_arguments(
        argparse.ArgumentParser(
            prog="headless_client.py",
            description="Smoke-test the companion control link.",
        )
    )
    parser.add_argument(
        "url",
        nargs="?",
        default=None,
        help="positional form of --ws-url (kept for sim/README.md)",
    )
    parser.add_argument(
        "--seconds", type=float, default=2.0, help="observation window"
    )
    args = parser.parse_args(argv)
    url = args.url or args.ws_url
    try:
        asyncio.run(_smoke(url, args.seconds, args.vehicle_id))
    except (ConnectionError, TimeoutError) as exc:
        print(f"smoke test failed: {exc}", file=sys.stderr)
        return EXIT_LINK
    return EXIT_OK


__all__ = [
    "DEFAULT_VEHICLE_ID",
    "DEFAULT_WS_URL",
    "EXIT_ASSERT",
    "EXIT_ERROR",
    "EXIT_LINK",
    "EXIT_OK",
    "Axes",
    "CommandTimeout",
    "HeadlessClient",
    "Phase",
    "PhaseMachine",
    "StatusPred",
    "TelemetryPred",
    "TrackingPred",
    "default_vehicle_id",
    "default_ws_url",
    "drive_acceptance",
    "env_float",
    "env_int",
    "link_arguments",
    "now_ms",
    "run_acceptance",
]


if __name__ == "__main__":
    raise SystemExit(main())
