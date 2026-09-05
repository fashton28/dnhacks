/**
 * Contract parity — pins the planner's read-only mirror (src/contract.ts) to
 * the AUTHORITATIVE frozen contract at ground/ui/src/contract/index.ts.
 *
 * The type-level assignments below are checked by `npm run typecheck`
 * (tsc -p tsconfig.test.json), which `npm test` runs first: if either copy
 * drifts, the assignment in the drifted direction stops compiling. The
 * runtime assertions pin the PROFILE_SPEED_MPS values.
 */
import { describe, expect, it } from 'vitest';

import * as Auth from '../../ui/src/contract';
import * as Shared from '../../../shared/shared';
import {
  Anomaly,
  BatteryState,
  CapabilitiesMessage,
  CctvEventMessage,
  Corridor,
  EnvelopeMessage,
  EscalationMessage,
  FleetMessage,
  GimbalState,
  HealthEventMessage,
  IncidentReport,
  MissionPlan,
  MissionProfile,
  MissionRecord,
  ModeMessage,
  PlanTool,
  PlanTraceEntry,
  PlanCommandAckMessage,
  PlanCommandMessage,
  PlanHeartbeatMessage,
  PROFILE_SPEED_MPS,
  ObservationMessage,
  ReadinessMessage,
  RfEventMessage,
  SimulationToggles,
  SpectrumMessage,
  Task,
  TaskMessage,
  TASK_QUESTION_MAX_CHARS,
  Telemetry,
  Verification,
  VerificationCheck,
  VerificationCheckName,
  VERIFICATION_CHECK_NAMES,
  GIMBAL_PITCH_MAX_DEG,
  GIMBAL_PITCH_MIN_DEG,
} from '../src/contract';

/* ---- type-level mutual assignability (compile-time; evaluated by tsc) ---- */

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Each line fails to compile if the mirror and the authoritative type diverge.
const _profile: MutuallyAssignable<MissionProfile, Auth.MissionProfile> = true;
const _planTool: MutuallyAssignable<PlanTool, Auth.PlanTool> = true;
const _anomaly: MutuallyAssignable<Anomaly, Auth.Anomaly> = true;
const _plan: MutuallyAssignable<MissionPlan, Auth.MissionPlan> = true;
const _check: MutuallyAssignable<VerificationCheck, Auth.VerificationCheck> = true;
const _verification: MutuallyAssignable<Verification, Auth.Verification> = true;
const _report: MutuallyAssignable<IncidentReport, Auth.IncidentReport> = true;
const _battery: MutuallyAssignable<BatteryState, Auth.BatteryState> = true;
const _telemetry: MutuallyAssignable<Telemetry, Auth.Telemetry> = true;
const _observation: MutuallyAssignable<ObservationMessage, Auth.ObservationMessage> = true;
const _capabilities: MutuallyAssignable<CapabilitiesMessage, Auth.CapabilitiesMessage> = true;
const _planCommand: MutuallyAssignable<PlanCommandMessage, Auth.PlanCommandMessage> = true;
const _planCommandAck: MutuallyAssignable<PlanCommandAckMessage, Auth.PlanCommandAckMessage> = true;
const _heartbeat: MutuallyAssignable<PlanHeartbeatMessage, Auth.PlanHeartbeatMessage> = true;
const _readiness: MutuallyAssignable<ReadinessMessage, Auth.ReadinessMessage> = true;
const _health: MutuallyAssignable<HealthEventMessage, Auth.HealthEventMessage> = true;
const _rf: MutuallyAssignable<RfEventMessage, Auth.RfEventMessage> = true;
const _spectrum: MutuallyAssignable<SpectrumMessage, Auth.SpectrumMessage> = true;
const _fleet: MutuallyAssignable<FleetMessage, Auth.FleetMessage> = true;
const _toggles: MutuallyAssignable<SimulationToggles, Auth.SimulationToggles> = true;

/* Phase 1 additions: tasking, plan trace + corridor, envelope monitoring,
 * attendance mode, escalation, the CCTV cue rail, the gimbal, and the durable
 * mission record. */
