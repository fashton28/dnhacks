import "./style.css";
import "./manual.css";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { api, liveFeed, RendererLink, type DroneState, type SceneState } from "./hub";
import { SiteScene, enuToThree } from "./scene";
import { VisionModes } from "./vision";
import { enuToLatlon } from "./geo";
import { createOverview } from "./overview";
import { LogFeed, renderFleet, renderHud, renderMission, renderTelemetry, type Mission, type MissionSpecView, type ValidationView } from "./ui/panels";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const isHeadless = params.get("headless") === "1";
if (isHeadless) document.body.classList.add("headless");
const isEmbed = params.get("embed") === "1" || params.get("embed") === "drone";
const isEmbedDrone = params.get("embed") === "drone";   // Drone view only: the dashboard's live camera feed
const isEmbedWorld = params.get("embed") === "1";       // World view only: the dashboard's World tab
const wantStream = params.get("stream") === "1";        // produce the legacy MJPEG stream from this tab
const sensorFx = params.get("fx") === "1";               // grain, vignette, chromatic aberration are opt-in; default is clean imagery
if (isEmbed) document.body.classList.add("embed");
if (isEmbedDrone) document.body.classList.add("embed-drone");

const feed = new LogFeed($("log"));
const log = (msg: string, level: "info" | "good" | "warn" | "bad" = "info") => feed.push(msg, level);

const [site, siteGeo] = await Promise.all([fetch("./site.json").then((r) => r.json()), fetch("./site.geojson").then((r) => r.json())]);
$("site-name").textContent = site.name;

// ---- World view ----------------------------------------------------------------------------
const worldCanvas = $<HTMLCanvasElement>("world-canvas");
const renderer = new THREE.WebGLRenderer({ canvas: worldCanvas, antialias: true, powerPreference: "high-performance" });
const world = new SiteScene(site, renderer, isHeadless ? "low" : "high");
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
// Resolution: cap the device pixel ratio and adapt it to hold ~60 fps (Retina at 2x costs 4x the pixels of 1x).
const MAX_RATIO = Math.min(window.devicePixelRatio, 1.5);
let pixelRatio = MAX_RATIO;
let lastRatioChange = 0;
renderer.setPixelRatio(pixelRatio);
renderer.info.autoReset = false;  // reset once per frame in the loop so calls and triangles cover every pass
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const worldCam = new THREE.PerspectiveCamera(50, 1, 0.5, 3000);
const controls = new OrbitControls(worldCam, worldCanvas);
controls.target.copy(enuToThree(0, 0, 5));
controls.maxPolarAngle = Math.PI / 2 - 0.03;
controls.minDistance = 1.2;
controls.maxDistance = 1200;
worldCam.position.copy(enuToThree(-230, -290, 150));
controls.update();

// ---- Drone view (offscreen renderer with a sensor post-pass; also serves Renderer-role captures) ----
const droneCanvas = $<HTMLCanvasElement>("drone-canvas");
// No preserveDrawingBuffer: evidence frames and the stream read the canvas in the same task that rendered it, so the buffer is still intact.
const droneRenderer = new THREE.WebGLRenderer({ canvas: droneCanvas, antialias: true, preserveDrawingBuffer: false, powerPreference: "high-performance" });
droneRenderer.shadowMap.enabled = true;
droneRenderer.shadowMap.autoUpdate = false;  // static sun: the map is refreshed once per Scene change (see SiteScene.shadowMapNeedsUpdate), never per frame
droneRenderer.toneMapping = THREE.ACESFilmicToneMapping;
droneRenderer.outputColorSpace = THREE.SRGBColorSpace;
droneRenderer.setPixelRatio(1);
const droneCam = new THREE.PerspectiveCamera(70, 1280 / 720, 0.05, 2000);
const vision = new VisionModes(droneRenderer, world);
(window as any).__argusVision = vision;
const DRONE_W = 1280, DRONE_H = 720;
droneCanvas.width = DRONE_W; droneCanvas.height = DRONE_H;
// The renderer sized itself from the canvas attributes at construction; without this the viewport stays at that size and evidence frames are drawn in one corner.
droneRenderer.setSize(DRONE_W, DRONE_H, false);
const droneTarget = new THREE.WebGLRenderTarget(DRONE_W, DRONE_H, { samples: 4, type: THREE.HalfFloatType });
/** In embed-drone mode the canvas fills the frame: render at its displayed size (capped at 1080p, dpr up to 2). */
function fitDroneCanvas(): void {
  if (!isEmbedDrone) return;
  const dpr = Math.min(window.devicePixelRatio, 1.5);
  const w = Math.min(1920, Math.round(layout.droneW * dpr)), h = Math.min(1080, Math.round(layout.droneH * dpr));
  if (w > 0 && h > 0 && (droneCanvas.width !== w || droneCanvas.height !== h)) {
    droneCanvas.width = w; droneCanvas.height = h; droneRenderer.setSize(w, h, false); droneTarget.setSize(w, h);
    droneCam.aspect = w / h; droneCam.updateProjectionMatrix();
  }
}
const postScene = new THREE.Scene();
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const postMat = new THREE.ShaderMaterial({
  uniforms: { tDiffuse: { value: droneTarget.texture }, time: { value: 0 }, grain: { value: sensorFx ? 0.045 : 0.0 }, vignette: { value: sensorFx ? 0.35 : 0.0 }, ca: { value: sensorFx ? 0.0025 : 0.0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float time; uniform float grain; uniform float vignette; uniform float ca; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7)) + time) * 43758.5453); }
    void main(){
      vec2 d = vUv - 0.5;
      float caAmt = ca * length(d);  // chromatic aberration only when sensor effects are on
      vec3 c;
      c.r = texture2D(tDiffuse, vUv + d * caAmt).r;
      c.g = texture2D(tDiffuse, vUv).g;
      c.b = texture2D(tDiffuse, vUv - d * caAmt).b;
      c += (hash(vUv * 1000.0) - 0.5) * grain;
      c *= 1.0 - vignette * dot(d, d) * 2.2;
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});
postMat.toneMapped = true;
postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat));

// ---- state ----------------------------------------------------------------------------------
const drones = new Map<string, DroneState>();
const missions = new Map<string, Mission>();
const lastRefused = new Map<string, string>();
let selected: string | null = null;
let scene: SceneState = { props: [], open_fences: [], scenario_ids: [] };
let missionSpec: MissionSpecView = null;
let validation: ValidationView = null;
const detections: any[] = [];
const switchTab = (name: string) => document.querySelector<HTMLButtonElement>(`.tab[data-tab="${name}"]`)?.click();
let baselineRef: string | null = null;
let dispatching = false;
function refreshDispatchButton(): void {
  const b = $<HTMLButtonElement>("dispatch");
  b.disabled = detections.length === 0 || dispatching;
  b.textContent = dispatching ? "Dispatching…" : detections.length ? `Dispatch ${detections[detections.length - 1].id}` : "Dispatch";
}
function onDetection(d: any): void {
  detections.push(d);
  log(`DETECTION ${d.id}: ${d.change_type} ~${Math.round(d.area_m2 ?? 0)} m² confidence ${d.confidence}`, "warn");
  refreshDispatchButton();
}

