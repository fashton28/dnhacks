/* SatellitePanel — before/after satellite tiles with the REAL eis-satellite
   change-detection core run in the browser. The baked PNGs are decoded via
   <img> + canvas into raw RGBA (decode is deliberately outside the core), the
   diff/overlay comes from detectAnomalies(), and wire anomalies are projected
   onto the tile with the tiles.json georef. Fully offline. */
import React from 'react';
import { Panel, Badge, Tabs, Toggle } from '@/components';
import type { Anomaly } from '@/contract';
import { detectAnomalies, latLonToPixel, validateGeoRef } from '@satellite/index';
import type { DetectResult, GeoRefTiles } from '@satellite/index';
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
}

export function SatellitePanel({ anomalies }: SatellitePanelProps): React.ReactElement {
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

  const markers = React.useMemo(() => {
    if (!georef) return [];
    return anomalies.map((a) => {
      const p = latLonToPixel(a.lat, a.lon, georef);
      return {
        id: a.id,
        left: (p.x / georef.widthPx) * 100,
        top: (p.y / georef.heightPx) * 100,
        conf: a.confidence,
      };
    });
  }, [anomalies, georef]);

  return (
    <Panel
      title="Satellite change detection"
      variant="sunken"
      pad={false}
      status={
        detect
          ? <Badge tone={detect.anomalies.length > 0 ? 'caution' : 'nominal'} mono>
              {detect.anomalies.length} CHANGE{detect.anomalies.length === 1 ? '' : 'S'}
            </Badge>
          : <Badge tone="outline" mono>…</Badge>
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
                title={`${m.id} · conf ${(m.conf * 100).toFixed(0)}%`}
                style={{
                  position: 'absolute',
                  left: `${m.left}%`,
                  top: `${m.top}%`,
                  transform: 'translate(-50%, -50%)',
                  width: 26, height: 26,
                  border: '1.5px solid var(--amber-bright)',
                  borderRadius: '50%',
                  boxShadow: '0 0 10px rgba(245,166,35,0.5)',
                  pointerEvents: 'none',
                }}
              >
                <span
                  style={{
                    position: 'absolute', left: '50%', top: -16, transform: 'translateX(-50%)',
                    fontFamily: 'var(--font-mono)', fontSize: 9, whiteSpace: 'nowrap',
                    color: 'var(--amber-bright)', background: 'rgba(8,12,16,0.75)',
                    padding: '1px 4px', borderRadius: 3,
                  }}
                >
                  {m.id}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
