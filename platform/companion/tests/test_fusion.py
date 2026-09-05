from eis_companion.control.fusion import SensorTrack, fuse_tracks


def track(track_id, bearing, modality, *, distance=10.0, confidence=0.8):
    return SensorTrack(track_id, "person", bearing, distance, confidence, modality)


def test_bearing_fusion_wraps_across_north():
    result = fuse_tracks([track(1, 359.0, "rgb"), track(2, 1.0, "thermal")])
    fused = result.tracks[-1]
    assert fused.modality == "fused"
    assert fused.bearing_deg < 2.0 or fused.bearing_deg > 358.0


def test_only_closest_track_per_modality_is_grouped():
    result = fuse_tracks([
        track(1, 0.0, "rgb"), track(2, 1.0, "thermal"), track(3, 4.0, "thermal")
    ])
    fused = [item for item in result.tracks if item.modality == "fused"]
    assert len(fused) == 1
    assert any(item.id == 3 and item.conf == 0.65 for item in result.tracks)


def test_malformed_tracks_are_dropped_and_empty_is_valid():
    result = fuse_tracks([track(1, float("nan"), "rgb"), track(2, 1.0, "lidar", distance=-1)])
    assert result.tracks == ()
    assert fuse_tracks([]).tracks == ()
