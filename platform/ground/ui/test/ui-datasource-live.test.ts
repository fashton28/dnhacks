/* ============================================================================
 * LiveDataProvider against the wire contract (src/contract, shared/shared.py),
 * driven through a fake WebSocket so no companion is needed.
 *
 * What the contract pins and these cases check:
 *   - connection state is replayed to a new subscriber and follows the socket
 *     (connecting → connected → disconnected), with exponential backoff on an
 *     unexpected close and NO reconnect after disconnect()
 *   - a command is one `command` frame; its ack correlates by command NAME,
 *     first-in first-out — there is no requestId on the ack path
 *   - manualInput is fire-and-forget: one frame per call, never acked, dropped
 *     when the link is down
 *   - a command that cannot get an ack (timeout, closed link, not connected)
 *     resolves with a synthetic failure ack that also reaches onAck
 *   - inbound frames fan out by type; junk and unknown frames are ignored
 * ========================================================================== */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CommandAck, ConnectionState, StatusText, Telemetry, TrackingStatus,
} from '@/contract';
import { DEFAULT_VEHICLE_ID } from '@/contract';
import { LiveDataProvider } from '@/dataSource/LiveDataProvider';

/* ---- a WebSocket the test drives from both ends -------------------------- */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  closedByClient = false;

  constructor(public readonly url: string) {
    FakeSocket.instances.push(this);
  }

  /* --- the provider's side --- */
  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket not open');
    this.sent.push(data);
  }
  close(): void {
    this.closedByClient = true;
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }

  /* --- the companion's side --- */
  accept(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
  receiveRaw(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.({} as CloseEvent);
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const socketFactory = (url: string): WebSocket => new FakeSocket(url) as unknown as WebSocket;
const CONFIG = { host: 'sitl', controlPort: 8765, videoUrl: 'rtsp://sitl:8554/eis', sitl: true };

function makeProvider(ackTimeoutMs = 4000): LiveDataProvider {
  return new LiveDataProvider({ socketFactory, cueRails: false, ackTimeoutMs });
}

async function connected(provider: LiveDataProvider): Promise<FakeSocket> {
  await provider.connect(CONFIG);
  const socket = FakeSocket.instances[FakeSocket.instances.length - 1];
  socket.accept();
  return socket;
}

const ack = (command: CommandAck['command'], success = true, message = 'OK'): CommandAck => ({
  type: 'ack', ts: Date.now(), vehicleId: DEFAULT_VEHICLE_ID, command, success, message,
});

const telemetry = (latencyMs: number): Telemetry => ({
  type: 'telemetry', ts: Date.now(), vehicleId: DEFAULT_VEHICLE_ID,
  armed: false, mode: 'LOITER', controlSource: 'auto', navSource: 'gps',
  gpsHealth: { fix: 3, sats: 14, hdop: 0.8 }, failsafeState: 'none', failsafeReason: '',
  attitude: { roll: 0, pitch: 0, yaw: 90 },
  position: { lat: 1, lon: 2, relAlt: 0, absAlt: 30 },
  velocity: { groundspeed: 0, verticalSpeed: 0 }, heading: 90,
  battery: {
    soc_pct: 90, voltage_v: 16, current_a: 1, cell_delta_v: 0.01, temp_c: 30, remaining_s: 1000,
    charge_state: 'charged', voltage: 16, current: 1, remaining: 90,
  },
  gps: { fixType: 3, satellites: 14, hdop: 0.8 }, sortie: null,
  home: { lat: 1, lon: 2, distance: 0 }, link: { rssi: -50, latencyMs },
});

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
});
afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------------------------------------------------- */
describe('connection lifecycle', () => {
  it('replays the current state to a new subscriber and follows the socket', async () => {
    const provider = makeProvider();
    const states: ConnectionState[] = [];
    provider.onConnectionChange((s) => states.push(s));
    expect(states).toEqual(['disconnected']);

    await provider.connect(CONFIG);
    expect(states.at(-1)).toBe('connecting');
    expect(FakeSocket.instances[0].url).toBe('ws://127.0.0.1:8765');

    FakeSocket.instances[0].accept();
    expect(states.at(-1)).toBe('connected');

    provider.disconnect();
    expect(states.at(-1)).toBe('disconnected');
    expect(FakeSocket.instances[0].closedByClient).toBe(true);
    // a late subscriber sees the settled state
    const late: ConnectionState[] = [];
    provider.onConnectionChange((s) => late.push(s));
    expect(late).toEqual(['disconnected']);
  });

  it('resolves a real host verbatim', async () => {
    const provider = makeProvider();
    await provider.connect({ ...CONFIG, host: '192.168.4.20', controlPort: 9001 });
    expect(FakeSocket.instances[0].url).toBe('ws://192.168.4.20:9001');
    provider.disconnect();
  });

  it('reconnects with doubling backoff after an unexpected close, not after disconnect()', async () => {
    const provider = makeProvider();
    const states: ConnectionState[] = [];
    provider.onConnectionChange((s) => states.push(s));
    const first = await connected(provider);

    first.drop();
    expect(states.at(-1)).toBe('disconnected');
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(states.at(-1)).toBe('connecting');

    // the retry never opened: the next wait doubles
    FakeSocket.instances[1].drop();
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(3);

    // a successful open resets the backoff to the base
    FakeSocket.instances[2].accept();
    expect(states.at(-1)).toBe('connected');
    FakeSocket.instances[2].drop();
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeSocket.instances).toHaveLength(4);

    // an intentional disconnect stops the loop for good
    provider.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(4);
    expect(states.at(-1)).toBe('disconnected');
  });

  it('ignores events from a socket that has been superseded', async () => {
    const provider = makeProvider();
    const states: ConnectionState[] = [];
    provider.onConnectionChange((s) => states.push(s));
    const first = await connected(provider);
    await provider.connect(CONFIG); // re-connect replaces the session
    expect(first.closedByClient).toBe(true);
    const second = FakeSocket.instances[1];
    second.accept();
    expect(states.at(-1)).toBe('connected');
    // the old socket's late events must not disturb the new session
    first.onerror?.({} as Event);
    first.onclose?.({} as CloseEvent);
    expect(states.at(-1)).toBe('connected');
    provider.disconnect();
  });
});

