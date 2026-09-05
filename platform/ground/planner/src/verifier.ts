/**
 * DNHacks deterministic mission trust layer.
 *
 * Ordered checks: schema, site_valid, nav_source, readiness, wind,
 * rf_environment, airspace, anomaly_proximity, altitude, speed, standoff,
 * geofence, nfz_transit, nfz_orbit, terminal, loiter, range, sortie,
 * attended, deconfliction.
 * Corrected plans are fully re-walked and rechecked before release.
 *
 * Every metre of geometry below comes from `geometry.ts` — the same library
 * the deterministic planner draws with, so the planner cannot disagree with
 * its own verifier about what clears a buffered NFZ.
 */

import {
  Anomaly, AttendanceMode, BatteryState, CapabilityProfile, FleetVehicle, MissionPlan,
  MissionProfile, NavSource, PlanTool, PROFILE_SPEED_MPS, RfEventMessage, SensorHealth,
  Verification, VerificationCheck,
} from './contract';
import {
  CorridorGeometry, LatLon, Walk, WalkLeg as Leg, corridorGeometryFromWalk,
  distancePointToPolygonMeters, distancePointToSegmentMeters, distanceSegmentToPolygonMeters,
  haversineMeters, lateralSeparationM, movePointAcrossBoundary, movePointAwayFromPolygon,
  movePointInsidePolygon, pointInOrOnPolygon, pointInPolygon, profileForTool,
  rangeAvailableSeconds, round6, segmentStaysInsidePolygon, verticalSeparationM, viaCandidates,
  windAdjustedSeconds as windAdjust, policyFor as profileLimits, walkPlan as walkMission,
  INDEFINITE_HOLD_S as HOLD_S,
} from './geometry';
import { SiteModel } from './site';
import { validateMissionPlan } from './validate';
import {
  DECONFLICTION_POLICY, PROFILE_POLICY, UNATTENDED_ENVELOPE, VERIFIER_POLICY, canonicalProfile,
} from './policy';

export const HARD_MIN_STANDOFF_M = VERIFIER_POLICY.hardMinStandoffM;
export const HARD_MAX_SPEED_MPS = VERIFIER_POLICY.hardMaxSpeedMps;
export const NOMINAL_ENDURANCE_S = VERIFIER_POLICY.nominalEnduranceS;
export const RESERVE_PCT = VERIFIER_POLICY.reservePct;
export const DEFAULT_BATTERY_PCT = 60;
export const DRAIN_PCT_PER_S = 100 / NOMINAL_ENDURANCE_S;
export const WIND_TIME_FACTOR_PER_MPS = VERIFIER_POLICY.windTimeFactorPerMps;
export const MAX_WIND_MPS = VERIFIER_POLICY.maxWindMps;
export const ANOMALY_PROXIMITY_M = VERIFIER_POLICY.anomalyProximityM;
export const DEFAULT_MAX_SORTIE_S = VERIFIER_POLICY.maxSortieS;
export const DEFAULT_DISPATCH_MIN_SOC_PCT = VERIFIER_POLICY.dispatchMinSocPct;
export const DEFAULT_CELL_IMBALANCE_MAX_V = VERIFIER_POLICY.cellImbalanceMaxV;
export const DEFAULT_BATT_TEMP_MAX_C = VERIFIER_POLICY.battTempMaxC;
export const CORRECTION_MARGIN_M = 5;
export const MAX_HOLD_S = 60;
export const MAX_ORBIT_LAPS = 3;
/** Flight seconds charged to a hold with no declared duration (geometry.ts). */
const INDEFINITE_HOLD_S = HOLD_S;
/** Nominal inter-vehicle separation, metres (ADR D21). */
export const MIN_SEPARATION_M = DECONFLICTION_POLICY.minSeparationM;
/** Vertical stagger applied when two corridors cross, metres (ADR D21). */
export const ALTITUDE_STAGGER_M = DECONFLICTION_POLICY.altitudeStaggerM;

export const CHECK_ORDER = [
  'schema', 'site_valid', 'nav_source', 'readiness', 'wind', 'rf_environment',
  'airspace', 'anomaly_proximity', 'altitude', 'speed', 'standoff', 'geofence',
  'nfz_transit', 'nfz_orbit', 'terminal', 'loiter', 'range', 'sortie',
  'attended', 'deconfliction',
] as const;

export interface TelemetrySnapshot {
  battery: Partial<BatteryState> & { remaining?: number };
  navSource?: NavSource;
  position?: { lat: number; lon: number; relAlt?: number };
}

export interface VerificationContext {
  telemetry?: TelemetrySnapshot;
  battery?: TelemetrySnapshot['battery'];
  navSource?: NavSource;
  currentPosition?: LatLon;
  currentAltitudeM?: number;
  readiness?: { ready: boolean; reasons: string[] };
  windMps?: number;
  anomaly?: Anomaly;
  rfEvents?: RfEventMessage[];
  sdrState?: 'warming' | 'nominal' | 'degraded' | 'no_device' | 'saturated';
  rfOverride?: boolean;
  sensors?: { rgb: SensorHealth; thermal: SensorHealth; lidar: SensorHealth };
  isNight?: boolean;
  maxSortieS?: number;
  dispatchMinSocPct?: number;
  cellImbalanceMaxV?: number;
  battTempMaxC?: number;
  profileCapabilities?: CapabilityProfile[];

  /* ---- attendance (ADR D23 / docs/CONOPS.md §2) ---- */
  /** Attendance mode this dispatch would fly in. Absent means `attended`. */
  mode?: AttendanceMode;
  /**
   * Set by triage's lure rule (docs/THREAT_MODEL.md § A6.2): a repeated,
   * pattern-forming cue that a human should look at before anything flies.
   * Advisory when attended; a REJECTION when unattended.
   */
  requiresOperator?: boolean;
  requiresOperatorReason?: string;
  /** Unattended sorties already flown in the trailing hour (cap: 2). */
  unattendedSortiesLastHour?: number;
  /** True while an escalation is still undelivered (docs/CONOPS.md §3). */
  escalationUndelivered?: boolean;

