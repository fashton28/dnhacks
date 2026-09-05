/* ============================================================================
 * eis-planner/deterministic — the ONLY source of flight plans.
 *
 * A task (what to look for and why) plus the site model, the vehicle's
 * capabilities and its live state produce exactly one plan, or `infeasible`.
 * No model, no cue and no operator text influences a coordinate, an altitude,
 * a radius or a speed: this is the rule table from ADR D20, and it is the
 * defence against the luring attack in docs/THREAT_MODEL.md § A6.2.
 *
 * | Rule | Definition |
 * |---|---|
 * | Profile      | person/vehicle/fence_gap → inspect; structure → survey; unknown → inspect |
 * | Dispatch     | The state gates the verifier would refuse on are refused HERE, before a plan exists |
 * | Altitude     | Middle of (profile band ∩ site band ∩ unattended band when unattended); empty → infeasible |
 * | Route        | Straight leg, else the shortest via-point detour around buffered NFZs, else infeasible |
 * | Orbit        | Profile radius shrunk to clear NFZ + geofence, NEVER below standoff; else infeasible |
 * | Laps         | Exactly 1 |
 * | Hold         | 15 s, and only for `fence_gap` |
 * | Terminal     | `rtl` |
 * | Time budget  | min(live-SoC range time, sortie cap); over budget → trim holds/laps, else infeasible |
 * | Separation   | Altitude chosen clear of any peer corridor it would cross |
 * | Tie-break    | Lowest total detour, then the northernmost via-point |
 *
 * The planner NEVER emits a plan that violates a limit. A `corrected` verdict
 * on this planner's output is a bug in this file, not a save by the verifier —
 * `test/deterministic.test.ts` runs every verifier fixture's state through it
 * and asserts `pass` or `infeasible`, never `corrected`.
 *
 * `planTrace` carries the RULES THAT FIRED, never geometry: the contract says
 * a trace entry is reason-for-record only, so no entry below prints a
 * coordinate, an altitude or a radius. The plan itself is the geometry.
 * ========================================================================== */

import {
  Anomaly, Corridor, MissionPlan, MissionProfile, PlanTool, PlanTraceEntry, Task,
} from './contract';
import {
  LatLon, corridorGeometryFromWalk, haversineMeters, lateralSeparationM, legNeedsLidar,
  orbitEntryPoint, pointInOrOnPolygon, policyFor, rangeAvailableSeconds, round6, routeVias,
  shrinkOrbitRadius, timeBudgetSeconds, trimToBudget, verticalSeparationM, walkPlan,
  windAdjustedSeconds,
} from './geometry';
import {
  CORRIDOR_POLICY, DECONFLICTION_POLICY, PLANNER_POLICY, UNATTENDED_ENVELOPE, VERIFIER_POLICY,
  canonicalProfile,
} from './policy';
import { SiteModel } from './site';
import { VerificationContext, peerGeometry, requiredSeparationM, siteValidity } from './verifier';

export interface DeterministicPlanInput {
  task: Task;
  anomaly: Anomaly;
  site: SiteModel;
  /** The SAME runtime context the verifier will judge the plan with. */
  context: VerificationContext;
  /** Ground-side correlation id; defaults to a stable id derived from the task. */
  requestId?: string;
}

export interface PlannedMission {
  infeasible: false;
  plan: MissionPlan;
  planTrace: PlanTraceEntry[];
  corridor: Corridor;
  /** min(range time, sortie cap), seconds. */
  timeBudgetS: number;
  /** Wind-adjusted flight time of the emitted plan, seconds. */
  estimatedFlightS: number;
}

export interface InfeasibleMission {
  infeasible: true;
  reason: string;
  planTrace: PlanTraceEntry[];
}

export type DeterministicPlanResult = PlannedMission | InfeasibleMission;

