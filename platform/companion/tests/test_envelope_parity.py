"""
PARITY -- control/envelope.py against the ``rails/`` oracle.

``rails/`` (repo root) holds a second, independent implementation of the ADR
D21/D22 envelope policy, written from the ADR and importing nothing from
``platform/``. ``rails/eval_envelope.py`` carries twenty trajectories generated
deterministically (a fixed-seed LCG, not ``random``, so the set does not move
with a CPython release) as PLAIN WIRE-SHAPED DATA: a corridor, a site geometry,
a set of limits and 160 samples at 20 Hz each.

This module builds a companion :class:`EnvelopeMonitor` from exactly that data,
runs it tick for tick, and compares the resulting state sequence against the
oracle's. Compared per tick:

    state, constraint, action, base_action, wire_action, escalated,
    margin (within 1 mm / 1 ms), margin_unit, speed_scale, back_off_m,
    breach_duration_s, suspended

Between them the trajectories exercise nominal flight, warning-and-slow drift,
the 2x-tolerance hold, altitude excursions both ways, a geofence-margin RTL, an
NFZ buffer breach and the legal overflight above its ceiling, a standoff dip,
sortie exhaustion, peer separation fresh / stale / past the 10 s hold, orbit
radial drift, the 5 s escalation dwell, hysteretic recovery, and a suspended
breach that still latches.

A MISMATCH IS A BUG IN THE COMPANION, not a reason to edit the oracle.

The oracle is imported from the repo root, four directories above this file. If
``rails/`` is absent the suite fails rather than skipping: a parity harness
that quietly does nothing is worse than none.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from eis_companion.control.envelope import (          # noqa: E402
    Corridor,
    EnvelopeLimits,
    EnvelopeMonitor,
    EnvelopeSample,
    MonitoredZone,
    PeerSample,
    SiteGeometry,
)

try:
    from rails import eval_envelope as rails_eval_envelope   # noqa: E402
except ImportError as error:                                 # pragma: no cover - a broken checkout
    raise RuntimeError(
        f"the rails oracle is missing or unimportable at {REPO_ROOT / 'rails'} ({error}). "
        "Envelope parity does not skip: a harness that quietly does nothing is worse than none."
    ) from error

#: Distance/seconds tolerance on a compared margin. The two implementations do
#: the same arithmetic in the same order, so anything above float noise is a
#: real divergence.
MARGIN_TOL = 1e-3

TRAJECTORIES: List[Dict[str, Any]] = rails_eval_envelope.build_trajectories()
TRAJECTORY_IDS = [trajectory["id"] for trajectory in TRAJECTORIES]


# ---------------------------------------------------------------------------
# Building the COMPANION monitor from the oracle's plain trajectory data
# ---------------------------------------------------------------------------
def _optional_float(value: Any) -> float:
    """``None`` means "does not apply this tick" and reads as ``inf``."""
    return math.inf if value is None else float(value)


def _sample(raw: Dict[str, Any]) -> EnvelopeSample:
    return EnvelopeSample(
        t_s=float(raw["t_s"]),
        lat=float(raw["lat"]),
        lon=float(raw["lon"]),
        rel_alt_m=float(raw["rel_alt_m"]),
        airborne=bool(raw.get("airborne", True)),
        standoff_m=_optional_float(raw.get("standoff_m")),
        sortie_elapsed_s=float(raw.get("sortie_elapsed_s", 0.0)),
        sortie_cap_s=_optional_float(raw.get("sortie_cap_s")),
    )


def _peer(raw: Optional[Dict[str, Any]]) -> Optional[PeerSample]:
    if raw is None:
        return None
    return PeerSample(
        vehicle_id=str(raw.get("vehicle_id", "")),
        lat=float(raw["lat"]),
        lon=float(raw["lon"]),
        rel_alt_m=float(raw.get("rel_alt_m", 0.0)),
        age_s=_optional_float(raw.get("age_s")),
        valid=bool(raw.get("valid", True)),
    )


def _geometry(raw: Dict[str, Any]) -> SiteGeometry:
    return SiteGeometry(
        geofence=tuple((float(p[0]), float(p[1])) for p in raw.get("geofence") or ()),
        nfz=tuple(
            MonitoredZone(
                name=str(zone.get("name", "")),
                polygon=tuple((float(p[0]), float(p[1])) for p in zone.get("polygon") or ()),
                ceiling_m=_optional_float(zone.get("ceiling_m")),
            )
            for zone in raw.get("nfz") or ()
        ),
        nfz_buffer_m=float(raw.get("nfz_buffer_m", 25.0)),
    )


def _state(decision: Any) -> Dict[str, Any]:
    """One tick of the comparable state, in the oracle's own shape."""
    margin = decision.margin_m
    return {
        "state": decision.state,
        "constraint": decision.constraint,
        "action": decision.action,
        "base_action": decision.base_action,
        "wire_action": decision.wire_action,
        "escalated": bool(decision.escalated),
        "margin_m": None if not math.isfinite(margin) else float(margin),
        "margin_unit": decision.margin_unit,
        "speed_scale": float(decision.speed_scale),
        "back_off_m": float(decision.back_off_m),
        "breach_duration_s": float(decision.breach_duration_s),
        "suspended": bool(decision.suspended),
    }


