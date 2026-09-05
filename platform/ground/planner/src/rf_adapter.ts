/**
 * DNHacks passive RF-drone fixture adapter and GPS/interference correlator.
 *
 * The adapter validates receive-only feed records, attaches the required
 * vehicleId, and derives anomaly envelopes for located hostile drones. It has
 * no vehicle-command or radio-transmit surface. Blue-force fingerprint
 * whitelisting remains a deployment TODO because no authoritative fingerprint
 * source exists in this run.
 */

import * as fs from 'fs';
import {
  Anomaly,
  DEFAULT_VEHICLE_ID,
  HealthEventMessage,
  NavSource,
  RfEventKind,
  RfEventMessage,
} from './contract';


export const CORRELATION_WINDOW_MS = 60_000;

export interface AnomalyMessage {
  type: 'anomaly';
  ts: number;
  vehicleId: string;
  anomaly: Anomaly;
}

export interface RfFeedEmission {
  event: RfEventMessage;
  anomaly?: AnomalyMessage;
}

const RF_KINDS = new Set<RfEventKind>([
  'gnss_interference', 'drone_link', 'remote_id', 'hostile_drone',
]);

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function optionalCoordinate(
  record: Record<string, unknown>,
  name: 'lat' | 'lon' | 'pilot_lat' | 'pilot_lon',
): number | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  const latitude = name === 'lat' || name === 'pilot_lat';
  const valid = finite(value) && (latitude ? value >= -90 && value <= 90 : value >= -180 && value <= 180);
  if (!valid) throw new Error(`invalid RF event: ${name} is outside its coordinate range`);
  return value;
}

/** Validate one untrusted feed record and attach the configured identity/time. */
export function adaptRfEvent(
  input: unknown,
  options: { defaultVehicleId?: string; nowMs?: number } = {},
): RfFeedEmission {
  const defaultVehicleId = options.defaultVehicleId ?? DEFAULT_VEHICLE_ID;
  const nowMs = options.nowMs ?? Date.now();
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('invalid RF event: record must be an object');
  }
  const raw = input as Record<string, unknown>;
  if (raw.source !== 'sdr' && raw.source !== 'rf_drone') {
    throw new Error('invalid RF event: source must be sdr|rf_drone');
  }
  if (typeof raw.kind !== 'string' || !RF_KINDS.has(raw.kind as RfEventKind)) {
    throw new Error('invalid RF event: unsupported kind');
  }
  if (typeof raw.band !== 'string' || raw.band.trim() === '') {
    throw new Error('invalid RF event: band must be a non-empty string');
  }
  if (!finite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) {
    throw new Error('invalid RF event: confidence must be in [0, 1]');
  }
  if (raw.power_delta_db !== undefined && !finite(raw.power_delta_db)) {
    throw new Error('invalid RF event: power_delta_db must be finite when present');
  }
  if (raw.vehicleId !== undefined && (typeof raw.vehicleId !== 'string' || raw.vehicleId === '')) {
    throw new Error('invalid RF event: vehicleId must be a non-empty string when present');
  }
  const ts = raw.ts === undefined ? nowMs : raw.ts;
  if (!finite(ts) || ts < 0) throw new Error('invalid RF event: ts must be a non-negative number');

  const vehicleId = (raw.vehicleId as string | undefined) ?? defaultVehicleId;
  const lat = optionalCoordinate(raw, 'lat');
  const lon = optionalCoordinate(raw, 'lon');
  if ((lat === undefined) !== (lon === undefined)) {
    throw new Error('invalid RF event: lat and lon must be supplied together');
  }
  const pilotLat = optionalCoordinate(raw, 'pilot_lat');
  const pilotLon = optionalCoordinate(raw, 'pilot_lon');
  if ((pilotLat === undefined) !== (pilotLon === undefined)) {
    throw new Error('invalid RF event: pilot_lat and pilot_lon must be supplied together');
  }

  const event: RfEventMessage = {
    type: 'rfEvent',
    ts,
    vehicleId,
    source: raw.source,
    kind: raw.kind as RfEventKind,
    band: raw.band,
    confidence: raw.confidence,
    ...(raw.power_delta_db === undefined ? {} : { power_delta_db: raw.power_delta_db }),
    ...(lat === undefined ? {} : { lat, lon: lon as number }),
    ...(pilotLat === undefined ? {} : { pilot_lat: pilotLat, pilot_lon: pilotLon as number }),
  };

  let anomaly: AnomalyMessage | undefined;
  if (event.kind === 'hostile_drone' && lat !== undefined && lon !== undefined) {
    anomaly = {
      type: 'anomaly',
      ts,
      vehicleId,
      anomaly: {
        id: `rf-${Math.trunc(ts)}-${lat.toFixed(5)}-${lon.toFixed(5)}`,
        lat,
        lon,
        type: 'hostile_drone',
        confidence: event.confidence,
        thumbnail: '',
        source: 'rf_drone',
      },
    };
  }
  return { event, ...(anomaly ? { anomaly } : {}) };
}