  /* ---- fleet deconfliction (ADR D21 / D26) ---- */
  /** This plan's vehicle; peers are every other entry in `fleet`. */
  vehicleId?: string;
  /** Hub-relayed fleet message contents: the ONLY source of peer state. */
  fleet?: FleetVehicle[];
  /**
   * `FleetMessage.ts` — the epoch ms the peer state above was published at.
   * `FleetVehicle` carries no timestamp of its own, so this is the only handle
   * on peer-data age, and age is what doubles the required separation (D21).
   * Absent means "as fresh as `now`", which is the OPTIMISTIC reading: a caller
   * that cannot say how old its fleet view is gets the nominal 40 m, so the
   * hub must pass this through for the stale rule to bite.
   */
  fleetTs?: number;
  /** Epoch ms this plan would be dispatched at (defaults to `now`). */
  dispatchAt?: number;
  /** Epoch ms "now" for time-overlap maths (defaults to Date.now()). */
  now?: number;
}

interface CorrectionResult { plan: MissionPlan; edits: Map<string, string[]>; holdUntil?: number; }

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
function ok(name: string, reason: string): VerificationCheck { return { name, ok: true, reason }; }
function fail(name: string, reason: string): VerificationCheck { return { name, ok: false, reason }; }

/** Profile limits for this plan, tightened by companion-reported capabilities. */
function policyFor(profile: MissionProfile, context: VerificationContext) {
  return profileLimits(profile, context.profileCapabilities);
}

function contextOf(input?: TelemetrySnapshot | VerificationContext): VerificationContext {
  if (!input) return {};
  const candidate = input as VerificationContext;
  if ('telemetry' in candidate || 'battery' in candidate || 'navSource' in candidate ||
      'currentPosition' in candidate || 'currentAltitudeM' in candidate || 'rfEvents' in candidate ||
      'sdrState' in candidate || 'rfOverride' in candidate || 'windMps' in candidate ||
      'readiness' in candidate || 'sensors' in candidate || 'isNight' in candidate ||
      'anomaly' in candidate) return candidate;
  return { telemetry: input as TelemetrySnapshot };
}
function batteryOf(context: VerificationContext): TelemetrySnapshot['battery'] | undefined {
  return context.telemetry?.battery ?? context.battery;
}
function navSourceOf(context: VerificationContext): NavSource | undefined {
  return context.navSource ?? context.telemetry?.navSource;
}
function startPosition(context: VerificationContext, site: SiteModel): LatLon {
  return context.currentPosition ?? context.telemetry?.position ?? { lat: site.home.lat, lon: site.home.lon };
}
function startAltitude(context: VerificationContext): number | null {
  const value = context.currentAltitudeM ?? context.telemetry?.position?.relAlt;
  return finite(value) ? value : null;
}

/** The plan walk, anchored at the vehicle's reported position and altitude. */
function walkPlan(plan: MissionPlan, site: SiteModel, context: VerificationContext): Walk {
  return walkMission(plan, site, {
    start: startPosition(context, site),
    startAltM: startAltitude(context),
    capabilities: context.profileCapabilities,
  });
}

/**
 * The `site_valid` predicate, exported so the deterministic planner refuses an
 * unusable site model instead of drawing geometry on it.
 */
export function siteValidity(site: SiteModel): VerificationCheck {
  return checkSite(site);
}

function checkSite(site: SiteModel): VerificationCheck {
  try {
    if (!site || !site.home || !finite(site.home.lat) || !finite(site.home.lon) || !finite(site.home.altM) ||
        !Array.isArray(site.perimeter) || site.perimeter.length < 3 ||
        !Array.isArray(site.geofence) || site.geofence.length < 3 ||
        !finite(site.nfzBufferM) || site.nfzBufferM < 0 || !site.altBandM ||
        !finite(site.altBandM.min) || !finite(site.altBandM.max) || !finite(site.clearAltitudeM) ||
        site.clearAltitudeM < site.altBandM.min || site.clearAltitudeM > site.altBandM.max ||
        !Array.isArray(site.nfz) || !Array.isArray(site.clutter) || !Array.isArray(site.staging)) {
      return fail('site_valid', 'site model is missing required finite geometry or policy fields');
    }
    const rings = [site.perimeter, site.geofence, ...site.nfz.map((z) => z.polygon), ...site.clutter.map((z) => z.polygon)];
    if (rings.some((ring) => ring.length < 3 || ring.some((p) =>
      !finite(p.lat) || !finite(p.lon) || p.lat < -90 || p.lat > 90 || p.lon < -180 || p.lon > 180))) {
      return fail('site_valid', 'site model contains an invalid polygon coordinate');
    }
    if (site.geofence.some((point) => !pointInOrOnPolygon(point, site.perimeter))) {
      return fail('site_valid', 'operational geofence escapes the site perimeter');
    }
    if (!pointInOrOnPolygon({ lat: site.home.lat, lon: site.home.lon }, site.geofence)) {
      return fail('site_valid', 'home is outside the operational geofence');
    }
    return ok('site_valid', 'site geometry and safety policy are valid');
  } catch (error) {
    return fail('site_valid', `site validation failed: ${(error as Error).message}`);
  }
}

function checkNavSource(context: VerificationContext): VerificationCheck {
  const source = navSourceOf(context);
  if (source === undefined) return fail('nav_source', 'runtime navigation source is required before execution');
  return source === 'gps' ? ok('nav_source', 'GPS navigation source is healthy') :
    fail('nav_source', `new missions are refused while navigation source is ${source}`);
}

function routeUsesClutter(walk: Walk, site: SiteModel): boolean {
  return walk.legs.some((leg) => site.clutter.some((area) =>
    distanceSegmentToPolygonMeters(leg.from, leg.to, area.polygon) === 0 && leg.minAltM < site.clearAltitudeM));
}

