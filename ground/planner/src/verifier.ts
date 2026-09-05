/* ============================================================================
 * eis-planner/verifier — deterministic MissionVerifier.
 *
 * verifyMission(plan, site, telemetrySnapshot?) -> Verification (contract type)
 *
 * PURE + DETERMINISTIC: the verdict is a function of exactly (plan, site,
 * telemetrySnapshot). No Date, no randomness, no I/O. `requestId` is passed
 * through from the plan unchanged. Same inputs -> byte-identical output.
 *
 * Checks (each a named VerificationCheck with ok + reason, `edit` set when a
 * correction was applied for that check):
 *  - geofence : every goto/orbit target inside the perimeter AND every leg
 *               segment (including the first leg from home and any RTL leg
 *               back to home) stays inside the perimeter.
 *  - nfz      : no target inside an NFZ at/below its ceiling, and no leg
 *               segment crosses an NFZ polygon while at/below the ceiling.
 *               A leg's altitude is taken as the MAX of its endpoint
 *               altitudes, per spec.
 *  - altitude : every commanded altitude within site alt_band_m (AGL).
 *  - battery  : total path length / profile speed = flight seconds; the
 *               battery must cover drain + reserve (constants below).
 *
 * Corrections (verdict 'corrected', correctedPlan set):
 *  - out-of-band altitudes are clamped into [alt_band.min, alt_band.max];
 *  - a target inside an NFZ (at/below ceiling) is moved to the nearest point
 *    OUTSIDE the polygon plus CORRECTION_MARGIN_M;
 *  - a target outside the perimeter is moved to the nearest point INSIDE the
 *    perimeter minus CORRECTION_MARGIN_M.
 *  The corrected plan is re-checked; if it still fails (e.g. a leg
 *  unavoidably crosses an NFZ, or the battery is insufficient — battery is
 *  never correctable) the verdict is 'rejected'.
 * ========================================================================== */

import {
  MissionPlan,
  PlanTool,
  Verification,
  VerificationCheck,
  PROFILE_SPEED_MPS,
} from './contract';
import {
  LatLon,
  SiteModel,
  haversineMeters,
  movePointAcrossBoundary,
  pointInPolygon,
  segmentIntersectsPolygon,
  segmentStaysInsidePolygon,
} from './site';

/* ---------------------------------------------------------------------------
 * Documented constants
 * ------------------------------------------------------------------------- */

/**
 * Battery drain, percent per second of flight. 0.08 %/s empties a full
 * battery in ~21 minutes — a conservative model for a small quad cruising.
 */
export const DRAIN_PCT_PER_S = 0.08;

/**
 * Reserve that must remain UNTOUCHED by the planned flight, percent.
 * Covers RTL headroom, wind, and estimation error.
 */
export const RESERVE_PCT = 25;

/**
 * Battery percentage assumed when no telemetry snapshot is provided.
 * Deliberately conservative (roughly half charge) so a plan verified without
 * live telemetry is never more permissive than one verified with it.
 */
export const DEFAULT_BATTERY_PCT = 60;

/** Margin, meters, applied when moving a target across a polygon boundary. */
export const CORRECTION_MARGIN_M = 5;

/**
 * Seconds charged against the battery for a `hold` with no durationS
 * (contract: omitted = indefinite). The verifier cannot budget "indefinite",
 * so it charges this documented conservative stand-in.
 */
export const INDEFINITE_HOLD_S = 30;

/**
 * Altitude (AGL) assumed for a tool that inherits altitude before any
 * goto_gps has set one (e.g. a plan that opens with orbit_point): the bottom
 * of the site alt band — the lowest legal altitude, i.e. the conservative
 * choice for NFZ ceiling checks.
 */
function inheritedStartAlt(site: SiteModel): number {
  return site.altBandM.min;
}

/** Minimal telemetry slice the verifier reads. A full contract `Telemetry`
 *  frame is structurally assignable to this. */
export interface TelemetrySnapshot {
  battery: { remaining: number };
}

