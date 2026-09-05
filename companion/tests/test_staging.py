"""
StagingObserver tests.

Proves:
  * horizontal distance gating (default 15 m radius, configurable),
  * once-per-arrival debounce (burst of emit_repeat calls, then silence,
    re-arm only after leaving the radius),
  * deterministic truth -> observation mapping of the offline stub
    (vehicle/breach high-conf, structure low-conf, false_alarm nothing),
  * the real-detector backend path (mocked PersonDetector + image loader),
  * graceful stub fallback when the image or detector fails,
  * no-GPS-fix guard, injected clock, site.json-shaped input dicts.

Pure stdlib + numpy (for the dummy frame). No hardware, no ultralytics.
"""
from __future__ import annotations


import pytest

np = pytest.importorskip("numpy")

import eis_companion.vision.staging as staging  # noqa: E402
from eis_companion.types import TargetObservation  # noqa: E402
from eis_companion.vision.staging import (  # noqa: E402
    DEFAULT_ARRIVAL_RADIUS_M,
    StagingObserver,
    StagingPoint,
    haversine_m,
)

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

BASE_LAT = -35.363261
BASE_LON = 149.16523

# ~1 degree of latitude in metres (good enough at this scale for offsets)
M_PER_DEG_LAT = 111_320.0


def lat_offset(meters: float) -> float:
    """Latitude delta corresponding to *meters* moved north."""
    return meters / M_PER_DEG_LAT


def point(id="stage-a", truth="vehicle", lat=BASE_LAT, lon=BASE_LON,
          image="site/staging/stage-a.png") -> dict:
    """A staging entry shaped exactly like site.json staging[]."""
    return {"id": id, "lat": lat, "lon": lon, "image": image, "truth": truth}


def observer(truth="vehicle", **kwargs) -> StagingObserver:
    return StagingObserver([point(truth=truth)], **kwargs)


class FakeDetector:
    """Detector stand-in recording calls and returning canned observations."""

    def __init__(self, returns=None, raises=None):
        self.returns = returns if returns is not None else [
            TargetObservation(bbox=(0.1, 0.1, 0.2, 0.2), conf=0.77, ts=0.0)
        ]
        self.raises = raises
        self.frames = []

    def detect(self, frame):
        self.frames.append(frame)
        if self.raises is not None:
            raise self.raises
        return list(self.returns)


DUMMY_FRAME = np.zeros((16, 16, 3), dtype=np.uint8)


# --------------------------------------------------------------------------
# Geometry sanity
# --------------------------------------------------------------------------

def test_haversine_known_offset():
    d = haversine_m(BASE_LAT, BASE_LON, BASE_LAT + lat_offset(100.0), BASE_LON)
    assert d == pytest.approx(100.0, rel=0.01)


# --------------------------------------------------------------------------
# Distance gating
# --------------------------------------------------------------------------

def test_no_emission_when_far():
    obs = observer()
    got = obs.observe(BASE_LAT + lat_offset(100.0), BASE_LON, 30.0)
    assert got == []


def test_emits_within_default_radius():
    obs = observer(truth="vehicle")
    got = obs.observe(BASE_LAT + lat_offset(10.0), BASE_LON, 30.0)
    assert len(got) == 1
    o = got[0]
    assert isinstance(o, TargetObservation)
    assert o.conf >= 0.8
    x, y, w, h = o.bbox
    assert 0.0 <= x <= 1.0 and 0.0 <= y <= 1.0
    assert w > 0.0 and h > 0.0 and x + w <= 1.0 and y + h <= 1.0


def test_default_radius_is_15m():
    assert DEFAULT_ARRIVAL_RADIUS_M == pytest.approx(15.0)
    obs = observer()
    # 20 m out: beyond the default threshold
    assert obs.observe(BASE_LAT + lat_offset(20.0), BASE_LON) == []
    # 14 m out: inside it
    assert len(obs.observe(BASE_LAT + lat_offset(14.0), BASE_LON)) == 1


def test_arrival_radius_configurable():
    near = BASE_LAT + lat_offset(25.0)
    wide = observer(arrival_radius_m=30.0)
    tight = observer(arrival_radius_m=15.0)
    assert len(wide.observe(near, BASE_LON)) == 1
    assert tight.observe(near, BASE_LON) == []


def test_no_fix_guard_at_null_island():
    # VehicleState lat/lon default to 0.0 before the first GPS fix; a
    # staging point near (0, 0) must not match the bogus origin.
    obs = StagingObserver([point(lat=0.00001, lon=0.0)])
    assert obs.observe(0.0, 0.0, 0.0) == []
    # ...but a real position right next to it still works.
    assert len(obs.observe(0.00002, 0.0, 0.0)) == 1


def test_non_finite_position_ignored():
    obs = observer()
    assert obs.observe(float("nan"), BASE_LON) == []
    assert obs.observe(BASE_LAT, float("inf")) == []


# --------------------------------------------------------------------------
# Debounce / re-arm
# --------------------------------------------------------------------------

