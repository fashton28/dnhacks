"""Plant signals: the plant's own instrumentation as a trigger for ARGUS.

A nuclear plant already instruments itself (winding temperatures, relief valve position switches, fire alarm
zones, radiation monitors). ARGUS subscribes to those readings and turns one that is above its threshold into a
Detection at the asset's position, so everything downstream is the pipeline that already exists: Site context,
triage decision, envelope, Safety Validator, agent flight, thermal confirmation, report.

The reading rides along in `Detection.metadata` as data, never instructions.
"""
from __future__ import annotations

from contracts.models import ChangeType, Detection, LatLon, PlantSignal, PlantSignalKind
from contracts.site import enu_to_latlon, latlon_to_enu

HALF_SIDE_M = 6.0  # the Detection polygon: a square of this half side around the asset

CHANGE_TYPE_FOR_KIND = {
    PlantSignalKind.temperature: ChangeType.thermal_anomaly,
    PlantSignalKind.fire_alarm: ChangeType.thermal_anomaly,
    PlantSignalKind.valve: ChangeType.structure,
    PlantSignalKind.radiation: ChangeType.unknown,
}


class PlantSignals:
    """Insertion-ordered store of every signal the Hub has ingested, newest last. Lives as long as the process."""

    def __init__(self, limit: int = 500) -> None:
        self._items: dict[str, PlantSignal] = {}
        self._limit = limit

    def append(self, signal: PlantSignal) -> PlantSignal:
        self._items.pop(signal.id, None)
        self._items[signal.id] = signal
        while len(self._items) > self._limit:
            self._items.pop(next(iter(self._items)))
        return signal

    def get(self, signal_id: str) -> PlantSignal | None:
        return self._items.get(signal_id)

    def list(self) -> list[PlantSignal]:
        return list(self._items.values())

    def __len__(self) -> int:
        return len(self._items)


def _fmt(v: str | float) -> str:
    """142.0 reads as 142; a valve position stays as written."""
    return f"{v:g}" if isinstance(v, (int, float)) else str(v)


def signal_to_detection(signal: PlantSignal) -> Detection:
    """A signal becomes a Detection: a small square around the asset, the reading quoted in metadata."""
    x, y = latlon_to_enu(signal.asset.lat, signal.asset.lon)
    h = HALF_SIDE_M
    ring = [LatLon(lat=lat, lon=lon) for lat, lon in (enu_to_latlon(x - h, y - h), enu_to_latlon(x + h, y - h), enu_to_latlon(x + h, y + h), enu_to_latlon(x - h, y + h))]
    reading = f"{_fmt(signal.value)} {signal.unit}".strip()
    threshold = "" if signal.threshold is None else f", threshold {_fmt(signal.threshold)} {signal.unit}".strip()
    note = f"Plant signal {signal.sensor_id} on {signal.asset.name}: {signal.kind.value.replace('_', ' ')} {reading}{threshold} ({signal.severity.value})."
    if signal.note:
        note += f" {signal.note}"
    return Detection(
        id=f"det-{signal.id}",
        polygon=ring,
        confidence=0.9,
        change_type=CHANGE_TYPE_FOR_KIND[signal.kind],
        before_ref=f"plant/{signal.sensor_id}",
        after_ref=f"plant/{signal.sensor_id}",
        detected_at=signal.ts,
        area_m2=(2 * h) ** 2,
        metadata={
            "source": "plant-signal",
            "signal_id": signal.id,
            "sensor_id": signal.sensor_id,
            "asset": signal.asset.name,
            "kind": signal.kind.value,
            "value": _fmt(signal.value),
            "unit": signal.unit,
            "threshold": "" if signal.threshold is None else _fmt(signal.threshold),
            "severity": signal.severity.value,
            "note": note,
        },
    )