/* ---------------------------------------------------------------------------
 * Plan walk: derive targets, legs, and flight time from the tool list
 * ------------------------------------------------------------------------- */

interface Target {
  toolIndex: number;
  kind: 'goto_gps' | 'orbit_point';
  pos: LatLon;
  altM: number;
}

interface Leg {
  toolIndex: number;
  from: LatLon;
  to: LatLon;
  /** max of endpoint altitudes (spec: conservative NFZ altitude for the leg). */
  maxAltM: number;
  lengthM: number;
  speedMps: number;
}

interface Walk {
  targets: Target[];
  legs: Leg[];
  totalPathM: number;
  totalFlightS: number;
}

function walkPlan(plan: MissionPlan, site: SiteModel): Walk {
  const targets: Target[] = [];
  const legs: Leg[] = [];
  let totalPathM = 0;
  let totalFlightS = 0;

  const home: LatLon = { lat: site.home.lat, lon: site.home.lon };
  let cur: LatLon = home;
  /** null = still on the ground at home (no commanded altitude yet). */
  let curAlt: number | null = null;
  const planSpeed = PROFILE_SPEED_MPS[plan.profile];

  const addLeg = (toolIndex: number, to: LatLon, toAlt: number, speedMps: number) => {
    // The climb-out happens at the departure point, so a leg departing the
    // ground is treated as flown at the destination altitude.
    const maxAltM = curAlt === null ? toAlt : Math.max(curAlt, toAlt);
    const lengthM = haversineMeters(cur, to);
    legs.push({ toolIndex, from: cur, to, maxAltM, lengthM, speedMps });
    totalPathM += lengthM;
    totalFlightS += speedMps > 0 ? lengthM / speedMps : 0;
    cur = to;
    curAlt = toAlt;
  };

  plan.tools.forEach((tool: PlanTool, i: number) => {
    switch (tool.tool) {
      case 'goto_gps': {
        const speed = PROFILE_SPEED_MPS[tool.profile ?? plan.profile];
        const to = { lat: tool.lat, lon: tool.lon };
        addLeg(i, to, tool.alt, speed);
        targets.push({ toolIndex: i, kind: 'goto_gps', pos: to, altM: tool.alt });
        break;
      }
      case 'orbit_point': {
        const alt = curAlt ?? inheritedStartAlt(site);
        const center = { lat: tool.lat, lon: tool.lon };
        addLeg(i, center, alt, planSpeed);
        targets.push({ toolIndex: i, kind: 'orbit_point', pos: center, altM: alt });
        const circumferenceM = 2 * Math.PI * Math.max(0, tool.radius);
        totalPathM += circumferenceM;
        totalFlightS += planSpeed > 0 ? circumferenceM / planSpeed : 0;
        break;
      }
      case 'hold': {
        totalFlightS += tool.durationS ?? INDEFINITE_HOLD_S;
        break;
      }
      case 'rtl': {
        const alt = curAlt ?? inheritedStartAlt(site);
        addLeg(i, home, alt, planSpeed);
        curAlt = null; // landed
        break;
      }
    }
  });

  return { targets, legs, totalPathM, totalFlightS };
}

/* ---------------------------------------------------------------------------
 * Checks (evaluated against an already-walked plan)
 * ------------------------------------------------------------------------- */

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function checkGeofence(walk: Walk, site: SiteModel): VerificationCheck {
  const failures: string[] = [];
  for (const t of walk.targets) {
    if (!pointInPolygon(t.pos, site.perimeter)) {
      failures.push(`${t.kind} target (tool ${t.toolIndex}) is outside the perimeter`);
    }
  }
  for (const leg of walk.legs) {
    if (leg.lengthM === 0) continue;
    if (!segmentStaysInsidePolygon(leg.from, leg.to, site.perimeter)) {
      failures.push(`leg to tool ${leg.toolIndex} leaves the perimeter`);
    }
  }
  return failures.length === 0
    ? {
        name: 'geofence',
        ok: true,
        reason: `all ${walk.targets.length} target(s) and ${walk.legs.length} leg(s) stay inside the perimeter`,
      }
    : { name: 'geofence', ok: false, reason: failures.join('; ') };
}

