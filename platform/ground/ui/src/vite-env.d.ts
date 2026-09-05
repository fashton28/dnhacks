/// <reference types="vite/client" />

import type {
  Anomaly, CapabilitiesMessage, ConnectionConfig, HealthEventMessage,
  IncidentReport, MissionPlan, RfEventMessage, SpectrumMessage, Telemetry,
  Verification,
} from './contract';
import type { VerificationContext } from '@planner/verifier';
import type { ObservationSummary } from '@planner/report';

export interface PlannerProposeResult {
  vehicleId: string;
  plan: MissionPlan;
  effectivePlan?: MissionPlan;
  verification: Verification;
  source: 'scripted' | 'live';
  attempts: 1 | 2;
  fallbackReason?: string;
  escalationReason?: string;
}

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
  /**
   * Optional (added by the Electron shells for the mission retrofit): load the
   * EIS_SITE_FILE-selected site JSON (default site/site.json, demo stub
   * site/site.stub.json) from disk in the main process. The shells return the
   * RAW JSON TEXT (site:load); the renderer accepts text or a parsed object
   * and validates either (eis-planner validateSite) before use. Absent in the
   * browser dev server, which fetches /site.json instead (served by the vite
   * siteFilePlugin). Always call via `window.eis?.loadSiteFile?.()`.
   */
  loadSiteFile?(): Promise<unknown>;
  /**
   * Optional (Electron shells): baked satellite change-detection assets from
   * ground/satellite/data — base64 PNGs + raw JSON text — or null when absent
   * (the renderer's bundled copies are the default path and remain the
   * fallback). Call via `window.eis?.loadSatelliteTiles?.()`.
   */
  loadSatelliteTiles?(): Promise<{
    beforePng: string;
    afterPng: string;
    tilesJson: string;
    anomaliesJson: string | null;
  } | null>;
  /** Constrained image resolver for paths declared by the selected site file. */
  resolveSiteAsset?(path: string): Promise<string | null>;
  plannerPropose?(input: {
    vehicleId: string;
    anomaly: Anomaly;
    telemetry?: Telemetry;
    capabilities?: CapabilitiesMessage;
    context: VerificationContext;
  }): Promise<PlannerProposeResult>;
  plannerReport?(input: {
    vehicleId: string;
    anomaly: Anomaly;
    plan: MissionPlan;
    observation: ObservationSummary;
  }): Promise<IncidentReport>;
  onPlannerEvent?(cb: (event: unknown) => void): () => void;
  sdrStart?(input?: { mode?: 'scripted' | 'live'; vehicleId?: string; scenario?: string }): Promise<unknown>;
  sdrStop?(): Promise<unknown>;
  sdrStatus?(): Promise<unknown>;
  onSdrEvent?(cb: (event: SpectrumMessage | RfEventMessage | HealthEventMessage) => void): () => void;
  /** Default connection config baked into the build (env/CLI overrides). */
  defaultConfig(): Promise<Partial<ConnectionConfig>>;
}

declare global {
  interface Window {
    eis?: ElectronBridge;
  }
}
