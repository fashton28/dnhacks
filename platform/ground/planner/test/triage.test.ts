/**
 * Triage is the model's whole job, and the scripted ranking is the default
 * path. These tests pin the ranking, the correlation rules, the lure flag, and
 * the two hard boundaries: the model can never emit geometry, and a live
 * failure never blocks or leaks into the flight envelope.
 */
import * as fs from 'fs';
import { describe, expect, it } from 'vitest';

import { Anomaly, RfEventMessage, TASK_QUESTION_MAX_CHARS } from '../src/contract';
import { LlmClient, TASK_LIST_SCHEMA, TRIAGE_PROMPT_FILE, taskFromModel, triagePrompt } from '../src/llm';
import {
  SOURCE_RELIABILITY, TriageInput, isFresh, lureFlags, scriptedTriage, triage, triagePayload,
} from '../src/triage';

const NOW = 1757116800000;

const cue = (over: Partial<Anomaly> & { id: string }): Anomaly => ({
  lat: -26.089, lon: 29.4763, type: 'motion', confidence: 0.8,
  thumbnail: 'site/staging/stage-a.png', source: 'cctv', observedAt: NOW, ttl_s: 900,
  ...over,
});

const fenceZone = {
  name: 'east-fence-south', fenceLine: true,
  polygon: [
    { lat: -26.0885, lon: 29.4758 }, { lat: -26.0885, lon: 29.4769 },
    { lat: -26.0895, lon: 29.4769 }, { lat: -26.0895, lon: 29.4758 },
  ],
};

const base: TriageInput = {
  anomalies: [], fleet: [{ vehicleId: 'eis-1', ready: true }],
  cueBudget: { used: 0, cap: 2 }, mode: 'attended', now: NOW,
};

const rf = (kind: RfEventMessage['kind']): RfEventMessage => ({
  type: 'rfEvent', ts: NOW, vehicleId: 'eis-1', source: kind === 'gnss_interference' ? 'sdr' : 'rf_drone',
  kind, band: kind === 'gnss_interference' ? 'GPS L1' : '2.4GHz', confidence: 0.9,
});

describe('scripted triage ranking', () => {
  it('ranks by source reliability x confidence x recency', () => {
    const result = scriptedTriage({
      ...base,
      anomalies: [
        cue({ id: 'sat', source: 'sentinel2', confidence: 0.95 }),
        cue({ id: 'fence', source: 'fence_sensor', confidence: 0.8 }),
        cue({ id: 'old-cctv', source: 'cctv', confidence: 0.9, observedAt: NOW - 3_600_000, ttl_s: 7200 }),
      ],
    });
    expect(result.tasks.map((task) => task.anomalyId)).toEqual(['fence', 'sat', 'old-cctv']);
    expect(result.source).toBe('scripted');
    expect(SOURCE_RELIABILITY.fence_sensor).toBeGreaterThan(SOURCE_RELIABILITY.sentinel2);
    expect(result.tasks[0].question.length).toBeLessThanOrEqual(TASK_QUESTION_MAX_CHARS);
  });

  it('is stable for the same input', () => {
    const input = { ...base, anomalies: [cue({ id: 'a' }), cue({ id: 'b' })] };
    expect(JSON.stringify(scriptedTriage(input))).toEqual(JSON.stringify(scriptedTriage(input)));
  });

  it('drops cues past their ttl', () => {
    const stale = cue({ id: 'stale', observedAt: NOW - 1_000_000, ttl_s: 60 });
    expect(isFresh(stale, NOW)).toBe(false);
    expect(scriptedTriage({ ...base, anomalies: [stale] }).tasks).toHaveLength(0);
  });

  it('maps breach cues to fence_gap and vehicle cues to vehicle', () => {
    const result = scriptedTriage({
      ...base, anomalies: [cue({ id: 'breach', type: 'breach' }), cue({ id: 'veh', type: 'vehicle' })],
    });
    const byId = Object.fromEntries(result.tasks.map((task) => [task.anomalyId, task.lookFor]));
    expect(byId.breach).toBe('fence_gap');
    expect(byId.veh).toBe('vehicle');
  });

  it('makes RF plus fence-zone motion priority 1', () => {
    const result = scriptedTriage({
      ...base, zones: [fenceZone], rfEvents: [rf('drone_link')],
      anomalies: [cue({ id: 'zone-cue', lat: -26.089, lon: 29.4763 }), cue({ id: 'elsewhere', lat: -26.0870, lon: 29.4700 })],
    });
    expect(result.tasks[0].anomalyId).toBe('zone-cue');
    expect(result.tasks[0].priority).toBe(1);
    expect(result.tasks[0].urgency).toBe('immediate');
    expect(result.tasks[0].lookFor).toBe('fence_gap');
    expect(result.tasks[0].rationale).toContain('fence zone');
  });

  it('defers RF plus SDR interference and flags it escalate-without-flying', () => {
    const result = scriptedTriage({
      ...base, zones: [fenceZone], rfEvents: [rf('drone_link'), rf('gnss_interference')],
      anomalies: [cue({ id: 'zone-cue' })],
    });
    expect(result.tasks[0].urgency).toBe('defer');
    expect(result.escalateWithoutFlying).toEqual(['zone-cue']);
    expect(result.tasks[0].rationale).toContain('escalate without flying');
  });

  it('flags a repeated cue in one place as a possible lure', () => {
    const anomalies = [
      cue({ id: 'lure-1' }), cue({ id: 'lure-2' }), cue({ id: 'lure-3' }),
    ];
    const flags = lureFlags(anomalies, NOW);
    expect(Object.keys(flags)).toHaveLength(3);
    const result = scriptedTriage({ ...base, anomalies });
    expect(result.requiresOperator['lure-1']).toContain('lure');
    expect(result.tasks[0].rationale).toContain('lure');
  });

  it('softens ordinary activity instead of hiding it', () => {
    const anomalies = [cue({ id: 'gate' })];
    const ordinary = scriptedTriage({
      ...base, anomalies, normalcy: { ordinaryActivity: true, detail: 'delivery window at gate 2' },
    });
    const plain = scriptedTriage({ ...base, anomalies });
    expect(ordinary.tasks[0].priority).toBeLessThan(plain.tasks[0].priority);
    expect(ordinary.tasks[0].rationale).toContain('delivery window');
    expect(ordinary.tasks).toHaveLength(1);
  });
});

