/* MapPanel — production react-leaflet situational map over satellite tiles.
   Renders a rotated drone marker (heading + amber cone), a home marker, a locked
   target reticle placed standoff ahead of the drone, a breadcrumb trail, and a
   dashed geofence circle. Auto-recenters on the drone. Offline-tolerant: if tiles
   fail to load it falls back to a CSS grid background with the last known position
   and markers, and shows an OFFLINE chip. Keeps the Panel chrome, SAT/zoom action
   buttons, legend, and lat/lon readout from the prototype. */
import React from 'react';
import L from 'leaflet';
import { MapContainer, TileLayer, Marker, Polyline, Circle, useMap } from 'react-leaflet';
import { Plus, Minus } from 'lucide-react';
import { Panel, IconButton, Badge } from '@/components';
import { MAP } from '@/theme/tokens';
import type { Telemetry, TrackingStatus } from '@/contract';

export type MapTileSource = 'satellite' | 'osm' | 'terrain';

interface TileDef {
  url: string;
  attribution: string;
  maxZoom: number;
}

const TILE_SOURCES: Record<MapTileSource, TileDef> = {
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles © Esri — World Imagery',
    maxZoom: 19,
  },
  osm: {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  },
  terrain: {
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: 'Map data: © OpenStreetMap contributors, SRTM | © OpenTopoMap',
    maxZoom: 17,
  },
};

const DEFAULT_ZOOM = 18;

interface MapPanelProps {
  tel: Telemetry | null;
  tracking: TrackingStatus | null;
  home: { lat: number; lon: number };
  trail: { lat: number; lon: number }[];
  geofenceRadius?: number;
  tileSource?: MapTileSource;
}

/** Drone divIcon: an inline SVG triangle rotated to the heading, with an amber
 *  heading cone behind it. */
function droneIcon(heading: number): L.DivIcon {
  const html = `
    <div style="position:relative;width:64px;height:64px;transform:translate(-50%,-50%);">
      <div style="position:absolute;left:32px;top:32px;transform:translate(-50%,-50%) rotate(${heading}deg);">
        <svg width="64" height="64" viewBox="-32 -32 64 64" style="overflow:visible;">
          <path d="M0 -46 A46 46 0 0 1 ${Math.sin(0.4) * 46} ${-Math.cos(0.4) * 46} L0 0 Z"
                fill="rgba(245,166,35,0.28)" />
          <path d="M0 -46 A46 46 0 0 0 ${-Math.sin(0.4) * 46} ${-Math.cos(0.4) * 46} L0 0 Z"
                fill="rgba(245,166,35,0.28)" />
          <path d="M0 -9 L6 7 L0 3 L-6 7 Z"
                fill="${MAP.droneFill}" stroke="${MAP.droneStroke}" stroke-width="1.5" stroke-linejoin="round" />
        </svg>
      </div>
    </div>`;
  return L.divIcon({
    html,
    className: 'eis-drone-icon',
    iconSize: [64, 64],
    iconAnchor: [32, 32],
  });
}

/** Home divIcon: a small filled dot with a dark ring. */
function homeIcon(): L.DivIcon {
  const html = `
    <div style="width:14px;height:14px;transform:translate(-50%,-50%);">
      <div style="width:8px;height:8px;margin:3px;border-radius:50%;background:${MAP.home};border:1.5px solid rgba(0,0,0,0.6);"></div>
    </div>`;
  return L.divIcon({ html, className: 'eis-home-icon', iconSize: [14, 14], iconAnchor: [7, 7] });
}

/** Target divIcon: a red reticle (circle + cross). */
function targetIcon(): L.DivIcon {
  const html = `
    <div style="width:26px;height:26px;transform:translate(-50%,-50%);">
      <svg width="26" height="26" viewBox="-13 -13 26 26">
        <circle cx="0" cy="0" r="7" fill="none" stroke="${MAP.target}" stroke-width="2" />
        <path d="M-11 0 H11 M0 -11 V11" stroke="${MAP.target}" stroke-width="2" />
      </svg>
    </div>`;
  return L.divIcon({ html, className: 'eis-target-icon', iconSize: [26, 26], iconAnchor: [13, 13] });
}

/** Move a lat/lon by `dist` metres along `headingDeg` (0 = north, clockwise). */
function projectAhead(lat: number, lon: number, headingDeg: number, dist: number): [number, number] {
  const hd = (headingDeg * Math.PI) / 180;
  const dN = Math.cos(hd) * dist;
  const dE = Math.sin(hd) * dist;
  const dLat = dN / 111320;
  const dLon = dE / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lat + dLat, lon + dLon];
}

/** Keeps the map centred on the drone (or home before any telemetry). */
function Recenter({ lat, lon }: { lat: number; lon: number }): null {
  const map = useMap();
  React.useEffect(() => {
    map.panTo([lat, lon], { animate: true, duration: 0.4 });
  }, [map, lat, lon]);
  return null;
}

/** Reports the first tile load error up to the panel so it can fall back. */
function TileErrorWatch({ url, onError }: { url: string; onError: () => void }): React.ReactElement {
  const src = Object.values(TILE_SOURCES).find((s) => s.url === url) ?? TILE_SOURCES.satellite;
  return (
    <TileLayer
      url={url}
      attribution={src.attribution}
      maxZoom={src.maxZoom}
      eventHandlers={{ tileerror: onError }}
    />
  );
}

