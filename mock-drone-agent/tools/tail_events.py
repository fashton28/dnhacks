#!/usr/bin/env python3
"""Follow the event log — a 20-line reference for the dashboard team.

    python3 tools/tail_events.py               # follow live
    python3 tools/tail_events.py --replay      # print history, then follow

Your dashboard does the same thing: poll `read_events(path, since_seq)`, keep
the last `seq` you saw, render whatever arrives. No coupling to the agent code.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent.events import read_events  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", default="runs/events.jsonl")
    ap.add_argument("--replay", action="store_true", help="include events already in the file")
    ap.add_argument("--interval", type=float, default=0.4)
    ap.add_argument("--type", action="append", help="only show these event types (repeatable)")
    args = ap.parse_args()

    wanted = set(args.type or [])
    last = 0
    if not args.replay:
        last = max((e["seq"] for e in read_events(args.path)), default=0)

    print(f"following {args.path} from seq {last} — Ctrl-C to stop", file=sys.stderr)
    try:
        while True:
            for event in read_events(args.path, since_seq=last):
                last = event["seq"]
                if wanted and event["type"] not in wanted:
                    continue
                print(json.dumps(event))
            sys.stdout.flush()
            time.sleep(args.interval)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
