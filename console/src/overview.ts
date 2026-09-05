// Overview: the satellite operations map of the Site. Fleet markers with heading, status and battery, recent tracks,
// the Site GeoJSON layers (geofence, fences, no-fly zone, protected area, pads, gate), Scenario props and open fence
// sections, click-to-select. Owned by the Overview workstream; the shell mounts it with createOverview().
import * as maplibregl from "maplibre-gl";
import type { MapLayerMouseEvent } from "maplibre-gl";
// Vite (dev and build) cannot resolve MapLibre's worker by its own URL heuristics: hand it the bundled worker explicitly.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
maplibregl.setWorkerUrl(maplibreWorkerUrl);
import "maplibre-gl/dist/maplibre-gl.css";
import type { DroneState, SceneState } from "./hub";
import { enuToLatlon } from "./geo";

export type OverviewOptions = { site: any; siteGeo: any; onSelect: (droneId: string) => void };
export type Overview = {
  updateDrone(s: DroneState): void;
  setSelected(id: string | null): void;
  setScene(state: SceneState): void;
  resize(): void;
};

const TRACK_POINTS = 240;           // ~24 s of 10 Hz telemetry per Drone
const STATUS_COLOR: Record<string, string> = {
  idle: "#8b98a8", on_mission: "#3fb950", manual_control: "#f0883e", returning: "#58a6ff", offline: "#f85149",
};

const CSS = `
.argus-overview { position: relative; width: 100%; height: 100%; min-height: 200px; background: #0b0e12; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; overflow: hidden; }
.argus-overview .maplibregl-map { width: 100%; height: 100%; }
.argus-overview .argus-vignette { position: absolute; inset: 0; pointer-events: none; box-shadow: inset 0 0 120px 30px rgba(5, 8, 12, 0.55); }
.argus-overview .argus-toolbar { position: absolute; top: 10px; right: 10px; display: flex; gap: 6px; z-index: 2; }
.argus-overview .argus-btn { background: rgba(12, 17, 24, 0.85); color: #dfe6ee; border: 1px solid #2a3440; border-radius: 6px; padding: 5px 10px; font-size: 11px; letter-spacing: 0.04em; cursor: pointer; backdrop-filter: blur(6px); }
.argus-overview .argus-btn:hover { border-color: #3fb950; }
.argus-overview .argus-btn.on { color: #3fb950; border-color: #3fb950; }
.argus-overview .argus-legend { position: absolute; left: 10px; bottom: 28px; z-index: 2; background: rgba(12, 17, 24, 0.82); border: 1px solid #2a3440; border-radius: 6px; padding: 5px 9px; font-size: 11px; color: #b8c2cc; line-height: 1.55; backdrop-filter: blur(6px); cursor: default; }
.argus-overview .argus-legend .argus-legend-title { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: #8b98a8; }
.argus-overview .argus-legend .argus-legend-body { display: none; margin-top: 4px; }
.argus-overview .argus-legend:hover .argus-legend-body { display: block; }
.argus-overview .argus-legend .sw { display: inline-block; width: 14px; height: 0; border-top: 2px solid; margin-right: 6px; vertical-align: middle; }
.argus-overview .argus-legend .sw.dash { border-top-style: dashed; }
.argus-overview .argus-title { position: absolute; left: 10px; top: 10px; z-index: 2; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #8b98a8; background: rgba(12, 17, 24, 0.75); padding: 4px 8px; border-radius: 4px; border: 1px solid #2a3440; }
.argus-overview .argus-title b { color: #dfe6ee; letter-spacing: 0.04em; text-transform: none; margin-left: 6px; font-weight: 600; }
.argus-overview .argus-drone { width: 34px; height: 34px; cursor: pointer; transform-origin: center; filter: drop-shadow(0 1px 3px rgba(0,0,0,0.7)); transition: filter 120ms; }
.argus-overview .argus-drone:hover { filter: drop-shadow(0 0 6px rgba(255,255,255,0.8)); }
.argus-overview .argus-drone svg { width: 100%; height: 100%; overflow: visible; }
.argus-overview .argus-drone .ring { fill: none; stroke-width: 1.5; opacity: 0.9; }
.argus-overview .argus-drone.selected .ring { stroke-width: 2.5; stroke: #ffffff; }
.argus-overview .argus-drone .batt { fill: none; stroke-width: 3; stroke-linecap: round; }
.argus-overview .argus-label { position: absolute; left: 50%; top: 100%; transform: translate(-50%, 2px); white-space: nowrap; font-size: 10px; font-weight: 600; color: #e6edf3; background: rgba(8, 11, 16, 0.78); padding: 1px 5px; border-radius: 3px; border: 1px solid rgba(255,255,255,0.12); pointer-events: none; letter-spacing: 0.02em; }
.argus-overview .argus-label small { color: #9fb0c0; font-weight: 500; margin-left: 4px; }
.argus-overview.compact .argus-drone:not(.selected):not(:hover) .argus-label { display: none; }
.argus-overview .maplibregl-popup-content { background: rgba(12, 17, 24, 0.94); color: #dfe6ee; border: 1px solid #2a3440; border-radius: 6px; padding: 8px 10px; font-size: 11px; line-height: 1.5; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; box-shadow: 0 6px 20px rgba(0,0,0,0.5); }
.argus-overview .maplibregl-popup-anchor-bottom .maplibregl-popup-tip { border-top-color: #2a3440; }
.argus-overview .maplibregl-popup-anchor-top .maplibregl-popup-tip { border-bottom-color: #2a3440; }
.argus-overview .maplibregl-ctrl-attrib { background: rgba(12, 17, 24, 0.7) !important; color: #8b98a8; font-size: 10px; }
.argus-overview .maplibregl-ctrl-attrib a { color: #b8c2cc; }
.argus-overview .maplibregl-ctrl-scale { background: rgba(12, 17, 24, 0.7); color: #dfe6ee; border-color: #8b98a8; font-size: 10px; }
.argus-overview .maplibregl-ctrl-group { background: rgba(12, 17, 24, 0.85); border: 1px solid #2a3440; }
.argus-overview .maplibregl-ctrl-group button { background-color: transparent; filter: invert(0.85); }
.argus-overview .maplibregl-ctrl-group button + button { border-top-color: #2a3440; }
`;

