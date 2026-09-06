/* MapPanel — react-leaflet situational map.
 *
 * Draws the drone (heading-rotated, with an amber view cone), the home point,
 * the locked target projected `estimatedDistance` ahead along the heading, the
 * breadcrumb trail and a dashed geofence around home; follows the drone (or
 * home before the first telemetry frame). If the tile server cannot be
 * reached the tile layer is dropped for a CSS grid and an OFFLINE chip, while
 * every marker stays where it was. Panel chrome: source badge, zoom buttons,
 * legend and a lat/lon readout.
 */
import React from 'react';
import L from 'leaflet';
import { MapContainer, TileLayer, Marker, Polyline, Circle, useMap } from 'react-leaflet';
import { Plus, Minus } from 'lucide-react';
import { Panel, IconButton, Badge } from '@/components';
import { MAP } from '@/theme/tokens';
import type { Telemetry, TrackingStatus } from '@/contract';

export type MapTileSource = 'satellite' | 'osm' | 'terrain';

interface MapPanelProps {
  tel: Telemetry | null;
  tracking: TrackingStatus | null;
  home: { lat: number; lon: number };
  trail: { lat: number; lon: number }[];
  geofenceRadius?: number;
  tileSource?: MapTileSource;
}

/* ------------------------------------------------------------------ */
/*  Tile providers and zoom                                             */
/* ------------------------------------------------------------------ */

interface TileProvider {
  url: string;
  attribution: string;
  maxZoom: number;
  badge: string;
}

const TILE_PROVIDERS: Readonly<Record<MapTileSource, TileProvider>> = {
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri — World Imagery',
    maxZoom: 19,
    badge: 'SAT',
  },
  osm: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
    badge: 'OSM',
  },
  terrain: {
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: 'Map data: © OpenStreetMap contributors, SRTM | © OpenTopoMap',
    maxZoom: 17,
    badge: 'TER',
  },
};

export const MAP_MIN_ZOOM = 3;
export const MAP_INITIAL_ZOOM = 18;
export const DEFAULT_GEOFENCE_M = 60;
/** Where a locked target is drawn while the tracker has no range estimate yet. */
export const ASSUMED_TARGET_RANGE_M = 5;

function provider(src: MapTileSource | undefined): TileProvider {
  return TILE_PROVIDERS[src ?? 'satellite'] ?? TILE_PROVIDERS.satellite;
}

export function tileBadge(src: MapTileSource | undefined): string {
  return provider(src).badge;
}

/** Keep a zoom level inside [MAP_MIN_ZOOM, the provider's maxZoom]. */
export function clampZoom(zoom: number, src: MapTileSource | undefined): number {
  return Math.min(provider(src).maxZoom, Math.max(MAP_MIN_ZOOM, Math.round(zoom)));
}

/* ------------------------------------------------------------------ */
/*  Geometry                                                            */
/* ------------------------------------------------------------------ */

const EARTH_RADIUS_M = 6371008.8;
const DEG = Math.PI / 180;

/** Displace a WGS-84 point by `metres` along `bearingDeg` (0 = north,
 *  clockwise) on the local tangent plane — plenty for standoff-scale offsets. */
export function offsetByBearing(lat: number, lon: number, bearingDeg: number, metres: number): [number, number] {
  const b = bearingDeg * DEG;
  const dLat = (metres * Math.cos(b)) / EARTH_RADIUS_M;
  const dLon = (metres * Math.sin(b)) / (EARTH_RADIUS_M * Math.cos(lat * DEG));
  return [lat + dLat / DEG, lon + dLon / DEG];
}

/** Map position of the locked target, or null when nothing is locked. */
export function targetPosition(tel: Telemetry | null, tracking: TrackingStatus | null): [number, number] | null {
  if (!tel || tracking?.state !== 'locked') return null;
  const range = tracking.estimatedDistance ?? ASSUMED_TARGET_RANGE_M;
  return offsetByBearing(tel.position.lat, tel.position.lon, tel.heading || 0, range);
}

/** Corner readout: four decimals, or an em dash before the first frame. */
export function mapCoordLabel(tel: Telemetry | null): string {
  return tel ? `${tel.position.lat.toFixed(4)}, ${tel.position.lon.toFixed(4)}` : '—';
}

/* ------------------------------------------------------------------ */
/*  Marker icons                                                        */
/* ------------------------------------------------------------------ */

const CONE_HALF_ANGLE = 0.4; // radians either side of the heading

