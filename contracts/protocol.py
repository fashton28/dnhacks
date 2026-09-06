"""Hub controller protocol.

One WebSocket per controller (Drone or Supervisor).
Every message is a JSON object with a `type` field.
Controllers send about 10 messages per second upward; the Hub sends commands downward.
Every command carries a `cmd_id`; the controller answers each with an `ack`.
"""
from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import Field, TypeAdapter

from contracts.models import DroneState, Scenario, SceneState, Strict, VelocityNED


# ---- controller -> Hub -------------------------------------------------------

class Hello(Strict):
    type: Literal["hello"] = "hello"
    role: Literal["drone", "renderer"]
    id: str = Field(description="drone_id, or a renderer id")
    sim: Literal["ardupilot", "fake", "browser", "headless"]


class Telemetry(Strict):
    type: Literal["telemetry"] = "telemetry"
    state: DroneState


class Frame(Strict):
    type: Literal["frame"] = "frame"
    drone_id: str
    jpeg_b64: str
    width: int
    height: int
    lat: float
    lon: float
    alt: float
    heading_deg: float
    gimbal_pitch_deg: float
    ts: str
    cmd_id: str | None = Field(default=None, description="set when this frame answers a capture_frame")
    temp_png_b64: str | None = Field(default=None, description="thermal frames only: grayscale PNG of the per-pixel temperature before the palette; byte 0 = -10 C, 255 = 700 C, linear")


class Ack(Strict):
    type: Literal["ack"] = "ack"
    cmd_id: str
    ok: bool
    detail: str = ""


class Overhead(Strict):
    type: Literal["overhead"] = "overhead"
    ref: str
    png_b64: str
    width: int
    height: int
    footprint: list[list[float]] = Field(description="[[lat, lon] x 4] corners: top-left, top-right, bottom-right, bottom-left")
    ts: str
    cmd_id: str | None = None


ControllerMessage = Annotated[Union[Hello, Telemetry, Frame, Ack, Overhead], Field(discriminator="type")]
controller_message = TypeAdapter(ControllerMessage)


# ---- Hub -> controller -------------------------------------------------------

class Command(Strict):
    cmd_id: str


class Goto(Command):
    type: Literal["goto"] = "goto"
    lat: float
    lon: float
    alt: float
    speed_mps: float | None = None


class Hover(Command):
    type: Literal["hover"] = "hover"


class SetVelocity(Command):
    type: Literal["set_velocity"] = "set_velocity"
    velocity_ned: VelocityNED
    yaw_rate_dps: float = 0.0


class LookAt(Command):
    type: Literal["look_at"] = "look_at"
    pitch_deg: float = Field(ge=-30, le=90, description="-30 looks up, 0 is level, 90 is straight down")


class CaptureFrame(Command):
    type: Literal["capture_frame"] = "capture_frame"


class ReturnHome(Command):
    type: Literal["return_home"] = "return_home"


class RenderFrame(Command):
    """Hub -> Renderer: render this Drone's camera now and answer with a frame tagged with cmd_id."""

    type: Literal["render_frame"] = "render_frame"
    drone_id: str
    # the camera state this frame must be rendered with, so evidence never races a settings message or the gimbal motion
    mode: str | None = Field(default=None, description="rgb | thermal | lidar; None keeps the Renderer's current setting")
    fov_deg: float | None = None
    gimbal_pitch_deg: float | None = None


class Scene(Command):
    """Hub -> Renderer: the current scene state to draw."""

    type: Literal["scene"] = "scene"
    state: SceneState


class RendererSettings(Command):
    """Hub -> Renderer: how to draw a Drone's camera: sensor mode and field of view. Set by any front end via the Hub."""

    type: Literal["renderer_settings"] = "renderer_settings"
    drone_id: str
    mode: Literal["rgb", "thermal", "lidar"] = "rgb"
    fov_deg: float = Field(default=70.0, ge=20.0, le=110.0)


class CaptureOverhead(Command):
    type: Literal["capture_overhead"] = "capture_overhead"
    ref: str


class Reset(Command):
    type: Literal["reset"] = "reset"


DroneCommand = Annotated[Union[Goto, Hover, SetVelocity, LookAt, CaptureFrame, ReturnHome], Field(discriminator="type")]
RendererCommand = Annotated[Union[RenderFrame, Scene, RendererSettings, CaptureOverhead, Reset], Field(discriminator="type")]
HubMessage = Annotated[
    Union[Goto, Hover, SetVelocity, LookAt, CaptureFrame, ReturnHome, RenderFrame, Scene, RendererSettings, CaptureOverhead, Reset],
    Field(discriminator="type"),
]
drone_command = TypeAdapter(DroneCommand)
renderer_command = TypeAdapter(RendererCommand)
hub_message = TypeAdapter(HubMessage)
