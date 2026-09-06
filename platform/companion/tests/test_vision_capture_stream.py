"""Capture backend selection and the mediamtx/GStreamer stream supervisor.

Both modules exist to make a laptop behave like a Jetson. The contracts that
matter are the degradation paths, because they are the ones exercised on every
dev box and in every SITL acceptance run:

  * `Capture` must open a synthetic source with no OpenCV and no camera, and
    must refuse -- visibly, returning False -- rather than half-open anything
    else when OpenCV is absent.
  * `Capture` is constructed by the orchestrator with KEYWORD settings
    (`Capture(source=..., width=...)`). A signature that only accepted a dict
    made every real-camera build raise TypeError, which the caller's handler
    reports as absent hardware -- the FM-101 shape.
  * `VideoStream` must never raise and must keep mediamtx running when only
    the publisher is missing, since an external publisher can still feed it.
"""
from __future__ import annotations

import numpy as np
import pytest

from eis_companion.vision import capture as capture_mod
from eis_companion.vision.capture import Capture, CaptureSettings
from eis_companion.stream import video as video_mod
from eis_companion.stream.video import STREAM_PATH, StreamConfig, VideoStream, build_gst_pipeline


# ===========================================================================
# Capture -- settings resolution
# ===========================================================================

def test_the_orchestrator_keyword_form_constructs():
    """This is exactly how app.py builds it."""
    cap = Capture(source="v4l2", device="/dev/video0", width=640, height=480, fps=15)
    assert cap.source == "v4l2"
    assert (cap.width, cap.height, cap.fps) == (640, 480, 15)
    assert cap.settings.device == "/dev/video0"


def test_the_mapping_form_constructs():
    cap = Capture({"source": "SIM", "width": 320, "height": 240})
    assert cap.source == "sim"          # normalised to lower case
    assert (cap.width, cap.height) == (320, 240)


def test_keyword_settings_win_over_the_mapping():
    cap = Capture({"source": "csi", "width": 1280}, width=800)
    assert cap.width == 800


def test_none_means_not_supplied():
    cap = Capture({"source": "sim"}, width=None)
    assert cap.width == 1280


def test_the_yaml_file_key_is_accepted_as_an_alias_for_file_path():
    assert Capture(source="file", file="/clips/a.mp4").settings.file_path == "/clips/a.mp4"


def test_an_unknown_setting_is_refused_rather_than_silently_dropped():
    with pytest.raises(TypeError) as excinfo:
        Capture(source="sim", widht=640)
    assert "widht" in str(excinfo.value)


def test_defaults_match_the_documented_capture_configuration():
    settings = CaptureSettings.resolve()
    assert settings.source == "csi"
    assert settings.frame_size == (1280, 720)
    assert settings.fps == 30
    assert settings.flip == 0 and settings.sensor_id == 0


# ===========================================================================
# Capture -- synthetic backend (the SITL / dev-box path)
# ===========================================================================

def test_the_synthetic_source_opens_with_no_camera_and_no_opencv(monkeypatch):
    monkeypatch.setattr(capture_mod, "_CV2_AVAILABLE", False)
    cap = Capture(source="sim", width=160, height=120)
    assert cap.open() is True
    assert cap.is_opened() is True
    ok, frame = cap.read()
    assert ok is True
    assert frame.shape == (120, 160, 3)
    assert frame.dtype == np.uint8
    cap.release()
    assert cap.is_opened() is False


@pytest.mark.parametrize("name", ["sim", "mock"])
def test_both_synthetic_source_names_are_accepted(name):
    with Capture(source=name, width=64, height=48) as cap:
        assert cap.is_opened() is True
        assert cap.read()[0] is True


def test_an_injected_sim_source_is_used_as_is():
    class Scripted:
        def __init__(self):
            self.frames = 0

        def render_frame(self):
            self.frames += 1
            return np.full((48, 64, 3), 7, dtype=np.uint8)

    scripted = Scripted()
    cap = Capture({"source": "mock"}, sim_source=scripted)
    cap.open()
    ok, frame = cap.read()
    assert ok and scripted.frames == 1
    assert int(frame[0, 0, 0]) == 7


