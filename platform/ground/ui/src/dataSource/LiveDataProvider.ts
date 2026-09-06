/* ============================================================================
 * Drone Safety Platform — LiveDataProvider
 * ----------------------------------------------------------------------------
 * The companion-facing `MissionDataSource`: one WebSocket to
 * ws://<host>:<controlPort> (host 'sitl' is the loopback alias for SITL),
 * speaking the wire contract in src/contract (mirrored by shared/shared.py).
 *
 * What the contract requires and how this file discharges it:
 *   - lifecycle   connect() opens the link and keeps it open with exponential
 *                 backoff until disconnect(). The connection state is reported
 *                 through onConnectionChange, which replays the current state
 *                 to a new subscriber so a late-mounting panel is never blank.
 *   - inbound     every InboundMessage type is routed to its subscriber
 *                 channel by a static table (INBOUND_ROUTE). Frames the UI has
 *                 no channel for are accepted and dropped — never treated as
 *                 protocol errors — and malformed JSON is ignored.
 *   - commands    sendCommand() writes a `command` frame and resolves with the
 *                 vehicle's `ack`. Acks carry NO requestId: they correlate by
 *                 command name, first-in first-out (contract §CommandAck). A
 *                 command that gets no ack inside the timeout, cannot be sent,
 *                 or whose link closes first resolves with a synthetic failure
 *                 ack — and that ack is announced on the ack channel too, so
 *                 the operator sees a command that never reached the vehicle.
 *   - manual      setManualInput() is fire-and-forget: one `manualInput` frame
 *                 per call, never acked, never queued. A frame that cannot be
 *                 sent is dropped because the next one supersedes it.
 *   - cue rails   the ground-side CueBus (SAR, SDR, CCTV, fence loop) runs
 *                 alongside the vehicle link and feeds the same anomaly /
 *                 healthEvent channels the companion does.
 * ========================================================================== */
import type {
  AnomalyMessage,
  CapabilitiesMessage,
  Command,
  CommandAck,
  CommandName,
  ConnectionConfig,
  ConnectionState,
  EnvelopeMessage,
  EscalationMessage,
  FleetMessage,
  HealthEventMessage,
  InboundMessage,
  IncidentReportMessage,
  ManualInput,
  ManualInputMessage,
  MissionPlanMessage,
  ModeMessage,
  ObservationMessage,
  ReadinessMessage,
  RfEventMessage,
  SpectrumMessage,
  StatusText,
  TaskMessage,
  Telemetry,
  TrackingStatus,
  Unsubscribe,
  VerificationMessage,
} from '@/contract';
import { DEFAULT_VEHICLE_ID, DEFAULTS } from '@/contract';
import { getRawSite, getSiteModel } from '@/site';
import { createRendererCueBus } from '@/cues';
import type { CueBus, RailHealth } from '@/cues';
import type { MissionDataSource } from './types';

/* ---- tunables ------------------------------------------------------------ */

/** How long a command waits for its ack before it is reported as failed. */
const ACK_TIMEOUT_MS = 4000;
/** Reconnect backoff: doubles from the base up to the ceiling. */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15000;
/** `WebSocket.OPEN` per WHATWG; a constant so a test socket needs no statics. */
const SOCKET_OPEN = 1;
/** Loopback address the `sitl` host alias resolves to. */
const SITL_HOST = '127.0.0.1';

/* ---- subscriber channels ------------------------------------------------- */

/** Every fan-out channel and the message it carries. Typed as a map so that
 *  `on`/`emit` are checked per channel without one overload per message. */