function polar(r: number, angle: number): string {
  return `${(Math.sin(angle) * r).toFixed(2)} ${(-Math.cos(angle) * r).toFixed(2)}`;
}

/** Heading cone + chevron. The SVG itself is rotated, and the icon is anchored
 *  at its centre, so the glyph sits exactly on the position. */
function buildDroneIcon(headingDeg: number): L.DivIcon {
  const r = 46;
  const wedge = `M0 0 L${polar(r, -CONE_HALF_ANGLE)} A${r} ${r} 0 0 1 ${polar(r, CONE_HALF_ANGLE)} Z`;
  const html =
    '<div style="position:relative;width:64px;height:64px">' +
    `<svg width="64" height="64" viewBox="-32 -32 64 64" style="position:absolute;left:0;top:0;overflow:visible;transform:rotate(${headingDeg}deg);transform-origin:center">` +
    `<path d="${wedge}" fill="rgba(245,166,35,0.28)"/>` +
    `<path d="M0 -9 L6 7 L0 3 L-6 7 Z" fill="${MAP.droneFill}" stroke="${MAP.droneStroke}" stroke-width="1.5" stroke-linejoin="round"/>` +
    '</svg></div>';
  return L.divIcon({ html, className: 'eis-drone-icon', iconSize: [64, 64], iconAnchor: [32, 32] });
}

function buildHomeIcon(): L.DivIcon {
  const html =
    '<svg width="14" height="14" viewBox="0 0 14 14">' +
    `<circle cx="7" cy="7" r="4" fill="${MAP.home}" stroke="rgba(0,0,0,0.6)" stroke-width="1.5"/>` +
    '</svg>';
  return L.divIcon({ html, className: 'eis-home-icon', iconSize: [14, 14], iconAnchor: [7, 7] });
}

function buildTargetIcon(): L.DivIcon {
  const html =
    '<svg width="26" height="26" viewBox="-13 -13 26 26">' +
    `<circle r="7" fill="none" stroke="${MAP.target}" stroke-width="2"/>` +
    `<path d="M-11 0 H11 M0 -11 V11" stroke="${MAP.target}" stroke-width="2"/>` +
    '</svg>';
  return L.divIcon({ html, className: 'eis-target-icon', iconSize: [26, 26], iconAnchor: [13, 13] });
}

/* ------------------------------------------------------------------ */
/*  Map-side controller                                                 */
/* ------------------------------------------------------------------ */

/** Lives inside the MapContainer: follows the focus point, pushes the panel's
 *  zoom into the map, and mirrors wheel/pinch zooms back out so the buttons
 *  and the map never disagree. */
function MapController({
  lat,
  lon,
  zoom,
  onZoomChange,
}: {
  lat: number;
  lon: number;
  zoom: number;
  onZoomChange: (z: number) => void;
}): null {
  const map = useMap();

  React.useEffect(() => {
    map.panTo([lat, lon], { animate: true, duration: 0.4 });
  }, [map, lat, lon]);

  React.useEffect(() => {
    if (map.getZoom() !== zoom) map.setZoom(zoom);
  }, [map, zoom]);

  React.useEffect(() => {
    const sync = (): void => onZoomChange(map.getZoom());
    map.on('zoomend', sync);
    return () => {
      map.off('zoomend', sync);
    };
  }, [map, onZoomChange]);

  return null;
}

/* ------------------------------------------------------------------ */
/*  Chrome                                                              */
/* ------------------------------------------------------------------ */

const GLASS: React.CSSProperties = {
  position: 'absolute',
  background: 'rgba(8,12,16,0.72)',
  backdropFilter: 'blur(6px)',
  zIndex: 500,
};

function Legend({ fence }: { fence: number }) {
  const rows: { color: string; label: string; dashed?: boolean }[] = [
    { color: MAP.droneFill, label: 'Drone' },
    { color: MAP.home, label: 'Home' },
    { color: MAP.target, label: 'Target' },
    { color: 'rgba(47,129,247,0.8)', label: `Geofence ${fence} m`, dashed: true },
  ];
  return (
    <dl
      style={{
        ...GLASS,
        left: 10,
        bottom: 10,
        margin: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '7px 9px',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-sm)',
      }}
    >
      {rows.map((row) => (
        <div key={row.label} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <dt
            aria-hidden
            style={{
              width: 12,
              height: row.dashed ? 0 : 8,
              flex: 'none',
              borderRadius: row.dashed ? 0 : '50%',
              background: row.dashed ? 'transparent' : row.color,
              borderTop: row.dashed ? `2px dashed ${row.color}` : 'none',
            }}
          />
          <dd style={{ margin: 0, fontSize: 10, color: 'var(--text-secondary)' }}>{row.label}</dd>
        </div>
      ))}
    </dl>
  );
}

