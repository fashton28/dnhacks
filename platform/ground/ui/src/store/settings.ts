/* ============================================================================
 * Drone Safety Platform — SettingsStore
 * ----------------------------------------------------------------------------
 * The one observable home for the operator's persistent settings: connection,
 * failsafe envelope, PID gains and display preferences.
 *
 * Persistence is an adapter picked once at construction:
 *   1. window.eis.settings (Electron shells). The snapshot lives under the key
 *      `eis.settings` inside <userData>/settings.json — the same key and the
 *      same nested shape earlier builds wrote — so an existing settings file
 *      keeps loading and a file written here still loads in an older build.
 *   2. localStorage under the same key (browser dev server).
 *   3. memory only (tests, storage-restricted contexts).
 *
 * Every snapshot that enters the store — a stored blob, a partial patch, an
 * updater's result — passes through `normaliseSettings`: missing keys inherit
 * from a base, values of the wrong type fall back, unknown keys are dropped
 * and `theme` is pinned. That single funnel is how an older settings file
 * "migrates": new keys pick up their defaults and nothing ever throws.
 *
 * PID apply path: gains persist here and, when connected, map onto the
 * companion config keys guidance.gains.{yaw,altitude,forward}.{kp,ki,kd}.
 * ========================================================================== */
import { useSyncExternalStore } from 'react';
import type { ConnectionConfig } from '@/contract';

/* ---- shape ------------------------------------------------------------- */

export type SafetyAction = 'HOLD' | 'RTL' | 'LAND';

export interface FailsafeConfig {
  geofenceRadius: number;     // m
  maxAltitude: number;        // m
  batteryWarnPct: number;     // %
  batteryFailsafePct: number; // %
  linkLossAction: SafetyAction;
  gcsLossAction: SafetyAction;
}

export interface PidAxisGains { kp: number; ki: number; kd: number }
export interface PidGains {
  yaw: PidAxisGains;
  altitude: PidAxisGains;
  forward: PidAxisGains;
}

export type UnitSystem = 'metric' | 'imperial';
export type MapTileSet = 'satellite' | 'terrain' | 'osm';

export interface AppSettings {
  connection: ConnectionConfig;
  failsafe: FailsafeConfig;
  pid: PidGains;
  units: UnitSystem;
  mapTiles: MapTileSet;
  theme: 'dark';
}

export const SAFETY_ACTIONS: readonly SafetyAction[] = ['HOLD', 'RTL', 'LAND'];
export const UNIT_SYSTEMS: readonly UnitSystem[] = ['metric', 'imperial'];
export const MAP_TILE_SETS: readonly MapTileSet[] = ['satellite', 'terrain', 'osm'];
export const PID_AXES = ['yaw', 'altitude', 'forward'] as const;
export type PidAxis = (typeof PID_AXES)[number];
export const PID_GAIN_KEYS = ['kp', 'ki', 'kd'] as const;
export type PidGainKey = (typeof PID_GAIN_KEYS)[number];

export const DEFAULT_SETTINGS: AppSettings = {
  connection: {
    host: 'sitl',
    controlPort: 8765,
    videoUrl: '',
    sitl: true,
  },
  failsafe: {
    geofenceRadius: 60,
    maxAltitude: 30,
    batteryWarnPct: 30,
    batteryFailsafePct: 15,
    linkLossAction: 'RTL',
    gcsLossAction: 'RTL',
  },
  pid: {
    yaw:      { kp: 0.40, ki: 0.05, kd: 0.00 },
    altitude: { kp: 0.80, ki: 0.10, kd: 0.04 },
    forward:  { kp: 0.60, ki: 0.08, kd: 0.02 },
  },
  units: 'metric',
  mapTiles: 'satellite',
  theme: 'dark',
};

/** The key the snapshot is stored under — in settings.json and in localStorage. */
export const SETTINGS_STORAGE_KEY = 'eis.settings';

/* ---- normalisation ----------------------------------------------------- */

