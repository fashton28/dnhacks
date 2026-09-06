/* ============================================================================
 * PARITY — the TypeScript planner/verifier against the `rails/` oracle.
 *
 * `rails/` (repo root) is a second, independent implementation of the same
 * rules, written in Python from the ADR and the contract, importing nothing
 * from `platform/`. This suite runs `python rails/eval_planner.py --json`,
 * runs the SAME fixtures through `src/deterministic.ts` and `src/verifier.ts`,
 * and compares. For every fixture:
 *
 *   - the verifier's VERDICT on the fixture's own plan,
 *   - `requiresOperator` — the attended check failing, or the runtime context
 *     carrying triage's lure flag,
 *   - the SET of non-pass check names,
 *   - the CORRECTED tool sequence, args agreeing within 1 m / 1 s,
 *   - the deterministic planner's planTrace RULE NAMES, its infeasibility, and
 *     the verdict its own plan earns.
 *
 * A mismatch is a bug in THIS port, not a reason to edit the oracle. The
 * oracle is only ever corrected against the specification, and only before a
 * first green run — otherwise "parity" would mean nothing more than "the
 * oracle was moved until it agreed".
 *
 * The interpreter comes from `EIS_PYTHON`. Without it the suite tries, in
 * order, the companion venv (`platform/companion/.venv/Scripts/python.exe` on
 * Windows, `bin/python` elsewhere), then `python3`, then `python`, and takes
 * the first that can import pydantic. If none can, the suite FAILS rather than
 * skipping: a parity harness that quietly does nothing is worse than none.
 * ========================================================================== */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

import { Anomaly, MissionPlan, PlanTool, Task } from '../src/contract';
import { planMission } from '../src/deterministic';
import { haversineMeters } from '../src/geometry';
import { SiteModel, validateSite } from '../src/site';
import { VerificationContext, verifyMission } from '../src/verifier';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'platform', 'verifier_fixtures');
const ORACLE = path.join(REPO_ROOT, 'rails', 'eval_planner.py');

/** Distance tolerance for a corrected coordinate/altitude/radius, metres. */
const TOLERANCE_M = 1;
/** Duration tolerance for a corrected hold, seconds. */
const TOLERANCE_S = 1;

/* ---------------------------------------------------------------------------
 * Fixture loading — the same assembly `verifier-fixtures.test.ts` uses.
 * ------------------------------------------------------------------------- */
interface Fixture {
  id: string;
  site: string;
  siteOverride?: Partial<SiteModel>;
  plan: MissionPlan;
  telemetry?: Record<string, unknown>;
  probeTask: Task;
  probeRequestId: string;
}

const readJson = (file: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, file), 'utf8'));

const ids = fs.readdirSync(FIXTURE_ROOT).filter((file) => /^V\d\d\.json$/.test(file)).sort()
  .map((file) => file.replace('.json', ''));
const fixtures = ids.map((id) => readJson(`${id}.json`) as Fixture);
const baseline = readJson('baseline_context.json') as Record<string, unknown>;
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

function siteFor(fixture: Fixture): SiteModel {
  const loaded = validateSite(readJson(fixture.site));
  return fixture.siteOverride ? { ...loaded, ...fixture.siteOverride } : loaded;
}

/* ---------------------------------------------------------------------------
 * The parity surface, computed on this side.
 * ------------------------------------------------------------------------- */
interface NormalTool {
  tool: string;
  lat?: number; lon?: number; alt?: number; radius?: number;
  laps?: number; durationS?: number; speed_mps?: number; profile?: string;
}

/** One tool sequence in the shape the oracle emits: wire aliases collapsed. */
function normaliseTools(tools: PlanTool[]): NormalTool[] {
  return tools.map((tool) => {
    const entry: NormalTool = { tool: tool.tool };
    const source = tool as unknown as Record<string, unknown>;
    for (const key of ['lat', 'lon', 'alt', 'radius', 'laps', 'durationS', 'speed_mps', 'profile'] as const) {
      if (source[key] !== undefined && source[key] !== null) {
        (entry as unknown as Record<string, unknown>)[key] = source[key];
      }
    }
    return entry;
  });
}

/**
 * Does this outcome need a human before anything flies? Derived from the two
 * facts the verifier already reports, identically on both sides: the
 * `attended` check failing (the unattended envelope refusing), or the runtime
 * context carrying triage's lure flag.
 */