def run_companion(trajectory: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Drive the COMPANION's monitor over one recorded trajectory."""
    corridor = Corridor.from_wire(trajectory["corridor"])
    monitor = EnvelopeMonitor(
        EnvelopeLimits(**trajectory["limits"]),
        corridor=corridor,
        geometry=_geometry(trajectory["geometry"]),
    )
    monitor.arm(corridor)
    monitor.set_geometry(_geometry(trajectory["geometry"]))
    states: List[Dict[str, Any]] = []
    for raw in trajectory["samples"]:
        decision = monitor.update(
            _sample(raw),
            peer=_peer(raw.get("peer")),
            suspended=bool(raw.get("suspended", False)),
        )
        states.append({"t_s": raw["t_s"], **_state(decision)})
    return states


# ---------------------------------------------------------------------------
# The comparison
# ---------------------------------------------------------------------------
def _assert_tick_matches(ours: Dict[str, Any], theirs: Dict[str, Any], where: str) -> None:
    for key in ("state", "constraint", "action", "base_action", "wire_action",
                "escalated", "margin_unit", "suspended"):
        assert ours[key] == theirs[key], f"{where}: {key} {ours[key]!r} vs oracle {theirs[key]!r}"
    for key in ("margin_m", "speed_scale", "back_off_m", "breach_duration_s"):
        mine, other = ours[key], theirs[key]
        if mine is None or other is None:
            assert mine == other, f"{where}: {key} {mine!r} vs oracle {other!r}"
            continue
        assert abs(mine - other) <= MARGIN_TOL, \
            f"{where}: {key} {mine!r} vs oracle {other!r}"


def test_the_oracle_offers_twenty_recorded_trajectories():
    assert len(TRAJECTORIES) == rails_eval_envelope.TRAJECTORY_COUNT == 20
    assert len(set(TRAJECTORY_IDS)) == 20
    for trajectory in TRAJECTORIES:
        assert len(trajectory["samples"]) == rails_eval_envelope.SAMPLE_COUNT
        assert trajectory["description"]


@pytest.mark.parametrize("trajectory", TRAJECTORIES, ids=TRAJECTORY_IDS)
def test_companion_matches_the_oracle_state_sequence(trajectory):
    ours = run_companion(trajectory)
    theirs = rails_eval_envelope.run_trajectory(trajectory)
    assert len(ours) == len(theirs)
    for index, (mine, other) in enumerate(zip(ours, theirs)):
        assert mine["t_s"] == other["t_s"]
        _assert_tick_matches(mine, other, f"{trajectory['id']} tick {index} (t={mine['t_s']} s)")


def test_the_trajectories_cover_every_constraint_and_every_action():
    constraints = set()
    actions = set()
    for trajectory in TRAJECTORIES:
        for state in run_companion(trajectory):
            if state["constraint"]:
                constraints.add(state["constraint"])
            actions.add(state["action"])
    assert {"corridor", "altitude", "geofence", "nfz",
            "standoff", "separation", "sortie"} <= constraints
    assert {"none", "slow", "hold", "rtl", "escalate"} <= actions


def test_the_recorded_trajectories_are_reproducible():
    """The set is data, not a sample: generating it twice must give one answer."""
    again = rails_eval_envelope.build_trajectories()
    assert again == TRAJECTORIES
