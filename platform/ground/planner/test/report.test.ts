import { describe, expect, it } from 'vitest';

import { Anomaly, MissionPlan } from '../src/contract';
import { ESCALATE_CONFIDENCE, reportVerdict, writeIncidentReport } from '../src/report';

const anomaly: Anomaly = {
  id: 'anom-9', lat: -35.36, lon: 149.16, type: 'change', confidence: 0.77,
  thumbnail: 'x.png', source: 'sentinel2',
};

const plan: MissionPlan = {
  requestId: 'req-9',
  anomalyId: 'anom-9',
  profile: 'standard',
  rationale: 'survey',
  tools: [
    { tool: 'goto_gps', lat: -35.36, lon: 149.16, alt: 40, profile: 'standard' },
    { tool: 'orbit_point', lat: -35.36, lon: 149.16, radius: 25 },
    { tool: 'hold', durationS: 10 },
    { tool: 'rtl' },
  ],
};

describe('reportVerdict mapping', () => {
  it('confident detection -> escalate', () => {
    expect(reportVerdict({ detected: true, observationAvailable: true, classification: 'confirmed', confidence: ESCALATE_CONFIDENCE })).toBe('escalate');
    expect(reportVerdict({ detected: true, observationAvailable: true, classification: 'confirmed', confidence: 0.95 })).toBe('escalate');
  });
  it('nothing seen -> escalate for human review', () => {
    expect(reportVerdict({ detected: false, observationAvailable: false, confidence: 0.9 })).toBe('escalate');
  });
  it('ambiguous detection -> escalate', () => {
    expect(reportVerdict({ detected: true, observationAvailable: true, confidence: ESCALATE_CONFIDENCE - 0.01 })).toBe('escalate');
  });
});

describe('writeIncidentReport', () => {
  it('produces the four required markdown sections and correlates by requestId', () => {
    const report = writeIncidentReport(anomaly, plan, { detected: true, observationAvailable: true, classification: 'confirmed', confidence: 0.9 });
    expect(report.missionId).toBe(plan.requestId);
    expect(report.verdict).toBe('escalate');
    for (const section of ['## What was flagged', '## What flew', '## What was seen', '## Recommendation']) {
      expect(report.markdown).toContain(section);
    }
    expect(report.markdown).toContain(anomaly.id);
  });

  it('carries the staging ground truth when provided (demo path)', () => {
    const report = writeIncidentReport(anomaly, plan, {
      detected: false, observationAvailable: true, confidence: 0.9, classification: 'false_alarm', stagingTruth: 'false_alarm',
    });
    expect(report.verdict).toBe('false_alarm');
    expect(report.markdown).toContain('false_alarm');
    expect(report.markdown).toContain('ground truth');
  });

  it('is deterministic (no timestamps/randomness)', () => {
    const a = writeIncidentReport(anomaly, plan, { detected: true, confidence: 0.5 });
    const b = writeIncidentReport(anomaly, plan, { detected: true, confidence: 0.5 });
    expect(b).toEqual(a);
  });

  it('does not dump embedded image bytes into markdown', () => {
    const embedded = { ...anomaly, thumbnail: `data:image/png;base64,${'A'.repeat(20_000)}` };
    const report = writeIncidentReport(embedded, plan, {
      detected: true, observationAvailable: true, classification: 'confirmed', confidence: 0.9,
      frames: { rgb: embedded.thumbnail, thermal: embedded.thumbnail },
    });
    expect(report.markdown).toContain('embedded image thumbnail is attached');
    expect(report.markdown).not.toContain('data:image');
    expect(report.markdown.length).toBeLessThan(5_000);
  });
});