function checkReadiness(walk: Walk, site: SiteModel, context: VerificationContext): VerificationCheck {
  const failures: string[] = [];
  if (!context.readiness) failures.push('readiness envelope is required');
  else if (!context.readiness.ready) {
    failures.push(...(context.readiness.reasons.length ? context.readiness.reasons : ['vehicle not ready']));
  }
  const battery = batteryOf(context);
  if (!battery) failures.push('battery telemetry is required');
  else {
    const minSoc = Math.max(DEFAULT_DISPATCH_MIN_SOC_PCT, context.dispatchMinSocPct ?? 0);
    const maxDelta = Math.min(DEFAULT_CELL_IMBALANCE_MAX_V, context.cellImbalanceMaxV ?? Infinity);
    const maxTemp = Math.min(DEFAULT_BATT_TEMP_MAX_C, context.battTempMaxC ?? Infinity);
    if (!finite(battery.soc_pct)) failures.push('battery SoC is non-finite');
    else if (battery.soc_pct < minSoc) failures.push(`battery SoC ${fmt(battery.soc_pct)}% is below ${fmt(minSoc)}%`);
    if (battery.charge_state !== 'charged') failures.push(`charge_state is ${battery.charge_state ?? 'unknown'}, expected charged`);
    if (battery.fault) failures.push(`battery fault: ${battery.fault}`);
    if (!finite(battery.cell_delta_v)) failures.push('cell delta is non-finite');
    else if (battery.cell_delta_v > maxDelta) failures.push(`cell delta ${battery.cell_delta_v} V exceeds ${maxDelta} V`);
    if (!finite(battery.temp_c)) failures.push('battery temperature is non-finite');
    else if (battery.temp_c > maxTemp) failures.push(`battery temperature ${battery.temp_c} C exceeds ${maxTemp} C`);
  }
  if (!context.sensors) failures.push('sensor health is required');
  if (context.isNight === undefined) failures.push('day/night state is required');
  if (context.isNight && context.sensors?.thermal !== 'ok') failures.push('night mission requires a healthy thermal sensor');
  if (context.sensors?.lidar !== 'ok' && routeUsesClutter(walk, site)) {
    failures.push(`clutter transit requires healthy LiDAR or altitude >= ${site.clearAltitudeM} m`);
  }
  return failures.length ? fail('readiness', failures.join('; ')) :
    ok('readiness', 'battery, dispatch, and required sensor checks pass');
}

function checkWind(context: VerificationContext): VerificationCheck {
  const wind = context.windMps;
  if (!finite(wind) || wind < 0) return fail('wind', 'wind speed must be a finite non-negative number');
  return wind <= MAX_WIND_MPS ? ok('wind', `wind ${fmt(wind)} m/s is within ${MAX_WIND_MPS} m/s`) :
    fail('wind', `wind ${fmt(wind)} m/s exceeds ${MAX_WIND_MPS} m/s; hold then RTL`);
}

function checkRfEnvironment(context: VerificationContext): VerificationCheck {
  if (!Array.isArray(context.rfEvents) || context.sdrState === undefined) {
    return fail('rf_environment', 'RF events and SDR health state are required before execution');
  }
  const interference = (context.rfEvents ?? []).filter((event) => event.kind === 'gnss_interference');
  if (interference.length && !context.rfOverride) {
    return fail('rf_environment', 'GNSS interference detected; operator override required');
  }
  if (context.sdrState === 'no_device') return ok('rf_environment', 'SDR unavailable; RF environment unknown (no override required)');
  return ok('rf_environment', interference.length ? 'operator accepted RF override' : 'no blocking RF interference');
}

function checkAirspace(walk: Walk, site: SiteModel, context: VerificationContext): VerificationCheck {
  const conflicts: string[] = [];
  (context.rfEvents ?? []).filter((event) => event.kind === 'hostile_drone').forEach((event) => {
    if (!finite(event.lat) || !finite(event.lon)) {
      conflicts.push('hostile drone has no trusted position');
      return;
    }
    const point = { lat: event.lat, lon: event.lon };
    if (pointInOrOnPolygon(point, site.geofence) || walk.legs.some((leg) =>
      distancePointToSegmentMeters(point, leg.from, leg.to) <= site.nfzBufferM)) {
      conflicts.push(`hostile drone at ${event.lat.toFixed(5)},${event.lon.toFixed(5)} conflicts with mission airspace`);
    }
  });
  return conflicts.length ? fail('airspace', conflicts.join('; ')) : ok('airspace', 'no hostile-drone conflict');
}

function checkAnomalyProximity(walk: Walk, context: VerificationContext): VerificationCheck {
  if (!context.anomaly) return fail('anomaly_proximity', 'anomaly location is required before execution');
  const nearest = walk.targets.length ? Math.min(...walk.targets.map((target) =>
    haversineMeters(target.pos, context.anomaly as Anomaly))) : Infinity;
  return nearest <= ANOMALY_PROXIMITY_M ? ok('anomaly_proximity', `nearest mission target is ${fmt(nearest)} m from the anomaly`) :
    fail('anomaly_proximity', `no mission target is within ${ANOMALY_PROXIMITY_M} m of the anomaly`);
}

function checkAltitude(walk: Walk, plan: MissionPlan, site: SiteModel, context: VerificationContext): VerificationCheck {
  const failures: string[] = [];
  walk.targets.forEach((target) => {
    const maximum = Math.min(site.altBandM.max, policyFor(profileForTool(plan.tools[target.toolIndex], plan), context).maxAltitudeM);
    if (!finite(target.altM) || target.altM < site.altBandM.min || target.altM > maximum) {
      failures.push(`tool ${target.toolIndex} altitude ${fmt(target.altM)} m is outside [${site.altBandM.min}, ${maximum}] m`);
    }
  });
  return failures.length ? fail('altitude', failures.join('; ')) : ok('altitude', 'all target altitudes satisfy site and profile bounds');
}

function checkSpeed(walk: Walk, plan: MissionPlan, context: VerificationContext): VerificationCheck {
  const failures: string[] = [];
  walk.legs.forEach((leg) => {
    const maximum = Math.min(HARD_MAX_SPEED_MPS, policyFor(profileForTool(plan.tools[leg.toolIndex], plan), context).maxSpeedMps);
    if (!finite(leg.speedMps) || leg.speedMps <= 0 || leg.speedMps > maximum) {
      failures.push(`tool ${leg.toolIndex} speed ${fmt(leg.speedMps)} m/s exceeds valid (0, ${maximum}] m/s`);
    }
  });
  return failures.length ? fail('speed', failures.join('; ')) : ok('speed', 'all leg speeds satisfy profile and hard bounds');
}

