/* ============================================================================
 * eis-planner/fleet — deterministic allocation for two vehicles (ADR D26).
 *
 * Star topology, no mesh, no negotiation: this module decides WHICH vehicle
 * flies a task, using only the hub's view of the fleet, and it decides the same
 * way every time.
 *
 *   - Nearest READY vehicle that has the range for the task.
 *   - If that vehicle's plan is infeasible, try the other one.
 *   - Never two vehicles on one anomaly — except an explicit handoff.
 *   - Handoff when a vehicle's `must_rtl_by` arrives mid-task with the question
 *     still unanswered: the task is re-tasked to the other ready vehicle and the
 *     new mission record carries `handoffFrom`.
 *   - The cue budget counts ONE sortie per vehicle, so a handoff is one more
 *     sortie against the budget, not a free continuation.
 *
 * There is no automatic reallocation of a LOST vehicle: that escalates to the
 * operator and the other vehicle continues under widened separation (D26).
 * ========================================================================== */

import { Anomaly, MissionPlan, Task } from './contract';
import { DeterministicPlanResult, planMission } from './deterministic';
import { haversineMeters, rangeAvailableSeconds } from './geometry';
import { SiteModel } from './site';
import { VerificationContext } from './verifier';

/** One vehicle the hub can dispatch, with the state its plan is drawn from. */
export interface FleetCandidate {
  vehicleId: string;
  /** The runtime context this vehicle would be verified with. */
  context: VerificationContext;
  /** Sorties this vehicle has already flown in the budget window. */
  sortiesUsed?: number;
}

export interface AllocationInput {
  task: Task;
  anomaly: Anomaly;
  site: SiteModel;
  vehicles: FleetCandidate[];
  /** Cap on sorties per vehicle in the budget window (ADR D23: 2/h unattended). */
  sortieCapPerVehicle?: number;
  /** Anomalies already assigned: `{anomalyId: vehicleId}`. */
  assigned?: Record<string, string>;
  /** Set when this allocation continues a task the named vehicle started. */
  handoffFrom?: string;
  requestId?: string;
}

export interface AllocationAttempt {
  vehicleId: string;
  distanceM: number;
  ready: boolean;
  /** Why this vehicle was skipped, when it was. */
  skipped?: string;
  result?: DeterministicPlanResult;
}

export interface Allocation {
  assigned: boolean;
  vehicleId?: string;
  plan?: MissionPlan;
  task: Task;
  handoffFrom?: string;
  attempts: AllocationAttempt[];
  /** Present when no vehicle could take the task. */
  reason?: string;
}

function readiness(candidate: FleetCandidate): { ready: boolean; reason: string } {
  const context = candidate.context;
  if (!context.readiness) return { ready: false, reason: 'readiness is unknown' };
  if (!context.readiness.ready) {
    return { ready: false, reason: context.readiness.reasons.join('; ') || 'not ready' };
  }
  return { ready: true, reason: 'ready' };
}

function positionOf(candidate: FleetCandidate, site: SiteModel): { lat: number; lon: number } {
  return candidate.context.currentPosition ?? candidate.context.telemetry?.position ??
    { lat: site.home.lat, lon: site.home.lon };
}

/** Range seconds this vehicle has, from its live pack. */
export function candidateRangeS(candidate: FleetCandidate): number {
  const battery = candidate.context.telemetry?.battery ?? candidate.context.battery;
  return rangeAvailableSeconds(battery?.soc_pct as number, battery?.remaining_s);
}

/**
 * Allocate one task to one vehicle: nearest ready vehicle with range, then the
 * other one if the first has no feasible plan.
 */
