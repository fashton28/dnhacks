/* ============================================================================
 * eis-satellite — Node-only entry point (e2e CLI, generator, tests).
 * Re-exports the browser-safe core plus Node PNG codec + baked/live modes.
 * ========================================================================== */

export * from '../index.js';

export { encodePng, decodePng, type DecodedPng } from './png.js';

export {
  type SatMode,
  type GetAnomaliesOptions,
  resolveSatMode,
  defaultDataDir,
  loadTilesMeta,
  loadTileRgba,
  computeBakedResult,
  loadBakedAnomalies,
  detectFromPngBytes,
  getAnomalies,
  clearBakedCache,
} from './baked.js';
