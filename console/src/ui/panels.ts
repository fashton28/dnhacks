// Panel renderers for the Console shell: Fleet cards, Mission/Validation, Log feed, Drone telemetry HUD.
// Pure DOM rendering from state; no network or Three.js here.
import type { DroneState } from "../hub";

export type Mission = {
  mission_id: string; drone_id: string; phase: string; next_waypoint: number; evidence: string[]; error: string | null;
  plan: { waypoints: { lat: number; lon: number; alt: number }[]; pattern: string; est_duration_s: number; est_battery_pct: number };
};

/** Placeholders for the agent workstream: filled when the Triage Agent and Safety Validator publish events. */
export type MissionSpecView = { objective: string; rationale: string; max_altitude_m: number; standoff_m: number } | null;
export type ValidationView = { verdict: "accept" | "reject"; violations: { rule: string; detail: string; severity: string }[] } | null;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

/** Fleet cards are keyed by drone id and patched in place: telemetry arrives ~10 Hz per Drone and a rebuild would detach the element under a click. */
export function renderFleet(el: HTMLElement, drones: DroneState[], selected: string | null, onSelect: (id: string) => void, justSelected: string | null = null): void {
  if (drones.length === 0) {
    if (!el.querySelector(".empty")) el.innerHTML = `<div class="empty"><b>No Drones connected.</b><br>Start the fleet with <span class="mono">make sim</span> or <span class="mono">make fake-fleet</span>.</div>`;
    return;
  }
  el.querySelector(".empty")?.remove();
  const seen = new Set<string>();
  drones.forEach((s, i) => {
    seen.add(s.drone_id);
    let card = el.querySelector<HTMLElement>(`[data-drone="${s.drone_id}"]`);
    if (!card) {
      card = document.createElement("div");
      card.dataset.drone = s.drone_id;
      card.innerHTML = `<div class="id"><span class="name"></span> <span class="status-chip"></span><span class="key"></span></div>
        <div class="stat alt"></div><div class="mode"></div><div class="stat bat"></div><div class="bar"><i></i></div>`;
      card.onclick = () => onSelect(s.drone_id);
      el.appendChild(card);
    }
    if (el.children[i] !== card) el.insertBefore(card, el.children[i] ?? null);
    card.className = `drone-card${s.drone_id === selected ? " selected" : ""}${s.drone_id === justSelected ? " just-selected" : ""}`;
    card.title = `Select ${s.drone_id} (key ${i + 1})`;
    const bat = Math.max(0, Math.min(100, s.battery_pct));
    const set = (sel: string, text: string) => { const n = card!.querySelector<HTMLElement>(sel)!; if (n.textContent !== text) n.textContent = text; };
    set(".name", s.drone_id);
    const chip = card.querySelector<HTMLElement>(".status-chip")!;
    chip.className = `status-chip ${s.status}`; set(".status-chip", s.status.replace("_", " "));
    set(".key", i < 9 ? String(i + 1) : "");
    card.querySelector<HTMLElement>(".alt")!.innerHTML = `<b>${s.alt.toFixed(1)}</b> m AGL`;
    set(".mode", `${s.mode || "—"}${s.armed ? " · armed" : ""} · hdg ${s.heading_deg.toFixed(0)}°`);
    card.querySelector<HTMLElement>(".bat")!.innerHTML = `<b>${bat.toFixed(0)}%</b> battery`;
    const bar = card.querySelector<HTMLElement>(".bar")!;
    bar.className = `bar ${bat < 20 ? "crit" : bat < 35 ? "low" : ""}`;
    (bar.firstElementChild as HTMLElement).style.width = `${bat}%`;
  });
  for (const c of [...el.querySelectorAll<HTMLElement>("[data-drone]")]) if (!seen.has(c.dataset.drone!)) c.remove();
}

