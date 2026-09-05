/* ============================================================================
 * eis-satellite — browser-safe entry point.
 *
 * Everything exported here runs in Node AND the browser: pure detection core,
 * georef math, and the dependency-free PNG encoder (for thumbnail data URLs).
 * Node-only helpers (PNG decode, baked-mode file loading, EIS_SAT_MODE) live
 * in './node' (import 'eis-satellite/node' / ../dist/node/index.js).
 * ========================================================================== */

export type {
  Anomaly,
  BoundsLatLon,
  GeoRefTiles,
  ChangeBlob,
  DetectOptions,
  DetectResult,
} from './types.js';

export {
  latLonToPixel,
  pixelToLatLon,
  metersPerPixel,
  distanceMeters,
  validateGeoRef,
} from './georef.js';

export {
  DETECT_DEFAULTS,
  computeDiff,
  thresholdMask,
  diffOverlayRgba,
  findBlobs,
  blobConfidence,
  cropRgba,
  detectAnomalies,
} from './detect.js';
export * from './sar.js';

export {
  crc32,
  base64Encode,
  encodePngStored,
  rgbaToPngDataUrl,
  rgbaToScanlines,
} from './png.js';
