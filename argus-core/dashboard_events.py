"""Append-only JSONL event writer for a dashboard or simulator adapter."""
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def emit(path: str | Path, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    event = {
        "event_type": event_type,
        "timestamp": datetime.now(UTC).isoformat(),
        "payload": payload,
    }
    output = Path(path)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("a") as stream:
        stream.write(json.dumps(event) + "\n")
    return event
