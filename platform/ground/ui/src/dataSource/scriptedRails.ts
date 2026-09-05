/* ============================================================================
 * SCRIPTED DEMO RAILS — ground-side stand-ins for producers that do not exist
 * yet on the vehicle/planner side.
 * ----------------------------------------------------------------------------
 * WHAT THIS IS
 *   Phase 3 needs four things the seam does not yet deliver:
 *     1. `MissionPlan.corridor`   — the flight tube a verified plan may occupy.
 *     2. `MissionPlan.planTrace`  — the ordered rule record behind the plan.
 *     3. `attended` verification check      (ADR D23 · UNATTENDED_ENVELOPE).
 *     4. `deconfliction` check + `holdUntil` (ADR D21 · separation).
 *   Both are declared OPTIONAL in the frozen contract, and `ground/planner`
 *   emits neither today (its deterministic planner is `ScriptedPlanner`, and
 *   `verifyMission` has no attendance/separation checks). This module derives
 *   them from what the REAL planner and verifier already produced.
 *
 * WHAT THIS IS NOT
 *   It is NOT a second planner. It never chooses a route, an altitude, a tool,
 *   a profile or a coordinate: every geometric input here comes out of a plan
 *   the deterministic planner already emitted, or out of the loaded site model.
 *   Corridor derivation is a mechanical projection of `plan.tools`; the trace
 *   is a reason-for-record (no coordinates, tools or altitudes, per contract).
 *
 * WHEN `ground/planner` GAINS `corridor` / `planTrace` AND THE VERIFIER GAINS
 * `attended` / `deconfliction`, DELETE THIS FILE and pass the producer's own
 * values through unchanged. Consumers already read `plan.corridor`,
 * `plan.planTrace` and `verification.checks` and nothing else.
 * ========================================================================== */
