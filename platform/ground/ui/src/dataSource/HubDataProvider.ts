/* ============================================================================
 * HubDataProvider — the dashboard's DataSource against the ARGUS Hub.
 * ----------------------------------------------------------------------------
 * One WebSocket to `/ws/live` for every state change, REST for commands.
 * The Hub is multi-vehicle; this dashboard's store is single-vehicle, so the
 * provider follows one Drone (`setVehicle`) and publishes the rest as a fleet
 * list (`onFleet`). Sensor fields the Hub does not report are left at their
 * unknown/zero values, never invented.
 *
 * Mapping summary
 *   drone_state            -> Telemetry (selected vehicle only) + fleet list
 *   message/clamp/manual   -> StatusText
 *   detection              -> AnomalyMessage
 *   autonomy.plan_proposed -> MissionPlanMessage   (requestId = mission#attempt)
 *   autonomy.plan_rejected -> VerificationMessage 'rejected'
 *   autonomy.plan_approved -> VerificationMessage 'pass'
 *   triage + incident      -> IncidentReportMessage
 *   sendCommand            -> Hub REST (see COMMANDS below)
 *   setManualInput         -> POST /drones/{id}/manual/command at 10 Hz
 * ========================================================================== */
import type {
  Anomaly,
  AnomalyMessage,
  Command,
  CommandAck,
  ConnectionConfig,
  ConnectionState,
  IncidentReportMessage,
  ManualInput,
  MissionPlan,
  MissionPlanMessage,
  Mode,
  PlanTool,
  StatusText,
  Telemetry,
  TrackingStatus,
  Unsubscribe,
  Verification,
  VerificationMessage,
} from '@/contract';
import { DEFAULTS, MODES } from '@/contract';
import type { MissionDataSource } from './types';
import { hubHttpBase, hubWsBase } from './hubConfig';

/* ---- Hub wire shapes (contracts/models.py, hub/server.py) ------------------ */
interface HubDroneState {
  drone_id: string;
  lat: number;
  lon: number;
  alt: number;
  heading_deg: number;
  velocity_ned: { vx: number; vy: number; vz: number };
  battery_pct: number;
  status: 'idle' | 'on_mission' | 'manual_control' | 'returning' | 'offline';
  mission_id: string | null;
  gimbal_pitch_deg: number;
  armed: boolean;
  mode: string;
  message: string;
  ts: string;
}
interface HubDetection {
  id: string;
  polygon: { lat: number; lon: number }[];
  confidence: number;
  change_type: string;
  before_ref: string;
  after_ref: string;
  area_m2: number | null;
  metadata: Record<string, string>;
}
interface HubMission {
  mission_id: string;
  drone_id: string;
  phase: string;
  next_waypoint: number;
  error: string | null;
}
interface AgentWaypoint { lat: number; lon: number; alt_m: number; action: string; duration_s?: number; purpose?: string }
interface AgentPlan { anomaly_id: string; priority: string; reasoning: string; waypoints: AgentWaypoint[] }

/** One row of the fleet list published to the vehicle selector. */
export interface FleetEntry {
  vehicleId: string;
  status: HubDroneState['status'];
  batteryPct: number;
  altM: number;
  mode: string;
}

type Listeners<T> = Set<(v: T) => void>;
const emit = <T,>(ls: Listeners<T>, v: T): void => ls.forEach((cb) => cb(v));
const sub = <T,>(ls: Listeners<T>) => (cb: (v: T) => void): Unsubscribe => { ls.add(cb); return () => ls.delete(cb); };

const KNOWN_MODES = new Set<string>(MODES);

export class HubDataProvider implements MissionDataSource {
  private http = 'http://127.0.0.1:8000';
  private ws: WebSocket | null = null;
  private wsUrl = '';
  private wantConnection = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connState: ConnectionState = 'disconnected';

  private vehicleId = 'drone-1';
  private vehiclePinned = false;
  private states = new Map<string, HubDroneState>();
  private lastMessage = new Map<string, string>();
  private missions = new Map<string, HubMission>();
  private home: { lat: number; lon: number } | null = null;

