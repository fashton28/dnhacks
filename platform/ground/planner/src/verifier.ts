/**
 * DNHacks deterministic mission trust layer.
 *
 * Ordered checks: schema, site_valid, nav_source, readiness, wind,
 * rf_environment, airspace, anomaly_proximity, altitude, speed, standoff,
 * geofence, nfz_transit, nfz_orbit, terminal, loiter, range, sortie.
 * Corrected plans are fully re-walked and rechecked before release.
 */

import {
  Anomaly, BatteryState, CapabilityProfile, MissionPlan, MissionProfile, NavSource, PlanTool,
  PROFILE_SPEED_MPS, RfEventMessage, SensorHealth, Verification, VerificationCheck,
} from './contract';
import {
  LatLon, SiteModel, distancePointToPolygonMeters, distanceSegmentToPolygonMeters,
  haversineMeters, movePointAcrossBoundary, movePointAwayFromPolygon, movePointInsidePolygon,
  pointInOrOnPolygon, pointInPolygon, segmentStaysInsidePolygon,
} from './site';
import { validateMissionPlan } from './validate';
import { PROFILE_POLICY, VERIFIER_POLICY } from './policy';

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
export const INDEFINITE_HOLD_S = 30;
export const MAX_HOLD_S = 60;
export const MAX_ORBIT_LAPS = 3;
export const CONSERVATIVE_VERTICAL_SPEED_MPS = 2;
export const RTL_LANDING_ALLOWANCE_S = 15;

export const CHECK_ORDER = [
  'schema', 'site_valid', 'nav_source', 'readiness', 'wind', 'rf_environment',
  'airspace', 'anomaly_proximity', 'altitude', 'speed', 'standoff', 'geofence',
  'nfz_transit', 'nfz_orbit', 'terminal', 'loiter', 'range', 'sortie',
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
}

interface Target {
  toolIndex: number;
  kind: 'goto_gps' | 'goto_relative' | 'orbit_point';
  pos: LatLon;
  altM: number;
  radiusM?: number;
}
interface Leg {
  toolIndex: number; from: LatLon; to: LatLon; fromAltM: number; toAltM: number;
  minAltM: number; maxAltM: number;
  lengthM: number; speedMps: number;
}
interface Walk { targets: Target[]; legs: Leg[]; totalPathM: number; totalFlightS: number; }
interface CorrectionResult { plan: MissionPlan; edits: Map<string, string[]>; }

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
function round6(value: number): number { return Math.round(value * 1e6) / 1e6; }
function ok(name: string, reason: string): VerificationCheck { return { name, ok: true, reason }; }
function fail(name: string, reason: string): VerificationCheck { return { name, ok: false, reason }; }

function profileForTool(tool: PlanTool, plan: MissionPlan): MissionProfile {
  if (tool.tool === 'goto_gps' && tool.profile) return tool.profile;
  if (tool.tool === 'follow' || tool.tool === 'orbit') return tool.profile;
  return plan.profile;
}

function policyFor(profile: MissionProfile, context: VerificationContext) {
  const base = PROFILE_POLICY[profile];
  const effective = context.profileCapabilities?.find((entry) => entry.profile === profile);
  return effective ? {
    maxSpeedMps: Math.min(base.maxSpeedMps, effective.max_speed_mps),
    maxAltitudeM: Math.min(base.maxAltitudeM, effective.max_altitude_m),
    standoffM: Math.max(base.standoffM, effective.min_standoff_m),
    maxSortieS: base.maxSortieS,
  } : base;
}

function translateMeters(origin: LatLon, eastM: number, northM: number): LatLon {
  return {
    lat: origin.lat + northM / 111_320,
    lon: origin.lon + eastM / (111_320 * Math.cos(origin.lat * Math.PI / 180)),
  };
}