function injectCss(): void {
  if (document.getElementById("argus-overview-css")) return;
  const el = document.createElement("style");
  el.id = "argus-overview-css";
  el.textContent = CSS;
  document.head.appendChild(el);
}

/** Drone glyph: quad outline pointing up (north when rotated by heading), status ring, battery arc. */
function droneSvg(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "-20 -20 40 40");
  svg.innerHTML = `
    <circle class="ring" r="15" stroke="#8b98a8"/>
    <path class="batt" d="" stroke="#3fb950"/>
    <g class="body">
      <path d="M0,-11 L4,-4 L9,-9 L11,-7 L6,-2 L10,2 L2,2 L0,6 L-2,2 L-10,2 L-6,-2 L-11,-7 L-9,-9 L-4,-4 Z" fill="#0d1117" stroke="#e6edf3" stroke-width="1.2" stroke-linejoin="round"/>
      <circle cx="0" cy="-2" r="2" fill="#e6edf3"/>
    </g>`;
  return svg;
}

/** Arc from 12 o'clock clockwise, proportional to battery. */
function batteryArc(pct: number): string {
  const r = 18;
  const frac = Math.max(0.02, Math.min(1, pct / 100));
  const a = frac * 2 * Math.PI;
  const x = r * Math.sin(a), y = -r * Math.cos(a);
  const large = a > Math.PI ? 1 : 0;
  return `M0,${-r} A${r},${r} 0 ${large} 1 ${x.toFixed(2)},${y.toFixed(2)}`;
}

function batteryColor(pct: number): string {
  return pct > 50 ? "#3fb950" : pct > 25 ? "#f0883e" : "#f85149";
}

function lonLat(a: { lat: number; lon: number }, x: number, y: number): [number, number] {
  const [lat, lon] = enuToLatlon(a, x, y);
  return [lon, lat];
}

type DroneEntry = { marker: maplibregl.Marker; el: HTMLDivElement; label: HTMLDivElement; track: [number, number][]; state: DroneState };

