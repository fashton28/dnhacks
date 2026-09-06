"""
rails/policy — the reviewable constant table the oracle plans and judges with.

Mirrors ``platform/ground/planner/src/policy.ts``, which is itself the mirror of
``platform/verifier_fixtures/profiles.json`` and ``range_model.json``. Nothing
here is imported from ``platform/``: the oracle is a SECOND implementation, and
a shared import would make a parity run tautological.

Every value below TIGHTENS or restates a limit that exists elsewhere. None of
them relaxes one, and no code path in ``rails/`` may lower a floor at runtime.
"""
from __future__ import annotations

from typing import Dict, Literal

MissionProfile = Literal["follow", "inspect", "survey", "slow", "standard", "fast"]
CanonicalProfile = Literal["follow", "inspect", "survey"]

#: Cruise speed per profile, m/s (contract ``PROFILE_SPEED_MPS``). Every value
#: stays under the companion's 8 m/s hard cap.
PROFILE_SPEED_MPS: Dict[str, float] = {
    "follow": 2.0,
    "inspect": 4.0,
    "survey": 6.0,
    "slow": 2.0,
    "standard": 4.0,
    "fast": 6.0,
}

#: Hard limits + the range model (verifier_fixtures/range_model.json).
VERIFIER_POLICY = {
    "hardMinStandoffM": 3.0,
    "hardMaxSpeedMps": 8.0,
    "nominalEnduranceS": 1500.0,
    "reservePct": 25.0,
    "windTimeFactorPerMps": 0.05,
    "maxWindMps": 12.0,
    "anomalyProximityM": 200.0,
    "maxSortieS": 480.0,
    "dispatchMinSocPct": 80.0,
    "cellImbalanceMaxV": 0.1,
    "battTempMaxC": 60.0,
}

#: Per-profile caps (verifier_fixtures/profiles.json).
PROFILE_POLICY: Dict[str, Dict[str, float]] = {
    "follow": {"maxSpeedMps": 2.0, "maxAltitudeM": 50.0, "standoffM": 8.0, "maxSortieS": 480.0},
    "inspect": {"maxSpeedMps": 4.0, "maxAltitudeM": 45.0, "standoffM": 5.0, "maxSortieS": 480.0},
    "survey": {"maxSpeedMps": 6.0, "maxAltitudeM": 60.0, "standoffM": 8.0, "maxSortieS": 480.0},
    "slow": {"maxSpeedMps": 2.0, "maxAltitudeM": 50.0, "standoffM": 8.0, "maxSortieS": 480.0},
    "standard": {"maxSpeedMps": 4.0, "maxAltitudeM": 45.0, "standoffM": 5.0, "maxSortieS": 480.0},
    "fast": {"maxSpeedMps": 6.0, "maxAltitudeM": 60.0, "standoffM": 8.0, "maxSortieS": 480.0},
}

#: Compatibility profile names resolve to the canonical three (ADR D13).
PROFILE_ALIASES: Dict[str, str] = {
    "follow": "follow", "inspect": "inspect", "survey": "survey",
    "slow": "follow", "standard": "inspect", "fast": "survey",
}


def canonical_profile(profile: str) -> str:
    """``standard`` -> ``inspect``, ``fast`` -> ``survey``, ``slow`` -> ``follow``."""
    return PROFILE_ALIASES[profile]


#: ADR D23 — the envelope that applies when nobody is watching. Every entry is
#: a strict tightening of an attended limit.
UNATTENDED_ENVELOPE = {
    "containment": "perimeter",
    "profile": "inspect",
    "altBandM": {"min": 30.0, "max": 50.0},
    "maxLaps": 1,
    "maxHoldS": 15.0,
    "maxSortiesPerHour": 2,
    "maxWindMps": 6.0,
}

#: ADR D21 — the corridor, not the waypoint list, is what the monitor checks.
CORRIDOR_POLICY = {
    "lateralTolInspectM": 10.0,
    "lateralTolSurveyM": 15.0,
    "radialTolM": 5.0,
}

#: ADR D21 / D26 — inter-vehicle separation, star topology, two vehicles.
DECONFLICTION_POLICY = {
    "minSeparationM": 40.0,
    "staleSeparationM": 80.0,
    "stalePeerS": 3.0,
    "holdPeerS": 10.0,
    "altitudeStaggerM": 10.0,
    "sharedOrbitCentreM": 10.0,
    "dispatchDelayMarginS": 30.0,
}

#: ADR D20 — the deterministic planner's shape policy. Orbit radii are the
#: REQUESTED radius; geometry shrinks them and never below the standoff floor.
PLANNER_POLICY = {
    "orbitRadiusM": {
        "follow": 15.0, "inspect": 25.0, "survey": 40.0,
        "slow": 15.0, "standard": 25.0, "fast": 40.0,
    },
    "laps": 1,
    "fenceGapHoldS": 15.0,
}

__all__ = [
    "CORRIDOR_POLICY",
    "DECONFLICTION_POLICY",
    "PLANNER_POLICY",
    "PROFILE_ALIASES",
    "PROFILE_POLICY",
    "PROFILE_SPEED_MPS",
    "UNATTENDED_ENVELOPE",
    "VERIFIER_POLICY",
    "canonical_profile",
]
