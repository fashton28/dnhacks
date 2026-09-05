/* ============================================================================
 * Drone Safety Platform — LiveDataProvider
 * ----------------------------------------------------------------------------
 * A `DataSource` implementation that talks to the companion over a WebSocket at
 * ws://${host}:${controlPort}  (the SITL alias 'sitl' resolves to 127.0.0.1).
 *
 * - connect(): opens the socket, emits connecting → connected, and auto-reconnects
 *   with exponential backoff. Emits 'error'/'disconnected' as appropriate.
 * - inbound messages: JSON.parse, switch on .type → dispatch to subscribers.
 * - sendCommand(): sends {type:'command',command,params} and awaits the next
 *   matching ack (by command name) with a ~4s timeout; on timeout it resolves a
 *   synthetic failure ack so callers never hang.
 * - setManualInput(): fire-and-forget {type:'manualInput',…,ts}.
 * ========================================================================== */
import type {
  AnomalyMessage,
  CommandAck,
  Command,
  ConnectionConfig,
  ConnectionState,
  IncidentReportMessage,
  InboundMessage,
  ManualInput,
  MissionPlanMessage,
  StatusText,
  Telemetry,
  TrackingStatus,
  Unsubscribe,
  VerificationMessage,
} from '@/contract';
import { DEFAULT_VEHICLE_ID } from '@/contract';
import type { MissionDataSource } from './types';

const ACK_TIMEOUT_MS = 4000;
const MAX_BACKOFF_MS = 15000;
const BASE_BACKOFF_MS = 500;

interface PendingAck {
  command: CommandAck['command'];
  resolve: (ack: CommandAck) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Callbacks {
  tel: Array<(t: Telemetry) => void>;
  trk: Array<(t: TrackingStatus) => void>;
  txt: Array<(s: StatusText) => void>;
  ack: Array<(a: CommandAck) => void>;
  conn: Array<(s: ConnectionState) => void>;
  anom: Array<(m: AnomalyMessage) => void>;
  plan: Array<(m: MissionPlanMessage) => void>;
  verf: Array<(m: VerificationMessage) => void>;
  rept: Array<(m: IncidentReportMessage) => void>;
}

export class LiveDataProvider implements MissionDataSource {
  private cbs: Callbacks = {
    tel: [],
    trk: [],
    txt: [],
    ack: [],
    conn: [],
    anom: [],
    plan: [],
    verf: [],
    rept: [],
  };

  private ws: WebSocket | null = null;
  private config: ConnectionConfig | null = null;
  private connState: ConnectionState = 'disconnected';

  private pending: PendingAck[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private latencyMs = 0;

  /* ---- DataSource: lifecycle ------------------------------------------- */
  connect(config: ConnectionConfig): Promise<void> {
    this.config = config;
    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    this.open();
    return Promise.resolve();
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.failAllPending();
    this.setConnState('disconnected');
  }

  private url(): string {
    const cfg = this.config;
    if (!cfg) return 'ws://127.0.0.1:8765';
    const host = cfg.host === 'sitl' ? '127.0.0.1' : cfg.host;
    return `ws://${host}:${cfg.controlPort}`;
  }

  private open(): void {
    this.setConnState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url());
    } catch {
      this.setConnState('error');
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = (): void => {
      this.reconnectAttempts = 0;
      this.setConnState('connected');
    };

    ws.onmessage = (ev: MessageEvent): void => {
      this.handleMessage(ev.data);
    };

    ws.onerror = (): void => {
      this.setConnState('error');
    };

    ws.onclose = (): void => {
      if (this.ws === ws) this.ws = null;
      this.failAllPending();
      this.setConnState('disconnected');
      if (!this.intentionalClose) this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(
      MAX_BACKOFF_MS,
      BASE_BACKOFF_MS * 2 ** this.reconnectAttempts,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.intentionalClose) this.open();
    }, delay);
  }

