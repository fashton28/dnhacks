/**
 * The orchestrator: triage → plan → verify → approval gate. It owns no
 * geometry, so these tests are about the SEAMS — who may produce a plan, what
 * auto-approves, and what escalates.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import stub from '../../../site/site.stub.json';
import { Anomaly, BatteryState } from '../src/contract';
import { EscalationAdapter } from '../src/escalation';
import { FleetCandidate } from '../src/fleet';
import { MissionPlanner, badPlanRailEnabled } from '../src/planner';
import { validateSite } from '../src/site';
import { VerificationContext } from '../src/verifier';

const site = validateSite(stub);
const NOW = 1757116800000;
const dirs: string[] = [];
function tmpAdapter(): EscalationAdapter {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eis-planner-'));
  dirs.push(dir);
  return new EscalationAdapter({ dataDir: dir, now: () => NOW });
}
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const battery: BatteryState = {
  soc_pct: 92, voltage_v: 24.6, current_a: 12, cell_delta_v: 0.02, temp_c: 28,
  remaining_s: 1200, charge_state: 'charged', voltage: 24.6, current: 12, remaining: 92,
};

const cue: Anomaly = {
  id: 'cue-east-yard', lat: -26.0891, lon: 29.47515, type: 'motion', confidence: 0.92,
  thumbnail: 'site/staging/stage-b.png', source: 'cctv', observedAt: NOW, ttl_s: 900,
  cameraId: 'cam-east-north',
};

function context(over: Partial<VerificationContext> = {}): VerificationContext {
  return {
    navSource: 'gps', readiness: { ready: true, reasons: [] }, battery, windMps: 0,
    anomaly: cue, rfEvents: [], sdrState: 'nominal',
    sensors: { rgb: 'ok', thermal: 'ok', lidar: 'ok' }, isNight: false,
    now: NOW, dispatchAt: NOW, ...over,
  };
}

const vehicles = (over: Partial<VerificationContext> = {}): FleetCandidate[] => [
  { vehicleId: 'eis-1', context: context({ currentPosition: { lat: -26.0895, lon: 29.4750 }, ...over }) },
  { vehicleId: 'eis-2', context: context({ currentPosition: { lat: -26.0930, lon: 29.4690 }, ...over }) },
];

const runInput = (over: Record<string, unknown> = {}) => ({
  anomalies: [cue], vehicles: vehicles(), cueBudget: { used: 0, cap: 2 },
  mode: 'attended' as const, now: NOW, ...over,
});

describe('planner orchestration', () => {
  it('triages, plans deterministically, verifies, and waits for the operator', async () => {
    const planner = new MissionPlanner(site, { llm: null, escalation: tmpAdapter(), now: () => NOW });
    const result = await planner.run(runInput());
    expect(result.triage.source).toBe('scripted');
    expect(result.decisions).toHaveLength(1);
    const decision = result.decisions[0];
    expect(decision.approval).toBe('pending_operator');
    expect(decision.verification?.verdict).toBe('pass');
    expect(decision.vehicleId).toBe('eis-1');
    expect(decision.planTrace.length).toBeGreaterThan(3);
    expect(decision.corridor?.generated_from).toBe(decision.plan?.requestId);
    expect(decision.escalation).toBeUndefined();
  });

  it('auto-approves inside the unattended envelope', async () => {
    const planner = new MissionPlanner(site, { llm: null, escalation: tmpAdapter(), now: () => NOW });
    const result = await planner.run(runInput({
      mode: 'unattended', vehicles: vehicles({ mode: 'unattended' }),
    }));
    const decision = result.decisions[0];
    expect(decision.approval).toBe('auto_approved');
    expect(decision.verification?.verdict).toBe('pass');
    expect(decision.mode).toBe('unattended');
  });

  it('refuses an unattended task outside the envelope and escalates it', async () => {
    const escalation = tmpAdapter();
    const planner = new MissionPlanner(site, { llm: null, escalation, now: () => NOW });
    const result = await planner.run(runInput({
      mode: 'unattended',
      vehicles: vehicles({ mode: 'unattended', windMps: 9 }),   // over the 6 m/s unattended limit
    }));
    const decision = result.decisions[0];
    expect(decision.approval).toBe('refused');
    expect(decision.reason).toContain('wind');
    expect(decision.escalation?.delivered).toBe(true);
    expect(escalation.audit.read()).toHaveLength(1);
    expect(escalation.audit.read()[0].mode).toBe('unattended');
  });

  it('escalates without flying when RF correlates with GNSS interference', async () => {
    const escalation = tmpAdapter();
    const planner = new MissionPlanner(site, { llm: null, escalation, now: () => NOW });
    const zone = {
      name: 'east-fence-north', fenceLine: true,
      polygon: [
        { lat: -26.0878, lon: 29.4740 }, { lat: -26.0878, lon: 29.4769 },
        { lat: -26.0900, lon: 29.4769 }, { lat: -26.0900, lon: 29.4740 },
      ],
    };
    const result = await planner.run(runInput({
      zones: [zone],
      rfEvents: [
        { type: 'rfEvent', ts: NOW, vehicleId: 'eis-1', source: 'rf_drone', kind: 'drone_link', band: '2.4GHz', confidence: 0.9 },
        { type: 'rfEvent', ts: NOW, vehicleId: 'eis-1', source: 'sdr', kind: 'gnss_interference', band: 'GPS L1', confidence: 0.9 },
      ],
    }));
    const decision = result.decisions[0];
    expect(decision.approval).toBe('refused');
    expect(decision.plan).toBeUndefined();
    expect(decision.reason).toContain('without flying');
    expect(escalation.audit.read()[0].reason).toContain('escalates without flying');
  });

  it('keeps ScriptedPlanner only as the EIS_TEST_BAD_PLAN rail', async () => {
    expect(badPlanRailEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(badPlanRailEnabled({ EIS_TEST_BAD_PLAN: '1' } as NodeJS.ProcessEnv)).toBe(true);
    const escalation = tmpAdapter();
    const planner = new MissionPlanner(site, {
      llm: null, escalation, now: () => NOW,
      env: { EIS_TEST_BAD_PLAN: '1' } as NodeJS.ProcessEnv,
    });
    const decision = (await planner.run(runInput())).decisions[0];
    expect(decision.approval).toBe('refused');
    expect(decision.verification?.verdict).toBe('rejected');
    expect(decision.reason).toContain('verifier rejected');
    expect(decision.escalation?.delivered).toBe(true);
  });

  it('never assigns two vehicles to one anomaly', async () => {
    const planner = new MissionPlanner(site, { llm: null, escalation: tmpAdapter(), now: () => NOW });
    const result = await planner.run(runInput({ assigned: { [cue.id]: 'eis-2' } }));
    expect(result.decisions[0].approval).toBe('refused');
    expect(result.decisions[0].reason).toContain('already assigned');
  });
});
