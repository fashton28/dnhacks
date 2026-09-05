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
  FleetMessage,
  HealthEventMessage,
  IncidentReport,
  MissionPlan,
  MissionProfile,
  PlanTool,
  PlanCommandAckMessage,
  PlanCommandMessage,
  PlanHeartbeatMessage,
  PROFILE_SPEED_MPS,
  ObservationMessage,
  ReadinessMessage,
  RfEventMessage,
  SimulationToggles,
  SpectrumMessage,
  Telemetry,
  Verification,
  VerificationCheck,
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
    ]).toEqual(new Array(20).fill(true));
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
    ]).toEqual(new Array(16).fill(true));
  });

  it('profile speeds stay under the companion hard max-speed cap', () => {
    for (const speed of Object.values(PROFILE_SPEED_MPS)) {
      expect(speed).toBeGreaterThan(0);
      expect(speed).toBeLessThanOrEqual(Auth.DEFAULTS.maxSpeedCap);
    }
  });
});