  /* ---- inbound dispatch ------------------------------------------------ */
  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let msg: InboundMessage;
    try {
      msg = JSON.parse(raw) as InboundMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'telemetry':
        if (typeof msg.link?.latencyMs === 'number') this.latencyMs = msg.link.latencyMs;
        this.cbs.tel.forEach((f) => f(msg));
        break;
      case 'tracking':
        this.cbs.trk.forEach((f) => f(msg));
        break;
      case 'statusText':
        this.cbs.txt.forEach((f) => f(msg));
        break;
      case 'ack':
        this.resolvePending(msg);
        this.cbs.ack.forEach((f) => f(msg));
        break;
      case 'anomaly':
        this.cbs.anom.forEach((f) => f(msg));
        break;
      case 'missionPlan':
        this.cbs.plan.forEach((f) => f(msg));
        break;
      case 'verification':
        this.cbs.verf.forEach((f) => f(msg));
        break;
      case 'incidentReport':
        this.cbs.rept.forEach((f) => f(msg));
        break;
      default:
        break;
    }
  }

  private resolvePending(ack: CommandAck): void {
    const idx = this.pending.findIndex((p) => p.command === ack.command);
    if (idx === -1) return;
    const [p] = this.pending.splice(idx, 1);
    clearTimeout(p.timer);
    p.resolve(ack);
  }

  private failAllPending(): void {
    const pend = this.pending;
    this.pending = [];
    pend.forEach((p) => {
      clearTimeout(p.timer);
      p.resolve({
        type: 'ack',
        ts: Date.now(),
        vehicleId: DEFAULT_VEHICLE_ID,
        command: p.command,
        success: false,
        message: 'Link closed before ack',
      });
    });
  }

  /* ---- subscription API ------------------------------------------------ */
  onTelemetry(cb: (t: Telemetry) => void): Unsubscribe {
    this.cbs.tel.push(cb);
    return () => this._off('tel', cb);
  }
  onTracking(cb: (t: TrackingStatus) => void): Unsubscribe {
    this.cbs.trk.push(cb);
    return () => this._off('trk', cb);
  }
  onStatusText(cb: (s: StatusText) => void): Unsubscribe {
    this.cbs.txt.push(cb);
    return () => this._off('txt', cb);
  }
  onAck(cb: (a: CommandAck) => void): Unsubscribe {
    this.cbs.ack.push(cb);
    return () => this._off('ack', cb);
  }
  onConnectionChange(cb: (s: ConnectionState) => void): Unsubscribe {
    this.cbs.conn.push(cb);
    cb(this.connState);
    return () => this._off('conn', cb);
  }

  /* mission channels (MissionDataSource) */
  onAnomaly(cb: (m: AnomalyMessage) => void): Unsubscribe {
    this.cbs.anom.push(cb);
    return () => this._off('anom', cb);
  }
  onMissionPlan(cb: (m: MissionPlanMessage) => void): Unsubscribe {
    this.cbs.plan.push(cb);
    return () => this._off('plan', cb);
  }
  onVerification(cb: (m: VerificationMessage) => void): Unsubscribe {
    this.cbs.verf.push(cb);
    return () => this._off('verf', cb);
  }
  onIncidentReport(cb: (m: IncidentReportMessage) => void): Unsubscribe {
    this.cbs.rept.push(cb);
    return () => this._off('rept', cb);
  }

  private _off<K extends keyof Callbacks>(k: K, cb: unknown): void {
    const list = this.cbs[k] as Array<unknown>;
    this.cbs[k] = list.filter((f) => f !== cb) as Callbacks[K];
  }

  private setConnState(s: ConnectionState): void {
    if (this.connState === s) return;
    this.connState = s;
    this.cbs.conn.forEach((f) => f(s));
  }

  /* ---- outbound -------------------------------------------------------- */
  sendCommand(cmd: Command): Promise<CommandAck> {
    return new Promise<CommandAck>((resolve) => {
      const failure: CommandAck = {
        type: 'ack',
        ts: Date.now(),
        vehicleId: cmd.vehicleId,
        command: cmd.command,
        success: false,
        message: 'Command timed out — no ack received',
      };

      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        resolve({ ...failure, message: 'Not connected' });
        return;
      }

      const timer = setTimeout(() => {
        const idx = this.pending.findIndex((p) => p.timer === timer);
        if (idx !== -1) this.pending.splice(idx, 1);
        resolve(failure);
      }, ACK_TIMEOUT_MS);

      this.pending.push({ command: cmd.command, resolve, timer });

      try {
        this.ws.send(JSON.stringify(cmd));
      } catch {
        clearTimeout(timer);
        const idx = this.pending.findIndex((p) => p.timer === timer);
        if (idx !== -1) this.pending.splice(idx, 1);
        resolve({ ...failure, message: 'Failed to send command' });
      }
    });
  }

  setManualInput(input: ManualInput): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(
        JSON.stringify({
          type: 'manualInput',
          vehicleId: DEFAULT_VEHICLE_ID,
          throttle: input.throttle,
          yaw: input.yaw,
          pitch: input.pitch,
          roll: input.roll,
          ts: Date.now(),
        }),
      );
    } catch {
      /* fire-and-forget */
    }
  }

  getVideoUrl(): string {
    return this.config?.videoUrl ?? '';
  }

  /** Last observed link latency (ms), tracked from telemetry heartbeats. */
  getLatencyMs(): number {
    return this.latencyMs;
  }
}
