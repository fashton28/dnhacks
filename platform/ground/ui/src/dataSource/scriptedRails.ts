/* ============================================================================
 * SCRIPTED DEMO RAILS — ground-side stand-ins for producers that do not exist
 * yet on the vehicle/planner side.
 * ----------------------------------------------------------------------------
 * WHAT THIS IS, NOW
 *   Two of the four things this file once supplied have real producers, and the
 *   stand-ins for them are DELETED (FM-181):
 *
 *     1. `MissionPlan.corridor`   — still derived here, for one plan only.
 *     2. `MissionPlan.planTrace`  — still derived here, for one plan only.
 *     3. `attended` check         — REMOVED: `verifier.ts` emits it from the
 *                                   attendance mode in the runtime context.
 *     4. `deconfliction` + `holdUntil` — REMOVED: `verifier.ts` emits both from
 *                                   the fleet and `fleetTs` in that context.
 *
 *   Folding scripted copies of 3 and 4 in over the verifier's own output
 *   REPLACED the real verdict with a re-derivation of it, which is a second
 *   opinion wearing the first one's name. The deterministic planner emits its
 *   own corridor and trace, so `withCorridorAndTrace` is a no-op for its output
 *   and dresses only the deliberately-invalid scripted plan the verifier must
 *   refuse (docs/DEMO_RUNBOOK.md R1).
 *
 * WHAT THIS IS NOT
 *   It is NOT a second planner. It never chooses a route, an altitude, a tool,
 *   a profile or a coordinate: every geometric input here comes out of a plan
 *   the planner already emitted, or out of the loaded site model. Corridor
 *   derivation is a mechanical projection of `plan.tools`; the trace is a
 *   reason-for-record (no coordinates, tools or altitudes, per contract).
 *
 * WHEN THE SCRIPTED BAD-PLAN RAIL GAINS A REAL PRODUCER, DELETE THIS FILE.
 * Consumers already read `plan.corridor`, `plan.planTrace` and
 * `verification.checks` and nothing else.
 * ========================================================================== */
import type {
  Corridor,
  CorridorLeg,
  CorridorOrbit,
  MissionPlan,
  MissionProfile,
  PlanTraceEntry,
  Task,
} from '@/contract';
import type { LatLon, SiteModel } from '@planner/site';
import {
  M_PER_DEG_LAT,
  haversineMeters,
  pointInPolygon,
  segmentIntersectsPolygon,
} from '@planner/site';
import { HARD_MIN_STANDOFF_M } from '@planner/verifier';

/* ---------------------------------------------------------------------------
 * Tolerances — ADR D21. Survey is looser than inspect because a survey pattern
 * is flown further from what it observes; the orbit's radial tolerance is the
 * tightest because radius trades directly against standoff.
 * ------------------------------------------------------------------------- */
export const LATERAL_TOL_M: Record<MissionProfile, number> = {
  inspect: 10,
  standard: 10,
  follow: 10,
  slow: 10,
  survey: 15,
  fast: 15,
};

export const ORBIT_RADIAL_TOL_M = 5;

/**
 * ADR D23 — UNATTENDED_ENVELOPE. The authority for these numbers is the
 * companion's `config.py` hard floor; this copy exists so the ground station
 * can EXPLAIN a refusal, and it may only ever be as tight or tighter.
 */
export const UNATTENDED_ENVELOPE = {
  /** `inspect` only (and its compatibility alias `standard`). */
  profiles: ['inspect', 'standard'] as MissionProfile[],
  altMinM: 30,
  altMaxM: 50,
  maxLaps: 1,
  maxHoldS: 15,
  maxWindMps: 6,
} as const;

/* ---------------------------------------------------------------------------
 * Local metre projection (equirectangular about a reference point). Accurate
 * well inside plant scale, which is how every other geometry consumer in this
 * repo projects (see eis-planner/site).
 * ------------------------------------------------------------------------- */
interface XY { x: number; y: number }

function toXY(ref: LatLon, p: LatLon): XY {
  const cosLat = Math.cos((ref.lat * Math.PI) / 180);
  return {
    x: (p.lon - ref.lon) * M_PER_DEG_LAT * cosLat,
    y: (p.lat - ref.lat) * M_PER_DEG_LAT,
  };
}

