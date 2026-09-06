/**
 * Fleet allocation is deterministic and conservative: nearest ready vehicle
 * with range, the other one when the first has no feasible plan, never two
 * vehicles on one anomaly, and a handoff only when the incumbent's deadline
 * has actually arrived with the question unanswered.
 */
import { describe, expect, it } from 'vitest';

import stub from '../../../site/site.stub.json';
import { Anomaly, BatteryState, Task } from '../src/contract';
import { FleetCandidate, allocate, candidateRangeS, handoff } from '../src/fleet';
import { validateSite } from '../src/site';
import { VerificationContext } from '../src/verifier';

const site = validateSite(stub);
const NOW = 1757116800000;

const battery = (soc = 92): BatteryState => ({
  soc_pct: soc, voltage_v: 24.6, current_a: 12, cell_delta_v: 0.02, temp_c: 28,
  remaining_s: 1200, charge_state: 'charged', voltage: 24.6, current: 12, remaining: soc,
});

const anomaly: Anomaly = {
  id: 'cue-east-yard', lat: 41.1997305, lon: -98.3988061, type: 'motion', confidence: 0.9,
  thumbnail: 'site/staging/stage-b.png', source: 'cctv', observedAt: NOW, ttl_s: 900,
};

const task: Task = {
  taskId: 'task-cue-east-yard', anomalyId: anomaly.id, lookFor: 'person',
  question: 'Is there a person at the east yard cue?', urgency: 'immediate',
  priority: 0.9, rationale: 'high-confidence cctv cue', source: 'scripted',
};

function context(over: Partial<VerificationContext> = {}): VerificationContext {
  return {
    navSource: 'gps', readiness: { ready: true, reasons: [] }, battery: battery(),
    windMps: 0, anomaly, rfEvents: [], sdrState: 'nominal',
    sensors: { rgb: 'ok', thermal: 'ok', lidar: 'ok' }, isNight: false,
    now: NOW, dispatchAt: NOW, ...over,
  };
}

const vehicle = (id: string, position: { lat: number; lon: number },
  over: Partial<VerificationContext> = {}, sortiesUsed = 0): FleetCandidate => ({
  vehicleId: id, sortiesUsed,
  context: context({ currentPosition: position, ...over }),
});

const near = { lat: 41.1996407, lon: -98.398567 };
const far = { lat: 41.1986525, lon: -98.4014327 };

describe('fleet allocation', () => {
  it('picks the nearest ready vehicle with range', () => {
    const result = allocate({
      task, anomaly, site,
      vehicles: [vehicle('eis-2', far), vehicle('eis-1', near)],
    });
    expect(result.assigned).toBe(true);
    expect(result.vehicleId).toBe('eis-1');
    expect(result.task.assignedTo).toBe('eis-1');
    expect(result.plan?.tools.length).toBeGreaterThan(2);
  });

  it('skips a vehicle that is not ready and says why', () => {
    const result = allocate({
      task, anomaly, site,
      vehicles: [
        vehicle('eis-1', near, { readiness: { ready: false, reasons: ['pack charging'] } }),
        vehicle('eis-2', far),
      ],
    });
    expect(result.vehicleId).toBe('eis-2');
    expect(result.attempts[0]).toMatchObject({ vehicleId: 'eis-1', ready: false });
    expect(result.attempts[0].skipped).toContain('pack charging');
  });

  it('tries the other vehicle when the first has no feasible plan', () => {
    const result = allocate({
      task, anomaly, site,
      vehicles: [vehicle('eis-1', near, { navSource: 'optflow' }), vehicle('eis-2', far)],
    });
    expect(result.vehicleId).toBe('eis-2');
    const first = result.attempts[0];
    expect(first.result && first.result.infeasible ? first.result.reason : '').toContain('optflow');
  });

  it('refuses when no vehicle can fly it, naming every reason', () => {
    const result = allocate({
      task, anomaly, site,
      vehicles: [
        vehicle('eis-1', near, { navSource: 'optflow' }),
        vehicle('eis-2', far, { windMps: 20 }),
      ],
    });
    expect(result.assigned).toBe(false);
    expect(result.reason).toContain('optflow');
    expect(result.reason).toContain('wind');
  });

  it('never puts a second vehicle on an anomaly outside a handoff', () => {
    const result = allocate({
      task, anomaly, site, vehicles: [vehicle('eis-2', far)],
      assigned: { [anomaly.id]: 'eis-1' },
    });
    expect(result.assigned).toBe(false);
    expect(result.reason).toContain('already assigned to eis-1');
  });

  it('counts one sortie per vehicle against the cue budget', () => {
    const result = allocate({
      task, anomaly, site, sortieCapPerVehicle: 2,
      vehicles: [vehicle('eis-1', near, {}, 2), vehicle('eis-2', far, {}, 1)],
    });
    expect(result.vehicleId).toBe('eis-2');
    expect(result.attempts[0].skipped).toContain('cue budget spent');
  });

  it('skips a vehicle with no range above the reserve', () => {
    const flat = vehicle('eis-1', near, { battery: battery(20) });
    expect(candidateRangeS(flat)).toBe(0);
    const result = allocate({ task, anomaly, site, vehicles: [flat, vehicle('eis-2', far)] });
    expect(result.vehicleId).toBe('eis-2');
    expect(result.attempts[0].skipped).toContain('no range');
  });
});

describe('handoff', () => {
  const common = {
    task, anomaly, site,
    vehicles: [vehicle('eis-1', near), vehicle('eis-2', far)],
    fromVehicleId: 'eis-1',
    assigned: { [anomaly.id]: 'eis-1' },
  };

  it('re-tasks the other vehicle when must_rtl_by arrives unanswered', () => {
    const result = handoff({ ...common, mustRtlBy: NOW - 1000, questionAnswered: false, now: NOW });
    expect(result.handedOff).toBe(true);
    expect(result.vehicleId).toBe('eis-2');
    expect(result.handoffFrom).toBe('eis-1');
    expect(result.detail).toContain('unanswered');
  });

  it('does not hand off before the deadline', () => {
    const result = handoff({ ...common, mustRtlBy: NOW + 120_000, questionAnswered: false, now: NOW });
    expect(result.handedOff).toBe(false);
    expect(result.assigned).toBe(false);
    expect(result.detail).toContain('before it must turn for home');
  });

  it('does not hand off an answered question', () => {
    const result = handoff({ ...common, mustRtlBy: NOW - 1000, questionAnswered: true, now: NOW });
    expect(result.handedOff).toBe(false);
    expect(result.detail).toContain('answered');
  });

  it('reports honestly when nobody can take the handoff', () => {
    const result = handoff({
      ...common,
      vehicles: [vehicle('eis-1', near), vehicle('eis-2', far, { navSource: 'extnav' })],
      mustRtlBy: NOW - 1000, questionAnswered: false, now: NOW,
    });
    expect(result.handedOff).toBe(false);
    expect(result.detail).toContain('no vehicle could take the handoff');
  });
});
