/**
 * CLI smoke tests — run the BUILT dist/cli.js under Node exactly the way the
 * Python e2e gate / demo scripts will. `npm test` builds before vitest runs,
 * so dist/ is always current here.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeAll, describe, expect, it } from 'vitest';

import stubSite from '../../../site/site.stub.json';
import { Anomaly, MissionPlan, Verification } from '../src/contract';

const pkgRoot = path.resolve(__dirname, '..');
const cliJs = path.join(pkgRoot, 'dist', 'cli.js');

let dir: string;
let sitePath: string;
let anomalyPath: string;
let contextPath: string;

const anomaly: Anomaly = {
  id: 'cli-anom',
  lat: stubSite.staging[0].lat,
  lon: stubSite.staging[0].lon,
  type: 'change',
  confidence: 0.85,
  thumbnail: 'site/staging/stage-a.png',
  source: 'sentinel2',
};

function runCli(args: string[]): string {
  return execFileSync(process.execPath, [cliJs, ...args], { encoding: 'utf8' });
}

beforeAll(() => {
  expect(fs.existsSync(cliJs), `built CLI missing at ${cliJs} — run npm run build`).toBe(true);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eis-planner-cli-'));
  sitePath = path.join(dir, 'site.json');
  anomalyPath = path.join(dir, 'anomaly.json');
  fs.writeFileSync(sitePath, JSON.stringify(stubSite));
  fs.writeFileSync(anomalyPath, JSON.stringify(anomaly));
  contextPath = path.join(dir, 'scripted-ready-context.json');
  fs.writeFileSync(contextPath, JSON.stringify({
    navSource: 'gps', readiness: { ready: true, reasons: [] },
    battery: { soc_pct: 90, voltage_v: 24, current_a: 1, cell_delta_v: 0.02,
      temp_c: 25, remaining_s: 1200, charge_state: 'charged', fault: '',
      voltage: 24, current: 1, remaining: 90 },
    windMps: 0, anomaly, rfEvents: [], sdrState: 'nominal',
    sensors: { rgb: 'ok', thermal: 'ok', lidar: 'ok' }, isNight: false,
  }));
});

describe('cli', () => {
  it('plan --scripted emits a MissionPlan; verify passes it (exit 0)', () => {
    const planOut = runCli(['plan', '--scripted', anomalyPath, sitePath]);
    const plan = JSON.parse(planOut) as MissionPlan;
    expect(plan.anomalyId).toBe(anomaly.id);
    expect(plan.tools[plan.tools.length - 1].tool).toBe('rtl');

    const planPath = path.join(dir, 'plan.json');
    fs.writeFileSync(planPath, planOut);
    const verification = JSON.parse(runCli(['verify', planPath, sitePath, '--context', contextPath])) as Verification;
    expect(verification.requestId).toBe(plan.requestId);
    expect(verification.verdict).toBe('pass');
  });

  it('plan --scripted --failing round-trips to a non-pass verdict, still exit 0', () => {
    const planOut = runCli(['plan', '--scripted', anomalyPath, sitePath, '--failing']);
    const planPath = path.join(dir, 'failing-plan.json');
    fs.writeFileSync(planPath, planOut);
    const verification = JSON.parse(runCli(['verify', planPath, sitePath, '--context', contextPath])) as Verification;
    expect(['rejected', 'corrected']).toContain(verification.verdict);
    const byName = Object.fromEntries(verification.checks.map((c) => [c.name, c]));
    expect(byName.nfz_transit.ok && byName.nfz_orbit.ok).toBe(false);
    expect(byName.altitude.ok).toBe(false);
  });

  it('verify honours a fail-closed runtime context file', () => {
    const planOut = runCli(['plan', '--scripted', anomalyPath, sitePath]);
    const planPath = path.join(dir, 'plan-t.json');
    fs.writeFileSync(planPath, planOut);
    const low = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
    low.battery.soc_pct = 20;
    const telemPath = path.join(dir, 'low-context.json');
    fs.writeFileSync(telemPath, JSON.stringify(low));
    const verification = JSON.parse(
      runCli(['verify', planPath, sitePath, '--context', telemPath]),
    ) as Verification;
    expect(verification.verdict).toBe('rejected'); // 20% cannot cover reserve
    expect(verification.checks.find((c) => c.name === 'range')!.ok).toBe(false);
  });

  it('report emits an IncidentReport', () => {
    const planOut = runCli(['plan', '--scripted', anomalyPath, sitePath]);
    const inputPath = path.join(dir, 'report-input.json');
    fs.writeFileSync(inputPath, JSON.stringify({
      anomaly,
      plan: JSON.parse(planOut),
      observation: { detected: true, confidence: 0.9, stagingTruth: 'vehicle' },
    }));
    const report = JSON.parse(runCli(['report', inputPath])) as {
      missionId: string; verdict: string; markdown: string;
    };
    expect(report.verdict).toBe('escalate');
    expect(report.markdown).toContain('## Recommendation');
  });

  it('plan --task emits the deterministic plan and verify passes it', () => {
    const taskPath = path.join(dir, 'task.json');
    fs.writeFileSync(taskPath, JSON.stringify({
      requestId: 'cli-task-1',
      task: {
        taskId: 'cli-task-1', anomalyId: anomaly.id, lookFor: 'fence_gap',
        question: 'Is the fence line open at the cue?', urgency: 'immediate',
        priority: 0.9, rationale: 'cli smoke', source: 'scripted',
      },
      anomaly,
    }));
    const planOut = runCli(['plan', '--task', taskPath, sitePath, '--context', contextPath]);
    const plan = JSON.parse(planOut) as MissionPlan & { planTrace?: unknown[]; corridor?: unknown };
    expect(plan.requestId).toBe('cli-task-1');
    expect(plan.tools[plan.tools.length - 1].tool).toBe('rtl');
    expect(plan.tools.some((tool) => tool.tool === 'hold')).toBe(true);
    expect(Array.isArray(plan.planTrace)).toBe(true);
    expect(plan.corridor).toBeDefined();

    const planPath = path.join(dir, 'task-plan.json');
    fs.writeFileSync(planPath, planOut);
    const verification = JSON.parse(
      runCli(['verify', planPath, sitePath, '--context', contextPath])) as Verification;
    expect(verification.verdict).toBe('pass');
  });

  it('plan --task reports infeasible instead of an unsafe plan, still exit 0', () => {
    const taskPath = path.join(dir, 'task-bad.json');
    fs.writeFileSync(taskPath, JSON.stringify({
      task: {
        taskId: 'cli-task-2', anomalyId: anomaly.id, lookFor: 'person',
        question: 'Anyone there?', urgency: 'immediate', priority: 0.5,
        rationale: 'cli smoke', source: 'scripted',
      },
      anomaly,
    }));
    const badContext = path.join(dir, 'bad-context.json');
    const bad = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
    bad.navSource = 'extnav';
    fs.writeFileSync(badContext, JSON.stringify(bad));
    const out = JSON.parse(runCli(['plan', '--task', taskPath, sitePath, '--context', badContext])) as
      { infeasible: boolean; reason: string; planTrace: unknown[] };
    expect(out.infeasible).toBe(true);
    expect(out.reason).toContain('extnav');
    expect(out.planTrace.length).toBeGreaterThan(0);
  });

  it('triage --scripted emits an ordered task list with no geometry', () => {
    const cuesPath = path.join(dir, 'anomalies.json');
    fs.writeFileSync(cuesPath, JSON.stringify({
      now: 1757116800000,
      anomalies: [
        { ...anomaly, id: 'sat-cue', source: 'sentinel2', confidence: 0.95, observedAt: 1757116800000, ttl_s: 3600 },
        { ...anomaly, id: 'fence-cue', source: 'fence_sensor', type: 'breach', confidence: 0.8,
          observedAt: 1757116800000, ttl_s: 3600 },
      ],
      fleet: [{ vehicleId: 'eis-1', ready: true }],
      cueBudget: { used: 0, cap: 2 },
      mode: 'attended',
    }));
    const out = JSON.parse(runCli(['triage', '--scripted', cuesPath])) as
      { tasks: Array<Record<string, unknown>>; source: string };
    expect(out.source).toBe('scripted');
    expect(out.tasks.map((task) => task.anomalyId)).toEqual(['fence-cue', 'sat-cue']);
    expect(out.tasks[0].lookFor).toBe('fence_gap');
    for (const task of out.tasks) {
      for (const key of Object.keys(task)) {
        expect(['lat', 'lon', 'alt', 'radius', 'tools', 'profile']).not.toContain(key);
      }
    }
  });

  it('exits non-zero on bad input', () => {
    expect(() => runCli(['verify', path.join(dir, 'nope.json'), sitePath])).toThrow();
    expect(() => runCli(['frobnicate'])).toThrow();
    expect(() => runCli(['plan', '--task', path.join(dir, 'nope.json'), sitePath])).toThrow();
  });
});
