/* MissionMap — self-drawn SVG site map for the mission (power-plant security)
   view. No tile servers, fully offline: a local equirectangular meters
   projection centred on the SITE HOME renders the perimeter geofence, NFZ
   polygons, staging markers, the satellite anomaly pin, the planned route
   (legs + orbit circle) INSIDE its corridor band, every fleet vehicle with its
   own cleared corridor and track, and the followed vehicle's breadcrumb trail.
   Every coordinate comes from the loaded site model / wire messages —
   nothing is hardcoded.

   The map header carries the fleet strip: one chip per vehicle (readiness,
   SoC, sortie timer, monitor state). Selecting a chip switches which vehicle
   the whole dashboard follows.

   The cue pin is draggable: dropping it somewhere else asks the data source to
   RE-PLAN from the new location. The map never edits a plan — it reports where
   the operator put the target and the planner + verifier do the rest. */
import React from 'react';
import { Panel, Badge } from '@/components';
import type {
  Anomaly,
  Corridor,
  EnvelopeMessage,
  EnvelopeState,
  FleetVehicle,
  MissionPlan,
  ObservationMessage,
  RfEventMessage,
  Telemetry,
} from '@/contract';
import type { SiteModel } from '@/site';

const M_PER_DEG_LAT = 111320;

interface XY { x: number; y: number }

/** Pin/track colour per vehicle, by fleet order. New rails are pin colours and
 *  badges — never another panel. */
const VEHICLE_COLORS = ['#ffc24b', '#58d68d', '#c47dff', '#5aa0ff'];

const ENVELOPE_TONE: Record<EnvelopeState, 'nominal' | 'caution' | 'danger'> = {
  in_envelope: 'nominal',
  warning: 'caution',
  breach: 'danger',
};

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
  /** Fleet rows: every vehicle's position and cleared corridor. */
  fleet?: FleetVehicle[];
  /** Latest envelope report per vehicle (the fleet chip's monitor state). */
  envelopeByVehicle?: Record<string, EnvelopeMessage>;
  /** Breadcrumb tracks per vehicle, sampled from the fleet stream. */
  trailsByVehicle?: Record<string, { lat: number; lon: number }[]>;
  selectedVehicle?: string;
  onSelectVehicle?: (id: string) => void;
  /** Present when the data source can re-plan from a relocated cue. */
  onMoveAnomaly?: (anomalyId: string, lat: number, lon: number) => void;
}

export function MissionMap({
  site, tel, trail, anomalies, plan, executing,
  observation = null, rfEvents = [],
  fleet = [], envelopeByVehicle = {}, trailsByVehicle = {},
  selectedVehicle, onSelectVehicle, onMoveAnomaly,
}: MissionMapProps): React.ReactElement {
  const view = React.useMemo(
    () => (site ? computeView(site, anomalies, observation, rfEvents, fleet) : null),
    [site, anomalies, observation, rfEvents, fleet],
  );

  return (
    <Panel
      title="Site map"
      variant="sunken"
      pad={false}
      status={executing ? <Badge tone="accent" mono>MISSION</Badge> : undefined}
      actions={
        fleet.length > 0
          ? <FleetStrip
              fleet={fleet}
              envelopeByVehicle={envelopeByVehicle}
              selectedVehicle={selectedVehicle}
              onSelectVehicle={onSelectVehicle}
            />
          : <Badge tone="outline" mono>SITE MODEL</Badge>
      }
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
          <MapSvg
            site={site} view={view} tel={tel} trail={trail} anomalies={anomalies} plan={plan}
            observation={observation} rfEvents={rfEvents} fleet={fleet}
            trailsByVehicle={trailsByVehicle} selectedVehicle={selectedVehicle}
            onMoveAnomaly={onMoveAnomaly}
          />
        )}
        {site && view && <Legend metersAcross={view.w} corridor={!!plan?.corridor} />}
      </div>
    </Panel>
  );
}

/* ---- fleet strip --------------------------------------------------------- */

interface FleetStripProps {
  fleet: FleetVehicle[];
  envelopeByVehicle: Record<string, EnvelopeMessage>;
  selectedVehicle?: string;
  onSelectVehicle?: (id: string) => void;
}

