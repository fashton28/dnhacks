/* ============================================================================
 * eis-cues — the CCTV rail.
 *
 * Event mode FIRST (ADR D25): a VMS event names the camera and the zone, the
 * site model turns the zone into a location, and the class ranks the cue. Pixel
 * mode is the calibrated one-stream fallback, enabled explicitly.
 *
 * What this rail may and may not do:
 *  - It emits `anomaly` cues and `healthEvent`s, plus the contract's existing
 *    `cctvEvent` for audit provenance. It introduces no wire message.
 *  - A class label ranks a cue. It never establishes identity, intent or
 *    authorisation, and nothing here decides a dispatch.
 *  - A camera reported offline makes its zones BLIND: no cue, and therefore no
 *    dispatch, originates from a zone nobody is watching.
 *  - The VMS failing takes only this rail out. Every other rail is unaffected.
 * ========================================================================== */

import { BaseRail, type RailOptions } from '../base.js';
import type { CctvEventMessage, Unsubscribe } from '../contract.js';
import { pointInPolygon, polygonCentroid } from '../geo.js';
import { EMPTY_NORMALCY, normalcyRules, normalcySuppression, type SiteNormalcy } from '../normalcy.js';
import { DEFAULT_CAMERA_RATE_LIMIT } from '../rateLimit.js';
import { findCamera, findZone, type CueSite } from '../site.js';
import type {
  BlindZone, DecodedCue, RailId, RateLimit, WhitelistRule,
} from '../types.js';
import {
  cctvCueType, parseVmsEvent, vmsConfidence, type VmsEvent,
} from '../cctv/vms.js';
import {
  projectPixelCue, validateCalibration,
  type CameraCalibration, type CameraFrame, type PixelDetector,
} from '../cctv/pixel.js';

export type CctvMode = 'event' | 'pixel';

/** Default camera-cue lifetime. A person seen at a fence is worth acting on for
 *  a couple of minutes; past that the observation no longer describes the site. */
export const CCTV_DEFAULT_TTL_S = 180;

export interface CctvRailOptions extends RailOptions {
  site: CueSite;
  /** Event mode is the default; pixel mode must be asked for. */
  mode?: CctvMode;
  normalcy?: SiteNormalcy;
  /** Pixel mode only. A camera with no calibration cannot produce a pixel cue. */
  calibrations?: CameraCalibration[];
  /** Pixel mode only. */
  detector?: PixelDetector;
  /** Per-camera limit, applied before the shared cue budget. */
  cameraRateLimit?: Partial<RateLimit>;
}

export class CctvRail extends BaseRail {
  readonly id: RailId = 'cctv';
  protected readonly defaultTtlS = CCTV_DEFAULT_TTL_S;

  readonly mode: CctvMode;
  private readonly site: CueSite;
  private readonly normalcy: SiteNormalcy;
  private readonly calibrations = new Map<string, CameraCalibration>();
  private readonly detector?: PixelDetector;
  private readonly cameraLimit: Partial<RateLimit>;
  private readonly cctvListeners = new Set<(m: CctvEventMessage) => void>();

  constructor(options: CctvRailOptions) {
    super(options);
    this.site = options.site;
    this.mode = options.mode ?? 'event';
    this.normalcy = options.normalcy ?? EMPTY_NORMALCY;
    this.detector = options.detector;
    this.cameraLimit = options.cameraRateLimit ?? DEFAULT_CAMERA_RATE_LIMIT;
    for (const calibration of options.calibrations ?? []) {
      this.calibrations.set(calibration.cameraId, calibration);
    }
  }

  protected defaultRateLimit(): RateLimit {
    // `limiterKey` keys on cameraId, so this cap is the PER-CAMERA cap, not a
    // rail-wide one: one noisy camera is contained without silencing the site.
    return { ...DEFAULT_CAMERA_RATE_LIMIT, ...this.cameraLimit } as RateLimit;
  }

  protected limiterKey(cue: DecodedCue): string {
    return `cctv:${cue.cameraId ?? 'unknown'}`;
  }

  /** Contract `cctvEvent`, for the audit trail. Provenance only — never a dispatch. */
  onCctvEvent(cb: (m: CctvEventMessage) => void): Unsubscribe {
    this.cctvListeners.add(cb);
    return () => this.cctvListeners.delete(cb);
  }

  protected async onStart(): Promise<void> {
    if (this.mode !== 'pixel') return;
    if (!this.detector) {
      throw new Error('pixel mode needs a detector; none was supplied');
    }
    let problems = 0;
    for (const calibration of this.calibrations.values()) {
      for (const problem of validateCalibration(calibration, findCamera(this.site, calibration.cameraId))) {
        problems += 1;
        this.warn(`calibration warning for ${problem.cameraId}: ${problem.reason}`);
      }
    }
    if (problems > 0) {
      this.setHealth(
        'degraded',
        `cue rail cctv: ${problems} calibration problem(s); affected cameras cannot produce pixel cues`,
      );
    }
  }

  /* ---- event mode -------------------------------------------------------- */

