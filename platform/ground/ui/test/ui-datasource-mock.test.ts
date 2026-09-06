/* ============================================================================
 * MockDataProvider against the DataSource contract. The offline mock stands in
 * for the companion, so it must keep the companion's wire semantics:
 *
 *   - every command is acked exactly once (channel AND promise), after a short
 *     simulated round trip; manualInput frames are NEVER acked
 *   - exactly one controlSource is active and reported in every telemetry
 *     frame; engaging one authority releases the others
 *   - standoff and speed set-points are clamped to the safety envelope the
 *     contract's DEFAULTS declare, and the ack says so
 *   - the manual-input watchdog zeroes the sticks and holds when frames stop
 *   - the phase machine: arm → takeoff → flying, rtl → landing → touchdown
 *     disarms
 *   - connection state is replayed to a new subscriber
 * ========================================================================== */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command, CommandAck, ConnectionState, StatusText, Telemetry, TrackingStatus } from '@/contract';
import { DEFAULTS, DEFAULT_VEHICLE_ID } from '@/contract';
import { MockDataProvider } from '@/dataSource/MockDataProvider';

const CONFIG = { host: 'sitl', controlPort: 8765, videoUrl: '', sitl: true };

interface Harness {
  provider: MockDataProvider;
  acks: CommandAck[];
  logs: StatusText[];
  tel: Telemetry[];
  trk: TrackingStatus[];
  send(command: Command['command'], params?: Command['params']): Promise<CommandAck>;
  latest(): Telemetry;
}

async function harness(): Promise<Harness> {
  const provider = new MockDataProvider();
  const acks: CommandAck[] = [];
  const logs: StatusText[] = [];
  const tel: Telemetry[] = [];
  const trk: TrackingStatus[] = [];
  provider.onAck((a) => acks.push(a));
  provider.onStatusText((s) => logs.push(s));
  provider.onTelemetry((t) => tel.push(t));
  provider.onTracking((t) => trk.push(t));
  await provider.connect(CONFIG);
  // let the site model settle so the vehicle sits at the site home
  await vi.advanceTimersByTimeAsync(0);
  return {
    provider, acks, logs, tel, trk,
    send: (command, params) => provider.sendCommand({ type: 'command', vehicleId: DEFAULT_VEHICLE_ID, command, params }),
    latest: () => tel[tel.length - 1],
  };
}

/** Send a command and let its simulated ack round trip complete. */
async function issue(h: Harness, command: Command['command'], params?: Command['params']): Promise<CommandAck> {
  const pending = h.send(command, params);
  await vi.advanceTimersByTimeAsync(100);
  return pending;
}