  /* agent plan correlation: mission id -> last proposed attempt */
  private attempts = new Map<string, number>();
  private pendingPlanId: string | null = null;
  private triage = new Map<string, string>();

  /* manual control */
  private manualActive = false;
  private manualInput: ManualInput = { throttle: 0, yaw: 0, pitch: 0, roll: 0 };
  private manualTimer: ReturnType<typeof setInterval> | null = null;
  private lastClampRule: string | null = null;

  private lConn: Listeners<ConnectionState> = new Set();
  private lTel: Listeners<Telemetry> = new Set();
  private lTrack: Listeners<TrackingStatus> = new Set();
  private lStatus: Listeners<StatusText> = new Set();
  private lAck: Listeners<CommandAck> = new Set();
  private lAnomaly: Listeners<AnomalyMessage> = new Set();
  private lPlan: Listeners<MissionPlanMessage> = new Set();
  private lVerify: Listeners<VerificationMessage> = new Set();
  private lReport: Listeners<IncidentReportMessage> = new Set();
  private lFleet: Listeners<FleetEntry[]> = new Set();

  /* ---- DataSource ------------------------------------------------------------ */
  async connect(config: ConnectionConfig): Promise<void> {
    this.http = hubHttpBase(config);
    this.wsUrl = `${hubWsBase(config)}/ws/live`;
    this.wantConnection = true;
    this.setConn('connecting');
    this.openSocket();
  }

  disconnect(): void {
    this.wantConnection = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.stopManualLoop();
    this.ws?.close();
    this.ws = null;
    this.setConn('disconnected');
  }

  onConnectionChange = sub(this.lConn);
  onTelemetry = sub(this.lTel);
  onTracking = sub(this.lTrack);
  onStatusText = sub(this.lStatus);
  onAck = sub(this.lAck);
  onAnomaly = sub(this.lAnomaly);
  onMissionPlan = sub(this.lPlan);
  onVerification = sub(this.lVerify);
  onIncidentReport = sub(this.lReport);

  /* ---- Fleet extension (beyond the frozen contract) ------------------------- */
  onFleet = sub(this.lFleet);

  /** Follow another Drone: telemetry, video and commands switch to it. */
  setVehicle(id: string): void {
    this.vehicleId = id;
    this.vehiclePinned = true;
    const s = this.states.get(id);
    if (s) emit(this.lTel, this.toTelemetry(s));
    this.publishFleet();
  }

  getVehicle(): string { return this.vehicleId; }

  getVideoUrl(): string {
    return `${this.http}/drones/${this.vehicleId}/mjpeg`;
  }

  /* ---- commands ---------------------------------------------------------------- */
  async sendCommand(cmd: Command): Promise<CommandAck> {
    const id = cmd.vehicleId || this.vehicleId;
    const ack = (success: boolean, message: string): CommandAck => {
      const a: CommandAck = { type: 'ack', ts: Date.now(), vehicleId: id, command: cmd.command, success, message };
      emit(this.lAck, a);
      return a;
    };
    try {
      switch (cmd.command) {
        case 'rtl':
          return ack(...(await this.droneCommand(id, { type: 'return_home' })));
        case 'land':
          return ack(...(await this.droneCommand(id, { type: 'return_home' })), );
        case 'disarm':
        case 'emergencyStop': {
          // The Hub has no disarm/kill; the safest available action is a return to the pad.
          this.stopManualLoop();
          const [ok, msg] = await this.droneCommand(id, { type: 'return_home' });
          return ack(ok, `${cmd.command}: ARGUS Hub has no kill switch; Return home sent instead. ${msg}`.trim());
        }
        case 'takeoff': {
          const s = this.states.get(id);
          if (!s) return ack(false, `no telemetry for ${id}`);
          const alt = cmd.params?.altitude ?? 10;
          return ack(...(await this.droneCommand(id, { type: 'goto', lat: s.lat, lon: s.lon, alt })));
        }
        case 'engageManual': {
          const r = await this.post(`/drones/${id}/manual/start`, {});
          if (!r.ok) return ack(false, r.text);
          this.manualActive = true;
          this.startManualLoop();
          return ack(true, r.json?.paused_mission ? `Manual Control taken; Mission ${r.json.paused_mission} paused` : 'Manual Control taken');
        }
        case 'disengageManual': {
          this.stopManualLoop();
          const r = await this.post(`/drones/${id}/manual/end`, { action: 'hover' });
          return ack(r.ok, r.ok ? 'Manual Control released; holding position' : r.text);
        }
        case 'abortPlan': {
          const m = this.activeMissionFor(id);
          if (!m) return ack(false, `no active Mission on ${id}`);
          const r = await this.post(`/missions/${m.mission_id}/abort`, {});
          return ack(r.ok, r.ok ? `Mission ${m.mission_id} aborted; returning home` : r.text);
        }
        case 'executePlan':
          return ack(true, 'ARGUS dispatches approved plans automatically; the Drone is already flying it');
        case 'continueMission': {
          const m = this.activeMissionFor(id);
          if (!m) return ack(false, `no paused Mission on ${id}`);
          const r = await this.post(`/missions/${m.mission_id}/resume`, {});
          return ack(r.ok, r.ok ? `Mission ${m.mission_id} resumed` : r.text);
        }
        case 'arm':
          return ack(true, 'ARGUS arms the autopilot itself when a Mission or Manual Control starts');
        default:
          return ack(false, `${cmd.command} is not supported by the ARGUS Hub`);
      }
    } catch (err) {
      return ack(false, (err as Error).message);
    }
  }

