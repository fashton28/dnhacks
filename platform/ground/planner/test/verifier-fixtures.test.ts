/* ============================================================================
 * V01-V25 verifier fixtures.
 *
 * The cases live in the repo-root `verifier_fixtures/` directory as
 * self-describing JSON: a plan, a runtime-context patch, and the verdict plus
 * failing checks the deterministic verifier must produce. Nothing about the
 * expectations is computed here — this suite only feeds each case to the real
 * `verifyMission` and compares. `verifier_fixtures/run_fixtures.mjs` runs the
 * same cases against the compiled `dist/` build outside vitest.
 * ========================================================================== */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { MissionPlan, Verification } from '../src/contract';
import { SiteModel, validateSite } from '../src/site';
import { CHECK_ORDER, VerificationContext, verifyMission } from '../src/verifier';

interface Expected {
  verdict: Verification['verdict'];
  failingChecks: string[];
  editedChecks?: string[];
  reasonContains?: Record<string, string[]>;
  editContains?: Record<string, string[]>;
}
interface Fixture {
  id: string;
  scenario: string;
  description: string;
  covers: string[];
  site: string;
  siteOverride?: Partial<SiteModel>;
  plan: MissionPlan;
  telemetry?: Record<string, unknown>;
  expected: Expected;
}

const ROOT = path.resolve(__dirname, '../../../verifier_fixtures');
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));

const ids = fs.readdirSync(ROOT).filter((file) => /^V\d\d\.json$/.test(file)).sort()
  .map((file) => file.replace('.json', ''));
const fixtures = ids.map((id) => readJson(`${id}.json`) as Fixture);
const baseline = readJson('baseline_context.json') as Record<string, unknown>;

/* Context assembly — see baseline_context.json `_fixture`. A case telemetry
 * block is merged over the healthy baseline, one level deep for these four
 * keys so a case can change one battery or sensor field without restating a
 * whole healthy vehicle; every other key is replaced outright. */
const DEEP_MERGED = ['battery', 'readiness', 'sensors', 'anomaly'];
function buildContext(telemetry: Record<string, unknown> = {}): VerificationContext {
  const context: Record<string, unknown> = { ...baseline };
  delete context._fixture;
  for (const [key, value] of Object.entries(telemetry)) {
    context[key] = DEEP_MERGED.includes(key) && value && typeof value === 'object' && !Array.isArray(value)
      ? { ...(context[key] as object ?? {}), ...value }
      : value;
  }
  return context as VerificationContext;
}

/** `siteOverride` patches the VALIDATED model, so a case can present geometry
 * the loader would have refused and prove the verifier re-checks it itself. */
function siteFor(fixture: Fixture): SiteModel {
  const loaded = validateSite(readJson(fixture.site));
  return fixture.siteOverride ? { ...loaded, ...fixture.siteOverride } : loaded;
}

describe('V01-V25 verifier fixtures', () => {
  it('carries exactly the documented case set', () => {
    expect(ids).toEqual(Array.from({ length: 25 }, (_, i) => `V${String(i + 1).padStart(2, '0')}`));
    expect(fixtures.map((f) => f.id)).toEqual(ids);
    expect(fixtures.every((f) => f.description.length > 0 && f.covers.length > 0)).toBe(true);
  });

  it('verifies against a site that satisfies the site contract', () => {
    const site = validateSite(readJson('site.fixture.json'));
    expect(site.clearAltitudeM).toBeGreaterThanOrEqual(site.altBandM.min);
    expect(site.clearAltitudeM).toBeLessThanOrEqual(site.altBandM.max);
    expect(site.nfzBufferM).toBe(25);
  });

  for (const fixture of fixtures) {
    describe(`${fixture.id} ${fixture.scenario}`, () => {
      const site = siteFor(fixture);
      const context = buildContext(fixture.telemetry);
      const result = verifyMission(fixture.plan, site, context);
      const { expected } = fixture;

      it('produces the expected verdict and failing checks', () => {
        expect(result.checks.map((check) => check.name)).toEqual([...CHECK_ORDER]);
        expect(result.checks.filter((check) => !check.ok).map((check) => check.name))
          .toEqual(expected.failingChecks);
        expect(result.verdict).toBe(expected.verdict);
      });

      it('reports the documented reasons and edits', () => {
        for (const [name, fragments] of Object.entries(expected.reasonContains ?? {})) {
          for (const fragment of fragments) {
            expect(result.checks.find((check) => check.name === name)?.reason).toContain(fragment);
          }
        }
        for (const [name, fragments] of Object.entries(expected.editContains ?? {})) {
          for (const fragment of fragments) {
            expect(result.checks.find((check) => check.name === name)?.edit).toContain(fragment);
          }
        }
        if (expected.editedChecks) {
          expect(result.checks.filter((check) => check.edit).map((check) => check.name))
            .toEqual(expected.editedChecks);
        }
      });

      it('releases a corrected plan only when that plan is itself clean', () => {
        if (result.verdict !== 'corrected') {
          expect(result.correctedPlan).toBeUndefined();
          return;
        }
        expect(result.correctedPlan).toBeDefined();
        const rechecked = verifyMission(result.correctedPlan as MissionPlan, site, context);
        expect(rechecked.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual([]);
        expect(rechecked.verdict).toBe('pass');
      });
    });
  }
});
