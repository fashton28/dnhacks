/* ============================================================================
 * Eye in the Sky — SettingsStore
 * ----------------------------------------------------------------------------
 * Singleton observable store for all persistent app settings. Backed by
 * window.eis?.settings (the Electron on-disk bridge) when present, otherwise
 * localStorage + in-memory. React components use useSettings() which re-renders
 * on every change (via useSyncExternalStore).
 *
 * PID apply path: gains are persisted here AND (when connected) map onto the
 * companion config keys guidance.gains.{yaw,altitude,forward}.{kp,ki,kd}. The
 * Settings modal documents this mapping next to the PID controls.
 * ========================================================================== */
import { useSyncExternalStore } from 'react';
import type { ConnectionConfig } from '@/contract';

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

export interface AppSettings {
  connection: ConnectionConfig;
  failsafe: FailsafeConfig;
  pid: PidGains;
  units: 'metric' | 'imperial';
  mapTiles: 'satellite' | 'terrain' | 'osm';
  theme: 'dark';
}

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

export interface SettingsStore {
  get(): AppSettings;
  set(patch: Partial<AppSettings> | ((s: AppSettings) => AppSettings)): void;
  subscribe(cb: (s: AppSettings) => void): () => void;
  reset(): void;
}

const STORAGE_KEY = 'eis.settings';

/** Deep-merge a stored/partial settings blob over a base so newly added keys
 *  always fall back to a sane default. */
function mergeSettings(base: AppSettings, patch: Partial<AppSettings> | undefined): AppSettings {
  if (!patch) return base;
  return {
    connection: { ...base.connection, ...patch.connection },
    failsafe: { ...base.failsafe, ...patch.failsafe },
    pid: {
      yaw: { ...base.pid.yaw, ...patch.pid?.yaw },
      altitude: { ...base.pid.altitude, ...patch.pid?.altitude },
      forward: { ...base.pid.forward, ...patch.pid?.forward },
    },
    units: patch.units ?? base.units,
    mapTiles: patch.mapTiles ?? base.mapTiles,
    theme: 'dark',
  };
}

function createSettingsStore(): SettingsStore {
  let current: AppSettings = { ...DEFAULT_SETTINGS };
  const listeners = new Set<(s: AppSettings) => void>();
  const bridge = typeof window !== 'undefined' ? window.eis?.settings : undefined;

  const emit = (): void => listeners.forEach((cb) => cb(current));

  const persist = (): void => {
    if (bridge) {
      bridge.set(STORAGE_KEY, current).catch(() => {
        /* best effort */
      });
      return;
    }
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
      } catch {
        /* best effort */
      }
    }
  };

  // Initial load (async for the bridge, sync for localStorage).
  if (bridge) {
    bridge
      .get<Partial<AppSettings>>(STORAGE_KEY)
      .then((stored) => {
        if (stored) {
          current = mergeSettings(DEFAULT_SETTINGS, stored);
          emit();
        }
      })
      .catch(() => {
        /* fall back to defaults */
      });
  } else if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) current = mergeSettings(DEFAULT_SETTINGS, JSON.parse(raw) as Partial<AppSettings>);
    } catch {
      /* fall back to defaults */
    }
  }

  return {
    get() {
      return current;
    },
    set(patch) {
      current =
        typeof patch === 'function' ? patch(current) : mergeSettings(current, patch);
      persist();
      emit();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    reset() {
      current = { ...DEFAULT_SETTINGS };
      persist();
      emit();
    },
  };
}

export const settingsStore: SettingsStore = createSettingsStore();

/** React hook — re-renders the consuming component whenever settings change. */
export function useSettings(): AppSettings {
  return useSyncExternalStore(
    (cb) => settingsStore.subscribe(cb),
    () => settingsStore.get(),
    () => settingsStore.get(),
  );
}
