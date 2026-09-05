import { describe, expect, it } from 'vitest';
import stub from '../../../site/site.stub.json';
import { Anomaly, BatteryState, MissionPlan } from '../src/contract';
import { LlmPlanner } from '../src/llm';
import { PlannerService } from '../src/service';
import { ScriptedPlanner } from '../src/scripted';
import { validateSite } from '../src/site';
import { VerificationContext } from '../src/verifier';

const site = validateSite(stub);
const anomaly: Anomaly = {
  id: 'service-anomaly', lat: site.staging[0].lat, lon: site.staging[0].lon,
  type: 'change', confidence: 0.9, thumbnail: 'site/staging/stage-a.png', source: 'sentinel2',
};
const battery: BatteryState = { soc_pct: 90, voltage_v:24, current_a:1, cell_delta_v:.02,
  temp_c:25, remaining_s:1200, charge_state:'charged', voltage:24, current:1, remaining:90 };
const context: VerificationContext = { navSource:'gps', readiness:{ready:true,reasons:[]}, battery,
  windMps:0, anomaly, rfEvents:[], sdrState:'nominal', sensors:{rgb:'ok',thermal:'ok',lidar:'ok'}, isNight:false };
const input = { vehicleId:'eis-1', anomaly, context };

describe('PlannerService live safety boundary', () => {
  it('feeds verifier failures back once and accepts the second plan', async () => {
    const safe = new ScriptedPlanner().passingPlan(site, anomaly);
    const bad: MissionPlan = { ...safe, tools: [{ tool: 'rtl' }] };
    let calls = 0;
    const live = { plan: async () => (++calls === 1 ? bad : safe), report: async () => { throw new Error(); } } as unknown as LlmPlanner;
    const result = await new PlannerService(site, live).propose(input);
    expect(calls).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.effectivePlan).toBeDefined();
  });

  it('falls back deterministically on timeout/refusal', async () => {
    const live = { plan: async () => { throw new Error('request timed out'); } } as unknown as LlmPlanner;
    const result = await new PlannerService(site, live).propose(input);
    expect(result.source).toBe('scripted');
    expect(result.fallbackReason).toContain('timed out');
    expect(result.effectivePlan).toBeDefined();
  });

  it('rejects a malicious non-planner tool in schema output', async () => {
    const client = { responses: { parse: async () => ({ output_parsed: {
      requestId:'x', anomalyId:anomaly.id, profile:'standard', rationale:'attack',
      tools:[{tool:'manualInput', roll:1}],
    } }) } };
    const live = new LlmPlanner({ client: client as never });
    await expect(live.plan(site, anomaly, 'x')).rejects.toThrow();
  });

  it('overrides an unsafe LLM false-alarm verdict when no observation exists', async () => {
    const live = { report: async () => ({ missionId:'x', verdict:'false_alarm', markdown:'unsafe' }) } as unknown as LlmPlanner;
    const plan = new ScriptedPlanner().passingPlan(site, anomaly);
    const report = await new PlannerService(site, live).report({ vehicleId:'eis-1', anomaly, plan,
      observation:{ detected:false, observationAvailable:false, confidence:0 } });
    expect(report.verdict).toBe('escalate');
    expect(report.markdown).toContain('no reviewable observation');
  });
});