def test_single_emission_per_arrival_when_repeat_1():
    obs = observer(emit_repeat=1)
    inside = (BASE_LAT + lat_offset(5.0), BASE_LON)
    assert len(obs.observe(*inside)) == 1
    # Staying inside: silent, however many ticks pass.
    for _ in range(20):
        assert obs.observe(*inside) == []


def test_burst_length_matches_emit_repeat():
    obs = observer(emit_repeat=3)
    inside = (BASE_LAT + lat_offset(5.0), BASE_LON)
    emitted = [len(obs.observe(*inside)) for _ in range(6)]
    assert emitted == [1, 1, 1, 0, 0, 0]


def test_rearm_after_leaving_threshold():
    obs = observer(emit_repeat=1)
    inside = (BASE_LAT + lat_offset(5.0), BASE_LON)
    outside = (BASE_LAT + lat_offset(50.0), BASE_LON)
    assert len(obs.observe(*inside)) == 1
    assert obs.observe(*inside) == []          # debounced
    assert obs.observe(*outside) == []         # left -> re-armed
    assert len(obs.observe(*inside)) == 1      # second arrival emits again


def test_leaving_mid_burst_cancels_and_rearms():
    obs = observer(emit_repeat=3)
    inside = (BASE_LAT + lat_offset(5.0), BASE_LON)
    outside = (BASE_LAT + lat_offset(50.0), BASE_LON)
    assert len(obs.observe(*inside)) == 1
    assert obs.observe(*outside) == []         # burst cancelled
    assert len(obs.observe(*inside)) == 1      # fresh arrival, fresh burst


def test_reset_rearms_all_points():
    obs = observer(emit_repeat=1)
    inside = (BASE_LAT + lat_offset(5.0), BASE_LON)
    assert len(obs.observe(*inside)) == 1
    obs.reset()
    assert len(obs.observe(*inside)) == 1


# --------------------------------------------------------------------------
# Truth -> observation mapping (offline stub backend)
# --------------------------------------------------------------------------

@pytest.mark.parametrize("truth", ["vehicle", "breach"])
def test_truth_high_confidence_single_observation(truth):
    got = observer(truth=truth).observe(BASE_LAT, BASE_LON)
    assert len(got) == 1
    assert got[0].conf >= 0.8


def test_truth_structure_low_confidence():
    got = observer(truth="structure").observe(BASE_LAT, BASE_LON)
    assert len(got) == 1
    assert got[0].conf < 0.5


def test_truth_false_alarm_no_observation():
    assert observer(truth="false_alarm").observe(BASE_LAT, BASE_LON) == []


def test_unknown_truth_emits_nothing():
    assert observer(truth="martian").observe(BASE_LAT, BASE_LON) == []


def test_truth_case_insensitive():
    got = observer(truth="  VEHICLE ").observe(BASE_LAT, BASE_LON)
    assert len(got) == 1 and got[0].conf >= 0.8


def test_stub_is_deterministic_across_arrivals():
    obs = observer(truth="breach", emit_repeat=1)
    inside = (BASE_LAT, BASE_LON)
    outside = (BASE_LAT + lat_offset(50.0), BASE_LON)
    first = obs.observe(*inside)
    obs.observe(*outside)
    second = obs.observe(*inside)
    assert [(o.bbox, o.conf) for o in first] == [(o.bbox, o.conf) for o in second]


def test_ts_uses_injected_clock():
    obs = observer(clock=lambda: 1234.5)
    got = obs.observe(BASE_LAT, BASE_LON)
    assert got and got[0].ts == pytest.approx(1234.5)


# --------------------------------------------------------------------------
# Multiple staging points
# --------------------------------------------------------------------------

def test_only_the_near_point_emits():
    far_lat = BASE_LAT + lat_offset(500.0)
    obs = StagingObserver([
        point(id="a", truth="vehicle", lat=BASE_LAT),
        point(id="b", truth="breach", lat=far_lat),
    ], emit_repeat=1)
    got = obs.observe(BASE_LAT, BASE_LON)
    assert len(got) == 1  # only point a
    # Fly to point b: its own arrival emits, a re-armed but not re-entered.
    got_b = obs.observe(far_lat, BASE_LON)
    assert len(got_b) == 1


def test_points_debounce_independently():
    far_lat = BASE_LAT + lat_offset(500.0)
    obs = StagingObserver([
        point(id="a", truth="vehicle", lat=BASE_LAT),
        point(id="b", truth="breach", lat=far_lat),
    ], emit_repeat=1)
    assert len(obs.observe(BASE_LAT, BASE_LON)) == 1
    assert len(obs.observe(far_lat, BASE_LON)) == 1
    # Back at a WITHOUT having left... a was left when we flew to b, so it
    # re-armed and emits again; b stays silent (still armed-out at 500 m).
    assert len(obs.observe(BASE_LAT, BASE_LON)) == 1


# --------------------------------------------------------------------------
# Real-detector backend path
# --------------------------------------------------------------------------

