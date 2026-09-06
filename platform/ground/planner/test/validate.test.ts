import { describe, expect, it } from 'vitest';
import { MISSION_SEQUENCE_TOOLS, validateMissionPlan, validateObservation } from '../src/validate';
import { TASK_LIST_SCHEMA } from '../src/llm';

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
  it.each([
    { tool:'follow', track_id:1, profile:'follow' },
    { tool:'orbit', track_id:1, profile:'inspect' },
    { tool:'goto_relative', dx:1, dy:2, dz:3 },
  ])('rejects $tool from a MissionPlan sequence while retaining its wire shape', (tool) => {
    expect(() => validateMissionPlan({ ...base, tools:[tool, {tool:'rtl'}] }))
      .toThrow(/not admitted.*resolved geometry.*planCommand/);
  });
  it('publishes only the geometrically verifiable sequence tool set', () => {
    expect(MISSION_SEQUENCE_TOOLS).toEqual(['goto_gps', 'orbit_point', 'hold', 'rtl']);
  });
  it('gives the model no schema in which a plan could be expressed', () => {
    // The only schema-bound tasking surface: no tools, no geometry, no plan.
    const shape = TASK_LIST_SCHEMA.safeParse({ tasks: [{
      anomalyId: 'a-1', lookFor: 'vehicle', question: 'q', urgency: 'immediate',
      priority: 0.5, rationale: 'r',
    }] });
    expect(shape.success).toBe(true);
    expect(TASK_LIST_SCHEMA.safeParse({ tasks: [{
      anomalyId: 'a-1', lookFor: 'vehicle', question: 'q', urgency: 'immediate',
      priority: 0.5, rationale: 'r', tools: [{ tool: 'goto_gps', lat: 0, lon: 0, alt: 20 }],
    }] }).success).toBe(false);
  });
});
