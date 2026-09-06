/* ============================================================================
 * FM-160 — `Detection` (ARGUS Hub) ⟷ `Anomaly` (this stack).
 *
 * Before this adapter existed the mapping was prose in REPOSITORY_REVIEW and a
 * hand-rolled POST was rejected 422 on three counts at once. The fixtures below
 * are the two directions, plus the refusals that keep the adapter from
 * inventing the evidence references the Hub demands.
 * ========================================================================== */
import { describe, expect, it } from 'vitest';
import { Anomaly } from '../src/contract';
import {
  AdapterError, HUB_CHANGE_TYPES, POINT_FOOTPRINT_M, anomalyFromHubDetection,
  hubDetectionFromAnomaly, parseHubDetection, squareAround,
} from '../src/hub_adapter';
import { haversineMeters, polygonCentroid } from '../src/geometry';

/** A Detection exactly as `contracts/models.py` serialises one. */
const detection = {
  id: 'det-7',
  polygon: [
    { lat: -26.0910, lon: 29.4690 },
    { lat: -26.0910, lon: 29.4695 },
    { lat: -26.0905, lon: 29.4695 },
    { lat: -26.0905, lon: 29.4690 },
  ],
  confidence: 0.82,
  change_type: 'intruder_vehicle',
  before_ref: 'tiles/komati/2024-11-02.png',
  after_ref: 'tiles/komati/2024-11-14.png',
  detected_at: '2025-09-06T00:00:00+00:00',
  area_m2: 2500,
  metadata: { source: 'sentinel2', analyst: 'wide-area' },
};

describe('parseHubDetection', () => {
  it('accepts a well-formed Detection', () => {
    expect(parseHubDetection(detection).id).toBe('det-7');
  });

  it('rejects an extra field loudly, the way the Hub\'s extra="forbid" does', () => {
    expect(() => parseHubDetection({ ...detection, sneaky: 1 }))
      .toThrow(/unexpected field\(s\) sneaky/);
  });

  it.each([
    ['a two-vertex ring', { polygon: detection.polygon.slice(0, 2) }, /at least 3 vertices/],
    ['a confidence above 1', { confidence: 1.5 }, /confidence must be in/],
    ['an unknown change_type', { change_type: 'teleport' }, /change_type must be one of/],
    ['a missing before_ref', { before_ref: undefined }, /before_ref and after_ref/],
    ['an unparseable timestamp', { detected_at: 'yesterday' }, /ISO 8601/],
    ['a non-string metadata value', { metadata: { source: 7 } }, /string.*map/],
    ['an out-of-range vertex', { polygon: [{ lat: 200, lon: 0 }, { lat: 0, lon: 0 }, { lat: 1, lon: 1 }] },
      /valid lat\/lon/],
  ])('rejects %s', (_label, patch, message) => {
    expect(() => parseHubDetection({ ...detection, ...patch })).toThrow(message);
  });

  it('covers every change_type the Hub declares', () => {
    for (const changeType of HUB_CHANGE_TYPES) {
      const { anomaly } = anomalyFromHubDetection({ ...detection, change_type: changeType });
      expect(typeof anomaly.type).toBe('string');
      expect(anomaly.type.length).toBeGreaterThan(0);
    }
  });
});

describe('Detection → Anomaly', () => {
  const { anomaly, extras } = anomalyFromHubDetection(detection);

  it('collapses the polygon to its centroid, the only point the area agrees on', () => {
    const centroid = polygonCentroid(detection.polygon);
    expect(haversineMeters(anomaly, centroid)).toBeLessThan(0.01);
  });

  it('carries id, confidence, evidence and observation time across', () => {
    expect(anomaly.id).toBe('det-7');
    expect(anomaly.confidence).toBe(0.82);
    expect(anomaly.thumbnail).toBe(detection.after_ref);
    expect(anomaly.observedAt).toBe(Date.parse(detection.detected_at));
    expect(anomaly.ttl_s).toBeGreaterThan(0);
  });

  it('maps change_type onto a kind the triage table already knows', () => {
    expect(anomaly.type).toBe('vehicle');
    expect(anomalyFromHubDetection({ ...detection, change_type: 'fence_breach' }).anomaly.type)
      .toBe('fence_gap');
  });

  it('keeps what an Anomaly has nowhere to put instead of dropping it', () => {
    expect(extras.polygon).toEqual(detection.polygon);
    expect(extras.areaM2).toBe(2500);
    expect(extras.beforeRef).toBe(detection.before_ref);
    expect(extras.metadata.analyst).toBe('wide-area');
  });

  it('falls back to a known rail rather than inventing one', () => {
    const unknown = anomalyFromHubDetection({ ...detection, metadata: { source: 'orbital-mind-laser' } });
    expect(unknown.anomaly.source).toBe('sentinel2');
    const declared = anomalyFromHubDetection({ ...detection, metadata: { source: 'cctv' } });
    expect(declared.anomaly.source).toBe('cctv');
  });
});

