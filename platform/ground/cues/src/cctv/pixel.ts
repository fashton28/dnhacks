/* ============================================================================
 * eis-cues/cctv — pixel mode: the calibrated ONE-STREAM fallback.
 *
 * Event mode is the default and the primary path. Pixel mode exists for a
 * camera whose VMS gives no events, is enabled explicitly (EIS_CCTV_MODE=pixel)
 * and covers exactly ONE stream — an analytics farm is not in scope.
 *
 * Geometry (all site-derived; nothing here hardcodes plant coordinates):
 *
 *   bearing = heading_deg + (u - 0.5) * fov_deg
 *             where u is the box's centre COLUMN as a fraction of image width.
 *             Column 0 is the left edge of the frame, which is the LEFT edge of
 *             the cone looking along the optical axis, i.e. heading - fov/2.
 *
 *   range   = refRangeM * refBoxHeightPx / boxHeightPx
 *             the pinhole similar-triangles relation for an object of roughly
 *             constant real height: apparent height falls off as 1/range.
 *             `refBoxHeightPx` is the calibrated box height of that class at
 *             `refRangeM` for THIS camera.
 *
 * The projected point is then clamped into the camera's `fov_polygon`: a cue
 * may never claim ground the camera cannot see. A cue that still lands outside
 * the operational geofence is REFUSED with a calibration warning — that is a
 * miscalibrated camera, not a discovery (docs/FAILURE_MODES.md, "Miscalibrated
 * camera").
 *
 * A detector is an interface, not a dependency: the stub is deterministic and
 * offline, and a YOLO backend is optional and injected.
 * ========================================================================== */

import { clampIntoPolygon, pointInPolygon, destination, normalizeBearing, type LatLon } from '../geo.js';
import type { CueSite, SiteCamera } from '../site.js';

/** One decoded video frame handed to a detector. Format-agnostic on purpose. */
export interface CameraFrame {
  cameraId: string;
  /** Epoch ms the frame was captured. */
  ts: number;
  widthPx: number;
  heightPx: number;
  /** Encoded frame bytes (the ffmpeg source emits PNG/JPEG). */
  data: Uint8Array;
}

/** A detection in PIXEL coordinates, origin top-left. */
export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
  class: string;
  confidence: number;
}

/**
 * The detector seam. The scripted stub implements it; a YOLO backend is an
 * optional injection and is never required for the demo or test path.
 */
export interface PixelDetector {
  readonly name: string;
  detect(frame: CameraFrame): PixelBox[] | Promise<PixelBox[]>;
}

/**
 * Deterministic offline stub. It reports whatever boxes it was primed with for
 * a camera and NEVER invents a detection from frame bytes — a stub that
 * hallucinated would make a camera failure look like a quiet scene.
 */
export class ScriptedPixelDetector implements PixelDetector {
  readonly name = 'scripted';

  constructor(private readonly boxesByCamera: Record<string, PixelBox[]> = {}) {}

  setBoxes(cameraId: string, boxes: PixelBox[]): void {
    this.boxesByCamera[cameraId] = boxes;
  }

  detect(frame: CameraFrame): PixelBox[] {
    return this.boxesByCamera[frame.cameraId] ?? [];
  }
}

/** Per-camera pixel calibration.
 *
 *  GAP: docs/SITE_CONTRACT.md carries no pixel calibration for `cameras`, so
 *  this is a cues-owned config (fixtures/cctv_calibration.json). It is
 *  deliberately NOT derived from the site file: a wrong calibration must be
 *  fixable without editing site geometry. */
export interface CameraCalibration {
  cameraId: string;
  imageWidthPx: number;
  imageHeightPx: number;
  /** Calibrated box height, pixels, for `refClass` at `refRangeM`. */
  refBoxHeightPx: number;
  refRangeM: number;
  /** The class the reference height was measured on, e.g. 'person'. */
  refClass: string;
  /** Per-class real-height ratio relative to `refClass` (a vehicle is taller). */
  classHeightRatio?: Record<string, number>;
}

export interface CalibrationProblem {
  cameraId: string;
  reason: string;
}

/** Validate a calibration against its camera. Returns every problem found. */
export function validateCalibration(
  calibration: CameraCalibration,
  camera: SiteCamera | undefined,
): CalibrationProblem[] {
  const problems: CalibrationProblem[] = [];
  const bad = (reason: string): void => {
    problems.push({ cameraId: calibration.cameraId, reason });
  };
  if (!camera) {
    bad('no camera with this id exists in the site model');
    return problems;
  }
  for (const [key, value] of [
    ['imageWidthPx', calibration.imageWidthPx],
    ['imageHeightPx', calibration.imageHeightPx],
    ['refBoxHeightPx', calibration.refBoxHeightPx],
    ['refRangeM', calibration.refRangeM],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) bad(`${key} must be a finite number > 0`);
  }
  if (calibration.refRangeM > camera.rangeM) {
    bad(`refRangeM ${calibration.refRangeM} m exceeds the camera's useful range ${camera.rangeM} m`);
  }
  if (!Number.isFinite(camera.fovDeg) || camera.fovDeg <= 0 || camera.fovDeg > 360) {
    bad('camera fov_deg is outside (0, 360]');
  }
  if (!Number.isFinite(camera.headingDeg) || camera.headingDeg < 0 || camera.headingDeg >= 360) {
    bad('camera heading_deg is outside [0, 360)');
  }
  if (!Number.isFinite(camera.rangeM) || camera.rangeM <= 0) {
    bad('camera range_m is not positive');
  }
  if (camera.fovPolygon.length < 3) {
    bad('camera fov_polygon has fewer than three vertices');
  }
  return problems;
}