// Per-Drone camera settings brokered by the Hub (vision mode and field of view); applied whenever that Drone's view is drawn.
type CamSettings = { mode: "rgb" | "thermal" | "lidar"; fov_deg: number };
const cameraSettings = new Map<string, CamSettings>();
function applyCamera(droneId: string): void {
  const st = cameraSettings.get(droneId) ?? { mode: "rgb", fov_deg: 70 };
  if (vision.mode !== st.mode) vision.mode = st.mode;
  if (Math.abs(droneCam.fov - st.fov_deg) > 0.01) { droneCam.fov = st.fov_deg; droneCam.updateProjectionMatrix(); }
}
let visionWarm = false;
function renderDroneView(s: DroneState): void {
  applyCamera(s.drone_id);
  if (!visionWarm) { visionWarm = true; vision.warmUp(droneCam, droneTarget); }  // once, at the first frame: compile every vision mode now, not mid-flight
  droneRenderer.shadowMap.needsUpdate = world.shadowMapNeedsUpdate(droneRenderer);
  applyGimbalGoal(s);
  world.aimDroneCamera(droneCam, s);
  const g = world.drones.get(s.drone_id);
  if (g) g.visible = false;
  if (vision.usesRgbPost) {
    vision.render(droneCam, droneTarget);
    postMat.uniforms.time.value = performance.now() / 1000;
    droneRenderer.render(postScene, postCam);
  } else {
    vision.render(droneCam, null);
  }
  if (g) g.visible = true;
}

/** Thermal frames carry the radiometric map: a grayscale PNG of the per-pixel temperature before the palette
 *  (byte 0 = -10 C, 255 = 700 C, linear; see ThermalPass.readTemperature). The Hub thresholds it into Sightings. */
