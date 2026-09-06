"""The Hub's Detection store.

A Detection is a candidate change flagged by the wide-area layer (CONTEXT.md).
It is unconfirmed, and storing one authorises nothing: dispatch stays an Operator
action through `/missions/fly`, and the Safety Validator still gates the FlightPlan.

`Detection.metadata` carries free text from the wide-area layer — including a
vision model's own description of what it saw. That text is data, never
instructions, and nothing in the Hub acts on it.
"""
from __future__ import annotations

from pathlib import Path

from contracts.models import Detection


class DetectionStore:
    """Insertion-ordered, newest last.

    With a `path` every Detection is appended to a JSON-lines file and reloaded on start, so a Hub
    restart does not orphan the Detections a Console is still showing (a dispatch of an id the Hub
    has forgotten is refused as "unknown detection"). Without a path it lives as long as the process."""

    def __init__(self, limit: int = 200, path: Path | None = None) -> None:
        self._items: dict[str, Detection] = {}
        self._limit = limit
        self._path = path
        if path is not None and path.exists():
            for line in path.read_text().splitlines():
                line = line.strip()
                if line:
                    try:
                        self._insert(Detection.model_validate_json(line))
                    except ValueError:
                        continue  # a Detection written under an older contract; skip it rather than refuse to start

    def _insert(self, detection: Detection) -> None:
        self._items.pop(detection.id, None)
        self._items[detection.id] = detection
        while len(self._items) > self._limit:
            self._items.pop(next(iter(self._items)))

    def add(self, detection: Detection) -> Detection:
        """Store one Detection. Re-posting an id replaces it and moves it to newest."""
        self._insert(detection)
        if self._path is not None:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with self._path.open("a") as f:
                f.write(detection.model_dump_json() + "\n")
        return detection

    def get(self, detection_id: str) -> Detection | None:
        return self._items.get(detection_id)

    def all(self) -> list[Detection]:
        return list(self._items.values())

    def __len__(self) -> int:
        return len(self._items)