function orbitEntry(center: LatLon, current: LatLon, radiusM: number): LatLon {
  const distance = haversineMeters(center, current);
  if (distance < 0.01) return translateMeters(center, 0, radiusM);
  const scale = radiusM / distance;
  return { lat: center.lat + (current.lat - center.lat) * scale,
    lon: center.lon + (current.lon - center.lon) * scale };
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

function walkPlan(plan: MissionPlan, site: SiteModel, context: VerificationContext): Walk {
  const targets: Target[] = [];
  const legs: Leg[] = [];
  let totalPathM = 0;
  let totalFlightS = 0;
  const home = { lat: site.home.lat, lon: site.home.lon };
  let current = startPosition(context, site);
  let currentAlt = startAltitude(context);
  const addLeg = (toolIndex: number, to: LatLon, altitudeM: number, speedMps: number) => {
    const lengthM = haversineMeters(current, to);
    const fromAltM = currentAlt ?? site.altBandM.min;
    const maxAltM = Math.max(fromAltM, altitudeM);
    const minAltM = Math.min(fromAltM, altitudeM);
    legs.push({ toolIndex, from: current, to, fromAltM, toAltM: altitudeM, minAltM, maxAltM, lengthM, speedMps });
    totalPathM += lengthM;
    totalFlightS += speedMps > 0 ? lengthM / speedMps : Infinity;
    totalFlightS += Math.abs(altitudeM - fromAltM) / CONSERVATIVE_VERTICAL_SPEED_MPS;
    current = to;
    currentAlt = altitudeM;
  };
  plan.tools.forEach((tool, index) => {
    const profile = profileForTool(tool, plan);
    const speed = Math.min(PROFILE_SPEED_MPS[profile], policyFor(profile, context).maxSpeedMps);
    switch (tool.tool) {
      case 'goto_gps': {
        const to = { lat: tool.lat, lon: tool.lon };
        addLeg(index, to, tool.alt, tool.speed_mps ?? speed);
        targets.push({ toolIndex: index, kind: 'goto_gps', pos: to, altM: tool.alt });
        break;
      }
      case 'goto_relative': {
        const to = translateMeters(current, tool.dx, tool.dy);
        const altitude = (currentAlt ?? site.altBandM.min) + tool.dz;
        addLeg(index, to, altitude, speed);
        targets.push({ toolIndex: index, kind: 'goto_relative', pos: to, altM: altitude });
        break;
      }
      case 'orbit_point': {
        const altitude = currentAlt ?? site.altBandM.min;
        const center = { lat: tool.lat, lon: tool.lon };
        const entry = orbitEntry(center, current, tool.radius);
        addLeg(index, entry, altitude, speed);
        const orbitLength = 2 * Math.PI * tool.radius * (tool.laps ?? 1);
        totalPathM += orbitLength;
        totalFlightS += speed > 0 ? orbitLength / speed : Infinity;
        targets.push({ toolIndex: index, kind: 'orbit_point', pos: center, altM: altitude, radiusM: tool.radius });
        break;
      }
      case 'hold': totalFlightS += tool.durationS ?? INDEFINITE_HOLD_S; break;
      case 'follow': totalFlightS += INDEFINITE_HOLD_S; break;
      case 'orbit': totalFlightS += 2 * Math.PI * policyFor(profile, context).standoffM / speed; break;
      case 'rtl': {
        const altitude = currentAlt ?? site.altBandM.min;
        addLeg(index, home, altitude, speed);
        totalFlightS += altitude / CONSERVATIVE_VERTICAL_SPEED_MPS + RTL_LANDING_ALLOWANCE_S;
        currentAlt = null;
        break;
      }
    }
  });
  return { targets, legs, totalPathM, totalFlightS };
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

function distancePointToSegmentMeters(point: LatLon, a: LatLon, b: LatLon): number {
  const latScale = 111_320;
  const lonScale = latScale * Math.cos(a.lat * Math.PI / 180);
  const bx = (b.lon - a.lon) * lonScale;
  const by = (b.lat - a.lat) * latScale;
  const px = (point.lon - a.lon) * lonScale;
  const py = (point.lat - a.lat) * latScale;
  const denom = bx * bx + by * by;
  const t = denom === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / denom));
  return Math.hypot(px - t * bx, py - t * by);
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
  return walk.totalFlightS * (1 + WIND_TIME_FACTOR_PER_MPS * (context.windMps ?? 0));
}
function checkRange(walk: Walk, context: VerificationContext): VerificationCheck {
  const soc = liveSoc(context);
  if (!finite(soc) || soc < 0 || soc > 100) return fail('range', 'live battery SoC must be finite and in [0, 100]');
  const modelAvailable = NOMINAL_ENDURANCE_S * Math.max(0, (soc - RESERVE_PCT) / 100);
  const remaining = batteryOf(context)?.remaining_s;
  const liveAvailable = finite(remaining) ? remaining * Math.max(0, (soc - RESERVE_PCT) / Math.max(soc, 1)) : Infinity;
  const available = Math.min(modelAvailable, liveAvailable);
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

function runChecks(plan: MissionPlan, site: SiteModel, context: VerificationContext,
  schema = ok('schema', 'MissionPlan schema is valid and finite'), siteCheck = checkSite(site)): VerificationCheck[] {
  const walk = walkPlan(plan, site, context);
  return [schema, siteCheck, checkNavSource(context), checkReadiness(walk, site, context),
    checkWind(context), checkRfEnvironment(context), checkAirspace(walk, site, context),
    checkAnomalyProximity(walk, context), checkAltitude(walk, plan, site, context), checkSpeed(walk, plan, context),
    checkStandoff(plan, context), checkGeofence(walk, site), checkNfzTransit(walk, site),
    checkNfzOrbit(walk, site), checkTerminal(plan), checkLoiter(plan), checkRange(walk, context),
    checkSortie(walk, plan, context)];
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
    const points = zone.polygon.map((vertex) => movePointAwayFromPolygon(vertex, zone.polygon, viaClearance))
      .filter((point) => pointInOrOnPolygon(point, site.geofence))
      .filter((point) => site.nfz.every((other) =>
        distanceSegmentToPolygonMeters(leg.from, point, other.polygon) >= site.nfzBufferM - 0.05 &&
        distanceSegmentToPolygonMeters(point, leg.to, other.polygon) >= site.nfzBufferM - 0.05))
      .sort((a, b) => haversineMeters(leg.from, a) + haversineMeters(a, leg.to) -
        haversineMeters(leg.from, b) - haversineMeters(b, leg.to));
    if (!points.length) break;
    const via = points[0];
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
  return { plan: candidate, edits };
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
  const correctedChecks = runChecks(correction.plan, site, context);
  if (correction.edits.size && correctedChecks.every((check) => check.ok)) {
    return { requestId: plan.requestId, verdict: 'corrected', checks: checksWithEdits, correctedPlan: correction.plan };
  }
  return { requestId: plan.requestId, verdict: 'rejected', checks: checksWithEdits };
}