export function createOverview(el: HTMLElement, opts: OverviewOptions): Overview {
  injectCss();
  el.classList.add("argus-overview");
  const anchor = opts.site.anchor as { lat: number; lon: number };
  const geo = opts.siteGeo;

  const mapEl = document.createElement("div");
  mapEl.className = "argus-map";
  mapEl.style.cssText = "position:absolute;inset:0;";
  el.appendChild(mapEl);

  const map = new maplibregl.Map({
    container: mapEl,
    center: [anchor.lon, anchor.lat],
    zoom: 16.4,
    minZoom: 10,
    maxZoom: 20,
    pitch: 0,
    bearing: 0,
    attributionControl: false,
    style: {
      version: 8,
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
      sources: {
        esri: {
          type: "raster",
          tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
          tileSize: 256,
          maxzoom: 19,
          attribution: "Esri, Maxar, Earthstar Geographics",
        },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#0b0e12" } },
        { id: "esri", type: "raster", source: "esri", paint: { "raster-saturation": -0.25, "raster-brightness-max": 0.92, "raster-contrast": 0.08 } },
      ],
    },
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");
  map.addControl(new maplibregl.NavigationControl({ showCompass: true, visualizePitch: false }), "top-left");

  // chrome
  const vignette = document.createElement("div");
  vignette.className = "argus-vignette";
  el.appendChild(vignette);
  const title = document.createElement("div");
  title.className = "argus-title";
  title.innerHTML = `Overview <b>${opts.site.name ?? "Site"}</b>`;
  el.appendChild(title);
  const toolbar = document.createElement("div");
  toolbar.className = "argus-toolbar";
  const followBtn = document.createElement("button");
  followBtn.className = "argus-btn";
  followBtn.textContent = "Follow selected";
  const fitBtn = document.createElement("button");
  fitBtn.className = "argus-btn";
  fitBtn.textContent = "Fit Site";
  toolbar.append(followBtn, fitBtn);
  el.appendChild(toolbar);
  const legend = document.createElement("div");
  legend.className = "argus-legend";
  legend.innerHTML = `<div class="argus-legend-title">Legend</div><div class="argus-legend-body">
    <div><span class="sw dash" style="border-color:#f85149"></span>Geofence · ceiling ${opts.site.limits?.alt_ceiling_m ?? "--"} m</div>
    <div><span class="sw" style="border-color:#ff4d6a"></span>No-fly zone</div>
    <div><span class="sw" style="border-color:#f0c04a"></span>Perimeter fences</div>
    <div><span class="sw" style="border-color:#58a6ff"></span>Protected area</div>
    <div><span class="sw" style="border-color:#3fb950"></span>Drone track (status colour)</div></div>`;
  el.appendChild(legend);

  let follow = false;
  followBtn.onclick = () => { follow = !follow; followBtn.classList.toggle("on", follow); if (follow && selected && drones.has(selected)) panTo(drones.get(selected)!.state); };
  const fitSite = () => {
    const fence = geo.features.find((f: any) => f.properties.kind === "geofence");
    if (!fence) return;
    const b = new maplibregl.LngLatBounds();
    for (const c of fence.geometry.coordinates[0]) b.extend(c as [number, number]);
    map.fitBounds(b, { padding: 28, duration: 600 });
  };
  fitBtn.onclick = fitSite;
  map.on("dragstart", () => { if (follow) { follow = false; followBtn.classList.remove("on"); } });
  const compact = () => el.classList.toggle("compact", map.getZoom() < 17.6);
  map.on("zoom", compact);
  map.on("load", compact);

  const drones = new Map<string, DroneEntry>();
  let selected: string | null = null;
  let ready = false;
  const pending: (() => void)[] = [];
  const whenReady = (fn: () => void) => (ready ? fn() : pending.push(fn));

  const byKind = (kind: string) => ({ type: "FeatureCollection", features: geo.features.filter((f: any) => f.properties.kind === kind) });

  map.on("load", () => {
    // ---- Site layers ---------------------------------------------------------------------
    map.addSource("geofence", { type: "geojson", data: byKind("geofence") });
    map.addSource("protected", { type: "geojson", data: byKind("protected_area") });
    map.addSource("nofly", { type: "geojson", data: byKind("no_fly_zone") });
    map.addSource("fences", { type: "geojson", data: byKind("fence_section") });
    map.addSource("pads", { type: "geojson", data: byKind("helipad") });
    map.addSource("gate", { type: "geojson", data: byKind("gate") });
    map.addSource("footprint", { type: "geojson", data: byKind("overhead_footprint") });
    map.addSource("props", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addSource("tracks", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addSource("zone-labels", { type: "geojson", data: zoneLabels() });

    map.addLayer({ id: "footprint-line", type: "line", source: "footprint", paint: { "line-color": "#8b98a8", "line-width": 1, "line-dasharray": [1, 3], "line-opacity": 0.55 } });
    map.addLayer({ id: "protected-fill", type: "fill", source: "protected", paint: { "fill-color": "#58a6ff", "fill-opacity": 0.07 } });
    map.addLayer({ id: "protected-line", type: "line", source: "protected", paint: { "line-color": "#58a6ff", "line-width": 1, "line-opacity": 0.6 } });
    map.addLayer({ id: "nofly-fill", type: "fill", source: "nofly", paint: { "fill-color": "#ff4d6a", "fill-opacity": 0.16 } });
    map.addLayer({ id: "nofly-line", type: "line", source: "nofly", paint: { "line-color": "#ff4d6a", "line-width": 1.5 } });
    map.addLayer({ id: "geofence-line", type: "line", source: "geofence", paint: { "line-color": "#f85149", "line-width": 1.8, "line-dasharray": [4, 2.5] } });
    map.addLayer({ id: "fences-line", type: "line", source: "fences", paint: { "line-color": ["case", ["boolean", ["get", "open"], false], "#ff2d55", "#f0c04a"], "line-width": ["case", ["boolean", ["get", "open"], false], 4, 1.4], "line-opacity": 0.95 } });
    map.addLayer({ id: "pads-circle", type: "circle", source: "pads", paint: { "circle-radius": 5, "circle-color": "#0d1117", "circle-stroke-color": "#dfe6ee", "circle-stroke-width": 1.5 } });
    map.addLayer({ id: "gate-circle", type: "circle", source: "gate", paint: { "circle-radius": 4, "circle-color": "#f0c04a", "circle-stroke-color": "#0d1117", "circle-stroke-width": 1 } });
    map.addLayer({ id: "props-circle", type: "circle", source: "props", paint: {
      "circle-radius": 7,
      "circle-color": ["match", ["get", "kind"], "vehicle", "#ff2d55", "crate", "#d29922", "person", "#bc8cff", "#e6edf3"],
      "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5, "circle-opacity": 0.95,
    } });
    map.addLayer({ id: "props-label", type: "symbol", source: "props", layout: { "text-field": ["get", "label"], "text-size": 10, "text-offset": [0, 1.3], "text-anchor": "top", "text-font": ["Open Sans Semibold"] }, paint: { "text-color": "#ffd7dd", "text-halo-color": "#0b0e12", "text-halo-width": 1.2 } });
    map.addLayer({ id: "tracks-line", type: "line", source: "tracks", layout: { "line-cap": "round", "line-join": "round" }, paint: {
      "line-color": ["get", "color"], "line-width": ["case", ["boolean", ["get", "selected"], false], 3, 1.8], "line-opacity": 0.85,
    } });
    map.addLayer({ id: "zone-labels", type: "symbol", source: "zone-labels", layout: { "text-field": ["get", "label"], "text-size": 10.5, "text-letter-spacing": 0.12, "text-transform": "uppercase", "text-font": ["Open Sans Semibold"], "text-anchor": ["get", "anchor"], "text-offset": ["get", "offset"] }, paint: { "text-color": ["get", "color"], "text-halo-color": "#0b0e12", "text-halo-width": 1.3, "text-opacity": 0.9 } });

    // tooltips
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, maxWidth: "260px" });
    const hover = (layer: string, text: (p: any) => string) => {
      map.on("mousemove", layer, (e: MapLayerMouseEvent) => {
        const f = e.features?.[0]; if (!f) return;
        map.getCanvas().style.cursor = "default";
        popup.setLngLat(e.lngLat).setHTML(text(f.properties)).addTo(map);
      });
      map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; popup.remove(); });
    };
    hover("nofly-fill", (p) => `<b>No-fly zone</b><br>${p.name ?? ""}`);
    hover("geofence-line", (p) => `<b>Geofence</b><br>ceiling ${p.alt_ceiling_m} m · floor ${p.alt_floor_m} m`);
    hover("fences-line", (p) => `<b>${p.open ? "OPEN fence section" : "Fence section"}</b><br>${p.name}`);
    hover("pads-circle", (p) => `<b>${p.name}</b><br>${p.drone_id ?? "unassigned"}`);
    hover("props-circle", (p) => `<b>${p.kind}</b><br>${p.id}`);

    ready = true;
    pending.splice(0).forEach((fn) => fn());
    fitSite();
  });

  function zoneLabels() {
    const f = (kind: string) => geo.features.find((x: any) => x.properties.kind === kind);
    const ringTop = (feat: any, idx: number) => feat.geometry.coordinates[0][idx];
    const out: any[] = [];
    const gf = f("geofence"); if (gf) out.push({ type: "Feature", properties: { label: "geofence", color: "#f85149", anchor: "bottom-left", offset: [0.2, -0.3] }, geometry: { type: "Point", coordinates: ringTop(gf, 3) } });
    const pa = f("protected_area"); if (pa) out.push({ type: "Feature", properties: { label: "protected area", color: "#58a6ff", anchor: "top-left", offset: [0.3, 0.3] }, geometry: { type: "Point", coordinates: ringTop(pa, 3) } });
    const nf = f("no_fly_zone"); if (nf) {
      const c = nf.geometry.coordinates[0]; const lon = c.reduce((s: number, p: number[]) => s + p[0], 0) / c.length; const lat = c.reduce((s: number, p: number[]) => s + p[1], 0) / c.length;
      out.push({ type: "Feature", properties: { label: "no-fly · reactor", color: "#ff8fa3", anchor: "center", offset: [0, 0] }, geometry: { type: "Point", coordinates: [lon, lat] } });
    }
    const gate = f("gate"); if (gate) out.push({ type: "Feature", properties: { label: "gate", color: "#f0c04a", anchor: "top", offset: [0, 0.8] }, geometry: gate.geometry });
    return { type: "FeatureCollection", features: out };
  }

  function panTo(s: DroneState) {
    map.easeTo({ center: [s.lon, s.lat], duration: 400, easing: (t: number) => t });
  }

  function refreshTracks() {
    const features = [...drones.values()].filter((d) => d.track.length > 1).map((d) => ({
      type: "Feature", properties: { color: STATUS_COLOR[d.state.status] ?? "#3fb950", selected: d.state.drone_id === selected },
      geometry: { type: "LineString", coordinates: d.track },
    }));
    (map.getSource("tracks") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features } as any);
  }

  function updateDrone(s: DroneState) {
    let d = drones.get(s.drone_id);
    if (!d) {
      const wrap = document.createElement("div");
      wrap.className = "argus-drone";
      const svg = droneSvg();
      wrap.appendChild(svg);
      const label = document.createElement("div");
      label.className = "argus-label";
      wrap.appendChild(label);
      wrap.addEventListener("click", (e) => { e.stopPropagation(); opts.onSelect(s.drone_id); });
      wrap.title = s.drone_id;
      const marker = new maplibregl.Marker({ element: wrap, anchor: "center", rotationAlignment: "map", pitchAlignment: "map" }).setLngLat([s.lon, s.lat]).addTo(map);
      d = { marker, el: wrap, label, track: [], state: s };
      drones.set(s.drone_id, d);
    }
    d.state = s;
    d.marker.setLngLat([s.lon, s.lat]);
    const body = d.el.querySelector<SVGGElement>(".body")!;
    body.setAttribute("transform", `rotate(${s.heading_deg.toFixed(1)})`);
    const ring = d.el.querySelector<SVGCircleElement>(".ring")!;
    ring.setAttribute("stroke", STATUS_COLOR[s.status] ?? "#8b98a8");
    const batt = d.el.querySelector<SVGPathElement>(".batt")!;
    batt.setAttribute("d", batteryArc(s.battery_pct));
    batt.setAttribute("stroke", batteryColor(s.battery_pct));
    d.el.style.opacity = s.status === "offline" ? "0.45" : "1";
    d.label.innerHTML = `${s.drone_id}<small>${s.alt.toFixed(0)} m · ${s.battery_pct.toFixed(0)}%</small>`;
    d.el.classList.toggle("selected", s.drone_id === selected);
    // track: only while airborne, drop the tail
    if (s.alt > 0.5) {
      const last = d.track[d.track.length - 1];
      if (!last || Math.abs(last[0] - s.lon) > 1e-7 || Math.abs(last[1] - s.lat) > 1e-7) d.track.push([s.lon, s.lat]);
      if (d.track.length > TRACK_POINTS) d.track.splice(0, d.track.length - TRACK_POINTS);
    } else if (d.track.length && s.status === "idle") {
      d.track = [];
    }
    whenReady(refreshTracks);
    if (follow && selected === s.drone_id) panTo(s);
  }

  function setSelected(id: string | null) {
    selected = id;
    for (const [k, d] of drones) d.el.classList.toggle("selected", k === id);
    whenReady(refreshTracks);
    if (follow && id && drones.has(id)) panTo(drones.get(id)!.state);
  }

  function setScene(state: SceneState) {
    whenReady(() => {
      const open = new Set(state.open_fences);
      const fences = byKind("fence_section");
      fences.features = fences.features.map((f: any) => ({ ...f, properties: { ...f.properties, open: open.has(f.properties.name) } }));
      (map.getSource("fences") as maplibregl.GeoJSONSource).setData(fences as any);
      const props = {
        type: "FeatureCollection",
        features: state.props.map((p) => ({ type: "Feature", properties: { id: p.id, kind: p.kind, label: p.kind === "vehicle" ? "intruder vehicle" : p.kind }, geometry: { type: "Point", coordinates: lonLat(anchor, p.x, p.y) } })),
      };
      (map.getSource("props") as maplibregl.GeoJSONSource).setData(props as any);
    });
  }

  function resize() { map.resize(); }
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => map.resize()).observe(el);

  return { updateDrone, setSelected, setScene, resize };
}
