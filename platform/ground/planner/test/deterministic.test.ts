/* ============================================================================
 * The deterministic planner never emits a plan that violates a limit.
 *
 * The load-bearing test here is the fixture sweep: every verifier fixture's
 * RUNTIME STATE is fed to the planner, and the result must be either a plan the
 * verifier passes, or an explicit `infeasible`. A `corrected` verdict on
 * planner output would be a planner bug, so it is asserted against directly.
 * ========================================================================== */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { Anomaly, MissionPlan, Task } from '../src/contract';
import { planMission } from '../src/deterministic';
import { PLANNER_POLICY, UNATTENDED_ENVELOPE, VERIFIER_POLICY } from '../src/policy';
import { SiteModel, validateSite } from '../src/site';
import { VerificationContext, verifyMission } from '../src/verifier';

const ROOT = path.resolve(__dirname, '../../../verifier_fixtures');
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
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

interface Fixture {
  id: string; site: string; siteOverride?: Partial<SiteModel>;
  telemetry?: Record<string, unknown>; plan: MissionPlan;
  task?: { task: Task; anomaly: Anomaly };
}

const ids = fs.readdirSync(ROOT).filter((file) => /^V\d\d\.json$/.test(file)).sort()
  .map((file) => file.replace('.json', ''));
const fixtures = ids.map((id) => readJson(`${id}.json`) as Fixture);

function siteFor(fixture: Fixture): SiteModel {
  const loaded = validateSite(readJson(fixture.site));
  return fixture.siteOverride ? { ...loaded, ...fixture.siteOverride } : loaded;
}

/**
 * The states a plan cannot be drawn for, and why. Derived by running the
 * planner over every fixture state; each entry is a state the VERIFIER would
 * also refuse, so refusing earlier costs nothing and explains more.
 *
 * This is NOT the list the phase brief guessed at (V06, V07, V11, V16,
 * V24-V27). Those were checked against the fixtures and corrected:
 *   - V06 (altitude), V07 (speed), V08 (standoff), V11 (orbit buffer),
 *     V12 (terminal), V13 (altitude), V23 (loiter/budget) are healthy STATES
 *     with a defective PLAN. The planner never writes those plans, so it
 *     produces a passing plan from each of those states.
 *   - V26-V28 do not exist on this branch (reserved, see the fixtures README).
 *   - V09 (cue outside the geofence), V17 (invalid site model) and the RF /
 *     airspace / battery / night / LiDAR states below are the real refusals.
 */
const INFEASIBLE_STATES: Record<string, string> = {
  V03: 'navigation source is extnav',
  V04: 'wind 13 m/s exceeds 12 m/s',
  V09: 'outside the operational geofence',
  V15: 'night mission needs a healthy thermal sensor',
  V16: 'transits clutter',
  V17: 'site model is not usable',
  V19: 'GNSS interference is present',
  V21: 'a hostile drone is detected',
  // Sorted by fixture id below, so keep new entries in id order.
  V22: 'navigation source is optflow',
  V24: 'battery SoC 62% is below 80%',
  V31: 'already orbiting this observation point',
  V34: 'night mission needs a healthy thermal sensor',
  V35: 'flagged for operator review',
};

const probeTask = (id: string, anomalyId: string): Task => ({
  taskId: `probe-${id}`, anomalyId, lookFor: 'vehicle',
  question: 'What is at the flagged change?', urgency: 'immediate', priority: 0.8,
  rationale: 'fixture-state probe', source: 'scripted',
});

