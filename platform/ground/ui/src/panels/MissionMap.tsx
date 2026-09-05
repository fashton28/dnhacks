/* MissionMap — self-drawn SVG site map for the mission (power-plant security)
   view. No tile servers, fully offline: a local equirectangular meters
   projection centred on the SITE HOME renders the perimeter geofence, NFZ
   polygons, staging markers, the satellite anomaly pin, the planned route
   (legs + orbit circle), the vehicle with heading + breadcrumb trail.
   Every coordinate comes from the loaded site model / wire messages —
   nothing is hardcoded. */
import React from 'react';
import { Panel, Badge } from '@/components';
import type { Anomaly, MissionPlan, ObservationMessage, RfEventMessage, Telemetry } from '@/contract';
import type { SiteModel } from '@/site';

const M_PER_DEG_LAT = 111320;

interface XY { x: number; y: number }

export interface MissionMapProps {
  site: SiteModel | null;
  tel: Telemetry | null;
  trail: { lat: number; lon: number }[];
  anomalies: Anomaly[];
  /** The plan whose route to draw (the effective/corrected plan). */
  plan: MissionPlan | null;
  executing?: boolean;
  observation?: ObservationMessage | null;
  rfEvents?: RfEventMessage[];
}

export function MissionMap({ site, tel, trail, anomalies, plan, executing, observation = null, rfEvents = [] }: MissionMapProps): React.ReactElement {
  const view = React.useMemo(() => (site ? computeView(site, anomalies, observation, rfEvents) : null), [site, anomalies, observation, rfEvents]);

  return (
    <Panel
      title="Site map"
      variant="sunken"
      pad={false}
      status={executing ? <Badge tone="accent" mono>MISSION</Badge> : undefined}
      actions={<Badge tone="outline" mono>SVG · OFFLINE</Badge>}
      style={{ height: '100%' }}
      bodyStyle={{ position: 'relative' }}
    >
      <div style={{ position: 'absolute', inset: 0 }}>
        {!site || !view ? (
          <div
            style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
              justifyContent: 'center', color: 'var(--text-disabled)',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)',
            }}
          >
            Loading site model…
          </div>
        ) : (
          <MapSvg site={site} view={view} tel={tel} trail={trail} anomalies={anomalies} plan={plan} observation={observation} rfEvents={rfEvents} />
        )}
        {site && view && <Legend metersAcross={view.w} />}
      </div>
    </Panel>
  );
}

/* ---- projection ---------------------------------------------------------- */

interface View {
  home: { lat: number; lon: number };
  cosLat: number;
  minX: number;
  minY: number;
  w: number;
  h: number;
}

function computeView(site: SiteModel, anomalies: Anomaly[], observation: ObservationMessage | null, rfEvents: RfEventMessage[]): View {
  const home = site.home;
  const cosLat = Math.cos((home.lat * Math.PI) / 180);
  const pts: XY[] = [];
  const push = (lat: number, lon: number): void => {
    pts.push({
      x: (lon - home.lon) * M_PER_DEG_LAT * cosLat,
      y: -(lat - home.lat) * M_PER_DEG_LAT, // SVG y grows south
    });
  };
  push(home.lat, home.lon);
  site.perimeter.forEach((p) => push(p.lat, p.lon));
  site.staging.forEach((p) => push(p.lat, p.lon));
  anomalies.forEach((a) => push(a.lat, a.lon));
  observation?.geometry.fence_gaps.forEach((p) => push(p.lat, p.lon));
  observation?.geometry.new_structures.forEach((p) => push(p.lat, p.lon));
  rfEvents.forEach((event) => {
    if (event.lat !== undefined && event.lon !== undefined) push(event.lat, event.lon);
    if (event.pilot_lat !== undefined && event.pilot_lon !== undefined) push(event.pilot_lat, event.pilot_lon);
  });
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const margin = 45; // m
  const minX = Math.min(...xs) - margin;
  const maxX = Math.max(...xs) + margin;
  const minY = Math.min(...ys) - margin;
  const maxY = Math.max(...ys) + margin;
  return { home, cosLat, minX, minY, w: maxX - minX, h: maxY - minY };
}

