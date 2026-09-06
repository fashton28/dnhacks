/* ============================================================================
 * Settings persistence compatibility (ui-views-stores).
 *
 * The Electron shell keeps one JSON map in <userData>/settings.json and the
 * renderer's snapshot lives under the key `eis.settings`. These cases pin:
 *   (a) a file written by the earlier implementation — full, partial, or a
 *       little wrong — still loads through a bridge-shaped adapter and ends
 *       up complete and well-typed;
 *   (b) what the store writes back is the same key and the same nested
 *       shape, so the file stays readable by either implementation;
 *   (c) the store's own semantics: deep patch, updater, reset, subscribe,
 *       and a late hydration losing to an edit made while it was in flight.
 * ========================================================================== */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  bridgePersistence,
  createSettingsStore,
  memoryPersistence,
  normaliseSettings,
  settingsStore,
  storagePersistence,
  useSettings,
} from '@/store/settings';
import type { AppSettings } from '@/store/settings';

/** A settings.json exactly as the previous build wrote it. */
const LEGACY_SNAPSHOT: AppSettings = {
  connection: { host: '192.168.4.7', controlPort: 8766, videoUrl: 'rtsp://192.168.4.7:8554/cam', sitl: false },
  failsafe: {
    geofenceRadius: 120, maxAltitude: 45, batteryWarnPct: 35, batteryFailsafePct: 20,
    linkLossAction: 'LAND', gcsLossAction: 'HOLD',
  },
  pid: {
    yaw: { kp: 0.5, ki: 0.06, kd: 0.01 },
    altitude: { kp: 0.9, ki: 0.12, kd: 0.05 },
    forward: { kp: 0.7, ki: 0.09, kd: 0.03 },
  },
  units: 'imperial',
  mapTiles: 'osm',
  theme: 'dark',
};

interface BridgeOptions {
  holdReads?: boolean;
  failRead?: boolean;
  failWrite?: boolean;
}

/** In-memory stand-in for the shell's settingsStore behind window.eis.settings. */
function fakeBridge(file: Record<string, unknown>, opts: BridgeOptions = {}) {
  const map: Record<string, unknown> = { ...file };
  const writes: Array<{ key: string; value: unknown }> = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const bridge = {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      if (opts.holdReads) await gate;
      if (opts.failRead) throw new Error('disk read failed');
      return map[key] as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      if (opts.failWrite) throw new Error('disk write failed');
      map[key] = JSON.parse(JSON.stringify(value)); // through the IPC/JSON boundary
      writes.push({ key, value });
    },
    async all(): Promise<Record<string, unknown>> {
      return { ...map };
    },
  };
  return { bridge, map, writes, release: () => release() };
}

/** Minimal Storage-alike for the browser path. */
function fakeStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
  };
}

const bridgeStore = (file: Record<string, unknown>, opts?: BridgeOptions) => {
  const fake = fakeBridge(file, opts);
  const store = createSettingsStore({ persistence: bridgePersistence(fake.bridge) });
  return { ...fake, store };
};