function FleetStrip({ fleet, envelopeByVehicle, selectedVehicle, onSelectVehicle }: FleetStripProps): React.ReactElement {
  // The sortie timer counts against a wall-clock deadline, so it needs its own
  // 1 Hz tick rather than waiting for the next fleet frame.
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {fleet.map((v, i) => {
        const on = v.vehicleId === selectedVehicle;
        const color = VEHICLE_COLORS[i % VEHICLE_COLORS.length];
        const envelope = envelopeByVehicle[v.vehicleId];
        const leftS = v.sortie ? Math.max(0, Math.round((v.sortie.must_rtl_by - Date.now()) / 1000)) : null;
        return (
          <button
            key={v.vehicleId}
            type="button"
            onClick={() => onSelectVehicle?.(v.vehicleId)}
            title={v.readiness.ready ? 'Ready' : v.readiness.reasons.join('; ') || 'Not ready'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              height: 22, padding: '0 7px',
              background: on ? 'var(--surface-input)' : 'transparent',
              border: `1px solid ${on ? 'var(--border-strong)' : 'var(--border-subtle)'}`,
              borderRadius: 'var(--radius-pill)',
              color: 'var(--text-secondary)',
              fontFamily: 'var(--font-mono)', fontSize: 10,
              cursor: onSelectVehicle ? 'pointer' : 'default',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flex: 'none' }} />
            <span style={{ color: on ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: 600 }}>
              {v.vehicleId}
            </span>
            <span style={{ color: v.readiness.ready ? 'var(--nominal-fg)' : 'var(--danger-fg)' }}>
              {v.readiness.ready ? 'RDY' : 'HOLD'}
            </span>
            <span>{v.battery.soc_pct.toFixed(0)}%</span>
            <span style={{ color: leftS !== null && leftS <= 60 ? 'var(--danger-fg)' : 'var(--text-tertiary)' }}>
              {leftS === null ? '--:--' : fmtClock(leftS)}
            </span>
            <Badge tone={envelope ? ENVELOPE_TONE[envelope.state] : 'outline'} mono>
              {envelope ? envelope.state === 'in_envelope' ? 'ENV OK' : envelope.state.toUpperCase() : 'ENV ?'}
            </Badge>
          </button>
        );
      })}
    </div>
  );
}

function fmtClock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
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

