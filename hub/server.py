"""ARGUS Hub: the single backend process.

- /ws/controller   Drones and the Supervisor connect here (controller protocol, see contracts/protocol.py)
- /ws/live         Console clients receive every state change as JSON events
- REST             list Drones, send a Drone a command, fly a FlightPlan, pause/resume/abort a Mission
"""
from __future__ import annotations

import asyncio
import base64
import os
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ValidationError

from contracts.models import Detection, DroneState, DroneStatus, FlightPlan, ManualCommand, Scenario, SceneProp, SceneState
from contracts.protocol import (
    Ack,
    CaptureFrame,
    CaptureOverhead,
    Frame,
    Goto,
    Hello,
    Hover,
    LookAt,
    Overhead,
    RenderFrame,
    ReturnHome,
    Scene,
    SetVelocity,
    Telemetry,
    controller_message,
    drone_command,
)
from contracts.site import SITE_NAME
from hub.audit import AuditLog
from hub.autonomy import Autonomy
from hub.manual import ManualControl
from hub.missions import MissionPhase, MissionRunner
from hub.registry import Registry


class HubSettings(BaseModel):
    audit_path: Path | None = Path("events.jsonl")
    evidence_dir: Path | None = Path("evidence")
    runs_dir: Path = Path("runs")
    speed_factor: float = 1.0


class CommandBody(BaseModel):
    """One direct Drone command from the Console or a test."""

    type: str
    lat: float | None = None
    lon: float | None = None
    alt: float | None = None
    speed_mps: float | None = None
    vx: float = 0
    vy: float = 0
    vz: float = 0
    yaw_rate_dps: float = 0
    pitch_deg: float | None = None


class FlyBody(BaseModel):
    plan: FlightPlan
    drone_id: str | None = None


class OverheadBody(BaseModel):
    ref: str


class DetectBody(BaseModel):
    before_ref: str
    after_ref: str
    min_area_m2: float = 4.0


class ManualBody(BaseModel):
    vx: float = 0
    vy: float = 0
    vz: float = 0
    yaw_rate_dps: float = 0


class ManualEndBody(BaseModel):
    action: str = "resume"  # resume | abort | hover


