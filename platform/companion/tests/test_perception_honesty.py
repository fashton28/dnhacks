"""Perception must report what it actually saw (FM-25/98/99/100/101/113-127).

The observation-state invariant in docs/FAILURE_MODES.md: a healthy frame with
zero tracks is a VALID observation and may support `false_alarm`; "no
observation" is reserved for a missing, stale, failed or invalid frame. Several
paths collapsed the two, and several fabricated evidence outright.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from eis_companion.app import Companion, FrameUnavailable, _CameraSource
from eis_companion.config import AppConfig
from eis_companion.control.fusion import UNCLASSIFIED, SensorTrack, class_compatible, fuse_tracks
from eis_companion.types import Limits, TargetObservation, VehicleState
from eis_companion.vision.detector import DEFAULT_CONF_THRESHOLD, SUPPORTED_CLASSES
from eis_companion.vision.lidar import (
    FENCE_GAP_VOTES,
    FENCE_SAMPLE_SPACING_M,
    LidarGeometryDetector,
    SyntheticLidarSource,
    classify_cluster,
)
from eis_companion.vision.multimodal import StagedSensorSuite, observation_message
from eis_companion.vision.staging import (
    STUB_DETECTIONS,
    STUB_MIN_CONFIDENCE,
    StagingObserver,
)

ROOT = Path(__file__).resolve().parents[2]
STUB_SITE = "site/site.stub.json"
FAR_LAT, FAR_LON = -26.09065, 29.46925


def site_raw() -> dict:
    return json.loads((ROOT / "site/site.stub.json").read_text(encoding="utf-8"))


def suite() -> StagedSensorSuite:
    raw = site_raw()
    return StagedSensorSuite(
        raw["staging"],
        home=(raw["home"]["lat"], raw["home"]["lon"]),
        perimeter=raw["perimeter"],
        image_root=str(ROOT),
    )


def run(coro):
    return asyncio.run(coro)


# ==========================================================================
# FM-100 / FM-101: a dead camera is UNHEALTHY, not an empty frame
# ==========================================================================
class DeadCapture:
    def read(self):
        return False, None


class GoodCapture:
    def read(self):
        return True, object()


class EmptyDetector:
    last_inference_failed = False

    def detect(self, frame):
        return []


class FailingDetector:
    last_inference_failed = True

    def detect(self, frame):
        return []


def test_a_failed_camera_read_raises_instead_of_reporting_an_empty_frame():
    source = _CameraSource(DeadCapture(), EmptyDetector())
    with pytest.raises(FrameUnavailable):
        run(source.observe())


def test_a_failed_inference_raises_instead_of_reporting_an_empty_frame():
    source = _CameraSource(GoodCapture(), FailingDetector())
    with pytest.raises(FrameUnavailable):
        run(source.observe())


def test_a_healthy_empty_frame_is_a_valid_observation():
    """Control: zero tracks from a WORKING camera must stay valid."""
    source = _CameraSource(GoodCapture(), EmptyDetector())
    assert run(source.observe()) == []


def make_companion(camera_source="sim") -> Companion:
    cfg = AppConfig()
    cfg.sitl = True
    cfg.camera.source = camera_source
    cfg.planner.site_file = STUB_SITE
    c = Companion(cfg)
    c.setup()
    c.vehicle = None
    c._fc_ready = True
    return c


def test_the_orchestrator_marks_the_camera_rail_unhealthy_on_a_dead_frame():
    c = make_companion()
    c.source = _CameraSource(DeadCapture(), EmptyDetector())
    c.staging_observer = None
    c.sensor_suite = None
    events: list = []

    class Api:
        async def broadcast(self, message):
            events.append(dict(message))

        async def push_tracking(self, tracking):
            pass

        async def push_status(self, severity, text):
            pass

    c.api = Api()
    run(c._perception_tick())
    assert c._camera_source_valid is False
    failures = [
        e for e in events
        if e.get("type") == "healthEvent" and e.get("state") == "failed"
    ]
    assert failures, "a dead camera must raise a 'failed' health event"
    assert "no observation" in failures[0]["detail"]


def test_the_real_detector_is_constructed_with_the_right_keyword():
    """PersonDetector(conf=...) raised TypeError on EVERY real-camera build,
    and the blanket except reported that bug as 'no hardware' (FM-101)."""
    import inspect

    from eis_companion.vision.detector import PersonDetector

    signature = inspect.signature(PersonDetector.__init__)
    assert "conf_threshold" in signature.parameters
    # The alias exists so the same mistake cannot be fatal again.
    assert "conf" in signature.parameters

    source = inspect.getsource(Companion._build_vision_source)
    assert "conf_threshold=cfg.detector.conf" in source
    assert "except TypeError" in source, (
        "a construction BUG must be distinguishable from absent hardware"
    )


# ==========================================================================
# FM-25: fixture health is per-point and is not clobbered
# ==========================================================================
def test_fixture_health_reports_which_point_is_bad(tmp_path):
    raw = site_raw()
    points = [
        dict(raw["staging"][0], image="missing.png"),
        dict(raw["staging"][1]),
    ]
    (tmp_path / "site").mkdir()
    s = StagedSensorSuite(
        points, home=(raw["home"]["lat"], raw["home"]["lon"]),
        perimeter=raw["perimeter"], image_root=str(ROOT),
    )
    health = s.asset_health()
    assert health[points[0]["id"]]["rgb"] is False
    assert health[points[1]["id"]]["rgb"] is True
    assert s.unhealthy_points()["rgb"] == (points[0]["id"],)


def test_the_perception_loop_cannot_overwrite_the_fixture_verdict():
    """`camera.source: sim` cannot fail, so one tick used to erase the
    startup fixture verdict ~100 ms after boot."""
    c = make_companion()
    c._camera_fixture_valid = False
    c.staging_observer = None
    c.sensor_suite = None

    class Api:
        async def broadcast(self, message):
            pass

        async def push_tracking(self, tracking):
            pass

    c.api = Api()
    run(c._perception_tick())
    assert c._camera_source_valid is True      # the live rail IS healthy
    assert c._camera_fixture_valid is False    # ...the fixture verdict stands


def test_connect_messages_name_the_unhealthy_fixture():
    c = make_companion()
    c._camera_fixture_valid = False
    c._sensor_fixture_gaps = {"rgb": ("komati-west-service-road",), "thermal": ()}
    messages = c._connect_messages()
    camera = [
        m for m in messages
        if m.get("component") == "camera" and m.get("state") == "unavailable"
    ]
    assert camera and "komati-west-service-road" in camera[0]["detail"]


def test_every_site_fixture_referenced_by_the_stub_actually_exists():
    """A staging arrival otherwise produces 'no observation' at demo time."""
    raw = site_raw()
    for point in raw["staging"]:
        for key in ("image", "thermal_image"):
            path = ROOT / point[key]
            assert path.is_file(), f"{point['id']}.{key} -> {path} is missing"
            header = path.read_bytes()[:12]
            assert header.startswith(b"\x89PNG\r\n\x1a\n") or header.startswith(
                b"\xff\xd8\xff"
            ), f"{path} is not a PNG/JPEG"


# ==========================================================================
# FM-98: a person-only backend is a CAPABILITY, not a silent nothing
# ==========================================================================
class PersonOnlyDetector:
    supported_classes = SUPPORTED_CLASSES

    def detect(self, frame):
        return []


def test_a_person_only_backend_reports_the_truths_it_cannot_produce():
    observer = StagingObserver(
        [{"id": "p", "lat": 0.001, "lon": 0.001, "image": "x.png", "truth": "vehicle"}],
        detector=PersonOnlyDetector(),
        image_loader=lambda path: object(),
    )
    assert observer.observe(0.001, 0.001) == []
    caps = observer.capabilities()
    assert caps["backend"] == "detector"
    assert "vehicle" in caps["unsupported_truths"]
    assert "structure" in caps["unsupported_truths"]


def test_the_capability_gap_reaches_the_wire():
    c = make_companion()
    c._detector_capabilities = {
        "backend": "detector", "classes": ["person"],
        "unsupported_truths": ["structure", "vehicle"], "conf_threshold": 0.3,
    }
    messages = c._connect_messages()
    caps = [m for m in messages if m["type"] == "capabilities"][0]
    assert caps["detector"]["classes"] == ["person"]
    gaps = [m for m in messages if m.get("state") == "capability_gap"]
    assert gaps and "vehicle" in gaps[0]["detail"]


def test_an_unrestricted_backend_makes_no_capability_claim_on_its_behalf():
    class AnyClassDetector:
        def detect(self, frame):
            return [TargetObservation(bbox=(0.1, 0.1, 0.2, 0.2), conf=0.9)]

    observer = StagingObserver(
        [{"id": "p", "lat": 0.001, "lon": 0.001, "image": "x.png", "truth": "vehicle"}],
        detector=AnyClassDetector(),
        image_loader=lambda path: object(),
    )
    assert len(observer.observe(0.001, 0.001)) == 1
    assert observer.capabilities()["unsupported_truths"] == []


# ==========================================================================
# FM-121: every stub cue is reachable by the real backend
# ==========================================================================
def test_every_stub_confidence_clears_the_detector_threshold():
    assert STUB_MIN_CONFIDENCE >= DEFAULT_CONF_THRESHOLD, (
        f"the offline demo shows a cue at {STUB_MIN_CONFIDENCE:.2f} that the "
        f"real backend gates out at {DEFAULT_CONF_THRESHOLD:.2f}"
    )
    for truth, entries in STUB_DETECTIONS.items():
        for _, conf, _ in entries:
            assert conf >= DEFAULT_CONF_THRESHOLD, truth


# ==========================================================================
# FM-122: a parked vehicle is not a locked person
# ==========================================================================
def test_the_stub_carries_the_object_class():
    observer = StagingObserver(
        [{"id": "p", "lat": 0.001, "lon": 0.001, "image": "x.png", "truth": "vehicle"}],
    )
    got = observer.observe(0.001, 0.001)
    assert got and got[0].cls == "vehicle"


def test_non_person_observations_stay_off_the_person_tracking_wire():
    c = make_companion()
    c.source = None
    c.sensor_suite = None
    seen: list = []

    class Tracker:
        def update(self, observations, ts):
            seen.append(list(observations))
            return SimpleNamespace(
                state="searching", targets=[], locked_target_id=None,
                locked_bbox=None, estimated_distance=None,
            )

        def select(self, tid):
            pass

    class Observer:
        def observe(self, lat, lon, rel_alt=0.0):
            return [
                TargetObservation(bbox=(0.3, 0.3, 0.2, 0.2), conf=0.91, cls="vehicle"),
                TargetObservation(bbox=(0.5, 0.3, 0.1, 0.3), conf=0.90, cls="person"),
            ]

        def reset(self):
            pass

    class Api:
        async def broadcast(self, message):
            pass

        async def push_tracking(self, tracking):
            pass

    c.tracker = Tracker()
    c.staging_observer = Observer()
    c.api = Api()
    c._planner_engaged = True
    c._vehicle_state = VehicleState(
        armed=True, airborne=True, mode="GUIDED", lat=FAR_LAT, lon=FAR_LON, relAlt=25.0
    )
    run(c._perception_tick())
    assert seen and len(seen[0]) == 1
    assert seen[0][0].cls == "person"


# ==========================================================================
# FM-118: no fabricated proximity data
# ==========================================================================
def test_no_proximity_frames_are_published_from_a_staged_observation():
    """min(ranges) went into all 72 OBSTACLE_DISTANCE sectors -- a wall in
    every direction, computed in the STAGING POINT's frame, not the vehicle's."""
    c = make_companion()
    c.source = None
    calls: list = []

    class Vehicle:
        limits = Limits()

        def send_distance_sensor(self, distance_m, **kwargs):
            calls.append(("distance", distance_m))
            return True

        def send_obstacle_distance(self, distances_cm):
            calls.append(("obstacle", list(distances_cm)))
            return True

        def update_limits(self, limits):
            pass

    class Tracker:
        def update(self, observations, ts):
            return SimpleNamespace(
                state="searching", targets=[], locked_target_id=None,
                locked_bbox=None, estimated_distance=None,
            )

        def select(self, tid):
            pass

    class Api:
        def __init__(self):
            self.sent = []

        async def broadcast(self, message):
            self.sent.append(dict(message))

        async def push_tracking(self, tracking):
            pass

    c.vehicle = Vehicle()
    c.tracker = Tracker()
    c.staging_observer = None
    c.api = Api()
    c._planner_engaged = True
    c._vehicle_state = VehicleState(
        armed=True, airborne=True, mode="GUIDED", lat=FAR_LAT, lon=FAR_LON, relAlt=25.0
    )
    run(c._perception_tick())
    assert calls == [], "staged, staging-point-framed ranges are not proximity data"
    # ...and the observation itself still reaches the operator.
    assert any(m.get("type") == "observation" for m in c.api.sent)


def test_the_observation_declares_its_frame_and_its_provenance():
    s = suite()
    point = site_raw()["staging"][0]
    observation = s.observe(point["lat"], point["lon"])
    assert observation is not None
    assert observation.scripted is True
    assert observation.range_frame == "staging_point"
    message = observation_message(observation, "eis-1")
    assert "SCRIPTED" in message["scene"], (
        "scripted evidence must be labelled as such on the wire (FM-99)"
    )


# ==========================================================================
# FM-113 / FM-115: LiDAR geometry produces usable, classified evidence
# ==========================================================================
def lidar_result(truth: str):
    raw = site_raw()
    origin = (raw["staging"][0]["lat"], raw["staging"][0]["lon"])
    source = SyntheticLidarSource((raw["home"]["lat"], raw["home"]["lon"]),
                                  raw["perimeter"])
    detector = LidarGeometryDetector(origin, raw["perimeter"])
    result = None
    for scan in range(FENCE_GAP_VOTES):
        result = detector.detect(source.frame(truth, origin, scan_index=scan))
    return result, detector


def test_a_structure_fixture_produces_lidar_evidence():
    """The box grid was sampled at 1.667 m against a 1.5 m cluster radius, so
    it fragmented into zero-extent slabs: 0 tracks, 0 new_structures (FM-113)."""
    result, _ = lidar_result("structure")
    assert result.valid
    assert result.tracks, "a 5 x 4 x 3 m structure must produce a LiDAR cluster"
    assert any(t.cls == "structure" for t in result.tracks)
    assert result.geometry.new_structures


def test_a_vehicle_fixture_still_produces_a_vehicle_track():
    result, _ = lidar_result("vehicle")
    assert any(t.cls == "vehicle" for t in result.tracks)


def test_lidar_can_corroborate_a_person():
    """The vocabulary was the single hardcoded string 'vehicle', so a LiDAR
    return could never confirm the one class the mission is about (FM-115)."""
    result, _ = lidar_result("breach")
    assert any(t.cls == "person" for t in result.tracks)


def test_the_flat_fence_line_is_not_reported_as_a_structure():
    """Control: the perimeter ring clusters into one enormous flat run."""
    assert classify_cluster(50_000.0, 0.0) == ""
    assert classify_cluster(0.24, 1.8) == "person"
    assert classify_cluster(8.0, 1.8) == "vehicle"
    assert classify_cluster(20.0, 3.0) == "structure"


def test_an_unclassified_geometric_return_can_corroborate_any_class():
    assert class_compatible(UNCLASSIFIED, "person") is True
    assert class_compatible("vehicle", "person") is False
    fused = fuse_tracks([
        SensorTrack(1, "person", 0.0, 10.0, 0.9, "rgb"),
        SensorTrack(2, UNCLASSIFIED, 0.5, 10.2, 0.8, "lidar"),
    ])
    combined = [t for t in fused.tracks if t.modality == "fused"]
    assert combined and combined[0].cls == "person"


# ==========================================================================
# FM-116 / FM-117: the fence-gap debounce is real, and width is metres
# ==========================================================================
def test_the_fence_gap_debounce_accumulates_across_distinct_scans():
    """A fresh detector per observation reset _gap_votes every time, so the
    3-scan debounce was structurally unreachable (FM-116)."""
    result, detector = lidar_result("breach")
    assert result.geometry.fence_gaps, "a persistent detector must accumulate votes"
    assert max(detector.gap_votes.values()) >= FENCE_GAP_VOTES


def test_one_scan_alone_never_reports_a_gap():
    raw = site_raw()
    origin = (raw["staging"][0]["lat"], raw["staging"][0]["lon"])
    source = SyntheticLidarSource((raw["home"]["lat"], raw["home"]["lon"]),
                                  raw["perimeter"])
    detector = LidarGeometryDetector(origin, raw["perimeter"])
    first = detector.detect(source.frame("breach", origin, scan_index=0))
    assert first.geometry.fence_gaps == ()


def test_the_gap_width_is_metres_derived_from_the_sample_spacing():
    result, _ = lidar_result("breach")
    gap = result.geometry.fence_gaps[0]
    assert gap["width_m"] > 0.0
    # 5 removed samples at the shared spacing constant.
    assert gap["width_m"] == pytest.approx(5.0 * FENCE_SAMPLE_SPACING_M)


# ==========================================================================
# FM-119: the synthetic scanner has a finite range
# ==========================================================================
def test_the_synthetic_lidar_is_range_gated():
    raw = site_raw()
    origin = (raw["staging"][0]["lat"], raw["staging"][0]["lon"])
    source = SyntheticLidarSource(
        (raw["home"]["lat"], raw["home"]["lon"]), raw["perimeter"], max_range_m=120.0
    )
    points = source.frame("vehicle", origin)
    assert points
    for x, y, z in points:
        assert (x * x + y * y + z * z) ** 0.5 <= 120.0 + 1e-6


def test_a_range_gate_does_not_manufacture_fence_gaps():
    """An expected sample beyond the scanner's reach is not missing fence."""
    raw = site_raw()
    origin = (raw["staging"][0]["lat"], raw["staging"][0]["lon"])
    source = SyntheticLidarSource(
        (raw["home"]["lat"], raw["home"]["lon"]), raw["perimeter"], max_range_m=50.0
    )
    detector = LidarGeometryDetector(origin, raw["perimeter"], max_range_m=50.0)
    result = None
    for scan in range(FENCE_GAP_VOTES):
        result = detector.detect(source.frame("vehicle", origin, scan_index=scan))
    assert result.geometry.fence_gaps == ()


# ==========================================================================
# FM-127: overlapping staging radii do not swallow observations
# ==========================================================================
def test_an_unobserved_in_radius_point_stays_pending():
    """observe() marked EVERY in-radius point as inside while emitting at most
    one, consuming the others' arrival edge silently (FM-127)."""
    raw = site_raw()
    a = dict(raw["staging"][0])
    b = dict(raw["staging"][1], lat=a["lat"] + 0.00002, lon=a["lon"])
    s = StagedSensorSuite(
        [a, b], home=(raw["home"]["lat"], raw["home"]["lon"]),
        perimeter=raw["perimeter"], image_root=str(ROOT), arrival_radius_m=100.0,
    )
    first = s.observe(a["lat"], a["lon"])
    second = s.observe(a["lat"], a["lon"])
    assert first is not None and second is not None
    assert {first.staging_id, second.staging_id} == {a["id"], b["id"]}
    assert s.observe(a["lat"], a["lon"]) is None      # both consumed now
