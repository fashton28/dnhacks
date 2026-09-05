/* eslint-disable @typescript-eslint/no-explicit-any -- MapLibre GL event/feature payloads are untyped in this panel (teammate code, kept as-is) */
/* ============================================================================
 * SiteMap — satellite operations map of the Site (MapLibre GL on Esri World Imagery).
 * ----------------------------------------------------------------------------
 * Layers from the Hub's site.geojson (geofence, no-fly zone, protected area, fence sections with open ones in red,
 * pads, gate), Fleet markers with heading, status ring, battery arc and label, per-Drone tracks, Detections as
 * polygons with confidence labels, the agent's planned route, and Scenario props. Store-driven; marker updates are
 * batched to ~6 Hz so 30 Hz telemetry never touches MapLibre directly.
 * ========================================================================== */
import React, { useEffect, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Map as MapIcon, Crosshair, Maximize2 } from 'lucide-react';
import { Panel, Badge } from '@/components';
import type { HubDroneState } from '@/dataSource/HubDataProvider';
import { useArgus, activeMission, STATUS_COLOR } from '../store';

maplibregl.setWorkerUrl(maplibreWorkerUrl);

const TRACK_POINTS = 200;
const RING: Record<HubDroneState['status'], string> = { idle: '#8b98a8', on_mission: '#3fb950', manual_control: '#f0883e', returning: '#58a6ff', offline: '#f85149' };
const R_EARTH = 6378137;
type Anchor = { lat: number; lon: number };
const enuToLonLat = (a: Anchor, x: number, y: number): [number, number] => [a.lon + (x / (R_EARTH * Math.cos(a.lat * Math.PI / 180))) * 180 / Math.PI, a.lat + (y / R_EARTH) * 180 / Math.PI];

function droneSvg(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '-20 -20 40 40');
  svg.innerHTML = `<circle class="ring" r="15" stroke="#8b98a8"/><path class="batt" d="" stroke="#3fb950"/>
    <g class="body"><path d="M0,-11 L4,-4 L9,-9 L11,-7 L6,-2 L10,2 L2,2 L0,6 L-2,2 L-10,2 L-6,-2 L-11,-7 L-9,-9 L-4,-4 Z" fill="#0d1117" stroke="#e6edf3" stroke-width="1.2" stroke-linejoin="round"/><circle cx="0" cy="-2" r="2" fill="#e6edf3"/></g>`;
  return svg;
}
function batteryArc(pct: number): string {
  const r = 18, frac = Math.max(0.02, Math.min(1, pct / 100)), a = frac * 2 * Math.PI;
  return `M0,${-r} A${r},${r} 0 ${a > Math.PI ? 1 : 0} 1 ${(r * Math.sin(a)).toFixed(2)},${(-r * Math.cos(a)).toFixed(2)}`;
}
const battColor = (pct: number) => (pct > 50 ? '#3fb950' : pct > 25 ? '#f0883e' : '#f85149');

type Entry = { marker: maplibregl.Marker; el: HTMLDivElement; label: HTMLDivElement; track: [number, number][]; state: HubDroneState };