  setManualInput(input: ManualInput): void {
    this.manualInput = input;
  }

  /* ---- internals: socket --------------------------------------------------------- */
  private setConn(s: ConnectionState): void {
    if (s === this.connState) return;
    this.connState = s;
    emit(this.lConn, s);
  }

  private openSocket(): void {
    if (!this.wantConnection) return;
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.setConn('connected');
      void this.refreshMissions();
      void this.loadHome();
    };
    ws.onmessage = (ev) => {
      try { this.handle(JSON.parse(ev.data as string)); } catch (err) { console.warn('[hub] bad event', err); }
    };
    ws.onclose = () => {
      this.ws = null;
      if (!this.wantConnection) return;
      this.setConn('connecting');
      this.reconnectTimer = setTimeout(() => this.openSocket(), 1000);
    };
    ws.onerror = () => { this.setConn('error'); ws.close(); };
  }

  private handle(ev: Record<string, unknown>): void {
    const now = Date.now();
    switch (ev.type) {
      case 'snapshot': {
        for (const s of (ev.drones as HubDroneState[]) ?? []) this.ingestState(s);
        for (const m of (ev.missions as HubMission[]) ?? []) this.missions.set(m.mission_id, m);
        break;
      }
      case 'drone_state':
        this.ingestState(ev.state as HubDroneState);
        break;
      case 'mission': {
        const m = ev.mission as HubMission;
        this.missions.set(m.mission_id, m);
        if (m.drone_id === this.vehicleId) {
          const phase = m.phase;
          if (phase === 'flying' && m.next_waypoint === 0) this.status(m.drone_id, 'info', `Mission ${m.mission_id} started`);
          else if (phase === 'complete') this.status(m.drone_id, 'info', `Mission ${m.mission_id} complete, returning home`);
          else if (phase === 'failed') this.status(m.drone_id, 'error', `Mission ${m.mission_id} failed: ${m.error ?? 'unknown'}`);
          else if (phase === 'aborted') this.status(m.drone_id, 'warning', `Mission ${m.mission_id} aborted`);
          else if (phase === 'paused') this.status(m.drone_id, 'warning', `Mission ${m.mission_id} paused for Manual Control`);
        }
        break;
      }
      case 'clamp': {
        const rule = String(ev.rule);
        if (rule !== this.lastClampRule) {
          this.lastClampRule = rule;
          this.status(String(ev.drone_id), 'warning', `Safety Validator clamped manual input: ${rule}`);
        }
        break;
      }
      case 'manual':
        this.status(String(ev.drone_id), 'warning', ev.active ? 'Manual Control taken by Operator' : 'Manual Control released');
        break;
      case 'ack':
        if (ev.ok === false) this.status(String(ev.drone_id), 'error', `Drone refused command: ${String(ev.detail ?? '')}`);
        break;
      case 'detection': {
        const d = (ev.detection ?? ev) as HubDetection;
        emit(this.lAnomaly, { type: 'anomaly', ts: now, vehicleId: this.vehicleId, anomaly: this.toAnomaly(d) });
        this.status(this.vehicleId, 'warning', `Detection ${d.id}: ${d.change_type} ~${Math.round(d.area_m2 ?? 0)} m² conf ${d.confidence}`);
        break;
      }
      case 'autonomy':
        this.handleAgentEvent(ev.event as { type: string; mission_id: string | null; payload: Record<string, unknown> });
        break;
      case 'triage': {
        const mid = String(ev.mission_id);
        this.triage.set(mid, String(ev.decision));
        this.status(this.vehicleId, 'info', `Triage ${String(ev.decision).toUpperCase()} (${ev.confidence}): ${String(ev.rationale ?? '')}`);
        break;
      }
      case 'incident': {
        const mid = String(ev.mission_id);
        const decision = this.triage.get(mid) ?? 'log_only';
        const verdict = decision === 'escalate' ? 'escalate' : decision === 'false_alarm' ? 'false_alarm' : 'log';
        const md = `# ${String(ev.title)}\n\n**Severity:** ${String(ev.severity)}\n\n**Recommended action:** ${String(ev.recommended_action)}\n\n${String(ev.body_markdown)}`;
        emit(this.lReport, { type: 'incidentReport', ts: now, vehicleId: this.vehicleId, report: { missionId: mid, verdict, markdown: md } });
        break;
      }
      case 'dispatch_outcome':
        this.status(this.vehicleId, ev.flown ? 'info' : 'warning',
          `Dispatch ${String(ev.detection_id)}: ${ev.flown ? `flown by ${String(ev.drone_id)}` : 'NOT FLOWN'} after ${String(ev.attempts)} attempt(s)`);
        void this.refreshMissions();
        break;
      default:
        break; // frame, scene, overhead, mission_spec, validation: not needed here
    }
  }

  private handleAgentEvent(e: { type: string; mission_id: string | null; payload: Record<string, unknown> }): void {
    const now = Date.now();
    const mid = e.mission_id ?? 'mission';
    const p = e.payload;
    if (e.type === 'plan_proposed') {
      const attempt = Number(p.attempt ?? (this.attempts.get(mid) ?? 0) + 1);
      this.attempts.set(mid, attempt);
      const requestId = `${mid}#${attempt}`;
      this.pendingPlanId = requestId;
      emit(this.lPlan, { type: 'missionPlan', ts: now, vehicleId: this.vehicleId, plan: this.toPlan(requestId, p.plan as AgentPlan) });
    } else if (e.type === 'plan_rejected' || e.type === 'plan_approved' || e.type === 'plan_abandoned') {
      const attempt = Number(p.attempt ?? this.attempts.get(mid) ?? 1);
      const requestId = `${mid}#${attempt}`;
      const violations = ((p.violations ?? p.last_violations ?? []) as { code: string; message: string }[]);
      const verification: Verification = e.type === 'plan_approved'
        ? { requestId, verdict: 'pass', checks: [{ name: 'verifier', ok: true, reason: `${String(p.checks_passed ?? '')} checks passed; est ${String(p.flight_time_s ?? '?')} s, ${String(p.battery_needed_pct ?? '?')}% battery` }] }
        : { requestId, verdict: 'rejected', checks: violations.map((v) => ({ name: v.code, ok: false, reason: v.message })) };
      emit(this.lVerify, { type: 'verification', ts: now, vehicleId: this.vehicleId, verification });
      if (e.type === 'plan_abandoned') this.status(this.vehicleId, 'error', `Plan abandoned after ${String(p.attempts)} attempts; escalated to the Operator`);
    } else if (e.type === 'waypoint_reached') {
      this.status(this.vehicleId, 'info', `Waypoint ${String(p.index)} reached at ${String(p.alt_m)} m (${String(p.action)})`);
    } else if (e.type === 'observation') {
      this.status(this.vehicleId, 'info', `Observation: ${String(p.caption ?? '')}`);
    }
  }

  /* ---- internals: state ---------------------------------------------------------- */
  private ingestState(s: HubDroneState): void {
    const first = !this.states.has(s.drone_id);
    this.states.set(s.drone_id, s);
    if (!this.vehiclePinned && (first || !this.states.has(this.vehicleId))) {
      // follow the first Drone that reports, until the operator picks one
      if (!this.states.has(this.vehicleId)) this.vehicleId = s.drone_id;
    }
    if (s.message && s.message !== this.lastMessage.get(s.drone_id)) {
      this.lastMessage.set(s.drone_id, s.message);
      const refused = s.message.startsWith('REFUSED');
      if (s.drone_id === this.vehicleId || refused) {
        this.status(s.drone_id, refused ? 'critical' : 'info', `Autopilot: ${s.message}`);
      }
    }
    if (s.drone_id === this.vehicleId) emit(this.lTel, this.toTelemetry(s));
    if (first || s.drone_id === this.vehicleId) this.publishFleet();
    else this.publishFleetThrottled();
  }

  private fleetTimer: ReturnType<typeof setTimeout> | null = null;
  private publishFleetThrottled(): void {
    if (this.fleetTimer) return;
    this.fleetTimer = setTimeout(() => { this.fleetTimer = null; this.publishFleet(); }, 500);
  }
  private publishFleet(): void {
    const rows: FleetEntry[] = [...this.states.values()]
      .sort((a, b) => a.drone_id.localeCompare(b.drone_id))
      .map((s) => ({ vehicleId: s.drone_id, status: s.status, batteryPct: s.battery_pct, altM: s.alt, mode: s.mode }));
    emit(this.lFleet, rows);
  }

  private status(vehicleId: string, severity: StatusText['severity'], text: string): void {
    emit(this.lStatus, { type: 'statusText', ts: Date.now(), vehicleId, severity, text });
  }

  private activeMissionFor(droneId: string): HubMission | null {
    for (const m of this.missions.values()) {
      if (m.drone_id === droneId && ['pending', 'flying', 'paused', 'returning'].includes(m.phase)) return m;
    }
    return null;
  }

  private async refreshMissions(): Promise<void> {
    const r = await this.get('/missions');
    if (r.ok && Array.isArray(r.json)) for (const m of r.json as HubMission[]) this.missions.set(m.mission_id, m);
  }

  private async loadHome(): Promise<void> {
    const r = await this.get('/console/site.json');
    const site = r.json as { fleet?: { drone_id: string; lat: number; lon: number }[]; anchor?: { lat: number; lon: number } } | undefined;
    if (!r.ok || !site) return;
    const pad = site.fleet?.[0];
    this.home = pad ? { lat: pad.lat, lon: pad.lon } : site.anchor ?? null;
  }

  /* ---- internals: manual loop ------------------------------------------------------ */
  private startManualLoop(): void {
    if (this.manualTimer) return;
    this.manualTimer = setInterval(() => void this.pushManual(), 100);
  }
  private stopManualLoop(): void {
    this.manualActive = false;
    if (this.manualTimer) { clearInterval(this.manualTimer); this.manualTimer = null; }
    this.lastClampRule = null;
  }
  private async pushManual(): Promise<void> {
    if (!this.manualActive) return;
    const s = this.states.get(this.vehicleId);
    if (!s) return;
    const { throttle, yaw, pitch, roll } = this.manualInput;
    const h = (s.heading_deg * Math.PI) / 180;
    const fwd = pitch * DEFAULTS.maxSpeed;
    const right = roll * DEFAULTS.maxSpeed;
    const vx = fwd * Math.cos(h) - right * Math.sin(h);   // north
    const vy = fwd * Math.sin(h) + right * Math.cos(h);   // east
    const r = await this.post(`/drones/${this.vehicleId}/manual/command`, {
      vx, vy, vz: -throttle * DEFAULTS.maxClimbRate, yaw_rate_dps: yaw * DEFAULTS.maxYawRate,
    });
    if (!r.ok && r.status === 409) { this.stopManualLoop(); this.status(this.vehicleId, 'warning', 'Manual Control session ended by the Hub'); }
  }

  /* ---- internals: REST ---------------------------------------------------------------- */
  private async droneCommand(id: string, body: Record<string, unknown>): Promise<[boolean, string]> {
    const r = await this.post(`/drones/${id}/command`, body);
    if (!r.ok) return [false, r.text];
    const ack = r.json as { ok: boolean; detail: string };
    return [ack.ok, ack.detail || `${String(body.type)} accepted`];
  }

  private async post(path: string, body: unknown): Promise<{ ok: boolean; status: number; text: string; json?: any }> {
    const res = await fetch(`${this.http}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { ok: res.ok, status: res.status, text: res.ok ? text : `${res.status}: ${((json as { detail?: string })?.detail) ?? text}`, json };
  }

  private async get(path: string): Promise<{ ok: boolean; json?: unknown }> {
    try {
      const res = await fetch(`${this.http}${path}`);
      return { ok: res.ok, json: res.ok ? await res.json() : undefined };
    } catch { return { ok: false }; }
  }

  /* ---- internals: mapping ---------------------------------------------------------------- */
  private toTelemetry(s: HubDroneState): Telemetry {
    const mode: Mode = KNOWN_MODES.has(s.mode) ? (s.mode as Mode) : 'GUIDED';
    const gs = Math.hypot(s.velocity_ned.vx, s.velocity_ned.vy);
    const controlSource = s.status === 'manual_control' ? 'manual' : s.status === 'on_mission' ? 'planner' : 'auto';
    const refused = s.message.startsWith('REFUSED');
    const home = this.home ?? { lat: s.lat, lon: s.lon };
    const distance = haversineM(home.lat, home.lon, s.lat, s.lon);
    const battery = {
      soc_pct: s.battery_pct, voltage_v: 0, current_a: 0, cell_delta_v: 0, temp_c: 0, remaining_s: 0,
      charge_state: 'unknown' as const, voltage: 0, current: 0, remaining: s.battery_pct,
    };
    return {
      type: 'telemetry', ts: Date.parse(s.ts) || Date.now(), vehicleId: s.drone_id,
      armed: s.armed, mode, controlSource, navSource: 'gps',
      // The Hub does not relay GPS quality: reported as unknown (0), not as healthy.
      gpsHealth: { fix: 0, sats: 0, hdop: 0 },
      failsafeState: refused ? 'refuse' : s.status === 'returning' ? 'rtl' : 'none',
      failsafeReason: refused ? s.message : '',
      attitude: { roll: 0, pitch: 0, yaw: s.heading_deg },
      position: { lat: s.lat, lon: s.lon, relAlt: s.alt, absAlt: s.alt },
      velocity: { groundspeed: gs, verticalSpeed: -s.velocity_ned.vz },
      heading: s.heading_deg, battery,
      gps: { fixType: 0, satellites: 0, hdop: 0 },
      sortie: null,
      home: { lat: home.lat, lon: home.lon, distance },
      link: { rssi: 0, latencyMs: Math.max(0, Date.now() - (Date.parse(s.ts) || Date.now())) },
    };
  }

  private toAnomaly(d: HubDetection): Anomaly {
    const n = d.polygon.length || 1;
    const lat = d.polygon.reduce((a, p) => a + p.lat, 0) / n;
    const lon = d.polygon.reduce((a, p) => a + p.lon, 0) / n;
    return {
      id: d.id, lat, lon, type: d.change_type, confidence: d.confidence,
      thumbnail: `${this.http}/evidence/${d.after_ref}`,
      // the contract's closed source list has no "overhead render"; sentinel2 is the wide-area slot
      source: 'sentinel2',
    };
  }

  private toPlan(requestId: string, plan: AgentPlan): MissionPlan {
    const tools: PlanTool[] = [];
    for (const w of plan.waypoints ?? []) {
      tools.push({ tool: 'goto_gps', lat: w.lat, lon: w.lon, alt: w.alt_m, alt_m: w.alt_m, profile: 'inspect' });
      if (w.action === 'hover') tools.push({ tool: 'hold', durationS: w.duration_s ?? 10, duration_s: w.duration_s ?? 10 });
    }
    tools.push({ tool: 'rtl' });
    return { requestId, anomalyId: plan.anomaly_id, tools, profile: 'inspect', rationale: plan.reasoning ?? '' };
  }
}

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
