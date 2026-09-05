import { describe, expect, it } from 'vitest';
import { validateMissionPlan, validateObservation } from '../src/validate';

const base = { requestId:'r', anomalyId:'a', profile:'standard', rationale:'test' };
describe('wire validation hardening', () => {
  it('does not accept inherited profile names', () => {
    expect(() => validateMissionPlan({ ...base, profile:'toString', tools:[{tool:'rtl'}] })).toThrow(/profile/);
  });
  it('rejects conflicting aliases and fractional orbit laps', () => {
    expect(() => validateMissionPlan({ ...base, tools:[{tool:'goto_gps',lat:0,lon:0,alt:20,alt_m:30}] })).toThrow(/conflicting/);
    expect(() => validateMissionPlan({ ...base, tools:[{tool:'orbit_point',lat:0,lon:0,radius:5,radius_m:6}] })).toThrow(/conflicting/);
    expect(() => validateMissionPlan({ ...base, tools:[{tool:'hold',durationS:1,duration_s:2}] })).toThrow(/conflicting/);
    expect(() => validateMissionPlan({ ...base, tools:[{tool:'orbit_point',lat:0,lon:0,radius:5,laps:1.5}] })).toThrow(/integer/);
  });
  it('rejects remote frames and malformed geometry before reporting', () => {
    expect(() => validateObservation({detected:true,confidence:.9,frames:{rgb:'https://example.test/x.png'}})).toThrow(/local/);
    expect(() => validateObservation({detected:true,confidence:.9,geometry:{fenceGaps:[{lat:0,lon:0,widthM:'wide'}]}})).toThrow(/geometry/);
  });
});