def test_injected_detector_is_used_instead_of_stub():
    fake = FakeDetector()
    # truth=false_alarm would stub to []; the fake returning one obs proves
    # the real path ran.
    obs = StagingObserver(
        [point(truth="false_alarm")],
        detector=fake,
        image_loader=lambda path: DUMMY_FRAME,
        clock=lambda: 42.0,
    )
    got = obs.observe(BASE_LAT, BASE_LON)
    assert len(got) == 1
    assert got[0].conf == pytest.approx(0.77)
    assert got[0].bbox == (0.1, 0.1, 0.2, 0.2)
    assert got[0].ts == pytest.approx(42.0)      # re-stamped on emission
    assert len(fake.frames) == 1                 # detector saw the loaded frame
    assert fake.frames[0] is DUMMY_FRAME


def test_detector_runs_once_per_arrival_not_per_tick():
    fake = FakeDetector()
    obs = StagingObserver(
        [point(truth="vehicle")],
        detector=fake,
        image_loader=lambda path: DUMMY_FRAME,
        emit_repeat=3,
    )
    for _ in range(5):
        obs.observe(BASE_LAT, BASE_LON)
    assert len(fake.frames) == 1


def test_image_root_prefixes_relative_paths():
    seen = []

    def loader(path):
        seen.append(path)
        return DUMMY_FRAME

    obs = StagingObserver(
        [point(image="site/staging/stage-a.png")],
        detector=FakeDetector(),
        image_loader=loader,
        image_root="C:/repo",
    )
    obs.observe(BASE_LAT, BASE_LON)
    assert len(seen) == 1
    assert seen[0].replace("\\", "/") == "C:/repo/site/staging/stage-a.png"


def test_real_backend_resolved_via_mocked_import(monkeypatch):
    """With ultralytics 'importable' (PersonDetector patched), the observer
    builds the real backend itself and emits its detections."""
    constructed = {}

    class PatchedDetector(FakeDetector):
        def __init__(self, **kwargs):
            super().__init__()
            constructed.update(kwargs)

    monkeypatch.setattr(staging, "PersonDetector", PatchedDetector)
    monkeypatch.setattr(staging, "_default_image_loader", lambda p: DUMMY_FRAME)

    obs = StagingObserver(
        [point(truth="false_alarm")],
        detector_kwargs={"conf_threshold": 0.5, "device": "cpu"},
    )
    got = obs.observe(BASE_LAT, BASE_LON)
    assert len(got) == 1                       # fake detection, not the [] stub
    assert got[0].conf == pytest.approx(0.77)
    assert constructed == {"conf_threshold": 0.5, "device": "cpu"}


def test_missing_ultralytics_falls_back_to_stub(monkeypatch):
    """PersonDetector raising ImportError (no ultralytics) -> stub backend."""

    def boom(**kwargs):
        raise ImportError("ultralytics is not installed")

    monkeypatch.setattr(staging, "PersonDetector", boom)
    obs = StagingObserver([point(truth="vehicle")])
    got = obs.observe(BASE_LAT, BASE_LON)
    assert len(got) == 1 and got[0].conf >= 0.8   # stub result


def test_image_load_failure_falls_back_to_stub():
    obs = StagingObserver(
        [point(truth="breach")],
        detector=FakeDetector(),
        image_loader=lambda path: None,           # unreadable image
    )
    got = obs.observe(BASE_LAT, BASE_LON)
    assert len(got) == 1 and got[0].conf >= 0.8   # stub 'breach' result


def test_detector_exception_falls_back_to_stub():
    obs = StagingObserver(
        [point(truth="vehicle")],
        detector=FakeDetector(raises=RuntimeError("cuda exploded")),
        image_loader=lambda path: DUMMY_FRAME,
    )
    got = obs.observe(BASE_LAT, BASE_LON)
    assert len(got) == 1 and got[0].conf >= 0.8   # stub 'vehicle' result


def test_empty_real_result_is_respected_not_stubbed():
    # A real detector legitimately finding nothing must NOT trigger the
    # stub -- an empty real result is a real result.
    obs = StagingObserver(
        [point(truth="vehicle")],                 # stub would emit one obs
        detector=FakeDetector(returns=[]),
        image_loader=lambda path: DUMMY_FRAME,
    )
    assert obs.observe(BASE_LAT, BASE_LON) == []


# --------------------------------------------------------------------------
# Input shapes
# --------------------------------------------------------------------------

def test_accepts_site_json_shaped_dicts_and_dataclass():
    sp = StagingPoint.from_dict(point(id="x", truth="VEHICLE"))
    assert sp.id == "x" and sp.truth == "vehicle"
    obs = StagingObserver([sp, point(id="y", lat=BASE_LAT + lat_offset(500.0))])
    assert len(obs.points) == 2
    assert all(isinstance(p, StagingPoint) for p in obs.points)


def test_empty_staging_list_is_fine():
    obs = StagingObserver([])
    assert obs.observe(BASE_LAT, BASE_LON) == []