interface ChannelMap {
  connection: ConnectionState;
  telemetry: Telemetry;
  tracking: TrackingStatus;
  statusText: StatusText;
  ack: CommandAck;
  anomaly: AnomalyMessage;
  missionPlan: MissionPlanMessage;
  verification: VerificationMessage;
  incidentReport: IncidentReportMessage;
  observation: ObservationMessage;
  capabilities: CapabilitiesMessage;
  readiness: ReadinessMessage;
  healthEvent: HealthEventMessage;
  rfEvent: RfEventMessage;
  spectrum: SpectrumMessage;
  fleet: FleetMessage;
  task: TaskMessage;
  envelope: EnvelopeMessage;
  mode: ModeMessage;
  escalation: EscalationMessage;
}
type Channel = keyof ChannelMap;
type Listener<K extends Channel> = (message: ChannelMap[K]) => void;

/** Per-channel listener sets. Emission iterates a snapshot so a listener
 *  that unsubscribes (or subscribes) mid-dispatch cannot skip a peer. */
class Fanout {
  private listeners = new Map<Channel, Set<(message: unknown) => void>>();

  on<K extends Channel>(channel: K, cb: Listener<K>): Unsubscribe {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
    }
    const entry = cb as (message: unknown) => void;
    set.add(entry);
    return () => {
      set?.delete(entry);
    };
  }

  emit<K extends Channel>(channel: K, message: ChannelMap[K]): void {
    const set = this.listeners.get(channel);
    if (!set || set.size === 0) return;
    for (const cb of [...set]) cb(message);
  }
}

/* ---- inbound routing ----------------------------------------------------- */

type InboundType = InboundMessage['type'];
/** Frames that are part of the contract but have no UI channel (yet). */
type UnroutedType = 'planCommandAck' | 'cctvEvent';
type RoutedInbound = Exclude<InboundMessage, { type: UnroutedType }>;

/** Where each inbound frame lands. `null` means accepted and dropped. The
 *  mapped types make forgetting a new InboundMessage member a compile error,
 *  and let `route()` narrow a frame to the channels that exist. */
const INBOUND_ROUTE: { readonly [T in RoutedInbound['type']]: Channel } & { readonly [T in UnroutedType]: null } = {
  telemetry: 'telemetry',
  tracking: 'tracking',
  statusText: 'statusText',
  ack: 'ack',
  anomaly: 'anomaly',
  missionPlan: 'missionPlan',
  verification: 'verification',
  incidentReport: 'incidentReport',
  observation: 'observation',
  capabilities: 'capabilities',
  planCommandAck: null,   // planner-internal; the ground planner correlates these itself
  readiness: 'readiness',
  healthEvent: 'healthEvent',
  rfEvent: 'rfEvent',
  spectrum: 'spectrum',
  fleet: 'fleet',
  task: 'task',
  envelope: 'envelope',
  mode: 'mode',
  escalation: 'escalation',
  cctvEvent: null,        // audit/provenance only; the dispatchable form is an `anomaly`
};

function isRouted(msg: InboundMessage): msg is RoutedInbound {
  return INBOUND_ROUTE[msg.type] !== null;
}

/** Parse one socket payload into a contract message, or null if it is not
 *  text, not JSON, or not a frame type the contract knows. */
function decodeInbound(raw: unknown): InboundMessage | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(INBOUND_ROUTE, type)) return null;
  return parsed as InboundMessage;
}

/* ---- ack correlation ----------------------------------------------------- */

interface AckWaiter {
  command: CommandName;
  resolve: (ack: CommandAck) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A handle on one outstanding command. */
interface AckTicket {
  promise: Promise<CommandAck>;
  /** Resolve the command locally with a synthetic failure (send error, timeout). */
  fail(message: string): void;
}

function syntheticAck(cmd: Pick<Command, 'command' | 'vehicleId'>, message: string): CommandAck {
  return {
    type: 'ack',
    ts: Date.now(),
    vehicleId: cmd.vehicleId,
    command: cmd.command,
    success: false,
    message,
  };
}

/**
 * Outstanding commands awaiting the vehicle's ack. The wire carries no
 * requestId on the ack path, so an ack settles the OLDEST waiter with the
 * same command name. Synthetic (locally generated) acks go through
 * `announce` so subscribers on the ack channel see them like any other.
 */
class AckLedger {
  private waiters: AckWaiter[] = [];

