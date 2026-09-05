import "./style.css";
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
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const worldCam = new THREE.PerspectiveCamera(50, 1, 0.5, 3000);
const controls = new OrbitControls(worldCam, worldCanvas);
controls.target.copy(enuToThree(0, 0, 5));
controls.maxPolarAngle = Math.PI / 2 - 0.03;
controls.minDistance = 8;
controls.maxDistance = 1200;
worldCam.position.copy(enuToThree(-230, -290, 150));
controls.update();

// ---- Drone view (offscreen renderer with a sensor post-pass; also serves Renderer-role captures) ----
const droneCanvas = $<HTMLCanvasElement>("drone-canvas");
const droneRenderer = new THREE.WebGLRenderer({ canvas: droneCanvas, antialias: true, preserveDrawingBuffer: true });
droneRenderer.shadowMap.enabled = true;
droneRenderer.toneMapping = THREE.ACESFilmicToneMapping;
droneRenderer.outputColorSpace = THREE.SRGBColorSpace;
droneRenderer.setPixelRatio(1);
const droneCam = new THREE.PerspectiveCamera(70, 800 / 480, 0.05, 2000);
const vision = new VisionModes(droneRenderer, world);
(window as any).__argusVision = vision;
const droneTarget = new THREE.WebGLRenderTarget(800, 480, { samples: 4, type: THREE.HalfFloatType });
const postScene = new THREE.Scene();
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const postMat = new THREE.ShaderMaterial({
  uniforms: { tDiffuse: { value: droneTarget.texture }, time: { value: 0 }, grain: { value: 0.045 }, vignette: { value: 0.35 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float time; uniform float grain; uniform float vignette; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7)) + time) * 43758.5453); }
    void main(){
      vec2 d = vUv - 0.5;
      float ca = 0.0025 * length(d);
      vec3 c;
      c.r = texture2D(tDiffuse, vUv + d * ca).r;
      c.g = texture2D(tDiffuse, vUv).g;
      c.b = texture2D(tDiffuse, vUv - d * ca).b;
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

function renderDroneView(s: DroneState): void {
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

function frameMessage(s: DroneState, cmdId: string | null) {
  renderDroneView(s);
  const jpeg = droneCanvas.toDataURL("image/jpeg", 0.72).split(",")[1];
  return { type: "frame", drone_id: s.drone_id, jpeg_b64: jpeg, width: droneCanvas.width, height: droneCanvas.height, lat: s.lat, lon: s.lon, alt: s.alt,
           heading_deg: s.heading_deg, gimbal_pitch_deg: s.gimbal_pitch_deg, ts: new Date().toISOString(), cmd_id: cmdId };
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
    reply(frameMessage(s, cmd.cmd_id));
    log(`Renderer: evidence frame for ${cmd.drone_id}`);
  } else if (cmd.type === "capture_overhead") {
    reply({ type: "ack", cmd_id: cmd.cmd_id, ok: true });
    reply(overheadMessage(cmd.ref, cmd.cmd_id));
    log(`Renderer: overhead captured ${cmd.ref}`);
  } else if (cmd.type === "scene") {
    scene = cmd.state; world.setScene(scene); overview.setScene(scene);
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
      break;
    case "drone_state": onDrone(ev.state); break;
    case "scene": scene = ev.state; world.setScene(scene); overview.setScene(scene); break;
    case "mission": onMission(ev.mission); break;
    case "clamp": log(`Safety Validator clamped ${ev.drone_id}: ${ev.rule}`, "warn"); showClamp(ev.rule); break;
    case "manual": log(`${ev.drone_id}: Manual Control ${ev.active ? "taken" : "released"}${ev.mission_id ? ` (Mission ${ev.mission_id})` : ""}`, "warn"); break;
    case "overhead": log(`Overhead image stored: ${ev.ref}`, "good"); break;
    case "detection": onDetection(ev.detection); break;
    case "mission_spec": missionSpec = { objective: ev.spec.objective, rationale: ev.spec.rationale, max_altitude_m: ev.spec.max_altitude_m, standoff_m: ev.spec.standoff_m }; log(`Triage Agent proposed a plan (attempt ${ev.spec.attempt ?? 1}): ${ev.spec.rationale}`); refreshMission(); switchTab("mission"); break;
    case "validation": validation = { verdict: ev.result.verdict, violations: ev.result.violations }; log(ev.result.verdict === "accept" ? `Safety Validator: ACCEPT (${ev.result.checks_passed ?? ""} checks)` : `Safety Validator: REJECT ${ev.result.violations.map((v: any) => v.rule).join(", ")}`, ev.result.verdict === "accept" ? "good" : "warn"); refreshMission(); break;
    case "triage": log(`Triage: ${String(ev.decision).toUpperCase()} (confidence ${ev.confidence}) ${ev.rationale ?? ""}`, ev.decision === "escalate" ? "warn" : "good"); break;
    case "incident": log(`INCIDENT REPORT [${ev.severity}] ${ev.title}: ${ev.recommended_action}`, ev.severity === "high" || ev.severity === "critical" ? "bad" : "warn"); break;
    case "dispatch_outcome": log(`Dispatch outcome for ${ev.detection_id}: ${ev.flown ? "flown by " + ev.drone_id : "NOT FLOWN"} after ${ev.attempts} attempt(s), triage ${ev.triage?.decision}`, ev.flown ? "good" : "warn"); dispatching = false; refreshDispatchButton(); break;
    case "autonomy": if (["plan_abandoned", "waypoint_reached", "observation"].includes(ev.event.type)) log(`agent ${ev.event.type}: ${ev.event.type === "observation" ? ev.event.payload.caption : JSON.stringify(ev.event.payload).slice(0, 140)}`); break;
    case "ack": if (!ev.ok) log(`${ev.drone_id} refused command: ${ev.detail}`, "bad"); break;
  }
}, (ok) => setPill("hub-status", ok, ok ? "hub live" : "hub reconnecting"));