/* ------------------------------------------------------------------------- */
describe('loading a settings.json written by the previous build', () => {
  it('reads the full legacy snapshot from the eis.settings key', async () => {
    const { store } = bridgeStore({ [SETTINGS_STORAGE_KEY]: LEGACY_SNAPSHOT });
    expect(store.get()).toEqual(DEFAULT_SETTINGS); // nothing applied until the read lands
    await store.ready();
    expect(store.get()).toEqual(LEGACY_SNAPSHOT);
  });

  it('migrates a partial legacy blob: missing sections pick up their defaults', async () => {
    const { store } = bridgeStore({
      [SETTINGS_STORAGE_KEY]: { connection: LEGACY_SNAPSHOT.connection, units: 'imperial' },
    });
    await store.ready();
    const s = store.get();
    expect(s.connection).toEqual(LEGACY_SNAPSHOT.connection);
    expect(s.units).toBe('imperial');
    expect(s.failsafe).toEqual(DEFAULT_SETTINGS.failsafe);
    expect(s.pid).toEqual(DEFAULT_SETTINGS.pid);
    expect(s.mapTiles).toBe(DEFAULT_SETTINGS.mapTiles);
    expect(s.theme).toBe('dark');
  });

  it('fills missing keys INSIDE a section from the defaults', async () => {
    const { store } = bridgeStore({
      [SETTINGS_STORAGE_KEY]: {
        failsafe: { geofenceRadius: 250 },
        pid: { yaw: { kp: 1.25 } },
      },
    });
    await store.ready();
    const s = store.get();
    expect(s.failsafe).toEqual({ ...DEFAULT_SETTINGS.failsafe, geofenceRadius: 250 });
    expect(s.pid.yaw).toEqual({ ...DEFAULT_SETTINGS.pid.yaw, kp: 1.25 });
    expect(s.pid.altitude).toEqual(DEFAULT_SETTINGS.pid.altitude);
  });

  it('coerces wrong types, rejects unknown enum values and drops unknown keys', async () => {
    const { store } = bridgeStore({
      [SETTINGS_STORAGE_KEY]: {
        connection: { host: 'jetson.local', controlPort: '9000', sitl: 'true', extra: 1 },
        failsafe: { linkLossAction: 'PANIC', batteryWarnPct: 'lots' },
        pid: { yaw: { kp: 'abc', ki: Number.NaN, kd: 0.2 } },
        units: 'furlongs',
        mapTiles: 'terrain',
        theme: 'light',
        debug: true,
      },
    });
    await store.ready();
    const s = store.get() as AppSettings & Record<string, unknown>;
    expect(s.connection).toEqual({ host: 'jetson.local', controlPort: 9000, videoUrl: '', sitl: true });
    expect(s.failsafe.linkLossAction).toBe(DEFAULT_SETTINGS.failsafe.linkLossAction);
    expect(s.failsafe.batteryWarnPct).toBe(DEFAULT_SETTINGS.failsafe.batteryWarnPct);
    expect(s.pid.yaw).toEqual({ kp: DEFAULT_SETTINGS.pid.yaw.kp, ki: DEFAULT_SETTINGS.pid.yaw.ki, kd: 0.2 });
    expect(s.units).toBe('metric');
    expect(s.mapTiles).toBe('terrain');
    expect(s.theme).toBe('dark');
    expect('debug' in s).toBe(false);
    expect('extra' in s.connection).toBe(false);
  });

  it('treats a missing key, a corrupt value or a failed read as "use defaults"', async () => {
    const empty = bridgeStore({});
    await empty.store.ready();
    expect(empty.store.get()).toEqual(DEFAULT_SETTINGS);

    const corrupt = bridgeStore({ [SETTINGS_STORAGE_KEY]: 'not an object' });
    await corrupt.store.ready();
    expect(corrupt.store.get()).toEqual(DEFAULT_SETTINGS);

    const broken = bridgeStore({ [SETTINGS_STORAGE_KEY]: LEGACY_SNAPSHOT }, { failRead: true });
    await expect(broken.store.ready()).resolves.toEqual(DEFAULT_SETTINGS);
    expect(broken.store.get()).toEqual(DEFAULT_SETTINGS);
  });
});

/* ------------------------------------------------------------------------- */
describe('what the store writes back', () => {
  it('uses the same key and the complete nested shape', async () => {
    const { store, writes } = bridgeStore({ [SETTINGS_STORAGE_KEY]: LEGACY_SNAPSHOT });
    await store.ready();
    store.set({ mapTiles: 'terrain' });

    expect(writes).toHaveLength(1);
    expect(writes[0].key).toBe('eis.settings');
    const blob = writes[0].value as AppSettings;
    expect(Object.keys(blob).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    expect(Object.keys(blob.connection).sort()).toEqual(Object.keys(DEFAULT_SETTINGS.connection).sort());
    expect(Object.keys(blob.failsafe).sort()).toEqual(Object.keys(DEFAULT_SETTINGS.failsafe).sort());
    expect(Object.keys(blob.pid).sort()).toEqual(['altitude', 'forward', 'yaw']);
    expect(blob).toEqual({ ...LEGACY_SNAPSHOT, mapTiles: 'terrain' });
  });

  it('round-trips: a fresh store over the written file sees the same settings', async () => {
    const first = bridgeStore({});
    await first.store.ready();
    first.store.set({ connection: { host: '10.0.0.9', controlPort: 8770, videoUrl: '', sitl: false } });
    first.store.set({ pid: { ...DEFAULT_SETTINGS.pid, forward: { kp: 1, ki: 0, kd: 0 } } });

    const second = createSettingsStore({ persistence: bridgePersistence(first.bridge) });
    await second.ready();
    expect(second.get()).toEqual(first.store.get());
    expect(second.get().connection.host).toBe('10.0.0.9');
    expect(second.get().pid.forward).toEqual({ kp: 1, ki: 0, kd: 0 });
    // And the file still carries only the one key the shell has always used.
    expect(Object.keys(first.map)).toEqual([SETTINGS_STORAGE_KEY]);
  });
});

/* ------------------------------------------------------------------------- */
describe('browser (localStorage) path', () => {
  it('loads synchronously from JSON text under the same key', () => {
    const storage = fakeStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(LEGACY_SNAPSHOT) });
    const store = createSettingsStore({ persistence: storagePersistence(storage) });
    expect(store.get()).toEqual(LEGACY_SNAPSHOT); // no await needed
  });

  it('writes JSON text that parses back to the live snapshot', () => {
    const storage = fakeStorage();
    const store = createSettingsStore({ persistence: storagePersistence(storage) });
    store.set({ units: 'imperial' });
    expect(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) as string)).toEqual(store.get());
  });

  it('survives corrupt JSON text', () => {
    const storage = fakeStorage({ [SETTINGS_STORAGE_KEY]: '{not json' });
    const store = createSettingsStore({ persistence: storagePersistence(storage) });
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });
});

