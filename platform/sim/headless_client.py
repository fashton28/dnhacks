"""
============================================================================
Drone Safety Platform -- headless WebSocket client (HeadlessClient)
----------------------------------------------------------------------------
A small async WebSocket client that speaks the shared control contract
(shared/shared.py / ground/ui/src/contract/index.ts). It is the Python
stand-in for the ground TypeScript ``LiveDataProvider`` and is used by the
acceptance tests (e2e_test.py, manual_test.py).

It drives the companion ENTIRELY through the WebSocket contract -- no internal
companion imports. That keeps the tests honest: they exercise exactly what the
real ground station exercises.

Contract facts honoured (mirrors LiveDataProvider.ts):
  * companion -> ground:  telemetry (~10Hz), tracking (~10Hz), statusText, ack
  * ground -> companion:  command (acked), manualInput (HIGH-RATE, NOT acked)
  * sendCommand() awaits the next matching ack BY COMMAND NAME, with a timeout.
  * send_manual_input() is fire-and-forget (never awaits an ack).

Command params map (per contract Command.params):
    takeoff   -> {"altitude": meters}
    setMode   -> {"mode": Mode}
    selectTarget -> {"targetId": int}
    setStandoff  -> {"meters": float}
    setMaxSpeed  -> {"mps": float}

Requires the `websockets` package (declared by the packaging agent, not pinned
here). Usage::

    async with HeadlessClient("ws://127.0.0.1:8765") as c:
        ack = await c.send_command("arm")
        assert ack["success"], ack["message"]
        tel = await c.wait_for_telemetry(lambda t: t.get("armed"))

============================================================================
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import time
from collections import deque
from typing import Any, Callable, Deque, Optional

try:
    import websockets
    from websockets.client import WebSocketClientProtocol
except Exception as exc:  # pragma: no cover - import-time guard
    raise SystemExit(
        "headless_client requires the 'websockets' package "
        "(pip install websockets). Original error: %r" % (exc,)
    )


def now_ms() -> int:
    return int(time.time() * 1000)


# Predicate type aliases ----------------------------------------------------
TelemetryPred = Callable[[dict], bool]
TrackingPred = Callable[[dict], bool]
StatusPred = Callable[[dict], bool]


class CommandTimeout(TimeoutError):
    """Raised when an awaited ack does not arrive within the timeout."""


class HeadlessClient:
    """Async contract-speaking WebSocket client (ground-station stand-in).

    Parameters
    ----------
    url:
        ws:// URL of the companion control port, e.g. ws://127.0.0.1:8765.
    ack_timeout:
        Seconds to await an ack for a sent command (default 5.0).
    history:
        How many of each inbound message kind to retain (default 600 ~= 60s
        at 10 Hz). Lets tests assert over a recent window.
    """

    def __init__(
        self,
        url: str = "ws://127.0.0.1:8765",
        *,
        ack_timeout: float = 5.0,
        history: int = 600,
    ) -> None:
        self.url = url
        self.ack_timeout = ack_timeout

        self._ws: Optional[WebSocketClientProtocol] = None
        self._rx_task: Optional[asyncio.Task] = None
        self._closed = asyncio.Event()

        # Latest snapshots + rolling history --------------------------------
        self.last_telemetry: Optional[dict] = None
        self.last_tracking: Optional[dict] = None
        self.telemetry_log: Deque[dict] = deque(maxlen=history)
        self.tracking_log: Deque[dict] = deque(maxlen=history)
        self.status_log: Deque[dict] = deque(maxlen=history)
        self.ack_log: Deque[dict] = deque(maxlen=history)

        # Per-command futures for the next matching ack ---------------------
        self._pending_acks: dict[str, Deque[asyncio.Future]] = {}

        # Events fired on each new message so waiters wake promptly ----------
        self._tel_event = asyncio.Event()
        self._trk_event = asyncio.Event()
        self._txt_event = asyncio.Event()

    # ------------------------------------------------------------------
    # Connection lifecycle
    # ------------------------------------------------------------------
    async def connect(self, *, retries: int = 40, retry_delay: float = 0.5) -> None:
        """Open the socket, retrying until the companion is reachable."""
        last_exc: Optional[Exception] = None
        for _ in range(max(1, retries)):
            try:
                self._ws = await websockets.connect(
                    self.url,
                    ping_interval=20,
                    ping_timeout=20,
                    max_queue=None,
                )
                self._closed.clear()
                self._rx_task = asyncio.ensure_future(self._rx_loop())
                return
            except (OSError, asyncio.TimeoutError) as exc:
                last_exc = exc
                await asyncio.sleep(retry_delay)
        raise ConnectionError(
            f"Could not connect to companion at {self.url} after {retries} tries: {last_exc!r}"
        )

    async def close(self) -> None:
        self._closed.set()
        if self._rx_task is not None:
            self._rx_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._rx_task
            self._rx_task = None
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close()
            self._ws = None
        # Fail any still-pending acks so awaiters don't hang.
        for dq in self._pending_acks.values():
            while dq:
                fut = dq.popleft()
                if not fut.done():
                    fut.set_exception(ConnectionError("Link closed before ack"))

    async def __aenter__(self) -> "HeadlessClient":
        await self.connect()
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    # ------------------------------------------------------------------
    # Inbound receive loop
    # ------------------------------------------------------------------
    async def _rx_loop(self) -> None:
        assert self._ws is not None
        try:
            async for raw in self._ws:
                if isinstance(raw, bytes):
                    try:
                        raw = raw.decode("utf-8")
                    except Exception:
                        continue
                try:
                    msg = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                self._dispatch(msg)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Connection dropped; signal closed so waiters can bail.
            self._closed.set()

    def _dispatch(self, msg: dict) -> None:
        mtype = msg.get("type")
        if mtype == "telemetry":
            self.last_telemetry = msg
            self.telemetry_log.append(msg)
            _pulse(self._tel_event)
        elif mtype == "tracking":
            self.last_tracking = msg
            self.tracking_log.append(msg)
            _pulse(self._trk_event)
        elif mtype == "statusText":
            self.status_log.append(msg)
            _pulse(self._txt_event)
        elif mtype == "ack":
            self.ack_log.append(msg)
            self._resolve_ack(msg)

    def _resolve_ack(self, ack: dict) -> None:
        name = ack.get("command")
        dq = self._pending_acks.get(name)
        if not dq:
            return
        while dq:
            fut = dq.popleft()
            if not fut.done():
                fut.set_result(ack)
                return

    # ------------------------------------------------------------------
    # Outbound: commands (acked) and manualInput (fire-and-forget)
    # ------------------------------------------------------------------
    async def send_command(
        self,
        command: str,
        params: Optional[dict] = None,
        *,
        timeout: Optional[float] = None,
        expect_success: bool = False,
    ) -> dict:
        """Send a command and await the next matching ack (by command name).

        Returns the ack dict. If ``expect_success`` is True, raises
        AssertionError on a failure ack (handy in tests). Raises CommandTimeout
        if no ack arrives within the timeout.
        """
        if self._ws is None:
            raise ConnectionError("Not connected")

        fut: asyncio.Future = asyncio.get_event_loop().create_future()
        self._pending_acks.setdefault(command, deque()).append(fut)

        payload = {"type": "command", "command": command}
        if params:
            payload["params"] = params
        await self._ws.send(json.dumps(payload))

        try:
            ack = await asyncio.wait_for(fut, timeout or self.ack_timeout)
        except asyncio.TimeoutError as exc:
            # Drop our pending future so it doesn't resolve late.
            dq = self._pending_acks.get(command)
            if dq and fut in dq:
                dq.remove(fut)
            raise CommandTimeout(
                f"No ack for command '{command}' within "
                f"{timeout or self.ack_timeout}s"
            ) from exc

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
        if self._ws is None:
            raise ConnectionError("Not connected")
        await self._ws.send(
            json.dumps(
                {
                    "type": "manualInput",
                    "throttle": float(throttle),
                    "yaw": float(yaw),
                    "pitch": float(pitch),
                    "roll": float(roll),
                    "ts": now_ms(),
                }
            )
        )

    async def stream_manual_input(
        self,
        axes: Callable[[float], tuple[float, float, float, float]],
        *,
        duration: float,
        rate_hz: float = 25.0,
        stop: Optional[asyncio.Event] = None,
    ) -> None:
        """Stream manualInput frames at ``rate_hz`` for ``duration`` seconds.

        ``axes(elapsed)`` returns (throttle, yaw, pitch, roll) for that instant,
        letting tests script time-varying stick motion. Stops early if ``stop``
        is set. This mirrors how the UI streams sticks at ~20-50 Hz.
        """
        period = 1.0 / max(rate_hz, 1.0)
        t0 = time.monotonic()
        while True:
            elapsed = time.monotonic() - t0
            if elapsed >= duration or (stop is not None and stop.is_set()):
                return
            thr, yaw, pit, rol = axes(elapsed)
            await self.send_manual_input(thr, yaw, pit, rol)
            await asyncio.sleep(period)

    # ------------------------------------------------------------------
    # High-level convenience helpers used by the tests
    # ------------------------------------------------------------------
    async def wait_for_telemetry(
        self, pred: TelemetryPred, *, timeout: float = 30.0, desc: str = ""
    ) -> dict:
        """Await a telemetry message satisfying ``pred``. Returns it."""
        return await self._wait_for(self.telemetry_log, self._tel_event, pred, timeout, desc or "telemetry")

    async def wait_for_tracking(
        self, pred: TrackingPred, *, timeout: float = 30.0, desc: str = ""
    ) -> dict:
        """Await a tracking message satisfying ``pred``. Returns it."""
        return await self._wait_for(self.tracking_log, self._trk_event, pred, timeout, desc or "tracking")

    async def wait_for_status(
        self, pred: StatusPred, *, timeout: float = 30.0, desc: str = ""
    ) -> dict:
        """Await a statusText message satisfying ``pred``. Returns it."""
        return await self._wait_for(self.status_log, self._txt_event, pred, timeout, desc or "statusText")

    async def _wait_for(
        self,
        log: Deque[dict],
        event: asyncio.Event,
        pred: Callable[[dict], bool],
        timeout: float,
        desc: str,
    ) -> dict:
        deadline = time.monotonic() + timeout
        # Check anything already buffered first.
        for msg in list(log):
            try:
                if pred(msg):
                    return msg
            except Exception:
                pass
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CommandTimeout(f"Timed out waiting for {desc} after {timeout}s")
            if self._closed.is_set():
                raise ConnectionError(f"Link closed while waiting for {desc}")
            event.clear()
            try:
                await asyncio.wait_for(event.wait(), timeout=min(remaining, 1.0))
            except asyncio.TimeoutError:
                pass
            # New messages may have arrived; scan the tail.
            for msg in list(log):
                try:
                    if pred(msg):
                        return msg
                except Exception:
                    pass

    async def collect_telemetry(self, duration: float) -> list[dict]:
        """Collect every telemetry message over ``duration`` seconds."""
        start_len = len(self.telemetry_log)
        await asyncio.sleep(duration)
        # Return only what arrived during the window (best-effort).
        items = list(self.telemetry_log)
        return items[max(0, start_len - 0):]

    # --- snapshot accessors -------------------------------------------
    @property
    def control_source(self) -> Optional[str]:
        if self.last_telemetry is None:
            return None
        return self.last_telemetry.get("controlSource")

    @property
    def estimated_distance(self) -> Optional[float]:
        if self.last_tracking is None:
            return None
        return self.last_tracking.get("estimatedDistance")


def _pulse(event: asyncio.Event) -> None:
    """Set then immediately allow re-clear: wakes all current waiters."""
    event.set()


# --------------------------------------------------------------------------
# Tiny smoke-test entry point: connect, print a few messages, exit.
# --------------------------------------------------------------------------
async def _smoke(url: str) -> None:
    async with HeadlessClient(url) as c:
        print(f"connected to {url}; collecting 2s of telemetry/tracking...")
        await asyncio.sleep(2.0)
        print("telemetry frames:", len(c.telemetry_log))
        print("tracking  frames:", len(c.tracking_log))
        if c.last_telemetry:
            t = c.last_telemetry
            print(
                "  armed=%s mode=%s controlSource=%s relAlt=%.2f"
                % (
                    t.get("armed"),
                    t.get("mode"),
                    t.get("controlSource"),
                    t.get("position", {}).get("relAlt", float("nan")),
                )
            )


if __name__ == "__main__":
    import sys

    url = sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:8765"
    asyncio.run(_smoke(url))
