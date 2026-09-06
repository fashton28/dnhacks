/* Shared test helpers. The stub site file is selected EXPLICITLY, per
 * docs/SITE_CONTRACT.md — tests never rely on the production default. */

import { fileURLToPath } from 'node:url';

import { loadCueSiteFrom } from '../src/node/load.js';
import type { CueSite } from '../src/site.js';
import type { AnomalyMessage, HealthEventMessage } from '../src/contract.js';
import type { CueAdapter } from '../src/types.js';

/** Absolute path of platform/ (the repo root these paths are relative to). */
export const PLATFORM_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export const STUB_SITE_PATH = fileURLToPath(new URL('../../../site/site.stub.json', import.meta.url));

export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

export function stubSite(): CueSite {
  return loadCueSiteFrom(STUB_SITE_PATH);
}

/** A quiet site-local instant: Thursday 00:00 site time (UTC-360), outside
 *  every normalcy window in fixtures/normalcy.json. */
export const QUIET_START_MS = Date.UTC(2024, 0, 11, 6, 0, 0);

/** Wednesday 08:00 site time — inside staffed hours and the east-service-gate window. */
export const STAFFED_START_MS = Date.UTC(2024, 0, 10, 14, 0, 0);

/** Thursday 09:00 site time — inside the switchyard delivery window (days 2 and 4). */
export const DELIVERY_START_MS = Date.UTC(2024, 0, 11, 15, 0, 0);

export interface Recorder {
  anomalies: AnomalyMessage[];
  health: HealthEventMessage[];
}

/** Subscribe to a rail (or anything with the same two channels). */
export function record(adapter: Pick<CueAdapter, 'onAnomaly' | 'onHealth'>): Recorder {
  const out: Recorder = { anomalies: [], health: [] };
  adapter.onAnomaly((m) => out.anomalies.push(m));
  adapter.onHealth((m) => out.health.push(m));
  return out;
}
