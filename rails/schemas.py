"""
rails/schemas — Pydantic mirrors of the shared contract's planning slice.

The AUTHORITATIVE contract copy is ``platform/ground/ui/src/contract/index.ts``,
mirrored by ``platform/shared/shared.ts`` and ``platform/shared/shared.py``.
This module mirrors the same shapes a THIRD time, in Pydantic, because the
oracle must be able to reject a malformed plan on its own evidence rather than
by importing the implementation it exists to check.

Only the planning slice lives here — ``MissionPlan``, ``Task``, ``Anomaly``,
``Corridor``, ``Verification`` and ``IncidentReport``. Telemetry, commands and
the cue-rail messages are not part of what the oracle judges.

``validate_mission_plan`` is the reference of
``platform/ground/planner/src/validate.ts``: the ``schema`` check of the
verifier, with the same admitted-tool set and the same alias rules
(``alt``/``alt_m``, ``radius``/``radius_m``, ``durationS``/``duration_s``).
It raises :class:`SchemaError` with a human-readable reason; the reason text is
NOT part of the parity surface, the pass/fail is.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List, Literal, Mapping, Optional, Sequence

from pydantic import BaseModel, ConfigDict, Field

from .policy import PROFILE_SPEED_MPS

MissionProfileT = Literal["follow", "inspect", "survey", "slow", "standard", "fast"]
AnomalySourceT = Literal[
    "sentinel2", "sar", "sdr", "rf_drone", "drone_survey", "cctv", "fence_sensor",
]
TaskLookForT = Literal["person", "vehicle", "fence_gap", "structure", "unknown"]
TaskUrgencyT = Literal["immediate", "next_sortie", "defer"]
TaskSourceT = Literal["llm", "operator", "scripted"]
VerdictT = Literal["pass", "corrected", "rejected"]
IncidentVerdictT = Literal["false_alarm", "log", "escalate"]
NavSourceT = Literal["gps", "optflow", "extnav"]
SensorHealthT = Literal["ok", "degraded", "failed"]
AttendanceModeT = Literal["attended", "unattended"]

#: contract TASK_QUESTION_MAX_CHARS
TASK_QUESTION_MAX_CHARS = 120

#: The tools admitted to a MissionPlan sequence (validate.ts
#: ``MISSION_SEQUENCE_TOOLS``). Moving-track and relative tools stay legal as
#: single planCommands but are not verifiable as a sequence.
MISSION_SEQUENCE_TOOLS = ("goto_gps", "orbit_point", "hold", "rtl")


class SchemaError(ValueError):
    """A plan that is not a well-formed, finite ``MissionPlan``."""


class _Model(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)


# ---------------------------------------------------------------------------
# Geometry-carrying contract types
# ---------------------------------------------------------------------------
class LatLon(_Model):
    lat: float
    lon: float


class AltBand(_Model):
    min: float
    max: float


class CorridorLeg(_Model):
    # "from" is a Python keyword, so the field is named and aliased.
    start: LatLon = Field(alias="from")
    end: LatLon = Field(alias="to")
    lateral_tol_m: float

    def dump(self) -> Dict[str, Any]:
        return {
            "from": {"lat": self.start.lat, "lon": self.start.lon},
            "to": {"lat": self.end.lat, "lon": self.end.lon},
            "lateral_tol_m": self.lateral_tol_m,
        }


class CorridorOrbit(_Model):
    center: LatLon
    radius_m: float
    radial_tol_m: float


class Corridor(_Model):
    """The geometric envelope a verified plan may occupy (ADR D21)."""
    legs: List[CorridorLeg] = Field(default_factory=list)
    orbits: List[CorridorOrbit] = Field(default_factory=list)
    alt_band_m: AltBand
    generated_from: str = ""

    def dump(self) -> Dict[str, Any]:
        return {
            "legs": [leg.dump() for leg in self.legs],
            "orbits": [orbit.model_dump() for orbit in self.orbits],
            "alt_band_m": self.alt_band_m.model_dump(),
            "generated_from": self.generated_from,
        }


class PlanTraceEntry(_Model):
    """One rule that fired, in the order it fired. Reason-for-record only:
    never a coordinate, a tool or an altitude."""
    rule: str
    effect: str


class Anomaly(_Model):
    id: str
    lat: float
    lon: float
    type: str
    confidence: float
    thumbnail: str = ""
    source: AnomalySourceT = "sentinel2"
    observedAt: Optional[int] = None
    ttl_s: Optional[float] = None
    cameraId: Optional[str] = None


class Task(_Model):
    """WHAT to look for and WHY. Never where, how high, or with which tool —
    this is the entire surface a model is allowed to emit."""
    taskId: str
    anomalyId: str
    lookFor: TaskLookForT
    question: str
    urgency: TaskUrgencyT
    priority: float
    rationale: str
    source: TaskSourceT
    assignedTo: Optional[str] = None


# ---------------------------------------------------------------------------
# Plan tools — a dict-shaped union, exactly as the wire carries them.
#
# Tools stay plain dicts inside the oracle rather than becoming model
# instances, because presence-vs-absence of the wire aliases (`alt_m`,
# `radius_m`, `duration_s`) is load-bearing in the verifier's correction path:
# a corrected tool must carry back exactly the aliases the input carried.
# ---------------------------------------------------------------------------
PlanToolDict = Dict[str, Any]


class MissionPlan(_Model):
    requestId: str
    anomalyId: str
    tools: List[PlanToolDict]
    profile: MissionProfileT
    rationale: str
    planTrace: Optional[List[PlanTraceEntry]] = None
    corridor: Optional[Corridor] = None

    def dump(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "requestId": self.requestId,
            "anomalyId": self.anomalyId,
            "profile": self.profile,
            "rationale": self.rationale,
            "tools": [dict(tool) for tool in self.tools],
        }
        if self.planTrace is not None:
            out["planTrace"] = [entry.model_dump() for entry in self.planTrace]
        if self.corridor is not None:
            out["corridor"] = self.corridor.dump()
        return out


class VerificationCheck(_Model):
    name: str
    ok: bool
    reason: str
    edit: Optional[str] = None

    def dump(self) -> Dict[str, Any]:
        out = {"name": self.name, "ok": self.ok, "reason": self.reason}
        if self.edit is not None:
            out["edit"] = self.edit
        return out


class Verification(_Model):
    requestId: str
    verdict: VerdictT
    checks: List[VerificationCheck]
    correctedPlan: Optional[MissionPlan] = None
    holdUntil: Optional[int] = None

    @property
    def failing_checks(self) -> List[str]:
        return [check.name for check in self.checks if not check.ok]

    def dump(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "requestId": self.requestId,
            "verdict": self.verdict,
            "checks": [check.dump() for check in self.checks],
        }
        if self.correctedPlan is not None:
            out["correctedPlan"] = self.correctedPlan.dump()
        if self.holdUntil is not None:
            out["holdUntil"] = self.holdUntil
        return out


class IncidentReport(_Model):
    missionId: str
    verdict: IncidentVerdictT
    markdown: str


# ---------------------------------------------------------------------------
# validate.ts, in Python
# ---------------------------------------------------------------------------
def _is_finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _is_profile(value: Any) -> bool:
    return isinstance(value, str) and value in PROFILE_SPEED_MPS


def _is_int(value: Any) -> bool:
    return _is_finite(value) and float(value) == int(float(value))


def validate_tool(raw: Any, ctx: str) -> PlanToolDict:
    """Reference of ``validate.ts::validateTool``. Raises :class:`SchemaError`."""
    if not isinstance(raw, Mapping):
        raise SchemaError(f"{ctx} must be an object")
    tool = raw.get("tool")

    if tool in ("follow", "orbit"):
        track_id = raw.get("track_id", raw.get("trackId"))
        if not _is_int(track_id) or float(track_id) < 0 or not _is_profile(raw.get("profile")):
            raise SchemaError(f"{ctx} ({tool}) requires numeric track_id and a valid profile")
        out = {"tool": tool, "track_id": track_id, "profile": raw["profile"]}
        if raw.get("trackId") is not None:
            out["trackId"] = track_id
        return out

    if tool == "goto_relative":
        if not (_is_finite(raw.get("dx")) and _is_finite(raw.get("dy")) and _is_finite(raw.get("dz"))):
            raise SchemaError(f"{ctx} (goto_relative) requires numeric dx, dy, dz")
        return {"tool": "goto_relative", "dx": raw["dx"], "dy": raw["dy"], "dz": raw["dz"]}

    if tool == "goto_gps":
        alt_m, alt = raw.get("alt_m"), raw.get("alt")
        if alt_m is not None and alt is not None and alt_m != alt:
            raise SchemaError(f"{ctx} (goto_gps) has conflicting alt and alt_m values")
        altitude = alt_m if alt_m is not None else alt
        lat, lon = raw.get("lat"), raw.get("lon")
        if (not _is_finite(lat) or lat < -90 or lat > 90 or
                not _is_finite(lon) or lon < -180 or lon > 180 or not _is_finite(altitude)):
            raise SchemaError(f"{ctx} (goto_gps) requires numeric lat, lon, alt_m (or legacy alt)")
        if raw.get("profile") is not None and not _is_profile(raw.get("profile")):
            raise SchemaError(f"{ctx} (goto_gps) has invalid profile {raw.get('profile')!r}")
        speed = raw.get("speed_mps")
        if speed is not None and (not _is_finite(speed) or speed <= 0):
            raise SchemaError(f"{ctx} (goto_gps) speed_mps must be positive and finite when present")
        out = {"tool": "goto_gps", "lat": lat, "lon": lon, "alt": altitude}
        if alt_m is not None:
            out["alt_m"] = altitude
        if raw.get("profile") is not None:
            out["profile"] = raw["profile"]
        if speed is not None:
            out["speed_mps"] = speed
        return out

    if tool == "orbit_point":
        radius_m, radius = raw.get("radius_m"), raw.get("radius")
        if radius_m is not None and radius is not None and radius_m != radius:
            raise SchemaError(f"{ctx} (orbit_point) has conflicting radius and radius_m values")
        effective = radius_m if radius_m is not None else radius
        lat, lon = raw.get("lat"), raw.get("lon")
        if (not _is_finite(lat) or lat < -90 or lat > 90 or
                not _is_finite(lon) or lon < -180 or lon > 180 or
                not _is_finite(effective) or effective <= 0):
            raise SchemaError(f"{ctx} (orbit_point) requires numeric lat, lon, radius_m (or legacy radius)")
        laps = raw.get("laps")
        if laps is not None and (not _is_int(laps) or float(laps) <= 0):
            raise SchemaError(f"{ctx} (orbit_point) laps must be a positive integer when present")
        out = {"tool": "orbit_point", "lat": lat, "lon": lon, "radius": effective}
        if radius_m is not None:
            out["radius_m"] = effective
        if laps is not None:
            out["laps"] = laps
        return out

    if tool == "hold":
        duration_s, duration_camel = raw.get("duration_s"), raw.get("durationS")
        if duration_s is not None and duration_camel is not None and duration_s != duration_camel:
            raise SchemaError(f"{ctx} (hold) has conflicting durationS and duration_s values")
        duration = duration_s if duration_s is not None else duration_camel
        if duration is not None and (not _is_finite(duration) or duration < 0):
            raise SchemaError(f"{ctx} (hold) duration_s must be finite and non-negative when present")
        if duration is None:
            return {"tool": "hold"}
        out = {"tool": "hold", "durationS": duration}
        if duration_s is not None:
            out["duration_s"] = duration
        return out

    if tool == "rtl":
        return {"tool": "rtl"}

    raise SchemaError(f"{ctx} has unknown tool {tool!r}")


def validate_mission_plan(data: Any) -> MissionPlan:
    """Reference of ``validate.ts::validateMissionPlan``.

    The returned plan carries ONLY the validated fields — the trace and the
    corridor are deliberately dropped, exactly as the TypeScript does, so a
    verifier never judges geometry that did not survive validation.
    """
    if isinstance(data, MissionPlan):
        data = data.dump()
    if not isinstance(data, Mapping):
        raise SchemaError("invalid MissionPlan: must be an object")
    if not isinstance(data.get("requestId"), str) or data.get("requestId") == "":
        raise SchemaError("invalid MissionPlan: requestId must be a non-empty string")
    if not isinstance(data.get("anomalyId"), str):
        raise SchemaError("invalid MissionPlan: anomalyId must be a string")
    if not _is_profile(data.get("profile")):
        raise SchemaError(
            "invalid MissionPlan: profile must be one of " + "|".join(PROFILE_SPEED_MPS)
        )
    if not isinstance(data.get("rationale"), str):
        raise SchemaError("invalid MissionPlan: rationale must be a string")
    tools_raw = data.get("tools")
    if not isinstance(tools_raw, Sequence) or isinstance(tools_raw, (str, bytes)) or not tools_raw:
        raise SchemaError("invalid MissionPlan: tools must be a non-empty array")
    tools = [validate_tool(tool, f"invalid MissionPlan: tools[{i}]")
             for i, tool in enumerate(tools_raw)]
    for tool in tools:
        if tool["tool"] not in MISSION_SEQUENCE_TOOLS:
            raise SchemaError(
                f"invalid MissionPlan: tool {tool['tool']} is not admitted to a mission "
                "sequence; moving-track and relative tools require resolved geometry and "
                "sequence-executor support before verification (use the single planCommand path)"
            )
    return MissionPlan(
        requestId=data["requestId"],
        anomalyId=data["anomalyId"],
        tools=tools,
        profile=data["profile"],
        rationale=data["rationale"],
    )


def validate_anomaly(data: Any) -> Anomaly:
    """Reference of ``validate.ts::validateAnomaly``."""
    if not isinstance(data, Mapping):
        raise SchemaError("invalid Anomaly: must be an object")
    if not isinstance(data.get("id"), str) or data.get("id") == "":
        raise SchemaError("invalid Anomaly: id must be a non-empty string")
    lat, lon = data.get("lat"), data.get("lon")
    if not _is_finite(lat) or lat < -90 or lat > 90 or not _is_finite(lon) or lon < -180 or lon > 180:
        raise SchemaError("invalid Anomaly: lat/lon must be finite coordinates")
    if not isinstance(data.get("type"), str):
        raise SchemaError("invalid Anomaly: type must be a string")
    confidence = data.get("confidence")
    if not _is_finite(confidence) or confidence < 0 or confidence > 1:
        raise SchemaError("invalid Anomaly: confidence must be a number in [0, 1]")
    source = data.get("source", "sentinel2")
    return Anomaly(
        id=data["id"], lat=lat, lon=lon, type=data["type"], confidence=confidence,
        thumbnail=data.get("thumbnail", ""), source=source,
        observedAt=data.get("observedAt"), ttl_s=data.get("ttl_s"),
        cameraId=data.get("cameraId"),
    )


__all__ = [
    "AltBand",
    "Anomaly",
    "Corridor",
    "CorridorLeg",
    "CorridorOrbit",
    "IncidentReport",
    "LatLon",
    "MISSION_SEQUENCE_TOOLS",
    "MissionPlan",
    "PlanTraceEntry",
    "SchemaError",
    "TASK_QUESTION_MAX_CHARS",
    "Task",
    "Verification",
    "VerificationCheck",
    "validate_anomaly",
    "validate_mission_plan",
    "validate_tool",
]
