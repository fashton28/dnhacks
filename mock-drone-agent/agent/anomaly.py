"""Mock satellite change-detection layer.

Stands in for the real wide-area layer (Sentinel-2 before/after tiles) so the
drone agent can be developed and demoed before that layer exists. Swap this for
the real detector by producing the same anomaly dict — see `contracts/events.md`.

Each catalogue entry carries a `ground_truth` field: what is *actually* at that
coordinate. The LLM never sees it (`for_llm` strips it); it exists so the
simulation can synthesize sensor readings that are consistent with reality, and
so we can score whether triage got the answer right.
"""

from __future__ import annotations

import random
from typing import Any

from .types import make_anomaly

# ground_truth values the simulation and triage scoring both understand.
GROUND_TRUTHS = ("fence_cut", "intruder", "vehicle_authorized", "equipment_fault", "nothing")

CATALOGUE: list[dict[str, Any]] = [
    make_anomaly(
        "fence-breach-01",
        39.9531,
        -75.1901,
        "Fence-line discontinuity along the north perimeter. NIR band shows a ~2 m gap in the "
        "fence signature that was not present in the previous pass 5 days ago; a small dark "
        "object sits immediately inside the line.",
        confidence=0.78,
        ground_truth="fence_cut",
    ),
    make_anomaly(
        "vehicle-cluster-02",
        39.9471,
        -75.1875,
        "Three new bright rectangular objects, roughly 5 x 2 m each, in the south-east service "
        "lot. Lot was empty in the previous pass. Consistent with parked vehicles.",
        confidence=0.64,
        ground_truth="vehicle_authorized",
    ),
    make_anomaly(
        "thermal-hotspot-03",
        39.9512,
        -75.1885,
        "Thermal band anomaly on the north-west edge of the transformer bank: +11 K against the "
        "site baseline, persistent across two consecutive night passes.",
        confidence=0.81,
        ground_truth="equipment_fault",
    ),
    make_anomaly(
        "structure-change-04",
        39.9525,
        -75.1935,
        "New 8 x 4 m dark rectangle north-west of the control building, absent from the previous "
        "pass. Could be a new structure, a delivered container, or a shadow artifact from the "
        "lower sun angle.",
        confidence=0.52,
        ground_truth="nothing",
    ),
    make_anomaly(
        # Deliberately outside the geofence: no legal mission exists. The trust
        # layer must refuse to fly and escalate to a human instead.
        "offsite-activity-05",
        39.9556,
        -75.1901,
        "Vehicle track marks and a stationary object on the access road roughly 180 m north of "
        "the facility boundary, oriented toward the north perimeter gate.",
        confidence=0.69,
        ground_truth="intruder",
    ),
]

BY_ID = {a["anomaly_id"]: a for a in CATALOGUE}


def get(anomaly_id: str) -> dict[str, Any]:
    if anomaly_id not in BY_ID:
        raise KeyError(
            f"unknown anomaly {anomaly_id!r}. Available: {', '.join(sorted(BY_ID))}"
        )
    return dict(BY_ID[anomaly_id])


def sample(n: int = 1, seed: int | None = None) -> list[dict[str, Any]]:
    """Pick `n` anomalies at random, as the satellite layer would deliver them."""
    rng = random.Random(seed)
    return [dict(a) for a in rng.sample(CATALOGUE, min(n, len(CATALOGUE)))]


def for_llm(anomaly: dict[str, Any]) -> dict[str, Any]:
    """The anomaly with the answer key removed. Always use this at a model boundary."""
    return {k: v for k, v in anomaly.items() if k != "ground_truth"}