export function allocate(input: AllocationInput): Allocation {
  const { task, anomaly, site } = input;
  const cap = input.sortieCapPerVehicle;
  const holder = input.assigned?.[task.anomalyId];
  const attempts: AllocationAttempt[] = [];

  if (holder && holder !== input.handoffFrom) {
    return {
      assigned: false, task, attempts,
      reason: `anomaly ${task.anomalyId} is already assigned to ${holder}; ` +
        'two vehicles never work one anomaly outside an explicit handoff',
    };
  }

  const ordered = input.vehicles
    .filter((candidate) => candidate.vehicleId !== input.handoffFrom)
    .map((candidate) => ({ candidate, distanceM: haversineMeters(positionOf(candidate, site), anomaly) }))
    .sort((a, b) => (a.distanceM - b.distanceM) ||
      a.candidate.vehicleId.localeCompare(b.candidate.vehicleId));

  for (const { candidate, distanceM } of ordered) {
    const state = readiness(candidate);
    if (!state.ready) {
      attempts.push({ vehicleId: candidate.vehicleId, distanceM, ready: false, skipped: state.reason });
      continue;
    }
    if (cap !== undefined && (candidate.sortiesUsed ?? 0) >= cap) {
      attempts.push({
        vehicleId: candidate.vehicleId, distanceM, ready: true,
        skipped: `cue budget spent: ${candidate.sortiesUsed}/${cap} sorties this window`,
      });
      continue;
    }
    if (candidateRangeS(candidate) <= 0) {
      attempts.push({
        vehicleId: candidate.vehicleId, distanceM, ready: true,
        skipped: 'no range left above the battery reserve',
      });
      continue;
    }
    const result = planMission({
      task, anomaly, site,
      context: { ...candidate.context, vehicleId: candidate.vehicleId },
      requestId: input.requestId ?? `plan-${task.taskId}-${candidate.vehicleId}`,
    });
    attempts.push({ vehicleId: candidate.vehicleId, distanceM, ready: true, result });
    if (!result.infeasible) {
      const assignedTask: Task = { ...task, assignedTo: candidate.vehicleId };
      return {
        assigned: true, vehicleId: candidate.vehicleId, plan: result.plan, task: assignedTask,
        attempts, ...(input.handoffFrom ? { handoffFrom: input.handoffFrom } : {}),
      };
    }
  }

  return {
    assigned: false, task, attempts,
    reason: attempts.length
      ? `no vehicle can fly this task: ${attempts.map((attempt) => `${attempt.vehicleId}: ${
        attempt.skipped ?? (attempt.result && attempt.result.infeasible ? attempt.result.reason : 'unknown')
      }`).join('; ')}`
      : 'no vehicle is available',
  };
}

export interface HandoffInput extends AllocationInput {
  /** The vehicle that started the task. */
  fromVehicleId: string;
  /** Epoch ms the incumbent must turn for home. */
  mustRtlBy: number;
  /** True while the task's question is still unanswered. */
  questionAnswered: boolean;
  /** Epoch ms now. */
  now?: number;
}

export interface HandoffResult extends Allocation {
  /** True when the incumbent's deadline actually triggered a handoff. */
  handedOff: boolean;
  detail: string;
}

/**
 * Handoff: the incumbent's `must_rtl_by` has arrived and the question is still
 * unanswered, so the OTHER ready vehicle is re-tasked. This is an explicit,
 * audited action — never an emergent reallocation (ADR D26).
 */
export function handoff(input: HandoffInput): HandoffResult {
  const now = input.now ?? Date.now();
  if (input.questionAnswered) {
    return {
      assigned: false, handedOff: false, task: input.task, attempts: [],
      detail: 'the question is answered; the incumbent finishes and returns on its own timer',
    };
  }
  if (now < input.mustRtlBy) {
    return {
      assigned: false, handedOff: false, task: input.task, attempts: [],
      detail: `incumbent ${input.fromVehicleId} still has ${
        Math.round((input.mustRtlBy - now) / 1000)} s before it must turn for home`,
    };
  }
  const allocation = allocate({ ...input, handoffFrom: input.fromVehicleId });
  return {
    ...allocation,
    handedOff: allocation.assigned,
    handoffFrom: input.fromVehicleId,
    detail: allocation.assigned
      ? `task handed from ${input.fromVehicleId} to ${allocation.vehicleId} with the question unanswered`
      : `no vehicle could take the handoff from ${input.fromVehicleId}: ${allocation.reason}`,
  };
}
