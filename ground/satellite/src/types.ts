/* ============================================================================
 * eis-satellite — shared types.
 *
 * `Anomaly` is a structural copy of the FROZEN contract type in
 * ground/ui/src/contract/index.ts. TypeScript typing is structural, so values
 * built against this interface ARE contract Anomalies. The contract file is
 * never imported from src/ (it lives outside this package's rootDir and would
 * break the dist build); instead test/contract-compat.test.ts asserts mutual
 * assignability against the real contract at typecheck time, so any drift
 * fails `npm run typecheck`.
 * ========================================================================== */

/** Structural copy of contract `Anomaly` (see header). `type` is the anomaly
 *  KIND (this package always emits 'change'), not a message discriminant. */
export interface Anomaly {
  id: string;
  lat: number;
  lon: number;
  type: string;        // anomaly kind, e.g. 'change'
  confidence: number;  // 0..1
  thumbnail: string;   // repo-relative path or data URL
}

/** Geographic bounding box of a tile, degrees WGS84. */
export interface BoundsLatLon {
  north: number;
  south: number;
  east: number;
  west: number;
}

/** Shape of data/tiles.json — the georeference sidecar for before/after.png.
 *  Extra keys (e.g. `generated` provenance) are additive and ignored here. */
export interface GeoRefTiles {
  boundsLatLon: BoundsLatLon;
  widthPx: number;
  heightPx: number;
}

/** One connected change region found in the diff, in pixel space. */
export interface ChangeBlob {
  areaPx: number;
  /** Pixel-aligned bounding box (x,y = top-left pixel index, inclusive). */
  bbox: { x: number; y: number; w: number; h: number };
  /** Diff-magnitude-weighted centroid in CONTINUOUS pixel coords
   *  (pixel i spans [i, i+1), so a single-pixel blob centers at i + 0.5). */
  centroidPx: { x: number; y: number };
  meanDiff: number; // mean per-pixel diff over the blob, 0..255
  maxDiff: number;  // max per-pixel diff over the blob, 0..255
  /** Ranking score (area x contrast); higher = more prominent. */
  score: number;
}

export interface DetectOptions {
  /** Per-pixel max-channel abs difference required to mark change. Default 28. */
  threshold?: number;
  /** Minimum connected area in pixels for a blob to count. Default 10. */
  minBlobAreaPx?: number;
  /** Keep at most this many blobs (best score first). Default 16. */
  maxBlobs?: number;
  /** 4- or 8-connectivity for component labeling. Default 8. */
  connectivity?: 4 | 8;
  /** Anomaly id prefix; ids are `${idPrefix}-${rank}`. Default 'sat-change'. */
  idPrefix?: string;
  /** Embed PNG data-URL thumbnails cropped from the after tile. Default true.
   *  (Encoding uses the dependency-free stored-PNG encoder — browser-safe.) */
  thumbnails?: boolean;
}

export interface DetectResult {
  anomalies: Anomaly[];
  blobs: ChangeBlob[];
  /** Per-pixel max-channel abs diff, length w*h, 0..255. */
  diff: Uint8Array;
  /** Binary change mask, length w*h, values 0|1 (post-threshold). */
  mask: Uint8Array;
  /** RGBA overlay (length w*h*4): transparent where unchanged, red-orange with
   *  diff-proportional alpha where changed. Renderable directly by the UI. */
  overlayRgba: Uint8Array;
}