function checkNfz(walk: Walk, site: SiteModel): VerificationCheck {
  const failures: string[] = [];
  for (const zone of site.nfz) {
    for (const t of walk.targets) {
      if (t.altM <= zone.ceilingM && pointInPolygon(t.pos, zone.polygon)) {
        failures.push(
          `${t.kind} target (tool ${t.toolIndex}) is inside NFZ "${zone.name}" at ` +
          `${fmt(t.altM)} m (ceiling ${fmt(zone.ceilingM)} m)`,
        );
      }
    }
    for (const leg of walk.legs) {
      if (leg.lengthM === 0) continue;
      if (leg.maxAltM <= zone.ceilingM &&
          segmentIntersectsPolygon(leg.from, leg.to, zone.polygon)) {
        failures.push(
          `leg to tool ${leg.toolIndex} crosses NFZ "${zone.name}" at ` +
          `${fmt(leg.maxAltM)} m (ceiling ${fmt(zone.ceilingM)} m)`,
        );
      }
    }
  }
  return failures.length === 0
    ? {
        name: 'nfz',
        ok: true,
        reason: site.nfz.length === 0
          ? 'site has no NFZs'
          : `no target or leg enters any of the ${site.nfz.length} NFZ(s) at/below its ceiling`,
      }
    : { name: 'nfz', ok: false, reason: failures.join('; ') };
}

function checkAltitude(walk: Walk, site: SiteModel): VerificationCheck {
  const { min, max } = site.altBandM;
  const failures: string[] = [];
  for (const t of walk.targets) {
    if (t.altM < min || t.altM > max) {
      failures.push(
        `${t.kind} target (tool ${t.toolIndex}) altitude ${fmt(t.altM)} m is outside ` +
        `the site alt band [${fmt(min)}, ${fmt(max)}] m AGL`,
      );
    }
  }
  return failures.length === 0
    ? {
        name: 'altitude',
        ok: true,
        reason: `all altitudes within the site alt band [${fmt(min)}, ${fmt(max)}] m AGL`,
      }
    : { name: 'altitude', ok: false, reason: failures.join('; ') };
}

function checkBattery(walk: Walk, telemetry?: TelemetrySnapshot): VerificationCheck {
  const availablePct = telemetry?.battery.remaining ?? DEFAULT_BATTERY_PCT;
  const drainPct = walk.totalFlightS * DRAIN_PCT_PER_S;
  const requiredPct = drainPct + RESERVE_PCT;
  const detail =
    `path ${fmt(walk.totalPathM)} m, flight ${fmt(walk.totalFlightS)} s, drain ` +
    `${drainPct.toFixed(1)}% + reserve ${fmt(RESERVE_PCT)}% = ${requiredPct.toFixed(1)}% ` +
    `required vs ${fmt(availablePct)}% available` +
    (telemetry ? '' : ` (no telemetry — assumed ${fmt(DEFAULT_BATTERY_PCT)}%)`);
  return availablePct >= requiredPct
    ? { name: 'battery', ok: true, reason: detail }
    : { name: 'battery', ok: false, reason: `insufficient battery: ${detail}` };
}

function runChecks(plan: MissionPlan, site: SiteModel, telemetry?: TelemetrySnapshot): VerificationCheck[] {
  const walk = walkPlan(plan, site);
  return [
    checkGeofence(walk, site),
    checkNfz(walk, site),
    checkAltitude(walk, site),
    checkBattery(walk, telemetry),
  ];
}

/* ---------------------------------------------------------------------------
 * Corrections
 * ------------------------------------------------------------------------- */