function requiresOperator(checks: Array<{ name: string; ok: boolean }>,
  context: VerificationContext): boolean {
  return checks.some((check) => check.name === 'attended' && !check.ok) ||
    Boolean(context.requiresOperator);
}

interface OracleFixture {
  id: string;
  verify: {
    verdict: string;
    requiresOperator: boolean;
    failingChecks: string[];
    correctedTools: NormalTool[] | null;
    holdUntil: number | null;
  };
  plan: {
    infeasible: boolean;
    reason: string | null;
    planTraceRules: string[];
    verdict: string | null;
    requiresOperator: boolean | null;
    tools: NormalTool[] | null;
    profile: string | null;
  };
}

function evaluateHere(fixture: Fixture): OracleFixture {
  const site = siteFor(fixture);
  const context = buildContext(fixture.telemetry);
  const anomaly = context.anomaly as Anomaly;

  const verification = verifyMission(fixture.plan, site, context);
  const verify = {
    verdict: verification.verdict,
    requiresOperator: requiresOperator(verification.checks, context),
    failingChecks: verification.checks.filter((check) => !check.ok).map((check) => check.name),
    correctedTools: verification.correctedPlan
      ? normaliseTools(verification.correctedPlan.tools) : null,
    holdUntil: verification.holdUntil ?? null,
  };

  const planned = planMission({
    task: fixture.probeTask, anomaly, site, context, requestId: fixture.probeRequestId,
  });
  if (planned.infeasible) {
    return {
      id: fixture.id,
      verify,
      plan: {
        infeasible: true, reason: planned.reason,
        planTraceRules: planned.planTrace.map((entry) => entry.rule),
        verdict: null, requiresOperator: null, tools: null, profile: null,
      },
    };
  }
  const replanned = verifyMission(planned.plan, site, context);
  return {
    id: fixture.id,
    verify,
    plan: {
      infeasible: false, reason: null,
      planTraceRules: planned.planTrace.map((entry) => entry.rule),
      verdict: replanned.verdict,
      requiresOperator: requiresOperator(replanned.checks, context),
      tools: normaliseTools(planned.plan.tools),
      profile: planned.plan.profile,
    },
  };
}

/* ---------------------------------------------------------------------------
 * Running the oracle.
 * ------------------------------------------------------------------------- */
function pythonCandidates(): string[] {
  const configured = process.env.EIS_PYTHON;
  const venv = process.platform === 'win32'
    ? path.join(REPO_ROOT, 'platform', 'companion', '.venv', 'Scripts', 'python.exe')
    : path.join(REPO_ROOT, 'platform', 'companion', '.venv', 'bin', 'python');
  return [...(configured ? [configured] : []), venv, 'python3', 'python'];
}