const tempCanvas = document.createElement("canvas");
function temperaturePngB64(): string | null {
  const t = vision.readTemperature();
  if (!t) return null;
  tempCanvas.width = t.width; tempCanvas.height = t.height;
  const ctx = tempCanvas.getContext("2d")!;
  const img = ctx.createImageData(t.width, t.height);
  for (let i = 0, n = t.width * t.height; i < n; i++) { const v = t.data[i]; img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return tempCanvas.toDataURL("image/png").split(",")[1];
}
function frameMessage(s: DroneState, cmdId: string | null) {
  renderDroneView(s);
  const jpeg = droneCanvas.toDataURL("image/jpeg", 0.72).split(",")[1];
  const temp = temperaturePngB64();
  // the Drone view canvas is also the live camera on screen: put the selected Drone back if we just drew another one
  if (selected && selected !== s.drone_id && drones.has(selected)) renderDroneView(drones.get(selected)!);
  return { type: "frame", drone_id: s.drone_id, jpeg_b64: jpeg, width: droneCanvas.width, height: droneCanvas.height, lat: s.lat, lon: s.lon, alt: s.alt,
           heading_deg: s.heading_deg, gimbal_pitch_deg: s.gimbal_pitch_deg, ts: new Date().toISOString(), cmd_id: cmdId, temp_png_b64: temp };
}
/** Streaming variant: encodes off the main thread with toBlob and sends when ready; never stalls the render loop. */
let streamBusy = false;
function streamFrame(s: DroneState): void {
  if (streamBusy || document.hidden) return;
  streamBusy = true;
  const meta = { drone_id: s.drone_id, width: droneCanvas.width, height: droneCanvas.height, lat: s.lat, lon: s.lon, alt: s.alt, heading_deg: s.heading_deg, gimbal_pitch_deg: s.gimbal_pitch_deg, ts: new Date().toISOString() };
  droneCanvas.toBlob((blob) => {
    if (!blob) { streamBusy = false; return; }
    const reader = new FileReader();
    reader.onloadend = () => { streamBusy = false; const url = String(reader.result); link.send({ type: "frame", ...meta, jpeg_b64: url.slice(url.indexOf(",") + 1), cmd_id: null }); };
    reader.onerror = () => { streamBusy = false; };
    reader.readAsDataURL(blob);
  }, "image/jpeg", 0.82);
}

// overhead capture: orthographic top-down of the whole footprint
const ovSize = site.overhead.px as number;
const ovCanvas = document.createElement("canvas"); ovCanvas.width = ovCanvas.height = ovSize;
const ovRenderer = new THREE.WebGLRenderer({ canvas: ovCanvas, antialias: true, preserveDrawingBuffer: true });
ovRenderer.shadowMap.enabled = true;
ovRenderer.outputColorSpace = THREE.SRGBColorSpace;
const half = site.overhead.half as number;
const ovCam = new THREE.OrthographicCamera(-half, half, half, -half, 1, 1000);
ovCam.position.copy(enuToThree(0, 0, 500));
ovCam.up.set(0, 0, -1);
ovCam.lookAt(enuToThree(0, 0, 0));
function overheadMessage(ref: string, cmdId: string) {
  for (const g of world.drones.values()) g.visible = false;
  ovRenderer.render(world.scene, ovCam);
  for (const g of world.drones.values()) g.visible = true;
  const png = ovCanvas.toDataURL("image/png").split(",")[1];
  const a = site.anchor;
  const c = (x: number, y: number) => { const [lat, lon] = enuToLatlon(a, x, y); return [lat, lon]; };
  return { type: "overhead", ref, png_b64: png, width: ovSize, height: ovSize, footprint: [c(-half, half), c(half, half), c(half, -half), c(-half, -half)], ts: new Date().toISOString(), cmd_id: cmdId };
}

// ---- Overview (satellite map) ----------------------------------------------------------------
const overview = createOverview($("overview"), { site, siteGeo, onSelect: (id) => select(id) });

// ---- Hub connections -------------------------------------------------------------------------
const setPill = (id: string, ok: boolean, label: string) => { const el = $(id); el.textContent = label; el.className = `pill ${ok ? "ok" : "bad"}`; };
const rendererId = `console-${Math.random().toString(36).slice(2, 8)}`;
const link = new RendererLink(rendererId, isHeadless ? "headless" : "browser", (cmd, reply) => {
  if (cmd.type === "render_frame") {
    const s = drones.get(cmd.drone_id);
    if (!s) { reply({ type: "ack", cmd_id: cmd.cmd_id, ok: false, detail: `unknown drone ${cmd.drone_id}` }); return; }
    reply({ type: "ack", cmd_id: cmd.cmd_id, ok: true });
    // evidence is rendered with the camera state the Hub asked for, not whatever settings message or gimbal motion is in flight
    if (cmd.mode || cmd.fov_deg) { const cur = cameraSettings.get(s.drone_id) ?? { mode: "rgb", fov_deg: 70 }; cameraSettings.set(s.drone_id, { mode: (cmd.mode as any) ?? cur.mode, fov_deg: cmd.fov_deg ?? cur.fov_deg }); if (s.drone_id === selected) reflectVision((cmd.mode as any) ?? cur.mode); }
    const pose = world.poseOf(s.drone_id);
    const savedGimbal = pose?.gimbal;
    if (cmd.gimbal_pitch_deg != null && pose) pose.gimbal = cmd.gimbal_pitch_deg;
    const frame = frameMessage({ ...s, gimbal_pitch_deg: cmd.gimbal_pitch_deg ?? s.gimbal_pitch_deg }, cmd.cmd_id);
    if (pose && savedGimbal != null) pose.gimbal = savedGimbal;
    reply(frame);
    log(`Renderer: evidence frame for ${cmd.drone_id}`);
  } else if (cmd.type === "capture_overhead") {
    reply({ type: "ack", cmd_id: cmd.cmd_id, ok: true });
    reply(overheadMessage(cmd.ref, cmd.cmd_id));
    log(`Renderer: overhead captured ${cmd.ref}`);
  } else if (cmd.type === "renderer_settings") {
    cameraSettings.set(cmd.drone_id, { mode: cmd.mode, fov_deg: cmd.fov_deg });
    if (cmd.drone_id === selected) reflectVision(cmd.mode);
    reply({ type: "ack", cmd_id: cmd.cmd_id, ok: true });
  } else if (cmd.type === "scene") {
    scene = cmd.state; world.setScene(scene); overview.setScene(scene); focusNewProps(scene);
    reply({ type: "ack", cmd_id: cmd.cmd_id, ok: true });
  } else if (cmd.type === "reset") {
    scene = { props: [], open_fences: [], scenario_ids: [] }; world.setScene(scene); overview.setScene(scene);
    reply({ type: "ack", cmd_id: cmd.cmd_id, ok: true });
  } else {
    reply({ type: "ack", cmd_id: cmd.cmd_id, ok: false, detail: `renderer cannot ${cmd.type}` });
  }
}, (ok) => setPill("renderer-status", ok, ok ? "renderer on" : "renderer off"));
link.connect();

liveFeed((ev) => {
  switch (ev.type) {
    case "snapshot":
      for (const s of ev.drones) onDrone(s);
      for (const m of ev.missions ?? []) onMission(m);
      if (ev.scene) for (const p of (ev.scene as SceneState).props) seenProps.add(p.id);
      break;
    case "drone_state": onDrone(ev.state); break;
    case "scene": scene = ev.state; world.setScene(scene); overview.setScene(scene); focusNewProps(scene); break;
    case "camera": cameraSettings.set(ev.drone_id, { mode: ev.mode, fov_deg: ev.fov_deg }); if (ev.drone_id === selected) reflectVision(ev.mode); break;
    case "mission": onMission(ev.mission); break;
    case "clamp": log(`Safety Validator clamped ${ev.drone_id}: ${ev.rule}`, "warn"); showClamp(ev.rule); break;
    case "manual": log(`${ev.drone_id}: Manual Control ${ev.active ? "taken" : "released"}${ev.mission_id ? ` (Mission ${ev.mission_id})` : ""}`, "warn"); break;
    case "overhead": log(`Overhead image stored: ${ev.ref}`, "good"); break;
    case "detection": onDetection(ev.detection ?? ev); break;
    case "mission_spec": missionSpec = { objective: ev.spec.objective, rationale: ev.spec.rationale, max_altitude_m: ev.spec.max_altitude_m, standoff_m: ev.spec.standoff_m }; log(`Triage Agent proposed a plan (attempt ${ev.spec.attempt ?? 1}): ${ev.spec.rationale}`); refreshMission(); switchTab("mission"); break;
    case "validation": { const r = ev.result ?? ev; validation = { verdict: r.verdict, violations: r.violations ?? [] }; log(r.verdict === "accept" ? `Safety Validator: ACCEPT${r.checks_passed ? ` (${r.checks_passed} checks)` : ""}` : `Safety Validator: REJECT ${(r.violations ?? []).map((v: any) => v.rule).join(", ")}`, r.verdict === "accept" ? "good" : "warn"); refreshMission(); break; }
    case "envelope": log(`Envelope ${String(ev.verdict).toUpperCase()}: ${ev.radius_m} m around the Detection, ceiling ${ev.ceiling_m} m, ${ev.time_budget_s} s. ${ev.rationale ?? ""}`, ev.verdict === "accept" ? "good" : "warn"); break;
    case "envelope_repaired": log(`Envelope shrunk after refusal (${(ev.rules ?? []).join(", ")}): ${ev.radius_m} m, ceiling ${ev.ceiling_m} m`, "warn"); break;
    case "agent_note": log(`agent: ${ev.text}`); break;
    case "hard_stop": log(`HARD STOP: ${ev.reason}. Returning home.`, "bad"); break;
    case "pretriage": log(`Triage agent: ${String(ev.action).replace("_", " ").toUpperCase()} for ${ev.detection_id}${ev.zone ? ` in ${String(ev.zone).replace(/_/g, " ")}` : ""}. ${ev.rationale ?? ""}`, ev.action === "dispatch" ? "good" : "warn"); break;
    case "agent_action": { const r = String(ev.result ?? ev.detail ?? ""); const bad = ev.ok === false || /^(refused|error)/i.test(r); log(`agent ${ev.tool ?? ev.action}${ev.args ? " " + JSON.stringify(ev.args) : ""}${r ? ": " + r.slice(0, 120) : ""}`, bad ? "warn" : "info"); break; }
    case "inspection": log(`Inspection at waypoint ${Number(ev.waypoint_index) + 1}: ${String(ev.threat_assessment).toUpperCase()}. ${ev.summary ?? ""}`, ev.threat_assessment === "none" ? "good" : "warn"); break;
    case "triage": log(`Triage: ${String(ev.decision).toUpperCase()} (confidence ${ev.confidence}) ${ev.rationale ?? ""}`, ev.decision === "escalate" ? "warn" : "good"); break;
    case "incident": log(`INCIDENT REPORT [${ev.severity}] ${ev.title}: ${ev.recommended_action}`, ev.severity === "high" || ev.severity === "critical" ? "bad" : "warn"); break;
    case "dispatch_outcome": log(`Dispatch outcome for ${ev.detection_id}: ${ev.flown ? "flown by " + ev.drone_id : "NOT FLOWN"} after ${ev.attempts} attempt(s), triage ${ev.triage?.decision}`, ev.flown ? "good" : "warn"); dispatching = false; refreshDispatchButton(); break;
    case "autonomy": if (["plan_abandoned", "waypoint_reached", "observation"].includes(ev.event.type)) log(`agent ${ev.event.type}: ${ev.event.type === "observation" ? ev.event.payload.caption : JSON.stringify(ev.event.payload).slice(0, 140)}`); break;
    case "sightings": onSightings(ev); break;
    case "ack": if (!ev.ok) log(`${ev.drone_id} refused command: ${ev.detail}`, "bad"); break;
  }
}, (ok) => setPill("hub-status", ok, ok ? "hub live" : "hub reconnecting"));

let lastFleetRefresh = 0;
function onDrone(s: DroneState): void {
  const prev = drones.get(s.drone_id);
  drones.set(s.drone_id, s);
  world.updateDrone(s);
  if (!isEmbed) overview.updateDrone(s);  // the Overview map is hidden in embeds; its marker and track updates would only burn CPU
  if (prev && prev.status !== s.status) log(`${s.drone_id}: ${prev.status.replace("_", " ")} → ${s.status.replace("_", " ")}${s.mode ? ` (${s.mode})` : ""}`, s.status === "offline" ? "bad" : "info");
  if (s.message?.startsWith("REFUSED") && lastRefused.get(s.drone_id) !== s.message) { lastRefused.set(s.drone_id, s.message); log(`${s.drone_id}: onboard fence ${s.message}`, "bad"); }
  // ?drone=<id> names the initial selection only; once it (or any later select) has taken effect, telemetry never overrides the Operator's choice
  if (pendingDroneParam) { if (s.drone_id === pendingDroneParam) select(s.drone_id, { quiet: true }); }
  else if (selected === null && s.status !== "offline" && (storedSelection === null || storedSelection === s.drone_id)) select(s.drone_id, { quiet: true });
  if (selected === null && !selectFallback) selectFallback = window.setTimeout(() => { if (selected === null && drones.size) select(sortedDrones()[0].drone_id, { quiet: true }); }, 2500);
  if (!isEmbed && (performance.now() - lastFleetRefresh > 200 || (prev && prev.status !== s.status))) { lastFleetRefresh = performance.now(); refreshFleet(); }
  if (s.drone_id === selected && performance.now() - lastSelectedRefresh > 100) { lastSelectedRefresh = performance.now(); refreshSelected(); syncGimbal(s); }
}
let lastSelectedRefresh = 0;

function onMission(m: Mission): void {
  const prev = missions.get(m.mission_id);
  missions.set(m.mission_id, m);
  if (!prev || prev.phase !== m.phase) log(`Mission ${m.mission_id} on ${m.drone_id}: ${m.phase}${m.error ? ` · ${m.error}` : ""}`, m.phase === "complete" ? "good" : m.phase === "failed" ? "bad" : "info");
  else if (prev.next_waypoint !== m.next_waypoint) log(`Mission ${m.mission_id}: waypoint ${m.next_waypoint} of ${m.plan.waypoints.length} reached`);
  if (m.drone_id === selected) refreshMission();
}

function activeMissionFor(id: string | null): Mission | undefined {
  if (!id) return undefined;
  const mine = [...missions.values()].filter((m) => m.drone_id === id);
  return mine.find((m) => ["pending", "flying", "paused", "returning"].includes(m.phase)) ?? mine[mine.length - 1];
}

const SEL_KEY = "argus.selected";
let storedSelection: string | null = null;
try { storedSelection = localStorage.getItem(SEL_KEY); } catch { storedSelection = null; }
let justSelected: string | null = null;
let selectFallback: number | undefined;
let flashTimer: number | undefined;
const sortedDrones = () => [...drones.values()].sort((a, b) => a.drone_id.localeCompare(b.drone_id));

function select(id: string, opts: { quiet?: boolean } = {}): void {
  const changed = selected !== id;
  selected = id;
  pendingDroneParam = null;
  try { localStorage.setItem(SEL_KEY, id); } catch { /* private mode */ }
  $("drone-view-id").textContent = id;
  $("focus-id").textContent = id;
  overview.setSelected(id);
  if (changed) {
    reflectVision(cameraSettings.get(id)?.mode ?? "rgb");  // vision segment and frame tint follow the new Drone's camera settings
    const s = drones.get(id);
    if (s) { syncGimbal(s); renderDroneView(s); }  // no stale frame from the previous Drone while the next telemetry arrives
    if (isEmbed && window.parent !== window) window.parent.postMessage({ type: "argus-selected", drone_id: id }, "*");  // the dashboard confirms its camera follows
  }
  if (changed && !opts.quiet) {
    justSelected = id;
    const panel = $("drone-panel");
    panel.classList.remove("flash"); void panel.offsetWidth; panel.classList.add("flash");
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => { justSelected = null; panel.classList.remove("flash"); refreshFleet(); }, 650);
    if (focusFollow) focusOn(id, 0.8);
  }
  refreshFleet();
  refreshSelected();
  refreshMission();
}
function selectIndex(i: number): void {
  const list = sortedDrones();
  if (list[i]) select(list[i].drone_id);
}
(window as any).__argusSelect = (id: string) => select(id);
window.addEventListener("message", (e) => { const m = e.data; if (m && m.type === "argus-select" && typeof m.drone_id === "string") select(m.drone_id, { quiet: true }); });
let pendingDroneParam: string | null = params.get("drone");
(window as any).__argus = { world, worldCam, controls, renderer, drones, missions };

