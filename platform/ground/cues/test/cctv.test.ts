/* The CCTV rail: zone mapping in event mode, and the calibrated pixel fallback
 * with its geofence refusal. */

import { describe, expect, it } from 'vitest';

import {
  CctvRail, ManualScheduler, ScriptedPixelDetector, mapOnvifNotification,
  parseVmsEvent, pointInPolygon, projectBox, projectPixelCue, validateCalibration,
} from '../src/index.js';
import { findCamera } from '../src/site.js';
import { loadCalibrations } from '../src/node/load.js';
import type { CameraCalibration, CameraFrame, PixelBox } from '../src/cctv/pixel.js';
import { FIXTURES_DIR, QUIET_START_MS, record, stubSite } from './helpers.js';

const site = stubSite();
const calibrations = loadCalibrations(FIXTURES_DIR);
const eastSouth = findCamera(site, 'cam-east-south')!;
const eastSouthCal = calibrations.find((c) => c.cameraId === 'cam-east-south')!;

function frame(cameraId: string, ts = QUIET_START_MS): CameraFrame {
  return { cameraId, ts, widthPx: 1280, heightPx: 720, data: new Uint8Array(0) };
}

/** A person 80 px tall at image centre → 100 m along the optical axis. */
function centredBox(heightPx: number): PixelBox {
  return { x: 620, y: 300, w: 40, h: heightPx, class: 'person', confidence: 0.7 };
}

describe('event mode', () => {
  it('rejects a VMS record naming an unknown camera or zone', async () => {
    const rail = new CctvRail({ scheduler: new ManualScheduler(QUIET_START_MS), site });
    const seen = record(rail);
    await rail.start();
    rail.ingest({ cameraId: 'cam-nowhere', zone: 'east-fence-north', ts: QUIET_START_MS });
    rail.ingest({ cameraId: 'cam-east-north', zone: 'not-a-zone', ts: QUIET_START_MS });
    expect(seen.anomalies).toHaveLength(0);
    expect(rail.health().counts.rejected).toBe(2);
    expect(seen.health.map((h) => h.detail).join(' ')).toMatch(/not in the site model/);
    expect(seen.health.map((h) => h.detail).join(' ')).toMatch(/does not define/);
  });

  it('validates the generic VMS shape before anything else looks at it', () => {
    expect(() => parseVmsEvent({ zone: 'z', ts: 1 })).toThrow(/cameraId/);
    expect(() => parseVmsEvent({ cameraId: 'c', ts: 1 })).toThrow(/zone/);
    expect(() => parseVmsEvent({ cameraId: 'c', zone: 'z' })).toThrow(/ts/);
    expect(() => parseVmsEvent({ cameraId: 'c', zone: 'z', ts: 1, confidence: 2 }))
      .toThrow(/confidence/);
    expect(parseVmsEvent({ cameraId: 'c', zone: 'z', ts: 5, class: 'person' }))
      .toEqual({ cameraId: 'c', zone: 'z', ts: 5, class: 'person' });
  });

  it('maps an ONVIF motion notification onto the generic shape', () => {
    const mapped = mapOnvifNotification({
      topic: 'tns1:RuleEngine/CellMotionDetector/Motion',
      source: { VideoSourceConfigurationToken: 'cam-east-south', RuleName: 'switchyard-approach' },
      data: { IsMotion: 'true', ObjectType: 'Person' },
      utcTime: '2024-01-10T22:00:00.000Z',
    });
    expect(mapped).toEqual({
      cameraId: 'cam-east-south',
      zone: 'switchyard-approach',
      class: 'person',
      ts: Date.UTC(2024, 0, 10, 22, 0, 0),
    });
  });

  it('ignores an un-carried ONVIF topic and refuses one with no provenance', () => {
    expect(mapOnvifNotification({
      topic: 'tns1:Device/HardwareFailure/StorageFailure', source: {}, utcTime: '2024-01-10T22:00:00Z',
    })).toBeNull();
    expect(() => mapOnvifNotification({
      topic: 'tns1:VideoSource/MotionAlarm', source: { RuleName: 'z' }, utcTime: '2024-01-10T22:00:00Z',
    })).toThrow(/video source token/);
  });
});

describe('pixel projection', () => {
  it('derives bearing from the pixel column across the field of view', () => {
    const centre = projectBox(centredBox(80), eastSouth, eastSouthCal);
    expect(centre.bearingDeg).toBeCloseTo(270, 6);

    const left = projectBox({ ...centredBox(80), x: 0, w: 40 }, eastSouth, eastSouthCal);
    const right = projectBox({ ...centredBox(80), x: 1_240, w: 40 }, eastSouth, eastSouthCal);
    // Total swing across the frame is the camera's full horizontal FOV.
    expect(right.bearingDeg - left.bearingDeg).toBeCloseTo(eastSouth.fovDeg * (1_240 / 1_280), 3);
  });

  it('derives range from box height and clamps it to the camera range', () => {
    expect(projectBox(centredBox(80), eastSouth, eastSouthCal).rangeM).toBeCloseTo(100, 6);
    expect(projectBox(centredBox(160), eastSouth, eastSouthCal).rangeM).toBeCloseTo(50, 6);
    // A tiny box would project past the camera's useful range; it is clamped.
    expect(projectBox(centredBox(1), eastSouth, eastSouthCal).rangeM).toBe(eastSouth.rangeM);
  });

  it('clamps a projection back into the camera footprint', () => {
    const projected = projectBox(centredBox(80), eastSouth, eastSouthCal);
    expect(pointInPolygon(projected.point, eastSouth.fovPolygon)).toBe(true);
    expect(projected.clampedToFov).toBe(false);
  });

  it('accepts a cue that lands inside the operational geofence', () => {
    const result = projectPixelCue(centredBox(80), eastSouth, eastSouthCal, site);
    expect(result.ok).toBe(true);
    if (result.ok) expect(pointInPolygon(result.cue.point, site.geofence)).toBe(true);
  });

  it('refuses a miscalibrated cue that lands outside the geofence', () => {
    // A box eight times the calibrated height puts the target 12.5 m out — back
    // behind the fence line, where this camera sits OUTSIDE the geofence.
    const result = projectPixelCue(centredBox(640), eastSouth, eastSouthCal, site);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.calibrationWarning).toBe(true);
      expect(result.reason).toMatch(/outside the operational geofence/);
    }
  });

  it('refuses a box with no height rather than inventing a range', () => {
    const result = projectPixelCue({ ...centredBox(80), h: 0 }, eastSouth, eastSouthCal, site);
    expect(result.ok).toBe(false);
  });
});