function OfflineChip() {
  return (
    <div
      style={{
        ...GLASS,
        left: '50%',
        top: 10,
        transform: 'translateX(-50%)',
        padding: '4px 9px',
        background: 'rgba(8,12,16,0.8)',
        border: '1px solid var(--amber-line)',
        borderRadius: 'var(--radius-pill)',
        fontFamily: 'var(--font-sans)',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.05em',
        color: 'var(--amber-bright)',
      }}
    >
      OFFLINE — last position
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Panel                                                               */
/* ------------------------------------------------------------------ */

export function MapPanel({
  tel,
  tracking,
  home,
  trail,
  geofenceRadius,
  tileSource = 'satellite',
}: MapPanelProps): React.ReactElement {
  const [zoom, setZoom] = React.useState(MAP_INITIAL_ZOOM);
  const [offline, setOffline] = React.useState(false);

  const tiles = provider(tileSource);
  const fence = geofenceRadius ?? DEFAULT_GEOFENCE_M;
  const focus: [number, number] = tel ? [tel.position.lat, tel.position.lon] : [home.lat, home.lon];
  const headingDeg = Math.round(tel?.heading ?? 0);

  const droneIcon = React.useMemo(() => buildDroneIcon(headingDeg), [headingDeg]);
  const homeIcon = React.useMemo(buildHomeIcon, []);
  const targetIcon = React.useMemo(buildTargetIcon, []);
  const crumbs = React.useMemo<[number, number][]>(() => trail.map((p) => [p.lat, p.lon]), [trail]);
  const target = React.useMemo(() => targetPosition(tel, tracking), [tel, tracking]);

  const stepZoom = (delta: number): void => setZoom((z) => clampZoom(z + delta, tileSource));
  const markOffline = React.useCallback(() => setOffline(true), []);

  return (
    <Panel
      title="Situational map"
      variant="sunken"
      pad={false}
      actions={
        <>
          <Badge tone={offline ? 'danger' : 'outline'} mono>
            {offline ? 'OFFLINE' : tiles.badge}
          </Badge>
          <IconButton size="sm" icon={<Plus size={15} />} title="Zoom in" onClick={() => stepZoom(1)} />
          <IconButton size="sm" icon={<Minus size={15} />} title="Zoom out" onClick={() => stepZoom(-1)} />
        </>
      }
      style={{ height: '100%' }}
      bodyStyle={{ position: 'relative' }}
    >
      <div style={{ position: 'absolute', inset: 0 }}>
        {offline && (
          <div
            aria-hidden
            style={{
              position: 'absolute',
              inset: 0,
              background: MAP.base,
              backgroundImage:
                'linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)',
              backgroundSize: '48px 48px',
            }}
          />
        )}

        <MapContainer
          center={focus}
          zoom={zoom}
          zoomControl={false}
          attributionControl
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', background: 'transparent' }}
        >
          {!offline && (
            <TileLayer
              url={tiles.url}
              attribution={tiles.attribution}
              maxZoom={tiles.maxZoom}
              eventHandlers={{ tileerror: markOffline }}
            />
          )}
          <MapController lat={focus[0]} lon={focus[1]} zoom={zoom} onZoomChange={setZoom} />

          <Circle
            center={[home.lat, home.lon]}
            radius={fence}
            pathOptions={{ color: 'rgba(47,129,247,0.55)', weight: 1.5, dashArray: '6 5', fillColor: 'rgba(47,129,247,1)', fillOpacity: 0.05 }}
          />
          {crumbs.length > 1 && <Polyline positions={crumbs} pathOptions={{ color: 'rgba(90,160,255,0.7)', weight: 2 }} />}
          <Marker position={[home.lat, home.lon]} icon={homeIcon} />
          {tel && <Marker position={focus} icon={droneIcon} />}
          {target && <Marker position={target} icon={targetIcon} />}
        </MapContainer>

        {offline && <OfflineChip />}
        <Legend fence={fence} />

        <div
          style={{
            ...GLASS,
            right: 10,
            top: 10,
            background: 'rgba(8,12,16,0.6)',
            padding: '3px 6px',
            borderRadius: 3,
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-tertiary)',
          }}
        >
          {mapCoordLabel(tel)}
        </div>
      </div>
    </Panel>
  );
}