const _planTrace: MutuallyAssignable<PlanTraceEntry, Auth.PlanTraceEntry> = true;
const _corridor: MutuallyAssignable<Corridor, Auth.Corridor> = true;
const _checkName: MutuallyAssignable<VerificationCheckName, Auth.VerificationCheckName> = true;
const _task: MutuallyAssignable<Task, Auth.Task> = true;
const _taskMsg: MutuallyAssignable<TaskMessage, Auth.TaskMessage> = true;
const _envelope: MutuallyAssignable<EnvelopeMessage, Auth.EnvelopeMessage> = true;
const _mode: MutuallyAssignable<ModeMessage, Auth.ModeMessage> = true;
const _escalation: MutuallyAssignable<EscalationMessage, Auth.EscalationMessage> = true;
const _cctv: MutuallyAssignable<CctvEventMessage, Auth.CctvEventMessage> = true;
const _gimbal: MutuallyAssignable<GimbalState, Auth.GimbalState> = true;
const _record: MutuallyAssignable<MissionRecord, Auth.MissionRecord> = true;

const _sharedPlanTrace: MutuallyAssignable<Shared.PlanTraceEntry, Auth.PlanTraceEntry> = true;
const _sharedCorridor: MutuallyAssignable<Shared.Corridor, Auth.Corridor> = true;
const _sharedMissionPlan: MutuallyAssignable<Shared.MissionPlan, Auth.MissionPlan> = true;
const _sharedVerification: MutuallyAssignable<Shared.Verification, Auth.Verification> = true;
const _sharedCheckName: MutuallyAssignable<Shared.VerificationCheckName, Auth.VerificationCheckName> = true;
const _sharedTask: MutuallyAssignable<Shared.Task, Auth.Task> = true;
const _sharedTaskMsg: MutuallyAssignable<Shared.TaskMessage, Auth.TaskMessage> = true;
const _sharedEnvelope: MutuallyAssignable<Shared.EnvelopeMessage, Auth.EnvelopeMessage> = true;
const _sharedMode: MutuallyAssignable<Shared.ModeMessage, Auth.ModeMessage> = true;
const _sharedEscalation: MutuallyAssignable<Shared.EscalationMessage, Auth.EscalationMessage> = true;
const _sharedCctv: MutuallyAssignable<Shared.CctvEventMessage, Auth.CctvEventMessage> = true;
const _sharedGimbal: MutuallyAssignable<Shared.GimbalState, Auth.GimbalState> = true;
const _sharedRecord: MutuallyAssignable<Shared.MissionRecord, Auth.MissionRecord> = true;
const _sharedCommandName: MutuallyAssignable<Shared.CommandName, Auth.CommandName> = true;
const _sharedCommand: MutuallyAssignable<Shared.Command, Auth.Command> = true;

const _sharedProfile: MutuallyAssignable<Shared.MissionProfile, Auth.MissionProfile> = true;
const _sharedPlanTool: MutuallyAssignable<Shared.PlanTool, Auth.PlanTool> = true;
const _sharedAnomaly: MutuallyAssignable<Shared.Anomaly, Auth.Anomaly> = true;
const _sharedBattery: MutuallyAssignable<Shared.BatteryState, Auth.BatteryState> = true;
const _sharedTelemetry: MutuallyAssignable<Shared.Telemetry, Auth.Telemetry> = true;
const _sharedObservation: MutuallyAssignable<Shared.ObservationMessage, Auth.ObservationMessage> = true;
const _sharedCapabilities: MutuallyAssignable<Shared.CapabilitiesMessage, Auth.CapabilitiesMessage> = true;
const _sharedPlanCommand: MutuallyAssignable<Shared.PlanCommandMessage, Auth.PlanCommandMessage> = true;
const _sharedPlanCommandAck: MutuallyAssignable<Shared.PlanCommandAckMessage, Auth.PlanCommandAckMessage> = true;
const _sharedHeartbeat: MutuallyAssignable<Shared.PlanHeartbeatMessage, Auth.PlanHeartbeatMessage> = true;
const _sharedReadiness: MutuallyAssignable<Shared.ReadinessMessage, Auth.ReadinessMessage> = true;
const _sharedHealth: MutuallyAssignable<Shared.HealthEventMessage, Auth.HealthEventMessage> = true;
const _sharedRf: MutuallyAssignable<Shared.RfEventMessage, Auth.RfEventMessage> = true;
const _sharedSpectrum: MutuallyAssignable<Shared.SpectrumMessage, Auth.SpectrumMessage> = true;
const _sharedFleet: MutuallyAssignable<Shared.FleetMessage, Auth.FleetMessage> = true;
const _sharedToggles: MutuallyAssignable<Shared.SimulationToggles, Auth.SimulationToggles> = true;

/* ---- runtime value parity ---- */