type Dict = Record<string, unknown>;

function asDict(value: unknown): Dict | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Dict) : null;
}

function finiteNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function member<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function normaliseConnection(raw: unknown, base: ConnectionConfig): ConnectionConfig {
  const d = asDict(raw) ?? {};
  return {
    host: text(d.host, base.host),
    controlPort: finiteNumber(d.controlPort, base.controlPort),
    videoUrl: text(d.videoUrl, base.videoUrl),
    sitl: flag(d.sitl, base.sitl),
  };
}

function normaliseFailsafe(raw: unknown, base: FailsafeConfig): FailsafeConfig {
  const d = asDict(raw) ?? {};
  return {
    geofenceRadius: finiteNumber(d.geofenceRadius, base.geofenceRadius),
    maxAltitude: finiteNumber(d.maxAltitude, base.maxAltitude),
    batteryWarnPct: finiteNumber(d.batteryWarnPct, base.batteryWarnPct),
    batteryFailsafePct: finiteNumber(d.batteryFailsafePct, base.batteryFailsafePct),
    linkLossAction: member(d.linkLossAction, SAFETY_ACTIONS, base.linkLossAction),
    gcsLossAction: member(d.gcsLossAction, SAFETY_ACTIONS, base.gcsLossAction),
  };
}

function normaliseAxis(raw: unknown, base: PidAxisGains): PidAxisGains {
  const d = asDict(raw) ?? {};
  return {
    kp: finiteNumber(d.kp, base.kp),
    ki: finiteNumber(d.ki, base.ki),
    kd: finiteNumber(d.kd, base.kd),
  };
}

function normalisePid(raw: unknown, base: PidGains): PidGains {
  const d = asDict(raw) ?? {};
  return {
    yaw: normaliseAxis(d.yaw, base.yaw),
    altitude: normaliseAxis(d.altitude, base.altitude),
    forward: normaliseAxis(d.forward, base.forward),
  };
}

/**
 * Coerce any blob (a stored file, a partial patch, an updater result) into a
 * complete, well-typed AppSettings laid over `base`. Missing keys inherit
 * from `base`, wrong types fall back to `base`, unknown keys vanish, `theme`
 * is pinned to 'dark'. Never throws; always returns fresh objects so neither
 * `base` nor DEFAULT_SETTINGS is ever aliased by the live snapshot.
 */
export function normaliseSettings(raw: unknown, base: AppSettings = DEFAULT_SETTINGS): AppSettings {
  const d = asDict(raw) ?? {};
  return {
    connection: normaliseConnection(d.connection, base.connection),
    failsafe: normaliseFailsafe(d.failsafe, base.failsafe),
    pid: normalisePid(d.pid, base.pid),
    units: member(d.units, UNIT_SYSTEMS, base.units),
    mapTiles: member(d.mapTiles, MAP_TILE_SETS, base.mapTiles),
    theme: 'dark',
  };
}

/* ---- persistence adapters ---------------------------------------------- */

/**
 * Where a snapshot lives between runs. `read` returns the stored blob (or
 * undefined) and may be synchronous or a promise; `write` may return a promise
 * whose rejection the store swallows. Failures never reach the caller.
 */
export interface SettingsPersistence {
  read(): unknown;
  write(snapshot: AppSettings): unknown;
}

type BridgeSettings = NonNullable<Window['eis']>['settings'];

interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Electron shell: the snapshot is one key inside <userData>/settings.json. */
export function bridgePersistence(bridge: BridgeSettings, key: string = SETTINGS_STORAGE_KEY): SettingsPersistence {
  return {
    read: () => bridge.get<unknown>(key),
    write: (snapshot) => bridge.set(key, snapshot),
  };
}

/** Browser: JSON text under the same key in a Storage-like object. */
export function storagePersistence(storage: KeyValueStorage, key: string = SETTINGS_STORAGE_KEY): SettingsPersistence {
  return {
    read: () => {
      const raw = storage.getItem(key);
      return raw ? (JSON.parse(raw) as unknown) : undefined;
    },
    write: (snapshot) => storage.setItem(key, JSON.stringify(snapshot)),
  };
}