/* ------------------------------------------------------------------------- */
describe('commands and acks', () => {
  it('sends the command envelope and resolves with the vehicle ack, fanning it out', async () => {
    const provider = makeProvider();
    const socket = await connected(provider);
    const seen: CommandAck[] = [];
    provider.onAck((a) => seen.push(a));

    const pending = provider.sendCommand({
      type: 'command', vehicleId: DEFAULT_VEHICLE_ID, command: 'takeoff', params: { altitude: 4 },
    });
    expect(socket.frames()).toEqual([
      { type: 'command', vehicleId: DEFAULT_VEHICLE_ID, command: 'takeoff', params: { altitude: 4 } },
    ]);

    socket.receive(ack('takeoff', true, 'climbing'));
    const result = await pending;
    expect(result).toMatchObject({ type: 'ack', command: 'takeoff', success: true, message: 'climbing' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ command: 'takeoff', success: true });
    provider.disconnect();
  });

  it('correlates acks by command name, first-in first-out', async () => {
    const provider = makeProvider();
    const socket = await connected(provider);
    const cmd = (command: CommandAck['command'], meters?: number) => provider.sendCommand({
      type: 'command', vehicleId: DEFAULT_VEHICLE_ID, command, params: meters === undefined ? undefined : { meters },
    });
    const a = cmd('setStandoff', 5);
    const b = cmd('setStandoff', 6);
    const c = cmd('arm');

    // an ack for another command name does not settle the standoff waiters
    socket.receive(ack('arm', false, 'refused'));
    expect(await c).toMatchObject({ command: 'arm', success: false, message: 'refused' });

    socket.receive(ack('setStandoff', true, 'first'));
    expect(await a).toMatchObject({ message: 'first' });
    socket.receive(ack('setStandoff', true, 'second'));
    expect(await b).toMatchObject({ message: 'second' });
    provider.disconnect();
  });

  it('resolves a synthetic failure on timeout and announces it on the ack channel', async () => {
    const provider = makeProvider(250);
    await connected(provider);
    const seen: CommandAck[] = [];
    provider.onAck((a) => seen.push(a));
    const pending = provider.sendCommand({ type: 'command', vehicleId: DEFAULT_VEHICLE_ID, command: 'rtl' });
    await vi.advanceTimersByTimeAsync(249);
    expect(seen).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result).toMatchObject({ type: 'ack', command: 'rtl', success: false });
    expect(result.message).toMatch(/timed out/i);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(result);
    provider.disconnect();
  });

  it('fails every outstanding command when the link closes', async () => {
    const provider = makeProvider();
    const socket = await connected(provider);
    const a = provider.sendCommand({ type: 'command', vehicleId: DEFAULT_VEHICLE_ID, command: 'arm' });
    const b = provider.sendCommand({ type: 'command', vehicleId: DEFAULT_VEHICLE_ID, command: 'land' });
    socket.drop();
    expect(await a).toMatchObject({ command: 'arm', success: false, message: 'Link closed before ack' });
    expect(await b).toMatchObject({ command: 'land', success: false, message: 'Link closed before ack' });
    // nothing is left waiting: a late ack is fanned out but settles no one
    provider.disconnect();
  });

  it('refuses immediately while not connected', async () => {
    const provider = makeProvider();
    const seen: CommandAck[] = [];
    provider.onAck((a) => seen.push(a));
    const result = await provider.sendCommand({ type: 'command', vehicleId: DEFAULT_VEHICLE_ID, command: 'arm' });
    expect(result).toMatchObject({ command: 'arm', success: false, message: 'Not connected' });
    expect(seen).toEqual([result]);
  });
});

