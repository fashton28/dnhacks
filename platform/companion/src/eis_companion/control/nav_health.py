"""Pure GPS/EKF health voting and companion-owned source selection."""
from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class NavPolicy:
    vote_s: float = 2.0
    gps_min_fix: int = 3
    gps_min_sats: int = 6
    gps_max_hdop: float = 2.5
    gps_speed_accuracy_target_mps: float = 0.3
    gps_speed_accuracy_usable_mps: float = 1.0
    optflow_min_quality: float = 50.0
    optflow_max_innovation_mps: float = 0.15
    extnav_max_age_s: float = 0.5
    extnav_max_position_variance_m2: float = 1.0
    gps_max_age_s: float = 1.0
    ekf_max_age_s: float = 1.0


@dataclass(frozen=True)
class NavSample:
    timestamp_s: float
    gps_fix: int
    gps_sats: int
    gps_hdop: float
    gps_speed_accuracy_mps: float
    ekf_ok: bool
    gps_age_s: float = float("inf")
    ekf_age_s: float = float("inf")
    extnav_fresh: bool = False
    extnav_age_s: float = float("inf")
    extnav_position_variance_m2: float = float("inf")
    optflow_quality: float = 0.0
    optflow_innovation_mps: float = float("inf")


@dataclass(frozen=True)
class NavSnapshot:
    source: str
    gps_healthy: bool
    extnav_healthy: bool
    optflow_healthy: bool
    denied_edge: bool
    recovered_edge: bool
    source_changed: bool
    requested_source: str | None
    hold: bool
    refuse_missions: bool
    reason: str


def _finite_at_most(value: float, limit: float) -> bool:
    return math.isfinite(value) and 0.0 <= value <= limit


class NavHealth:
    """Vote GPS/fallback health with 2 s hysteresis.

    The class returns a desired source but performs no I/O.  Only the companion
    MAVLink wrapper may turn a source change into MAV_CMD_SET_EKF_SOURCE_SET.
    """

    def __init__(self, policy: NavPolicy = NavPolicy()) -> None:
        self.policy = policy
        self.source = "gps"
        self._candidate = "gps"
        self._candidate_since = 0.0
        self._last_requested: str | None = None

    def confirm_source(self, source: str, accepted: bool) -> bool:
        """Commit only a source switch acknowledged by the MAVLink wrapper."""
        if not accepted or source not in {"gps", "optflow", "extnav"}:
            self._last_requested = None
            return False
        changed = source != self.source
        self.source = source
        self._last_requested = None
        return changed

    def evaluate(self, sample: NavSample) -> NavSnapshot:
        p = self.policy
        gps_healthy = bool(
            sample.ekf_ok
            and _finite_at_most(sample.gps_age_s, p.gps_max_age_s)
            and _finite_at_most(sample.ekf_age_s, p.ekf_max_age_s)
            and sample.gps_fix >= p.gps_min_fix
            and sample.gps_sats >= p.gps_min_sats
            and _finite_at_most(sample.gps_hdop, p.gps_max_hdop)
            and _finite_at_most(
                sample.gps_speed_accuracy_mps,
                p.gps_speed_accuracy_usable_mps,
            )
        )
        extnav_healthy = bool(
            sample.extnav_fresh
            and _finite_at_most(sample.extnav_age_s, p.extnav_max_age_s)
            and _finite_at_most(
                sample.extnav_position_variance_m2,
                p.extnav_max_position_variance_m2,
            )
        )
        optflow_healthy = bool(
            math.isfinite(sample.optflow_quality)
            and sample.optflow_quality >= p.optflow_min_quality
            and _finite_at_most(
                abs(sample.optflow_innovation_mps),
                p.optflow_max_innovation_mps,
            )
        )

        if gps_healthy:
            desired = "gps"
            reason = (
                "GPS healthy"
                if sample.gps_speed_accuracy_mps <= p.gps_speed_accuracy_target_mps
                else "GPS usable; speed accuracy above 0.3 m/s target"
            )
        elif extnav_healthy:
            desired = "extnav"
            reason = "GPS denied; healthy LiDAR-inertial extnav available"
        elif optflow_healthy:
            desired = "optflow"
            reason = "GPS denied; healthy optical flow available"
        else:
            desired = "none"
            reason = "GPS denied; no healthy extnav or optical-flow fallback"

        now = max(0.0, float(sample.timestamp_s))
        if desired != self._candidate:
            self._candidate = desired
            self._candidate_since = now

        requested: str | None = None
        if desired != "none" and desired != self.source:
            if now - self._candidate_since >= p.vote_s and self._last_requested != desired:
                requested = desired
                self._last_requested = desired

        denied_edge = requested in {"extnav", "optflow"} and self.source == "gps"
        recovered_edge = requested == "gps" and self.source != "gps"

        return NavSnapshot(
            source=self.source,
            gps_healthy=gps_healthy,
            extnav_healthy=extnav_healthy,
            optflow_healthy=optflow_healthy,
            denied_edge=denied_edge,
            recovered_edge=recovered_edge,
            source_changed=False,
            requested_source=requested,
            hold=not gps_healthy or self.source != "gps",
            refuse_missions=not gps_healthy or self.source != "gps",
            reason=reason,
        )


__all__ = ["NavHealth", "NavPolicy", "NavSample", "NavSnapshot"]