/* ------------------------------------------------------------------------- */
describe('store semantics', () => {
  it('a late bridge read does not clobber an edit made while it was in flight', async () => {
    const { store, release, writes } = bridgeStore({ [SETTINGS_STORAGE_KEY]: LEGACY_SNAPSHOT }, { holdReads: true });
    store.set({ mapTiles: 'terrain' });
    expect(writes).toHaveLength(1); // the edit is already on disk
    release();
    await store.ready();
    expect(store.get().mapTiles).toBe('terrain');
    // The stale file is not layered back over the edit either.
    expect(store.get().connection).toEqual(DEFAULT_SETTINGS.connection);
  });

  it('a failing write never throws and the in-memory snapshot still advances', async () => {
    const { store } = bridgeStore({}, { failWrite: true });
    await store.ready();
    expect(() => store.set({ units: 'imperial' })).not.toThrow();
    await Promise.resolve();
    expect(store.get().units).toBe('imperial');
  });

  it('partial patches deep-merge, the updater form replaces, reset restores and persists defaults', () => {
    const storage = fakeStorage();
    const store = createSettingsStore({ persistence: storagePersistence(storage) });

    store.set({ failsafe: { ...DEFAULT_SETTINGS.failsafe, maxAltitude: 50 } });
    expect(store.get().failsafe).toEqual({ ...DEFAULT_SETTINGS.failsafe, maxAltitude: 50 });
    expect(store.get().connection).toEqual(DEFAULT_SETTINGS.connection);

    store.set((s) => ({ ...s, units: 'imperial', pid: { ...s.pid, yaw: { kp: 2, ki: 0, kd: 0 } } }));
    expect(store.get().units).toBe('imperial');
    expect(store.get().pid.yaw).toEqual({ kp: 2, ki: 0, kd: 0 });
    expect(store.get().failsafe.maxAltitude).toBe(50);

    store.reset();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) as string)).toEqual(DEFAULT_SETTINGS);
  });

  it('never hands out DEFAULT_SETTINGS itself, so edits cannot leak into the defaults', () => {
    const store = createSettingsStore({ persistence: memoryPersistence });
    expect(store.get()).not.toBe(DEFAULT_SETTINGS);
    expect(store.get().connection).not.toBe(DEFAULT_SETTINGS.connection);
    expect(store.get().pid.yaw).not.toBe(DEFAULT_SETTINGS.pid.yaw);
    store.set({ units: 'imperial' });
    expect(DEFAULT_SETTINGS.units).toBe('metric');
    expect(normaliseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normaliseSettings(undefined)).not.toBe(DEFAULT_SETTINGS);
  });

  it('subscribe delivers each change until unsubscribed, even mid-notify', () => {
    const store = createSettingsStore({ persistence: memoryPersistence });
    const seen: string[] = [];
    let offSecond: () => void = () => undefined;
    const offFirst = store.subscribe((s) => { seen.push(`a:${s.units}`); offSecond(); });
    offSecond = store.subscribe((s) => { seen.push(`b:${s.units}`); });

    store.set({ units: 'imperial' });
    // Listener b was removed by a during the same notify, yet the copy-iteration still reaches it once.
    expect(seen).toEqual(['a:imperial', 'b:imperial']);

    store.set({ units: 'metric' });
    expect(seen).toEqual(['a:imperial', 'b:imperial', 'a:metric']);

    offFirst();
    store.set({ units: 'imperial' });
    expect(seen).toHaveLength(3);
  });

  it('normaliseSettings tolerates any input', () => {
    for (const junk of [null, undefined, 42, 'text', [], true, () => undefined]) {
      expect(normaliseSettings(junk)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('the module singleton works in a bare Node environment', () => {
    expect(settingsStore.get()).toEqual(DEFAULT_SETTINGS);
    expect(typeof useSettings).toBe('function');
  });
});
