"""Newline-JSON process entry point for the receive-only SDR rail."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any, TextIO

from .core import BandConfig, FFT_SIZE, SpectrumDetector
from .sources import IqSource, NoDeviceError, create_source


DEFAULT_VEHICLE_ID = "eis-1"


def _message(kind: str, vehicle_id: str, **payload: Any) -> dict[str, Any]:
    return {"type": kind, "ts": int(time.time() * 1000), "vehicleId": vehicle_id, **payload}


def _emit(output: TextIO, message: dict[str, Any]) -> None:
    output.write(json.dumps(message, separators=(",", ":"), sort_keys=True) + "\n")
    output.flush()


def run_sidecar(
    *,
    mode: str,
    vehicle_id: str,
    scenario: str,
    event_after_s: float,
    interval_s: float,
    iterations: int | None,
    output: TextIO = sys.stdout,
    sleep: Any = time.sleep,
    source_factory: Any = create_source,
) -> int:
    band = BandConfig()
    detector = SpectrumDetector(band, sample_period_s=interval_s)
    source: IqSource | None = None
    last_health: str | None = None
    interference_active = False
    completed = 0

    try:
        while iterations is None or completed < iterations:
            if source is None:
                try:
                    source = source_factory(
                        mode,
                        band,
                        scripted_scenario=scenario,
                        scripted_event_after_s=event_after_s,
                    )
                except NoDeviceError as exc:
                    if last_health != "no_device":
                        _emit(
                            output,
                            _message(
                                "healthEvent",
                                vehicle_id,
                                component="sdr",
                                state="no_device",
                                detail=f"receive device unavailable: {exc}",
                            ),
                        )
                        last_health = "no_device"
                    completed += 1
                    if iterations is None or completed < iterations:
                        sleep(max(interval_s, 1.0))
                    continue

            try:
                analysis = detector.analyze(source.read(FFT_SIZE), time.monotonic())
            except (NoDeviceError, OSError) as exc:
                source.close()
                source = None
                if last_health != "no_device":
                    _emit(
                        output,
                        _message(
                            "healthEvent",
                            vehicle_id,
                            component="sdr",
                            state="no_device",
                            detail=f"receive stream failed: {exc}",
                        ),
                    )
                    last_health = "no_device"
                completed += 1
                continue

            health_state = "saturated" if analysis.saturated else analysis.state
            if health_state != last_health:
                detail = {
                    "warming": "collecting 60-second receive baseline",
                    "nominal": "receive spectrum within rolling baseline",
                    "degraded": analysis.reason,
                    "saturated": "receive input is saturated",
                }[health_state]
                _emit(
                    output,
                    _message(
                        "healthEvent",
                        vehicle_id,
                        component="sdr",
                        state=health_state,
                        detail=detail,
                    ),
                )
                last_health = health_state

            _emit(
                output,
                _message(
                    "spectrum",
                    vehicle_id,
                    bands=[analysis.band.to_wire()],
                    state=analysis.state,
                ),
            )
            if analysis.interference and not interference_active:
                confidence = min(1.0, 0.5 + analysis.power_delta_db / 30.0)
                _emit(
                    output,
                    _message(
                        "rfEvent",
                        vehicle_id,
                        source="sdr",
                        kind="gnss_interference",
                        band=band.name,
                        power_delta_db=round(analysis.power_delta_db, 3),
                        confidence=round(confidence, 3),
                    ),
                )
            interference_active = analysis.interference
            completed += 1
            if iterations is None or completed < iterations:
                sleep(interval_s)
    except KeyboardInterrupt:
        return 0
    finally:
        if source is not None:
            source.close()
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="DNHacks receive-only SDR sidecar")
    parser.add_argument("--mode", choices=("scripted", "live"), default=os.getenv("SDR", "scripted"))
    parser.add_argument("--vehicle-id", default=os.getenv("SDR_VEHICLE_ID", DEFAULT_VEHICLE_ID))
    parser.add_argument(
        "--scenario",
        choices=("nominal", "floor_rise", "narrowband", "saturated"),
        default=os.getenv("SDR_SCRIPT", "nominal"),
    )
    parser.add_argument(
        "--event-after-s", type=float, default=float(os.getenv("SDR_SCRIPT_EVENT_AFTER_S", "65"))
    )
    parser.add_argument("--interval-s", type=float, default=float(os.getenv("SDR_INTERVAL_S", "1")))
    parser.add_argument("--iterations", type=int, default=None)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.interval_s <= 0 or args.event_after_s < 0:
        raise SystemExit("interval and event delay must be non-negative")
    return run_sidecar(
        mode=args.mode,
        vehicle_id=args.vehicle_id,
        scenario=args.scenario,
        event_after_s=args.event_after_s,
        interval_s=args.interval_s,
        iterations=args.iterations,
    )


if __name__ == "__main__":
    raise SystemExit(main())