/** Read the baked feed. Accepted roots are an event array or { events: [] }. */
export function loadRfFixture(
  filePath: string,
  defaultVehicleId: string = DEFAULT_VEHICLE_ID,
): RfFeedEmission[] {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  const records = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { events?: unknown }).events)
      ? (parsed as { events: unknown[] }).events
      : null;
  if (records === null) throw new Error('invalid RF fixture: expected an array or {events: []}');
  return records.map((record, index) => adaptRfEvent(record, {
    defaultVehicleId,
    nowMs: index * 1000,
  }));
}

/**
 * Correlates either event ordering: RF then GPS loss, or GPS loss then RF.
 * Each pair emits once. Inputs from different vehicles never correlate.
 */
export class InterferenceCorrelator {
  private readonly gpsLoss = new Map<string, number>();
  private readonly interference = new Map<string, number>();
  private readonly emitted = new Set<string>();
  private readonly previousSource = new Map<string, NavSource>();
  private readonly emittedOrder: string[] = [];
  private static readonly MAX_EMITTED = 512;

  recordNavSource(vehicleId: string, navSource: NavSource, ts: number): HealthEventMessage | null {
    const previous = this.previousSource.get(vehicleId);
    this.previousSource.set(vehicleId, navSource);
    if (navSource === 'gps') {
      this.gpsLoss.delete(vehicleId);
      return null;
    }
    // Record the transition edge once. Repeated non-GPS telemetry retains the
    // original loss time so a stale denial cannot correlate with a later RF hit.
    if (previous === undefined || previous === 'gps') this.gpsLoss.set(vehicleId, ts);
    return this.correlate(vehicleId);
  }

  recordRfEvent(event: RfEventMessage): HealthEventMessage | null {
    if (event.kind !== 'gnss_interference') return null;
    this.interference.set(event.vehicleId, event.ts);
    return this.correlate(event.vehicleId);
  }

  private correlate(vehicleId: string): HealthEventMessage | null {
    const gpsTs = this.gpsLoss.get(vehicleId);
    const rfTs = this.interference.get(vehicleId);
    if (gpsTs === undefined || rfTs === undefined) return null;
    const deltaMs = Math.abs(gpsTs - rfTs);
    if (deltaMs > CORRELATION_WINDOW_MS) return null;
    const key = `${vehicleId}:${gpsTs}:${rfTs}`;
    if (this.emitted.has(key)) return null;
    this.emitted.add(key);
    this.emittedOrder.push(key);
    while (this.emittedOrder.length > InterferenceCorrelator.MAX_EMITTED) {
      this.emitted.delete(this.emittedOrder.shift() as string);
    }
    return {
      type: 'healthEvent',
      ts: Math.max(gpsTs, rfTs),
      vehicleId,
      component: 'gps',
      state: 'escalate',
      detail: `probable interference: GPS source loss and GNSS RF event were ${Math.round(deltaMs / 1000)} s apart`,
    };
  }
}
