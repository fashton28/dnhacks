/* ============================================================================
 * Drone Safety Platform — the cue rails, in the renderer (FM-180).
 *
 * `ground/cues` exports a `CueBus` that multiplexes seven rails onto the two
 * wire messages the UI already speaks — `anomaly` and `healthEvent` — and
 * nothing in `src/dataSource` consumed it, so the sentinel2 / sar / sdr /
 * rf_drone / cctv / fence_sensor / drone_survey rails never reached the map or
 * the task panel. This module is the renderer-side counterpart of the
 * package's Node factory (`eis-cues/node createCueBus`), which cannot be used
 * here because it reads its site, normalcy and fixtures off disk.
 *
 * It adds no wire message, no command and no plan. It decides only WHICH rails
 * are wired and WHERE their scripted fixtures come from; every rail's own
 * decoding, TTL expiry, blind-zone masking, whitelist and rate limiting is the
 * package's, unchanged, and the shared cue budget is the bus's.
 * ========================================================================== */
import { CueBus } from '@cues/bus';
import type { CueBusOptions, CueRejection } from '@cues/bus';
import { parseCueFixture } from '@cues/fixture';
import type { CueFixture } from '@cues/fixture';
import { parseCueSite } from '@cues/site';
import type { CueSite } from '@cues/site';
import { EMPTY_NORMALCY, parseNormalcy } from '@cues/normalcy';
import type { SiteNormalcy } from '@cues/normalcy';
import { RAIL_HEALTH_COMPONENT, RAIL_IDS } from '@cues/types';
import type { CueAdapter, RailHealth, RailId } from '@cues/types';
import { CctvRail } from '@cues/adapters/cctv';
import { DroneSurveyRail } from '@cues/adapters/drone_survey';
import { FenceSensorRail } from '@cues/adapters/fence_sensor';
import { RfDroneRail } from '@cues/adapters/rf_drone';
import { SarRail, Sentinel2Rail } from '@cues/adapters/satellite';
import { SdrRail } from '@cues/adapters/sdr';

import cctvEvents from '@cuefixtures/cctv_events.json';
import droneSurveyEvents from '@cuefixtures/drone_survey_events.json';
import fenceSensorEvents from '@cuefixtures/fence_sensor_events.json';
import normalcyFixture from '@cuefixtures/normalcy.json';
import rfDroneEvents from '@cuefixtures/rf_drone_events.json';
import sarEvents from '@cuefixtures/sar_events.json';
import sdrEvents from '@cuefixtures/sdr_events.json';
import sentinel2Events from '@cuefixtures/sentinel2_events.json';

export type { CueRejection, RailHealth, RailId };
export { CueBus, RAIL_HEALTH_COMPONENT, RAIL_IDS };

/** The bundled scripted fixture for each rail, keyed the same way as on disk. */
const FIXTURE_DATA: Record<RailId, unknown> = {
  sentinel2: sentinel2Events,
  sar: sarEvents,
  sdr: sdrEvents,
  rf_drone: rfDroneEvents,
  cctv: cctvEvents,
  fence_sensor: fenceSensorEvents,
  drone_survey: droneSurveyEvents,
};

/**
 * Parse the bundled fixture for one rail. A malformed fixture is a build-time
 * mistake, not a runtime condition, but it must not take the whole bus down
 * with it: the rail is left without a fixture and reports `failed` on start,
 * which is exactly how the package treats a rail with no source.
 */
export function bundledFixture(rail: RailId): CueFixture | undefined {
  try {
    return parseCueFixture(FIXTURE_DATA[rail], rail);
  } catch {
    return undefined;
  }
}

/** The bundled site normalcy window set (quiet hours, gates, deliveries). */
export function bundledNormalcy(): SiteNormalcy {
  try {
    return parseNormalcy(normalcyFixture);
  } catch {
    return EMPTY_NORMALCY;
  }
}