export function renderTelemetry(el: HTMLElement, s: DroneState | undefined): void {
  if (!s) { el.innerHTML = `<div class="empty"><b>No Drone selected.</b><br>Click a Fleet card or an Overview marker, or press 1, 2, 3.</div>`; return; }
  const kv = (k: string, v: string) => `<div><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const refused = s.message?.startsWith("REFUSED");
  el.innerHTML =
    kv("lat / lon", `${s.lat.toFixed(6)}<br>${s.lon.toFixed(6)}`) +
    kv("altitude", `${s.alt.toFixed(1)} m`) +
    kv("heading", `${s.heading_deg.toFixed(0)}°`) +
    kv("gimbal", `${s.gimbal_pitch_deg.toFixed(0)}° down`) +
    kv("velocity ned", `${s.velocity_ned.vx.toFixed(1)} ${s.velocity_ned.vy.toFixed(1)} ${s.velocity_ned.vz.toFixed(1)}`) +
    kv("battery", `${s.battery_pct.toFixed(0)}%`) +
    kv("autopilot", `${esc(s.mode || "—")}${s.armed ? " · armed" : ""}`) +
    kv("status", esc(s.status.replace("_", " "))) +
    (s.message ? `<div class="msg${refused ? " refused" : ""}"><span class="k">autopilot message</span>${esc(s.message)}</div>` : "");
}

export function renderHud(el: HTMLElement, s: DroneState | undefined, streaming: boolean, mode = "rgb"): void {
  if (!s) { el.innerHTML = ""; return; }
  el.innerHTML = `<span>${esc(s.drone_id)} · ${s.alt.toFixed(1)} m · ${s.heading_deg.toFixed(0)}°</span><span>${mode !== "rgb" ? `<span class="mode">${esc(mode.toUpperCase())}</span>` : ""}${streaming ? '<span class="rec">LIVE</span>' : ""}${new Date(s.ts).toLocaleTimeString()}</span>`;
}

export function renderMission(el: HTMLElement, m: Mission | undefined, spec: MissionSpecView, validation: ValidationView, droneId: string | null): void {
  const n = m?.plan.waypoints.length ?? 0;
  const progress = m ? `<div class="progress">${Array.from({ length: n }, (_, i) => `<i class="${i < m.next_waypoint ? "done" : i === m.next_waypoint && m.phase === "flying" ? "cur" : ""}"></i>`).join("")}</div>` : "";
  const missionCard = m
    ? `<div class="card"><h3>Mission <span class="chip">${esc(m.phase)}</span></h3>
        <dl class="kv"><dt>id</dt><dd>${esc(m.mission_id)}</dd><dt>Drone</dt><dd>${esc(m.drone_id)}</dd><dt>pattern</dt><dd>${esc(m.plan.pattern)}</dd>
        <dt>waypoints</dt><dd>${m.next_waypoint} / ${n}</dd><dt>evidence</dt><dd>${m.evidence.length} frames</dd>
        <dt>estimate</dt><dd>${m.plan.est_duration_s.toFixed(0)} s · ${m.plan.est_battery_pct.toFixed(1)}% battery</dd>${m.error ? `<dt>error</dt><dd style="color:var(--danger)">${esc(m.error)}</dd>` : ""}</dl>${progress}</div>`
    : `<div class="card"><h3>Mission</h3><div class="placeholder">${droneId ? `${esc(droneId)} has no active Mission. Dispatch one from a Detection, or use Fly square.` : "Select a Drone."}</div></div>`;
  const specCard = spec
    ? `<div class="card"><h3>Triage Agent · MissionSpec</h3><dl class="kv"><dt>objective</dt><dd>${esc(spec.objective)}</dd><dt>ceiling</dt><dd>${spec.max_altitude_m} m</dd><dt>standoff</dt><dd>${spec.standoff_m} m</dd></dl><p class="placeholder" style="color:var(--fg-1)">${esc(spec.rationale)}</p></div>`
    : `<div class="card"><h3>Triage Agent · MissionSpec</h3><div class="placeholder">The Triage Agent's intent and rationale appear here when a Detection is dispatched. The LLM states what to look at and from where; it never computes waypoints.</div></div>`;
  const valCard = validation
    ? `<div class="card"><h3>Safety Validator</h3><div class="verdict ${validation.verdict}">${validation.verdict === "accept" ? "✓ ACCEPTED" : "✕ REJECTED"}</div>${validation.violations.map((v) => `<div class="rule"><b>${esc(v.rule)}</b> · ${esc(v.detail)}</div>`).join("") || `<div class="placeholder">No rules violated: geofence, no-fly, altitude, range, standoff.</div>`}</div>`
    : `<div class="card"><h3>Safety Validator</h3><div class="verdict pending">— AWAITING PLAN</div><div class="placeholder">Every FlightPlan is checked against the geofence, no-fly zones, altitude limits and battery range before a motor spins. Rejections name the rule and are fed back to the agent.</div></div>`;
  el.innerHTML = missionCard + specCard + valCard;
}

export type LogLevel = "info" | "good" | "warn" | "bad";
export class LogFeed {
  private rows: { t: string; msg: string; level: LogLevel }[] = [];
  private el: HTMLElement;
  private max: number;
  constructor(el: HTMLElement, max = 300) { this.el = el; this.max = max; }
  push(msg: string, level: LogLevel = "info"): void {
    this.rows.unshift({ t: new Date().toLocaleTimeString(), msg, level });
    if (this.rows.length > this.max) this.rows.length = this.max;
    this.el.innerHTML = this.rows.map((r) => `<div class="row"><span class="t">${r.t}</span><span class="${r.level}">${esc(r.msg)}</span></div>`).join("");
  }
}