/** arm + takeoff, then run until the vehicle reports itself at altitude. */
async function airborne(h: Harness, altitude = 4): Promise<void> {
  expect((await issue(h, 'arm')).success).toBe(true);
  expect((await issue(h, 'takeoff', { altitude })).success).toBe(true);
  await vi.advanceTimersByTimeAsync(8_000);
  expect(h.latest().position.relAlt).toBeCloseTo(altitude, 0);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------------------------------------------------- */
describe('acks', () => {
  it('acks every command once, on the channel and through the promise', async () => {
    const h = await harness();
    const pending = h.send('arm');
    expect(h.acks).toHaveLength(0);          // not before the round trip
    await vi.advanceTimersByTimeAsync(100);
    const ack = await pending;
    expect(h.acks).toEqual([ack]);
    expect(ack).toMatchObject({ type: 'ack', vehicleId: DEFAULT_VEHICLE_ID, command: 'arm', success: true });
    h.provider.disconnect();
  });

  it('refuses with a reason rather than a bare failure', async () => {
    const h = await harness();
    const ack = await issue(h, 'takeoff', { altitude: 4 }); // not armed
    expect(ack.success).toBe(false);
    expect(ack.message).toMatch(/not armed/i);
    const gimbal = await issue(h, 'setGimbal');
    expect(gimbal.success).toBe(false);
    expect(gimbal.message).toMatch(/pitchDeg/);
    h.provider.disconnect();
  });

  it('never acks manual input frames', async () => {
    const h = await harness();
    await issue(h, 'arm');
    await issue(h, 'engageManual');
    const before = h.acks.length;
    for (let i = 0; i < 40; i += 1) h.provider.setManualInput({ throttle: 0.3, yaw: 0, pitch: 0, roll: 0 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.acks).toHaveLength(before);
    h.provider.disconnect();
  });
});

/* ------------------------------------------------------------------------- */
describe('one control source', () => {
  it('reports manual while the sticks have the vehicle and auto once released', async () => {
    const h = await harness();
    expect((await issue(h, 'arm')).success).toBe(true);
    expect((await issue(h, 'engageManual')).success).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.latest().controlSource).toBe('manual');
    expect(h.latest().mode).toBe('STABILIZE');

    expect((await issue(h, 'disengageManual')).success).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.latest().controlSource).toBe('auto');
    expect(h.latest().mode).toBe('LOITER');
    h.provider.disconnect();
  });

  it('manual preempts tracking: engaging the sticks releases the tracker', async () => {
    const h = await harness();
    await airborne(h);
    expect((await issue(h, 'engageTracking')).success).toBe(true);
    await vi.advanceTimersByTimeAsync(2_500); // searching → locked
    expect(h.latest().controlSource).toBe('tracking');
    expect(h.trk[h.trk.length - 1].state).toBe('locked');

    expect((await issue(h, 'engageManual')).success).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    expect(h.latest().controlSource).toBe('manual');
    expect(h.trk[h.trk.length - 1].state).toBe('idle');
    expect(h.logs.some((l) => /released for manual/i.test(l.text))).toBe(true);
    h.provider.disconnect();
  });

  it('refuses to engage tracking on the ground', async () => {
    const h = await harness();
    await issue(h, 'arm');
    const ack = await issue(h, 'engageTracking');
    expect(ack.success).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.latest().controlSource).toBe('auto');
    h.provider.disconnect();
  });

  it('emergency stop disarms and releases every authority', async () => {
    const h = await harness();
    await airborne(h);
    await issue(h, 'engageManual');
    const ack = await issue(h, 'emergencyStop');
    expect(ack.success).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.latest().armed).toBe(false);
    expect(h.latest().controlSource).toBe('auto');
    expect(h.logs.some((l) => l.severity === 'critical' && /EMERGENCY STOP/.test(l.text))).toBe(true);
    h.provider.disconnect();
  });
});

/* ------------------------------------------------------------------------- */
describe('safety envelope on set-points', () => {
  it('clamps standoff to the contract floor and ceiling', async () => {
    const h = await harness();
    const low = await issue(h, 'setStandoff', { meters: 1 });
    expect(low.success).toBe(true);
    expect(low.message).toMatch(`${DEFAULTS.minStandoff.toFixed(1)} m`);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.trk[h.trk.length - 1].standoffDistance).toBe(DEFAULTS.minStandoff);

    const high = await issue(h, 'setStandoff', { meters: 99 });
    expect(high.message).toMatch(`${DEFAULTS.maxStandoff.toFixed(1)} m`);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.trk[h.trk.length - 1].standoffDistance).toBe(DEFAULTS.maxStandoff);
    h.provider.disconnect();
  });

  it('never raises the speed cap above the envelope', async () => {
    const h = await harness();
    const ack = await issue(h, 'setMaxSpeed', { mps: 40 });
    expect(ack.success).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.trk[h.trk.length - 1].maxSpeed).toBe(DEFAULTS.maxSpeedCap);
    const missing = await issue(h, 'setMaxSpeed');
    expect(missing.success).toBe(false);
    h.provider.disconnect();
  });

  it('clamps the takeoff altitude to the ceiling', async () => {
    const h = await harness();
    await issue(h, 'arm');
    const ack = await issue(h, 'takeoff', { altitude: 500 });
    expect(ack.success).toBe(true);
    expect(ack.message).toMatch(`${DEFAULTS.maxAltitude} m`);
    h.provider.disconnect();
  });
});