function project(view: View, lat: number, lon: number): XY {
  return {
    x: (lon - view.home.lon) * M_PER_DEG_LAT * view.cosLat,
    y: -(lat - view.home.lat) * M_PER_DEG_LAT,
  };
}

/* ---- svg body ------------------------------------------------------------ */

interface MapSvgProps {
  site: SiteModel;
  view: View;
  tel: Telemetry | null;
  trail: { lat: number; lon: number }[];
  anomalies: Anomaly[];
  plan: MissionPlan | null;
  observation: ObservationMessage | null;
  rfEvents: RfEventMessage[];
}

function MapSvg({ site, view, tel, trail, anomalies, plan, observation, rfEvents }: MapSvgProps): React.ReactElement {
  const fs = Math.max(6, view.w / 55); // svg-unit font size (meters)
  const pj = (lat: number, lon: number): XY => project(view, lat, lon);
  const ring = (poly: { lat: number; lon: number }[]): string =>
    poly.map((p) => { const q = pj(p.lat, p.lon); return `${q.x},${q.y}`; }).join(' ');

  const homeXY = pj(site.home.lat, site.home.lon);
  const droneXY = tel ? pj(tel.position.lat, tel.position.lon) : null;
  const trailPts = trail.map((p) => { const q = pj(p.lat, p.lon); return `${q.x},${q.y}`; }).join(' ');

  // Planned route: home → each goto/orbit target in order (→ home when rtl).
  const route: XY[] = [];
  const orbits: { c: XY; r: number }[] = [];
  if (plan) {
    route.push(homeXY);
    for (const t of plan.tools) {
      if (t.tool === 'goto_gps' || t.tool === 'orbit_point') {
        const q = pj(t.lat, t.lon);
        route.push(q);
        if (t.tool === 'orbit_point') orbits.push({ c: q, r: t.radius });
      } else if (t.tool === 'rtl') {
        route.push(homeXY);
      }
    }
  }

  return (
    <svg
      viewBox={`${view.minX} ${view.minY} ${view.w} ${view.h}`}
      preserveAspectRatio="xMidYMid meet"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', background: 'var(--bg-sunken)' }}
    >
      {/* 50 m grid */}
      <defs>
        <pattern id="eis-grid" width={50} height={50} patternUnits="userSpaceOnUse">
          <path d="M 50 0 L 0 0 0 50" fill="none" stroke="rgba(255,255,255,0.045)" strokeWidth={0.6} />
        </pattern>
      </defs>
      <rect x={view.minX} y={view.minY} width={view.w} height={view.h} fill="url(#eis-grid)" />

      {/* perimeter geofence */}
      <polygon
        points={ring(site.perimeter)}
        fill="rgba(47,129,247,0.05)"
        stroke="rgba(47,129,247,0.65)"
        strokeWidth={1.5}
        strokeDasharray="7 5"
        vectorEffect="non-scaling-stroke"
      />

      {/* NFZ polygons */}
      {site.nfz.map((z, i) => {
        const c = centroid(z.polygon.map((p) => pj(p.lat, p.lon)));
        return (
          <g key={i}>
            <polygon
              points={ring(z.polygon)}
              fill="rgba(240,68,56,0.16)"
              stroke="rgba(240,68,56,0.7)"
              strokeWidth={1.2}
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={c.x} y={c.y} textAnchor="middle" dominantBaseline="middle"
              fontSize={fs * 0.9} fill="#ff6b66" fontFamily="var(--font-sans)" fontWeight={600}
              style={{ textTransform: 'uppercase', letterSpacing: 1 }}
            >
              {z.name} ≤{z.ceilingM}m
            </text>
          </g>
        );
      })}

      {/* LiDAR-known clutter volumes */}
      {site.clutter.map((item) => (
        <polygon key={item.name} points={ring(item.polygon)} fill="rgba(170,118,255,0.10)" stroke="rgba(170,118,255,0.55)" strokeWidth={1} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
      ))}

      {/* planned route */}
      {route.length > 1 && (
        <polyline
          points={route.map((q) => `${q.x},${q.y}`).join(' ')}
          fill="none"
          stroke="rgba(90,160,255,0.9)"
          strokeWidth={1.6}
          strokeDasharray="4 4"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {orbits.map((o, i) => (
        <circle
          key={i} cx={o.c.x} cy={o.c.y} r={o.r}
          fill="none" stroke="rgba(90,160,255,0.8)" strokeWidth={1.2}
          strokeDasharray="3 3" vectorEffect="non-scaling-stroke"
        />
      ))}
      {route.slice(1).map((q, i) => (
        <circle key={i} cx={q.x} cy={q.y} r={fs * 0.28} fill="#5aa0ff" stroke="#0b0d11" strokeWidth={0.6} />
      ))}

      {/* staging markers (diamonds) */}
      {site.staging.map((sp) => {
        const q = pj(sp.lat, sp.lon);
        const r = fs * 0.55;
        return (
          <g key={sp.id}>
            <polygon
              points={`${q.x},${q.y - r} ${q.x + r},${q.y} ${q.x},${q.y + r} ${q.x - r},${q.y}`}
              fill="rgba(196,204,214,0.85)" stroke="#0b0d11" strokeWidth={0.6}
            />
            <text x={q.x} y={q.y + r + fs} textAnchor="middle" fontSize={fs * 0.8}
              fill="var(--text-tertiary)" fontFamily="var(--font-mono)">
              {sp.id}
            </text>
          </g>
        );
      })}

      {/* anomaly pins */}
      {anomalies.map((a) => {
        const q = pj(a.lat, a.lon);
        const pin = a.source === 'sdr' ? '#ff6b66' : a.source === 'rf_drone' ? '#c47dff' : a.source === 'drone_survey' ? '#58d68d' : '#ffc24b';
        return (
          <g key={a.id}>
            <circle cx={q.x} cy={q.y} r={fs * 1.15} fill="none" stroke={pin} strokeWidth={1.2}
              vectorEffect="non-scaling-stroke" opacity={0.85}>
              <animate attributeName="r" values={`${fs * 0.7};${fs * 1.5};${fs * 0.7}`} dur="2.2s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.9;0.25;0.9" dur="2.2s" repeatCount="indefinite" />
            </circle>
            <circle cx={q.x} cy={q.y} r={fs * 0.4} fill={pin} stroke="#0b0d11" strokeWidth={0.6} />
            <text x={q.x + fs * 0.9} y={q.y - fs * 0.6} fontSize={fs * 0.8}
              fill={pin} fontFamily="var(--font-mono)">
              {a.source ?? 'unknown'} · {a.id}
            </text>
          </g>
        );
      })}

      {/* LiDAR-derived geometry claims */}
      {observation?.geometry.fence_gaps.map((gap, i) => {
        const q = pj(gap.lat, gap.lon);
        return <g key={`gap-${i}`}><circle cx={q.x} cy={q.y} r={fs * 0.7} fill="none" stroke="#ff6b66" strokeWidth={2} vectorEffect="non-scaling-stroke" /><text x={q.x + fs} y={q.y} fontSize={fs * 0.75} fill="#ff6b66">FENCE GAP {gap.width_m}m</text></g>;
      })}
      {observation?.geometry.new_structures.map((structure, i) => {
        const q = pj(structure.lat, structure.lon);
        const r = Math.max(fs * 0.6, Math.sqrt(structure.footprint_m2));
        return <g key={`structure-${i}`}><rect x={q.x - r / 2} y={q.y - r / 2} width={r} height={r} fill="rgba(255,194,75,0.25)" stroke="#ffc24b" vectorEffect="non-scaling-stroke" /><text x={q.x + r} y={q.y} fontSize={fs * 0.75} fill="#ffc24b">NEW STRUCTURE</text></g>;
      })}

      {/* Passive RF-drone marker and inferred pilot location */}
      {rfEvents.filter((event) => event.kind === 'hostile_drone').map((event, i) => {
        const drone = event.lat !== undefined && event.lon !== undefined ? pj(event.lat, event.lon) : null;
        const pilot = event.pilot_lat !== undefined && event.pilot_lon !== undefined ? pj(event.pilot_lat, event.pilot_lon) : null;
        return <g key={`hostile-${i}`}>
          {drone && pilot && <line x1={drone.x} y1={drone.y} x2={pilot.x} y2={pilot.y} stroke="#ff6b66" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
          {drone && <><path d={`M${drone.x} ${drone.y - fs} L${drone.x + fs} ${drone.y} L${drone.x} ${drone.y + fs} L${drone.x - fs} ${drone.y} Z`} fill="#ff3b30" stroke="#fff" strokeWidth={0.5} /><text x={drone.x + fs * 1.3} y={drone.y} fontSize={fs * 0.8} fill="#ff6b66">HOSTILE</text></>}
          {pilot && <><circle cx={pilot.x} cy={pilot.y} r={fs * 0.55} fill="#ff6b66" /><text x={pilot.x + fs} y={pilot.y} fontSize={fs * 0.8} fill="#ff6b66">PILOT</text></>}
        </g>;
      })}

      {/* breadcrumb trail */}
      {trail.length > 1 && (
        <polyline
          points={trailPts}
          fill="none" stroke="rgba(90,160,255,0.55)" strokeWidth={1.4}
          vectorEffect="non-scaling-stroke"
        />
      )}

      {/* home */}
      <circle cx={homeXY.x} cy={homeXY.y} r={fs * 0.42} fill="#e6eaf0" stroke="rgba(0,0,0,0.65)" strokeWidth={0.8} />
      <text x={homeXY.x + fs * 0.8} y={homeXY.y + fs * 0.4} fontSize={fs * 0.8}
        fill="var(--text-tertiary)" fontFamily="var(--font-mono)">
        H
      </text>

      {/* vehicle */}
      {droneXY && (
        <g transform={`translate(${droneXY.x} ${droneXY.y}) rotate(${tel?.heading ?? 0})`}>
          <path
            d={`M0 ${-fs * 1.1} L${fs * 0.7} ${fs * 0.8} L0 ${fs * 0.35} L${-fs * 0.7} ${fs * 0.8} Z`}
            fill="#ffc24b" stroke="#0b0d11" strokeWidth={0.7} strokeLinejoin="round"
          />
        </g>
      )}
    </svg>
  );
}

function centroid(pts: XY[]): XY {
  const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return { x, y };
}

/* ---- overlay legend ------------------------------------------------------ */

function Legend({ metersAcross }: { metersAcross: number }): React.ReactElement {
  const rows: Array<[string, string, boolean]> = [
    ['#ffc24b', 'Vehicle / anomaly', false],
    ['rgba(47,129,247,0.8)', 'Perimeter fence', true],
    ['rgba(240,68,56,0.8)', 'No-fly zone', false],
    ['rgba(90,160,255,0.9)', 'Planned route', true],
    ['rgba(196,204,214,0.9)', 'Staging point', false],
    ['rgba(170,118,255,0.8)', 'Clutter / LiDAR', true],
    ['#ff3b30', 'Hostile RF / pilot', false],
  ];
  return (
    <div
      style={{
        position: 'absolute', left: 10, bottom: 10,
        display: 'flex', flexDirection: 'column', gap: 4,
        padding: '7px 9px',
        background: 'rgba(8,12,16,0.72)',
        backdropFilter: 'blur(6px)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-sm)',
        zIndex: 5,
      }}
    >
      {rows.map(([color, label, dash]) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
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
          <span style={{ fontSize: 10, color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)' }}>{label}</span>
        </div>
      ))}
      <div style={{ fontSize: 10, color: 'var(--text-disabled)', fontFamily: 'var(--font-mono)' }}>
        view ≈ {Math.round(metersAcross)} m across · grid 50 m
      </div>
    </div>
  );
}
