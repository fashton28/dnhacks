import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectSarChanges, SarChip, SarDetection } from '../sar.js';

export function loadBakedSar(dataDir: string): SarDetection {
  const before = JSON.parse(readFileSync(join(dataDir, 'sar-before.json'), 'utf8')) as SarChip;
  const after = JSON.parse(readFileSync(join(dataDir, 'sar-after.json'), 'utf8')) as SarChip;
  const meta = JSON.parse(readFileSync(join(dataDir, 'provenance.json'), 'utf8')) as {
    kind: 'synthetic' | 'real'; claim: string; bounds: { north:number;south:number;west:number;east:number };
  };
  return detectSarChanges(before, after, { widthPx: before.width, heightPx: before.height, boundsLatLon: meta.bounds },
    { kind: meta.kind, claim: meta.claim });
}