function checkStandoff(plan: MissionPlan, context: VerificationContext): VerificationCheck {
  const failures: string[] = [];
  plan.tools.forEach((tool, index) => {
    if (tool.tool !== 'orbit_point') return;
    const minimum = Math.max(HARD_MIN_STANDOFF_M, policyFor(plan.profile, context).standoffM);
    if (!finite(tool.radius) || tool.radius < minimum) failures.push(`tool ${index} orbit radius ${fmt(tool.radius)} m is below ${minimum} m standoff`);
  });
  return failures.length ? fail('standoff', failures.join('; ')) : ok('standoff', 'all explicit standoffs satisfy profile and hard floors');
}

function checkGeofence(walk: Walk, site: SiteModel): VerificationCheck {
  const failures: string[] = [];
  walk.targets.forEach((target) => {
    if (!pointInOrOnPolygon(target.pos, site.geofence)) failures.push(`tool ${target.toolIndex} target is outside geofence`);
    if (target.kind === 'orbit_point' &&
        distancePointToPolygonMeters(target.pos, site.geofence) < (target.radiusM ?? 0) - 0.05) {
      failures.push(`tool ${target.toolIndex} orbit circumference leaves geofence`);
    }
  });
  walk.legs.forEach((leg) => {
    if (leg.lengthM > 0 && !segmentStaysInsidePolygon(leg.from, leg.to, site.geofence)) failures.push(`leg to tool ${leg.toolIndex} leaves geofence`);
  });
  return failures.length ? fail('geofence', failures.join('; ')) : ok('geofence', 'all targets and complete legs stay inside operational geofence');
}

function checkNfzTransit(walk: Walk, site: SiteModel): VerificationCheck {
  const failures: string[] = [];
  site.nfz.forEach((zone) => walk.legs.forEach((leg) => {
    if (leg.minAltM > zone.ceilingM) return;
    const clearance = distanceSegmentToPolygonMeters(leg.from, leg.to, zone.polygon);
    if (clearance < site.nfzBufferM - 0.05) failures.push(`leg to tool ${leg.toolIndex} is ${fmt(clearance)} m from NFZ "${zone.name}"; ${site.nfzBufferM} m required`);
  }));
  return failures.length ? fail('nfz_transit', failures.join('; ')) : ok('nfz_transit', `all legs clear buffered NFZs by ${site.nfzBufferM} m`);
}

function checkNfzOrbit(walk: Walk, site: SiteModel): VerificationCheck {
  const failures: string[] = [];
  walk.targets.filter((target) => target.kind === 'orbit_point').forEach((target) => site.nfz.forEach((zone) => {
    if (target.altM > zone.ceilingM) return;
    const clearance = pointInPolygon(target.pos, zone.polygon) ? 0 : distancePointToPolygonMeters(target.pos, zone.polygon);
    if (clearance < site.nfzBufferM + (target.radiusM ?? 0) - 0.05) failures.push(`tool ${target.toolIndex} orbit intersects buffered NFZ "${zone.name}"`);
  }));
  return failures.length ? fail('nfz_orbit', failures.join('; ')) : ok('nfz_orbit', 'all orbit circumferences clear buffered NFZs');
}

function checkTerminal(plan: MissionPlan): VerificationCheck {
  const rtl = plan.tools.flatMap((tool, index) => tool.tool === 'rtl' ? [index] : []);
  if (plan.tools[plan.tools.length - 1]?.tool !== 'rtl') return fail('terminal', 'mission must terminate with rtl');
  if (rtl.length !== 1) return fail('terminal', 'rtl may appear only once, as the terminal tool');
  return ok('terminal', 'mission terminates with one rtl');
}

function checkLoiter(plan: MissionPlan): VerificationCheck {
  const failures: string[] = [];
  plan.tools.forEach((tool, index) => {
    if (tool.tool === 'hold' && (tool.durationS ?? INDEFINITE_HOLD_S) > MAX_HOLD_S) failures.push(`tool ${index} hold exceeds ${MAX_HOLD_S} s`);
    if (tool.tool === 'orbit_point' && (tool.laps ?? 1) > MAX_ORBIT_LAPS) failures.push(`tool ${index} orbit exceeds ${MAX_ORBIT_LAPS} laps`);
  });
  return failures.length ? fail('loiter', failures.join('; ')) : ok('loiter', 'hold durations and orbit laps are bounded');
}

function liveSoc(context: VerificationContext): number {
  const battery = batteryOf(context);
  const value = battery?.soc_pct;
  return finite(value) ? value : Number.NaN;
}
function windAdjustedSeconds(walk: Walk, context: VerificationContext): number {
  return windAdjust(walk.totalFlightS, context.windMps ?? 0);
}
function checkRange(walk: Walk, context: VerificationContext): VerificationCheck {
  const soc = liveSoc(context);
  if (!finite(soc) || soc < 0 || soc > 100) return fail('range', 'live battery SoC must be finite and in [0, 100]');
  const available = rangeAvailableSeconds(soc, batteryOf(context)?.remaining_s);
  const required = windAdjustedSeconds(walk, context);
  const reason = `wind-adjusted ${fmt(required)} s required vs ${fmt(available)} s available at ${fmt(soc)}% SoC with ${RESERVE_PCT}% reserve`;
  return required <= available ? ok('range', reason) : fail('range', `insufficient live-SoC range: ${reason}`);
}
function maxSortie(plan: MissionPlan, context: VerificationContext): number {
  return Math.min(DEFAULT_MAX_SORTIE_S, policyFor(plan.profile, context).maxSortieS, context.maxSortieS ?? Infinity);
}
function checkSortie(walk: Walk, plan: MissionPlan, context: VerificationContext): VerificationCheck {
  const cap = maxSortie(plan, context);
  const required = windAdjustedSeconds(walk, context);
  return required <= cap ? ok('sortie', `sortie ${fmt(required)} s fits ${fmt(cap)} s cap`) :
    fail('sortie', `sortie ${fmt(required)} s exceeds ${fmt(cap)} s cap; split into two sorties`);
}

/* ---------------------------------------------------------------------------
 * attended — the UNATTENDED_ENVELOPE gate (ADR D23, docs/CONOPS.md §2).
 *
 * Attended flight is a no-op pass: the envelope exists because nobody is
 * watching. Unattended, anything outside it is REJECTED (never corrected —
 * quietly shrinking a task into the envelope would hide the refusal a human
 * is supposed to see), and the refusal escalates.
 * ------------------------------------------------------------------------- */