  constructor(private readonly announce: (ack: CommandAck) => void) {}

  enlist(cmd: Command, timeoutMs: number): AckTicket {
    let waiter: AckWaiter | null = null;
    const promise = new Promise<CommandAck>((resolve) => {
      const timer = setTimeout(() => {
        this.fail(waiter, 'Command timed out — no ack received');
      }, timeoutMs);
      waiter = { command: cmd.command, resolve, timer };
      this.waiters.push(waiter);
    });
    return {
      promise,
      fail: (message) => this.fail(waiter, message),
    };
  }

  /** Settle the first waiter for `ack.command`; false if nothing was waiting. */
  settle(ack: CommandAck): boolean {
    const idx = this.waiters.findIndex((w) => w.command === ack.command);
    if (idx === -1) return false;
    const [waiter] = this.waiters.splice(idx, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(ack);
    return true;
  }

  /** Fail every outstanding command with the same reason (link closed). */
  abandon(message: string, vehicleId: string): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      const ack = syntheticAck({ command: waiter.command, vehicleId }, message);
      waiter.resolve(ack);
      this.announce(ack);
    }
  }

  private fail(waiter: AckWaiter | null, message: string): void {
    if (!waiter) return;
    const idx = this.waiters.indexOf(waiter);
    if (idx === -1) return; // already settled
    this.waiters.splice(idx, 1);
    clearTimeout(waiter.timer);
    const ack = syntheticAck({ command: waiter.command, vehicleId: DEFAULT_VEHICLE_ID }, message);
    waiter.resolve(ack);
    this.announce(ack);
  }
}

/* ---- provider ------------------------------------------------------------ */

export interface LiveDataProviderOptions {
  /** Socket constructor; defaults to the platform WebSocket. Tests inject a fake. */
  socketFactory?: (url: string) => WebSocket;
  /** Ack wait, ms (default ACK_TIMEOUT_MS). */
  ackTimeoutMs?: number;
  /** Vehicle id stamped on outbound frames (default DEFAULT_VEHICLE_ID). */
  vehicleId?: string;
  /** Run the ground-side cue rails alongside the link (default true). */
  cueRails?: boolean;
}

const axis = (v: number): number => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);

export class LiveDataProvider implements MissionDataSource {
  readonly kind = 'live' as const;

  private readonly fanout = new Fanout();
  private readonly ledger = new AckLedger((ack) => this.fanout.emit('ack', ack));
  private readonly socketFactory: (url: string) => WebSocket;
  private readonly ackTimeoutMs: number;
  private readonly vehicleId: string;
  private readonly cueRailsEnabled: boolean;

  private config: ConnectionConfig | null = null;
  private state: ConnectionState = 'disconnected';
  private latencyMs = 0;

  /* socket session */
  private socket: WebSocket | null = null;
  /** Bumped on every open/drop so callbacks from a superseded socket are ignored. */
  private epoch = 0;
  private desired: 'online' | 'offline' = 'offline';
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  /* ---- cue rails (eis-cues CueBus) --------------------------------------
   * The cue rails are GROUND-side producers: the satellite tiles, the SDR, the
   * fixed cameras and the fence loop are all watched from the ground station,
   * not from the aircraft. They run on the same bus the mock uses (FM-180) and
   * emit onto the same `anomaly` / `healthEvent` channels the companion does,
   * so a cue reaches the map identically whichever end raised it.
   *
   * They are independent of the vehicle link on purpose: a cue rail that went
   * quiet because a drone was on the ground would be a rail that cannot raise
   * the alarm that launches it. */
  private cueBus: CueBus | null = null;

  constructor(options: LiveDataProviderOptions = {}) {
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.ackTimeoutMs = options.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    this.vehicleId = options.vehicleId ?? DEFAULT_VEHICLE_ID;
    this.cueRailsEnabled = options.cueRails ?? true;
  }