const refreshFleet = () => renderFleet($("fleet"), sortedDrones(), selected, select, justSelected);
function refreshSelected(): void {
  const s = selected ? drones.get(selected) : undefined;
  renderTelemetry($("drone-telemetry"), s);
  const chip = $("drone-view-status");
  chip.textContent = s ? s.status.replace("_", " ") : "";
  chip.className = `chip status-chip ${s?.status ?? ""}`;
}
const refreshMission = () => renderMission($("mission"), activeMissionFor(selected), missionSpec, validation, selected);
refreshFleet(); refreshSelected(); refreshMission();

// ---- tabs -------------------------------------------------------------------------------------
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) => b.onclick = () => {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === b));
  document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("active", p.id === `tab-${b.dataset.tab}`));
});

// ---- Manual Control (keys -> clamped velocity commands at 10 Hz through the Hub) --------------
const keys = new Set<string>();
let manual = false;
let manualDrone: string | null = null;
let clampTimer: number | undefined;
function showClamp(rule: string): void {
  const el = $("clamp-banner");
  el.textContent = `CLAMPED · ${rule.replace(/\+/g, " + ").replace(/_/g, " ")}`;
  el.hidden = false;
  window.clearTimeout(clampTimer);
  clampTimer = window.setTimeout(() => { el.hidden = true; }, 900);
}
async function manualStart(id: string): Promise<void> {
  const r: any = await api(`/drones/${id}/manual/start`, {});
  manual = true; manualDrone = id;
  $("manual-text").textContent = `${id}${r.paused_mission ? ` · Mission ${r.paused_mission} paused` : ""} · the Safety Validator still clamps every command`;
  $("manual-banner").hidden = false;
  log(`${id}: Manual Control${r.paused_mission ? ` (paused ${r.paused_mission})` : ""}`, "warn");
}
async function manualEnd(action: "resume" | "abort" | "hover"): Promise<void> {
  if (!manualDrone) return;
  const id = manualDrone;
  manual = false; manualDrone = null; manualPhase = "live";
  $("manual-banner").hidden = true;
  try { await api(`/drones/${id}/manual/end`, { action }); log(`${id}: handed back (${action})`, "good"); } catch (err) { log(String(err), "bad"); }
}
// ---- Camera gimbal: slider and [ ] keys send look_at; telemetry drives the readout unless the operator is dragging ----
const gimbalInput = $<HTMLInputElement>("gimbal");
let gimbalDragging = false, gimbalTimer: number | null = null, gimbalPending: number | null = null;
function sendGimbal(pitch: number): void {
  if (!selected) return;
  gimbalPending = pitch;
  if (gimbalTimer !== null) return;
  gimbalTimer = window.setTimeout(() => {
    gimbalTimer = null;
    const p = gimbalPending; gimbalPending = null;
    if (p !== null && selected) api(`/drones/${selected}/command`, { type: "look_at", pitch_deg: p }).catch((err) => log(String(err), "bad"));
  }, 50);  // 20 Hz while a key is held
  gimbalGoal = { id: selected, deg: pitch, until: performance.now() + 1500 };
}
gimbalInput.addEventListener("pointerdown", () => { gimbalDragging = true; });
gimbalInput.addEventListener("pointerup", () => { gimbalDragging = false; });
gimbalInput.addEventListener("input", () => { const v = Number(gimbalInput.value); $("gimbal-value").textContent = `${v}°`; sendGimbal(v); });
function syncGimbal(s: DroneState): void {
  if (gimbalDragging || gimbalTimer !== null) return;
  gimbalInput.value = String(Math.round(s.gimbal_pitch_deg));
  $("gimbal-value").textContent = `${Math.round(s.gimbal_pitch_deg)}°`;
}
function nudgeGimbal(delta: number): void {
  const v = Math.max(-30, Math.min(90, Number(gimbalInput.value) + delta));
  gimbalInput.value = String(v); $("gimbal-value").textContent = `${v}°`; sendGimbal(v);
}
// ---- Optimistic camera targets: the dashboard posts argus-gimbal / argus-camera on the key press (its own keys set the same
// goal), so the picture moves this frame; telemetry and the Hub's camera event take over once they catch up. ----
let gimbalGoal: { id: string; deg: number; until: number } | null = null;
let gimbalGoalLast = 0;
window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || typeof m.drone_id !== "string") return;
  if (m.type === "argus-gimbal" && typeof m.pitch_deg === "number") {
    const deg = Math.max(-30, Math.min(90, m.pitch_deg));
    gimbalGoal = { id: m.drone_id, deg, until: performance.now() + 1500 };
    if (m.drone_id === selected && !gimbalDragging) { gimbalInput.value = String(Math.round(deg)); $("gimbal-value").textContent = `${Math.round(deg)}°`; }
  } else if (m.type === "argus-camera" && typeof m.fov_deg === "number") {
    const cur = cameraSettings.get(m.drone_id) ?? { mode: "rgb", fov_deg: 70 };
    cameraSettings.set(m.drone_id, { ...cur, fov_deg: Math.max(20, Math.min(110, m.fov_deg)) });
  }
});
/** Steer the drawn gimbal toward the optimistic goal with a 60 ms time constant (a 20 Hz stream of 4-degree steps renders as
 *  one sweep) until telemetry agrees with it or the goal goes stale. Runs after the World's own per-frame smoothing. */
