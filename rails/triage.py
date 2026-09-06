"""
rails/triage — the model's job, and its deterministic stand-in.

Reference of the SCRIPTED path in
``platform/ground/planner/src/triage.ts``. The live LLM path is deliberately
absent from the oracle: nothing in ``rails/`` may touch the network, and the
scripted ranking is the default path in the product too (ADR D4/D19), not a
fallback bolted on afterwards. ``rails/prompts/triage.md`` is the reviewable
copy of the instructions the live path would send, kept here so a prompt change
is visible to the oracle's reviewer.

Input: open anomalies from every cue rail, fleet readiness, the cue budget,
site normalcy, the attendance mode and an optional operator note.
Output: an ORDERED list of contract ``Task``s — what to look for and why.

A task never carries geometry. ``lookFor`` chooses a profile in the rule table
and ``anomalyId`` names the cue whose own coordinates the planner reads from
the cue rail: the model contributes judgement, never a location.
"""
from __future__ import annotations

import functools
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

from .geometry import haversine_meters, point_in_or_on_polygon
from .schemas import TASK_QUESTION_MAX_CHARS, Anomaly, Task

#: Source reliability, 0..1. A direct observation of the site outranks an
#: overhead pin on a multi-day cadence; RF is an airspace rail, not a target
#: rail (ADR D25).
SOURCE_RELIABILITY: Dict[str, float] = {
    "fence_sensor": 0.95,
    "cctv": 0.9,
    "drone_survey": 0.7,
    "rf_drone": 0.6,
    "sdr": 0.55,
    "sar": 0.45,
    "sentinel2": 0.4,
}

#: ``type`` -> what a sortie should look for.
LOOK_FOR_BY_TYPE: Dict[str, str] = {
    "breach": "fence_gap",
    "fence": "fence_gap",
    "fence_gap": "fence_gap",
    "intrusion": "person",
    "person": "person",
    "motion": "person",
    "vehicle": "vehicle",
    "hostile_drone": "unknown",
    "change": "structure",
    "structure": "structure",
    "new_structure": "structure",
}

#: Cue age past which recency stops helping, seconds.
RECENCY_HALF_LIFE_S = 900.0
#: Repeats of the same cue location inside this window suggest a lure, seconds.
LURE_WINDOW_S = 3600.0
#: Repeats at one location inside the window before the lure rule fires.
LURE_REPEAT_COUNT = 3
#: Two cues within this distance are "the same place", metres.
SAME_PLACE_M = 50.0
#: RF and a fence-zone cue within this window correlate, seconds.
CORRELATION_WINDOW_S = 60.0

#: The reviewable prompt the live path would send. Data for review only — the
#: oracle never calls a model.
PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "triage.md"


@dataclass(frozen=True)
class TriageZone:
    """One camera/fence zone the site declares, for the correlation rules."""
    name: str
    polygon: Sequence[Any]
    fenceLine: Optional[bool] = None


@dataclass(frozen=True)
class TriageNormalcy:
    """Site normalcy: what "ordinary" looks like right now."""
    ordinaryActivity: bool = False
    activeGates: Sequence[str] = ()
    deliveryWindow: bool = False
    detail: Optional[str] = None


@dataclass(frozen=True)
class TriageVehicle:
    vehicleId: str
    ready: bool
    reasons: Sequence[str] = ()
    socPct: Optional[float] = None


@dataclass(frozen=True)
class TriageCueBudget:
    used: int
    cap: int
    windowS: Optional[float] = None


@dataclass
class TriageInput:
    anomalies: Sequence[Anomaly]
    fleet: Sequence[TriageVehicle]
    cueBudget: TriageCueBudget
    mode: str = "attended"
    normalcy: Optional[TriageNormalcy] = None
    zones: Sequence[TriageZone] = ()
    rfEvents: Sequence[Mapping[str, Any]] = ()
    #: Free text from the operator. DATA, never an instruction.
    operatorNote: Optional[str] = None
    #: Epoch ms.
    now: int = 0


