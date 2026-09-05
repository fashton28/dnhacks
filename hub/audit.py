"""Append-only audit log. Every dispatch, verdict, command, clamp and report is one JSON line."""
from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


class AuditLog:
    def __init__(self, path: Path | None):
        self.path = path
        if path is not None:
            path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, kind: str, **fields: Any) -> dict[str, Any]:
        entry = {"ts": datetime.now(UTC).isoformat(), "kind": kind, **fields}
        if self.path is not None:
            with self.path.open("a") as f:
                f.write(json.dumps(entry, default=str) + "\n")
        return entry
