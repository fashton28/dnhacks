"""
rails/eval_envelope — recorded trajectories -> envelope state sequences.

Twenty trajectories, generated DETERMINISTICALLY (a fixed-seed linear
congruential generator, not ``random``, so the sequence does not move with a
CPython release), each a corridor, a site geometry, a set of limits and 160
samples at 20 Hz. Between them they exercise every branch of the ADR D22
policy: nominal flight, warning-and-slow drift, a 2x-tolerance hold, altitude
excursions above and below the band, a geofence-margin RTL, an NFZ buffer
breach and the legal overflight above its ceiling, a standoff dip, sortie
exhaustion, peer separation fresh / stale / past the hold threshold, orbit
radial drift, the 5 s escalation dwell, hysteretic recovery, and a suspended
(manual-engaged) breach that still latches and logs.

The trajectory definitions are PLAIN DATA — wire-shaped dicts, no monitor
objects — so both implementations build their own monitor from the same input:

  * this module runs them through :mod:`rails.envelope` (the oracle);
  * ``platform/companion/tests/test_envelope_parity.py`` runs the identical
    trajectories through ``eis_companion.control.envelope`` (the port) and
    compares the two state sequences tick for tick.

A mismatch is a bug in the companion port, not a reason to move the oracle.

Usage::

    python rails/eval_envelope.py           # human summary
    python rails/eval_envelope.py --json    # the parity document
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

if __package__ in (None, ""):                     # `python rails/eval_envelope.py`
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from rails.envelope import (
    Corridor, EnvelopeLimits, EnvelopeMonitor, EnvelopeSample, MonitoredZone, PeerSample,
    SiteGeometry,
)

#: Site anchor — Meridian Station, the same home the fixtures use.
HOME_LAT = 41.1992364
HOME_LON = -98.3995821

#: Sampling: 20 Hz for 8 s, the rate the orchestrator actually runs the monitor.
SAMPLE_HZ = 20
SAMPLE_COUNT = 160
DT_S = 1.0 / SAMPLE_HZ

#: How many trajectories the harness generates.
TRAJECTORY_COUNT = 20


# ---------------------------------------------------------------------------
# Deterministic noise
# ---------------------------------------------------------------------------
class Lcg:
    """A fixed linear congruential generator.

    ``random.Random`` is not used on purpose: its stream is a CPython
    implementation detail, and a trajectory set that moves with the interpreter
    is not a fixture.
    """

    def __init__(self, seed: int) -> None:
        self.state = seed & 0x7FFFFFFF or 1

    def unit(self) -> float:
        """Next value in [0, 1)."""
        self.state = (1103515245 * self.state + 12345) & 0x7FFFFFFF
        return self.state / 0x80000000

    def signed(self) -> float:
        """Next value in [-1, 1)."""
        return self.unit() * 2.0 - 1.0


# ---------------------------------------------------------------------------
# Geometry helpers (metre offsets from home, so the numbers are readable)
# ---------------------------------------------------------------------------
def offset(east_m: float, north_m: float, lat: float = HOME_LAT, lon: float = HOME_LON) -> Tuple[float, float]:
    return (lat + north_m / 111_320.0,
            lon + east_m / (111_320.0 * math.cos(lat * math.pi / 180.0)))


def _ring(corners: Sequence[Tuple[float, float]]) -> List[List[float]]:
    return [list(offset(east, north)) for east, north in corners]


#: The operational geofence: a 1400 m square about home.
GEOFENCE = _ring([(-700, -700), (-700, 700), (700, 700), (700, -700)])
#: One NFZ, a 200 m box 300 m east of home, ceiling 30 m AGL. Flight inside at
#: or below 30 m is forbidden; overflight strictly above it is legal (ADR D3).
NFZ = {
    "name": "east switchyard",
    "polygon": _ring([(200, -100), (200, 100), (400, 100), (400, -100)]),
    "ceiling_m": 30.0,
}
SITE = {"geofence": GEOFENCE, "nfz": [NFZ], "nfz_buffer_m": 25.0}

#: The certified corridor: one 400 m leg due north, ending on a 25 m orbit.
LEG_START = offset(0, 0)
LEG_END = offset(0, 400)
CORRIDOR = {
    "legs": [{"from": {"lat": LEG_START[0], "lon": LEG_START[1]},
              "to": {"lat": LEG_END[0], "lon": LEG_END[1]},
              "lateral_tol_m": 10.0}],
    "orbits": [],
    "alt_band_m": {"min": 30.0, "max": 50.0},
    "generated_from": "rails-eval-envelope",
}
#: A corridor whose only element is an orbit, for the radial-drift trajectory.
ORBIT_CORRIDOR = {
    "legs": [],
    "orbits": [{"center": {"lat": LEG_END[0], "lon": LEG_END[1]},
                "radius_m": 25.0, "radial_tol_m": 5.0}],
    "alt_band_m": {"min": 30.0, "max": 50.0},
    "generated_from": "rails-eval-envelope-orbit",
}
#: A corridor with no altitude band, used where only lateral geometry matters.
UNBANDED_CORRIDOR = {**CORRIDOR, "alt_band_m": {"min": 0.0, "max": float("inf")}}

DEFAULT_LIMITS = EnvelopeLimits()


def _limits_dict(limits: EnvelopeLimits = DEFAULT_LIMITS) -> Dict[str, float]:
    return asdict(limits)


def _sample(t_s: float, *, east_m: float, north_m: float, alt_m: float = 40.0,
            standoff_m: Optional[float] = None, sortie_elapsed_s: float = 0.0,
            sortie_cap_s: Optional[float] = None, peer: Optional[Dict[str, Any]] = None,
            suspended: bool = False) -> Dict[str, Any]:
    lat, lon = offset(east_m, north_m)
    return {
        "t_s": round(t_s, 6), "lat": lat, "lon": lon, "rel_alt_m": alt_m, "airborne": True,
        "standoff_m": standoff_m, "sortie_elapsed_s": sortie_elapsed_s,
        "sortie_cap_s": sortie_cap_s, "peer": peer, "suspended": suspended,
    }


def _peer(east_m: float, north_m: float, *, age_s: float, alt_m: float = 40.0,
          vehicle_id: str = "eis-2") -> Dict[str, Any]:
    lat, lon = offset(east_m, north_m)
    return {"vehicle_id": vehicle_id, "lat": lat, "lon": lon, "rel_alt_m": alt_m,
            "age_s": age_s, "valid": True}


# ---------------------------------------------------------------------------
# The twenty trajectories
# ---------------------------------------------------------------------------
def _progress(index: int) -> float:
    """Fraction of the way along the corridor leg at sample ``index``."""
    return index / (SAMPLE_COUNT - 1)


def _trajectory(traj_id: str, description: str, samples: List[Dict[str, Any]], *,
                corridor: Dict[str, Any] = CORRIDOR,
                site: Dict[str, Any] = SITE,
                limits: EnvelopeLimits = DEFAULT_LIMITS) -> Dict[str, Any]:
    return {"id": traj_id, "description": description, "corridor": corridor,
            "geometry": site, "limits": _limits_dict(limits), "samples": samples}


def build_trajectories() -> List[Dict[str, Any]]:
    """The twenty recorded trajectories, as plain wire-shaped data."""
    trajectories: List[Dict[str, Any]] = []

    def t(index: int) -> float:
        return index * DT_S

    # T01 — nominal: straight up the corridor, mid-band, nothing to report.
    trajectories.append(_trajectory(
        "T01", "nominal transit: on the leg, mid-band, no peer, no observation",
        [_sample(t(i), east_m=0.0, north_m=400.0 * _progress(i)) for i in range(SAMPLE_COUNT)],
    ))

    # T02 — drift ramps 0 -> 30 m: in_envelope, then warning+slow past 10 m,
    # then hold past 20 m. Promoting slow -> hold RESTARTS the dwell, so this
    # trajectory ends before it can escalate; T07 and T16 cover that.
    trajectories.append(_trajectory(
        "T02", "lateral drift ramp 0->30 m: warning at tolerance, hold at 2x, dwell restarted",
        [_sample(t(i), east_m=30.0 * _progress(i), north_m=200.0) for i in range(SAMPLE_COUNT)],
    ))

    # T03 — warning then a clean return: the latch clears only after the
    # measurement has been inside by the hysteresis margin for recovery_s.
    trajectories.append(_trajectory(
        "T03", "drift into warning then back inside: hysteretic recovery clears the latch",
        [_sample(t(i), east_m=(15.0 if i < 40 else 0.0), north_m=200.0)
         for i in range(SAMPLE_COUNT)],
    ))

    # T04 — breach then recovery to a margin ABOVE hysteresis: still needs the
    # full recovery window before the latch drops.
    trajectories.append(_trajectory(
        "T04", "breach at 25 m then recovery to 5 m: latch survives until the recovery window",
        [_sample(t(i), east_m=(25.0 if i < 60 else 5.0), north_m=200.0)
         for i in range(SAMPLE_COUNT)],
    ))

    # T05 — climb out of the top of the band.
    trajectories.append(_trajectory(
        "T05", "altitude excursion above the band: hold, then escalation",
        [_sample(t(i), east_m=0.0, north_m=200.0, alt_m=40.0 + 20.0 * _progress(i))
         for i in range(SAMPLE_COUNT)],
    ))

    # T06 — descend out of the bottom of the band.
    trajectories.append(_trajectory(
        "T06", "altitude excursion below the band: hold, then escalation",
        [_sample(t(i), east_m=0.0, north_m=200.0, alt_m=40.0 - 20.0 * _progress(i))
         for i in range(SAMPLE_COUNT)],
    ))

    # T07 — east until the geofence margin is breached: rtl outranks corridor.
    trajectories.append(_trajectory(
        "T07", "geofence margin breach: rtl outranks the corridor's own drift finding",
        [_sample(t(i), east_m=600.0 + 120.0 * _progress(i), north_m=0.0)
         for i in range(SAMPLE_COUNT)],
        corridor=UNBANDED_CORRIDOR,
    ))

    # T08 — into the NFZ buffer BELOW its ceiling: rtl.
    trajectories.append(_trajectory(
        "T08", "NFZ buffer breach below the ceiling: rtl",
        [_sample(t(i), east_m=100.0 + 120.0 * _progress(i), north_m=0.0, alt_m=25.0)
         for i in range(SAMPLE_COUNT)],
        corridor=UNBANDED_CORRIDOR,
    ))

    # T09 — the same track ABOVE the ceiling: legal overflight, no NFZ finding.
    trajectories.append(_trajectory(
        "T09", "the same track above the NFZ ceiling: legal overflight, no NFZ finding",
        [_sample(t(i), east_m=100.0 + 120.0 * _progress(i), north_m=0.0, alt_m=40.0)
         for i in range(SAMPLE_COUNT)],
        corridor=UNBANDED_CORRIDOR,
    ))

    # T10 — the observed subject closes inside the standoff floor.
    trajectories.append(_trajectory(
        "T10", "standoff closes from 12 m to 1 m: hold plus a back-off request",
        [_sample(t(i), east_m=0.0, north_m=200.0, standoff_m=12.0 - 11.0 * _progress(i))
         for i in range(SAMPLE_COUNT)],
    ))

    # T11 — the sortie budget runs out mid-flight.
    trajectories.append(_trajectory(
        "T11", "sortie budget exhausted mid-flight: rtl on a seconds margin",
        [_sample(t(i), east_m=0.0, north_m=200.0, sortie_elapsed_s=470.0 + i * 0.1,
                 sortie_cap_s=480.0) for i in range(SAMPLE_COUNT)],
    ))

    # T12 — a fresh peer closes from 90 m to 15 m: 40 m applies.
    trajectories.append(_trajectory(
        "T12", "fresh peer closes from 90 m to 15 m: the nominal 40 m applies",
        [_sample(t(i), east_m=0.0, north_m=200.0,
                 peer=_peer(90.0 - 75.0 * _progress(i), 200.0, age_s=1.0))
         for i in range(SAMPLE_COUNT)],
    ))

    # T13 — a 60 m gap that is legal fresh and illegal stale (ADR D21).
    trajectories.append(_trajectory(
        "T13", "60 m gap with 5 s old peer data: separation doubles to 80 m, so it holds",
        [_sample(t(i), east_m=0.0, north_m=200.0, peer=_peer(60.0, 200.0, age_s=5.0))
         for i in range(SAMPLE_COUNT)],
    ))

    # T14 — peer data past the 10 s hold threshold: stop moving, whatever the
    # measured range says.
    trajectories.append(_trajectory(
        "T14", "peer data older than 10 s at 300 m: hold regardless of the range",
        [_sample(t(i), east_m=0.0, north_m=200.0, peer=_peer(300.0, 200.0, age_s=12.0))
         for i in range(SAMPLE_COUNT)],
    ))

    # T15 — radial drift about the orbit: the tighter 5 m tolerance bites.
    trajectories.append(_trajectory(
        "T15", "orbit radial drift out to 14 m: the 5 m radial tolerance is tighter than a leg's",
        [_sample(t(i), east_m=25.0 + 14.0 * _progress(i), north_m=400.0)
         for i in range(SAMPLE_COUNT)],
        corridor=ORBIT_CORRIDOR,
    ))

    # T16 — corridor drift AND a geofence breach at once: rtl wins the ladder.
    trajectories.append(_trajectory(
        "T16", "corridor drift and a geofence breach together: the more severe action wins",
        [_sample(t(i), east_m=690.0 + 20.0 * _progress(i), north_m=200.0)
         for i in range(SAMPLE_COUNT)],
        corridor=UNBANDED_CORRIDOR,
    ))

    # T17 — a breach while manual is engaged: the monitor still latches, still
    # escalates, and the decision is marked suspended so nothing acts on it.
    trajectories.append(_trajectory(
        "T17", "breach while manual is engaged: latched and logged, marked suspended",
        [_sample(t(i), east_m=30.0, north_m=200.0, suspended=i >= 20)
         for i in range(SAMPLE_COUNT)],
    ))

    # T18 — the vehicle returns to the corridor a tick before the 5 s dwell,
    # but the LATCH outlives it: recovery takes recovery_s, and the dwell keeps
    # counting inside that window, so this still escalates before it clears.
    # That is the intended shape — a breach is not undone by touching the line.
    trajectories.append(_trajectory(
        "T18", "breach released just before the dwell: the latch escalates, then recovers",
        [_sample(t(i), east_m=(25.0 if i < 99 else 0.0), north_m=200.0)
         for i in range(SAMPLE_COUNT)],
    ))

    # T19 — deterministic jitter that never leaves the corridor.
    jitter = Lcg(20260906)
    trajectories.append(_trajectory(
        "T19", "deterministic jitter inside the corridor: noise must not produce a finding",
        [_sample(t(i), east_m=6.0 * jitter.signed(), north_m=400.0 * _progress(i),
                 alt_m=40.0 + 4.0 * jitter.signed()) for i in range(SAMPLE_COUNT)],
    ))

    # T20 — a deterministic random walk that wanders in and out of tolerance,
    # which is the case hysteresis exists for.
    walk = Lcg(987654321)
    east = 0.0
    samples: List[Dict[str, Any]] = []
    for i in range(SAMPLE_COUNT):
        east = max(-28.0, min(28.0, east + 2.4 * walk.signed()))
        samples.append(_sample(t(i), east_m=east, north_m=200.0,
                               alt_m=40.0 + 6.0 * walk.signed(),
                               standoff_m=None if i % 3 else 4.0 + 6.0 * walk.unit()))
    trajectories.append(_trajectory(
        "T20", "deterministic random walk across the tolerance edge: the anti-flap case",
        samples,
    ))

    assert len(trajectories) == TRAJECTORY_COUNT, "the harness declares twenty trajectories"
    return trajectories


# ---------------------------------------------------------------------------
# Running one trajectory through the oracle's monitor
# ---------------------------------------------------------------------------
def _optional_float(value: Any) -> float:
    """``None`` means "does not apply this tick" and reads as ``inf``."""
    return math.inf if value is None else float(value)


def build_sample(raw: Dict[str, Any]) -> EnvelopeSample:
    return EnvelopeSample(
        t_s=float(raw["t_s"]), lat=float(raw["lat"]), lon=float(raw["lon"]),
        rel_alt_m=float(raw["rel_alt_m"]), airborne=bool(raw.get("airborne", True)),
        standoff_m=_optional_float(raw.get("standoff_m")),
        sortie_elapsed_s=float(raw.get("sortie_elapsed_s", 0.0)),
        sortie_cap_s=_optional_float(raw.get("sortie_cap_s")),
    )


def build_peer(raw: Optional[Dict[str, Any]]) -> Optional[PeerSample]:
    if raw is None:
        return None
    return PeerSample(
        vehicle_id=str(raw.get("vehicle_id", "")), lat=float(raw["lat"]), lon=float(raw["lon"]),
        rel_alt_m=float(raw.get("rel_alt_m", 0.0)), age_s=_optional_float(raw.get("age_s")),
        valid=bool(raw.get("valid", True)),
    )


def build_geometry(raw: Dict[str, Any]) -> SiteGeometry:
    return SiteGeometry(
        geofence=tuple((float(p[0]), float(p[1])) for p in raw.get("geofence") or ()),
        nfz=tuple(MonitoredZone(
            name=str(zone.get("name", "")),
            polygon=tuple((float(p[0]), float(p[1])) for p in zone.get("polygon") or ()),
            ceiling_m=_optional_float(zone.get("ceiling_m")),
        ) for zone in raw.get("nfz") or ()),
        nfz_buffer_m=float(raw.get("nfz_buffer_m", 25.0)),
    )


def state_of(decision: Any) -> Dict[str, Any]:
    """One tick of the comparable state sequence.

    Margins are rounded to 6 dp — far tighter than the 1e-3 m the parity test
    compares with, but enough to keep the JSON document stable.
    """
    margin = decision.margin_m
    return {
        "state": decision.state,
        "constraint": decision.constraint,
        "action": decision.action,
        "base_action": decision.base_action,
        "wire_action": decision.wire_action,
        "escalated": bool(decision.escalated),
        "margin_m": None if not math.isfinite(margin) else round(float(margin), 6),
        "margin_unit": decision.margin_unit,
        "speed_scale": round(float(decision.speed_scale), 6),
        "back_off_m": round(float(decision.back_off_m), 6),
        "breach_duration_s": round(float(decision.breach_duration_s), 6),
        "suspended": bool(decision.suspended),
    }


def run_trajectory(trajectory: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Drive the ORACLE's monitor over one trajectory and record every tick."""
    monitor = EnvelopeMonitor(
        EnvelopeLimits(**trajectory["limits"]),
        corridor=Corridor.from_wire(trajectory["corridor"]),
        geometry=build_geometry(trajectory["geometry"]),
    )
    monitor.arm(Corridor.from_wire(trajectory["corridor"]))
    monitor.set_geometry(build_geometry(trajectory["geometry"]))
    states: List[Dict[str, Any]] = []
    for raw in trajectory["samples"]:
        decision = monitor.update(build_sample(raw), peer=build_peer(raw.get("peer")),
                                  suspended=bool(raw.get("suspended", False)))
        states.append({"t_s": raw["t_s"], **state_of(decision)})
    return states


def evaluate() -> Dict[str, Any]:
    trajectories = build_trajectories()
    return {
        "generatedBy": "rails/eval_envelope.py",
        "trajectoryCount": len(trajectories),
        "sampleCount": SAMPLE_COUNT,
        "sampleHz": SAMPLE_HZ,
        "trajectories": [
            {"id": trajectory["id"], "description": trajectory["description"],
             "states": run_trajectory(trajectory)}
            for trajectory in trajectories
        ],
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run the rails envelope oracle over the recorded trajectories.")
    parser.add_argument("--json", action="store_true", help="emit the parity document on stdout")
    args = parser.parse_args(argv)

    document = evaluate()
    if args.json:
        json.dump(document, sys.stdout)
        sys.stdout.write("\n")
        return 0
    for entry in document["trajectories"]:
        seen: List[str] = []
        for state in entry["states"]:
            label = f"{state['state']}/{state['constraint'] or '-'}/{state['action']}"
            if not seen or seen[-1] != label:
                seen.append(label)
        print(f"{entry['id']}  {' -> '.join(seen)}")
        print(f"      {entry['description']}")
    print(f"\n{document['trajectoryCount']} trajectories x {document['sampleCount']} samples "
          f"at {document['sampleHz']} Hz")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
