"""Pure receive-side spectrum analysis.

This module owns no hardware.  It converts complex IQ captures into the wire
summary and compares them with a rolling baseline.  The first supported rail
is GPS L1; additional receive bands can use another :class:`BandConfig`.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import math
from typing import Deque

import numpy as np


FFT_SIZE = 4096
DEFAULT_BASELINE_SECONDS = 60.0
FLOOR_RISE_DB = 6.0
FLOOR_RISE_SECONDS = 2.0
NARROWBAND_RISE_DB = 15.0


@dataclass(frozen=True)
class BandConfig:
    name: str = "GPS L1"
    center_hz: float = 1_575_420_000.0
    sample_rate_hz: float = 2_400_000.0
    interference_window_hz: float = 1_000_000.0


@dataclass(frozen=True)
class SpectrumBand:
    name: str
    floor_db: float
    p95_db: float
    peak_mhz: float
    occ_bw_mhz: float

    def to_wire(self) -> dict[str, float | str]:
        return {
            "name": self.name,
            "floor_db": round(self.floor_db, 3),
            "p95_db": round(self.p95_db, 3),
            "peak_mhz": round(self.peak_mhz, 6),
            "occ_bw_mhz": round(self.occ_bw_mhz, 6),
        }


@dataclass(frozen=True)
class Analysis:
    band: SpectrumBand
    state: str
    warmed: bool
    saturated: bool
    interference: bool
    floor_delta_db: float
    narrowband_delta_db: float
    reason: str

    @property
    def power_delta_db(self) -> float:
        return max(self.floor_delta_db, self.narrowband_delta_db, 0.0)


@dataclass
class _BaselineSample:
    timestamp_s: float
    floor_db: float
    psd_db: np.ndarray


class SpectrumDetector:
    """4096-point FFT detector with a time-bounded rolling baseline."""

    def __init__(
        self,
        band: BandConfig | None = None,
        *,
        baseline_seconds: float = DEFAULT_BASELINE_SECONDS,
        sample_period_s: float = 1.0,
        floor_rise_db: float = FLOOR_RISE_DB,
        floor_rise_seconds: float = FLOOR_RISE_SECONDS,
        narrowband_rise_db: float = NARROWBAND_RISE_DB,
        saturation_level: float = 0.98,
        saturation_fraction: float = 0.01,
    ) -> None:
        if baseline_seconds <= 0 or sample_period_s <= 0:
            raise ValueError("baseline_seconds and sample_period_s must be positive")
        self.band = band or BandConfig()
        self.baseline_seconds = float(baseline_seconds)
        self.sample_period_s = float(sample_period_s)
        self.floor_rise_db = float(floor_rise_db)
        self.floor_rise_seconds = float(floor_rise_seconds)
        self.narrowband_rise_db = float(narrowband_rise_db)
        self.saturation_level = float(saturation_level)
        self.saturation_fraction = float(saturation_fraction)
        expected_samples = baseline_seconds / sample_period_s
        if baseline_seconds >= 30:
            self._minimum_baseline_samples = max(2, math.floor(expected_samples * 0.8))
            self._warm_span_s = max(0.0, baseline_seconds - max(2 * sample_period_s, baseline_seconds * 0.05))
        else:
            self._minimum_baseline_samples = max(2, math.ceil(expected_samples))
            self._warm_span_s = baseline_seconds
        self._baseline: Deque[_BaselineSample] = deque()
        self._has_warmed = False
        self._floor_rise_since: float | None = None
        self._excursion_active = False
        self._window = np.hanning(FFT_SIZE).astype(np.float64)
        offsets = np.fft.fftshift(np.fft.fftfreq(FFT_SIZE, 1.0 / self.band.sample_rate_hz))
        self._frequencies_hz = self.band.center_hz + offsets
        self._interference_mask = np.abs(offsets) <= self.band.interference_window_hz

    @property
    def baseline_samples(self) -> int:
        return len(self._baseline)

    def analyze(self, iq: np.ndarray, timestamp_s: float) -> Analysis:
        samples = np.asarray(iq)
        if samples.ndim != 1 or samples.size < FFT_SIZE:
            raise ValueError(f"IQ capture must contain at least {FFT_SIZE} samples")
        if not np.iscomplexobj(samples):
            raise ValueError("IQ capture must be complex")
        samples = samples[:FFT_SIZE].astype(np.complex128, copy=False)
        if not np.all(np.isfinite(samples.real)) or not np.all(np.isfinite(samples.imag)):
            raise ValueError("IQ capture contains non-finite values")

        magnitude = np.abs(samples)
        saturated = float(np.mean(magnitude >= self.saturation_level)) >= self.saturation_fraction
        spectrum = np.fft.fftshift(np.fft.fft(samples * self._window, n=FFT_SIZE))
        power = np.square(np.abs(spectrum)) / max(float(np.sum(self._window**2)), 1e-12)
        psd_db = 10.0 * np.log10(np.maximum(power, 1e-20))

        floor_db = float(np.percentile(psd_db, 20.0))
        p95_db = float(np.percentile(psd_db, 95.0))
        peak_index = int(np.argmax(np.where(self._interference_mask, psd_db, -np.inf)))
        peak_mhz = float(self._frequencies_hz[peak_index] / 1_000_000.0)
        occupied_bins = int(np.count_nonzero(psd_db >= floor_db + 6.0))
        occupied_bw_mhz = occupied_bins * self.band.sample_rate_hz / FFT_SIZE / 1_000_000.0

        cutoff = timestamp_s - self.baseline_seconds
        if not self._excursion_active:
            while self._baseline and self._baseline[0].timestamp_s < cutoff:
                self._baseline.popleft()
        baseline_span = timestamp_s - self._baseline[0].timestamp_s if self._baseline else 0.0
        if len(self._baseline) >= self._minimum_baseline_samples and baseline_span >= self._warm_span_s:
            self._has_warmed = True
        warmed = self._has_warmed and bool(self._baseline)

        floor_delta = 0.0
        narrowband_delta = 0.0
        interference = False
        reason = "baseline warming"
        if warmed:
            baseline_floors = np.fromiter((sample.floor_db for sample in self._baseline), dtype=float)
            # Compare spectral *shape* after removing each capture's broadband
            # floor.  Otherwise a genuine floor rise appears as thousands of
            # simultaneous "narrowband" peaks and bypasses the two-second gate.
            baseline_psd = np.median(
                np.stack(
                    [sample.psd_db - sample.floor_db for sample in self._baseline], axis=0
                ),
                axis=0,
            )
            floor_delta = floor_db - float(np.median(baseline_floors))
            shape_delta = ((psd_db - floor_db) - baseline_psd)[self._interference_mask]
            # A Hann-windowed carrier occupies adjacent FFT bins.  Requiring
            # three-bin support rejects the single-bin extremes expected when
            # comparing independent Gaussian-noise captures.
            if shape_delta.size >= 3:
                supported_peaks = np.minimum.reduce(
                    (shape_delta[:-2], shape_delta[1:-1], shape_delta[2:])
                )
                narrowband_delta = float(np.max(supported_peaks))
            else:
                narrowband_delta = float(np.max(shape_delta))

            if floor_delta >= self.floor_rise_db:
                if self._floor_rise_since is None:
                    self._floor_rise_since = timestamp_s
            else:
                self._floor_rise_since = None

            floor_persistent = (
                self._floor_rise_since is not None
                and timestamp_s - self._floor_rise_since >= self.floor_rise_seconds
            )
            narrowband = narrowband_delta >= self.narrowband_rise_db
            interference = floor_persistent or narrowband
            if floor_persistent and narrowband:
                reason = "persistent floor rise and narrowband peak"
            elif floor_persistent:
                reason = "persistent floor rise"
            elif narrowband:
                reason = "narrowband peak"
            else:
                reason = "within rolling baseline"
        else:
            self._floor_rise_since = None

        # Freeze the reference during a candidate anomaly.  Folding elevated
        # captures into a short rolling window would train the detector on the
        # interference before the persistence threshold can elapse.
        candidate_excursion = (
            warmed
            and (
                floor_delta >= self.floor_rise_db
                or narrowband_delta >= self.narrowband_rise_db
                or saturated
            )
        )
        if not candidate_excursion:
            self._baseline.append(
                _BaselineSample(
                    timestamp_s=float(timestamp_s), floor_db=floor_db, psd_db=psd_db.copy()
                )
            )
        self._excursion_active = candidate_excursion
        state = "degraded" if saturated or interference else ("nominal" if warmed else "warming")
        return Analysis(
            band=SpectrumBand(
                name=self.band.name,
                floor_db=floor_db,
                p95_db=p95_db,
                peak_mhz=peak_mhz,
                occ_bw_mhz=occupied_bw_mhz,
            ),
            state=state,
            warmed=warmed,
            saturated=saturated,
            interference=interference,
            floor_delta_db=floor_delta,
            narrowband_delta_db=narrowband_delta,
            reason=reason,
        )