function resolvePython(): string {
  const tried: string[] = [];
  for (const candidate of pythonCandidates()) {
    const probe = spawnSync(candidate, ['-c', 'import pydantic'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
    tried.push(`${candidate} (${probe.error ? probe.error.message : `exit ${probe.status}`})`);
  }
  throw new Error(
    'no Python interpreter with pydantic was found for the rails oracle. Set EIS_PYTHON to ' +
    `one (e.g. the companion venv). Tried: ${tried.join('; ')}`,
  );
}

function runOracle(python: string): Record<string, OracleFixture> {
  const result = spawnSync(python, [ORACLE, '--json'], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`rails/eval_planner.py --json failed (exit ${result.status}): ${result.stderr}`);
  }
  const document = JSON.parse(result.stdout) as {
    fixtures: OracleFixture[]; summary: { violations: unknown[] };
  };
  expect(document.summary.violations,
    'the oracle itself must answer pass or infeasible for every fixture state').toEqual([]);
  return Object.fromEntries(document.fixtures.map((entry) => [entry.id, entry]));
}

/* ---------------------------------------------------------------------------
 * Comparisons.
 * ------------------------------------------------------------------------- */
function expectToolsAgree(ours: NormalTool[] | null, theirs: NormalTool[] | null, label: string): void {
  if (ours === null || theirs === null) {
    expect(ours, `${label}: one side emitted tools and the other did not`).toEqual(theirs);
    return;
  }
  expect(ours.map((tool) => tool.tool), `${label}: tool sequence`).toEqual(theirs.map((tool) => tool.tool));
  ours.forEach((tool, index) => {
    const other = theirs[index];
    const where = `${label} tool ${index} (${tool.tool})`;
    if (tool.lat !== undefined || other.lat !== undefined) {
      expect(tool.lat, `${where}: one side has no latitude`).toBeTypeOf('number');
      expect(other.lat, `${where}: one side has no latitude`).toBeTypeOf('number');
      const metres = haversineMeters(
        { lat: tool.lat as number, lon: tool.lon as number },
        { lat: other.lat as number, lon: other.lon as number },
      );
      expect(metres, `${where}: position differs by ${metres.toFixed(3)} m`).toBeLessThanOrEqual(TOLERANCE_M);
    }
    for (const key of ['alt', 'radius', 'speed_mps'] as const) {
      if (tool[key] !== undefined || other[key] !== undefined) {
        expect(Math.abs((tool[key] ?? NaN) - (other[key] ?? NaN)),
          `${where}: ${key} ${tool[key]} vs ${other[key]}`).toBeLessThanOrEqual(TOLERANCE_M);
      }
    }
    if (tool.durationS !== undefined || other.durationS !== undefined) {
      expect(Math.abs((tool.durationS ?? NaN) - (other.durationS ?? NaN)),
        `${where}: hold duration`).toBeLessThanOrEqual(TOLERANCE_S);
    }
    expect(tool.laps, `${where}: laps`).toEqual(other.laps);
    expect(tool.profile, `${where}: profile`).toEqual(other.profile);
  });
}

/* ---------------------------------------------------------------------------
 * The suite.
 * ------------------------------------------------------------------------- */
describe('rails oracle parity', () => {
  let oracle: Record<string, OracleFixture>;

  beforeAll(() => {
    expect(fs.existsSync(ORACLE), `the rails oracle is missing at ${ORACLE}`).toBe(true);
    oracle = runOracle(resolvePython());
  });

  it('covers exactly the same fixture set on both sides', () => {
    expect(Object.keys(oracle).sort()).toEqual(ids);
    expect(fixtures.every((fixture) => fixture.probeTask && fixture.probeRequestId)).toBe(true);
  });

  for (const fixture of fixtures) {
    describe(fixture.id, () => {
      it('agrees on the verdict, requiresOperator and the failing checks', () => {
        const mine = evaluateHere(fixture);
        const theirs = oracle[fixture.id];
        expect(theirs, `${fixture.id} is missing from the oracle document`).toBeDefined();
        expect(mine.verify.verdict, `${fixture.id}: verdict`).toEqual(theirs.verify.verdict);
        expect(mine.verify.requiresOperator, `${fixture.id}: requiresOperator`)
          .toEqual(theirs.verify.requiresOperator);
        expect(new Set(mine.verify.failingChecks), `${fixture.id}: non-pass checks`)
          .toEqual(new Set(theirs.verify.failingChecks));
        // The order is CHECK_ORDER on both sides, so the sets being equal
        // should mean the lists are too; assert it rather than assume it.
        expect(mine.verify.failingChecks).toEqual(theirs.verify.failingChecks);
      });

      it('agrees on the corrected tool sequence within 1 m / 1 s', () => {
        const mine = evaluateHere(fixture);
        const theirs = oracle[fixture.id];
        expectToolsAgree(mine.verify.correctedTools, theirs.verify.correctedTools,
          `${fixture.id} corrected`);
      });

      it('agrees on what the deterministic planner does with this state', () => {
        const mine = evaluateHere(fixture);
        const theirs = oracle[fixture.id];
        expect(mine.plan.infeasible, `${fixture.id}: infeasible (${mine.plan.reason ?? ''} / ${
          theirs.plan.reason ?? ''})`).toEqual(theirs.plan.infeasible);
        expect(mine.plan.planTraceRules, `${fixture.id}: planTrace rule names`)
          .toEqual(theirs.plan.planTraceRules);
        expect(mine.plan.verdict, `${fixture.id}: verdict on the planner's own plan`)
          .toEqual(theirs.plan.verdict);
        expect(mine.plan.requiresOperator).toEqual(theirs.plan.requiresOperator);
        expect(mine.plan.profile).toEqual(theirs.plan.profile);
        expectToolsAgree(mine.plan.tools, theirs.plan.tools, `${fixture.id} planned`);
      });
    });
  }

  it('never lets the planner emit something the verifier has to correct', () => {
    for (const fixture of fixtures) {
      const mine = evaluateHere(fixture);
      if (mine.plan.infeasible) continue;
      expect(mine.plan.verdict, `${fixture.id}: the planner emitted a plan the verifier ${
        mine.plan.verdict}`).toBe('pass');
    }
  });
});
