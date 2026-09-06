/* ============================================================================
 * FM-79 — no image payload reaches the model prompt.
 *
 * The baked anomaly's thumbnail is a 10,010-character base64 data URL. Before
 * this fix it was stringified verbatim into the incident-report prompt: ~2.9k
 * inert tokens on the demo's critical path, and untrusted opaque input the
 * model had no use for. `report.ts` has stripped these from the operator-facing
 * markdown since it was written; `reportPayload` is its counterpart.
 * ========================================================================== */
import { describe, expect, it } from 'vitest';
import { Anomaly, MissionPlan } from '../src/contract';
import { describeEvidenceRef, reportPayload } from '../src/llm';
import { ObservationSummary } from '../src/report';
import { triagePayload } from '../src/triage';

const BASE64 = `data:image/png;base64,${'iVBORw0KGgo'.repeat(910)}`;

const anomaly: Anomaly = {
  id: 'sat-change-1', lat: -26.0906, lon: 29.4692, type: 'change',
  confidence: 0.94, thumbnail: BASE64, source: 'sentinel2',
};
const plan: MissionPlan = {
  requestId: 'plan-1', anomalyId: 'sat-change-1', profile: 'inspect',
  rationale: 'deterministic inspect',
  tools: [{ tool: 'orbit_point', lat: -26.0906, lon: 29.4692, radius: 25 }, { tool: 'rtl' }],
};
const observation: ObservationSummary = {
  detected: true, observationAvailable: true, confidence: 0.91,
  classification: 'confirmed', modalities: ['rgb', 'thermal'],
  frames: { rgb: BASE64, thermal: 'evidence/thermal-0042.png' },
};

describe('reportPayload', () => {
  const payload = reportPayload(anomaly, plan, observation);
  const serialised = JSON.stringify(payload);

  it('carries no base64 blob at all', () => {
    expect(serialised).not.toContain('iVBORw0KGgo');
    expect(serialised).not.toContain('base64,');
  });

  it('is a small fraction of the raw payload it replaces', () => {
    const raw = JSON.stringify({ anomaly, plan, observation });
    expect(raw.length).toBeGreaterThan(20_000);
    expect(serialised.length).toBeLessThan(raw.length / 10);
  });

  it('tells the model an attachment existed rather than pretending it did not', () => {
    expect(serialised).toContain('embedded image/png attachment');
  });

  it('passes a genuine reference through unchanged', () => {
    const frames = (payload.observation as { frames: { thermal: string } }).frames;
    expect(frames.thermal).toBe('evidence/thermal-0042.png');
  });

  it('leaves the plan and every decision-bearing observation field intact', () => {
    expect(payload.plan).toEqual(plan);
    const summary = payload.observation as ObservationSummary;
    expect(summary.detected).toBe(true);
    expect(summary.confidence).toBe(0.91);
    expect(summary.classification).toBe('confirmed');
    expect(summary.modalities).toEqual(['rgb', 'thermal']);
  });

  it('leaves an observation with no frames alone', () => {
    const bare = reportPayload(anomaly, plan, { detected: false, confidence: 0 });
    expect((bare.observation as ObservationSummary).frames).toBeUndefined();
  });
});

describe('describeEvidenceRef', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['ground/satellite/data/after.png', 'ground/satellite/data/after.png'],
    ['ground\\satellite\\data\\after.png', 'ground/satellite/data/after.png'],
    ['../../etc/passwd', 'evidence reference supplied and omitted'],
    ['a'.repeat(400), 'evidence reference supplied and omitted'],
  ])('maps %s', (input, expected) => {
    expect(describeEvidenceRef(input)).toBe(expected);
  });

  it('names the media type of an embedded payload and its size', () => {
    expect(describeEvidenceRef('data:image/jpeg;base64,AAAA'))
      .toBe('embedded image/jpeg attachment (27 chars, omitted)');
  });
});

describe('triagePayload (unchanged: it never carried imagery)', () => {
  it('still shows the model summaries only', () => {
    const payload = triagePayload({
      anomalies: [anomaly], fleet: [], cueBudget: { used: 0, cap: 2 }, mode: 'attended',
      now: 1_757_116_800_000,
    });
    expect(JSON.stringify(payload)).not.toContain('base64');
    expect(JSON.stringify(payload)).not.toContain('thumbnail');
  });
});
