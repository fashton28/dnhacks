/* ============================================================================
 * eis-cues/node — Node entry point: file loading, the ground/satellite bridge,
 * the RTSP frame source, and one factory that wires the whole bus.
 *
 * Re-exports the browser-safe core, so a Node consumer imports only this.
 * ========================================================================== */

export * from '../index.js';

export {
  DEFAULT_SITE_FILE, fixturesDir, packageDir, resolveSiteFile,
} from './paths.js';

export {
  CALIBRATION_FILE, NORMALCY_FILE, fixturePath, loadCalibrations, loadCueSite,
  loadCueSiteFrom, loadFixture, loadFixtureIfPresent, loadNormalcy,
} from './load.js';

export type { SatelliteModule } from './satellite.js';
export {
  clearSatelliteCache, defaultSarDataDir, loadSatelliteModule, sarSource,
  satelliteEntryCandidates, sentinel2Source,
} from './satellite.js';

export type { RtspFrameSourceOptions } from './ffmpeg.js';
export {
  DEFAULT_FRAME_FPS, MAX_FRAME_FPS, RtspFrameSource, ffmpegAvailable, readPngSize,
} from './ffmpeg.js';

import { CueBus, type CueBusOptions } from '../bus.js';
import type { Scheduler } from '../scheduler.js';
import type { CueAdapter, RailId } from '../types.js';
import type { CueSite } from '../site.js';
import type { SiteNormalcy } from '../normalcy.js';
import { CctvRail, type CctvMode } from '../adapters/cctv.js';
import { DroneSurveyRail } from '../adapters/drone_survey.js';
import { FenceSensorRail } from '../adapters/fence_sensor.js';
import { RfDroneRail } from '../adapters/rf_drone.js';
import { SarRail, Sentinel2Rail } from '../adapters/satellite.js';
import { SdrRail } from '../adapters/sdr.js';
import { loadCalibrations, loadCueSite, loadFixtureIfPresent, loadNormalcy } from './load.js';
import { sarSource, sentinel2Source } from './satellite.js';

/** Pixel mode is the fallback and must be asked for explicitly. */
export function resolveCctvMode(env: NodeJS.ProcessEnv = process.env): CctvMode {
  return env.EIS_CCTV_MODE === 'pixel' ? 'pixel' : 'event';
}

export interface CreateCueBusOptions extends CueBusOptions {
  /** Repo root used to resolve EIS_SITE_FILE. Defaults to process.cwd(). */
  repoRoot?: string;
  /** Pre-loaded site slice, when the caller already has one. */
  site?: CueSite;
  normalcy?: SiteNormalcy;
  /**
   * Rails to wire. Defaults to every rail that has a fixture, plus the two
   * satellite rails. A rail with neither a source nor a fixture reports
   * `failed` — it is never left looking nominal.
   */
  rails?: RailId[];
  /** Replay scripted fixtures. Default true; live wiring is opt-in per rail. */
  scripted?: boolean;
  /** Bind the sentinel2/sar rails to the real ground/satellite package. */
  useSatellite?: boolean;
  cctvMode?: CctvMode;
  scheduler?: Scheduler;
  env?: NodeJS.ProcessEnv;
}

/**
 * Build a bus with every cue rail wired for offline operation.
 *
 * Scripted mode replays `fixtures/<rail>_events.json`; `useSatellite` binds the
 * two satellite rails to the real detector in ground/satellite instead.
 */
export function createCueBus(options: CreateCueBusOptions = {}): CueBus {
  const env = options.env ?? process.env;
  const scripted = options.scripted ?? true;
  const site = options.site ?? loadCueSite(options.repoRoot);
  const normalcy = options.normalcy ?? loadNormalcy();
  const cctvMode = options.cctvMode ?? resolveCctvMode(env);
  const wanted = new Set<RailId>(
    options.rails ?? ['sentinel2', 'sar', 'sdr', 'rf_drone', 'cctv', 'fence_sensor', 'drone_survey'],
  );
  const scheduler = options.scheduler;
  const common = {
    ...(options.vehicleId === undefined ? {} : { vehicleId: options.vehicleId }),
    ...(scheduler === undefined ? {} : { scheduler }),
  };
  const fixture = (rail: RailId) => (scripted ? loadFixtureIfPresent(rail) : undefined);

  const adapters: CueAdapter[] = [];
  if (wanted.has('sentinel2')) {
    adapters.push(new Sentinel2Rail({
      ...common,
      ...(options.useSatellite ? { source: sentinel2Source({ env }) } : {}),
      ...(fixture('sentinel2') ? { fixture: fixture('sentinel2') } : {}),
    }));
  }
  if (wanted.has('sar')) {
    adapters.push(new SarRail({
      ...common,
      ...(options.useSatellite
        ? { source: sarSource({ env, ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }) }) }
        : {}),
      ...(fixture('sar') ? { fixture: fixture('sar') } : {}),
    }));
  }
  if (wanted.has('sdr')) {
    adapters.push(new SdrRail({ ...common, ...(fixture('sdr') ? { fixture: fixture('sdr') } : {}) }));
  }
  if (wanted.has('rf_drone')) {
    adapters.push(new RfDroneRail({
      ...common,
      ...(fixture('rf_drone') ? { fixture: fixture('rf_drone') } : {}),
    }));
  }
  if (wanted.has('cctv')) {
    adapters.push(new CctvRail({
      ...common,
      site,
      mode: cctvMode,
      ...(normalcy ? { normalcy } : {}),
      ...(cctvMode === 'pixel' ? { calibrations: loadCalibrations() } : {}),
      ...(fixture('cctv') ? { fixture: fixture('cctv') } : {}),
    }));
  }
  if (wanted.has('fence_sensor')) {
    adapters.push(new FenceSensorRail({
      ...common,
      site,
      ...(normalcy ? { normalcy } : {}),
      ...(fixture('fence_sensor') ? { fixture: fixture('fence_sensor') } : {}),
    }));
  }
  if (wanted.has('drone_survey')) {
    adapters.push(new DroneSurveyRail({
      ...common,
      ...(fixture('drone_survey') ? { fixture: fixture('drone_survey') } : {}),
    }));
  }

  const bus = new CueBus({
    ...(options.vehicleId === undefined ? {} : { vehicleId: options.vehicleId }),
    ...(scheduler === undefined ? {} : { scheduler }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
  });
  bus.registerAll(adapters);
  return bus;
}