function pointToSegmentM(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/* ---------------------------------------------------------------------------
 * Corridor derivation — a mechanical projection of the plan the deterministic
 * planner emitted. Waypoints come from `goto_gps` tools (plus home, and home
 * again on `rtl`); orbits come from `orbit_point`.
 * ------------------------------------------------------------------------- */
export function corridorFor(plan: MissionPlan, site: SiteModel): Corridor {
  const home: LatLon = { lat: site.home.lat, lon: site.home.lon };
  const points: LatLon[] = [home];
  const orbits: CorridorOrbit[] = [];
  const alts: number[] = [];

  for (const tool of plan.tools) {
    if (tool.tool === 'goto_gps') {
      points.push({ lat: tool.lat, lon: tool.lon });
      alts.push(tool.alt_m ?? tool.alt);
    } else if (tool.tool === 'orbit_point') {
      orbits.push({
        center: { lat: tool.lat, lon: tool.lon },
        radius_m: tool.radius_m ?? tool.radius,
        radial_tol_m: ORBIT_RADIAL_TOL_M,
      });
    } else if (tool.tool === 'rtl') {
      points.push(home);
    }
  }

  const legs: CorridorLeg[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    if (haversineMeters(from, to) < 1) continue;
    legs.push({ from, to, lateral_tol_m: LATERAL_TOL_M[plan.profile] ?? 10 });
  }

  // Altitude band: the commanded altitudes with the site band as the hard
  // outer bound. The corridor may only ever be tighter than the site allows.
  const band = site.altBandM;
  const lo = alts.length ? Math.min(...alts) : band.min;
  const hi = alts.length ? Math.max(...alts) : band.max;
  return {
    legs,
    orbits,
    alt_band_m: {
      min: Math.max(band.min, lo - 5),
      max: Math.min(band.max, hi + 5),
    },
    generated_from: plan.requestId,
  };
}

/* ---------------------------------------------------------------------------
 * Plan trace — the ordered record of the rules that shaped the plan (ADR D20).
 * A trace is a reason-for-record ONLY: per the contract it carries no
 * coordinates, no tools and no altitudes, so every effect below is phrased
 * without them.
 * ------------------------------------------------------------------------- */
export function planTraceFor(
  plan: MissionPlan,
  site: SiteModel,
  task?: Task | null,
): PlanTraceEntry[] {
  const trace: PlanTraceEntry[] = [];

  trace.push({
    rule: 'profile',
    effect: task
      ? `selected the ${plan.profile} profile for a ${task.lookFor.replace('_', ' ')} task`
      : `selected the ${plan.profile} profile`,
  });

  trace.push({
    rule: 'altitude',
    effect: 'took the middle of the profile band intersected with the site altitude band',
  });

  const home: LatLon = { lat: site.home.lat, lon: site.home.lon };
  const waypoints: LatLon[] = [home];
  for (const tool of plan.tools) {
    if (tool.tool === 'goto_gps') waypoints.push({ lat: tool.lat, lon: tool.lon });
  }
  const crossesNfz = site.nfz.some((zone) => {
    for (let i = 1; i < waypoints.length; i += 1) {
      if (segmentIntersectsPolygon(waypoints[i - 1], waypoints[i], zone.polygon)) return true;
    }
    return false;
  });
  const outsidePerimeter = waypoints.some((p) => !pointInPolygon(p, site.perimeter));
  trace.push({
    rule: 'route',
    effect: crossesNfz
      ? `straight legs cross a no-fly zone buffered by ${site.nfzBufferM} m — the verifier must correct or refuse`
      : outsidePerimeter
        ? 'a leg leaves the perimeter geofence — the verifier must correct or refuse'
        : `straight legs clear every no-fly zone buffered by ${site.nfzBufferM} m and stay inside the geofence`,
  });

  const orbit = plan.tools.find((t) => t.tool === 'orbit_point');
  if (orbit && orbit.tool === 'orbit_point') {
    const radius = orbit.radius_m ?? orbit.radius;
    trace.push({
      rule: 'orbit',
      effect: radius >= HARD_MIN_STANDOFF_M
        ? `observation radius holds at or above the ${HARD_MIN_STANDOFF_M} m standoff floor`
        : `observation radius is below the ${HARD_MIN_STANDOFF_M} m standoff floor — infeasible`,
    });
    trace.push({ rule: 'laps', effect: `${orbit.laps ?? 1} lap` });
  }

  const hold = plan.tools.find((t) => t.tool === 'hold');
  trace.push({
    rule: 'hold',
    effect: hold && hold.tool === 'hold'
      ? `held on station for ${hold.duration_s ?? hold.durationS ?? 0} s`
      : 'no hold — this task does not need one',
  });

  trace.push({
    rule: 'terminal',
    effect: plan.tools.some((t) => t.tool === 'rtl')
      ? 'terminal action is return to launch'
      : 'no terminal action — the plan ends holding position',
  });

  const corridor = plan.corridor;
  if (corridor) {
    trace.push({
      rule: 'corridor',
      effect: `flight tube: ${corridor.legs.length} leg(s) at ±${LATERAL_TOL_M[plan.profile] ?? 10} m, ` +
        `${corridor.orbits.length} orbit(s) at ±${ORBIT_RADIAL_TOL_M} m`,
    });
  }

  return trace;
}

/** Attach the corridor + trace the producers do not emit yet, in one place. */
export function withCorridorAndTrace(
  plan: MissionPlan,
  site: SiteModel,
  task?: Task | null,
): MissionPlan {
  if (plan.corridor && plan.planTrace) return plan;
  const corridor = plan.corridor ?? corridorFor(plan, site);
  const withCorridor: MissionPlan = { ...plan, corridor };
  return { ...withCorridor, planTrace: plan.planTrace ?? planTraceFor(withCorridor, site, task) };
}

/* ---------------------------------------------------------------------------
 * Envelope geometry — how far inside (or outside) the flight tube a position
 * is. Pure: it reads a position and a corridor and nothing else, which is why
 * the monitor built on it shares no state with guidance.
 * ------------------------------------------------------------------------- */
export interface CorridorMargin {
  /** Signed metres: positive is inside the tube, negative is how far past it. */
  marginM: number;
  /** Tolerance of the closest corridor element, metres. */
  toleranceM: number;
  /** Which element bound the answer. */
  element: 'leg' | 'orbit' | 'none';
}

export function corridorMargin(pos: LatLon, corridor: Corridor): CorridorMargin {
  let best: CorridorMargin = { marginM: Number.NEGATIVE_INFINITY, toleranceM: 10, element: 'none' };
  const ref: LatLon = corridor.legs[0]?.from ?? corridor.orbits[0]?.center ?? pos;
  const p = toXY(ref, pos);

  for (const leg of corridor.legs) {
    const d = pointToSegmentM(p, toXY(ref, leg.from), toXY(ref, leg.to));
    const margin = leg.lateral_tol_m - d;
    if (margin > best.marginM) best = { marginM: margin, toleranceM: leg.lateral_tol_m, element: 'leg' };
  }
  for (const orbit of corridor.orbits) {
    const d = Math.abs(haversineMeters(pos, orbit.center) - orbit.radius_m);
    const margin = orbit.radial_tol_m - d;
    if (margin > best.marginM) best = { marginM: margin, toleranceM: orbit.radial_tol_m, element: 'orbit' };
  }
  if (best.element === 'none') return { marginM: 0, toleranceM: 10, element: 'none' };
  return best;
}

/**
 * Nearest point on the corridor to `pos`. This is what a monitor-commanded
 * back-off aims at after a breach ("hold, then back off" — ADR D22); it is
 * never a route and never reaches guidance as a setpoint.
 */
export function nearestCorridorPoint(pos: LatLon, corridor: Corridor): LatLon | null {
  const ref: LatLon = corridor.legs[0]?.from ?? corridor.orbits[0]?.center ?? pos;
  const cosLat = Math.cos((ref.lat * Math.PI) / 180);
  const back = (xy: XY): LatLon => ({
    lat: ref.lat + xy.y / M_PER_DEG_LAT,
    lon: ref.lon + xy.x / (M_PER_DEG_LAT * cosLat),
  });
  const p = toXY(ref, pos);
  let best: { d: number; xy: XY } | null = null;
  for (const leg of corridor.legs) {
    const a = toXY(ref, leg.from);
    const b = toXY(ref, leg.to);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
    const xy = { x: a.x + t * dx, y: a.y + t * dy };
    const d = Math.hypot(p.x - xy.x, p.y - xy.y);
    if (!best || d < best.d) best = { d, xy };
  }
  for (const orbit of corridor.orbits) {
    const c = toXY(ref, orbit.center);
    const vx = p.x - c.x;
    const vy = p.y - c.y;
    const len = Math.hypot(vx, vy) || 1;
    const xy = { x: c.x + (vx / len) * orbit.radius_m, y: c.y + (vy / len) * orbit.radius_m };
    const d = Math.hypot(p.x - xy.x, p.y - xy.y);
    if (!best || d < best.d) best = { d, xy };
  }
  return best ? back(best.xy) : null;
}

/* ---------------------------------------------------------------------------
 * The `attended` and `deconfliction` checks that used to live here are GONE
 * (FM-181). `verifier.ts` produces both itself now, from the fleet, the
 * attendance mode and `now` in the runtime context, and folding scripted
 * stand-ins in over the top REPLACED the real verifier's verdict with a
 * re-derivation of it — a second opinion masquerading as the first.
 *
 * The one thing the verifier cannot know is whether a HUMAN is at the console:
 * attendance mode is the vehicle's, operator presence is the ground station's.
 * That single rule is overlaid in `MockDataProvider.dressVerification`, where
 * it can only ever make a verdict stricter.
 *
 * What remains in this file is the corridor/trace derivation for the ONE plan
 * that still has no producer: the deliberately-invalid scripted plan the
 * verifier must refuse (docs/DEMO_RUNBOOK.md R1). When that beat gains a real
 * producer, delete this file.
 * ------------------------------------------------------------------------- */