def test_reading_before_open_and_after_release_reports_failure_not_a_blank_frame():
    """A blank frame would read as a healthy observation of nobody (FM-100)."""
    cap = Capture(source="sim")
    assert cap.read() == (False, None)
    cap.open()
    cap.release()
    assert cap.read() == (False, None)


def test_a_backend_that_raises_while_reading_degrades_to_a_failed_read():
    class Exploding:
        def render_frame(self):
            raise RuntimeError("renderer died")

    cap = Capture(source="sim", sim_source=Exploding())
    cap.open()
    assert cap.read() == (False, None)


def test_release_is_idempotent():
    cap = Capture(source="sim")
    cap.open()
    cap.release()
    cap.release()
    assert cap.is_opened() is False


# ===========================================================================
# Capture -- refusals
# ===========================================================================

def test_an_unknown_source_fails_to_open():
    cap = Capture(source="thermal-x")
    assert cap.open() is False
    assert cap.is_opened() is False


@pytest.mark.parametrize("source", ["csi", "v4l2", "file"])
def test_device_sources_refuse_to_open_without_opencv(monkeypatch, source):
    monkeypatch.setattr(capture_mod, "_CV2_AVAILABLE", False)
    cap = Capture(source=source, file_path="/clips/a.mp4")
    assert cap.open() is False
    assert cap.read() == (False, None)


def test_the_file_backend_refuses_without_a_path(monkeypatch):
    monkeypatch.setattr(capture_mod, "_CV2_AVAILABLE", True)
    monkeypatch.setattr(capture_mod, "cv2", object(), raising=False)
    assert Capture(source="file").open() is False


def test_the_csi_pipeline_stays_on_the_low_latency_appsink():
    settings = CaptureSettings.resolve(
        {"source": "csi", "width": 1920, "height": 1080, "fps": 60,
         "flip": 2, "sensor_id": 1}
    )
    pipeline = capture_mod._csi_pipeline(settings)
    assert pipeline.startswith("nvarguscamerasrc sensor-id=1")
    assert "width=1920,height=1080,framerate=60/1,format=NV12" in pipeline
    assert "nvvidconv flip-method=2" in pipeline
    # Always the freshest frame, never a growing queue.
    assert pipeline.endswith("appsink drop=1 max-buffers=1")


# ===========================================================================
# StreamConfig
# ===========================================================================

@pytest.mark.parametrize("source", ["sim", "mock", ""])
def test_a_sourceless_configuration_advertises_no_video(source):
    assert StreamConfig(source=source).has_video is False


@pytest.mark.parametrize("source", ["csi", "v4l2", "file"])
def test_a_real_source_advertises_video(source):
    assert StreamConfig(source=source).has_video is True


def test_the_published_urls_use_the_configured_ports_and_stream_path():
    cfg = StreamConfig(rtsp_port=8554, webrtc_port=8889)
    assert cfg.rtsp_url == f"rtsp://127.0.0.1:8554/{STREAM_PATH}"
    assert cfg.whep_url == f"http://0.0.0.0:8889/{STREAM_PATH}/whep"
    assert STREAM_PATH == "stream"


def test_the_shipped_mediamtx_config_is_found_by_default():
    resolved = StreamConfig().resolved_mediamtx_config()
    assert resolved is not None and resolved.endswith("mediamtx.yml")


def test_an_explicit_mediamtx_config_overrides_the_shipped_one():
    cfg = StreamConfig(mediamtx_config="/etc/eis/mediamtx.yml")
    assert cfg.resolved_mediamtx_config() == "/etc/eis/mediamtx.yml"


# ===========================================================================
# GStreamer pipeline
# ===========================================================================

def stages(argv):
    """Split an argv pipeline back into its `!`-separated element stages."""
    out, current = [], []
    for token in argv:
        if token == "!":
            out.append(current)
            current = []
        else:
            current.append(token)
    out.append(current)
    return out


