/**
 * preload.ts — the renderer's only door to the main process (`window.eis`).
 *
 * Runs in Electron's isolated preload world with `sandbox: true`, so nothing
 * here may `require` anything but 'electron' (no fs, no path). Every method on
 * the bridge is a thin relay to one IPC channel; the channel table below is
 * the single place a channel name appears in this file, and ipc.ts registers a
 * handler for each of them.
 *
 * Three relay kinds:
 *   request  — ipcRenderer.invoke: a promise the main process resolves
 *   post     — ipcRenderer.send: one-way, no ack. Used ONLY for
 *              recorder.append, which fires on every telemetry/tracking frame;
 *              a per-frame round trip would build backpressure in the renderer
 *   stream   — ipcRenderer.on: main pushes events; returns an unsubscribe
 *
 * The bridge type is re-declared here (not imported) so this package compiles
 * on its own. It mirrors `ground/ui/src/vite-env.d.ts` ElectronBridge exactly;
 * change both together.
 *
 * Linux delta vs ../../windows/src/preload.ts: the `power` namespace
 * (LINUX_PRD §7) — the renderer holds the display awake while armed or
 * tracking/manual-active. It is optional in the shared renderer type.
 */

import { contextBridge, ipcRenderer } from 'electron';

/* ── Channel table (must match ipc.ts) ──────────────────────────────────── */

const CHANNEL = {
  powerInhibit: 'power:inhibit',
  powerRelease: 'power:release',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsAll: 'settings:all',
  recorderStart: 'recorder:start',
  recorderStop: 'recorder:stop',
  recorderAppend: 'recorder:append',
  recorderList: 'recorder:list',
  recorderLoad: 'recorder:load',
  appVersion: 'app:version',
  appDefaultConfig: 'app:defaultConfig',
  siteLoad: 'site:load',
  siteResolveAsset: 'site:resolveAsset',
  plannerPropose: 'planner:propose',
  plannerReport: 'planner:report',
  plannerEvent: 'planner:event',
  sdrStart: 'sdr:start',
  sdrStop: 'sdr:stop',
  sdrStatus: 'sdr:status',
  sdrEvent: 'sdr:event',
} as const;

/* ── Bridge shape (mirrors ground/ui/src/vite-env.d.ts) ─────────────────── */

interface ConnectionConfig {
  host: string;
  controlPort: number;
  videoUrl: string;
  sitl: boolean;
}

interface RecorderSessionMeta {
  id: string;
  path: string;
  startedAt: number;
  durationMs: number;
  size: number;
}

interface SettingsBridge {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  all(): Promise<Record<string, unknown>>;
}

interface RecorderBridge {
  start(meta?: Record<string, unknown>): Promise<{ sessionId: string }>;
  stop(): Promise<{ sessionId: string; path: string } | null>;
  append(record: unknown): void;
  list(): Promise<RecorderSessionMeta[]>;
  load(id: string): Promise<{ meta: Record<string, unknown>; frames: unknown[] } | null>;
}

interface AppBridge {
  version(): Promise<string>;
  platform: string;
}

/** Linux power management (LINUX_PRD §7): hold / drop a display-sleep inhibitor. */
interface PowerBridge {
  inhibit(): Promise<void>;
  release(): Promise<void>;
}

type SdrStartInput = { mode?: 'scripted' | 'live'; vehicleId?: string; scenario?: string };

interface ElectronBridge {
  settings: SettingsBridge;
  recorder: RecorderBridge;
  app: AppBridge;
  power: PowerBridge;
  defaultConfig(): Promise<Partial<ConnectionConfig>>;
  /** Raw JSON text of the EIS_SITE_FILE-selected site model (docs/SITE_CONTRACT.md). */
  loadSiteFile(): Promise<string>;
  resolveSiteAsset(path: string): Promise<string | null>;
  plannerPropose(input: unknown): Promise<unknown>;
  plannerReport(input: unknown): Promise<unknown>;
  onPlannerEvent(callback: (event: unknown) => void): () => void;
  sdrStart(input?: SdrStartInput): Promise<unknown>;
  sdrStop(): Promise<unknown>;
  sdrStatus(): Promise<unknown>;
  onSdrEvent(callback: (event: unknown) => void): () => void;
}

/* ── Relay builders ─────────────────────────────────────────────────────── */

type Channel = (typeof CHANNEL)[keyof typeof CHANNEL];

function request<T>(channel: Channel): (...args: unknown[]) => Promise<T> {
  return (...args) => ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

function post(channel: Channel): (payload: unknown) => void {
  return (payload) => {
    ipcRenderer.send(channel, payload);
  };
}

function stream(channel: Channel): (callback: (event: unknown) => void) => () => void {
  return (callback) => {
    const relay = (_event: Electron.IpcRendererEvent, payload: unknown): void => callback(payload);
    ipcRenderer.on(channel, relay);
    return () => {
      ipcRenderer.removeListener(channel, relay);
    };
  };
}

/* ── Assembly ───────────────────────────────────────────────────────────── */

const settings: SettingsBridge = {
  get: <T = unknown>(key: string) => request<T | undefined>(CHANNEL.settingsGet)(key),
  set: (key, value) => request<void>(CHANNEL.settingsSet)(key, value),
  all: request<Record<string, unknown>>(CHANNEL.settingsAll),
};

const recorder: RecorderBridge = {
  start: (meta) => request<{ sessionId: string }>(CHANNEL.recorderStart)(meta),
  stop: request<{ sessionId: string; path: string } | null>(CHANNEL.recorderStop),
  append: post(CHANNEL.recorderAppend),
  list: request<RecorderSessionMeta[]>(CHANNEL.recorderList),
  load: (id) => request<{ meta: Record<string, unknown>; frames: unknown[] } | null>(CHANNEL.recorderLoad)(id),
};

const appInfo: AppBridge = {
  version: request<string>(CHANNEL.appVersion),
  // `process` in a sandboxed preload is a trimmed polyfill, but it does carry `platform`.
  platform: process.platform,
};

const power: PowerBridge = {
  inhibit: request<void>(CHANNEL.powerInhibit),
  release: request<void>(CHANNEL.powerRelease),
};

const bridge: ElectronBridge = {
  settings,
  recorder,
  app: appInfo,
  power,
  defaultConfig: request<Partial<ConnectionConfig>>(CHANNEL.appDefaultConfig),
  loadSiteFile: request<string>(CHANNEL.siteLoad),
  resolveSiteAsset: (path) => request<string | null>(CHANNEL.siteResolveAsset)(path),
  plannerPropose: (input) => request<unknown>(CHANNEL.plannerPropose)(input),
  plannerReport: (input) => request<unknown>(CHANNEL.plannerReport)(input),
  onPlannerEvent: stream(CHANNEL.plannerEvent),
  sdrStart: (input) => request<unknown>(CHANNEL.sdrStart)(input),
  sdrStop: request<unknown>(CHANNEL.sdrStop),
  sdrStatus: request<unknown>(CHANNEL.sdrStatus),
  onSdrEvent: stream(CHANNEL.sdrEvent),
};

contextBridge.exposeInMainWorld('eis', bridge);
