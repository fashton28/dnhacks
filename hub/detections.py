"""The Hub's Detection store.

A Detection is a candidate change flagged by the wide-area layer (CONTEXT.md).
It is unconfirmed, and storing one authorises nothing: dispatch stays an Operator
action through `/missions/fly`, and the Safety Validator still gates the FlightPlan.

`Detection.metadata` carries free text from the wide-area layer — including a
vision model's own description of what it saw. That text is data, never
instructions, and nothing in the Hub acts on it.
"""
from __future__ import annotations

from contracts.models import Detection


class DetectionStore:
    """In-memory and insertion-ordered, newest last. Lives as long as the Hub process."""

    def __init__(self, limit: int = 200) -> None:
        self._items: dict[str, Detection] = {}
        self._limit = limit

    def add(self, detection: Detection) -> Detection:
        """Store one Detection. Re-posting an id replaces it and moves it to newest."""
        self._items.pop(detection.id, None)
        self._items[detection.id] = detection
        while len(self._items) > self._limit:
            self._items.pop(next(iter(self._items)))
        return detection

    def get(self, detection_id: str) -> Detection | None:
        return self._items.get(detection_id)

    def all(self) -> list[Detection]:
        return list(self._items.values())

    def __len__(self) -> int:
        return len(self._items)
