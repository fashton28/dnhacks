import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectSarChanges, SarChip, SarDetectOptions, SarDetection } from '../sar.js';

/**
 * Thumbnail candidates, in order. A SAR anomaly's `thumbnail` is rendered into
 * the incident report as evidence for a human reviewer to open, so it may only
 * ever name an IMAGE that exists — never the JSON intensity chip the detection
 * was computed from, and never a path that is not there (FM-125). When the
 * baked dataset ships no image, the cue carries no thumbnail and the report
 * writer says so in plain words.
 */
const THUMBNAIL_CANDIDATES = ['sar-after.png', 'sar-after.jpg', 'sar-after.webp'];

/** Provenance sidecar shape; `thumbnail` is optional and must name an image. */
interface SarProvenanceFile {
  kind: 'synthetic' | 'real';
  claim: string;
  bounds: { north: number; south: number; west: number; east: number };
  thumbnail?: string;
}

export function loadBakedSar(dataDir: string, options: SarDetectOptions = {}): SarDetection {
  const before = JSON.parse(readFileSync(join(dataDir, 'sar-before.json'), 'utf8')) as SarChip;
  const after = JSON.parse(readFileSync(join(dataDir, 'sar-after.json'), 'utf8')) as SarChip;
  const meta = JSON.parse(readFileSync(join(dataDir, 'provenance.json'), 'utf8')) as SarProvenanceFile;
  const declared = meta.thumbnail && existsSync(join(dataDir, meta.thumbnail)) ? meta.thumbnail : undefined;
  const found = declared ?? THUMBNAIL_CANDIDATES.find((name) => existsSync(join(dataDir, name)));
  // The reference is resolved against `dataDir`, so it travels with the
  // dataset instead of hardcoding one repository layout.
  const thumbnail = options.thumbnail ?? (found === undefined ? undefined : join(dataDir, found));
  return detectSarChanges(
    before, after,
    { widthPx: before.width, heightPx: before.height, boundsLatLon: meta.bounds },
    { kind: meta.kind, claim: meta.claim },
    { ...options, ...(thumbnail === undefined ? {} : { thumbnail }) },
  );
}