@pytest.mark.parametrize("source", ["csi", "v4l2", "file", "anything-else"])
def test_every_pipeline_is_well_formed_and_ends_at_mediamtx(source):
    cfg = StreamConfig(source=source, file="/clips/a.mp4")
    argv = build_gst_pipeline(cfg)
    assert argv[0] != "!" and argv[-1] != "!"
    assert all(stage for stage in stages(argv)), "empty element stage"
    assert stages(argv)[-1] == [
        "rtspclientsink", f"location={cfg.rtsp_url}", "latency=0",
    ]
    assert stages(argv)[-2] == ["h264parse"]


def test_the_jetson_path_uses_the_hardware_encoder_in_bits_per_second():
    argv = build_gst_pipeline(StreamConfig(source="csi", bitrate_kbps=2500))
    assert argv[0] == "nvarguscamerasrc"
    assert "video/x-raw(memory:NVMM),width=1280,height=720,framerate=30/1" in argv
    assert "nvv4l2h264enc" in argv
    assert "bitrate=2500000" in argv
    assert "x264enc" not in argv


def test_a_very_low_bitrate_still_leaves_the_hardware_encoder_a_floor():
    argv = build_gst_pipeline(StreamConfig(source="csi", bitrate_kbps=10))
    assert "bitrate=200000" in argv


def test_the_portable_path_uses_software_x264_in_kilobits():
    argv = build_gst_pipeline(StreamConfig(source="v4l2", device="/dev/video3",
                                           bitrate_kbps=1800))
    assert argv[0] == "v4l2src"
    assert "device=/dev/video3" in argv
    assert "x264enc" in argv and "tune=zerolatency" in argv
    assert "bitrate=1800" in argv
    assert "key-int-max=15" in argv       # fast WebRTC start
    assert "nvv4l2h264enc" not in argv


def test_the_file_path_decodes_before_re_encoding():
    argv = build_gst_pipeline(StreamConfig(source="file", file="/clips/a.mp4"))
    assert argv[0] == "filesrc"
    assert "location=/clips/a.mp4" in argv
    assert "decodebin" in argv
    assert "x264enc" in argv


def test_the_caps_stage_carries_the_configured_geometry():
    argv = build_gst_pipeline(StreamConfig(source="v4l2", width=640, height=360, fps=20))
    assert "video/x-raw,width=640,height=360,framerate=20/1" in argv


# ===========================================================================
# VideoStream supervision
# ===========================================================================

class FakePopen:
    """Records what was launched and how it was asked to stop."""

    def __init__(self, argv, stdout=None, stderr=None):
        self.argv = list(argv)
        self.alive = True
        self.killed = False

    def poll(self):
        return None if self.alive else 0

    def terminate(self):
        self.alive = False

    def send_signal(self, sig):
        self.alive = False

    def wait(self, timeout=None):
        return 0

    def kill(self):
        self.killed = True
        self.alive = False


