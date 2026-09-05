// Hub client: REST helpers, the live event feed, and the Renderer-role connection.
export type DroneState = {
  drone_id: string; lat: number; lon: number; alt: number; heading_deg: number;
  velocity_ned: { vx: number; vy: number; vz: number }; battery_pct: number; status: string;
  mission_id: string | null; gimbal_pitch_deg: number; armed: boolean; mode: string; message: string; ts: string;
};
export type SceneProp = { id: string; kind: string; x: number; y: number; yaw_deg: number };
export type SceneState = { props: SceneProp[]; open_fences: string[]; scenario_ids: string[] };

const params = new URLSearchParams(location.search);
export const HUB_HTTP = params.get("hub") ?? (location.port === "5173" ? `http://${location.hostname}:8000` : location.origin);
export const HUB_WS = HUB_HTTP.replace(/^http/, "ws");

export async function api<T = unknown>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const r = await fetch(`${HUB_HTTP}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

/** Live feed: every state change the Hub publishes. Reconnects forever. */
export function liveFeed(onEvent: (ev: any) => void, onStatus: (ok: boolean) => void): void {
  const connect = () => {
    const ws = new WebSocket(`${HUB_WS}/ws/live`);
    ws.onopen = () => onStatus(true);
    ws.onmessage = (m) => onEvent(JSON.parse(m.data));
    ws.onclose = () => { onStatus(false); setTimeout(connect, 1000); };
    ws.onerror = () => ws.close();
  };
  connect();
}

/** Renderer role: the Hub asks us to render Drone cameras and overhead images; we answer with frames. */
export class RendererLink {
  private ws: WebSocket | null = null;
  private id: string;
  private sim: "browser" | "headless";
  private onCommand: (cmd: any, reply: (msg: unknown) => void) => void;
  private onStatus: (ok: boolean) => void;
  constructor(id: string, sim: "browser" | "headless", onCommand: (cmd: any, reply: (msg: unknown) => void) => void, onStatus: (ok: boolean) => void) {
    this.id = id; this.sim = sim; this.onCommand = onCommand; this.onStatus = onStatus;
  }
  connect(): void {
    const ws = new WebSocket(`${HUB_WS}/ws/controller`);
    this.ws = ws;
    ws.onopen = () => { ws.send(JSON.stringify({ type: "hello", role: "renderer", id: this.id, sim: this.sim })); this.onStatus(true); };
    ws.onmessage = (m) => this.onCommand(JSON.parse(m.data), (msg) => ws.send(JSON.stringify(msg)));
    ws.onclose = () => { this.onStatus(false); setTimeout(() => this.connect(), 1000); };
    ws.onerror = () => ws.close();
  }
  send(msg: unknown): void { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }
}