function unattendedFailures(walk: Walk, plan: MissionPlan, site: SiteModel,
  context: VerificationContext): string[] {
  const failures: string[] = [];
  const envelope = UNATTENDED_ENVELOPE;
  if (context.requiresOperator) {
    failures.push(`task is flagged for operator review${
      context.requiresOperatorReason ? `: ${context.requiresOperatorReason}` : ''}`);
  }
  if (canonicalProfile(plan.profile) !== 'inspect') {
    failures.push(`profile ${plan.profile} is outside the unattended envelope (inspect only)`);
  }
  walk.targets.forEach((target) => {
    if (!pointInOrOnPolygon(target.pos, site.perimeter)) {
      failures.push(`tool ${target.toolIndex} target is outside the site perimeter`);
    }
    if (!finite(target.altM) || target.altM < envelope.altBandM.min || target.altM > envelope.altBandM.max) {
      failures.push(`tool ${target.toolIndex} altitude ${fmt(target.altM)} m is outside the unattended band ` +
        `[${envelope.altBandM.min}, ${envelope.altBandM.max}] m`);
    }
  });
  plan.tools.forEach((tool, index) => {
    if (tool.tool === 'orbit_point' && (tool.laps ?? 1) > envelope.maxLaps) {
      failures.push(`tool ${index} orbit exceeds ${envelope.maxLaps} unattended lap`);
    }
    if (tool.tool === 'hold' && (tool.durationS ?? INDEFINITE_HOLD_S) > envelope.maxHoldS) {
      failures.push(`tool ${index} hold exceeds the ${envelope.maxHoldS} s unattended limit`);
    }
  });
  const wind = context.windMps;
  if (!finite(wind) || wind > envelope.maxWindMps) {
    failures.push(`wind ${finite(wind) ? fmt(wind) : 'unknown'} m/s exceeds the ${envelope.maxWindMps} m/s unattended limit`);
  }
  if (navSourceOf(context) !== 'gps') failures.push('unattended dispatch requires a GPS navigation source');
  if ((context.rfEvents ?? []).some((event) => event.kind === 'gnss_interference')) {
    failures.push('RF interference is present; GNSS integrity is unverifiable');
  }
  if ((context.rfEvents ?? []).some((event) => event.kind === 'hostile_drone')) {
    failures.push('a hostile drone is detected; airspace is yielded, never contested');
  }
  if (context.isNight && context.sensors?.thermal !== 'ok') {
    failures.push('a night mission with no healthy thermal produces no observation worth flying for');
  }
  const sorties = context.unattendedSortiesLastHour ?? 0;
  if (sorties >= envelope.maxSortiesPerHour) {
    failures.push(`${sorties} unattended sorties in the trailing hour reaches the ${envelope.maxSortiesPerHour}/h cap`);
  }
  if (context.escalationUndelivered) {
    failures.push('an escalation is still undelivered; unattended dispatch stays refused');
  }
  return failures;
}

function checkAttended(walk: Walk, plan: MissionPlan, site: SiteModel,
  context: VerificationContext): VerificationCheck {
  if ((context.mode ?? 'attended') === 'attended') {
    return context.requiresOperator
      ? ok('attended', `attended operation; operator review flagged${
        context.requiresOperatorReason ? `: ${context.requiresOperatorReason}` : ''}`)
      : ok('attended', 'attended operation; the unattended envelope does not apply');
  }
  const failures = unattendedFailures(walk, plan, site, context);
  return failures.length
    ? fail('attended', `needs_operator: ${failures.join('; ')}`)
    : ok('attended', 'plan is inside UNATTENDED_ENVELOPE');
}

/* ---------------------------------------------------------------------------
 * deconfliction — two vehicles, star topology (ADR D21 / D26).
 *
 * Peer state arrives ONLY through the hub-relayed fleet message, which is what
 * makes the staleness rule enforceable: separation is a function of peer data
 * age, and there is exactly one path by which peer data arrives.
 * ------------------------------------------------------------------------- */

/** One peer, reduced to the geometry and the window separation is measured in. */
export interface PeerGeometry {
  vehicleId: string;
  geometry: CorridorGeometry;
  /** Epoch ms the peer's sortie must end by; Infinity when it has no cap. */
  endsAt: number;
  /** Age of this peer's data, seconds (D21: >3 s doubles the separation). */
  ageS: number;
}

/**
 * Peers this plan must separate from, built ONLY from the hub-relayed fleet
 * message (ADR D26). A vehicle on the pad with no committed corridor is not a
 * separation problem; one that is airborne, or committed to the air, is.
 */
export function peerGeometry(context: VerificationContext): PeerGeometry[] {
  const ageS = context.fleetTs === undefined ? 0
    : Math.max(0, ((context.now ?? Date.now()) - context.fleetTs) / 1000);
  return (context.fleet ?? [])
    .filter((vehicle) => vehicle.vehicleId !== (context.vehicleId ?? ''))
    .flatMap((vehicle: FleetVehicle) => {
      const airborne = vehicle.sortie !== null || (vehicle.position?.relAlt ?? 0) > 1 ||
        vehicle.plannedCorridor !== undefined;
      if (!airborne) return [];
      const corridor = vehicle.plannedCorridor;
      const position = finite(vehicle.position?.lat) && finite(vehicle.position?.lon)
        ? [{ lat: vehicle.position.lat, lon: vehicle.position.lon }] : [];
      return [{
        vehicleId: vehicle.vehicleId,
        geometry: {
          points: position,
          legs: (corridor?.legs ?? []).map((leg) => ({ from: leg.from, to: leg.to })),
          orbits: (corridor?.orbits ?? []).map((orbit) => ({ center: orbit.center, radiusM: orbit.radius_m })),
          altBandM: corridor?.alt_band_m ?? (finite(vehicle.position?.relAlt)
            ? { min: vehicle.position.relAlt, max: vehicle.position.relAlt } : null),
        },
        endsAt: vehicle.sortie ? vehicle.sortie.must_rtl_by : Infinity,
        ageS,
      }];
    });
}