function computeView(
  site: SiteModel,
  anomalies: Anomaly[],
  observation: ObservationMessage | null,
  rfEvents: RfEventMessage[],
  fleet: FleetVehicle[],
): View {
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
  fleet.forEach((v) => {
    if (v.position.lat !== 0 || v.position.lon !== 0) push(v.position.lat, v.position.lon);
  });
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

function unproject(view: View, x: number, y: number): { lat: number; lon: number } {
  return {
    lat: view.home.lat - y / M_PER_DEG_LAT,
    lon: view.home.lon + x / (M_PER_DEG_LAT * view.cosLat),
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
  fleet: FleetVehicle[];
  trailsByVehicle: Record<string, { lat: number; lon: number }[]>;
  selectedVehicle?: string;
  onMoveAnomaly?: (anomalyId: string, lat: number, lon: number) => void;
}

function MapSvg({
  site, view, tel, trail, anomalies, plan, observation, rfEvents,
  fleet, trailsByVehicle, selectedVehicle, onMoveAnomaly,
}: MapSvgProps): React.ReactElement {
  const fs = Math.max(6, view.w / 55); // svg-unit font size (meters)
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const [drag, setDrag] = React.useState<{ id: string; x: number; y: number } | null>(null);

  const pj = (lat: number, lon: number): XY => project(view, lat, lon);
  const ring = (poly: { lat: number; lon: number }[]): string =>
    poly.map((p) => { const q = pj(p.lat, p.lon); return `${q.x},${q.y}`; }).join(' ');

  const homeXY = pj(site.home.lat, site.home.lon);
  const droneXY = tel ? pj(tel.position.lat, tel.position.lon) : null;
  const trailPts = trail.map((p) => { const q = pj(p.lat, p.lon); return `${q.x},${q.y}`; }).join(' ');

  /* Client coordinates → map user units (metres east/south of home). */
  const toUser = (clientX: number, clientY: number): XY | null => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (!drag) return;
    const p = toUser(e.clientX, e.clientY);
    if (p) setDrag({ ...drag, x: p.x, y: p.y });
  };
  const endDrag = (): void => {
    if (!drag) return;
    const { lat, lon } = unproject(view, drag.x, drag.y);
    setDrag(null);
    onMoveAnomaly?.(drag.id, lat, lon);
  };

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

  const corridorFor = (id: string): Corridor | undefined =>
    fleet.find((v) => v.vehicleId === id)?.plannedCorridor;

  return (
    <svg
      ref={svgRef}
      viewBox={`${view.minX} ${view.minY} ${view.w} ${view.h}`}
      preserveAspectRatio="xMidYMid meet"
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        background: 'var(--bg-sunken)', touchAction: drag ? 'none' : 'auto',
      }}
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

      {/* Every fleet vehicle's cleared corridor, drawn as a BAND: the stroke
          width IS the tolerance, so what you see is what the monitor checks. */}
      {fleet.map((v, i) => {
        const corridor = v.plannedCorridor;
        if (!corridor) return null;
        return (
          <CorridorBand
            key={`corridor-${v.vehicleId}`}
            corridor={corridor}
            project={pj}
            color={VEHICLE_COLORS[i % VEHICLE_COLORS.length]}
            dim={v.vehicleId !== selectedVehicle}
          />
        );
      })}
      {/* The selected plan's own corridor, when the fleet row does not carry it. */}
      {plan?.corridor && !corridorFor(selectedVehicle ?? '') && (
        <CorridorBand corridor={plan.corridor} project={pj} color="#5aa0ff" dim={false} />
      )}

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

      {/* anomaly pins — draggable when the source can re-plan from a new target */}
      {anomalies.map((a) => {
        const dragging = drag?.id === a.id;
        const q = dragging ? { x: drag.x, y: drag.y } : pj(a.lat, a.lon);
        const pin = a.source === 'sdr' ? '#ff6b66' : a.source === 'rf_drone' ? '#c47dff' : a.source === 'drone_survey' ? '#58d68d' : '#ffc24b';
        const movable = !!onMoveAnomaly;
        return (
          <g
            key={a.id}
            style={{ cursor: movable ? (dragging ? 'grabbing' : 'grab') : 'default' }}
            onPointerDown={(e) => {
              if (!movable) return;
              e.preventDefault();
              const p = toUser(e.clientX, e.clientY);
              setDrag({ id: a.id, x: p?.x ?? q.x, y: p?.y ?? q.y });
            }}
          >
            {/* generous invisible hit area so the pin is easy to grab */}
            {movable && <circle cx={q.x} cy={q.y} r={fs * 1.8} fill="transparent" />}
            <circle cx={q.x} cy={q.y} r={fs * 1.15} fill="none" stroke={pin} strokeWidth={1.2}
              vectorEffect="non-scaling-stroke" opacity={0.85}>
              <animate attributeName="r" values={`${fs * 0.7};${fs * 1.5};${fs * 0.7}`} dur="2.2s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.9;0.25;0.9" dur="2.2s" repeatCount="indefinite" />
            </circle>
            <circle cx={q.x} cy={q.y} r={fs * 0.4} fill={pin} stroke="#0b0d11" strokeWidth={0.6} />
            <text x={q.x + fs * 0.9} y={q.y - fs * 0.6} fontSize={fs * 0.8}
              fill={pin} fontFamily="var(--font-mono)">
              {a.source ?? 'unknown'} · {a.id}{dragging ? ' · drop to re-plan' : ''}
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

      {/* per-vehicle tracks sampled from the fleet stream */}
      {fleet.map((v, i) => {
        const points = trailsByVehicle[v.vehicleId];
        if (!points || points.length < 2) return null;
        return (
          <polyline
            key={`track-${v.vehicleId}`}
            points={points.map((p) => { const q = pj(p.lat, p.lon); return `${q.x},${q.y}`; }).join(' ')}
            fill="none"
            stroke={VEHICLE_COLORS[i % VEHICLE_COLORS.length]}
            strokeOpacity={v.vehicleId === selectedVehicle ? 0.6 : 0.32}
            strokeWidth={1.2}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}

      {/* breadcrumb trail of the followed vehicle (telemetry-rate) */}
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

      {/* every fleet vehicle except the one telemetry already draws */}
      {fleet.map((v, i) => {
        if (v.vehicleId === selectedVehicle) return null;
        if (v.position.lat === 0 && v.position.lon === 0) return null;
        const q = pj(v.position.lat, v.position.lon);
        const color = VEHICLE_COLORS[i % VEHICLE_COLORS.length];
        return (
          <g key={`veh-${v.vehicleId}`}>
            <circle cx={q.x} cy={q.y} r={fs * 0.5} fill={color} fillOpacity={0.75} stroke="#0b0d11" strokeWidth={0.6} />
            <text x={q.x + fs * 0.8} y={q.y - fs * 0.5} fontSize={fs * 0.72} fill={color} fontFamily="var(--font-mono)">
              {v.vehicleId}
            </text>
          </g>
        );
      })}

      {/* followed vehicle */}
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

/** The flight tube itself: legs stroked at twice their lateral tolerance and
 *  orbit rings stroked at twice their radial tolerance, in map metres. */
function CorridorBand({
  corridor, project: pj, color, dim,
}: {
  corridor: Corridor;
  project: (lat: number, lon: number) => XY;
  color: string;
  dim: boolean;
}): React.ReactElement {
  const fill = dim ? 0.07 : 0.14;
  return (
    <g>
      {corridor.legs.map((leg, i) => {
        const a = pj(leg.from.lat, leg.from.lon);
        const b = pj(leg.to.lat, leg.to.lon);
        return (
          <line
            key={`leg-${i}`}
            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke={color} strokeOpacity={fill}
            strokeWidth={leg.lateral_tol_m * 2} strokeLinecap="round"
          />
        );
      })}
      {corridor.orbits.map((orbit, i) => {
        const c = pj(orbit.center.lat, orbit.center.lon);
        return (
          <circle
            key={`orbit-${i}`}
            cx={c.x} cy={c.y} r={orbit.radius_m}
            fill="none" stroke={color} strokeOpacity={fill}
            strokeWidth={orbit.radial_tol_m * 2}
          />
        );
      })}
    </g>
  );
}

function centroid(pts: XY[]): XY {
  const x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const y = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return { x, y };
}

/* ---- overlay legend ------------------------------------------------------ */

function Legend({ metersAcross, corridor }: { metersAcross: number; corridor: boolean }): React.ReactElement {
  const rows: Array<[string, string, boolean]> = [
    ['#ffc24b', 'Vehicle / anomaly', false],
    ['rgba(47,129,247,0.8)', 'Perimeter fence', true],
    ['rgba(240,68,56,0.8)', 'No-fly zone', false],
    ['rgba(90,160,255,0.9)', 'Planned route', true],
    ...(corridor ? [['rgba(90,160,255,0.45)', 'Corridor tolerance', false] as [string, string, boolean]] : []),
    ['rgba(196,204,214,0.9)', 'Staging point', false],
    ['rgba(170,118,255,0.8)', 'Clutter / LiDAR', true],
    ['#58d68d', 'Peer vehicle', false],
    ['#ff3b30', 'Hostile RF / pilot', false],
  ];
  return (
    <div
      style={{
        position: 'absolute', left: 8, right: 8, bottom: 8,
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 12px',
        padding: '5px 8px',
        background: 'rgba(8,12,16,0.72)',
        backdropFilter: 'blur(6px)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-sm)',
        zIndex: 5,
      }}
    >
      {rows.map(([color, label, dash]) => (
        <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
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
      <div style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-disabled)', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>
        {Math.round(metersAcross)} m across · 50 m grid
      </div>
    </div>
  );
}
