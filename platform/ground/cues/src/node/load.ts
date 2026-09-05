/* ============================================================================
 * eis-cues/node — loading the offline inputs: fixtures, site slice, normalcy,
 * calibration. All synchronous, all local; nothing here touches the network.
 * ========================================================================== */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseCueFixture, type CueFixture } from '../fixture.js';
import { parseNormalcy, type SiteNormalcy } from '../normalcy.js';
import { parseCueSite, type CueSite } from '../site.js';
import { parseCalibrations, type CameraCalibration } from '../cctv/pixel.js';
import type { RailId } from '../types.js';
import { fixturesDir, resolveSiteFile } from './paths.js';

function readJson(filePath: string, what: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`${what} not readable: ${filePath} (${(err as Error).message})`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${what} is not valid JSON: ${filePath} (${(err as Error).message})`);
  }
}

/** Path of a rail's scripted fixture: `fixtures/<railId>_events.json`. */
export function fixturePath(rail: RailId, dir: string = fixturesDir()): string {
  return join(dir, `${rail}_events.json`);
}

/** Load one rail's scripted fixture. A missing fixture is an error: scripted
 *  mode is selected explicitly, so a silent fallback would hide the mistake. */
export function loadFixture(rail: RailId, dir: string = fixturesDir()): CueFixture {
  return parseCueFixture(readJson(fixturePath(rail, dir), `cue fixture for ${rail}`), rail);
}

/** Load a rail's fixture if it exists, else undefined (for optional rails). */
export function loadFixtureIfPresent(
  rail: RailId,
  dir: string = fixturesDir(),
): CueFixture | undefined {
  return existsSync(fixturePath(rail, dir)) ? loadFixture(rail, dir) : undefined;
}

/** Load the cue-rail slice of the EIS_SITE_FILE-selected site model. */
export function loadCueSite(repoRoot: string = process.cwd()): CueSite {
  const filePath = resolveSiteFile(repoRoot);
  return parseCueSite(readJson(filePath, 'site file'));
}

export function loadCueSiteFrom(filePath: string): CueSite {
  return parseCueSite(readJson(filePath, 'site file'));
}

export const NORMALCY_FILE = 'normalcy.json';
export const CALIBRATION_FILE = 'cctv_calibration.json';

/** Load site normalcy. Absent normalcy means "nothing is explained away". */
export function loadNormalcy(dir: string = fixturesDir()): SiteNormalcy | undefined {
  const filePath = join(dir, NORMALCY_FILE);
  if (!existsSync(filePath)) return undefined;
  return parseNormalcy(readJson(filePath, 'site normalcy'));
}

/** Load CCTV pixel calibration. Absent calibration means no camera can produce
 *  a pixel cue — never that projection proceeds uncalibrated. */
export function loadCalibrations(dir: string = fixturesDir()): CameraCalibration[] {
  const filePath = join(dir, CALIBRATION_FILE);
  if (!existsSync(filePath)) return [];
  return parseCalibrations(readJson(filePath, 'cctv calibration'));
}