describe('contract parity (planner mirror vs ground/ui/src/contract)', () => {
  it('type-level assertions compiled (see tsc typecheck)', () => {
    expect([
      _profile, _planTool, _anomaly, _plan, _check, _verification, _report,
      _battery, _telemetry, _observation, _capabilities, _planCommand,
      _planCommandAck, _heartbeat, _readiness, _health, _rf, _spectrum,
      _fleet, _toggles,
      _planTrace, _corridor, _checkName, _task, _taskMsg, _envelope, _mode,
      _escalation, _cctv, _gimbal, _record,
    ]).toEqual(new Array(31).fill(true));
  });

  it('PROFILE_SPEED_MPS values match the authoritative contract', () => {
    expect(PROFILE_SPEED_MPS).toEqual(Auth.PROFILE_SPEED_MPS);
    expect(Shared.PROFILE_SPEED_MPS).toEqual(Auth.PROFILE_SPEED_MPS);
  });

  it('shared/shared.ts types remain assignable to the authoritative contract', () => {
    expect([
      _sharedProfile, _sharedPlanTool, _sharedAnomaly, _sharedBattery,
      _sharedTelemetry, _sharedObservation, _sharedCapabilities, _sharedPlanCommand,
      _sharedPlanCommandAck, _sharedHeartbeat, _sharedReadiness, _sharedHealth,
      _sharedRf, _sharedSpectrum, _sharedFleet, _sharedToggles,
      _sharedPlanTrace, _sharedCorridor, _sharedMissionPlan, _sharedVerification,
      _sharedCheckName, _sharedTask, _sharedTaskMsg, _sharedEnvelope, _sharedMode,
      _sharedEscalation, _sharedCctv, _sharedGimbal, _sharedRecord,
      _sharedCommandName, _sharedCommand,
    ]).toEqual(new Array(31).fill(true));
  });

  it('Phase 1 shared constants match across all three mirrors', () => {
    expect(TASK_QUESTION_MAX_CHARS).toBe(Auth.TASK_QUESTION_MAX_CHARS);
    expect(Shared.TASK_QUESTION_MAX_CHARS).toBe(Auth.TASK_QUESTION_MAX_CHARS);
    expect(VERIFICATION_CHECK_NAMES).toEqual(Auth.VERIFICATION_CHECK_NAMES);
    expect(Shared.VERIFICATION_CHECK_NAMES).toEqual(Auth.VERIFICATION_CHECK_NAMES);
    expect(VERIFICATION_CHECK_NAMES).toContain('attended');
    expect(VERIFICATION_CHECK_NAMES).toContain('deconfliction');
    expect([GIMBAL_PITCH_MIN_DEG, GIMBAL_PITCH_MAX_DEG])
      .toEqual([Auth.GIMBAL_PITCH_MIN_DEG, Auth.GIMBAL_PITCH_MAX_DEG]);
    expect([Shared.GIMBAL_PITCH_MIN_DEG, Shared.GIMBAL_PITCH_MAX_DEG])
      .toEqual([Auth.GIMBAL_PITCH_MIN_DEG, Auth.GIMBAL_PITCH_MAX_DEG]);
    // -30 up / 0 level / 90 down — matches the ARGUS console's convention.
    expect(Auth.GIMBAL_PITCH_MIN_DEG).toBe(-30);
    expect(Auth.GIMBAL_PITCH_MAX_DEG).toBe(90);
  });

  it('a Task carries no geometry beyond its anomalyId', () => {
    const task: Auth.Task = {
      taskId: 't-1', anomalyId: 'a-1', lookFor: 'vehicle',
      question: 'Is there a vehicle at the flagged change?',
      urgency: 'immediate', priority: 0.9, rationale: 'high-confidence change',
      source: 'llm',
    };
    // The schema an LLM may emit: no lat/lon/alt, no tool, no setpoint.
    const forbidden = ['lat', 'lon', 'alt', 'alt_m', 'tool', 'tools', 'radius',
      'radius_m', 'speed_mps', 'profile', 'mode', 'waypoints'];
    for (const key of Object.keys(task)) expect(forbidden).not.toContain(key);
    expect(task.question.length).toBeLessThanOrEqual(TASK_QUESTION_MAX_CHARS);
  });

  it('profile speeds stay under the companion hard max-speed cap', () => {
    for (const speed of Object.values(PROFILE_SPEED_MPS)) {
      expect(speed).toBeGreaterThan(0);
      expect(speed).toBeLessThanOrEqual(Auth.DEFAULTS.maxSpeedCap);
    }
  });
});
