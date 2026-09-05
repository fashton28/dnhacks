import { MissionProfile } from './contract';

/**
 * Generated mirror of verifier_fixtures/profiles.json and range_model.json.
 * test/policy-parity.test.ts prevents drift from the reviewable source files.
 */
export const VERIFIER_POLICY = {
  hardMinStandoffM: 3,
  hardMaxSpeedMps: 8,
  nominalEnduranceS: 1500,
  reservePct: 25,
  windTimeFactorPerMps: 0.05,
  maxWindMps: 12,
  anomalyProximityM: 200,
  maxSortieS: 480,
  dispatchMinSocPct: 80,
  cellImbalanceMaxV: 0.1,
  battTempMaxC: 60,
} as const;

export const PROFILE_POLICY: Record<MissionProfile, {
  maxSpeedMps: number;
  maxAltitudeM: number;
  standoffM: number;
  maxSortieS: number;
}> = {
  follow: { maxSpeedMps: 2, maxAltitudeM: 50, standoffM: 8, maxSortieS: 480 },
  inspect: { maxSpeedMps: 4, maxAltitudeM: 45, standoffM: 5, maxSortieS: 480 },
  survey: { maxSpeedMps: 6, maxAltitudeM: 60, standoffM: 8, maxSortieS: 480 },
  slow: { maxSpeedMps: 2, maxAltitudeM: 50, standoffM: 8, maxSortieS: 480 },
  standard: { maxSpeedMps: 4, maxAltitudeM: 45, standoffM: 5, maxSortieS: 480 },
  fast: { maxSpeedMps: 6, maxAltitudeM: 60, standoffM: 8, maxSortieS: 480 },
};