@pytest.fixture
def fake_tooling(monkeypatch):
    """Every binary present; every launch recorded."""
    spawned: list[FakePopen] = []
    stopped: list[str] = []

    class Recorder(FakePopen):
        def __init__(self, argv, stdout=None, stderr=None):
            super().__init__(argv, stdout, stderr)
            spawned.append(self)

        def terminate(self):
            stopped.append(self.argv[0])
            super().terminate()

        def send_signal(self, sig):
            stopped.append(self.argv[0])
            super().send_signal(sig)

    monkeypatch.setattr(video_mod.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(video_mod.subprocess, "Popen", Recorder)
    return spawned, stopped


def test_a_synthetic_source_launches_nothing(monkeypatch):
    launched = []
    monkeypatch.setattr(video_mod.subprocess, "Popen",
                        lambda *a, **k: launched.append(a) or FakePopen(a[0]))
    stream = VideoStream(StreamConfig(source="sim"))
    assert stream.start() is False
    assert stream.running is False
    assert launched == []


def test_a_missing_mediamtx_disables_the_stream_without_raising(monkeypatch):
    monkeypatch.setattr(video_mod.shutil, "which", lambda name: None)
    stream = VideoStream(StreamConfig(source="csi"))
    assert stream.start() is False
    assert stream.running is False
    stream.stop()          # still safe


def test_a_missing_publisher_keeps_mediamtx_up_for_an_external_one(monkeypatch):
    spawned = []
    monkeypatch.setattr(
        video_mod.shutil, "which",
        lambda name: None if name == "gst-launch-1.0" else "/usr/bin/mediamtx",
    )
    monkeypatch.setattr(
        video_mod.subprocess, "Popen",
        lambda argv, **k: spawned.append(list(argv)) or FakePopen(argv),
    )
    stream = VideoStream(StreamConfig(source="csi"))
    assert stream.start() is True
    assert stream.running is True
    assert len(spawned) == 1 and spawned[0][0] == "mediamtx"


def test_both_children_launch_and_mediamtx_gets_the_shipped_config(fake_tooling):
    spawned, _ = fake_tooling
    stream = VideoStream(StreamConfig(source="csi"))
    assert stream.start() is True
    assert [proc.argv[0] for proc in spawned] == ["mediamtx", "gst-launch-1.0"]
    assert spawned[0].argv[1].endswith("mediamtx.yml")
    assert spawned[1].argv[1] == "-q"
    assert stream.child_status() == {"mediamtx": True, "gstreamer publisher": True}


def test_a_second_start_does_not_launch_a_second_pair(fake_tooling):
    spawned, _ = fake_tooling
    stream = VideoStream(StreamConfig(source="csi"))
    stream.start()
    assert stream.start() is True
    assert len(spawned) == 2


def test_stop_shuts_the_publisher_down_before_the_server_it_feeds(fake_tooling):
    spawned, stopped = fake_tooling
    stream = VideoStream(StreamConfig(source="csi"))
    stream.start()
    stream.stop()
    assert stopped == ["gst-launch-1.0", "mediamtx"]
    assert stream.running is False
    assert all(not proc.alive for proc in spawned)


def test_a_child_that_ignores_the_stop_signal_is_killed(monkeypatch):
    class Stubborn(FakePopen):
        def send_signal(self, sig):
            pass

        def terminate(self):
            pass

        def wait(self, timeout=None):
            raise video_mod.subprocess.TimeoutExpired("mediamtx", timeout)

    made: list[Stubborn] = []
    monkeypatch.setattr(video_mod.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(
        video_mod.subprocess, "Popen",
        lambda argv, **k: made.append(Stubborn(argv)) or made[-1],
    )
    stream = VideoStream(StreamConfig(source="csi"))
    stream.start()
    stream.stop()
    assert made and all(proc.killed for proc in made)


def test_a_spawn_failure_leaves_nothing_running_and_never_raises(monkeypatch):
    def refuse(argv, **kwargs):
        raise OSError("Exec format error")

    monkeypatch.setattr(video_mod.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(video_mod.subprocess, "Popen", refuse)
    stream = VideoStream(StreamConfig(source="csi"))
    assert stream.start() is False
    assert stream.running is False
    assert stream.child_status() == {}


def test_a_publisher_spawn_failure_still_leaves_the_server_up(monkeypatch):
    made: list[FakePopen] = []

    def popen(argv, **kwargs):
        if argv[0] == "gst-launch-1.0":
            raise OSError("gst is broken")
        proc = FakePopen(argv)
        made.append(proc)
        return proc

    monkeypatch.setattr(video_mod.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(video_mod.subprocess, "Popen", popen)
    stream = VideoStream(StreamConfig(source="csi"))
    assert stream.start() is True
    assert stream.child_status() == {"mediamtx": True}


def test_stop_on_a_stream_that_never_started_is_a_no_op():
    stream = VideoStream(StreamConfig(source="csi"))
    stream.stop()
    assert stream.running is False