function applyGimbalGoal(s: DroneState): void {
  const goal = gimbalGoal; if (!goal || goal.id !== s.drone_id) return;
  const p = world.poseOf(s.drone_id); const now = performance.now();
  if (!p || now > goal.until || Math.abs(s.gimbal_pitch_deg - goal.deg) < 0.5) { gimbalGoal = null; gimbalGoalLast = 0; return; }
  const dt = gimbalGoalLast ? Math.min(0.1, (now - gimbalGoalLast) / 1000) : 0; gimbalGoalLast = now;
  p.gimbal += (goal.deg - p.gimbal) * (1 - Math.exp(-dt / 0.06));
  p.sgimbal = p.gimbal;  // keep the World's smoothing from pulling it back toward the stale telemetry sample
}

window.addEventListener("keydown", (e) => {
  if (e.key === "[" || e.key === "]") { if (!(e.target as HTMLElement).matches("input,textarea")) { e.preventDefault(); nudgeGimbal(e.key === "[" ? -5 : 5); } return; }
  if ((e.target as HTMLElement).tagName === "INPUT" || e.metaKey || e.ctrlKey) return;
  if (e.key === "?") { e.preventDefault(); toggleHelp(); return; }
  if (help?.open) { if (e.key === "Escape") help.close(); return; }
  const k = e.key.toLowerCase();
  if (k >= "1" && k <= "9") { selectIndex(Number(k) - 1); return; }
  if (k === "f" && selected) { focusOn(selected); return; }
  if (k === "g") { fitSite(); return; }
  if (k === "v") { cycleVision(); return; }
  keys.add(k);
  if (k === "h") manualEnd("resume");
  if (k === "x") manualEnd("abort");
  if (k === "r" && selected) returnHome(selected);
  if (["arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) { e.preventDefault(); return; }  // camera: swept continuously while held (see the manual tick)
  if (["w", "a", "s", "d", "q", "e"].includes(k)) {
    e.preventDefault();
    if (!manual && selected) manualStart(selected).catch((err) => log(String(err), "bad"));
  }
});
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
// ---- Manual Control loop: keyboard only. W/S fly along the nose, A/D turn the nose, Q/E descend and climb. The arrow keys
// drive the camera (up/down tilt, left/right zoom) and never move the aircraft. Velocities are recomputed from the current
// heading every tick, so W plus A or D flies a curve and the airframe banks into it.
const KEY_SPEED = 5.0, KEY_CLIMB = 2.5, KEY_YAW_RATE = 90;  // same feel as the dashboard; the autopilot ramps to it in about two seconds
let manualPhase = "live";
setInterval(() => {
  // camera arrows sweep while held: 80 deg/s of tilt, 3x zoom per second, in 4-degree / 0.15x steps at 20 Hz
  const tilt = (keys.has("arrowdown") ? 1 : 0) - (keys.has("arrowup") ? 1 : 0);
  const zoomDir = (keys.has("arrowright") ? 1 : 0) - (keys.has("arrowleft") ? 1 : 0);
  if (tilt) nudgeGimbal(tilt * 4);
  if (zoomDir) nudgeZoom(zoomDir * 0.15, true);
  if (!manual || !manualDrone) return;
  const s = drones.get(manualDrone); if (!s) return;
  const fwd = ((keys.has("w") ? 1 : 0) - (keys.has("s") ? 1 : 0)) * KEY_SPEED;
  const up = ((keys.has("e") ? 1 : 0) - (keys.has("q") ? 1 : 0)) * KEY_CLIMB;
  const yawRate = ((keys.has("d") ? 1 : 0) - (keys.has("a") ? 1 : 0)) * KEY_YAW_RATE;
  const h = s.heading_deg * Math.PI / 180;
  const vn = fwd * Math.cos(h);
  const ve = fwd * Math.sin(h);
  api<any>(`/drones/${manualDrone}/manual/command`, { vx: vn, vy: ve, vz: -up, yaw_rate_dps: yawRate })
    .then((r) => {
      if (r.clamped) showClamp(r.clamped.rule);
      const phase = String(r.phase ?? "live");
      if (phase !== manualPhase) { manualPhase = phase; if (phase !== "live") log(`Manual Control: ${phase}, keys go live once airborne`, "warn"); else log("Manual Control: keys live", "good"); }
      const chip = $("drone-view-status"); if (manual && phase !== "live") { chip.textContent = phase; chip.className = "chip status-chip taking-off"; }
    })
    .catch((err) => log(String(err), "bad"));
}, 50);

function returnHome(id: string): void {
  manualEnd("hover");
  api(`/drones/${id}/command`, { type: "return_home" }).then(() => log(`${id}: return home`, "warn")).catch((err) => log(String(err), "bad"));
}

// ---- World view camera: focus on a Drone / fit the Site (eased tweens) ----------------------------
const HOME_POS = enuToThree(-230, -290, 150);
const HOME_TARGET = enuToThree(0, 0, 5);
type CamTween = { t0: number; dur: number; fromPos: THREE.Vector3; toPos: THREE.Vector3; fromTgt: THREE.Vector3; toTgt: THREE.Vector3 } | null;
let camTween: CamTween = null;
let focusFollow = false;  // after Focus, keep the target on the Drone until the user orbits/zooms
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
function tweenCamera(toPos: THREE.Vector3, toTgt: THREE.Vector3, dur = 0.8): void {
  camTween = { t0: performance.now(), dur: dur * 1000, fromPos: worldCam.position.clone(), toPos: toPos.clone(), fromTgt: controls.target.clone(), toTgt: toTgt.clone() };
}
/** When a Scenario places something new, the World view flies to it (unless the Operator is following a Drone).
 *  The first look at a fire or a steam column is the demo's opening shot; nobody should have to hunt for it. */
const seenProps = new Set<string>();
function focusNewProps(state: SceneState): void {
  const fresh = state.props.filter((p) => !seenProps.has(p.id));
  state.props.forEach((p) => seenProps.add(p.id));
  if (!fresh.length || focusFollow || isEmbedDrone || isHeadless) return;
  const p = fresh[fresh.length - 1];
  const tgt = enuToThree(p.x, p.y, (p.z ?? 0) + 4);
  const dir = new THREE.Vector3(-0.55, 0.5, 0.65).normalize();  // from the south-west, looking down at ~30 degrees
  const pos = tgt.clone().add(dir.multiplyScalar(70));
  tweenCamera(pos, tgt, 1.4);
  log(`World view: looking at ${p.kind === "fire" ? "the fire" : p.kind === "steam" ? "the steam release" : `the ${p.kind}`} (${p.id})`);
}
/** Chase distance for Focus: ?dist=<metres> (default 45). Close values (4 to 8) give a cinematic follow of the airframe. */
const focusDistance = Math.max(2, Math.min(300, Number(params.get("dist")) || 45));
(window as any).__argusFocus = (id: string, dist?: number) => focusOn(id, 0.6, dist);
function focusOn(id: string, dur = 0.8, dist = focusDistance): void {
  const g = world.drones.get(id);
  if (!g) return;
  const tgt = g.position.clone();
  // keep the current viewing direction, come in to ~45 m
  const dir = worldCam.position.clone().sub(controls.target).normalize();
  if (dir.lengthSq() < 1e-6) dir.set(-0.6, 0.5, 0.6).normalize();
  dir.y = Math.max(dir.y, 0.35);
  const pos = tgt.clone().add(dir.normalize().multiplyScalar(dist));
  pos.y = Math.max(pos.y, tgt.y + Math.min(12, dist * 0.35));
  tweenCamera(pos, tgt, dur);
  focusFollow = true;
  log(`World view: focus on ${id}`);
}
function fitSite(): void { focusFollow = false; tweenCamera(HOME_POS, HOME_TARGET, 0.9); }
controls.addEventListener("start", () => { camTween = null; focusFollow = false; });
$("focus-drone").onclick = () => { if (selected) focusOn(selected); else log("Select a Drone first", "warn"); };
$("fit-site").onclick = fitSite;

// ---- Sightings overlay: the Hub's measurements drawn over the Drone view for a few seconds ---------------------------
type SightingRow = { id: string; label: string; temp_max_c: number | null; bbox: number[]; range_m: number; lat: number; lon: number };
const SIGHTING_SHOW_MS = 3000;
let sightingsTimer: number | undefined;
function onSightings(ev: { drone_id: string; width?: number; height?: number; sightings: SightingRow[] }): void {
  const rows = ev.sightings ?? [];
  for (const s of rows) log(`${ev.drone_id} sighting: ${s.label.replace("_", " ")}${s.temp_max_c != null ? ` ${s.temp_max_c.toFixed(0)} C` : ""} at ${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}, ${s.range_m.toFixed(0)} m`, s.label === "hot_spot" ? "warn" : "info");
  if (ev.drone_id !== selected || rows.length === 0) return;
  const frame = document.querySelector<HTMLElement>(".drone-frame");
  if (!frame) return;
  let layer = document.getElementById("sightings-layer");
  if (!layer) {
    layer = document.createElement("div"); layer.id = "sightings-layer";
    layer.style.cssText = "position:absolute;pointer-events:none;overflow:hidden;z-index:4";
    frame.appendChild(layer);
  }
  // frame pixels to the displayed canvas size
  const cw = droneCanvas.clientWidth || droneCanvas.width, ch = droneCanvas.clientHeight || droneCanvas.height;
  const fw = ev.width || droneCanvas.width, fh = ev.height || droneCanvas.height;
  layer.style.left = `${droneCanvas.offsetLeft}px`; layer.style.top = `${droneCanvas.offsetTop}px`; layer.style.width = `${cw}px`; layer.style.height = `${ch}px`;
  layer.replaceChildren(...rows.map((s) => {
    const [x0, y0, x1, y1] = s.bbox;
    const box = document.createElement("div");
    const hot = s.label === "hot_spot";
    box.style.cssText = `position:absolute;left:${(x0 / fw) * cw}px;top:${(y0 / fh) * ch}px;width:${((x1 - x0) / fw) * cw}px;height:${((y1 - y0) / fh) * ch}px;` +
      `border:2px solid ${hot ? "#ff5a3c" : "#9fd3ff"};border-radius:2px;box-shadow:0 0 0 1px rgba(0,0,0,.55);`;
    const tag = document.createElement("span");
    tag.textContent = `${s.label.replace("_", " ")}${s.temp_max_c != null ? ` ${s.temp_max_c.toFixed(0)} C` : ""} · ${s.range_m.toFixed(0)} m`;
    tag.style.cssText = `position:absolute;left:-2px;${y0 / fh * ch > 18 ? "bottom:100%" : "top:100%"};white-space:nowrap;padding:1px 5px;font:600 11px/1.4 ui-monospace,Menlo,monospace;` +
      `color:#fff;background:${hot ? "rgba(255,90,60,.9)" : "rgba(60,140,220,.9)"};border-radius:2px`;
    box.appendChild(tag);
    return box;
  }));
  layer.hidden = false;
  window.clearTimeout(sightingsTimer);
  sightingsTimer = window.setTimeout(() => { layer!.hidden = true; }, SIGHTING_SHOW_MS);
}

// ---- vision mode switch -------------------------------------------------------------------------------
const VISION: ("rgb" | "thermal" | "lidar")[] = ["rgb", "thermal", "lidar"];
function reflectVision(mode: "rgb" | "thermal" | "lidar"): void {
  document.querySelectorAll<HTMLButtonElement>("#vision-seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  const frame = document.querySelector<HTMLElement>(".drone-frame");
  if (frame) frame.className = `drone-frame${mode !== "rgb" ? ` mode-${mode}` : ""}`;
  if (selected && drones.has(selected)) renderHud($("hud"), drones.get(selected), (drones.get(selected)!.alt > 0.3), mode);
}
/** Camera zoom in steps: field of view 110 (1x) down to 20 degrees (5.5x), brokered by the Hub so every view follows. */
function nudgeZoom(deltaZoom: number, quiet = false): void {
  if (!selected) return;
  const cur = cameraSettings.get(selected) ?? { mode: "rgb", fov_deg: 70 };
  const zoom = Math.max(1, Math.min(5.5, 110 / cur.fov_deg + deltaZoom));
  const fov = Math.round(110 / zoom);
  cameraSettings.set(selected, { ...cur, fov_deg: fov });
  api(`/drones/${selected}/camera`, { fov_deg: fov }).catch((err) => log(String(err), "bad"));
  if (!quiet) log(`Camera zoom ${zoom.toFixed(1)}x`);
}
function setVision(mode: "rgb" | "thermal" | "lidar"): void {
  if (selected) {
    const cur = cameraSettings.get(selected) ?? { mode: "rgb", fov_deg: 70 };
    cameraSettings.set(selected, { ...cur, mode });
    api(`/drones/${selected}/camera`, { mode }).catch((err) => log(String(err), "bad"));
  }
  reflectVision(mode);

}
document.querySelectorAll<HTMLButtonElement>("#vision-seg button").forEach((b) => b.onclick = () => setVision(b.dataset.mode as any));
const cycleVision = () => { const cur = (selected && cameraSettings.get(selected)?.mode) || "rgb"; setVision(VISION[(VISION.indexOf(cur) + 1) % VISION.length]); };

// ---- help dialog ----------------------------------------------------------------------------------------
const help = document.getElementById("help") as HTMLDialogElement | null;
const toggleHelp = () => { if (!help) return; help.open ? help.close() : help.showModal(); };
$("help-btn").onclick = toggleHelp;
document.getElementById("help-close")?.addEventListener("click", () => help?.close());

// ---- toolbar ------------------------------------------------------------------------------------
document.querySelectorAll<HTMLButtonElement>("button[data-scenario]").forEach((b) => b.onclick = async () => {
  const kind = b.dataset.scenario!;
  try { await api("/scenarios/run", { id: `scn-${Date.now().toString(36)}`, kind, params: {} }); log(`Scenario: ${kind.replace("_", " ")}`, "warn"); } catch (err) { log(String(err), "bad"); }
});
$("reset-scene").onclick = async () => { try { await api("/scenarios/reset", {}); log("Site reset to baseline"); } catch (err) { log(String(err), "bad"); } };
$("baseline").onclick = async () => {
  baselineRef = `overhead/baseline-${Date.now()}.png`;
  await api("/overhead/capture", { ref: baselineRef });
  log(`Baseline captured: ${baselineRef}`, "good");
};
$("detect").onclick = async () => {
  if (!baselineRef) { log("Capture a Baseline first.", "warn"); return; }
  const afterRef = `overhead/after-${Date.now()}.png`;
  await api("/overhead/capture", { ref: afterRef });
  const dets: any[] = await api("/widearea/detect", { before_ref: baselineRef, after_ref: afterRef });
  if (dets.length === 0) log("Change detection: no change above the minimum area.", "good");
};
$("dispatch").onclick = async () => {
  if (detections.length === 0) return;
  const d = detections[detections.length - 1];
  dispatching = true; refreshDispatchButton(); switchTab("mission");
  log(`Dispatching ${d.id} to the Triage Agent…`);
  api(`/detections/${d.id}/dispatch`, {}).catch((err) => { log(String(err), "bad"); dispatching = false; refreshDispatchButton(); });
};
$("capture-overhead").onclick = async () => { try { const r: any = await api("/overhead/capture", { ref: `overhead/${Date.now()}.png` }); log(`Overhead captured: ${r.ref}`, "good"); } catch (err) { log(String(err), "bad"); } };
$("return-home").onclick = () => { if (selected) returnHome(selected); };
$("fly-square").onclick = async () => {
  if (!selected) { log("Select a Drone first", "warn"); return; }
  try {
    const plan = await (await fetch("./fixtures/flight_plan_square.json")).json();
    plan.mission_id = `msn-${Date.now().toString(36)}`;
    await api("/missions/fly", { plan, drone_id: selected });
    log(`${selected}: dispatched square Mission ${plan.mission_id}`, "good");
    document.querySelector<HTMLButtonElement>('.tab[data-tab="mission"]')?.click();
  } catch (err) { log(String(err), "bad"); }
};

// ---- render loop ---------------------------------------------------------------------------------
let frames = 0, lastFps = performance.now(), lastStream = 0, lastDroneRender = 0, lastHud = 0;
// Canvas sizes come from a ResizeObserver, so the render loop never forces a layout by reading clientWidth.
const layout = { worldW: worldCanvas.clientWidth, worldH: worldCanvas.clientHeight, droneW: droneCanvas.clientWidth, droneH: droneCanvas.clientHeight };
new ResizeObserver((entries) => {
  for (const e of entries) {
    const r = e.contentRect;
    if (e.target === worldCanvas) { layout.worldW = r.width; layout.worldH = r.height; }
    if (e.target === droneCanvas) { layout.droneW = r.width; layout.droneH = r.height; }
  }
}).observe(worldCanvas);
new ResizeObserver((entries) => { for (const e of entries) { layout.droneW = e.contentRect.width; layout.droneH = e.contentRect.height; } }).observe(droneCanvas);
// Rendering pauses while this view is not visible (a hidden dashboard tab, a background browser tab); telemetry still flows.
let visible = !document.hidden;
document.addEventListener("visibilitychange", () => { visible = !document.hidden; });
new IntersectionObserver((entries) => { for (const e of entries) visible = e.isIntersecting && !document.hidden; }).observe(isEmbedDrone ? droneCanvas : worldCanvas);
let sizedW = 0, sizedH = 0, sizedRatio = 0;
function resize(): void {
  const w = Math.floor(layout.worldW), h = Math.floor(layout.worldH);
  if (w > 0 && h > 0 && (w !== sizedW || h !== sizedH || pixelRatio !== sizedRatio)) {
    sizedW = w; sizedH = h; sizedRatio = pixelRatio;
    renderer.setPixelRatio(pixelRatio); renderer.setSize(w, h, false); worldCam.aspect = w / h; worldCam.updateProjectionMatrix(); overview.resize();
  }
}
// ---- perf instrumentation: per-stage ms averaged over the last second, on window.__argusPerf ----
const perf = { world: 0, drone: 0, stream: 0, ui: 0, frames: 0, lastReport: performance.now(), steps: [] as number[], lastPose: null as THREE.Vector3 | null, dts: [] as number[], lastNow: 0,
  report: { world: 0, drone: 0, stream: 0, ui: 0, fps: 0, stepMean: 0, stepStd: 0, stepMax: 0, stillFrames: 0, p50: 0, p95: 0, p99: 0, dtMax: 0, long20: 0, long34: 0, calls: 0, tris: 0 } };
world.smoothing = new URLSearchParams(location.search).get("smooth") !== "0";
(window as any).__argusPerf = perf;
function stage<T>(key: "world" | "drone" | "stream" | "ui", fn: () => T): T { const t = performance.now(); const r = fn(); (perf as any)[key] += performance.now() - t; return r; }
let lastWorldRender = 0;
const followDelta = new THREE.Vector3();
function loop(now: number): void {
  requestAnimationFrame(loop);
  resize();
  if (camTween) {
    const u = Math.min(1, (now - camTween.t0) / camTween.dur);
    const k = easeInOut(u);
    worldCam.position.lerpVectors(camTween.fromPos, camTween.toPos, k);
    controls.target.lerpVectors(camTween.fromTgt, camTween.toTgt, k);
    if (u >= 1) camTween = null;
  } else if (focusFollow && selected && world.drones.has(selected)) {
    const g = world.drones.get(selected)!;
    followDelta.copy(g.position).sub(controls.target);
    controls.target.add(followDelta);
    worldCam.position.add(followDelta);
  }
  controls.update();
  fitDroneCanvas();
  if (!visible && !isHeadless) { world.update(now / 1000, worldCam.position); perf.lastNow = 0; return; }  // hidden: keep poses warm, draw nothing
  // A headless Renderer only answers render requests (evidence frames, overheads), which draw on demand. Its continuous
  // World render and MJPEG stream are idled to a few frames a second so the Operator's own tabs keep the GPU.
  const worldDue = !isHeadless || now - lastWorldRender > 250;
  renderer.info.reset();
  stage("world", () => { world.update(now / 1000, worldCam.position); if (!isEmbedDrone && worldDue) { lastWorldRender = now; world.renderWorld(renderer, worldCam); } });
  if (selected && drones.has(selected)) {
    const s = drones.get(selected)!;
    // The Drone view is a camera feed. The embed renders it every frame; the full Console at 30 Hz; the World-only embed
    // has no Drone view on screen and skips it. The MJPEG stream (legacy /mjpeg consumers) is produced only by the headless
    // Renderer or when ?stream=1 is set: a toBlob readback every 80 ms was a periodic hitch in every other view.
    if (isEmbedDrone || (!isEmbedWorld && now - lastDroneRender > (isHeadless ? 200 : 33))) { lastDroneRender = now; stage("drone", () => renderDroneView(s)); }
    const streaming = s.alt > 0.3 && (isHeadless || wantStream) && !isEmbedDrone;
    if (streaming && now - lastStream > (isHeadless ? 200 : 80)) { lastStream = now; stage("stream", () => streamFrame(s)); }
    if (now - lastHud > 250) { lastHud = now; stage("ui", () => renderHud($("hud"), s, streaming, vision.mode)); }
  }
  frames++; perf.frames++;
  if (perf.lastNow) perf.dts.push(now - perf.lastNow); perf.lastNow = now;
  // motion smoothness of the selected Drone: frame-to-frame step of its drawn position. Smooth motion has a low spread and
  // no still frames while moving; snapping to 10 Hz telemetry shows as five still frames then one big step.
  if (selected && world.drones.has(selected)) {
    const pos = world.drones.get(selected)!.position;
    if (perf.lastPose) perf.steps.push(pos.distanceTo(perf.lastPose)); else perf.lastPose = new THREE.Vector3();
    perf.lastPose!.copy(pos);
  }
  if (now - lastFps > 1000) {
    $("fps").textContent = `${frames} fps`;
    // adaptive resolution: step the pixel ratio down when we cannot hold ~50 fps, back up when there is headroom
    if (visible && !isEmbedDrone && now - lastRatioChange > 3000) {
      if (frames < 45 && pixelRatio > 1.0) { pixelRatio = Math.max(1.0, +(pixelRatio - 0.25).toFixed(2)); lastRatioChange = now; }
      else if (frames > 58 && pixelRatio < MAX_RATIO) { pixelRatio = Math.min(MAX_RATIO, +(pixelRatio + 0.25).toFixed(2)); lastRatioChange = now; }
      $("fps").title = `render scale ${pixelRatio}x`;
    }
    frames = 0; lastFps = now; $("clock").textContent = new Date().toLocaleTimeString();
  }
  if (now - perf.lastReport > 1000) {
    const n = Math.max(1, perf.frames);
    const st = perf.steps, m = st.length ? st.reduce((a, b) => a + b, 0) / st.length : 0;
    const sd = st.length ? Math.sqrt(st.reduce((a, b) => a + (b - m) ** 2, 0) / st.length) : 0;
    const d = perf.dts.slice().sort((a, b) => a - b), q = (f: number) => (d.length ? d[Math.min(d.length - 1, Math.floor(f * d.length))] : 0);
    const info = renderer.info.render;
    perf.report = { world: +(perf.world / n).toFixed(2), drone: +(perf.drone / n).toFixed(2), stream: +(perf.stream / n).toFixed(2), ui: +(perf.ui / n).toFixed(2), fps: perf.frames,
      stepMean: +m.toFixed(3), stepStd: +sd.toFixed(3), stepMax: +(st.length ? Math.max(...st) : 0).toFixed(3), stillFrames: st.filter((x) => x < 1e-4).length,
      p50: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1), p99: +q(0.99).toFixed(1), dtMax: +(d.length ? d[d.length - 1] : 0).toFixed(1), long20: d.filter((x) => x > 20).length, long34: d.filter((x) => x > 34).length,
      calls: info.calls, tris: info.triangles };
    perf.world = perf.drone = perf.stream = perf.ui = 0; perf.frames = 0; perf.lastReport = now; perf.steps = []; perf.dts = [];
  }
}
requestAnimationFrame(loop);
