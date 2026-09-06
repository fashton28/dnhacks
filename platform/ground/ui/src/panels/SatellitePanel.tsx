/* SatellitePanel — before/after satellite tiles with the REAL eis-satellite
   change-detection core run in the browser. The baked PNGs are decoded via
   <img> + canvas into raw RGBA (decode is deliberately outside the core), the
   diff/overlay comes from detectAnomalies(), and wire anomalies are projected
   onto the tile with the tiles.json georef. Fully offline. */
import React from 'react';
import { Panel, Badge, Tabs, Toggle } from '@/components';
import type { Anomaly } from '@/contract';
import { detectAnomalies, projectToTile, validateGeoRef } from '@satellite/index';
import type { DetectResult, GeoRefTiles } from '@satellite/index';
import { RAIL_LABEL, pinColourFor } from '@/cues';
import type { RailHealth, RailId } from '@/cues';
import tilesMeta from '@satdata/tiles.json';
import beforeUrl from '@satdata/before.png';
import afterUrl from '@satdata/after.png';

type TileView = 'before' | 'after';

interface DecodedTile {
  rgba: Uint8Array;
  width: number;
  height: number;
}

async function rgbaFromUrl(url: string): Promise<DecodedTile> {
  const img = new Image();
  img.decoding = 'async';
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`failed to load tile image: ${url}`));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { rgba: new Uint8Array(data.data.buffer), width: canvas.width, height: canvas.height };
}

export interface SatellitePanelProps {
  anomalies: Anomaly[];
  /** Per-rail health for the badge strip; omitted when no rails are wired. */
  railHealth?: RailHealth[];
}

/** Badge tone for a rail's health state. */
const RAIL_TONE: Record<string, 'nominal' | 'caution' | 'danger' | 'outline'> = {
  healthy: 'nominal',
  degraded: 'caution',
  warning: 'caution',
  failed: 'danger',
  stopped: 'outline',
  starting: 'outline',
};