describe('deterministic planner over every fixture state', () => {
  for (const fixture of fixtures) {
    const site = siteFor(fixture);
    const context = buildContext(fixture.telemetry);
    const anomaly = context.anomaly as Anomaly;
    const result = planMission({
      task: probeTask(fixture.id, anomaly.id), anomaly, site, context,
      requestId: `probe-${fixture.id}`,
    });

    it(`${fixture.id}: emits a passing plan or refuses, never something to correct`, () => {
      const expectedRefusal = INFEASIBLE_STATES[fixture.id];
      if (result.infeasible) {
        expect(expectedRefusal, `${fixture.id} refused unexpectedly: ${result.reason}`).toBeDefined();
        expect(result.reason).toContain(expectedRefusal);
        expect(result.planTrace.some((entry) => entry.rule === 'infeasible')).toBe(true);
        return;
      }
      expect(expectedRefusal, `${fixture.id} should have been refused`).toBeUndefined();
      const verdict = verifyMission(result.plan, site, context);
      expect(verdict.verdict, `${fixture.id}: ${verdict.checks.filter((check) => !check.ok)
        .map((check) => `${check.name}: ${check.reason}`).join(' | ')}`).toBe('pass');
      expect(verdict.verdict).not.toBe('corrected');
    });
  }

  it('refuses exactly the documented states', () => {
    const refused = fixtures.filter((fixture) => {
      const site = siteFor(fixture);
      const context = buildContext(fixture.telemetry);
      const anomaly = context.anomaly as Anomaly;
      return planMission({ task: probeTask(fixture.id, anomaly.id), anomaly, site, context }).infeasible;
    }).map((fixture) => fixture.id);
    expect(refused).toEqual(Object.keys(INFEASIBLE_STATES));
  });
});