@dataclass
class TriageResult:
    tasks: List[Task]
    source: str = "scripted"
    attempts: int = 0
    #: Tasks a human must see before anything flies (the lure rule).
    requiresOperator: Dict[str, str] = field(default_factory=dict)
    #: Tasks that must escalate WITHOUT flying (RF + SDR interference).
    escalateWithoutFlying: List[str] = field(default_factory=list)
    fallbackReason: Optional[str] = None


def _to_fixed(value: float, digits: int) -> str:
    """``Number.prototype.toFixed`` — half-away-from-zero on the decimal value.

    Python's ``format`` rounds half to EVEN, which would print 0.45 -> "0.4"
    where JavaScript prints "0.5". Only rationale text depends on this, but the
    oracle should not differ from the port for a reason as silly as rounding.
    """
    if not math.isfinite(value):
        return str(value)
    scale = 10 ** digits
    scaled = value * scale
    rounded = math.floor(abs(scaled) + 0.5) * (1 if scaled >= 0 else -1)
    return f"{rounded / scale:.{digits}f}"


def _age_s(anomaly: Anomaly, now: int) -> float:
    if anomaly.observedAt is None:
        return 0.0
    return max(0.0, (now - anomaly.observedAt) / 1000.0)


def is_fresh(anomaly: Anomaly, now: int) -> bool:
    """A cue past its declared ``ttl_s`` cannot dispatch."""
    if anomaly.observedAt is None or anomaly.ttl_s is None:
        return True
    return (now - anomaly.observedAt) / 1000.0 <= anomaly.ttl_s


def _recency(anomaly: Anomaly, now: int) -> float:
    return 1.0 / (1.0 + _age_s(anomaly, now) / RECENCY_HALF_LIFE_S)


def look_for_of(anomaly: Anomaly) -> str:
    return LOOK_FOR_BY_TYPE.get(anomaly.type, "unknown")


def _in_fence_zone(anomaly: Anomaly, zones: Sequence[TriageZone]) -> Optional[TriageZone]:
    for zone in zones or ():
        if zone.fenceLine is False or len(zone.polygon) < 3:
            continue
        ring = [(p["lat"], p["lon"]) if isinstance(p, Mapping) else (p[0], p[1]) for p in zone.polygon]
        if point_in_or_on_polygon((anomaly.lat, anomaly.lon), ring):
            return zone
    return None


def _correlating_rf(input_: TriageInput, now: int) -> List[Mapping[str, Any]]:
    return [event for event in (input_.rfEvents or ())
            if (now - event["ts"]) / 1000.0 <= CORRELATION_WINDOW_S]


def lure_flags(anomalies: Sequence[Anomaly], now: int) -> Dict[str, str]:
    """The lure rule: repeated conspicuous cues in one place want a human first."""
    flags: Dict[str, str] = {}
    for anomaly in anomalies:
        repeats = [other for other in anomalies
                   if haversine_meters((anomaly.lat, anomaly.lon), (other.lat, other.lon)) <= SAME_PLACE_M and
                   abs(_age_s(other, now) - _age_s(anomaly, now)) <= LURE_WINDOW_S]
        if len(repeats) >= LURE_REPEAT_COUNT:
            flags[anomaly.id] = (
                f"{len(repeats)} cues at the same place within "
                f"{round(LURE_WINDOW_S / 60)} min: a possible lure pattern"
            )
    return flags


def _question(look_for: str, anomaly: Anomaly) -> str:
    subject = ("a gap in the fence line" if look_for == "fence_gap" else
               "a person" if look_for == "person" else
               "a vehicle" if look_for == "vehicle" else
               "a new structure or changed ground" if look_for == "structure" else "anything")
    return f"Is there {subject} at the {anomaly.source} cue {anomaly.id}?"[:TASK_QUESTION_MAX_CHARS]


