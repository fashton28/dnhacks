/* MapPanel: the geometry that places the target reticle, zoom clamping per
 * tile provider, and the panel chrome. Leaflet touches `window`/`document` at
 * import time, so both it and react-leaflet are stubbed — the map itself is
 * not under test here, the panel's own logic is. */
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Telemetry, TrackingStatus } from '@/contract';

vi.mock('leaflet', () => ({
  default: { divIcon: (opts: unknown) => opts },
}));

vi.mock('react-leaflet', async () => {
  const R = await import('react');
  const Box = ({ children }: { children?: React.ReactNode }) => R.createElement('div', { 'data-map': '' }, children);
  const Nothing = (): null => null;
  return {
    MapContainer: Box,
    TileLayer: Nothing,
    Marker: Nothing,
    Polyline: Nothing,
    Circle: Nothing,
    useMap: () => ({ panTo() {}, setZoom() {}, getZoom: () => 18, on() {}, off() {} }),
  };
});

const {
  ASSUMED_TARGET_RANGE_M,
  DEFAULT_GEOFENCE_M,
  MAP_INITIAL_ZOOM,
  MAP_MIN_ZOOM,
  MapPanel,
  clampZoom,
  mapCoordLabel,
  offsetByBearing,
  targetPosition,
  tileBadge,
} = await import('@/panels/MapPanel');

const tel = (over: Partial<Telemetry> = {}): Telemetry =>
  ({
    position: { lat: 1.3521, lon: 103.8198, relAlt: 12, absAlt: 30 },
    heading: 90,
    ...over,
  }) as Telemetry;

describe('offsetByBearing', () => {
  it('moves north along 0° and east along 90° by about one metre per 1/111195 degree', () => {
    const [nLat, nLon] = offsetByBearing(0, 0, 0, 111.195);
    expect(nLat).toBeCloseTo(0.001, 6);
    expect(nLon).toBeCloseTo(0, 9);
    const [eLat, eLon] = offsetByBearing(0, 0, 90, 111.195);
    expect(eLat).toBeCloseTo(0, 9);
    expect(eLon).toBeCloseTo(0.001, 6);
  });

  it('stretches longitude by the cosine of latitude', () => {
    const [, lonEq] = offsetByBearing(0, 0, 90, 100);
    const [, lon60] = offsetByBearing(60, 0, 90, 100);
    expect(lon60 / lonEq).toBeCloseTo(2, 3);
  });

  it('is a no-op for zero metres', () => {
    expect(offsetByBearing(45, -122, 200, 0)).toEqual([45, -122]);
  });
});

describe('targetPosition', () => {
  const locked = (estimatedDistance: number | null): TrackingStatus =>
    ({ state: 'locked', estimatedDistance, targets: [] }) as unknown as TrackingStatus;

  it('is null without telemetry or without a lock', () => {
    expect(targetPosition(null, locked(5))).toBeNull();
    expect(targetPosition(tel(), null)).toBeNull();
    expect(targetPosition(tel(), { ...locked(5), state: 'searching' })).toBeNull();
  });

  it('projects the estimated range along the heading, or the assumed range without one', () => {
    const t = tel({ heading: 0 });
    const withRange = targetPosition(t, locked(10));
    const assumed = targetPosition(t, locked(null));
    expect(withRange).not.toBeNull();
    expect(assumed).not.toBeNull();
    expect(withRange![0]).toBeGreaterThan(t.position.lat);
    expect(withRange![1]).toBeCloseTo(t.position.lon, 9);
    expect(assumed![0] - t.position.lat).toBeCloseTo((withRange![0] - t.position.lat) * (ASSUMED_TARGET_RANGE_M / 10), 9);
  });

  it('treats a missing heading as north', () => {
    const t = tel({ heading: 0 });
    const noHeading = targetPosition({ ...t, heading: undefined as unknown as number }, locked(5));
    expect(noHeading).toEqual(targetPosition(t, locked(5)));
  });
});

describe('zoom and badges', () => {
  it('clamps zoom to the provider ceiling and the shared floor', () => {
    expect(MAP_INITIAL_ZOOM).toBe(18);
    expect(clampZoom(25, 'satellite')).toBe(19);
    expect(clampZoom(25, 'terrain')).toBe(17);
    expect(clampZoom(1, 'osm')).toBe(MAP_MIN_ZOOM);
    expect(clampZoom(17.6, 'osm')).toBe(18);
    expect(clampZoom(25, undefined)).toBe(19);
  });

  it('badges each provider', () => {
    expect(tileBadge('satellite')).toBe('SAT');
    expect(tileBadge('osm')).toBe('OSM');
    expect(tileBadge('terrain')).toBe('TER');
    expect(tileBadge(undefined)).toBe('SAT');
  });

  it('formats the coordinate readout', () => {
    expect(mapCoordLabel(null)).toBe('—');
    expect(mapCoordLabel(tel())).toBe('1.3521, 103.8198');
  });
});

describe('MapPanel rendering', () => {
  const render = (over: Partial<React.ComponentProps<typeof MapPanel>>): string =>
    renderToStaticMarkup(React.createElement(MapPanel, { tel: null, tracking: null, home: { lat: 1, lon: 2 }, trail: [], ...over }));

  it('shows the provider badge, the default geofence legend and a dash before telemetry', () => {
    const html = render({});
    expect(html).toContain('Situational map');
    expect(html).toContain('SAT');
    expect(html).not.toContain('OFFLINE');
    expect(html).toContain(`Geofence ${DEFAULT_GEOFENCE_M} m`);
    expect(html).toContain('—');
  });

  it('reflects the chosen tile source, the configured fence and the live position', () => {
    const html = render({ tileSource: 'terrain', geofenceRadius: 80, tel: tel() });
    expect(html).toContain('TER');
    expect(html).toContain('Geofence 80 m');
    expect(html).toContain('1.3521, 103.8198');
  });
});
