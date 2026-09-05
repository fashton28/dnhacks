/// <reference types="vite/client" />

import type { ConnectionConfig } from './contract';

/**
 * The secure bridge exposed by the Electron preload script (ground/app).
 * Present only when running inside the Electron shell; undefined in the
 * browser dev server. All renderer ↔ main I/O goes through this.
 */
export interface ElectronBridge {
  /** Persisted settings (backed by an on-disk JSON file via the main process). */
  settings: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    all(): Promise<Record<string, unknown>>;
  };
  /** Flight recording to disk (telemetry + tracking + statusText). */
  recorder: {
    start(meta?: Record<string, unknown>): Promise<{ sessionId: string }>;
    stop(): Promise<{ sessionId: string; path: string } | null>;
    append(record: unknown): void;
    list(): Promise<Array<{ id: string; path: string; startedAt: number; durationMs: number; size: number }>>;
    load(id: string): Promise<{ meta: Record<string, unknown>; frames: unknown[] } | null>;
  };
  /** App / platform metadata. */
  app: {
    version(): Promise<string>;
    platform: string;
  };
  /**
   * Linux only (LINUX_PRD §7): inhibit screen-blank/suspend while armed or
   * tracking/manual-active. Absent in the Windows shell and the browser dev
   * server — always call via `window.eis?.power?.…`.
   */
  power?: {
    inhibit(): Promise<void>;
    release(): Promise<void>;
  };
  /** Default connection config baked into the build (env/CLI overrides). */
  defaultConfig(): Promise<Partial<ConnectionConfig>>;
}

declare global {
  interface Window {
    eis?: ElectronBridge;
  }
}