/** Lateral separation required from one peer, metres (doubled when stale). */
export function requiredSeparationM(peer: PeerGeometry): number {
  return peer.ageS > DECONFLICTION_POLICY.stalePeerS
    ? DECONFLICTION_POLICY.staleSeparationM : DECONFLICTION_POLICY.minSeparationM;
}

function checkDeconfliction(walk: Walk, plan: MissionPlan, context: VerificationContext): VerificationCheck {
  const peers = peerGeometry(context);
  if (!peers.length) return ok('deconfliction', 'no peer vehicle is airborne or committed to the air');
  const now = context.now ?? Date.now();
  const dispatchAt = context.dispatchAt ?? now;
  const endsAt = dispatchAt + windAdjustedSeconds(walk, context) * 1000;
  const ours = corridorGeometryFromWalk(walk);
  const conflicts: string[] = [];
  const cleared: string[] = [];
  for (const peer of peers) {
    if (!(dispatchAt < peer.endsAt && now < endsAt)) {
      cleared.push(`${peer.vehicleId} (no time overlap)`);
      continue;
    }
    const sharedCentre = ours.orbits.some((orbit) => peer.geometry.orbits.some((peerOrbit) =>
      haversineMeters(orbit.center, peerOrbit.center) <= DECONFLICTION_POLICY.sharedOrbitCentreM));
    if (sharedCentre) {
      conflicts.push(`${peer.vehicleId} already orbits this observation point; two vehicles never share an orbit centre`);
      continue;
    }
    const required = requiredSeparationM(peer);
    const lateral = lateralSeparationM(ours, peer.geometry);
    if (lateral >= required) {
      cleared.push(`${peer.vehicleId} at ${fmt(lateral)} m`);
      continue;
    }
    const vertical = verticalSeparationM(ours.altBandM, peer.geometry.altBandM);
    if (vertical >= DECONFLICTION_POLICY.altitudeStaggerM) {
      cleared.push(`${peer.vehicleId} crossing at ${fmt(lateral)} m lateral with ${fmt(vertical)} m stagger`);
      continue;
    }
    conflicts.push(`${peer.vehicleId} is ${fmt(lateral)} m away with ${fmt(vertical)} m altitude stagger; ` +
      `${required} m lateral or ${DECONFLICTION_POLICY.altitudeStaggerM} m stagger required`);
  }
  return conflicts.length ? fail('deconfliction', conflicts.join('; '))
    : ok('deconfliction', `separation holds against ${cleared.join(', ')}`);
}

function runChecks(plan: MissionPlan, site: SiteModel, context: VerificationContext,
  schema = ok('schema', 'MissionPlan schema is valid and finite'), siteCheck = checkSite(site)): VerificationCheck[] {
  const walk = walkPlan(plan, site, context);
  return [schema, siteCheck, checkNavSource(context), checkReadiness(walk, site, context),
    checkWind(context), checkRfEnvironment(context), checkAirspace(walk, site, context),
    checkAnomalyProximity(walk, context), checkAltitude(walk, plan, site, context), checkSpeed(walk, plan, context),
    checkStandoff(plan, context), checkGeofence(walk, site), checkNfzTransit(walk, site),
    checkNfzOrbit(walk, site), checkTerminal(plan), checkLoiter(plan), checkRange(walk, context),
    checkSortie(walk, plan, context), checkAttended(walk, plan, site, context),
    checkDeconfliction(walk, plan, context)];
}

function blockedChecks(schema: VerificationCheck, site: VerificationCheck): VerificationCheck[] {
  const blocker = !schema.ok ? schema.reason : site.reason;
  return CHECK_ORDER.map((name) => name === 'schema' ? schema : name === 'site_valid' ? site : fail(name, `not evaluated: ${blocker}`));
}