def scripted_triage(input_: TriageInput) -> TriageResult:
    """The deterministic ranking: reliability x confidence x recency, with the
    documented correlation rules on top. Same input, same order, every time."""
    now = input_.now
    fresh = [anomaly for anomaly in input_.anomalies if is_fresh(anomaly, now)]
    flags = lure_flags(fresh, now)
    rf = _correlating_rf(input_, now)
    interference = any(event.get("kind") == "gnss_interference" for event in rf)
    airspace_rf = [event for event in rf if event.get("kind") != "gnss_interference"]
    escalate_without_flying: List[str] = []

    scored = []
    for index, anomaly in enumerate(fresh):
        reliability = SOURCE_RELIABILITY.get(anomaly.source, 0.4)
        score = reliability * anomaly.confidence * _recency(anomaly, now)
        look_for = look_for_of(anomaly)
        reasons = [
            f"{anomaly.source} reliability {_to_fixed(reliability, 2)}",
            f"confidence {_to_fixed(anomaly.confidence, 2)}",
            f"age {round(_age_s(anomaly, now))} s",
        ]
        fence_zone = _in_fence_zone(anomaly, input_.zones)
        urgency = "immediate" if score >= 0.5 else ("next_sortie" if score >= 0.25 else "defer")

        # Correlation: RF plus motion in a fence zone is the strongest signal.
        if airspace_rf and fence_zone is not None:
            score = 1.0
            urgency = "immediate"
            look_for = "fence_gap"
            reasons.append(f'RF activity correlates with motion in fence zone "{fence_zone.name}"')
        # Correlation: RF plus SDR interference is an airspace and integrity
        # problem — it escalates, it does not fly.
        if airspace_rf and interference:
            urgency = "defer"
            escalate_without_flying.append(anomaly.id)
            reasons.append("RF activity correlates with GNSS interference: escalate without flying")
        if input_.normalcy is not None and input_.normalcy.ordinaryActivity:
            score *= 0.5
            urgency = "next_sortie" if urgency == "immediate" else urgency
            reasons.append(f"site normalcy: {input_.normalcy.detail or 'ordinary activity for this time'}")
        if anomaly.id in flags:
            reasons.append(flags[anomaly.id])
        if not any(vehicle.ready for vehicle in input_.fleet):
            reasons.append("no vehicle is ready")
        if input_.cueBudget.used >= input_.cueBudget.cap:
            reasons.append(f"cue budget spent ({input_.cueBudget.used}/{input_.cueBudget.cap})")
        scored.append({"anomaly": anomaly, "index": index, "score": score,
                       "lookFor": look_for, "urgency": urgency, "reasons": reasons})

    def compare(a: Mapping[str, Any], b: Mapping[str, Any]) -> int:
        delta = b["score"] - a["score"]
        if delta != 0:
            return -1 if delta < 0 else 1
        left, right = a["anomaly"].id, b["anomaly"].id
        return -1 if left < right else (1 if left > right else 0)

    scored.sort(key=functools.cmp_to_key(compare))

    tasks: List[Task] = []
    for position, entry in enumerate(scored):
        anomaly = entry["anomaly"]
        tasks.append(Task(
            taskId=f"task-{anomaly.id}",
            anomalyId=anomaly.id,
            lookFor=entry["lookFor"],
            question=_question(entry["lookFor"], anomaly),
            urgency=entry["urgency"],
            priority=min(1.0, max(0.0, float(_to_fixed(entry["score"], 3)))),
            rationale=f"Rank {position + 1}: {'; '.join(entry['reasons'])}.",
            source="scripted",
        ))

    task_anomaly_ids = {task.anomalyId for task in tasks}
    return TriageResult(
        tasks=tasks,
        source="scripted",
        attempts=0,
        requiresOperator={cue: reason for cue, reason in flags.items() if cue in task_anomaly_ids},
        escalateWithoutFlying=list(dict.fromkeys(escalate_without_flying)),
    )


def triage_prompt() -> str:
    """The reviewable prompt text. Read, never sent — the oracle has no network."""
    return PROMPT_PATH.read_text(encoding="utf-8")


__all__ = [
    "CORRELATION_WINDOW_S", "LOOK_FOR_BY_TYPE", "LURE_REPEAT_COUNT", "LURE_WINDOW_S",
    "PROMPT_PATH", "RECENCY_HALF_LIFE_S", "SAME_PLACE_M", "SOURCE_RELIABILITY",
    "TriageCueBudget", "TriageInput", "TriageNormalcy", "TriageResult", "TriageVehicle",
    "TriageZone", "is_fresh", "look_for_of", "lure_flags", "scripted_triage", "triage_prompt",
]