function onDrone(s: DroneState): void {
  const prev = drones.get(s.drone_id);
  drones.set(s.drone_id, s);
  world.updateDrone(s);
  overview.updateDrone(s);
  if (prev && prev.status !== s.status) log(`${s.drone_id}: ${prev.status.replace("_", " ")} → ${s.status.replace("_", " ")}${s.mode ? ` (${s.mode})` : ""}`, s.status === "offline" ? "bad" : "info");
  if (s.message?.startsWith("REFUSED") && lastRefused.get(s.drone_id) !== s.message) { lastRefused.set(s.drone_id, s.message); log(`${s.drone_id}: onboard fence ${s.message}`, "bad"); }
  if (selected === null && s.status !== "offline" && (storedSelection === null || storedSelection === s.drone_id)) select(s.drone_id, { quiet: true });
  if (selected === null && !selectFallback) selectFallback = window.setTimeout(() => { if (selected === null && drones.size) select(sortedDrones()[0].drone_id, { quiet: true }); }, 2500);
  refreshFleet();
  if (s.drone_id === selected) refreshSelected();
}

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
  try { localStorage.setItem(SEL_KEY, id); } catch { /* private mode */ }
  $("drone-view-id").textContent = id;
  $("focus-id").textContent = id;
  overview.setSelected(id);
  if (changed && !opts.quiet) {
    justSelected = id;
    const panel = $("drone-panel");
    panel.classList.remove("flash"); void panel.offsetWidth; panel.classList.add("flash");
    window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => { justSelected = null; panel.classList.remove("flash"); refreshFleet(); }, 650);
    if (drones.has(id)) renderDroneView(drones.get(id)!);  // no stale frame while the next telemetry arrives
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
  manual = false; manualDrone = null;
  $("manual-banner").hidden = true;
  try { await api(`/drones/${id}/manual/end`, { action }); log(`${id}: handed back (${action})`, "good"); } catch (err) { log(String(err), "bad"); }
}
window.addEventListener("keydown", (e) => {
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
  if (["w", "a", "s", "d", "q", "e", "arrowleft", "arrowright"].includes(k)) {
    e.preventDefault();
    if (!manual && selected) manualStart(selected).catch((err) => log(String(err), "bad"));
  }
});
window.addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
setInterval(() => {
  if (!manual || !manualDrone) return;
  const s = drones.get(manualDrone); if (!s) return;
  const spd = 3.0, climb = 1.5, yawRate = 45;
  const fwd = (keys.has("w") ? 1 : 0) - (keys.has("s") ? 1 : 0);
  const right = (keys.has("d") ? 1 : 0) - (keys.has("a") ? 1 : 0);
  const up = (keys.has("e") ? 1 : 0) - (keys.has("q") ? 1 : 0);
  const yaw = (keys.has("arrowright") ? 1 : 0) - (keys.has("arrowleft") ? 1 : 0);
  const h = s.heading_deg * Math.PI / 180;
  const vn = spd * (fwd * Math.cos(h) - right * Math.sin(h));
  const ve = spd * (fwd * Math.sin(h) + right * Math.cos(h));
  api<any>(`/drones/${manualDrone}/manual/command`, { vx: vn, vy: ve, vz: -up * climb, yaw_rate_dps: yaw * yawRate })
    .then((r) => { if (r.clamped) showClamp(r.clamped.rule); })
    .catch((err) => log(String(err), "bad"));
}, 100);

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
function focusOn(id: string, dur = 0.8): void {
  const g = world.drones.get(id);
  if (!g) return;
  const tgt = g.position.clone();
  // keep the current viewing direction, come in to ~45 m
  const dir = worldCam.position.clone().sub(controls.target).normalize();
  if (dir.lengthSq() < 1e-6) dir.set(-0.6, 0.5, 0.6).normalize();
  dir.y = Math.max(dir.y, 0.35);
  const pos = tgt.clone().add(dir.normalize().multiplyScalar(45));
  pos.y = Math.max(pos.y, tgt.y + 12);
  tweenCamera(pos, tgt, dur);
  focusFollow = true;
  log(`World view: focus on ${id}`);
}
function fitSite(): void { focusFollow = false; tweenCamera(HOME_POS, HOME_TARGET, 0.9); }
controls.addEventListener("start", () => { camTween = null; focusFollow = false; });
$("focus-drone").onclick = () => { if (selected) focusOn(selected); else log("Select a Drone first", "warn"); };
$("fit-site").onclick = fitSite;

