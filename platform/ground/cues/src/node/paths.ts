/* ============================================================================
 * eis-cues/node — file selection.
 *
 * The site file is selected exactly as docs/SITE_CONTRACT.md requires:
 * `EIS_SITE_FILE` (repo-root-relative or absolute), defaulting to
 * `site/site.json`. Demo scripts and tests select `site/site.stub.json`
 * EXPLICITLY; nothing here copies, generates or edits a site file.
 *
 * Fixtures and calibration live inside this package, so they resolve from the
 * module URL and work from src/ under vitest and from dist/ after a build.
 * ========================================================================== */

import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

export const DEFAULT_SITE_FILE = 'site/site.json';

/** Absolute path of ground/cues/fixtures. */
export function fixturesDir(): string {
  return fileURLToPath(new URL('../../fixtures/', import.meta.url));
}

/** Absolute path of the ground/cues package root. */
export function packageDir(): string {
  return fileURLToPath(new URL('../../', import.meta.url));
}

/**
 * Resolve the selected site file. Pure path math — existence is the caller's
 * problem, and an explicitly selected missing file is an error, not a fallback.
 */
export function resolveSiteFile(
  repoRoot: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const selected = env.EIS_SITE_FILE && env.EIS_SITE_FILE.trim() !== ''
    ? env.EIS_SITE_FILE
    : DEFAULT_SITE_FILE;
  return path.isAbsolute(selected) ? selected : path.resolve(repoRoot, selected);
}
