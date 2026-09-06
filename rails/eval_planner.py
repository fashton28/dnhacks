"""
rails/eval_planner — run the ORACLE over every verifier fixture.

Two things happen for each of ``platform/verifier_fixtures/V*.json``:

1. the fixture's own ``plan`` goes through the oracle's verifier, producing a
   verdict, the set of non-pass check names, whether the outcome requires an
   operator, and — when the verdict is ``corrected`` — the corrected tool
   sequence;
2. the fixture's runtime STATE goes through the oracle's deterministic planner,
   which must answer with a plan the verifier PASSES, or an explicit
   ``infeasible``. **Never something to correct.** A ``corrected`` verdict on
   planner output would mean the planner emitted a plan that violates a limit
   and was rescued by the verifier, which is exactly the failure mode the
   deterministic rule table exists to make impossible. That assertion is
   enforced here: the process exits non-zero when it is violated.

``--json`` dumps the whole thing as one JSON document on stdout. That document
is the PARITY SURFACE: ``platform/ground/planner/test/parity.test.ts`` runs the
same fixtures through the TypeScript planner and verifier and compares, field
for field. Anything printed outside ``--json`` is for humans and is not
compared.

``requiresOperator`` is derived identically on both sides, from two facts the
verifier already reports:

    requiresOperator = (the `attended` check failed)  OR
                       (the runtime context carries requiresOperator)

— the unattended envelope refusing a dispatch, or triage's lure flag naming a
cue a human should see first (docs/THREAT_MODEL.md § A6.2).

Usage::

    python rails/eval_planner.py            # human summary
    python rails/eval_planner.py --json     # the parity document
    python rails/eval_planner.py --json V10 V36
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

if __package__ in (None, ""):                     # `python rails/eval_planner.py`
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rails.deterministic import PlannedMission, plan_mission
from rails.schemas import Anomaly, Task
from rails.site import SiteModel, validate_site
from rails.verifier import Verification, verify_mission

#: Repo root — ``rails/`` sits directly beneath it.
REPO_ROOT = Path(__file__).resolve().parents[1]
#: The fixture directory. Fixture ``site`` paths resolve relative to it.
FIXTURE_ROOT = REPO_ROOT / "platform" / "verifier_fixtures"

#: Keys of ``baseline_context.json`` a fixture patches ONE LEVEL DEEP, so a
#: case can change a single SoC or sensor field without restating a whole
#: healthy vehicle. Every other key is replaced outright.
DEEP_MERGED = ("battery", "readiness", "sensors", "anomaly")

_FIXTURE_ID = re.compile(r"^V\d\d\.json$")


# ---------------------------------------------------------------------------
# Fixture loading
# ---------------------------------------------------------------------------
def read_json(name: str) -> Any:
    return json.loads((FIXTURE_ROOT / name).read_text(encoding="utf-8"))


def fixture_ids() -> List[str]:
    return sorted(path.stem for path in FIXTURE_ROOT.iterdir() if _FIXTURE_ID.match(path.name))


def build_context(telemetry: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    """A case's ``telemetry`` block merged over ``baseline_context.json``."""
    baseline = dict(read_json("baseline_context.json"))
    baseline.pop("_fixture", None)
    for key, value in (telemetry or {}).items():
        if key in DEEP_MERGED and isinstance(value, Mapping):
            merged = dict(baseline.get(key) or {})
            merged.update(value)
            baseline[key] = merged
        else:
            baseline[key] = value
    return baseline


def site_for(fixture: Mapping[str, Any]) -> SiteModel:
    """The fixture's site, with its ``siteOverride`` applied AFTER validation."""
    path = (FIXTURE_ROOT / fixture["site"]).resolve()
    loaded = validate_site(json.loads(path.read_text(encoding="utf-8")))
    return loaded.with_override(fixture.get("siteOverride"))


def probe_task(fixture: Mapping[str, Any], anomaly: Anomaly) -> Task:
    """The task the fixture state is planned for.

    A fixture carries its own ``probeTask`` so the oracle and the port read
    literally the same input rather than each constructing a probe of its own.
    """
    raw = fixture.get("probeTask")
    if raw is None:
        raise ValueError(
            f"fixture {fixture['id']} carries no probeTask; every fixture must declare the "
            "task its runtime state is planned for (see verifier_fixtures/README.md)"
        )
    return Task.model_validate({**raw, "anomalyId": raw.get("anomalyId") or anomaly.id})


def probe_request_id(fixture: Mapping[str, Any]) -> str:
    return fixture.get("probeRequestId") or f"probe-{fixture['id']}"


# ---------------------------------------------------------------------------
# The parity surface
# ---------------------------------------------------------------------------
def requires_operator(verification: Verification, context: Mapping[str, Any]) -> bool:
    """Does this outcome need a human before anything flies?

    The `attended` check failing IS the unattended refusal; the context flag is
    triage's lure rule. Either one means a person looks first.
    """
    attended_failed = any(check.name == "attended" and not check.ok
                          for check in verification.checks)
    return bool(attended_failed or context.get("requiresOperator"))