// ---- vision mode switch -------------------------------------------------------------------------------
const VISION: ("rgb" | "thermal" | "lidar")[] = ["rgb", "thermal", "lidar"];
function setVision(mode: "rgb" | "thermal" | "lidar"): void {
  vision.mode = mode;
  document.querySelectorAll<HTMLButtonElement>("#vision-seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  const frame = document.querySelector<HTMLElement>(".drone-frame");
  if (frame) frame.className = `drone-frame${mode !== "rgb" ? ` mode-${mode}` : ""}`;
  if (selected && drones.has(selected)) renderHud($("hud"), drones.get(selected), (drones.get(selected)!.alt > 0.3), mode);
}
document.querySelectorAll<HTMLButtonElement>("#vision-seg button").forEach((b) => b.onclick = () => setVision(b.dataset.mode as any));
const cycleVision = () => setVision(VISION[(VISION.indexOf(vision.mode) + 1) % VISION.length]);

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
let frames = 0, lastFps = performance.now(), lastStream = 0, lastHud = 0;
function resize(): void {
  const w = worldCanvas.clientWidth, h = worldCanvas.clientHeight;
  const dpr = Math.min(window.devicePixelRatio, 2);
  if (w > 0 && h > 0 && (worldCanvas.width !== Math.floor(w * dpr) || worldCanvas.height !== Math.floor(h * dpr))) {
    renderer.setSize(w, h, false); worldCam.aspect = w / h; worldCam.updateProjectionMatrix(); overview.resize();
  }
}
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
    const delta = g.position.clone().sub(controls.target);
    controls.target.add(delta);
    worldCam.position.add(delta);
  }
  controls.update();
  world.update(now / 1000);
  world.renderWorld(renderer, worldCam);
  if (selected && drones.has(selected)) {
    const s = drones.get(selected)!;
    renderDroneView(s);
    const streaming = s.alt > 0.3;
    if (streaming && now - lastStream > 100) { lastStream = now; link.send(frameMessage(s, null)); }
    if (now - lastHud > 250) { lastHud = now; renderHud($("hud"), s, streaming, vision.mode); }
  }
  frames++;
  if (now - lastFps > 1000) { $("fps").textContent = `${frames} fps`; frames = 0; lastFps = now; $("clock").textContent = new Date().toLocaleTimeString(); }
}
requestAnimationFrame(loop);