function buildCorrectedPlan(plan: MissionPlan, site: SiteModel, context: VerificationContext,
  originalChecks: VerificationCheck[]): CorrectionResult {
  const edits = new Map<string, string[]>();
  const note = (name: string, detail: string) => edits.set(name, [...(edits.get(name) ?? []), detail]);
  let tools: PlanTool[] = plan.tools.map((tool, index) => {
    if (tool.tool === 'goto_gps') {
      const profile = profileForTool(tool, plan);
      const maxAltitude = Math.min(site.altBandM.max, policyFor(profile, context).maxAltitudeM);
      const altitude = Math.min(maxAltitude, Math.max(site.altBandM.min, tool.alt));
      const maxSpeed = Math.min(HARD_MAX_SPEED_MPS, policyFor(profile, context).maxSpeedMps);
      const speed = tool.speed_mps === undefined ? undefined : Math.min(maxSpeed, tool.speed_mps);
      if (altitude !== tool.alt) note('altitude', `clamped tool ${index} altitude to ${fmt(altitude)} m`);
      if (speed !== tool.speed_mps) note('speed', `clamped tool ${index} speed to ${fmt(speed as number)} m/s`);
      return { ...tool, alt: altitude, ...(tool.alt_m === undefined ? {} : { alt_m: altitude }),
        ...(speed === undefined ? {} : { speed_mps: speed }) };
    }
    if (tool.tool === 'orbit_point') {
      const minimum = Math.max(HARD_MIN_STANDOFF_M, policyFor(plan.profile, context).standoffM);
      const radius = Math.max(minimum, tool.radius);
      const laps = Math.min(MAX_ORBIT_LAPS, tool.laps ?? 1);
      if (radius !== tool.radius) note('standoff', `raised tool ${index} orbit radius to ${fmt(radius)} m`);
      if (laps !== (tool.laps ?? 1)) note('loiter', `trimmed tool ${index} orbit to ${fmt(laps)} laps`);
      return { ...tool, radius, ...(tool.radius_m === undefined ? {} : { radius_m: radius }),
        ...(tool.laps === undefined ? {} : { laps }) };
    }
    if (tool.tool === 'hold') {
      const duration = Math.min(MAX_HOLD_S, tool.durationS ?? INDEFINITE_HOLD_S);
      if (duration !== (tool.durationS ?? INDEFINITE_HOLD_S)) note('loiter', `clamped tool ${index} hold to ${duration} s`);
      return tool.durationS === undefined ? tool : { ...tool, durationS: duration,
        ...(tool.duration_s === undefined ? {} : { duration_s: duration }) };
    }
    return { ...tool };
  });

  tools = tools.map((tool, index) => {
    if (tool.tool !== 'goto_gps' && tool.tool !== 'orbit_point') return tool;
    let position = { lat: tool.lat, lon: tool.lon };
    if (!pointInOrOnPolygon(position, site.geofence)) {
      position = movePointAcrossBoundary(position, site.geofence, CORRECTION_MARGIN_M);
      note('geofence', `moved tool ${index} target inside operational geofence`);
    }
    const orbitRadius = tool.tool === 'orbit_point' ? tool.radius : 0;
    if (tool.tool === 'orbit_point' && pointInOrOnPolygon(position, site.geofence)) {
      const clearance = distancePointToPolygonMeters(position, site.geofence);
      const required = orbitRadius + CORRECTION_MARGIN_M;
      if (clearance < required) {
        position = movePointInsidePolygon(position, site.geofence, required);
        note('geofence', `moved tool ${index} orbit center inward to contain its circumference`);
      }
    }
    site.nfz.forEach((zone) => {
      const clearance = pointInPolygon(position, zone.polygon) ? 0 : distancePointToPolygonMeters(position, zone.polygon);
      const required = site.nfzBufferM + orbitRadius + CORRECTION_MARGIN_M;
      if (clearance < required) {
        position = movePointAwayFromPolygon(position, zone.polygon, required);
        note(tool.tool === 'orbit_point' ? 'nfz_orbit' : 'nfz_transit', `moved tool ${index} clear of buffered NFZ "${zone.name}"`);
      }
    });
    return { ...tool, lat: round6(position.lat), lon: round6(position.lon) };
  });
  let candidate: MissionPlan = { ...plan, tools };

  if (context.sensors?.lidar !== 'ok') {
    const walk = walkPlan(candidate, site, context);
    const violations = walk.legs.filter((leg) => site.clutter.some((area) =>
      distanceSegmentToPolygonMeters(leg.from, leg.to, area.polygon) === 0 && leg.minAltM < site.clearAltitudeM));
    tools = [...candidate.tools];
    [...violations].sort((a, b) => b.toolIndex - a.toolIndex).forEach((leg) => {
      const target = tools[leg.toolIndex];
      if (target?.tool !== 'goto_gps' || site.clutter.some((area) => pointInOrOnPolygon(leg.from, area.polygon))) return;
      const altitude = Math.max(target.alt, site.clearAltitudeM);
      tools[leg.toolIndex] = { ...target, alt: altitude,
        ...(target.alt_m === undefined ? {} : { alt_m: altitude }) };
      tools.splice(leg.toolIndex, 0, { tool: 'goto_gps', lat: round6(leg.from.lat), lon: round6(leg.from.lon),
        alt: site.clearAltitudeM, profile: candidate.profile });
      note('readiness', `inserted a vertical climb outside clutter before tool ${leg.toolIndex}`);
    });
    candidate = { ...candidate, tools };
  }

  for (let attempt = 0; attempt < 12; attempt++) {
    const walk = walkPlan(candidate, site, context);
    let violation: { leg: Leg; zone: SiteModel['nfz'][number] } | undefined;
    for (const zone of site.nfz) {
      const leg = walk.legs.find((entry) => entry.minAltM <= zone.ceilingM &&
        distanceSegmentToPolygonMeters(entry.from, entry.to, zone.polygon) < site.nfzBufferM - 0.05);
      if (leg) { violation = { leg, zone }; break; }
    }
    if (!violation) break;
    const { leg, zone } = violation;
    // Give corner routes enough radial room for both adjacent legs to remain
    // outside the buffered polygon after coordinate rounding.
    const viaClearance = site.nfzBufferM * 2 + CORRECTION_MARGIN_M;
    const points = viaCandidates(leg.from, leg.to, zone, site, viaClearance);
    if (!points.length) break;
    const via = points[0].point;
    const altitude = Math.min(site.altBandM.max, policyFor(plan.profile, context).maxAltitudeM,
      Math.max(site.altBandM.min, leg.maxAltM));
    tools = [...candidate.tools];
    tools.splice(leg.toolIndex, 0, { tool: 'goto_gps', lat: round6(via.lat), lon: round6(via.lon),
      alt: altitude, profile: plan.profile });
    candidate = { ...candidate, tools };
    note('nfz_transit', `inserted safe via-point around buffered NFZ "${zone.name}"`);
  }

  const terminalValid = candidate.tools[candidate.tools.length - 1]?.tool === 'rtl' && candidate.tools.filter((tool) => tool.tool === 'rtl').length === 1;
  if (!terminalValid) {
    tools = candidate.tools.filter((tool) => tool.tool !== 'rtl');
    tools.push({ tool: 'rtl' });
    candidate = { ...candidate, tools };
    note('terminal', 'normalized mission to one terminal rtl');
  }

  const failed = new Set(originalChecks.filter((check) => !check.ok).map((check) => check.name));
  if (failed.has('range') || failed.has('sortie')) {
    const budgetCheck = failed.has('sortie') ? 'sortie' : 'range';
    tools = candidate.tools.flatMap((tool, index): PlanTool[] => {
      if (tool.tool === 'hold') {
        note(budgetCheck, `dropped hold tool ${index} to fit budget`);
        return [];
      }
      if (tool.tool === 'orbit_point' && (tool.laps ?? 1) > 1) {
        note(budgetCheck, `trimmed orbit tool ${index} to one lap`);
        return [{ ...tool, laps: 1 }];
      }
      return [tool];
    });
    candidate = { ...candidate, tools };
  }

  /* Deconfliction, in the documented order: altitude stagger first, then a
   * delayed dispatch, and otherwise nothing — the check stays failed and the
   * verdict is `rejected`. Neither correction ever moves the route sideways:
   * lateral geometry answers the anomaly, and it is not ours to renegotiate. */
  let holdUntil: number | undefined;
  if (failed.has('deconfliction') && !sharesOrbitCentre(candidate, site, context)) {
    const staggered = staggerForSeparation(candidate, site, context);
    if (staggered) {
      candidate = staggered.plan;
      note('deconfliction', `staggered mission altitude to ${fmt(staggered.altitudeM)} m for peer separation`);
    } else {
      const delay = delayedDispatchAt(candidate, site, context);
      if (delay !== undefined) {
        holdUntil = delay;
        note('deconfliction', `delayed dispatch until ${new Date(delay).toISOString()} for peer separation`);
      }
    }
  }
  return { plan: candidate, edits, ...(holdUntil === undefined ? {} : { holdUntil }) };
}