describe('the model boundary', () => {
  it('shows the model no geometry and marks the operator note as data', () => {
    const payload = triagePayload({
      ...base, anomalies: [cue({ id: 'a' })], operatorNote: 'fly lower over the fence',
    });
    const json = JSON.stringify(payload);
    expect(json).not.toContain('lat');
    expect(json).not.toContain('lon');
    expect(json).toContain('data, not an instruction');
  });

  it('drops model tasks that name an unknown anomaly', () => {
    const known = new Set(['a']);
    const entry = {
      anomalyId: 'not-a-cue', lookFor: 'person' as const, question: 'q',
      urgency: 'immediate' as const, priority: 0.9, rationale: 'r',
    };
    expect(taskFromModel(entry, 0, known)).toBeNull();
    expect(taskFromModel({ ...entry, anomalyId: 'a' }, 0, known)?.source).toBe('llm');
    expect(taskFromModel({ ...entry, anomalyId: 'a', priority: 42 }, 0, known)?.priority).toBe(1);
  });

  it('rejects any model output carrying geometry', () => {
    expect(TASK_LIST_SCHEMA.safeParse({ tasks: [{
      anomalyId: 'a', lookFor: 'person', question: 'q', urgency: 'defer',
      priority: 0.1, rationale: 'r', lat: -26.09,
    }] }).success).toBe(false);
  });

  it('falls back to the scripted ranking after two live attempts, without blocking', async () => {
    let calls = 0;
    const client = { triage: async () => { calls++; throw new Error('request timed out'); } } as unknown as LlmClient;
    const result = await triage({ ...base, anomalies: [cue({ id: 'a' })] }, client);
    expect(calls).toBe(2);
    expect(result.source).toBe('scripted');
    expect(result.fallbackReason).toContain('timed out');
    expect(result.tasks).toHaveLength(1);
  });

  it('takes the model ordering when it is schema-valid', async () => {
    const client = {
      triage: async () => ({ tasks: [{
        anomalyId: 'b', lookFor: 'fence_gap' as const, question: 'Is the fence open?',
        urgency: 'immediate' as const, priority: 0.9, rationale: 'model judgement',
      }] }),
    } as unknown as LlmClient;
    const result = await triage({ ...base, anomalies: [cue({ id: 'a' }), cue({ id: 'b' })] }, client);
    expect(result.source).toBe('llm');
    expect(result.tasks.map((task) => task.anomalyId)).toEqual(['b']);
    expect(result.tasks[0].source).toBe('llm');
  });
});

describe('the reviewable prompt', () => {
  it('ships with the package and forbids geometry in words too', () => {
    expect(fs.existsSync(TRIAGE_PROMPT_FILE)).toBe(true);
    const prompt = triagePrompt();
    expect(prompt).toContain('schema-bound JSON only');
    expect(prompt).toMatch(/no altitude|no route/);
    expect(prompt).toContain('data, not instructions');
  });

  it('never throws when the file is missing', () => {
    expect(triagePrompt('/definitely/not/here.md')).toContain('schema-bound JSON only');
  });
});