  /* ---- DataSource: lifecycle ------------------------------------------- */

  connect(config: ConnectionConfig): Promise<void> {
    this.config = config;
    this.desired = 'online';
    this.attempt = 0;
    this.cancelRetry();
    this.dropSocket();
    this.openSession();
    this.startCueRails();
    return Promise.resolve();
  }

  disconnect(): void {
    this.desired = 'offline';
    this.cancelRetry();
    this.stopCueRails();
    this.dropSocket();
    this.ledger.abandon('Link closed before ack', this.vehicleId);
    this.setState('disconnected');
  }

  private endpoint(): string {
    const cfg = this.config;
    if (!cfg) return `ws://${SITL_HOST}:${DEFAULTS.controlPort}`;
    const host = cfg.host === 'sitl' ? SITL_HOST : cfg.host;
    return `ws://${host}:${cfg.controlPort}`;
  }

  private openSession(): void {
    const epoch = ++this.epoch;
    this.setState('connecting');

    let socket: WebSocket;
    try {
      socket = this.socketFactory(this.endpoint());
    } catch {
      this.setState('error');
      this.retryLater();
      return;
    }
    this.socket = socket;
    const current = (): boolean => this.epoch === epoch && this.socket === socket;

    socket.onopen = (): void => {
      if (!current()) return;
      this.attempt = 0;
      this.setState('connected');
    };
    socket.onmessage = (ev: MessageEvent): void => {
      if (!current()) return;
      const msg = decodeInbound(ev.data);
      if (msg) this.route(msg);
    };
    socket.onerror = (): void => {
      if (current()) this.setState('error');
    };
    socket.onclose = (): void => {
      if (!current()) return;
      this.socket = null;
      this.ledger.abandon('Link closed before ack', this.vehicleId);
      this.setState('disconnected');
      if (this.desired === 'online') this.retryLater();
    };
  }