interface CorrectionResult {
  plan: MissionPlan;
  /** edit descriptions keyed by check name; empty = nothing was correctable. */
  edits: Map<string, string[]>;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Build a corrected copy of the plan, in this deterministic order:
 *  1. clamp goto altitudes into the alt band;
 *  2. (using post-clamp altitudes) move any goto/orbit target that sits
 *     inside an NFZ at/below its ceiling to just outside the polygon;
 *  3. move any goto/orbit target outside the perimeter to just inside it.
 * Battery and leg-crossing failures have no direct correction.
 */
function buildCorrectedPlan(plan: MissionPlan, site: SiteModel): CorrectionResult {
  const edits = new Map<string, string[]>();
  const note = (check: string, text: string) => {
    const list = edits.get(check) ?? [];
    list.push(text);
    edits.set(check, list);
  };

  const { min, max } = site.altBandM;
  let curAlt: number | null = null;

  const tools: PlanTool[] = plan.tools.map((tool, i) => {
    if (tool.tool === 'goto_gps') {
      let t = { ...tool };
      // 1. altitude clamp
      if (t.alt < min || t.alt > max) {
        const clamped = Math.min(max, Math.max(min, t.alt));
        note('altitude', `clamped tool ${i} altitude ${fmt(t.alt)} m into the alt band -> ${fmt(clamped)} m`);
        t = { ...t, alt: clamped };
      }
      curAlt = t.alt;
      t = correctTargetPosition(t, i, t.alt, site, note);
      return t;
    }
    if (tool.tool === 'orbit_point') {
      const alt = curAlt ?? inheritedStartAlt(site);
      return correctTargetPosition({ ...tool }, i, alt, site, note);
    }
    return tool;
  });

  return {
    plan: { ...plan, tools },
    edits,
  };
}

function correctTargetPosition<T extends { lat: number; lon: number }>(
  tool: T,
  index: number,
  altM: number,
  site: SiteModel,
  note: (check: string, text: string) => void,
): T {
  let pos: LatLon = { lat: tool.lat, lon: tool.lon };
  let changed = false;

  // 2. NFZ push-out (only zones whose ceiling forbids this altitude)
  for (const zone of site.nfz) {
    if (altM <= zone.ceilingM && pointInPolygon(pos, zone.polygon)) {
      const moved = movePointAcrossBoundary(pos, zone.polygon, CORRECTION_MARGIN_M);
      note('nfz',
        `moved tool ${index} target out of NFZ "${zone.name}" ` +
        `(${CORRECTION_MARGIN_M} m clear of its boundary)`);
      pos = moved;
      changed = true;
    }
  }

  // 3. perimeter pull-in
  if (!pointInPolygon(pos, site.perimeter)) {
    const moved = movePointAcrossBoundary(pos, site.perimeter, CORRECTION_MARGIN_M);
    note('geofence',
      `moved tool ${index} target inside the perimeter ` +
      `(${CORRECTION_MARGIN_M} m clear of its boundary)`);
    pos = moved;
    changed = true;
  }

  if (!changed) return tool;
  return { ...tool, lat: round6(pos.lat), lon: round6(pos.lon) };
}

/* ---------------------------------------------------------------------------
 * Entry point
 * ------------------------------------------------------------------------- */

/**
 * Deterministically verify a MissionPlan against the site model.
 * See the module header for check + correction semantics.
 */
export function verifyMission(
  plan: MissionPlan,
  site: SiteModel,
  telemetry?: TelemetrySnapshot,
): Verification {
  const originalChecks = runChecks(plan, site, telemetry);
  if (originalChecks.every((c) => c.ok)) {
    return { requestId: plan.requestId, verdict: 'pass', checks: originalChecks };
  }

  const { plan: correctedPlan, edits } = buildCorrectedPlan(plan, site);
  const withEdits: VerificationCheck[] = originalChecks.map((c) => {
    const e = edits.get(c.name);
    return e && e.length > 0 ? { ...c, edit: e.join('; ') } : c;
  });

  const anyEdit = edits.size > 0;
  if (anyEdit) {
    const recheck = runChecks(correctedPlan, site, telemetry);
    if (recheck.every((c) => c.ok)) {
      return {
        requestId: plan.requestId,
        verdict: 'corrected',
        checks: withEdits,
        correctedPlan,
      };
    }
  }

  return { requestId: plan.requestId, verdict: 'rejected', checks: withEdits };
}