export interface RendererCueBusOptions extends CueBusOptions {
  /**
   * Raw site JSON (docs/SITE_CONTRACT.md). The cctv and fence_sensor rails
   * resolve a camera zone or a fence segment against it, so they are only
   * wired when a site is available — a rail that cannot place its cue would
   * emit coordinates it invented.
   */
  site?: unknown;
  normalcy?: SiteNormalcy;
  /** Rails to wire. Defaults to every rail the renderer can support. */
  rails?: RailId[];
}

/** Which rails a given site model can support. */
export function railsFor(site: CueSite | null): RailId[] {
  const needsSite = new Set<RailId>(['cctv', 'fence_sensor']);
  return RAIL_IDS.filter((rail) => site !== null || !needsSite.has(rail));
}

/**
 * Build the scripted cue bus the offline demo replays.
 *
 * Every rail runs from its bundled fixture: no network, no filesystem, no
 * Electron. The satellite rails are fixture-backed here rather than bound to
 * the real detector, because the renderer already runs `eis-satellite` itself
 * in the SatellitePanel and running it twice would double-count the same cue.
 */
export function createRendererCueBus(options: RendererCueBusOptions = {}): CueBus {
  let site: CueSite | null = null;
  if (options.site !== undefined) {
    try {
      site = parseCueSite(options.site);
    } catch {
      site = null;
    }
  }
  const normalcy = options.normalcy ?? bundledNormalcy();
  const wanted = new Set<RailId>(options.rails ?? railsFor(site));
  const common = {
    ...(options.vehicleId === undefined ? {} : { vehicleId: options.vehicleId }),
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
  };
  const withFixture = (rail: RailId) => {
    const fixture = bundledFixture(rail);
    return fixture ? { fixture } : {};
  };

  const adapters: CueAdapter[] = [];
  if (wanted.has('sentinel2')) adapters.push(new Sentinel2Rail({ ...common, ...withFixture('sentinel2') }));
  if (wanted.has('sar')) adapters.push(new SarRail({ ...common, ...withFixture('sar') }));
  if (wanted.has('sdr')) adapters.push(new SdrRail({ ...common, ...withFixture('sdr') }));
  if (wanted.has('rf_drone')) adapters.push(new RfDroneRail({ ...common, ...withFixture('rf_drone') }));
  if (site) {
    if (wanted.has('cctv')) {
      adapters.push(new CctvRail({ ...common, site, mode: 'event', normalcy, ...withFixture('cctv') }));
    }
    if (wanted.has('fence_sensor')) {
      adapters.push(new FenceSensorRail({ ...common, site, normalcy, ...withFixture('fence_sensor') }));
    }
  }
  if (wanted.has('drone_survey')) {
    adapters.push(new DroneSurveyRail({ ...common, ...withFixture('drone_survey') }));
  }

  const bus = new CueBus({
    ...(options.vehicleId === undefined ? {} : { vehicleId: options.vehicleId }),
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
  });
  bus.registerAll(adapters);
  return bus;
}

/* ---------------------------------------------------------------------------
 * Per-rail presentation. One place, so the map pin, the cue list and the rail
 * badge cannot disagree about which rail a cue came from.
 * ------------------------------------------------------------------------- */

/** Pin colour per cue rail (map + cue list). */
export const RAIL_PIN_COLOUR: Record<RailId, string> = {
  sentinel2: '#ffc24b',     // amber: the overhead optical rail
  sar: '#f5845c',           // warm orange: overhead radar
  sdr: '#ff6b66',           // red: RF spectrum
  rf_drone: '#c47dff',      // violet: a located hostile emitter
  drone_survey: '#58d68d',  // green: our own aircraft's survey
  cctv: '#4fc3f7',          // cyan: fixed cameras
  fence_sensor: '#ffe066',  // pale yellow: the fence line
};

/** Human label per rail, for badges and legends. */
export const RAIL_LABEL: Record<RailId, string> = {
  sentinel2: 'Optical',
  sar: 'SAR',
  sdr: 'SDR',
  rf_drone: 'RF drone',
  drone_survey: 'Survey',
  cctv: 'CCTV',
  fence_sensor: 'Fence',
};

/** The pin colour for a cue, by the rail that raised it. */
export function pinColourFor(source: string): string {
  return RAIL_PIN_COLOUR[source as RailId] ?? '#ffc24b';
}