import type {
  AttendanceMode,
  Corridor,
  CorridorLeg,
  CorridorOrbit,
  MissionPlan,
  MissionProfile,
  PlanTraceEntry,
  Task,
  Verification,
  VerificationCheck,
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

/** Inter-vehicle separation, metres (D21). Doubles when peer data is stale. */
export const SEPARATION_M = 40;
export const SEPARATION_STALE_M = 80;
/** Peer data older than this is stale; older than HOLD_AGE_MS, the answer is hold. */
export const SEPARATION_STALE_AGE_MS = 3000;
export const SEPARATION_HOLD_AGE_MS = 10000;

/** How long a deconfliction hold defers dispatch, ms. */
export const DECONFLICTION_HOLD_MS = 20000;

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

/**
 * Departure/return clearance around the launch point, metres. Two vehicles
 * that share a pad necessarily share the first and last stretch of their
 * corridors; that overlap is sequenced by the pad, not by corridor separation,
 * so it is excluded from the comparison. Everything beyond it is compared.
 */
export const PAD_CLEARANCE_M = 60;

/** Minimum separation between two corridors, metres (sampled along the legs). */
export function corridorSeparationM(a: Corridor, b: Corridor): number {
  const ref: LatLon = a.legs[0]?.from ?? a.orbits[0]?.center ?? { lat: 0, lon: 0 };
  const padOf = (c: Corridor): XY | null =>
    c.legs[0] ? toXY(ref, c.legs[0].from) : null;
  const pads = [padOf(a), padOf(b)].filter((p): p is XY => p !== null);
  const nearAPad = (p: XY): boolean =>
    pads.some((pad) => Math.hypot(p.x - pad.x, p.y - pad.y) <= PAD_CLEARANCE_M);

  const samples = (c: Corridor): XY[] => {
    const out: XY[] = [];
    for (const leg of c.legs) {
      const from = toXY(ref, leg.from);
      const to = toXY(ref, leg.to);
      for (let i = 0; i <= 20; i += 1) {
        out.push({ x: from.x + ((to.x - from.x) * i) / 20, y: from.y + ((to.y - from.y) * i) / 20 });
      }
    }
    for (const orbit of c.orbits) {
      const centre = toXY(ref, orbit.center);
      for (let i = 0; i < 16; i += 1) {
        const th = (i / 16) * Math.PI * 2;
        out.push({ x: centre.x + orbit.radius_m * Math.cos(th), y: centre.y + orbit.radius_m * Math.sin(th) });
      }
    }
    return out.filter((p) => !nearAPad(p));
  };
  const sa = samples(a);
  const sb = samples(b);
  if (sa.length === 0 || sb.length === 0) return Number.POSITIVE_INFINITY;
  let min = Number.POSITIVE_INFINITY;
  for (const pa of sa) {
    for (const pb of sb) {
      const d = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      if (d < min) min = d;
    }
  }
  return min;
}

/* ---------------------------------------------------------------------------
 * The two checks the verifier does not produce yet.
 * ------------------------------------------------------------------------- */
export interface AttendanceInput {
  mode: AttendanceMode;
  operatorPresent: boolean;
  plan: MissionPlan;
  site: SiteModel;
  navSourceIsGps: boolean;
  rfInterference: boolean;
  hostileDrone: boolean;
  nightWithoutThermal: boolean;
  windMps?: number;
}

/** `attended` — does the mission's attendance mode permit this dispatch? */
export function attendedCheck(input: AttendanceInput): VerificationCheck {
  const name = 'attended';
  if (input.mode === 'attended') {
    return input.operatorPresent
      ? { name, ok: true, reason: 'operator is on the loop; attended dispatch permitted' }
      : { name, ok: false, reason: 'operator is not present and the mission is attended — approval has expired' };
  }

  // Unattended: every condition of ADR D23's UNATTENDED_ENVELOPE must hold.
  const refusals: string[] = [];
  if (!UNATTENDED_ENVELOPE.profiles.includes(input.plan.profile)) {
    refusals.push(`profile ${input.plan.profile} is outside the unattended envelope (inspect only)`);
  }
  if (!input.navSourceIsGps) refusals.push('navigation source is not GPS');
  if (input.rfInterference) refusals.push('RF interference present — GNSS integrity unverifiable');
  if (input.hostileDrone) refusals.push('hostile drone detected — airspace is yielded, never contested');
  if (input.nightWithoutThermal) refusals.push('night operation without healthy thermal');
  if (input.windMps !== undefined && input.windMps > UNATTENDED_ENVELOPE.maxWindMps) {
    refusals.push(`wind ${input.windMps.toFixed(1)} m/s exceeds the ${UNATTENDED_ENVELOPE.maxWindMps} m/s unattended limit`);
  }

  for (const tool of input.plan.tools) {
    if (tool.tool === 'goto_gps') {
      const alt = tool.alt_m ?? tool.alt;
      if (alt < UNATTENDED_ENVELOPE.altMinM || alt > UNATTENDED_ENVELOPE.altMaxM) {
        refusals.push(`a leg leaves the ${UNATTENDED_ENVELOPE.altMinM}–${UNATTENDED_ENVELOPE.altMaxM} m unattended altitude band`);
      }
      if (!pointInPolygon({ lat: tool.lat, lon: tool.lon }, input.site.perimeter)) {
        refusals.push('a waypoint lies outside the site perimeter');
      }
    } else if (tool.tool === 'orbit_point') {
      if ((tool.laps ?? 1) > UNATTENDED_ENVELOPE.maxLaps) {
        refusals.push(`more than ${UNATTENDED_ENVELOPE.maxLaps} orbit lap`);
      }
    } else if (tool.tool === 'hold') {
      const held = tool.duration_s ?? tool.durationS ?? 0;
      if (held > UNATTENDED_ENVELOPE.maxHoldS) {
        refusals.push(`hold of ${held} s exceeds the ${UNATTENDED_ENVELOPE.maxHoldS} s unattended limit`);
      }
    }
  }

  const unique = [...new Set(refusals)];
  return unique.length === 0
    ? { name, ok: true, reason: 'inside UNATTENDED_ENVELOPE; unattended dispatch permitted' }
    : { name, ok: false, reason: `outside UNATTENDED_ENVELOPE: ${unique.join('; ')}` };
}

export interface DeconflictionInput {
  corridor?: Corridor;
  peerCorridor?: Corridor;
  /** Epoch ms of the newest peer fleet row; omitted when there is no peer. */
  peerDataTs?: number;
  now: number;
}

export interface DeconflictionResult {
  check: VerificationCheck;
  /** Epoch ms before which dispatch must not happen, when a wait was applied. */
  holdUntil?: number;
}

/** `deconfliction` — no other vehicle's corridor conflicts in space and time. */
export function deconflictionCheck(input: DeconflictionInput): DeconflictionResult {
  const name = 'deconfliction';
  if (!input.corridor || !input.peerCorridor) {
    return { check: { name, ok: true, reason: 'no other vehicle holds a cleared corridor' } };
  }
  const age = input.peerDataTs === undefined ? Number.POSITIVE_INFINITY : input.now - input.peerDataTs;
  if (age > SEPARATION_HOLD_AGE_MS) {
    return {
      check: {
        name, ok: false,
        reason: `peer telemetry is ${(age / 1000).toFixed(0)} s old — a stale peer position is an unknown peer position`,
      },
    };
  }
  const required = age > SEPARATION_STALE_AGE_MS ? SEPARATION_STALE_M : SEPARATION_M;
  const separation = corridorSeparationM(input.corridor, input.peerCorridor);
  if (separation >= required) {
    return {
      check: {
        name, ok: true,
        reason: `closest approach to the peer corridor is ${separation.toFixed(0)} m (${required} m required)`,
      },
    };
  }
  const holdUntil = input.now + DECONFLICTION_HOLD_MS;
  return {
    holdUntil,
    check: {
      name, ok: true,
      reason: `closest approach to the peer corridor is ${separation.toFixed(0)} m, below the ${required} m separation`,
      edit: `dispatch held for ${(DECONFLICTION_HOLD_MS / 1000).toFixed(0)} s until the peer corridor clears`,
    },
  };
}

/**
 * Fold the two scripted checks into a verification the REAL verifier produced.
 * A failing check can only ever make the verdict stricter, never looser.
 */
export function withAttendanceChecks(
  verification: Verification,
  attendance: AttendanceInput,
  deconfliction: DeconflictionInput,
): Verification {
  const attended = attendedCheck(attendance);
  const decon = deconflictionCheck(deconfliction);
  const checks = [
    ...verification.checks.filter((c) => c.name !== 'attended' && c.name !== 'deconfliction'),
    attended,
    decon.check,
  ];
  const failed = checks.some((c) => !c.ok);
  const verdict: Verification['verdict'] = verification.verdict === 'rejected' || failed
    ? 'rejected'
    : decon.holdUntil
      ? 'corrected'
      : verification.verdict;
  return {
    ...verification,
    checks,
    verdict,
    ...(decon.holdUntil && verdict !== 'rejected' ? { holdUntil: decon.holdUntil } : {}),
  };
}