/* ------------------------------------------------------------------------- */
describe('manual input is fire-and-forget', () => {
  it('sends one manualInput frame per call and never receives an ack', async () => {
    const provider = makeProvider(300);
    const socket = await connected(provider);
    const acks: CommandAck[] = [];
    provider.onAck((a) => acks.push(a));

    for (let i = 0; i < 25; i += 1) provider.setManualInput({ throttle: 0.2, yaw: -0.1, pitch: 0.5, roll: 0 });
    provider.setManualInput({ throttle: 4, yaw: Number.NaN, pitch: -9, roll: 0.25 });

    const frames = socket.frames();
    expect(frames).toHaveLength(26);
    for (const frame of frames) {
      expect(frame.type).toBe('manualInput');
      expect(frame.vehicleId).toBe(DEFAULT_VEHICLE_ID);
      expect(typeof frame.ts).toBe('number');
    }
    // axes are bounded to -1..1 and a non-finite axis is centred
    expect(frames[25]).toMatchObject({ throttle: 1, yaw: 0, pitch: -1, roll: 0.25 });

    // no ack ever arrives for a stick frame, and none is synthesised either
    await vi.advanceTimersByTimeAsync(5_000);
    expect(acks).toHaveLength(0);
    provider.disconnect();
  });

  it('drops frames while the link is down instead of queueing them', async () => {
    const provider = makeProvider();
    provider.setManualInput({ throttle: 1, yaw: 0, pitch: 0, roll: 0 });
    const socket = await connected(provider);
    expect(socket.sent).toHaveLength(0);
    socket.drop();
    provider.setManualInput({ throttle: 1, yaw: 0, pitch: 0, roll: 0 });
    expect(socket.sent).toHaveLength(0);
    provider.disconnect();
  });
});

/* ------------------------------------------------------------------------- */
describe('inbound routing', () => {
  it('fans out telemetry, tracking and statusText by type and tracks link latency', async () => {
    const provider = makeProvider();
    const socket = await connected(provider);
    const tel: Telemetry[] = [];
    const trk: TrackingStatus[] = [];
    const txt: StatusText[] = [];
    provider.onTelemetry((t) => tel.push(t));
    provider.onTracking((t) => trk.push(t));
    provider.onStatusText((s) => txt.push(s));

    socket.receive(telemetry(73));
    socket.receive({
      type: 'tracking', ts: 1, vehicleId: DEFAULT_VEHICLE_ID, state: 'searching', targets: [],
      lockedTargetId: null, standoffDistance: 5, estimatedDistance: null, maxSpeed: 2,
    });
    socket.receive({ type: 'statusText', ts: 1, vehicleId: DEFAULT_VEHICLE_ID, severity: 'info', text: 'hi' });

    expect(tel).toHaveLength(1);
    expect(trk).toHaveLength(1);
    expect(txt).toHaveLength(1);
    expect(provider.getLatencyMs()).toBe(73);
    provider.disconnect();
  });

  it('ignores junk, unknown frame types and binary payloads', async () => {
    const provider = makeProvider();
    const socket = await connected(provider);
    const seen: unknown[] = [];
    provider.onTelemetry((t) => seen.push(t));
    provider.onStatusText((s) => seen.push(s));
    socket.receiveRaw('{not json');
    socket.receiveRaw(new ArrayBuffer(4));
    socket.receive({ type: 'somethingElse', ts: 1 });
    socket.receive({ type: 'cctvEvent', ts: 1, vehicleId: DEFAULT_VEHICLE_ID, cameraId: 'c1', zone: 'z' });
    socket.receive(42);
    expect(seen).toHaveLength(0);
    provider.disconnect();
  });

  it('stops delivering to a listener after unsubscribe', async () => {
    const provider = makeProvider();
    const socket = await connected(provider);
    const seen: Telemetry[] = [];
    const off = provider.onTelemetry((t) => seen.push(t));
    socket.receive(telemetry(10));
    off();
    socket.receive(telemetry(11));
    expect(seen).toHaveLength(1);
    provider.disconnect();
  });

  it('forwards passive RF events verbatim and reports the configured video URL', async () => {
    const provider = makeProvider();
    const socket = await connected(provider);
    const event = {
      type: 'rfEvent' as const, ts: 5, vehicleId: DEFAULT_VEHICLE_ID, source: 'sdr' as const,
      kind: 'gnss_interference' as const, band: 'L1', confidence: 0.9,
    };
    provider.forwardRfEvent(event);
    expect(socket.frames()).toEqual([event]);
    expect(provider.getVideoUrl()).toBe(CONFIG.videoUrl);
    provider.disconnect();
  });
});