  /** Close the active socket without reacting to its close event. */
  private dropSocket(): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    this.epoch += 1;
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }

  private retryLater(): void {
    if (this.desired !== 'online' || this.retryTimer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempt);
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.desired === 'online') this.openSession();
    }, delay);
  }

  private cancelRetry(): void {
    if (!this.retryTimer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.fanout.emit('connection', next);
  }

  /* ---- cue rails ------------------------------------------------------- */

  private startCueRails(): void {
    if (!this.cueRailsEnabled || this.cueBus) return;
    // The site is loaded asynchronously; the rails that need it wait for it,
    // and the rails that do not start immediately.
    void getSiteModel()
      .catch(() => null)
      .then(() => {
        if (this.cueBus || this.desired !== 'online') return;
        const bus = createRendererCueBus({
          vehicleId: this.vehicleId,
          site: getRawSite(),
        });
        this.cueBus = bus;
        bus.onAnomaly((m) => this.fanout.emit('anomaly', m));
        bus.onHealth((m) => this.fanout.emit('healthEvent', m));
        void bus.start();
      });
  }

  private stopCueRails(): void {
    const bus = this.cueBus;
    if (!bus) return;
    this.cueBus = null;
    void bus.stop();
    bus.dispose();
  }

  /** Per-rail badges: what each cue rail is doing right now. */
  railHealth(): RailHealth[] {
    return this.cueBus?.health() ?? [];
  }

  /* ---- inbound dispatch ------------------------------------------------ */

  private route(msg: InboundMessage): void {
    if (!isRouted(msg)) return;
    if (msg.type === 'telemetry' && typeof msg.link?.latencyMs === 'number') {
      this.latencyMs = msg.link.latencyMs;
    }
    if (msg.type === 'ack') this.ledger.settle(msg);
    this.fanout.emit(INBOUND_ROUTE[msg.type], msg);
  }

  /* ---- subscription API ------------------------------------------------ */

  onConnectionChange(cb: (s: ConnectionState) => void): Unsubscribe {
    const off = this.fanout.on('connection', cb);
    cb(this.state);
    return off;
  }
  onTelemetry(cb: (t: Telemetry) => void): Unsubscribe { return this.fanout.on('telemetry', cb); }
  onTracking(cb: (t: TrackingStatus) => void): Unsubscribe { return this.fanout.on('tracking', cb); }
  onStatusText(cb: (s: StatusText) => void): Unsubscribe { return this.fanout.on('statusText', cb); }
  onAck(cb: (a: CommandAck) => void): Unsubscribe { return this.fanout.on('ack', cb); }

  /* mission channels (MissionDataSource) */
  onAnomaly(cb: (m: AnomalyMessage) => void): Unsubscribe { return this.fanout.on('anomaly', cb); }
  onMissionPlan(cb: (m: MissionPlanMessage) => void): Unsubscribe { return this.fanout.on('missionPlan', cb); }
  onVerification(cb: (m: VerificationMessage) => void): Unsubscribe { return this.fanout.on('verification', cb); }
  onIncidentReport(cb: (m: IncidentReportMessage) => void): Unsubscribe { return this.fanout.on('incidentReport', cb); }
  onObservation(cb: (m: ObservationMessage) => void): Unsubscribe { return this.fanout.on('observation', cb); }
  onCapabilities(cb: (m: CapabilitiesMessage) => void): Unsubscribe { return this.fanout.on('capabilities', cb); }
  onReadiness(cb: (m: ReadinessMessage) => void): Unsubscribe { return this.fanout.on('readiness', cb); }
  onHealthEvent(cb: (m: HealthEventMessage) => void): Unsubscribe { return this.fanout.on('healthEvent', cb); }
  onRfEvent(cb: (m: RfEventMessage) => void): Unsubscribe { return this.fanout.on('rfEvent', cb); }
  onSpectrum(cb: (m: SpectrumMessage) => void): Unsubscribe { return this.fanout.on('spectrum', cb); }
  onFleet(cb: (m: FleetMessage) => void): Unsubscribe { return this.fanout.on('fleet', cb); }
  onTask(cb: (m: TaskMessage) => void): Unsubscribe { return this.fanout.on('task', cb); }
  onEnvelope(cb: (m: EnvelopeMessage) => void): Unsubscribe { return this.fanout.on('envelope', cb); }
  onMode(cb: (m: ModeMessage) => void): Unsubscribe { return this.fanout.on('mode', cb); }
  onEscalation(cb: (m: EscalationMessage) => void): Unsubscribe { return this.fanout.on('escalation', cb); }

  /* ---- outbound -------------------------------------------------------- */

  private canSend(): WebSocket | null {
    const socket = this.socket;
    return socket && socket.readyState === SOCKET_OPEN ? socket : null;
  }

  sendCommand(cmd: Command): Promise<CommandAck> {
    const socket = this.canSend();
    if (!socket) {
      const ack = syntheticAck(cmd, 'Not connected');
      this.fanout.emit('ack', ack);
      return Promise.resolve(ack);
    }
    const ticket = this.ledger.enlist(cmd, this.ackTimeoutMs);
    try {
      socket.send(JSON.stringify(cmd));
    } catch {
      ticket.fail('Failed to send command');
    }
    return ticket.promise;
  }

  setManualInput(input: ManualInput): void {
    const socket = this.canSend();
    if (!socket) return;
    const frame: ManualInputMessage = {
      type: 'manualInput',
      ts: Date.now(),
      vehicleId: this.vehicleId,
      throttle: axis(input.throttle),
      yaw: axis(input.yaw),
      pitch: axis(input.pitch),
      roll: axis(input.roll),
    };
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      /* dropped: the next stick frame supersedes this one */
    }
  }

  forwardRfEvent(event: RfEventMessage): void {
    const socket = this.canSend();
    if (!socket) return;
    try {
      socket.send(JSON.stringify(event));
    } catch {
      /* passive feed is best-effort */
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