/** Nothing survives a reload; used when no storage is reachable. */
export const memoryPersistence: SettingsPersistence = {
  read: () => undefined,
  write: () => undefined,
};

/** Bridge when the Electron shell exposes one, else localStorage, else memory. */
export function detectPersistence(): SettingsPersistence {
  if (typeof window !== 'undefined' && window.eis?.settings) return bridgePersistence(window.eis.settings);
  try {
    if (typeof localStorage !== 'undefined' && localStorage) return storagePersistence(localStorage);
  } catch {
    /* storage access is denied in some embedded contexts — fall through */
  }
  return memoryPersistence;
}

/* ---- store ------------------------------------------------------------- */

export interface SettingsStore {
  get(): AppSettings;
  set(patch: Partial<AppSettings> | ((s: AppSettings) => AppSettings)): void;
  subscribe(cb: (s: AppSettings) => void): () => void;
  reset(): void;
  /** Resolves once the persisted snapshot (if any) has been applied. */
  ready(): Promise<AppSettings>;
}

export interface SettingsStoreOptions {
  persistence?: SettingsPersistence;
  defaults?: AppSettings;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof (value as PromiseLike<unknown>).then === 'function';
}

export function createSettingsStore(options: SettingsStoreOptions = {}): SettingsStore {
  const defaults = normaliseSettings(options.defaults, DEFAULT_SETTINGS);
  const persistence = options.persistence ?? detectPersistence();
  const listeners = new Set<(s: AppSettings) => void>();
  let snapshot: AppSettings = normaliseSettings(undefined, defaults);
  /** Count of local writes — the guard that stops a late hydration clobbering an edit. */
  let writes = 0;

  const publish = (): void => {
    // Iterate a copy so a listener may unsubscribe (itself or another) mid-notify.
    for (const cb of Array.from(listeners)) cb(snapshot);
  };

  const persist = (): void => {
    try {
      const outcome = persistence.write(snapshot);
      if (isThenable(outcome)) Promise.resolve(outcome).catch(() => undefined);
    } catch {
      /* persistence is best effort; the in-memory snapshot is already current */
    }
  };

  const replace = (next: AppSettings): void => {
    snapshot = next;
    writes += 1;
    persist();
    publish();
  };

  const adopt = (stored: unknown, writesWhenRead: number): void => {
    if (stored === undefined || stored === null) return;
    // An operator edit landed while the read was in flight. It has already
    // been persisted, so the stored blob is the stale one — keep the edit.
    if (writes !== writesWhenRead) return;
    snapshot = normaliseSettings(stored, defaults);
    publish();
  };

  const hydration: Promise<AppSettings> = (() => {
    const at = writes;
    let outcome: unknown;
    try {
      outcome = persistence.read();
    } catch {
      return Promise.resolve(snapshot);
    }
    if (isThenable(outcome)) {
      return Promise.resolve(outcome).then(
        (stored) => { adopt(stored, at); return snapshot; },
        () => snapshot,
      );
    }
    // Synchronous storage (localStorage) is applied before the first get().
    adopt(outcome, at);
    return Promise.resolve(snapshot);
  })();

  return {
    get: () => snapshot,
    set(patch) {
      const next = typeof patch === 'function'
        ? normaliseSettings(patch(snapshot), snapshot)
        : normaliseSettings(patch, snapshot);
      replace(next);
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    reset() {
      replace(normaliseSettings(undefined, defaults));
    },
    ready: () => hydration,
  };
}

export const settingsStore: SettingsStore = createSettingsStore();

/** React hook — re-renders the consuming component whenever settings change. */
export function useSettings(): AppSettings {
  return useSyncExternalStore(settingsStore.subscribe, settingsStore.get, settingsStore.get);
}
