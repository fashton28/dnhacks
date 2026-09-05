/**
 * PlannerService — the Electron host's façade, after plan generation moved to
 * the deterministic rule table (ADR D20). The model keeps exactly two jobs
 * (triage and the report) and neither can produce a plan.
 */
import { describe, expect, it } from 'vitest';
import stub from '../../../site/site.stub.json';
import { Anomaly, BatteryState } from '../src/contract';
import { LlmClient } from '../src/llm';
import { PlannerService, taskForAnomaly } from '../src/service';
import { ScriptedPlanner } from '../src/scripted';
import { validateSite } from '../src/site';
import { VerificationContext } from '../src/verifier';

const site = validateSite(stub);
const anomaly: Anomaly = {
  id: 'service-anomaly', lat: site.staging[1].lat, lon: site.staging[1].lon,
  type: 'change', confidence: 0.9, thumbnail: 'site/staging/stage-a.png', source: 'sentinel2',
};
const battery: BatteryState = { soc_pct: 90, voltage_v:24, current_a:1, cell_delta_v:.02,
  temp_c:25, remaining_s:1200, charge_state:'charged', voltage:24, current:1, remaining:90 };
const context: VerificationContext = { navSource:'gps', readiness:{ready:true,reasons:[]}, battery,
  windMps:0, anomaly, rfEvents:[], sdrState:'nominal', sensors:{rgb:'ok',thermal:'ok',lidar:'ok'}, isNight:false };
const input = { vehicleId:'eis-1', anomaly, context };

describe('PlannerService deterministic boundary', () => {
  it('proposes a deterministic plan that verifies without correction', async () => {
    const result = await new PlannerService(site, null).propose(input);
    expect(result.source).toBe('deterministic');
    expect(result.attempts).toBe(1);
    expect(result.verification?.verdict).toBe('pass');
    expect(result.effectivePlan).toBeDefined();
    expect(result.plan?.planTrace?.length).toBeGreaterThan(0);
    expect(result.plan?.corridor?.generated_from).toBe(result.plan?.requestId);
  });

  it('refuses rather than planning when the state cannot be flown', async () => {
    const result = await new PlannerService(site, null).propose({
      ...input, context: { ...context, navSource: 'optflow' },
    });
    expect(result.plan).toBeUndefined();
    expect(result.infeasibleReason).toContain('optflow');
    expect(result.escalationReason).toContain('refused');
  });

  it('exposes no path by which a model can emit a plan', () => {
    const client = new LlmClient({ client: { responses: { parse: async () => ({ output_parsed: {} }) } } as never });
    expect((client as unknown as Record<string, unknown>).plan).toBeUndefined();
    expect(typeof client.triage).toBe('function');
    expect(typeof client.report).toBe('function');
  });

  it('derives a coordinate-free task from an anomaly', () => {
    const task = taskForAnomaly(anomaly);
    expect(task.anomalyId).toBe(anomaly.id);
    for (const key of Object.keys(task)) {
      expect(['lat', 'lon', 'alt', 'radius', 'profile', 'tools']).not.toContain(key);
    }
  });

  it('overrides an unsafe LLM false-alarm verdict when no observation exists', async () => {
    const live = { report: async () => ({ missionId:'x', verdict:'false_alarm', markdown:'unsafe' }) } as unknown as LlmClient;
    const plan = new ScriptedPlanner().passingPlan(site, anomaly);
    const report = await new PlannerService(site, live).report({ vehicleId:'eis-1', anomaly, plan,
      observation:{ detected:false, observationAvailable:false, confidence:0 } });
    expect(report.verdict).toBe('escalate');
    expect(report.markdown).toContain('no reviewable observation');
  });
});
