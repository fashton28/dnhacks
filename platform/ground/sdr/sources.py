"""Receive-only IQ sources.

Optional hardware libraries are imported only when `SDR=live`.  Every live
backend explicitly opens an RX path.  The scripted backend is the default and
keeps tests and the demo independent of a network or radio device.
"""

from __future__ import annotations

import time
from typing import Protocol

import numpy as np

from .core import BandConfig, FFT_SIZE


class NoDeviceError(RuntimeError):
    pass


class IqSource(Protocol):
    def read(self, count: int = FFT_SIZE) -> np.ndarray: ...

    def close(self) -> None: ...


class ScriptedIqSource:
    def __init__(
        self,
        band: BandConfig,
        *,
        scenario: str = "nominal",
        event_after_s: float = 65.0,
        seed: int = 2026,
    ) -> None:
        if scenario not in {"nominal", "floor_rise", "narrowband", "saturated"}:
            raise ValueError(f"unknown scripted SDR scenario: {scenario}")
        self.band = band
        self.scenario = scenario
        self.event_after_s = event_after_s
        self._started = time.monotonic()
        self._rng = np.random.default_rng(seed)
        self._sample_index = 0

    def read(self, count: int = FFT_SIZE) -> np.ndarray:
        elapsed = time.monotonic() - self._started
        active = elapsed >= self.event_after_s
        sigma = 0.025
        if active and self.scenario == "floor_rise":
            sigma *= 2.6
        real = self._rng.normal(0.0, sigma, count)
        imag = self._rng.normal(0.0, sigma, count)
        samples = (real + 1j * imag).astype(np.complex64)
        if active and self.scenario == "narrowband":
            indices = np.arange(count, dtype=float) + self._sample_index
            tone_hz = 150_000.0
            samples += (0.45 * np.exp(2j * np.pi * tone_hz * indices / self.band.sample_rate_hz)).astype(
                np.complex64
            )
        elif active and self.scenario == "saturated":
            samples[:] = (0.99 + 0.01j) * np.exp(2j * np.pi * np.arange(count) / 16.0)
        self._sample_index += count
        return samples

    def close(self) -> None:
        return None


class _SoapySource:
    def __init__(self, band: BandConfig) -> None:
        import SoapySDR  # type: ignore[import-not-found]
        from SoapySDR import SOAPY_SDR_CF32, SOAPY_SDR_RX  # type: ignore[import-not-found]

        self._module = SoapySDR
        self._rx_direction = SOAPY_SDR_RX
        self._device = SoapySDR.Device()
        self._device.setSampleRate(self._rx_direction, 0, band.sample_rate_hz)
        self._device.setFrequency(self._rx_direction, 0, band.center_hz)
        self._stream = self._device.setupStream(self._rx_direction, SOAPY_SDR_CF32, [0])
        self._device.activateStream(self._stream)

    def read(self, count: int = FFT_SIZE) -> np.ndarray:
        output = np.empty(count, dtype=np.complex64)
        result = self._device.readStream(self._stream, [output], count, timeoutUs=2_000_000)
        if result.ret <= 0:
            raise NoDeviceError(f"SoapySDR receive failed: {result.ret}")
        if result.ret < count:
            raise NoDeviceError(f"SoapySDR short receive: {result.ret}/{count}")
        return output

    def close(self) -> None:
        self._device.deactivateStream(self._stream)
        self._device.closeStream(self._stream)


class _RtlSource:
    def __init__(self, band: BandConfig) -> None:
        from rtlsdr import RtlSdr  # type: ignore[import-not-found]

        self._device = RtlSdr()
        self._device.sample_rate = band.sample_rate_hz
        self._device.center_freq = band.center_hz
        self._device.gain = "auto"

    def read(self, count: int = FFT_SIZE) -> np.ndarray:
        return np.asarray(self._device.read_samples(count), dtype=np.complex64)

    def close(self) -> None:
        self._device.close()


def create_source(
    mode: str,
    band: BandConfig,
    *,
    scripted_scenario: str = "nominal",
    scripted_event_after_s: float = 65.0,
) -> IqSource:
    if mode == "scripted":
        return ScriptedIqSource(
            band,
            scenario=scripted_scenario,
            event_after_s=scripted_event_after_s,
        )
    if mode != "live":
        raise ValueError("SDR mode must be 'scripted' or 'live'")

    failures: list[str] = []
    for source_type in (_SoapySource, _RtlSource):
        try:
            return source_type(band)
        except Exception as exc:  # optional driver/device errors vary by platform
            failures.append(f"{source_type.__name__}: {exc}")
    raise NoDeviceError("; ".join(failures) or "no receive device")