/* ------------------------------------------------------------------------- */
describe('manual input watchdog', () => {
  it('zeroes the sticks and holds when frames stop arriving', async () => {
    const h = await harness();
    await airborne(h);
    await issue(h, 'engageManual');
    // a steady stream of climb frames
    for (let i = 0; i < 10; i += 1) {
      h.provider.setManualInput({ throttle: 1, yaw: 0, pitch: 0, roll: 0 });
      await vi.advanceTimersByTimeAsync(100);
    }
    const climbing = h.latest();
    expect(climbing.velocity.verticalSpeed).toBeGreaterThan(0.5);
    expect(climbing.velocity.verticalSpeed).toBeLessThanOrEqual(DEFAULTS.maxClimbRate + 1e-9);

    // the stream stops: past the watchdog the vehicle holds
    await vi.advanceTimersByTimeAsync(DEFAULTS.manualWatchdogMs + 1_500);
    expect(h.logs.some((l) => /watchdog/i.test(l.text))).toBe(true);
    const held = h.latest();
    expect(Math.abs(held.velocity.verticalSpeed)).toBeLessThan(0.05);
    const altBefore = held.position.relAlt;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(Math.abs(h.latest().position.relAlt - altBefore)).toBeLessThan(0.05);
    expect(h.latest().controlSource).toBe('manual'); // still the operator's vehicle
    h.provider.disconnect();
  });
});

/* ------------------------------------------------------------------------- */
describe('phase machine', () => {
  it('arms, climbs to the takeoff altitude in GUIDED and reports it', async () => {
    const h = await harness();
    await airborne(h, 4);
    const frame = h.latest();
    expect(frame.armed).toBe(true);
    expect(frame.mode).toBe('GUIDED');
    expect(frame.sortie).not.toBeNull();
    expect(h.logs.some((l) => /Reached target altitude/.test(l.text))).toBe(true);
    h.provider.disconnect();
  });

  it('returns to launch, lands and disarms on touchdown', async () => {
    const h = await harness();
    await airborne(h, 4);
    const home = h.latest().home;
    // fly away under manual so the RTL leg has somewhere to come back from
    await issue(h, 'engageManual');
    for (let i = 0; i < 40; i += 1) {
      h.provider.setManualInput({ throttle: 0, yaw: 0, pitch: -1, roll: 0 });
      await vi.advanceTimersByTimeAsync(100);
    }
    await issue(h, 'disengageManual');
    expect(h.latest().home.distance).toBeGreaterThan(5);

    expect((await issue(h, 'rtl')).success).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.latest().mode).toBe('RTL');
    expect(h.latest().controlSource).toBe('auto');
    await vi.advanceTimersByTimeAsync(20_000);
    const landed = h.latest();
    expect(landed.position.relAlt).toBe(0);
    expect(landed.armed).toBe(false);
    expect(landed.mode).toBe('LOITER');
    expect(landed.sortie).toBeNull();
    expect(landed.home.distance).toBeLessThan(2);
    expect(landed.home.lat).toBe(home.lat);
    expect(h.logs.some((l) => /Landed & disarmed/.test(l.text))).toBe(true);
    h.provider.disconnect();
  });

  it('holds station rather than drifting away while idle in the air', async () => {
    const h = await harness();
    await airborne(h, 4);
    const start = h.latest().position;
    await vi.advanceTimersByTimeAsync(30_000);
    const end = h.latest().position;
    const driftM = Math.hypot((end.lat - start.lat) * 111_320, (end.lon - start.lon) * 111_320);
    expect(driftM).toBeLessThan(5);
    expect(end.relAlt).toBeGreaterThan(3);
    h.provider.disconnect();
  });
});

/* ------------------------------------------------------------------------- */
describe('connection state', () => {
  it('replays the current state and reports disconnect', async () => {
    const provider = new MockDataProvider();
    const states: ConnectionState[] = [];
    provider.onConnectionChange((s) => states.push(s));
    expect(states).toEqual(['connected']);
    await provider.connect(CONFIG);
    provider.disconnect();
    expect(states.at(-1)).toBe('disconnected');
    const late: ConnectionState[] = [];
    provider.onConnectionChange((s) => late.push(s));
    expect(late).toEqual(['disconnected']);
    expect(provider.getVideoUrl()).toBe('');
  });
});
