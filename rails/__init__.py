"""
rails — the executable ORACLE for the deterministic trust layer.

``rails/`` is a second, independent implementation of the rules that decide
whether a mission may fly: the geometry, the deterministic planner, the
verifier, the scripted triage ranking and the runtime envelope monitor's
policy. It is written in Python, from the ADR and the contract, and it imports
NOTHING from ``platform/`` — a shared import would make a parity run
tautological.

Its job is to disagree. ``platform/ground/planner`` (TypeScript) and
``platform/companion`` (Python) are the PORTS; a parity harness runs the same
inputs through both and compares. When they differ, the port is wrong and the
port is what changes. The oracle is edited only when it is provably wrong
against the specification — and then before the first green run, never after,
so a passing parity run always means "two implementations agree", not "the
oracle was moved until it did".

Modules
-------
``policy``        the constant table (profiles, hard limits, envelopes)
``schemas``       Pydantic mirrors of the contract's planning slice
``site``          the site model, per ``platform/docs/SITE_CONTRACT.md``
``geometry``      the one geometry library the planner and verifier share
``deterministic`` the rule table: task + site + state -> plan | infeasible
``verifier``      the twenty ordered checks and the correction path
``triage``        the scripted cue ranking (no network, ever)
``envelope``      the runtime monitor's policy, independently derived
``scripted``      the EIS_TEST_BAD_PLAN rail — never a plan source
``eval_planner``  every fixture state through the planner and the verifier
``eval_envelope`` recorded trajectories through the monitor
"""

__all__ = [
    "deterministic", "envelope", "eval_envelope", "eval_planner", "geometry", "policy",
    "schemas", "scripted", "site", "triage",
]