describe('calibration validation', () => {
  it('accepts the shipped calibration against the stub site', () => {
    for (const calibration of calibrations) {
      expect(validateCalibration(calibration, findCamera(site, calibration.cameraId))).toEqual([]);
    }
  });

  it('names every problem it finds', () => {
    const broken: CameraCalibration = { ...eastSouthCal, refBoxHeightPx: 0, refRangeM: 9_999 };
    const problems = validateCalibration(broken, eastSouth);
    expect(problems.map((p) => p.reason).join(' ')).toMatch(/refBoxHeightPx/);
    expect(problems.map((p) => p.reason).join(' ')).toMatch(/exceeds the camera's useful range/);
    expect(validateCalibration(eastSouthCal, undefined)[0].reason).toMatch(/no camera with this id/);
  });

  it('corrupted camera geometry is caught rather than projected', () => {
    const corrupted = { ...eastSouth, fovDeg: 0, headingDeg: 400, rangeM: -1 };
    const problems = validateCalibration(eastSouthCal, corrupted).map((p) => p.reason).join(' ');
    expect(problems).toMatch(/fov_deg/);
    expect(problems).toMatch(/heading_deg/);
    expect(problems).toMatch(/range_m/);
  });
});

describe('pixel mode on the rail', () => {
  function pixelRail(detector: ScriptedPixelDetector) {
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const rail = new CctvRail({ scheduler, site, mode: 'pixel', calibrations, detector });
    return { scheduler, rail, seen: record(rail) };
  }

  it('emits a cue whose zone is the one the projection landed in', async () => {
    const detector = new ScriptedPixelDetector({
      // 1150 px column, 46 px tall → east of the axis, ~174 m out.
      'cam-east-south': [{ x: 1_130, y: 300, w: 40, h: 46, class: 'person', confidence: 0.81 }],
    });
    const { rail, seen } = pixelRail(detector);
    await rail.start();
    const emitted = await rail.ingestFrame(frame('cam-east-south'));

    expect(emitted).toBe(1);
    expect(seen.anomalies[0].anomaly).toMatchObject({
      source: 'cctv', cameraId: 'cam-east-south', type: 'person_in_zone', confidence: 0.81,
    });
    expect(pointInPolygon(
      { lat: seen.anomalies[0].anomaly.lat, lon: seen.anomalies[0].anomaly.lon },
      site.geofence,
    )).toBe(true);
  });

  it('refuses the miscalibrated projection and warns, naming the camera', async () => {
    const detector = new ScriptedPixelDetector({ 'cam-east-south': [centredBox(640)] });
    const { rail, seen } = pixelRail(detector);
    await rail.start();
    const emitted = await rail.ingestFrame(frame('cam-east-south'));

    expect(emitted).toBe(0);
    expect(seen.anomalies).toHaveLength(0);
    const warning = seen.health.find((h) => h.detail.includes('calibration warning'));
    expect(warning?.state).toBe('warning');
    expect(warning?.detail).toContain('cam-east-south');
    expect(warning?.detail).toContain('cue refused');
    expect(warning?.component).toBe('camera');
  });

  it('produces no pixel cue for a camera with no calibration', async () => {
    const detector = new ScriptedPixelDetector({ 'cam-east-south': [centredBox(80)] });
    const scheduler = new ManualScheduler(QUIET_START_MS);
    const rail = new CctvRail({ scheduler, site, mode: 'pixel', calibrations: [], detector });
    const seen = record(rail);
    await rail.start();
    expect(await rail.ingestFrame(frame('cam-east-south'))).toBe(0);
    expect(seen.health.some((h) => h.detail.includes('no pixel calibration is configured'))).toBe(true);
  });

  it('needs a detector before it will start in pixel mode', async () => {
    const rail = new CctvRail({
      scheduler: new ManualScheduler(QUIET_START_MS), site, mode: 'pixel', calibrations,
    });
    await rail.start();
    expect(rail.health().state).toBe('failed');
    expect(rail.health().detail).toMatch(/needs a detector/);
  });

  it('ignores a frame while the rail is in event mode', async () => {
    const rail = new CctvRail({ scheduler: new ManualScheduler(QUIET_START_MS), site });
    const seen = record(rail);
    await rail.start();
    expect(await rail.ingestFrame(frame('cam-east-south'))).toBe(0);
    expect(seen.health.some((h) => h.detail.includes('event mode'))).toBe(true);
  });
});
