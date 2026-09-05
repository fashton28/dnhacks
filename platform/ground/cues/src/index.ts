/* ============================================================================
 * eis-cues — browser-safe entry point.
 *
 * Everything exported here runs in Node AND the browser: no fs, no child
 * processes, no Electron, no DOM. Node-only helpers (fixture/site/calibration
 * file loading, the ground/satellite bridge, the ffmpeg RTSP frame source) live
 * in './node'.
 *
 * The UI consumes this package through `CueBus`, which multiplexes every rail
 * into the contract's EXISTING `anomaly` channel. No cue rail adds a wire
 * message, a command, or a plan.
 * ========================================================================== */

export type {
  Anomaly, AnomalyMessage, AnomalySource, CctvEventMessage,
  HealthComponent, HealthEventMessage, Unsubscribe,
} from './contract.js';
export { DEFAULT_VEHICLE_ID } from './contract.js';

export type {
  BlindZone, CueAdapter, DecodedCue, RailHealth, RailHealthState, RailId,
  RateLimit, SuppressionRecord, WhitelistKind, WhitelistRule, WhitelistView,
} from './types.js';
export { RAIL_HEALTH_COMPONENT, RAIL_IDS, railIsNominal } from './types.js';

export type { LatLon, LatLonPair } from './geo.js';
export {
  clampIntoPolygon, destination, distanceToPolygonBoundaryMeters, haversineMeters,
  nearestPointOnPolygonBoundary, normalizeBearing, pointInPolygon, polygonCentroid,
} from './geo.js';

export type { CameraZone, CueSite, SiteCamera } from './site.js';
export { findCamera, findZone, parseCueSite } from './site.js';

export type {
  ActiveGate, DeliveryWindow, NormalcyQuery, NormalcyWindow, SiteNormalcy, Weekday, ZoneRef,
} from './normalcy.js';
export {
  EMPTY_NORMALCY, normalcyRules, normalcySuppression, parseNormalcy, siteLocal, windowContains,
} from './normalcy.js';

export type { CueFixture, FixtureEvent, FixtureTimebase } from './fixture.js';
export { REBASED_TS_FIELDS, isCueEvent, parseCueFixture, rebasePayload } from './fixture.js';

export { BoundedIdSet, DEFAULT_ID_MEMORY } from './dedupe.js';

export type { Scheduler } from './scheduler.js';
export { ManualScheduler, RealScheduler } from './scheduler.js';

export {
  CUE_BUDGET_CEILING, DEFAULT_CAMERA_RATE_LIMIT, DEFAULT_RAIL_RATE_LIMIT,
  SlidingWindowLimiter, resolveCueBudget, resolveRailRateLimit,
} from './rateLimit.js';

export { BaseRail, type RailOptions } from './base.js';

export type { CueBudgetState, CueBusOptions, CueRejection } from './bus.js';
export { CueBus } from './bus.js';

/* ---- rails ---------------------------------------------------------------- */

export type { SatelliteAnomaly, SatelliteCueSource, SatelliteRailOptions } from './adapters/satellite.js';
export {
  SAR_DEFAULT_TTL_S, SENTINEL2_DEFAULT_TTL_S, SarRail, Sentinel2Rail, parseSatelliteAnomaly,
} from './adapters/satellite.js';

export type { SdrRecord } from './adapters/sdr.js';
export { SDR_DEFAULT_TTL_S, SdrRail, parseSdrNdjson } from './adapters/sdr.js';

export type { BlueForceFingerprint, RfDroneRailOptions, RfDroneRecord } from './adapters/rf_drone.js';
export {
  DEFAULT_BLUE_FORCE_FRESHNESS_MS, DEFAULT_BLUE_FORCE_RADIUS_M, RF_DRONE_DEFAULT_TTL_S,
  RfDroneRail, parseRfDroneRecord,
} from './adapters/rf_drone.js';

export type { CctvMode, CctvRailOptions } from './adapters/cctv.js';
export { CCTV_DEFAULT_TTL_S, CctvRail } from './adapters/cctv.js';

export type { OnvifNotification, VmsEvent } from './cctv/vms.js';
export {
  CLASS_CONFIDENCE, UNCLASSED_CONFIDENCE, cctvCueType, mapOnvifNotification,
  parseVmsEvent, vmsConfidence,
} from './cctv/vms.js';

export type {
  CalibrationProblem, CameraCalibration, CameraFrame, PixelBox, PixelCue,
  PixelDetector, PixelProjection, PixelProjectionResult,
} from './cctv/pixel.js';
export {
  ScriptedPixelDetector, parseCalibrations, projectBox, projectPixelCue, validateCalibration,
} from './cctv/pixel.js';

export type { FenceSensorRailOptions, FenceSensorRecord } from './adapters/fence_sensor.js';
export {
  FENCE_SENSOR_DEFAULT_TTL_S, FenceSensorRail, parseFenceSensorRecord,
} from './adapters/fence_sensor.js';

export type { DroneSurveyRecord } from './adapters/drone_survey.js';
export {
  DRONE_SURVEY_DEFAULT_TTL_S, DroneSurveyRail, parseDroneSurveyRecord,
} from './adapters/drone_survey.js';