  protected decode(payload: unknown): DecodedCue | null {
    const event = parseVmsEvent(payload);
    const camera = findCamera(this.site, event.cameraId);
    if (!camera) {
      throw new Error(`VMS event names camera ${event.cameraId}, which is not in the site model`);
    }
    const zone = findZone(camera, event.zone);
    if (!zone) {
      throw new Error(`VMS event names zone ${event.zone}, which camera ${camera.id} does not define`);
    }
    // Audit provenance goes out even for a cue the whitelist will suppress:
    // what the camera saw is a fact, whether or not it is worth flying for.
    this.emitCctvEvent(event);
    if (this.cameraIsOffline(camera.id)) {
      // BaseRail refuses it too; naming the zone here keeps the reason precise.
      throw new Error(
        `zone ${zone.name} is blind — camera ${camera.id} is offline ` +
        `(${this.offlineCameraReason(camera.id) ?? 'no reason reported'})`,
      );
    }
    const centre = polygonCentroid(zone.polygon);
    return {
      ...(event.id ? { id: `cctv-${event.id}` } : {}),
      lat: centre.lat,
      lon: centre.lon,
      type: cctvCueType(event.class),
      confidence: vmsConfidence(event),
      observedAt: event.ts,
      cameraId: camera.id,
      zone: zone.name,
      ...(event.class === undefined ? {} : { class: event.class }),
      ...(event.thumbnail === undefined ? {} : { thumbnail: event.thumbnail }),
    };
  }

  private emitCctvEvent(event: VmsEvent): void {
    const message: CctvEventMessage = {
      type: 'cctvEvent',
      ts: this.scheduler.now(),
      vehicleId: this.vehicleId,
      cameraId: event.cameraId,
      zone: event.zone,
      ...(event.class === undefined ? {} : { class: event.class }),
      ...(event.thumbnail === undefined ? {} : { thumbnail: event.thumbnail }),
    };
    for (const cb of [...this.cctvListeners]) {
      try {
        cb(message);
      } catch {
        /* a subscriber's failure is its own */
      }
    }
  }

  /* ---- pixel mode -------------------------------------------------------- */

  /**
   * Run one frame through the detector and project every box.
   * Returns the number of cues emitted. Never throws at the caller: a bad frame
   * or a bad calibration becomes a rejection plus a calibration warning.
   */
  async ingestFrame(frame: CameraFrame): Promise<number> {
    if (this.mode !== 'pixel') {
      this.warn('a frame arrived while the rail is in event mode; ignored');
      return 0;
    }
    if (!this.detector) return 0;
    const camera = findCamera(this.site, frame.cameraId);
    if (!camera) {
      this.warn(`calibration warning for ${frame.cameraId}: camera is not in the site model`);
      return 0;
    }
    if (this.cameraIsOffline(camera.id)) {
      this.warn(`frame from offline camera ${camera.id} ignored; its zones are blind`);
      return 0;
    }
    const calibration = this.calibrations.get(frame.cameraId);
    if (!calibration) {
      this.warn(`calibration warning for ${frame.cameraId}: no pixel calibration is configured`);
      return 0;
    }
    if (validateCalibration(calibration, camera).length > 0) {
      this.warn(`calibration warning for ${frame.cameraId}: calibration is invalid; no cue derived`);
      return 0;
    }

    let boxes: PixelBoxList;
    try {
      boxes = await this.detector.detect(frame);
    } catch (err) {
      this.setHealth('degraded', `cue rail cctv: detector ${this.detector.name} failed — ${(err as Error).message}`);
      return 0;
    }

    let emitted = 0;
    for (const box of boxes) {
      const result = projectPixelCue(box, camera, calibration, this.site);
      if (!result.ok) {
        if (result.calibrationWarning) {
          this.warn(`calibration warning for ${camera.id}: ${result.reason}; cue refused`);
        }
        continue;
      }
      // The zone is whichever watched area the projection actually landed in —
      // never "the first zone on the camera". A cue outside every zone keeps
      // `zone` unset, so normalcy cannot suppress it on a zone it is not in.
      const zone = camera.zones.find((z) => pointInPolygon(result.cue.point, z.polygon));
      const message = this.publish({
        lat: result.cue.point.lat,
        lon: result.cue.point.lon,
        type: cctvCueType(box.class),
        confidence: box.confidence,
        observedAt: frame.ts,
        cameraId: camera.id,
        ...(zone ? { zone: zone.name } : {}),
        class: box.class,
        meta: {
          bearing_deg: result.cue.bearingDeg,
          range_m: result.cue.rangeM,
          clamped_to_fov: result.cue.clampedToFov,
          detector: this.detector.name,
        },
      }, this.scheduler.now());
      if (message) emitted += 1;
    }
    return emitted;
  }

  /* ---- health + whitelist ------------------------------------------------ */

  protected blindZones(): BlindZone[] {
    const blind: BlindZone[] = [];
    for (const camera of this.site.cameras) {
      if (!this.cameraIsOffline(camera.id)) continue;
      const reason = this.offlineCameraReason(camera.id) ?? 'camera offline';
      for (const zone of camera.zones) {
        blind.push({ cameraId: camera.id, zone: zone.name, reason });
      }
    }
    return blind;
  }

  protected whitelistMatch(cue: DecodedCue, nowMs: number): WhitelistRule | null {
    return normalcySuppression(this.normalcy, {
      ...(cue.cameraId === undefined ? {} : { cameraId: cue.cameraId }),
      ...(cue.zone === undefined ? {} : { zone: cue.zone }),
      ...(cue.class === undefined ? {} : { class: cue.class }),
      tsMs: cue.observedAt ?? nowMs,
    });
  }

  protected whitelistRules(): WhitelistRule[] {
    return normalcyRules(this.normalcy);
  }
}

type PixelBoxList = Awaited<ReturnType<PixelDetector['detect']>>;