/** `lookFor` → mission profile (ADR D20). Unknown looks are inspected. */
export function profileForLookFor(lookFor: Task['lookFor']): MissionProfile {
  return lookFor === 'structure' ? 'survey' : 'inspect';
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function batteryOf(context: VerificationContext) {
  return context.telemetry?.battery ?? context.battery;
}
function navSourceOf(context: VerificationContext) {
  return context.navSource ?? context.telemetry?.navSource;
}
function startPosition(context: VerificationContext, site: SiteModel): LatLon {
  return context.currentPosition ?? context.telemetry?.position ?? { lat: site.home.lat, lon: site.home.lon };
}
function startAltitude(context: VerificationContext): number | null {
  const value = context.currentAltitudeM ?? context.telemetry?.position?.relAlt;
  return finite(value) ? value : null;
}

/**
 * Dispatch gates, in the verifier's own terms. The planner refuses here so the
 * refusal is a reason a human can read, instead of a plan that exists only to
 * be rejected.
 */
function dispatchRefusals(context: VerificationContext, unattended: boolean): string[] {
  const refusals: string[] = [];
  const navSource = navSourceOf(context);
  if (navSource === undefined) refusals.push('runtime navigation source is unknown');
  else if (navSource !== 'gps') refusals.push(`navigation source is ${navSource}`);

  if (!context.readiness) refusals.push('readiness envelope is unknown');
  else if (!context.readiness.ready) {
    refusals.push(...(context.readiness.reasons.length ? context.readiness.reasons : ['vehicle not ready']));
  }

  const battery = batteryOf(context);
  const minSoc = Math.max(VERIFIER_POLICY.dispatchMinSocPct, context.dispatchMinSocPct ?? 0);
  const maxDelta = Math.min(VERIFIER_POLICY.cellImbalanceMaxV, context.cellImbalanceMaxV ?? Infinity);
  const maxTemp = Math.min(VERIFIER_POLICY.battTempMaxC, context.battTempMaxC ?? Infinity);
  if (!battery) refusals.push('battery telemetry is unknown');
  else {
    if (!finite(battery.soc_pct)) refusals.push('battery SoC is non-finite');
    else if (battery.soc_pct < minSoc) refusals.push(`battery SoC ${battery.soc_pct}% is below ${minSoc}%`);
    if (battery.charge_state !== 'charged') refusals.push(`charge_state is ${battery.charge_state ?? 'unknown'}`);
    if (battery.fault) refusals.push(`battery fault: ${battery.fault}`);
    if (finite(battery.cell_delta_v) && battery.cell_delta_v > maxDelta) {
      refusals.push(`cell delta ${battery.cell_delta_v} V exceeds ${maxDelta} V`);
    }
    if (finite(battery.temp_c) && battery.temp_c > maxTemp) {
      refusals.push(`battery temperature ${battery.temp_c} C exceeds ${maxTemp} C`);
    }
  }

  const windLimit = unattended ? UNATTENDED_ENVELOPE.maxWindMps : VERIFIER_POLICY.maxWindMps;
  if (!finite(context.windMps) || (context.windMps as number) < 0) refusals.push('wind speed is unknown');
  else if ((context.windMps as number) > windLimit) {
    refusals.push(`wind ${context.windMps} m/s exceeds ${windLimit} m/s`);
  }

  if (!Array.isArray(context.rfEvents) || context.sdrState === undefined) {
    refusals.push('RF environment is unknown');
  } else {
    if (context.rfEvents.some((event) => event.kind === 'gnss_interference') && !context.rfOverride) {
      refusals.push('GNSS interference is present');
    }
    if (context.rfEvents.some((event) => event.kind === 'hostile_drone')) {
      refusals.push('a hostile drone is detected');
    }
  }

  if (!context.sensors) refusals.push('sensor health is unknown');
  if (context.isNight === undefined) refusals.push('day/night state is unknown');
  if (context.isNight && context.sensors?.thermal !== 'ok') {
    refusals.push('a night mission needs a healthy thermal sensor');
  }
  if (unattended) {
    if (context.requiresOperator) {
      refusals.push(`task is flagged for operator review${
        context.requiresOperatorReason ? `: ${context.requiresOperatorReason}` : ''}`);
    }
    const sorties = context.unattendedSortiesLastHour ?? 0;
    if (sorties >= UNATTENDED_ENVELOPE.maxSortiesPerHour) {
      refusals.push(`${sorties} unattended sorties in the trailing hour reaches the ${
        UNATTENDED_ENVELOPE.maxSortiesPerHour}/h cap`);
    }
    if (context.escalationUndelivered) refusals.push('an escalation is still undelivered');
  }
  return refusals;
}

/** The altitude band a plan may occupy: site ∩ profile ∩ (unattended). */
function altitudeBand(site: SiteModel, profile: MissionProfile, context: VerificationContext,
  unattended: boolean): { min: number; max: number } | null {
  const limits = policyFor(profile, context.profileCapabilities);
  const min = Math.max(site.altBandM.min, unattended ? UNATTENDED_ENVELOPE.altBandM.min : -Infinity);
  const max = Math.min(site.altBandM.max, limits.maxAltitudeM,
    unattended ? UNATTENDED_ENVELOPE.altBandM.max : Infinity);
  return min <= max ? { min, max } : null;
}

/**
 * Pick a cruise altitude inside `band`: the middle of it, moved only to keep
 * the documented 10 m stagger from a peer corridor this plan would cross.
 */
function chooseAltitude(band: { min: number; max: number }, conflicts: Array<{ min: number; max: number }>):
{ altitudeM: number; staggered: boolean } {
  const middle = (band.min + band.max) / 2;
  const clears = (altitude: number): boolean => altitude >= band.min && altitude <= band.max &&
    conflicts.every((peer) => verticalSeparationM({ min: altitude, max: altitude }, peer) >=
      DECONFLICTION_POLICY.altitudeStaggerM);
  if (!conflicts.length || clears(middle)) return { altitudeM: middle, staggered: false };
  const above = Math.max(...conflicts.map((peer) => peer.max)) + DECONFLICTION_POLICY.altitudeStaggerM;
  const below = Math.min(...conflicts.map((peer) => peer.min)) - DECONFLICTION_POLICY.altitudeStaggerM;
  if (clears(above)) return { altitudeM: above, staggered: true };
  if (clears(below)) return { altitudeM: below, staggered: true };
  return { altitudeM: middle, staggered: false };
}

function lateralToleranceM(profile: MissionProfile): number {
  return canonicalProfile(profile) === 'survey'
    ? CORRIDOR_POLICY.lateralTolSurveyM : CORRIDOR_POLICY.lateralTolInspectM;
}

/** The corridor a verified plan is allowed to occupy (ADR D21). */
export function corridorForPlan(plan: MissionPlan, site: SiteModel, context: VerificationContext,
  bandM: { min: number; max: number }): Corridor {
  const walk = walkPlan(plan, site, {
    start: startPosition(context, site),
    startAltM: startAltitude(context),
    capabilities: context.profileCapabilities,
  });
  const tolerance = lateralToleranceM(plan.profile);
  return {
    legs: walk.legs.filter((leg) => leg.lengthM > 0).map((leg) => ({
      from: { lat: round6(leg.from.lat), lon: round6(leg.from.lon) },
      to: { lat: round6(leg.to.lat), lon: round6(leg.to.lon) },
      lateral_tol_m: tolerance,
    })),
    orbits: walk.targets.filter((target) => target.kind === 'orbit_point').map((target) => ({
      center: { lat: round6(target.pos.lat), lon: round6(target.pos.lon) },
      radius_m: target.radiusM ?? 0,
      radial_tol_m: CORRIDOR_POLICY.radialTolM,
    })),
    alt_band_m: { min: bandM.min, max: bandM.max },
    generated_from: plan.requestId,
  };
}

/**
 * Task + site + capabilities + vehicle state → one MissionPlan, or infeasible.
 */
export function planMission(input: DeterministicPlanInput): DeterministicPlanResult {
  const { task, anomaly, site, context } = input;
  const trace: PlanTraceEntry[] = [];
  const note = (rule: string, effect: string): void => { trace.push({ rule, effect }); };
  const refuse = (reason: string): InfeasibleMission => {
    note('infeasible', reason);
    return { infeasible: true, reason, planTrace: trace };
  };
  const requestId = input.requestId ?? `plan-${task.taskId}`;
  const unattended = (context.mode ?? 'attended') === 'unattended';
  note('mode', unattended ? 'unattended: UNATTENDED_ENVELOPE applies' : 'attended: full site envelope');

  const profile = profileForLookFor(task.lookFor);
  note('profile', `lookFor=${task.lookFor} selects the ${profile} profile`);

  const siteCheck = siteValidity(site);
  if (!siteCheck.ok) return refuse(`site model is not usable: ${siteCheck.reason}`);
  note('site_valid', 'site geometry and safety policy are valid');

  const refusals = dispatchRefusals(context, unattended);
  if (refusals.length) return refuse(`vehicle state refuses dispatch: ${refusals.join('; ')}`);
  note('dispatch_state', 'nav, readiness, battery, wind, RF and sensor gates all pass');

  const target: LatLon = { lat: anomaly.lat, lon: anomaly.lon };
  if (!pointInOrOnPolygon(target, site.geofence)) {
    return refuse('the cue lies outside the operational geofence');
  }
  if (unattended && !pointInOrOnPolygon(target, site.perimeter)) {
    return refuse('the cue lies outside the site perimeter, which unattended flight may not leave');
  }
  note('containment', 'the cue is inside the operational geofence');

  const band = altitudeBand(site, profile, context, unattended);
  if (!band) return refuse('the profile altitude band does not intersect the site altitude band');

  const peers = peerGeometry({ ...context });
  const start = startPosition(context, site);
  const startAltM = startAltitude(context);

  // Two vehicles never share an orbit centre (ADR D21/D26): if a peer is
  // already turning around this cue, this is a tasking mistake, and the fleet
  // layer must not answer it by sending a second aircraft to the same point.
  const orbitingPeer = peers.find((peer) => peer.geometry.orbits.some((orbit) =>
    haversineMeters(orbit.center, target) <= DECONFLICTION_POLICY.sharedOrbitCentreM));
  if (orbitingPeer) {
    return refuse(`${orbitingPeer.vehicleId} is already orbiting this observation point`);
  }

  const conflictBands = peers
    .filter((peer) => peer.geometry.altBandM !== null)
    .map((peer) => peer.geometry.altBandM as { min: number; max: number });
  const { altitudeM, staggered } = chooseAltitude(band, peers.length ? conflictBands : []);
  note('altitude', `mid-point of the profile band intersected with the site band${
    unattended ? ' and the unattended band' : ''}${staggered ? ', staggered clear of a peer corridor' : ''}`);

  const floorM = Math.max(VERIFIER_POLICY.hardMinStandoffM, policyFor(profile, context.profileCapabilities).standoffM);
  const requestedRadiusM = PLANNER_POLICY.orbitRadiusM[profile];
  const radiusM = shrinkOrbitRadius(target, requestedRadiusM, altitudeM, site, floorM);
  if (radiusM === null) {
    return refuse('the observation orbit cannot clear the buffered no-fly zones and the geofence without breaching standoff');
  }
  note('orbit', radiusM < requestedRadiusM
    ? 'orbit radius shrunk to clear the buffered no-fly zones and the geofence, never below standoff'
    : 'profile orbit radius clears the buffered no-fly zones and the geofence');
  note('laps', `exactly ${PLANNER_POLICY.laps} lap`);

  const approach = orbitEntryPoint(target, start, radiusM);
  // Departure: climb vertically to cruise altitude before translating, the way
  // the aircraft actually flies. Without it every route is judged at the site
  // band floor (the verifier's conservative min-altitude leg model), which
  // would forbid the legal overflight of a low-ceiling NFZ.
  const climb = startAltM === null || startAltM < altitudeM;
  const routeMinAltM = climb ? altitudeM : Math.min(startAltM as number, altitudeM);
  if (climb) note('departure', 'vertical climb to cruise altitude before the first translating leg');

  const vias = routeVias(start, approach, routeMinAltM, site);
  if (vias === null) {
    return refuse('no route to the observation point clears the buffered no-fly zones inside the geofence');
  }
  note('route', vias.length
    ? `straight leg blocked; shortest via-point detour around ${vias.length} buffered no-fly zone(s)`
    : 'straight leg clears every buffered no-fly zone and stays inside the geofence');

  // The return leg is flown too, so it is planned too: `rtl` goes straight home
  // from the orbit entry, and a straight line home can cross a buffered NFZ
  // that the outbound detour avoided.
  const home: LatLon = { lat: site.home.lat, lon: site.home.lon };
  const returnVias = routeVias(approach, home, altitudeM, site);
  if (returnVias === null) {
    return refuse('no return route from the observation point clears the buffered no-fly zones inside the geofence');
  }
  note('return', returnVias.length
    ? `direct return blocked; shortest via-point detour around ${returnVias.length} buffered no-fly zone(s)`
    : 'direct return clears every buffered no-fly zone and stays inside the geofence');

  const hold: PlanTool[] = task.lookFor === 'fence_gap'
    ? [{ tool: 'hold', durationS: PLANNER_POLICY.fenceGapHoldS }] : [];
  note('hold', task.lookFor === 'fence_gap'
    ? `${PLANNER_POLICY.fenceGapHoldS} s hold, the only hold case`
    : 'no hold: holds exist only for fence_gap');

  const legTools: PlanTool[] = [...(climb ? [start] : []), ...vias, approach].map((point) => ({
    tool: 'goto_gps', lat: round6(point.lat), lon: round6(point.lon),
    alt: altitudeM, profile,
  }));
  const returnTools: PlanTool[] = returnVias.map((point) => ({
    tool: 'goto_gps', lat: round6(point.lat), lon: round6(point.lon), alt: altitudeM, profile,
  }));
  let tools: PlanTool[] = [
    ...legTools,
    { tool: 'orbit_point', lat: round6(target.lat), lon: round6(target.lon), radius: radiusM, laps: PLANNER_POLICY.laps },
    ...hold,
    ...returnTools,
    { tool: 'rtl' },
  ];
  note('terminal', 'mission terminates with one rtl');

  // Clutter transit requires healthy LiDAR AT DISPATCH (ADR D15, FM row
  // "LiDAR failure / pre-flight clutter route"): refuse, never fly it low.
  if (context.sensors?.lidar !== 'ok') {
    const clutterWalk = walkPlan({ requestId, anomalyId: anomaly.id, tools, profile, rationale: '' }, site,
      { start, startAltM, capabilities: context.profileCapabilities });
    const blocked = clutterWalk.legs.some((leg) => legNeedsLidar(leg.from, leg.to, leg.minAltM, site));
    if (blocked) {
      return refuse(`the route transits clutter below ${site.clearAltitudeM} m and LiDAR is ${
        context.sensors?.lidar ?? 'unknown'}`);
    }
    note('clutter', 'route avoids clutter, so degraded LiDAR does not block dispatch');
  }

  const battery = batteryOf(context);
  const timeBudgetS = timeBudgetSeconds({
    socPct: battery?.soc_pct as number,
    remainingS: battery?.remaining_s,
    maxSortieS: context.maxSortieS,
    profile,
    capabilities: context.profileCapabilities,
  });
  const flightSeconds = (candidate: PlanTool[]): number => windAdjustedSeconds(
    walkPlan({ requestId, anomalyId: anomaly.id, tools: candidate, profile, rationale: '' }, site,
      { start, startAltM, capabilities: context.profileCapabilities }).totalFlightS,
    context.windMps ?? 0,
  );
  let estimatedFlightS = flightSeconds(tools);
  if (estimatedFlightS > timeBudgetS) {
    const trimmed = trimToBudget(tools);
    if (trimmed.notes.length) {
      tools = trimmed.tools;
      estimatedFlightS = flightSeconds(tools);
      note('time_budget', 'trimmed the hold and any extra lap to fit min(range, sortie cap)');
    }
  }
  if (estimatedFlightS > timeBudgetS) {
    return refuse(`the mission needs ${estimatedFlightS.toFixed(0)} s but only ${
      timeBudgetS.toFixed(0)} s of range and sortie budget is available`);
  }
  note('time_budget', 'mission fits min(live-SoC range time, sortie cap)');

  const plan: MissionPlan = {
    requestId,
    anomalyId: anomaly.id,
    profile,
    rationale: `Deterministic ${profile} of ${task.lookFor} at cue ${anomaly.id} for task ${task.taskId}: ` +
      `${task.question} Route, altitude, radius and duration come from the rule table, not from the cue.`,
    tools,
    planTrace: trace,
  };
  const corridor = corridorForPlan(plan, site, context, band);
  plan.corridor = corridor;
  note('corridor', `lateral tolerance ${lateralToleranceM(profile)} m, radial tolerance ${
    CORRIDOR_POLICY.radialTolM} m`);

  // Last guard: a plan that would cross a peer corridor with neither lateral
  // separation nor stagger is refused here rather than handed to the verifier
  // for a correction the planner should have made itself.
  const ours = corridorGeometryFromWalk(walkPlan(plan, site,
    { start, startAltM, capabilities: context.profileCapabilities }));
  const unresolved = peers.filter((peer) =>
    lateralSeparationM(ours, peer.geometry) < requiredSeparationM(peer) &&
    verticalSeparationM(ours.altBandM, peer.geometry.altBandM) < DECONFLICTION_POLICY.altitudeStaggerM);
  if (unresolved.length) {
    return refuse(`no altitude inside the band separates this mission from ${
      unresolved.map((peer) => peer.vehicleId).join(', ')}`);
  }
  if (peers.length) note('deconfliction', 'separation holds against every airborne peer');

  return {
    infeasible: false,
    plan,
    planTrace: trace,
    corridor,
    timeBudgetS,
    estimatedFlightS,
  };
}