def _number(value: Any) -> Any:
    """JSON-safe number: non-finite values never reach the parity document."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value if math.isfinite(value) else str(value)
    return value


def normalise_tools(tools: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """One tool sequence in the shape the parity harness compares.

    Wire aliases (``alt_m``, ``radius_m``, ``duration_s``) collapse onto their
    canonical field: they always carry the same value after validation, and
    comparing both would double-count one number.
    """
    out: List[Dict[str, Any]] = []
    for tool in tools:
        entry: Dict[str, Any] = {"tool": tool["tool"]}
        for key in ("lat", "lon", "alt", "radius", "laps", "durationS", "speed_mps", "profile"):
            if tool.get(key) is not None:
                entry[key] = _number(tool[key])
        out.append(entry)
    return out


def evaluate_fixture(fixture: Mapping[str, Any]) -> Dict[str, Any]:
    """The oracle's answer for one fixture, as the parity document carries it."""
    site = site_for(fixture)
    context = build_context(fixture.get("telemetry"))
    anomaly = Anomaly.model_validate(context["anomaly"])

    verification = verify_mission(fixture["plan"], site, context)
    verify_block = {
        "verdict": verification.verdict,
        "requiresOperator": requires_operator(verification, context),
        "failingChecks": verification.failing_checks,
        "correctedTools": (normalise_tools(verification.correctedPlan.tools)
                           if verification.correctedPlan is not None else None),
        "holdUntil": verification.holdUntil,
    }

    planned: PlannedMission = plan_mission(
        task=probe_task(fixture, anomaly), anomaly=anomaly, site=site, context=context,
        request_id=probe_request_id(fixture),
    )
    if planned.infeasible:
        plan_block: Dict[str, Any] = {
            "infeasible": True,
            "reason": planned.reason,
            "planTraceRules": planned.trace_rules,
            "verdict": None,
            "requiresOperator": None,
            "tools": None,
            "profile": None,
        }
    else:
        replanned = verify_mission(planned.plan, site, context)
        plan_block = {
            "infeasible": False,
            "reason": None,
            "planTraceRules": planned.trace_rules,
            "verdict": replanned.verdict,
            "requiresOperator": requires_operator(replanned, context),
            "tools": normalise_tools(planned.plan.tools),
            "profile": planned.plan.profile,
        }
    return {"id": fixture["id"], "site": fixture["site"], "verify": verify_block, "plan": plan_block}


def evaluate(ids: Optional[Sequence[str]] = None) -> Dict[str, Any]:
    """Every fixture (or the named ones) through the oracle."""
    selected = list(ids) if ids else fixture_ids()
    results = [evaluate_fixture(read_json(f"{fixture_id}.json")) for fixture_id in selected]

    # THE assertion: the deterministic planner emits a plan the verifier passes,
    # or an explicit infeasible. A `corrected` verdict on planner output is a
    # planner bug and fails this run.
    violations = [
        {"id": entry["id"], "verdict": entry["plan"]["verdict"]}
        for entry in results
        if not entry["plan"]["infeasible"] and entry["plan"]["verdict"] != "pass"
    ]
    infeasible = {entry["id"]: entry["plan"]["reason"]
                  for entry in results if entry["plan"]["infeasible"]}
    verdicts: Dict[str, int] = {}
    for entry in results:
        verdicts[entry["verify"]["verdict"]] = verdicts.get(entry["verify"]["verdict"], 0) + 1
    return {
        "generatedBy": "rails/eval_planner.py",
        "fixtureRoot": str(FIXTURE_ROOT.relative_to(REPO_ROOT)).replace("\\", "/"),
        "assertion": "the deterministic planner emits pass or infeasible, never corrected",
        "fixtures": results,
        "summary": {
            "count": len(results),
            "verifyVerdicts": verdicts,
            "plannerInfeasible": infeasible,
            "violations": violations,
        },
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Run the rails oracle over the verifier fixtures.")
    parser.add_argument("--json", action="store_true", help="emit the parity document on stdout")
    parser.add_argument("ids", nargs="*", help="fixture ids (default: all)")
    args = parser.parse_args(argv)

    document = evaluate(args.ids or None)
    if args.json:
        json.dump(document, sys.stdout, indent=None, sort_keys=False)
        sys.stdout.write("\n")
    else:
        summary = document["summary"]
        for entry in document["fixtures"]:
            plan = entry["plan"]
            answer = f"infeasible ({plan['reason']})" if plan["infeasible"] else plan["verdict"]
            print(f"{entry['id']:>4}  verify={entry['verify']['verdict']:<9} "
                  f"operator={str(entry['verify']['requiresOperator']):<5} "
                  f"failing={','.join(entry['verify']['failingChecks']) or '-':<40} "
                  f"planner={answer}")
        print(f"\n{summary['count']} fixtures; verify verdicts {summary['verifyVerdicts']}; "
              f"{len(summary['plannerInfeasible'])} states refused by the planner")
        if summary["violations"]:
            print(f"ASSERTION FAILED — planner output was not `pass`: {summary['violations']}")
    return 1 if document["summary"]["violations"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