export function SiteMap({ hubBase, onSelect, compact = false }: { hubBase: string; onSelect: (id: string) => void; compact?: boolean }): React.ReactElement {
  const holder = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const geoRef = useRef<any>(null);
  const anchorRef = useRef<Anchor | null>(null);
  const entries = useRef(new Map<string, Entry>());
  const pending = useRef(new Map<string, HubDroneState>());
  const flush = useRef<number | null>(null);
  const selectedRef = useRef<string | null>(null);
  const onSelectRef = useRef(onSelect); onSelectRef.current = onSelect;
  const [follow, setFollow] = useState(false);
  const followRef = useRef(false); followRef.current = follow;
  const [siteName, setSiteName] = useState('Site');

  const fleet = useArgus((s) => s.fleet);
  const selected = useArgus((s) => s.selected);
  const detections = useArgus((s) => s.detections);
  const agentPlan = useArgus((s) => s.agentPlan);
  const openFences = useArgus((s) => s.sceneOpenFences);
  const props = useArgus((s) => s.sceneProps);
  const mission = useArgus((s) => activeMission(s, s.selected));

  const fitSite = () => {
    const map = mapRef.current, geo = geoRef.current; if (!map || !geo) return;
    const fence = geo.features.find((f: any) => f.properties.kind === 'geofence'); if (!fence) return;
    const b = new maplibregl.LngLatBounds();
    for (const c of fence.geometry.coordinates[0]) b.extend(c as [number, number]);
    map.fitBounds(b, { padding: compact ? 14 : 22, duration: 500 });
  };

  /* ---- create the map once ---- */
  useEffect(() => {
    if (!holder.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: holder.current, center: [-98.4, 41.2], zoom: 15.6, minZoom: 10, maxZoom: 20, attributionControl: false,
      style: {
        version: 8, glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
        sources: { esri: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19, attribution: 'Esri, Maxar, Earthstar Geographics' } },
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0a0d11' } }, { id: 'esri', type: 'raster', source: 'esri', paint: { 'raster-saturation': -0.3, 'raster-brightness-max': 0.9, 'raster-contrast': 0.06 } }],
      },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 90, unit: 'metric' }), 'bottom-left');
    map.on('dragstart', () => setFollow(false));
    const empty = () => ({ type: 'FeatureCollection', features: [] } as any);
    map.on('load', () => {
      map.addSource('geofence', { type: 'geojson', data: empty() });
      map.addSource('protected', { type: 'geojson', data: empty() });
      map.addSource('nofly', { type: 'geojson', data: empty() });
      map.addSource('fences', { type: 'geojson', data: empty() });
      map.addSource('pads', { type: 'geojson', data: empty() });
      map.addSource('gate', { type: 'geojson', data: empty() });
      map.addSource('labels', { type: 'geojson', data: empty() });
      map.addSource('props', { type: 'geojson', data: empty() });
      map.addSource('tracks', { type: 'geojson', data: empty() });
      map.addSource('detections', { type: 'geojson', data: empty() });
      map.addSource('route', { type: 'geojson', data: empty() });
      map.addLayer({ id: 'protected-fill', type: 'fill', source: 'protected', paint: { 'fill-color': '#58a6ff', 'fill-opacity': 0.07 } });
      map.addLayer({ id: 'protected-line', type: 'line', source: 'protected', paint: { 'line-color': '#58a6ff', 'line-width': 1, 'line-opacity': 0.6 } });
      map.addLayer({ id: 'nofly-fill', type: 'fill', source: 'nofly', paint: { 'fill-color': '#ff4d6a', 'fill-opacity': 0.16 } });
      map.addLayer({ id: 'nofly-line', type: 'line', source: 'nofly', paint: { 'line-color': '#ff4d6a', 'line-width': 1.4 } });
      map.addLayer({ id: 'geofence-line', type: 'line', source: 'geofence', paint: { 'line-color': '#f85149', 'line-width': 1.6, 'line-dasharray': [4, 2.5] } });
      map.addLayer({ id: 'fences-line', type: 'line', source: 'fences', paint: { 'line-color': ['case', ['boolean', ['get', 'open'], false], '#ff2d55', '#f0c04a'], 'line-width': ['case', ['boolean', ['get', 'open'], false], 4, 1.3], 'line-opacity': 0.95 } });
      map.addLayer({ id: 'pads-circle', type: 'circle', source: 'pads', paint: { 'circle-radius': 4.5, 'circle-color': '#0d1117', 'circle-stroke-color': '#dfe6ee', 'circle-stroke-width': 1.4 } });
      map.addLayer({ id: 'gate-circle', type: 'circle', source: 'gate', paint: { 'circle-radius': 3.5, 'circle-color': '#f0c04a', 'circle-stroke-color': '#0d1117', 'circle-stroke-width': 1 } });
      map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['case', ['boolean', ['get', 'active'], false], '#3fb950', '#9fb0c0'], 'line-width': 2, 'line-dasharray': [2, 2] } });
      map.addLayer({ id: 'route-wp', type: 'circle', source: 'route', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 3, 'circle-color': '#0d1117', 'circle-stroke-color': '#3fb950', 'circle-stroke-width': 1.5 } });
      map.addLayer({ id: 'det-fill', type: 'fill', source: 'detections', paint: { 'fill-color': '#f0c04a', 'fill-opacity': 0.25 } });
      map.addLayer({ id: 'det-line', type: 'line', source: 'detections', paint: { 'line-color': '#ffd166', 'line-width': 1.6 } });
      map.addLayer({ id: 'det-label', type: 'symbol', source: 'detections', filter: ['==', ['geometry-type'], 'Point'], layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-offset': [0, -1.1], 'text-anchor': 'bottom', 'text-font': ['Open Sans Semibold'] }, paint: { 'text-color': '#ffe08a', 'text-halo-color': '#0b0e12', 'text-halo-width': 1.2 } });
      map.addLayer({ id: 'props-circle', type: 'circle', source: 'props', paint: { 'circle-radius': 6, 'circle-color': ['match', ['get', 'kind'], 'vehicle', '#ff2d55', 'crate', '#d29922', 'person', '#bc8cff', '#e6edf3'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.4 } });
      map.addLayer({ id: 'props-label', type: 'symbol', source: 'props', layout: { 'text-field': ['get', 'label'], 'text-size': 9.5, 'text-offset': [0, 1.2], 'text-anchor': 'top', 'text-font': ['Open Sans Semibold'] }, paint: { 'text-color': '#ffd7dd', 'text-halo-color': '#0b0e12', 'text-halo-width': 1.2 } });
      map.addLayer({ id: 'tracks-line', type: 'line', source: 'tracks', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['boolean', ['get', 'selected'], false], 3, 1.6], 'line-opacity': 0.85 } });
      map.addLayer({ id: 'zone-labels', type: 'symbol', source: 'labels', layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-letter-spacing': 0.12, 'text-transform': 'uppercase', 'text-font': ['Open Sans Semibold'], 'text-anchor': ['get', 'anchor'], 'text-offset': ['get', 'offset'] }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#0b0e12', 'text-halo-width': 1.3, 'text-opacity': 0.9 } });
      ready.current = true;
      applySite();
    });
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(holder.current);
    // Site layers from the Hub
    Promise.all([fetch(`${hubBase}/console/site.geojson`).then((r) => r.json()), fetch(`${hubBase}/console/site.json`).then((r) => r.json())])
      .then(([geo, site]) => { geoRef.current = geo; anchorRef.current = site.anchor; setSiteName(site.name ?? 'Site'); applySite(); })
      .catch(() => { /* the map still shows imagery */ });
    return () => { ro.disconnect(); map.remove(); mapRef.current = null; ready.current = false; entries.current.clear(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hubBase]);

  function byKind(kind: string) { const geo = geoRef.current; return { type: 'FeatureCollection', features: geo ? geo.features.filter((f: any) => f.properties.kind === kind) : [] } as any; }
  function src(id: string): maplibregl.GeoJSONSource | undefined { return mapRef.current?.getSource(id) as maplibregl.GeoJSONSource | undefined; }
  function applySite() {
    const map = mapRef.current, geo = geoRef.current; if (!map || !geo || !ready.current) return;
    src('geofence')?.setData(byKind('geofence')); src('protected')?.setData(byKind('protected_area')); src('nofly')?.setData(byKind('no_fly_zone'));
    src('pads')?.setData(byKind('helipad')); src('gate')?.setData(byKind('gate'));
    applyFences(openFences);
    const f = (kind: string) => geo.features.find((x: any) => x.properties.kind === kind);
    const labels: any[] = [];
    const nf = f('no_fly_zone'); if (nf) { const c = nf.geometry.coordinates[0]; labels.push({ type: 'Feature', properties: { label: 'no-fly · reactor', color: '#ff8fa3', anchor: 'center', offset: [0, 0] }, geometry: { type: 'Point', coordinates: [c.reduce((s: number, p: number[]) => s + p[0], 0) / c.length, c.reduce((s: number, p: number[]) => s + p[1], 0) / c.length] } }); }
    const pa = f('protected_area'); if (pa) labels.push({ type: 'Feature', properties: { label: 'protected area', color: '#58a6ff', anchor: 'top-left', offset: [0.3, 0.3] }, geometry: { type: 'Point', coordinates: pa.geometry.coordinates[0][3] } });
    const gf = f('geofence'); if (gf) labels.push({ type: 'Feature', properties: { label: 'geofence', color: '#f85149', anchor: 'bottom-left', offset: [0.2, -0.3] }, geometry: { type: 'Point', coordinates: gf.geometry.coordinates[0][3] } });
    const gate = f('gate'); if (gate) labels.push({ type: 'Feature', properties: { label: 'gate', color: '#f0c04a', anchor: 'top', offset: [0, 0.8] }, geometry: gate.geometry });
    src('labels')?.setData({ type: 'FeatureCollection', features: labels } as any);
    fitSite();
  }
  function applyFences(open: string[]) {
    const fences = byKind('fence_section'); const set = new Set(open);
    fences.features = fences.features.map((f: any) => ({ ...f, properties: { ...f.properties, open: set.has(f.properties.name) } }));
    src('fences')?.setData(fences);
  }

  /* ---- fleet markers, batched ---- */
  useEffect(() => {
    for (const s of Object.values(fleet)) pending.current.set(s.drone_id, s);
    if (flush.current !== null) return;
    flush.current = window.setTimeout(() => {
      flush.current = null;
      const map = mapRef.current; if (!map) return;
      const batch = [...pending.current.values()]; pending.current.clear();
      for (const s of batch) {
        let e = entries.current.get(s.drone_id);
        if (!e) {
          const el = document.createElement('div'); el.className = 'a-mapdrone'; el.appendChild(droneSvg());
          const label = document.createElement('div'); label.className = 'a-maplabel'; el.appendChild(label);
          el.addEventListener('click', (ev) => { ev.stopPropagation(); onSelectRef.current(s.drone_id); });
          const marker = new maplibregl.Marker({ element: el, anchor: 'center', rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat([s.lon, s.lat]).addTo(map);
          e = { marker, el, label, track: [], state: s }; entries.current.set(s.drone_id, e);
        }
        e.state = s; e.marker.setLngLat([s.lon, s.lat]);
        e.el.querySelector<SVGGElement>('.body')!.setAttribute('transform', `rotate(${s.heading_deg.toFixed(1)})`);
        e.el.querySelector<SVGCircleElement>('.ring')!.setAttribute('stroke', RING[s.status] ?? '#8b98a8');
        const batt = e.el.querySelector<SVGPathElement>('.batt')!; batt.setAttribute('d', batteryArc(s.battery_pct)); batt.setAttribute('stroke', battColor(s.battery_pct));
        e.el.style.opacity = s.status === 'offline' ? '0.45' : '1';
        e.el.classList.toggle('selected', s.drone_id === selectedRef.current);
        e.label.innerHTML = `${s.drone_id}<small>${s.alt.toFixed(0)} m · ${s.battery_pct.toFixed(0)}%</small>`;
        if (s.alt > 0.5) { const last = e.track[e.track.length - 1]; if (!last || Math.abs(last[0] - s.lon) > 1e-7 || Math.abs(last[1] - s.lat) > 1e-7) e.track.push([s.lon, s.lat]); if (e.track.length > TRACK_POINTS) e.track.splice(0, e.track.length - TRACK_POINTS); }
        else if (e.track.length && s.status === 'idle') e.track = [];
        if (followRef.current && s.drone_id === selectedRef.current) map.easeTo({ center: [s.lon, s.lat], duration: 300, easing: (t) => t });
      }
      if (ready.current) src('tracks')?.setData({ type: 'FeatureCollection', features: [...entries.current.values()].filter((d) => d.track.length > 1).map((d) => ({ type: 'Feature', properties: { color: STATUS_COLOR[d.state.status] ? RING[d.state.status] : '#3fb950', selected: d.state.drone_id === selectedRef.current }, geometry: { type: 'LineString', coordinates: d.track } })) } as any);
    }, 160);
  }, [fleet]);

  useEffect(() => { selectedRef.current = selected; for (const [k, e] of entries.current) e.el.classList.toggle('selected', k === selected); }, [selected]);
  useEffect(() => { if (ready.current) applyFences(openFences); }, [openFences]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const a = anchorRef.current; if (!ready.current || !a) return;
    src('props')?.setData({ type: 'FeatureCollection', features: props.map((p) => ({ type: 'Feature', properties: { id: p.id, kind: p.kind, label: p.kind === 'vehicle' ? 'vehicle' : p.kind }, geometry: { type: 'Point', coordinates: enuToLonLat(a, p.x, p.y) } })) } as any);
  }, [props]);
  useEffect(() => {
    if (!ready.current) return;
    const feats: any[] = [];
    for (const d of detections) {
      const ring = d.polygon.map((p) => [p.lon, p.lat]); if (ring.length < 3) continue;
      feats.push({ type: 'Feature', properties: { id: d.id }, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } });
      feats.push({ type: 'Feature', properties: { label: `${d.id} · ${Math.round(d.confidence * 100)}%` }, geometry: { type: 'Point', coordinates: [ring.reduce((s, c) => s + c[0], 0) / ring.length, ring.reduce((s, c) => s + c[1], 0) / ring.length] } });
    }
    src('detections')?.setData({ type: 'FeatureCollection', features: feats } as any);
  }, [detections]);
  useEffect(() => {
    if (!ready.current) return;
    const feats: any[] = [];
    const wps = agentPlan?.plan.waypoints ?? [];
    if (wps.length) {
      const active = !!mission && mission.mission_id === agentPlan?.mission_id;
      feats.push({ type: 'Feature', properties: { active }, geometry: { type: 'LineString', coordinates: wps.map((w) => [w.lon, w.lat]) } });
      wps.forEach((w, i) => feats.push({ type: 'Feature', properties: { i }, geometry: { type: 'Point', coordinates: [w.lon, w.lat] } }));
    }
    src('route')?.setData({ type: 'FeatureCollection', features: feats } as any);
  }, [agentPlan, mission]);

  return (
    <Panel title="Site map" icon={<MapIcon size={13} />} variant="sunken" pad={false} style={{ minHeight: 0 }} bodyStyle={{ position: 'relative', height: '100%', minHeight: 0 }}
      status={mission ? <Badge tone="accent" mono>MISSION</Badge> : <Badge tone="neutral" mono>{siteName.toUpperCase()}</Badge>}
      actions={(
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="a-icobtn" data-on={follow || undefined} title="Follow the selected Drone" aria-pressed={follow} onClick={() => { setFollow((f) => !f); const e = selected ? entries.current.get(selected) : null; if (e && mapRef.current) mapRef.current.easeTo({ center: [e.state.lon, e.state.lat], duration: 400 }); }}><Crosshair size={12} /></button>
          <button className="a-icobtn" title="Fit the Site" onClick={fitSite}><Maximize2 size={12} /></button>
        </div>
      )}>
      <div className="a-sitemap" style={{ position: 'absolute', inset: 0 }}>
        <div ref={holder} style={{ position: 'absolute', inset: 0 }} />
        <div className="a-mapvignette" />
      </div>
    </Panel>
  );
}