/**
 * Two vehicles orbiting one point is not a geometry problem to be corrected —
 * it is a tasking mistake — so a shared orbit centre skips correction entirely
 * and the verdict stays `rejected`.
 */
function sharesOrbitCentre(plan: MissionPlan, site: SiteModel, context: VerificationContext): boolean {
  const ours = corridorGeometryFromWalk(walkPlan(plan, site, context));
  return peerGeometry(context).some((peer) => ours.orbits.some((orbit) =>
    peer.geometry.orbits.some((peerOrbit) =>
      haversineMeters(orbit.center, peerOrbit.center) <= DECONFLICTION_POLICY.sharedOrbitCentreM)));
}

/** Peers this candidate would actually share airspace with. */
export function conflictingPeers(plan: MissionPlan, site: SiteModel, context: VerificationContext): PeerGeometry[] {
  const walk = walkPlan(plan, site, context);
  const now = context.now ?? Date.now();
  const dispatchAt = context.dispatchAt ?? now;
  const endsAt = dispatchAt + windAdjustedSeconds(walk, context) * 1000;
  const ours = corridorGeometryFromWalk(walk);
  return peerGeometry(context).filter((peer) => dispatchAt < peer.endsAt && now < endsAt &&
    lateralSeparationM(ours, peer.geometry) < requiredSeparationM(peer));
}

/**
 * Raise (preferred) or lower the whole mission by at least the 10 m stagger
 * from every conflicting peer, staying inside the site and profile bands.
 * Returns null when no legal altitude clears every peer.
 */
function staggerForSeparation(plan: MissionPlan, site: SiteModel, context: VerificationContext):
{ plan: MissionPlan; altitudeM: number } | null {
  const peers = conflictingPeers(plan, site, context).filter((peer) => peer.geometry.altBandM);
  if (!peers.length) return null;
  const floor = site.altBandM.min;
  const ceiling = Math.min(site.altBandM.max, policyFor(plan.profile, context).maxAltitudeM);
  const bands = peers.map((peer) => peer.geometry.altBandM as { min: number; max: number });
  const above = Math.max(...bands.map((band) => band.max)) + ALTITUDE_STAGGER_M;
  const below = Math.min(...bands.map((band) => band.min)) - ALTITUDE_STAGGER_M;
  // The band the staggered mission would OCCUPY includes the altitude it starts
  // from: a vehicle that descends through the peer's band has not staggered.
  const startAlt = startAltitude(context) ?? site.altBandM.min;
  const clears = (altitude: number): boolean => altitude >= floor && altitude <= ceiling &&
    peers.every((peer) => verticalSeparationM(
      { min: Math.min(startAlt, altitude), max: Math.max(startAlt, altitude) },
      peer.geometry.altBandM) >= ALTITUDE_STAGGER_M);
  const altitude = clears(above) ? above : clears(below) ? below : null;
  if (altitude === null) return null;
  const tools = plan.tools.map((tool) => tool.tool === 'goto_gps'
    ? { ...tool, alt: altitude, ...(tool.alt_m === undefined ? {} : { alt_m: altitude }) } : tool);
  return { plan: { ...plan, tools }, altitudeM: altitude };
}

/** The epoch-ms dispatch time at which every conflicting peer has gone home. */
function delayedDispatchAt(plan: MissionPlan, site: SiteModel, context: VerificationContext): number | undefined {
  const peers = conflictingPeers(plan, site, context);
  if (!peers.length) return undefined;
  const latest = Math.max(...peers.map((peer) => peer.endsAt));
  if (!finite(latest)) return undefined;
  return latest + DECONFLICTION_POLICY.dispatchDelayMarginS * 1000;
}

export function verifyMission(inputPlan: MissionPlan, site: SiteModel,
  inputContext?: TelemetrySnapshot | VerificationContext): Verification {
  const context = contextOf(inputContext);
  let plan: MissionPlan;
  let schemaCheck: VerificationCheck;
  try {
    plan = validateMissionPlan(inputPlan);
    schemaCheck = ok('schema', 'MissionPlan schema is valid and finite');
  } catch (error) {
    schemaCheck = fail('schema', (error as Error).message);
    const siteCheck = checkSite(site);
    const request = (inputPlan as unknown as { requestId?: unknown })?.requestId;
    return { requestId: typeof request === 'string' ? request : 'invalid', verdict: 'rejected',
      checks: blockedChecks(schemaCheck, siteCheck) };
  }
  const siteCheck = checkSite(site);
  if (!siteCheck.ok) return { requestId: plan.requestId, verdict: 'rejected', checks: blockedChecks(schemaCheck, siteCheck) };
  const original = runChecks(plan, site, context, schemaCheck, siteCheck);
  if (original.every((check) => check.ok)) return { requestId: plan.requestId, verdict: 'pass', checks: original };
  const correction = buildCorrectedPlan(plan, site, context, original);
  const checksWithEdits = original.map((check) => {
    const details = correction.edits.get(check.name);
    return details?.length ? { ...check, edit: details.join('; ') } : check;
  });
  // A delayed dispatch is a correction to WHEN, so the re-walk is judged at the
  // held-until time — otherwise the peer it waits out is still in the way.
  const correctedContext = correction.holdUntil === undefined
    ? context : { ...context, dispatchAt: correction.holdUntil };
  const correctedChecks = runChecks(correction.plan, site, correctedContext);
  if (correction.edits.size && correctedChecks.every((check) => check.ok)) {
    return {
      requestId: plan.requestId, verdict: 'corrected', checks: checksWithEdits,
      correctedPlan: correction.plan,
      ...(correction.holdUntil === undefined ? {} : { holdUntil: correction.holdUntil }),
    };
  }
  return { requestId: plan.requestId, verdict: 'rejected', checks: checksWithEdits };
}
