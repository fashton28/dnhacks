#!/usr/bin/env python3
"""End-to-end demo of the LLM layer.

    python3 run_demo.py                          # one random anomaly
    python3 run_demo.py --all                    # every anomaly in the catalogue
    python3 run_demo.py --anomaly fence-breach-01
    python3 run_demo.py --force-bad-plan         # show the verifier rejecting and repairing
    python3 run_demo.py --battery 40             # watch the battery check bite
    python3 run_demo.py --mode live              # require the real Claude API

Runs in mock mode automatically when there are no Anthropic credentials, so the
pipeline works with zero setup.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent import anomaly as anomaly_mod  # noqa: E402
from agent.events import EventLog  # noqa: E402
from agent.executor import SimStubExecutor  # noqa: E402
from agent.facility import Facility  # noqa: E402
from agent.llm import LLM, LLMError  # noqa: E402
from agent.orchestrator import Orchestrator  # noqa: E402

RULE = "─" * 78


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--anomaly", action="append", metavar="ID", help="anomaly id (repeatable)")
    ap.add_argument("--all", action="store_true", help="run every anomaly in the catalogue")
    ap.add_argument("--count", type=int, default=1, help="how many random anomalies (default 1)")
    ap.add_argument("--battery", type=float, default=100.0, help="starting battery %% (default 100)")
    ap.add_argument(
        "--mode",
        choices=("auto", "live", "mock"),
        default="auto",
        help="auto uses the API when credentials exist (default)",
    )
    ap.add_argument("--facility", default=None, help="path to a facility config JSON")
    ap.add_argument("--events", default="runs/events.jsonl", help="event log path")
    ap.add_argument("--seed", type=int, default=None, help="seed for anomaly choice and sensors")
    ap.add_argument(
        "--force-bad-plan",
        action="store_true",
        help="make the mock planner's first attempt illegal, to demo the trust layer",
    )
    ap.add_argument("--realtime", action="store_true", help="pace waypoints so a demo reads live")
    ap.add_argument("--fresh", action="store_true", help="truncate the event log first")
    args = ap.parse_args()

    facility = Facility.load(args.facility)

    try:
        llm = LLM(mode=args.mode)
    except LLMError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.all:
        anomalies = [anomaly_mod.get(a["anomaly_id"]) for a in anomaly_mod.CATALOGUE]
    elif args.anomaly:
        try:
            anomalies = [anomaly_mod.get(a) for a in args.anomaly]
        except KeyError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 2
    else:
        anomalies = anomaly_mod.sample(args.count, seed=args.seed)

    events_path = Path(args.events)
    if args.fresh and events_path.exists():
        events_path.unlink()
    events = EventLog(events_path)

    print(RULE)
    print(f"  {facility.name}")
    print(f"  planner/triage : {'MOCK — ' + llm.reason if llm.mock else llm.model}")
    print(f"  drone control  : SimStubExecutor (swap for Px4Executor when SITL is up)")
    print(f"  battery        : {args.battery:.0f}%")
    print(f"  anomalies      : {', '.join(a['anomaly_id'] for a in anomalies)}")
    print(f"  event log      : {events_path}")
    print(RULE)

    executor = SimStubExecutor(
        facility,
        events,
        battery_start_pct=args.battery,
        seed=args.seed,
        realtime=args.realtime,
    )
    orch = Orchestrator(
        facility,
        llm,
        executor,
        events,
        battery_pct=args.battery,
        force_bad_first=args.force_bad_plan,
    )

    try:
        outcomes = orch.run(anomalies)
    except LLMError as exc:
        print(f"\nLLM error: {exc}", file=sys.stderr)
        return 1

    print()
    print(RULE)
    print("  SUMMARY")
    print(RULE)
    for o in outcomes:
        flown = "flown" if o.flown else "NOT FLOWN"
        truth = anomaly_mod.BY_ID[o.anomaly_id].get("ground_truth")
        print(
            f"  {o.anomaly_id:<22} {flown:<10} attempts={o.attempts}  "
            f"-> {o.triage['decision'].upper():<12} [{o.triage['severity']}]"
        )
        print(f"     {o.triage['title']}")
        print(f"     ground truth was: {truth}")
    print(RULE)
    print(f"  reports: runs/reports/    events: {events_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
