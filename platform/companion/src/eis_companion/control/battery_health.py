"""Pure battery, charge-readiness, and sortie timing state.

The module is stdlib-only.  MAVLink parsing and environment selection belong in
the I/O/orchestrator layers; callers pass plain samples and consume snapshots.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional, Sequence


@dataclass(frozen=True)
class BatteryPolicy:
    nominal_endurance_s: float = 1500.0
    reserve_pct: float = 25.0
    max_sortie_s: float = 480.0
    dispatch_min_soc_pct: float = 80.0
    cell_imbalance_max_v: float = 0.10
    batt_temp_max_c: float = 60.0
    soc_divergence_max_pct: float = 10.0
    capacity_mah: float = 5000.0
    cell_count: int = 4
    internal_resistance_ohm: float = 0.02
    charge_current_min_a: float = 0.5
    charge_full_soc_pct: float = 95.0
    charge_plateau_current_a: float = 0.3
    charge_confirm_s: float = 10.0
    charge_stall_s: float = 15.0
    charge_min_gain_pct: float = 0.5
    require_cell_telemetry: bool = False
    require_temperature_telemetry: bool = True


@dataclass(frozen=True)
class BatterySample:
    voltage_v: float
    current_a: float
    temp_c: float
    reported_soc_pct: Optional[float] = None
    cell_voltages_v: Sequence[float] = ()
    armed: bool = False
    airborne: bool = False
    landed: bool = True
    external_power: bool = False
    charge_requested: bool = False
    pack_fault: str = ""
    timestamp_s: float = 0.0


@dataclass(frozen=True)
class BatterySnapshot:
    soc_pct: float
    voltage_soc_pct: float
    voltage_v: float
    current_a: float
    cell_delta_v: float
    temp_c: float
    remaining_s: float
    charge_state: str
    fault: str
    degraded_estimate: bool
    ready: bool
    reasons: tuple[str, ...]
    eta_ready_s: float
    elapsed_sortie_s: float
    cap_s: float
    must_rtl_by_s: float
    should_rtl: bool
    reserve_should_rtl: bool = False
    sortie_should_rtl: bool = False
    event: str = ""


def clamp(value: float, low: float, high: float) -> float:
    if not math.isfinite(value):
        return low
    return max(low, min(high, value))


def voltage_soc_pct(
    voltage_v: float,
    current_a: float,
    *,
    cell_count: int,
    internal_resistance_ohm: float,
) -> float:
    """Conservative linear OCV estimate with discharge-sag compensation.

    Positive current is discharge.  The simple 3.30--4.20 V/cell curve is a
    deliberately conservative portable fallback; hardware may provide a
    calibrated curve without changing the state machine.
    """
    if cell_count <= 0 or not math.isfinite(voltage_v) or voltage_v <= 0.0:
        return 0.0
    compensated = voltage_v + max(0.0, current_a) * max(0.0, internal_resistance_ohm)
    per_cell = compensated / cell_count
    return clamp((per_cell - 3.30) / 0.90 * 100.0, 0.0, 100.0)


def cell_delta_v(cell_voltages_v: Sequence[float]) -> float:
    cells = [float(v) for v in cell_voltages_v if math.isfinite(float(v)) and v > 0.0]
    return max(cells) - min(cells) if len(cells) >= 2 else 0.0


def estimate_return_time_s(
    home_distance_m: float,
    rel_alt_m: float,
    *,
    cruise_speed_mps: float,
    descent_rate_mps: float,
    landing_allowance_s: float = 15.0,
) -> float:
    """Conservative horizontal return plus descent and landing allowance."""
    values = (home_distance_m, rel_alt_m, cruise_speed_mps, descent_rate_mps)
    if not all(math.isfinite(float(value)) for value in values):
        return math.inf
    horizontal = max(0.0, home_distance_m) / max(0.5, cruise_speed_mps)
    descent = max(0.0, rel_alt_m) / max(0.25, descent_rate_mps)
    return horizontal + descent + max(0.0, landing_allowance_s)


class BatteryHealth:
    """Stateful battery estimator whose transitions are deterministic."""

    def __init__(self, policy: BatteryPolicy = BatteryPolicy()) -> None:
        self.policy = policy
        self._soc: Optional[float] = None
        self._last_ts: Optional[float] = None
        self._fault_latched = ""
        self._charge_stalled = False
        self._charge_window_ts: Optional[float] = None
        self._charge_window_soc: Optional[float] = None
        self._full_window_ts: Optional[float] = None
        self._sortie_start_ts: Optional[float] = None

    @property
    def fault_latched(self) -> bool:
        return bool(self._fault_latched)

    def clear_fault(self, *, disarmed: bool, inspected: bool) -> bool:
        """Clear the pack latch only after an explicit disarmed inspection."""
        if not (disarmed and inspected):
            return False
        self._fault_latched = ""
        self._charge_stalled = False
        return True

    def update(
        self,
        sample: BatterySample,
        *,
        estimated_return_s: float = 0.0,
    ) -> BatterySnapshot:
        p = self.policy
        ts = float(sample.timestamp_s)
        if not math.isfinite(ts) or ts < 0.0:
            raise ValueError("battery sample timestamp_s must be finite and >= 0")
        dt = 0.0 if self._last_ts is None else max(0.0, ts - self._last_ts)
        self._last_ts = ts

        v_soc = voltage_soc_pct(
            sample.voltage_v,
            sample.current_a,
            cell_count=p.cell_count,
            internal_resistance_ohm=p.internal_resistance_ohm,
        )
        reported = None if sample.reported_soc_pct is None else clamp(
            float(sample.reported_soc_pct), 0.0, 100.0
        )
        if self._soc is None:
            self._soc = reported if reported is not None else v_soc

        # Coulomb integration is authoritative between trusted anchors.
        capacity_as = max(1.0, p.capacity_mah / 1000.0 * 3600.0)
        integrated = self._soc - sample.current_a * dt / capacity_as * 100.0
        integrated = clamp(integrated, 0.0, 100.0)

        degraded = abs(integrated - v_soc) > p.soc_divergence_max_pct
        if sample.airborne or sample.armed:
            candidates = [integrated]
            if reported is not None:
                candidates.append(reported)
            if degraded:
                candidates.append(v_soc)
            # A flight estimate never increases, including noisy telemetry.
            self._soc = min(self._soc, *candidates)
        elif abs(sample.current_a) <= p.charge_plateau_current_a:
            # Re-anchor to OCV only while disarmed under low load.
            anchor = v_soc if reported is None else min(reported, v_soc) if degraded else reported
            self._soc = clamp(anchor, 0.0, 100.0)
        elif sample.external_power and sample.current_a < 0.0:
            # During charging, allow monotonic integration/reported progress.
            self._soc = max(self._soc, integrated, reported or 0.0)
        else:
            self._soc = min(self._soc, integrated, reported or self._soc)

        delta = cell_delta_v(sample.cell_voltages_v)
        new_fault = sample.pack_fault.strip()
        if delta > p.cell_imbalance_max_v:
            new_fault = new_fault or f"cell imbalance {delta:.3f} V"
        if sample.temp_c > p.batt_temp_max_c:
            new_fault = new_fault or f"battery temperature {sample.temp_c:.1f} C"
        if new_fault:
            self._fault_latched = new_fault

        charge_state, event = self._charge_state(sample, ts)
        if self._fault_latched:
            charge_state = "fault"

        reasons = []
        if sample.voltage_v <= 0.0 or not math.isfinite(sample.voltage_v):
            reasons.append("battery voltage unavailable")
        if p.require_temperature_telemetry and not math.isfinite(sample.temp_c):
            reasons.append("battery temperature unavailable")
        if p.require_cell_telemetry and len(tuple(sample.cell_voltages_v)) < p.cell_count:
            reasons.append("battery cell telemetry unavailable")
        if self._fault_latched:
            reasons.append(self._fault_latched)
        if self._charge_stalled:
            reasons.append("battery charge_stalled")
        if charge_state != "charged":
            reasons.append(f"charge_state={charge_state}")
        if self._soc < p.dispatch_min_soc_pct:
            reasons.append(
                f"SoC {self._soc:.1f}% below dispatch minimum {p.dispatch_min_soc_pct:.1f}%"
            )
        if delta > p.cell_imbalance_max_v:
            reasons.append(f"cell delta {delta:.3f} V exceeds {p.cell_imbalance_max_v:.3f} V")
        if sample.temp_c > p.batt_temp_max_c:
            reasons.append(
                f"temperature {sample.temp_c:.1f} C exceeds {p.batt_temp_max_c:.1f} C"
            )
        if degraded:
            reasons.append("battery degraded_estimate")

        elapsed = self._sortie_elapsed(sample, ts)
        must_rtl_by = clamp(p.max_sortie_s - max(0.0, estimated_return_s), 0.0, p.max_sortie_s)
        reserve_should_rtl = bool(sample.airborne and self._soc <= p.reserve_pct)
        sortie_should_rtl = bool(sample.airborne and elapsed >= must_rtl_by)
        should_rtl = bool(reserve_should_rtl or sortie_should_rtl or (
            sample.airborne and self._fault_latched
        ))
        remaining = p.nominal_endurance_s * max(0.0, self._soc - p.reserve_pct) / 100.0
        if sample.current_a > 0.1:
            usable_ah = p.capacity_mah / 1000.0 * max(0.0, self._soc - p.reserve_pct) / 100.0
            remaining = min(remaining, usable_ah / sample.current_a * 3600.0)
        eta = self._eta_ready(sample, charge_state)
        return BatterySnapshot(
            soc_pct=clamp(self._soc, 0.0, 100.0),
            voltage_soc_pct=v_soc,
            voltage_v=max(0.0, float(sample.voltage_v)),
            current_a=float(sample.current_a),
            cell_delta_v=delta,
            temp_c=float(sample.temp_c) if math.isfinite(sample.temp_c) else -1.0,
            remaining_s=remaining,
            charge_state=charge_state,
            fault=self._fault_latched,
            degraded_estimate=degraded,
            ready=not reasons,
            reasons=tuple(reasons),
            eta_ready_s=eta,
            elapsed_sortie_s=elapsed,
            cap_s=p.max_sortie_s,
            must_rtl_by_s=must_rtl_by,
            should_rtl=should_rtl,
            reserve_should_rtl=reserve_should_rtl,
            sortie_should_rtl=sortie_should_rtl,
            event=event,
        )

    def _charge_state(self, sample: BatterySample, ts: float) -> tuple[str, str]:
        p = self.policy
        if sample.airborne or sample.armed:
            self._reset_charge_windows()
            return "discharging", ""
        # A landed pack at a verified full SoC and plateau current is ready
        # even when the charger does not expose an external-power bit.
        if self._soc >= p.charge_full_soc_pct and abs(sample.current_a) <= p.charge_plateau_current_a:
            if self._full_window_ts is None:
                self._full_window_ts = ts
            if ts - self._full_window_ts >= p.charge_confirm_s:
                self._charge_stalled = False
                return "charged", "battery charged"
            if not sample.external_power:
                return "unknown", ""
        if not (sample.landed and sample.external_power):
            self._reset_charge_windows()
            return "unknown", ""

        if self._charge_window_ts is None:
            self._charge_window_ts = ts
            self._charge_window_soc = self._soc
        start_soc = self._charge_window_soc if self._charge_window_soc is not None else self._soc
        age = ts - self._charge_window_ts
        gain = self._soc - start_soc

        if sample.charge_requested and age >= p.charge_stall_s:
            if gain < p.charge_min_gain_pct:
                self._charge_stalled = True
                return "unknown", "battery charge_stalled"
            self._charge_window_ts = ts
            self._charge_window_soc = self._soc

        if self._soc >= p.charge_full_soc_pct and abs(sample.current_a) <= p.charge_plateau_current_a:
            if self._full_window_ts is None:
                self._full_window_ts = ts
            if ts - self._full_window_ts >= p.charge_confirm_s:
                self._charge_stalled = False
                return "charged", "battery charged"
        else:
            self._full_window_ts = None

        if sample.current_a <= -p.charge_current_min_a and age >= p.charge_confirm_s and gain > 0.0:
            self._charge_stalled = False
            return "charging", ""
        return "unknown", ""

    def _sortie_elapsed(self, sample: BatterySample, ts: float) -> float:
        if sample.armed and self._sortie_start_ts is None:
            self._sortie_start_ts = ts
        if not sample.armed:
            self._sortie_start_ts = None
            return 0.0
        start = self._sortie_start_ts if self._sortie_start_ts is not None else ts
        return max(0.0, ts - start)

    def _eta_ready(self, sample: BatterySample, charge_state: str) -> float:
        if charge_state == "charged" and self._soc >= self.policy.dispatch_min_soc_pct:
            return 0.0
        if not (sample.external_power and sample.current_a < 0.0):
            return -1.0
        capacity_ah = max(0.001, self.policy.capacity_mah / 1000.0)
        target = max(self.policy.dispatch_min_soc_pct, self.policy.charge_full_soc_pct)
        missing_ah = capacity_ah * max(0.0, target - self._soc) / 100.0
        return missing_ah / max(0.01, -sample.current_a) * 3600.0

    def _reset_charge_windows(self) -> None:
        self._charge_window_ts = None
        self._charge_window_soc = None
        self._full_window_ts = None


class ScriptedChargeCurve:
    """Deterministic monotonic SITL charge curve (default full cycle: 30 s)."""

    def __init__(self, start_soc_pct: float, duration_s: float = 30.0) -> None:
        self.start_soc_pct = clamp(start_soc_pct, 0.0, 100.0)
        self.duration_s = max(1.0, float(duration_s))

    def sample(self, elapsed_s: float) -> tuple[float, float]:
        progress = clamp(float(elapsed_s) / self.duration_s, 0.0, 1.0)
        soc = self.start_soc_pct + (100.0 - self.start_soc_pct) * progress
        current = -2.0 * (1.0 - progress) if progress < 1.0 else 0.0
        return soc, current


__all__ = [
    "BatteryHealth",
    "BatteryPolicy",
    "BatterySample",
    "BatterySnapshot",
    "ScriptedChargeCurve",
    "cell_delta_v",
    "estimate_return_time_s",
    "voltage_soc_pct",
]
