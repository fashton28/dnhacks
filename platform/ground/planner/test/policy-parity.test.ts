import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { PROFILE_POLICY, VERIFIER_POLICY } from '../src/policy';

const fixture = (name: string) => JSON.parse(fs.readFileSync(
  path.resolve(__dirname, `../../../verifier_fixtures/${name}`), 'utf8'));

describe('reviewable verifier policy mirrors', () => {
  it('matches profiles.json', () => {
    const source = fixture('profiles.json');
    for (const [name, value] of Object.entries(PROFILE_POLICY)) {
      const profile = source.profiles[name];
      expect(value).toEqual({
        maxSpeedMps: profile.speed_mps,
        maxAltitudeM: profile.max_altitude_m,
        standoffM: profile.standoff_m,
        maxSortieS: profile.max_sortie_s,
      });
    }
    expect(VERIFIER_POLICY.hardMinStandoffM).toBe(source.hard_limits.min_standoff_m);
    expect(VERIFIER_POLICY.hardMaxSpeedMps).toBe(source.hard_limits.max_speed_mps);
  });

  it('matches range_model.json', () => {
    const source = fixture('range_model.json');
    expect(VERIFIER_POLICY).toMatchObject({
      nominalEnduranceS: source.nominal_endurance_s,
      reservePct: source.reserve_pct,
      windTimeFactorPerMps: source.wind_time_factor_per_mps,
      maxWindMps: source.max_wind_mps,
      anomalyProximityM: source.anomaly_proximity_m,
      maxSortieS: source.max_sortie_s,
      dispatchMinSocPct: source.dispatch_min_soc_pct,
      cellImbalanceMaxV: source.cell_imbalance_max_v,
      battTempMaxC: source.batt_temp_max_c,
    });
  });
});
