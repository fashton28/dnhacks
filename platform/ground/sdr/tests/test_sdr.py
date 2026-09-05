from __future__ import annotations

import io
import json
from pathlib import Path

import numpy as np

from ground.sdr.core import BandConfig, FFT_SIZE, SpectrumDetector
from ground.sdr.sidecar import run_sidecar
from ground.sdr.sources import NoDeviceError, ScriptedIqSource


def _noise(seed: int, sigma: float = 0.025) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return (rng.normal(0, sigma, FFT_SIZE) + 1j * rng.normal(0, sigma, FFT_SIZE)).astype(
        np.complex64
    )


def _warm(detector: SpectrumDetector, count: int = 3) -> None:
    for index in range(count):
        result = detector.analyze(_noise(index), float(index))
        assert result.state == "warming"


def test_floor_rise_requires_two_seconds() -> None:
    detector = SpectrumDetector(baseline_seconds=3, sample_period_s=1)
    _warm(detector)
    assert not detector.analyze(_noise(10, sigma=0.065), 3.0).interference
    assert not detector.analyze(_noise(11, sigma=0.065), 4.0).interference
    result = detector.analyze(_noise(12, sigma=0.065), 5.0)
    assert result.interference
    assert "floor rise" in result.reason
    assert result.floor_delta_db >= 6.0


def test_narrowband_peak_triggers_inside_l1_window() -> None:
    band = BandConfig()
    detector = SpectrumDetector(band, baseline_seconds=3, sample_period_s=1)
    _warm(detector)
    samples = _noise(22)
    indices = np.arange(FFT_SIZE)
    samples += 0.45 * np.exp(2j * np.pi * 150_000 * indices / band.sample_rate_hz)
    result = detector.analyze(samples, 3.0)
    assert result.interference
    assert result.reason == "narrowband peak"
    assert abs(result.band.peak_mhz - 1575.57) < 0.01
    assert result.narrowband_delta_db >= 15.0


def test_saturation_degrades_health() -> None:
    detector = SpectrumDetector(baseline_seconds=2, sample_period_s=1)
    result = detector.analyze(np.full(FFT_SIZE, 0.99 + 0.01j), 0.0)
    assert result.saturated
    assert result.state == "degraded"


def test_scripted_source_is_deterministic_and_receive_only() -> None:
    band = BandConfig()
    first = ScriptedIqSource(band, seed=7).read()
    second = ScriptedIqSource(band, seed=7).read()
    np.testing.assert_array_equal(first, second)
    source_text = (Path(__file__).parents[1] / "sources.py").read_text(encoding="utf-8")
    forbidden = "write" + "Stream"
    assert forbidden not in source_text
    assert "SOAPY_SDR_" + "TX" not in source_text


def test_sidecar_emits_contract_shaped_messages() -> None:
    output = io.StringIO()
    run_sidecar(
        mode="scripted",
        vehicle_id="eis-1",
        scenario="nominal",
        event_after_s=65,
        interval_s=1,
        iterations=2,
        output=output,
        sleep=lambda _: None,
    )
    messages = [json.loads(line) for line in output.getvalue().splitlines()]
    assert messages[0] == {
        "component": "sdr",
        "detail": "collecting 60-second receive baseline",
        "state": "warming",
        "ts": messages[0]["ts"],
        "type": "healthEvent",
        "vehicleId": "eis-1",
    }
    spectra = [message for message in messages if message["type"] == "spectrum"]
    assert len(spectra) == 2
    assert spectra[0]["state"] == "warming"
    assert set(spectra[0]["bands"][0]) == {
        "name",
        "floor_db",
        "p95_db",
        "peak_mhz",
        "occ_bw_mhz",
    }


def test_live_no_device_is_a_health_event() -> None:
    def unavailable(*_args: object, **_kwargs: object) -> object:
        raise NoDeviceError("test receiver absent")

    output = io.StringIO()
    run_sidecar(
        mode="live",
        vehicle_id="eis-1",
        scenario="nominal",
        event_after_s=65,
        interval_s=1,
        iterations=1,
        output=output,
        sleep=lambda _: None,
        source_factory=unavailable,
    )
    message = json.loads(output.getvalue())
    assert message["type"] == "healthEvent"
    assert message["component"] == "sdr"
    assert message["state"] == "no_device"


def test_realistic_scheduler_drift_warms_and_sustained_interference_stays_degraded() -> None:
    detector = SpectrumDetector(baseline_seconds=60, sample_period_s=1)
    for index in range(61):
        detector.analyze(_noise(index), index * 1.01)
    nominal = detector.analyze(_noise(100), 61 * 1.01)
    assert nominal.warmed
    last = nominal
    for index in range(70):
        last = detector.analyze(_noise(200 + index, sigma=0.065), (62 + index) * 1.01)
    assert last.warmed
    assert last.interference
    assert last.state == "degraded"