export interface PixelProjection {
  point: LatLon;
  bearingDeg: number;
  rangeM: number;
  /** True when the raw projection fell outside the FOV cone and was clamped. */
  clampedToFov: boolean;
}

/**
 * Project one box onto the ground for a camera. Pure geometry — no policy.
 * Throws when the box is unusable (zero height, off-frame), which the rail
 * turns into a rejection plus a calibration warning.
 */
export function projectBox(
  box: PixelBox,
  camera: SiteCamera,
  calibration: CameraCalibration,
): PixelProjection {
  if (!Number.isFinite(box.h) || box.h <= 0) {
    throw new Error('box height must be > 0 px to derive a range');
  }
  if (!Number.isFinite(box.x) || !Number.isFinite(box.w) || box.w <= 0) {
    throw new Error('box column must be finite and the width > 0 px');
  }
  const centreColumn = box.x + box.w / 2;
  if (centreColumn < 0 || centreColumn > calibration.imageWidthPx) {
    throw new Error('box centre column falls outside the calibrated image width');
  }
  const u = centreColumn / calibration.imageWidthPx;
  const bearingDeg = normalizeBearing(camera.headingDeg + (u - 0.5) * camera.fovDeg);

  const ratio = calibration.classHeightRatio?.[box.class] ?? 1;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw new Error(`class height ratio for ${box.class} must be > 0`);
  }
  const rawRangeM = (calibration.refRangeM * calibration.refBoxHeightPx * ratio) / box.h;
  const rangeM = Math.min(rawRangeM, camera.rangeM);

  const raw = destination({ lat: camera.lat, lon: camera.lon }, bearingDeg, rangeM);
  const inFov = pointInPolygon(raw, camera.fovPolygon);
  const point = inFov ? raw : clampIntoPolygon(raw, camera.fovPolygon);
  return { point, bearingDeg, rangeM, clampedToFov: !inFov };
}

/** A projected cue that survived every geometric check. */
export interface PixelCue {
  point: LatLon;
  bearingDeg: number;
  rangeM: number;
  clampedToFov: boolean;
  box: PixelBox;
}

export type PixelProjectionResult =
  | { ok: true; cue: PixelCue }
  | { ok: false; reason: string; calibrationWarning: boolean };

/**
 * Project a box and enforce the operational geofence.
 *
 * A pixel-derived cue outside `site.geofence` means the camera's heading, FOV,
 * range or reference height is wrong — the projection is refused and the caller
 * raises a calibration warning naming the camera.
 */
export function projectPixelCue(
  box: PixelBox,
  camera: SiteCamera,
  calibration: CameraCalibration,
  site: CueSite,
): PixelProjectionResult {
  let projection: PixelProjection;
  try {
    projection = projectBox(box, camera, calibration);
  } catch (err) {
    return { ok: false, reason: (err as Error).message, calibrationWarning: true };
  }
  if (!pointInPolygon(projection.point, site.geofence)) {
    return {
      ok: false,
      reason:
        `projected ${projection.rangeM.toFixed(0)} m at ${projection.bearingDeg.toFixed(0)}° ` +
        'to a point outside the operational geofence',
      calibrationWarning: true,
    };
  }
  return { ok: true, cue: { ...projection, box } };
}

/** Validate already-parsed calibration JSON: `{ cameras: CameraCalibration[] }`. */
export function parseCalibrations(data: unknown): CameraCalibration[] {
  if (typeof data !== 'object' || data === null) {
    throw new Error('invalid cctv calibration: root must be an object');
  }
  const list = (data as { cameras?: unknown }).cameras;
  if (!Array.isArray(list)) {
    throw new Error('invalid cctv calibration: "cameras" must be an array');
  }
  return list.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`invalid cctv calibration: cameras[${i}] must be an object`);
    }
    const c = entry as Record<string, unknown>;
    if (typeof c.cameraId !== 'string' || c.cameraId === '') {
      throw new Error(`invalid cctv calibration: cameras[${i}].cameraId must be a non-empty string`);
    }
    if (typeof c.refClass !== 'string' || c.refClass === '') {
      throw new Error(`invalid cctv calibration: cameras[${i}].refClass must be a non-empty string`);
    }
    const nums: Record<string, number> = {};
    for (const key of ['imageWidthPx', 'imageHeightPx', 'refBoxHeightPx', 'refRangeM'] as const) {
      const value = c[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`invalid cctv calibration: cameras[${i}].${key} must be a finite number`);
      }
      nums[key] = value;
    }
    const ratios = c.classHeightRatio;
    return {
      cameraId: c.cameraId,
      imageWidthPx: nums.imageWidthPx,
      imageHeightPx: nums.imageHeightPx,
      refBoxHeightPx: nums.refBoxHeightPx,
      refRangeM: nums.refRangeM,
      refClass: c.refClass,
      ...(typeof ratios === 'object' && ratios !== null
        ? { classHeightRatio: ratios as Record<string, number> }
        : {}),
    };
  });
}