describe('Anomaly → Detection', () => {
  const anomaly: Anomaly = {
    id: 'sat-change-1', lat: -26.090664, lon: 29.469245, type: 'change',
    confidence: 0.94, thumbnail: 'ground/satellite/data/after.png', source: 'sentinel2',
    observedAt: Date.parse('2025-09-06T00:00:00Z'),
  };

  it('produces a record the Hub\'s own validator accepts', () => {
    const published = hubDetectionFromAnomaly(anomaly, { beforeRef: 'ground/satellite/data/before.png' });
    expect(() => parseHubDetection(published)).not.toThrow();
    expect(published.id).toBe('sat-change-1');
    expect(published.change_type).toBe('ground_disturbance');
    expect(published.metadata.source).toBe('sentinel2');
    expect(published.detected_at).toBe('2025-09-06T00:00:00.000Z');
  });

  it('turns a point into the smallest honest footprint', () => {
    const published = hubDetectionFromAnomaly(anomaly, { beforeRef: 'before.png' });
    expect(published.polygon).toHaveLength(4);
    expect(published.area_m2).toBe(POINT_FOOTPRINT_M * POINT_FOOTPRINT_M);
    const centroid = polygonCentroid(published.polygon);
    expect(haversineMeters(centroid, anomaly)).toBeLessThan(0.5);
  });

  it('refuses rather than inventing the baseline frame the Hub requires', () => {
    expect(() => hubDetectionFromAnomaly(anomaly)).toThrow(AdapterError);
    expect(() => hubDetectionFromAnomaly(anomaly)).toThrow(/holds no baseline frame/);
  });

  it('refuses a cue whose only "reference" is an embedded image payload', () => {
    const embedded: Anomaly = { ...anomaly, thumbnail: `data:image/png;base64,${'A'.repeat(4000)}` };
    expect(() => hubDetectionFromAnomaly(embedded, { beforeRef: 'before.png' }))
      .toThrow(/no usable image reference/);
  });

  it('refuses a cue with a non-finite position', () => {
    expect(() => hubDetectionFromAnomaly({ ...anomaly, lat: Number.NaN },
      { beforeRef: 'before.png' })).toThrow(/no finite position/);
  });

  it('publishes a real footprint unchanged when the caller has one', () => {
    const published = hubDetectionFromAnomaly(anomaly, {
      beforeRef: 'before.png', polygon: detection.polygon,
    });
    expect(published.polygon).toEqual(detection.polygon);
    expect(published.area_m2).toBeNull();
  });
});

describe('round trip', () => {
  it('Detection → Anomaly → Detection preserves identity, confidence and evidence', () => {
    const { anomaly, extras } = anomalyFromHubDetection(detection);
    const back = hubDetectionFromAnomaly(anomaly, {
      beforeRef: extras.beforeRef, polygon: extras.polygon,
      changeType: extras.changeType, metadata: extras.metadata,
    });
    expect(back.id).toBe(detection.id);
    expect(back.confidence).toBe(detection.confidence);
    expect(back.before_ref).toBe(detection.before_ref);
    expect(back.after_ref).toBe(detection.after_ref);
    expect(back.polygon).toEqual(detection.polygon);
    expect(back.change_type).toBe(detection.change_type);
    expect(back.detected_at).toBe(new Date(Date.parse(detection.detected_at)).toISOString());
  });

  it('flattens `intruder_vehicle` to `vehicle` when the original is not carried', () => {
    // Documented lossy direction: "intruder" is a conclusion, and our cue kinds
    // are observations. `DetectionExtras.changeType` is how a caller keeps it.
    const { anomaly, extras } = anomalyFromHubDetection(detection);
    const lossy = hubDetectionFromAnomaly(anomaly, { beforeRef: extras.beforeRef });
    expect(lossy.change_type).toBe('vehicle');
  });
});

describe('squareAround', () => {
  it('is centred on its point and the requested size on both axes', () => {
    const centre = { lat: -26.09, lon: 29.47 };
    const ring = squareAround(centre, 20);
    expect(haversineMeters(polygonCentroid(ring), centre)).toBeLessThan(0.5);
    expect(haversineMeters(ring[0], ring[1])).toBeCloseTo(20, 0);
    expect(haversineMeters(ring[1], ring[2])).toBeCloseTo(20, 0);
  });
});
