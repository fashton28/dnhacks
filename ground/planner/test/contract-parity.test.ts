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
import {
  Anomaly,
  IncidentReport,
  MissionPlan,
  MissionProfile,
  PlanTool,
  PROFILE_SPEED_MPS,
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

/* ---- runtime value parity ---- */

describe('contract parity (planner mirror vs ground/ui/src/contract)', () => {
  it('type-level assertions compiled (see tsc typecheck)', () => {
    expect([_profile, _planTool, _anomaly, _plan, _check, _verification, _report])
      .toEqual([true, true, true, true, true, true, true]);
  });

  it('PROFILE_SPEED_MPS values match the authoritative contract', () => {
    expect(PROFILE_SPEED_MPS).toEqual(Auth.PROFILE_SPEED_MPS);
  });

  it('profile speeds stay under the companion hard max-speed cap', () => {
    for (const speed of Object.values(PROFILE_SPEED_MPS)) {
      expect(speed).toBeGreaterThan(0);
      expect(speed).toBeLessThanOrEqual(Auth.DEFAULTS.maxSpeedCap);
    }
  });
});