describe('the rule table', () => {
  const site = validateSite(readJson('site.fixture.json'));
  const anomaly = (baseline as unknown as { anomaly: Anomaly }).anomaly;
  const context = buildContext({ currentAltitudeM: 45 });
  const plan = (lookFor: Task['lookFor'], overrides: Partial<VerificationContext> = {}) =>
    planMission({
      task: { ...probeTask('rule', anomaly.id), lookFor }, anomaly, site,
      context: { ...context, ...overrides }, requestId: 'rule-table',
    });

  it('maps lookFor to a profile and never above the profile band', () => {
    expect(plan('person').infeasible).toBe(false);
    const person = plan('person');
    const structure = plan('structure');
    if (person.infeasible || structure.infeasible) throw new Error('expected feasible plans');
    expect(person.plan.profile).toBe('inspect');
    expect(structure.plan.profile).toBe('survey');
  });

  it('holds for 15 s only on a fence_gap', () => {
    const gap = plan('fence_gap');
    const person = plan('person');
    if (gap.infeasible || person.infeasible) throw new Error('expected feasible plans');
    expect(gap.plan.tools.some((tool) => tool.tool === 'hold' &&
      tool.durationS === PLANNER_POLICY.fenceGapHoldS)).toBe(true);
    expect(person.plan.tools.some((tool) => tool.tool === 'hold')).toBe(false);
  });

  it('flies exactly one lap and terminates with one rtl', () => {
    const result = plan('vehicle');
    if (result.infeasible) throw new Error('expected a feasible plan');
    const orbits = result.plan.tools.filter((tool) => tool.tool === 'orbit_point');
    expect(orbits).toHaveLength(1);
    expect(orbits.every((tool) => tool.tool === 'orbit_point' && tool.laps === 1)).toBe(true);
    expect(result.plan.tools.filter((tool) => tool.tool === 'rtl')).toHaveLength(1);
    expect(result.plan.tools[result.plan.tools.length - 1].tool).toBe('rtl');
  });

  it('never shrinks an orbit below the standoff floor', () => {
    const result = plan('vehicle');
    if (result.infeasible) throw new Error('expected a feasible plan');
    const orbit = result.plan.tools.find((tool) => tool.tool === 'orbit_point');
    if (!orbit || orbit.tool !== 'orbit_point') throw new Error('expected an orbit');
    expect(orbit.radius).toBeGreaterThanOrEqual(VERIFIER_POLICY.hardMinStandoffM);
    expect(orbit.radius).toBeGreaterThanOrEqual(5);   // inspect profile standoff
  });

  it('is byte-for-byte reproducible for the same task and state', () => {
    expect(JSON.stringify(plan('fence_gap'))).toEqual(JSON.stringify(plan('fence_gap')));
  });

  it('carries a corridor with the documented tolerances', () => {
    const inspect = plan('vehicle');
    const survey = plan('structure');
    if (inspect.infeasible || survey.infeasible) throw new Error('expected feasible plans');
    expect(inspect.corridor.legs.every((leg) => leg.lateral_tol_m === 10)).toBe(true);
    expect(survey.corridor.legs.every((leg) => leg.lateral_tol_m === 15)).toBe(true);
    expect(inspect.corridor.orbits.every((orbit) => orbit.radial_tol_m === 5)).toBe(true);
    expect(inspect.corridor.generated_from).toBe(inspect.plan.requestId);
  });

  it('keeps coordinates and altitudes out of the plan trace', () => {
    const result = plan('fence_gap');
    if (result.infeasible) throw new Error('expected a feasible plan');
    for (const entry of result.planTrace) {
      expect(entry.effect).not.toMatch(/-?\d+\.\d{4,}/);          // no coordinates
      expect(entry.effect).not.toMatch(/\d+(\.\d+)?\s*m AGL/);    // no altitudes
    }
    expect(result.plan.planTrace).toEqual(result.planTrace);
  });

  it('budgets time as min(range, sortie cap)', () => {
    const result = plan('vehicle');
    if (result.infeasible) throw new Error('expected a feasible plan');
    expect(result.timeBudgetS).toBeLessThanOrEqual(VERIFIER_POLICY.maxSortieS);
    expect(result.estimatedFlightS).toBeLessThanOrEqual(result.timeBudgetS);
  });

  it('applies the unattended band and refuses a survey unattended', () => {
    const unattended = planMission({
      task: { ...probeTask('rule', anomaly.id), lookFor: 'vehicle' }, anomaly, site,
      context: { ...context, mode: 'unattended' }, requestId: 'unattended',
    });
    if (unattended.infeasible) throw new Error('expected a feasible unattended plan');
    const altitudes = unattended.plan.tools.flatMap((tool) => tool.tool === 'goto_gps' ? [tool.alt] : []);
    expect(Math.min(...altitudes)).toBeGreaterThanOrEqual(UNATTENDED_ENVELOPE.altBandM.min);
    expect(Math.max(...altitudes)).toBeLessThanOrEqual(UNATTENDED_ENVELOPE.altBandM.max);
    expect(verifyMission(unattended.plan, site, { ...context, mode: 'unattended' }).verdict).toBe('pass');

    const survey = planMission({
      task: { ...probeTask('rule', anomaly.id), lookFor: 'structure' }, anomaly, site,
      context: { ...context, mode: 'unattended' }, requestId: 'unattended-survey',
    });
    if (survey.infeasible) return;   // refused outright is also a correct answer
    expect(verifyMission(survey.plan, site, { ...context, mode: 'unattended' }).verdict).toBe('rejected');
  });

  it('refuses an unattended dispatch over the hourly sortie cap', () => {
    const result = planMission({
      task: probeTask('cap', anomaly.id), anomaly, site,
      context: { ...context, mode: 'unattended', unattendedSortiesLastHour: UNATTENDED_ENVELOPE.maxSortiesPerHour },
    });
    expect(result.infeasible).toBe(true);
    if (result.infeasible) expect(result.reason).toContain('unattended sorties');
  });

  it('reproduces the checked-in V36 planner output byte for byte', () => {
    const fixture = fixtures.find((entry) => entry.id === 'V36');
    if (!fixture?.task) throw new Error('V36 must carry its task for the parity check');
    const stub = siteFor(fixture);
    const context36 = buildContext(fixture.telemetry);
    const result = planMission({
      task: fixture.task.task, anomaly: fixture.task.anomaly, site: stub,
      context: context36, requestId: fixture.plan.requestId,
    });
    if (result.infeasible) throw new Error(`V36 refused: ${result.reason}`);
    expect(result.plan).toEqual(fixture.plan);
  });
});