export function SatellitePanel({ anomalies, railHealth = [] }: SatellitePanelProps): React.ReactElement {
  const [view, setView] = React.useState<TileView>('after');
  const [showDiff, setShowDiff] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [tiles, setTiles] = React.useState<{ before: DecodedTile; after: DecodedTile } | null>(null);
  const [detect, setDetect] = React.useState<DetectResult | null>(null);
  const baseRef = React.useRef<HTMLCanvasElement>(null);
  const overlayRef = React.useRef<HTMLCanvasElement>(null);

  const georef = React.useMemo<GeoRefTiles | null>(() => {
    try {
      return validateGeoRef(tilesMeta as GeoRefTiles);
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  }, []);

  /* decode both tiles once */
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [before, after] = await Promise.all([rgbaFromUrl(beforeUrl), rgbaFromUrl(afterUrl)]);
        if (!cancelled) setTiles({ before, after });
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /* run the real detection core when both tiles are decoded */
  React.useEffect(() => {
    if (!tiles || !georef) return;
    try {
      const result = detectAnomalies(
        tiles.before.rgba, tiles.after.rgba,
        tiles.after.width, tiles.after.height,
        georef,
        { thumbnails: false },
      );
      setDetect(result);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [tiles, georef]);

  /* paint the base tile */
  React.useEffect(() => {
    const canvas = baseRef.current;
    if (!canvas || !tiles) return;
    const tile = tiles[view];
    canvas.width = tile.width;
    canvas.height = tile.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new ImageData(new Uint8ClampedArray(tile.rgba), tile.width, tile.height);
    ctx.putImageData(img, 0, 0);
  }, [tiles, view]);

  /* paint the diff overlay */
  React.useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || !detect || !tiles) return;
    canvas.width = tiles.after.width;
    canvas.height = tiles.after.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new ImageData(new Uint8ClampedArray(detect.overlayRgba), tiles.after.width, tiles.after.height);
    ctx.putImageData(img, 0, 0);
  }, [detect, tiles]);

  /* Cue markers. A cue outside the tile's bounds extrapolates to a pixel
     coordinate off the image, which a percentage-based marker draws somewhere
     it cannot be seen with nothing to say it is off-frame (FM-109). Off-tile
     cues are CLAMPED to the nearest edge and labelled, so the operator sees
     "this cue is not on this tile" rather than an edge hit. */
  const markers = React.useMemo(() => {
    if (!georef) return [];
    return anomalies.map((a) => {
      const p = projectToTile(a.lat, a.lon, georef);
      return {
        id: a.id,
        left: (p.clampedX / georef.widthPx) * 100,
        top: (p.clampedY / georef.heightPx) * 100,
        conf: a.confidence,
        source: a.source,
        colour: pinColourFor(a.source),
        onTile: p.onTile,
      };
    });
  }, [anomalies, georef]);
  const offTile = markers.filter((m) => !m.onTile).length;

  return (
    <Panel
      title="Satellite change detection"
      variant="sunken"
      pad={false}
      status={
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {offTile > 0 && (
            <Badge tone="caution" mono>
              {offTile} OFF-TILE
            </Badge>
          )}
          {detect
            ? <Badge tone={detect.anomalies.length > 0 ? 'caution' : 'nominal'} mono>
                {detect.anomalies.length} CHANGE{detect.anomalies.length === 1 ? '' : 'S'}
              </Badge>
            : <Badge tone="outline" mono>…</Badge>}
        </div>
      }
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Tabs
            size="sm"
            value={view}
            onChange={(id) => setView(id as TileView)}
            items={[{ id: 'before', label: 'Before' }, { id: 'after', label: 'After' }]}
          />
          <Toggle size="sm" checked={showDiff} onChange={setShowDiff} label="Diff" />
        </div>
      }
      style={{ height: '100%' }}
      bodyStyle={{ position: 'relative' }}
    >
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {error ? (
          <div style={{ color: 'var(--danger-fg)', fontSize: 'var(--text-sm)', padding: 12, textAlign: 'center' }}>
            Satellite tiles unavailable: {error}
          </div>
        ) : !tiles ? (
          <div style={{ color: 'var(--text-disabled)', fontSize: 'var(--text-sm)' }}>Decoding tiles…</div>
        ) : (
          <div
            style={{
              position: 'relative',
              aspectRatio: `${tiles.after.width} / ${tiles.after.height}`,
              maxWidth: '100%',
              maxHeight: '100%',
              width: 'auto',
              height: '100%',
            }}
          >
            <canvas
              ref={baseRef}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', imageRendering: 'pixelated' }}
            />
            <canvas
              ref={overlayRef}
              style={{
                position: 'absolute', inset: 0, width: '100%', height: '100%',
                imageRendering: 'pixelated',
                opacity: showDiff ? 1 : 0,
                transition: 'opacity 150ms ease-out',
                pointerEvents: 'none',
              }}
            />
            {markers.map((m) => (
              <div
                key={m.id}
                title={
                  `${m.id} · ${RAIL_LABEL[m.source as RailId] ?? m.source} · conf ${(m.conf * 100).toFixed(0)}%` +
                  (m.onTile ? '' : ' · OFF-TILE: this cue lies outside these tile bounds')
                }
                style={{
                  position: 'absolute',
                  left: `${m.left}%`,
                  top: `${m.top}%`,
                  transform: 'translate(-50%, -50%)',
                  width: 26, height: 26,
                  border: `1.5px ${m.onTile ? 'solid' : 'dashed'} ${m.colour}`,
                  borderRadius: '50%',
                  boxShadow: m.onTile ? `0 0 10px ${m.colour}80` : 'none',
                  opacity: m.onTile ? 1 : 0.55,
                  pointerEvents: 'none',
                }}
              >
                <span
                  style={{
                    position: 'absolute', left: '50%', top: -16, transform: 'translateX(-50%)',
                    fontFamily: 'var(--font-mono)', fontSize: 9, whiteSpace: 'nowrap',
                    color: m.colour, background: 'rgba(8,12,16,0.75)',
                    padding: '1px 4px', borderRadius: 3,
                  }}
                >
                  {m.onTile ? m.id : `${m.id} · off-tile`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cue-rail badges. Every rail behind the one bus, each in its own pin
          colour so the badge and the map marker read as the same rail. */}
      {railHealth.length > 0 && (
        <div style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          display: 'flex', flexWrap: 'wrap', gap: 4,
          padding: '5px 8px',
          background: 'linear-gradient(to top, rgba(8,12,16,0.92), rgba(8,12,16,0))',
        }}>
          {railHealth.map((rail) => (
            <span
              key={rail.rail}
              title={rail.detail}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '1px 6px', borderRadius: 'var(--radius-pill)',
                border: `1px solid ${pinColourFor(rail.rail)}`,
                color: pinColourFor(rail.rail),
                fontFamily: 'var(--font-mono)', fontSize: 9,
                opacity: rail.state === 'healthy' ? 1 : 0.6,
              }}
            >
              <span style={{
                width: 5, height: 5, borderRadius: '50%',
                background: rail.state === 'healthy' ? pinColourFor(rail.rail)
                  : rail.state === 'failed' ? 'var(--danger-fg)' : 'var(--caution-fg)',
              }} />
              {RAIL_LABEL[rail.rail]}
              {rail.counts.emitted > 0 ? ` ${rail.counts.emitted}` : ''}
            </span>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* `RAIL_TONE` is exported for panels that render a rail badge with the shared
   Badge component rather than the inline pill above. */
export { RAIL_TONE };