export function MapPanel({
  tel,
  tracking,
  home,
  trail,
  geofenceRadius,
  tileSource = 'satellite',
}: MapPanelProps): React.ReactElement {
  const [zoom, setZoom] = React.useState(DEFAULT_ZOOM);
  const [offline, setOffline] = React.useState(false);
  const mapRef = React.useRef<L.Map | null>(null);

  const tile = TILE_SOURCES[tileSource] ?? TILE_SOURCES.satellite;
  const fenceRadius = geofenceRadius ?? 60;

  const dronePos: [number, number] | null = tel ? [tel.position.lat, tel.position.lon] : null;
  const center: [number, number] = dronePos ?? [home.lat, home.lon];

  const trailLatLng = React.useMemo<[number, number][]>(
    () => trail.map((p) => [p.lat, p.lon]),
    [trail],
  );

  const targetPos = React.useMemo<[number, number] | null>(() => {
    if (!tel || !tracking || tracking.state !== 'locked') return null;
    const dist = tracking.estimatedDistance ?? 5;
    return projectAhead(tel.position.lat, tel.position.lon, tel.heading || 0, dist);
  }, [tel, tracking]);

  const zoomIn = (): void => {
    setZoom((z) => {
      const nz = Math.min(tile.maxZoom, z + 1);
      mapRef.current?.setZoom(nz);
      return nz;
    });
  };
  const zoomOut = (): void => {
    setZoom((z) => {
      const nz = Math.max(3, z - 1);
      mapRef.current?.setZoom(nz);
      return nz;
    });
  };

  return (
    <Panel
      title="Situational map"
      variant="sunken"
      pad={false}
      actions={
        <>
          {offline ? (
            <Badge tone="danger" mono>
              OFFLINE
            </Badge>
          ) : (
            <Badge tone="outline" mono>
              {tileSource === 'satellite' ? 'SAT' : tileSource === 'terrain' ? 'TER' : 'OSM'}
            </Badge>
          )}
          <IconButton size="sm" icon={<Plus size={15} />} title="Zoom in" onClick={zoomIn} />
          <IconButton size="sm" icon={<Minus size={15} />} title="Zoom out" onClick={zoomOut} />
        </>
      }
      style={{ height: '100%' }}
      bodyStyle={{ position: 'relative' }}
    >
      <div style={{ position: 'absolute', inset: 0 }}>
        {/* offline CSS-grid fallback background */}
        {offline && (
          <div
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
          ref={mapRef}
          center={center}
          zoom={zoom}
          zoomControl={false}
          attributionControl
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', background: 'transparent' }}
        >
          {!offline && <TileErrorWatch url={tile.url} onError={() => setOffline(true)} />}

          <Recenter lat={center[0]} lon={center[1]} />

          {/* geofence circle (centred on home) */}
          <Circle
            center={[home.lat, home.lon]}
            radius={fenceRadius}
            pathOptions={{
              color: 'rgba(47,129,247,0.55)',
              weight: 1.5,
              dashArray: '6 5',
              fillColor: 'rgba(47,129,247,1)',
              fillOpacity: 0.05,
            }}
          />

          {/* breadcrumb trail */}
          {trailLatLng.length > 1 && (
            <Polyline positions={trailLatLng} pathOptions={{ color: 'rgba(90,160,255,0.7)', weight: 2 }} />
          )}

          {/* home marker */}
          <Marker position={[home.lat, home.lon]} icon={homeIcon()} />

          {/* drone marker */}
          {dronePos && <Marker position={dronePos} icon={droneIcon(tel?.heading ?? 0)} />}

          {/* locked target reticle */}
          {targetPos && <Marker position={targetPos} icon={targetIcon()} />}
        </MapContainer>

        {/* offline chip */}
        {offline && (
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: 10,
              transform: 'translateX(-50%)',
              padding: '4px 9px',
              background: 'rgba(8,12,16,0.8)',
              backdropFilter: 'blur(6px)',
              border: '1px solid var(--amber-line)',
              borderRadius: 'var(--radius-pill)',
              fontFamily: 'var(--font-sans)',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.05em',
              color: 'var(--amber-bright)',
              zIndex: 500,
            }}
          >
            OFFLINE — last position
          </div>
        )}

        {/* legend */}
        <div
          style={{
            position: 'absolute',
            left: 10,
            bottom: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: '7px 9px',
            background: 'rgba(8,12,16,0.72)',
            backdropFilter: 'blur(6px)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-sm)',
            zIndex: 500,
          }}
        >
          <Leg color={MAP.droneFill} label="Drone" />
          <Leg color={MAP.home} label="Home" />
          <Leg color={MAP.target} label="Target" />
          <Leg color="rgba(47,129,247,0.8)" label={`Geofence ${fenceRadius} m`} dash />
        </div>

        {/* lat/lon readout */}
        <div
          style={{
            position: 'absolute',
            right: 10,
            top: 10,
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-tertiary)',
            background: 'rgba(8,12,16,0.6)',
            padding: '3px 6px',
            borderRadius: 3,
            zIndex: 500,
          }}
        >
          {tel ? `${tel.position.lat.toFixed(4)}, ${tel.position.lon.toFixed(4)}` : '—'}
        </div>
      </div>
    </Panel>
  );
}

interface LegProps {
  color: string;
  label: string;
  dash?: boolean;
}

function Leg({ color, label, dash }: LegProps): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <span
        style={{
          width: 12,
          height: dash ? 0 : 8,
          borderRadius: dash ? 0 : '50%',
          background: dash ? 'transparent' : color,
          borderTop: dash ? `2px dashed ${color}` : 'none',
          flex: 'none',
        }}
      />
      <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{label}</span>
    </div>
  );
}