def create_app(settings: HubSettings | None = None) -> FastAPI:
    settings = settings or HubSettings(speed_factor=float(os.environ.get("ARGUS_SPEED_FACTOR", "1")))

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.registry = Registry()
        app.state.audit = AuditLog(settings.audit_path)
        app.state.missions = MissionRunner(app.state.registry, app.state.audit, settings.evidence_dir, settings.speed_factor)
        app.state.manual = ManualControl()
        app.state.settings = settings
        app.state.autonomy = Autonomy(app, asyncio.get_running_loop(), settings.runs_dir)

        async def stale_loop() -> None:
            while True:
                app.state.registry.mark_stale()
                await asyncio.sleep(0.5)

        task = asyncio.create_task(stale_loop())
        try:
            yield
        finally:
            task.cancel()

    app = FastAPI(title="ARGUS Hub", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])  # Vite dev servers on other ports

    def reg() -> Registry:
        return app.state.registry

    def runner() -> MissionRunner:
        return app.state.missions

    # ---- controller protocol ------------------------------------------------------
    @app.websocket("/ws/controller")
    async def ws_controller(ws: WebSocket) -> None:
        await ws.accept()
        try:
            hello = Hello.model_validate_json(await ws.receive_text())
        except (ValidationError, WebSocketDisconnect):
            await ws.close(code=1002)
            return
        if hello.role == "renderer":
            await _renderer_session(ws, hello)
            return
        conn = reg().add_drone(hello.id, ws, hello.sim)
        app.state.audit.append("drone_connected", drone_id=hello.id, sim=hello.sim)
        try:
            while True:
                raw = await ws.receive_text()
                try:
                    msg = controller_message.validate_json(raw)
                except ValidationError as e:
                    app.state.audit.append("bad_message", drone_id=hello.id, error=str(e)[:200])
                    continue
                conn.last_seen = asyncio.get_running_loop().time()
                if isinstance(msg, Telemetry):
                    conn.state = msg.state
                    reg().publish({"type": "drone_state", "state": msg.state.model_dump(mode="json")})
                elif isinstance(msg, Frame):
                    conn.last_frame = msg
                    reg().publish({"type": "frame", **msg.model_dump(mode="json")})
                    if msg.cmd_id and (fut := conn.frame_waiters.pop(msg.cmd_id, None)) and not fut.done():
                        fut.set_result(msg)
                elif isinstance(msg, Overhead):
                    pass
                elif isinstance(msg, Ack):
                    if (fut := conn.pending.get(msg.cmd_id)) and not fut.done():
                        fut.set_result(msg)
                    reg().publish({"type": "ack", "drone_id": hello.id, **msg.model_dump(mode="json")})
        except WebSocketDisconnect:
            pass
        finally:
            reg().remove_drone(hello.id)
            app.state.audit.append("drone_disconnected", drone_id=hello.id)

    async def _renderer_session(ws: WebSocket, hello: Hello) -> None:
        conn = reg().add_renderer(hello.id, ws, hello.sim)
        app.state.audit.append("renderer_connected", renderer_id=hello.id, sim=hello.sim)
        await ws.send_text(Scene(cmd_id=reg().new_cmd_id(), state=reg().scene).model_dump_json())
        try:
            while True:
                raw = await ws.receive_text()
                try:
                    msg = controller_message.validate_json(raw)
                except ValidationError as e:
                    app.state.audit.append("bad_message", renderer_id=hello.id, error=str(e)[:200])
                    continue
                if isinstance(msg, Frame):
                    reg().publish({"type": "frame", **msg.model_dump(mode="json")})
                    if (d := reg().drones.get(msg.drone_id)) is not None:
                        d.last_frame = msg
                    if msg.cmd_id and (fut := conn.pending.get(msg.cmd_id)) and not fut.done():
                        fut.set_result(msg)
                elif isinstance(msg, Overhead):
                    if app.state.settings.evidence_dir is not None:
                        path = app.state.settings.evidence_dir / msg.ref
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_bytes(base64.b64decode(msg.png_b64))
                        path.with_suffix(".json").write_text(msg.model_copy(update={"png_b64": ""}).model_dump_json(indent=2))
                    reg().publish({"type": "overhead", **msg.model_dump(mode="json", exclude={"png_b64"})})
                    if msg.cmd_id and (fut := conn.pending.get(msg.cmd_id)) and not fut.done():
                        fut.set_result(msg)
                elif isinstance(msg, Ack):
                    if (fut := conn.pending.get(msg.cmd_id)) and not fut.done() and not msg.ok:
                        fut.set_exception(RuntimeError(msg.detail))
        except WebSocketDisconnect:
            pass
        finally:
            reg().remove_renderer(hello.id)
            app.state.audit.append("renderer_disconnected", renderer_id=hello.id)

    # ---- live feed to the Console -------------------------------------------------
    @app.websocket("/ws/live")
    async def ws_live(ws: WebSocket) -> None:
        await ws.accept()
        q = reg().subscribe()
        try:
            await ws.send_json({"type": "snapshot", "site": SITE_NAME, "drones": [s.model_dump(mode="json") for s in reg().states()],
                                "missions": [m.model_dump(mode="json") for m in runner().missions.values()]})
            while True:
                ev = await q.get()
                await ws.send_json(ev)
        except WebSocketDisconnect:
            pass
        finally:
            reg().unsubscribe(q)

    # ---- REST -----------------------------------------------------------------------
    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "site": SITE_NAME, "drones": len(reg().drones), "speed_factor": settings.speed_factor}

    @app.get("/drones", response_model=list[DroneState])
    async def list_drones() -> list[DroneState]:
        return reg().states()

    @app.get("/drones/{drone_id}", response_model=DroneState)
    async def get_drone(drone_id: str) -> DroneState:
        conn = reg().drones.get(drone_id)
        if conn is None or conn.state is None:
            raise HTTPException(404, f"unknown drone {drone_id}")
        return conn.state

    @app.post("/drones/{drone_id}/command", response_model=Ack)
    async def command_drone(drone_id: str, body: CommandBody) -> Ack:
        cmd_id = reg().new_cmd_id()
        match body.type:
            case "goto":
                if body.lat is None or body.lon is None or body.alt is None:
                    raise HTTPException(422, "goto needs lat, lon, alt")
                cmd = Goto(cmd_id=cmd_id, lat=body.lat, lon=body.lon, alt=body.alt, speed_mps=body.speed_mps)
            case "hover":
                cmd = Hover(cmd_id=cmd_id)
            case "set_velocity":
                cmd = SetVelocity(cmd_id=cmd_id, velocity_ned={"vx": body.vx, "vy": body.vy, "vz": body.vz}, yaw_rate_dps=body.yaw_rate_dps)
            case "look_at":
                cmd = LookAt(cmd_id=cmd_id, pitch_deg=body.pitch_deg or 0.0)
            case "capture_frame":
                cmd = CaptureFrame(cmd_id=cmd_id)
            case "return_home":
                cmd = ReturnHome(cmd_id=cmd_id)
            case _:
                raise HTTPException(422, f"unknown command type {body.type}")
        drone_command.validate_python(cmd.model_dump())
        try:
            ack = await reg().send(drone_id, cmd)
        except LookupError as e:
            raise HTTPException(404, str(e)) from e
        except TimeoutError as e:
            raise HTTPException(504, f"{drone_id} did not ack {body.type}") from e
        app.state.audit.append("command", drone_id=drone_id, cmd=cmd.model_dump(mode="json"), ok=ack.ok, detail=ack.detail)
        return ack

    @app.post("/missions/fly")
    async def fly(body: FlyBody) -> dict[str, Any]:
        drone_id = body.drone_id or body.plan.drone_id
        if drone_id is None:
            idle = [s for s in reg().states() if s.status == DroneStatus.idle]
            if not idle:
                raise HTTPException(409, "no idle drone available")
            drone_id = max(idle, key=lambda s: s.battery_pct).drone_id
        conn = reg().drones.get(drone_id)
        if conn is None or conn.ws is None or conn.state is None:
            raise HTTPException(404, f"unknown or offline drone {drone_id}")
        if runner().active_for(drone_id) is not None:
            raise HTTPException(409, f"{drone_id} already has an active mission")
        if body.plan.mission_id in runner().missions:
            raise HTTPException(409, f"mission {body.plan.mission_id} already exists")
        m = runner().start(body.plan, drone_id)
        return m.model_dump(mode="json")

    @app.get("/missions")
    async def list_missions() -> list[dict[str, Any]]:
        return [m.model_dump(mode="json") for m in runner().missions.values()]

    @app.get("/missions/{mission_id}")
    async def get_mission(mission_id: str) -> dict[str, Any]:
        m = runner().missions.get(mission_id)
        if m is None:
            raise HTTPException(404, "unknown mission")
        return m.model_dump(mode="json")

    @app.post("/missions/{mission_id}/pause")
    async def pause_mission(mission_id: str) -> dict[str, Any]:
        if mission_id not in runner().missions:
            raise HTTPException(404, "unknown mission")
        return runner().pause(mission_id).model_dump(mode="json")

    @app.post("/missions/{mission_id}/resume")
    async def resume_mission(mission_id: str) -> dict[str, Any]:
        if mission_id not in runner().missions:
            raise HTTPException(404, "unknown mission")
        return runner().resume(mission_id).model_dump(mode="json")

    @app.post("/missions/{mission_id}/abort")
    async def abort_mission(mission_id: str) -> dict[str, Any]:
        if mission_id not in runner().missions:
            raise HTTPException(404, "unknown mission")
        return (await runner().abort(mission_id)).model_dump(mode="json")

    # ---- Manual Control ---------------------------------------------------------------------------
    @app.post("/drones/{drone_id}/manual/start")
    async def manual_start(drone_id: str) -> dict[str, Any]:
        conn = reg().drones.get(drone_id)
        if conn is None or conn.state is None:
            raise HTTPException(404, f"unknown drone {drone_id}")
        active = runner().active_for(drone_id)
        if active is not None and active.phase == MissionPhase.flying:
            runner().pause(active.mission_id)
        session = app.state.manual.begin(drone_id, active.mission_id if active else None)
        try:
            await reg().send(drone_id, Hover(cmd_id=reg().new_cmd_id()))
        except (LookupError, TimeoutError):
            pass
        app.state.audit.append("manual_start", drone_id=drone_id, paused_mission=session.mission_id)
        reg().publish({"type": "manual", "drone_id": drone_id, "active": True, "mission_id": session.mission_id})
        return {"drone_id": drone_id, "paused_mission": session.mission_id}

    @app.post("/drones/{drone_id}/manual/command")
    async def manual_command(drone_id: str, body: ManualBody) -> dict[str, Any]:
        conn = reg().drones.get(drone_id)
        if conn is None or conn.state is None:
            raise HTTPException(404, f"unknown drone {drone_id}")
        if drone_id not in app.state.manual.sessions:
            raise HTTPException(409, "no Manual Control session; call /manual/start first")
        cmd = ManualCommand(drone_id=drone_id, velocity_ned={"vx": body.vx, "vy": body.vy, "vz": body.vz}, yaw_rate_dps=body.yaw_rate_dps, ts=datetime.now(UTC))
        clamped, event = app.state.manual.clamp(cmd, conn.state)
        try:
            ack = await reg().send(drone_id, SetVelocity(cmd_id=reg().new_cmd_id(), velocity_ned=clamped.velocity_ned, yaw_rate_dps=clamped.yaw_rate_dps), timeout=2.0)
        except TimeoutError as e:
            raise HTTPException(504, "drone did not ack") from e
        if event is not None:
            app.state.audit.append("clamp", **event.model_dump(mode="json"))
            reg().publish({"type": "clamp", **event.model_dump(mode="json")})
        return {"ok": ack.ok, "sent": clamped.velocity_ned.model_dump(), "clamped": event.model_dump(mode="json") if event else None}

    @app.post("/drones/{drone_id}/manual/end")
    async def manual_end(drone_id: str, body: ManualEndBody) -> dict[str, Any]:
        session = app.state.manual.end(drone_id)
        if session is None:
            raise HTTPException(409, "no Manual Control session")
        result: dict[str, Any] = {"drone_id": drone_id, "action": body.action, "mission_id": session.mission_id}
        if session.mission_id and session.mission_id in runner().missions:
            if body.action == "resume":
                runner().resume(session.mission_id)
            elif body.action == "abort":
                await runner().abort(session.mission_id)
        if body.action == "hover" or not session.mission_id:
            try:
                await reg().send(drone_id, Hover(cmd_id=reg().new_cmd_id()))
            except (LookupError, TimeoutError):
                pass
        app.state.audit.append("manual_end", **result)
        reg().publish({"type": "manual", "drone_id": drone_id, "active": False, "mission_id": session.mission_id})
        return result

    # ---- scene and Scenarios (Scenario engine) ---------------------------------------------
    @app.get("/scene", response_model=SceneState)
    async def get_scene() -> SceneState:
        return reg().scene

    @app.post("/scenarios/run", response_model=SceneState)
    async def run_scenario(sc: Scenario) -> SceneState:
        scene = reg().scene
        p = sc.params
        if sc.kind == "intruder_vehicle":
            scene.props.append(SceneProp(id=f"{sc.id}-vehicle", kind="vehicle", x=float(p.get("x", 130)), y=float(p.get("y", -135)), yaw_deg=float(p.get("heading_deg", 90))))
        elif sc.kind in ("fence_breach", "perimeter_opening"):
            section = str(p.get("section", "fence_outer_s_07"))
            if section not in scene.open_fences:
                scene.open_fences.append(section)
        elif sc.kind == "unattended_object":  # crate beside the reactor, inside the protected area
            scene.props.append(SceneProp(id=f"{sc.id}-crate", kind="crate", x=float(p.get("x", 30)), y=float(p.get("y", -20)), yaw_deg=float(p.get("heading_deg", 0))))
        elif sc.kind == "unattended_object_benign":  # the same crate, in the service yard by the maintenance shed
            scene.props.append(SceneProp(id=f"{sc.id}-crate", kind="crate", x=float(p.get("x", -48)), y=float(p.get("y", -62)), yaw_deg=float(p.get("heading_deg", 20))))
        elif sc.kind == "authorized_activity":  # marked maintenance vehicle in the service yard during a declared window
            scene.props.append(SceneProp(id=f"{sc.id}-vehicle", kind="vehicle", x=float(p.get("x", -52)), y=float(p.get("y", -75)), yaw_deg=float(p.get("heading_deg", 0))))
        scene.scenario_ids.append(sc.id)
        app.state.audit.append("scenario_run", scenario=sc.model_dump(mode="json"))
        await reg().broadcast_scene()
        return scene

    @app.post("/scenarios/reset", response_model=SceneState)
    async def reset_scene() -> SceneState:
        reg().scene = SceneState()
        app.state.audit.append("scene_reset")
        await reg().broadcast_scene()
        return reg().scene

    @app.post("/overhead/capture")
    async def capture_overhead(body: OverheadBody) -> dict[str, Any]:
        try:
            ov = await reg().ask_renderer(CaptureOverhead(cmd_id=reg().new_cmd_id(), ref=body.ref))
        except LookupError as e:
            raise HTTPException(409, str(e)) from e
        app.state.audit.append("overhead_captured", ref=body.ref)
        return ov.model_dump(mode="json", exclude={"png_b64"})

    # ---- wide-area layer and autonomy ---------------------------------------------------------
    @app.post("/widearea/detect", response_model=list[Detection])
    async def widearea_detect(body: DetectBody) -> list[Detection]:
        from widearea.detect import detect, footprint_from_meta
        ev = settings.evidence_dir
        if ev is None:
            raise HTTPException(409, "evidence storage disabled")
        before, after = ev / body.before_ref, ev / body.after_ref
        if not before.exists() or not after.exists():
            raise HTTPException(404, "before/after overhead image not found; capture them first")
        dets = await asyncio.to_thread(detect, before, after, footprint_from_meta(after.with_suffix(".json")), before_ref=body.before_ref, after_ref=body.after_ref, min_area_m2=body.min_area_m2)
        for d in dets:
            app.state.autonomy.add_detection(d)
        app.state.audit.append("widearea_detect", before=body.before_ref, after=body.after_ref, detections=len(dets))
        return dets

    @app.post("/detections", response_model=Detection)
    async def add_detection(d: Detection) -> Detection:
        app.state.audit.append("detection_ingested", detection_id=d.id, change_type=d.change_type.value)
        return app.state.autonomy.add_detection(d)

    @app.get("/detections", response_model=list[Detection])
    async def list_detections() -> list[Detection]:
        return list(app.state.autonomy.detections.values())

    @app.post("/detections/{detection_id}/dispatch")
    async def dispatch_detection(detection_id: str) -> dict[str, Any]:
        if detection_id not in app.state.autonomy.detections:
            raise HTTPException(404, "unknown detection")
        app.state.audit.append("dispatch_requested", detection_id=detection_id, llm_mode=app.state.autonomy.mode)
        outcome = await app.state.autonomy.dispatch(detection_id)
        app.state.audit.append("dispatch_outcome", detection_id=detection_id, mission_id=outcome["mission_id"], flown=outcome["flown"], decision=outcome["triage"].get("decision"))
        return outcome

    @app.get("/autonomy")
    async def autonomy_status() -> dict[str, Any]:
        a = app.state.autonomy
        return {"llm_mode": a.mode, "model": getattr(a.llm, "model", None), "facility": a.facility.facility_id, "detections": len(a.detections), "outcomes": list(a.outcomes)}

    @app.post("/drones/{drone_id}/render")
    async def render_drone(drone_id: str) -> dict[str, Any]:
        if drone_id not in reg().drones:
            raise HTTPException(404, "unknown drone")
        try:
            fr = await reg().ask_renderer(RenderFrame(cmd_id=reg().new_cmd_id(), drone_id=drone_id))
        except LookupError as e:
            raise HTTPException(409, str(e)) from e
        return fr.model_dump(mode="json", exclude={"jpeg_b64"})

    @app.get("/", response_class=HTMLResponse)
    async def index() -> str:
        return f"<h1>ARGUS Hub</h1><p>{SITE_NAME}</p><p>{datetime.now(UTC).isoformat()}</p><ul><li><a href='/console/'>Console</a></li><li><a href='/docs'>API docs</a></li><li><a href='/drones'>Drones</a></li><li><a href='/missions'>Missions</a></li></ul>"

    console_dist = Path(__file__).resolve().parent.parent / "console" / "dist"
    if console_dist.exists():
        app.mount("/console", StaticFiles(directory=console_dist, html=True), name="console")
    if settings.evidence_dir is not None and settings.evidence_dir.exists():
        app.mount("/evidence", StaticFiles(directory=settings.evidence_dir), name="evidence")

    return app


app = create_app()
