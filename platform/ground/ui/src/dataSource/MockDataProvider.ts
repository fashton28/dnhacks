/* ============================================================================
 * Drone Safety Platform — MockDataProvider
 * ----------------------------------------------------------------------------
 * Faithful TypeScript port of ui_kits/ground-control/mock.js into a class that
 * implements the authoritative `DataSource` contract (plus the UI-side
 * MissionDataSource channels). A self-contained, lifelike mock that drives the
 * whole demo with no backend: telemetry @ ~10Hz, tracking with bboxes that
 * match the canvas scene, a status-text log, a command state machine, and the
 * manual (game-controller) physics block.
 *
 * MISSION SCENARIO (offline, end-to-end, all REAL ground-side code):
 *   ~5 s after start the baked satellite anomaly is emitted (eis-satellite
 *   baked data, re-anchored to the loaded site if stale), then the scripted
 *   FAILING plan (eis-planner ScriptedPlanner) with its Verification from the
 *   real MissionVerifier (nfz + altitude checks fail → rejected/corrected),
 *   then the passing plan + its pass/corrected Verification, which awaits
 *   operator approval. `executePlan` flies the plan (controlSource 'planner'),
 *   emits the synthetic locked-target observation at the staging point, the
 *   IncidentReport (real report writer; 'escalate' for a truth vehicle), and
 *   RTLs home. abortPlan / deny returns cleanly to idle.
 *
 *   NOTHING here hardcodes plant geometry — all coordinates derive from the
 *   loaded site model (src/site) + the baked anomaly.
 * ========================================================================== */
import type {
  Anomaly,
  AnomalyMessage,
  AttendanceMode,
  CapabilitiesMessage,
  CommandAck,
  Command,
  ConnectionConfig,
  ConnectionState,
  Corridor,
  DetectedTarget,
  EnvelopeAction,
  EnvelopeConstraint,
  EnvelopeMessage,
  EnvelopeState,
  EscalationMessage,
  FleetMessage,
  FleetVehicle,
  HealthEventMessage,
  IncidentReportMessage,
  ManualInput,
  MissionPlan,
  MissionPlanMessage,
  Mode,
  ModeMessage,
  ObservationMessage,
  ReadinessMessage,
  RfEventMessage,
  SensorHealth,
  StatusText,
  SpectrumMessage,
  SimulationToggles,
  Task,
  TaskLookFor,
  TaskMessage,
  TestFaultName,
  Telemetry,
  TrackingState,
  TrackingStatus,
  Unsubscribe,
  Verification,
  VerificationMessage,
} from '@/contract';
import { PROFILE_SPEED_MPS } from '@/contract';
import { GIMBAL_PITCH_MAX_DEG, GIMBAL_PITCH_MIN_DEG } from '@/contract';
import { DEFAULT_VEHICLE_ID } from '@/contract';
import type { DemoScenario, FleetRow, MissionDataSource } from './types';
import {
  UNATTENDED_ENVELOPE,
  corridorMargin,
  nearestCorridorPoint,
  withCorridorAndTrace,
} from './scriptedRails';

import { getSiteModel, getRawSite } from '@/site';
import type { SiteModel, SiteStagingPoint } from '@/site';
import { createRendererCueBus, RAIL_LABEL } from '@/cues';
import type { CueBus, RailHealth, RailId } from '@/cues';
import { ScriptedPlanner } from '@planner/scripted';
import { planMission } from '@planner/deterministic';
import { verifyMission } from '@planner/verifier';
import type { VerificationContext } from '@planner/verifier';
import { writeIncidentReport } from '@planner/report';
import type { ObservationSummary } from '@planner/report';
import { distancePointToPolygonMeters, haversineMeters, pointInPolygon } from '@planner/site';
import bakedAnomalies from '@satdata/anomalies.json';

const HOME = { lat: 37.7699, lon: -122.4666 }; // generic park (pre-site fallback)
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const now = (): number => Date.now();

const M_PER_DEG_LAT = 111320;

/** Mock-only time compression for planned missions: real plan legs are a few
 *  hundred meters at 2–6 m/s, which would make the demo minutes long. The
 *  vehicle flies SCALE× faster than the profile speed; telemetry reports the
 *  true (unscaled) profile speed so the readouts stay plausible. */
const MISSION_TIME_SCALE = 6;

/** Scenario beat delays, ms (anomaly → failing plan → its verification →
 *  passing plan → its verification → await approval). */
const SCENARIO_DELAYS_MS = [5000, 2500, 2000, 2500, 2000];

/** Envelope report cadence while airborne, ms (5 Hz). */
const ENVELOPE_PERIOD_MS = 200;

/** Default gimbal pitch, degrees: looking down at the scene. */
const DEFAULT_GIMBAL_PITCH_DEG = 45;

/** Cue TTL the mock stamps on the scripted anomaly, seconds. */
const SCRIPTED_CUE_TTL_S = 900;

/** The peer vehicle in the two-vehicle fleet (ADR D26 — star topology). */
const PEER_VEHICLE_ID = 'eis-2';

/** Lateral push a scripted gust applies while it blows, m/s. Chosen so the
 *  vehicle's limited lateral authority loses to it: the corridor tolerance is
 *  crossed in a couple of seconds of demo time, not instantly. */
const GUST_DRIFT_MPS = 1.95;
/** How long a scripted gust blows, ms. */
const GUST_DURATION_MS = 9000;

/** How long the operator stays away for the operator-absent beat, ms. */
const OPERATOR_ABSENT_MS = 14000;

/** Scripted wind, m/s. Above UNATTENDED_ENVELOPE.maxWindMps this alone would
 *  refuse an unattended dispatch; it is deliberately below it. */
const SCRIPTED_WIND_MPS = 4.2;

const DEFAULT_SIMULATION_TOGGLES: SimulationToggles = {
  simulateGpsLoss: false,
  simulateRfInterference: false,
  simulateHostileDrone: false,
  simulateLinkLoss: false,
  simulateCameraFail: false,
  simulateCharging: false,
  simulateBatteryFault: false,
  simulateSortieExpiry: false,
  simulateThermalFail: false,
  simulateLidarFail: false,
  simulateNight: false,
};

type Severity = StatusText['severity'];
type Phase = 'idle' | 'takeoff' | 'flying' | 'rtl' | 'landing';

interface SimState {
  armed: boolean;
  mode: Mode;
  relAlt: number;
  targetAlt: number;
  roll: number;
  pitch: number;
  yaw: number;
  heading: number;
  lat: number;
  lon: number;
  groundspeed: number;
  vspeed: number;
  battery: number;
  voltage: number;
  current: number;
  sats: number;
  fix: number;
  hdop: number;
  rssi: number;
  latency: number;
  phase: Phase;
}

interface TrackSim {
  state: TrackingState;
  standoff: number;
  maxSpeed: number;
  estimatedDistance: number | null;
  lockedTargetId: number | null;
  targets: DetectedTarget[];
}

interface Person {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  conf: number;
}

interface ManualState extends ManualInput {
  active: boolean;
}

/** In-flight execution state for an approved plan. */
interface MissionExec {
  plan: MissionPlan;
  toolIndex: number;
  orbit: { theta: number; laps: number } | null;
  holdLeftS: number | null;
  observed: boolean;
}

/** Synthetic observation window: while set, stepTracking emits the locked
 *  staging-point target instead of the ambient people sim. */
interface ObservationSim {
  until: number;
  detected: boolean;
  confidence: number;
  distanceM: number;
}

interface Callbacks {
  tel: Array<(t: Telemetry) => void>;
  trk: Array<(t: TrackingStatus) => void>;
  txt: Array<(s: StatusText) => void>;
  ack: Array<(a: CommandAck) => void>;
  conn: Array<(s: ConnectionState) => void>;
  anom: Array<(m: AnomalyMessage) => void>;
  plan: Array<(m: MissionPlanMessage) => void>;
  verf: Array<(m: VerificationMessage) => void>;
  rept: Array<(m: IncidentReportMessage) => void>;
  obs: Array<(m: ObservationMessage) => void>;
  caps: Array<(m: CapabilitiesMessage) => void>;
  ready: Array<(m: ReadinessMessage) => void>;
  health: Array<(m: HealthEventMessage) => void>;
  rf: Array<(m: RfEventMessage) => void>;
  spectrum: Array<(m: SpectrumMessage) => void>;
  fleet: Array<(m: FleetMessage) => void>;
  task: Array<(m: TaskMessage) => void>;
  envl: Array<(m: EnvelopeMessage) => void>;
  mode: Array<(m: ModeMessage) => void>;
  escl: Array<(m: EscalationMessage) => void>;
}

export class MockDataProvider implements MissionDataSource {
  readonly kind = 'mock' as const;
  private cbs: Callbacks = {
    tel: [],
    trk: [],
    txt: [],
    ack: [],
    conn: [],
    anom: [],
    plan: [],
    verf: [],
    rept: [],
    obs: [],
    caps: [],
    ready: [],
    health: [],
    rf: [],
    spectrum: [],
    fleet: [],
    task: [],
    envl: [],
    mode: [],
    escl: [],
  };

  private connState: ConnectionState = 'connected';
  private config: ConnectionConfig = { host: 'sitl', controlPort: 8765, videoUrl: '', sitl: true };

  private t = 0;
  private s: SimState = {
    armed: false,
    mode: 'LOITER',
    relAlt: 0,
    targetAlt: 0,
    roll: 0,
    pitch: 0,
    yaw: 0,
    heading: 215,
    lat: HOME.lat,
    lon: HOME.lon,
    groundspeed: 0,
    vspeed: 0,
    battery: 96,
    voltage: 16.6,
    current: 0.4,
    sats: 16,
    fix: 3,
    hdop: 0.7,
    rssi: -48,
    latency: 38,
    phase: 'idle',
  };

  private track: TrackSim = {
    state: 'idle',
    standoff: 4,
    maxSpeed: 3,
    estimatedDistance: null,
    lockedTargetId: null,
    targets: [],
  };

  // two "people" moving in the frame (normalised centre + size)
  private people: Person[] = [
    { id: 1, x: 0.4, y: 0.58, w: 0.1, h: 0.3, vx: 0.0011, conf: 0.0 },
    { id: 2, x: 0.66, y: 0.55, w: 0.09, h: 0.27, vx: -0.0008, conf: 0.0 },
  ];

  private _lostTimer = 0;
  private _started = false;

  // manual (game-controller) piloting
  private manual: ManualState = { active: false, throttle: 0, yaw: 0, pitch: 0, roll: 0 };

  // mission planner: while active, controlSource is 'planner'.
  private plannerActive = false;
  private sortieStartedAt: number | null = null;
  private simulationToggles: SimulationToggles = { ...DEFAULT_SIMULATION_TOGGLES };
  private mission: MissionExec | null = null;
  private obs: ObservationSim | null = null;

  // scripted anomaly→plan→verification scenario
  private site: SiteModel | null = null;
  private _scnStep = 0;
  private _scnDone = false;
  private _scnTimer: ReturnType<typeof setTimeout> | null = null;
  private _scnAnomaly: Anomaly | null = null;
  private _scnFailing: MissionPlan | null = null;
  private _scnPassing: MissionPlan | null = null;
  private _scnPassingVerification: Verification | null = null;
  private planner = new ScriptedPlanner();

  private _searchT = 0;
  private _lostStart = 0;
  private _warn30 = false;
  private _warn15 = false;
  private hostileOverride = false;
  private lastAuxEmit = 0;
  private lastHealthSignature = '';
  private lastReadinessSignature = '';

  // attendance mode + gimbal + envelope monitor (Phase 1 rails)
  private attendance: AttendanceMode = 'attended';
  private attendanceSince = now();
  private operatorPresent = true;
  private operatorReturnsAt: number | null = null;
  private gimbalPitchDeg = DEFAULT_GIMBAL_PITCH_DEG;
  private _scnTask: Task | null = null;
  private _scnTasks: Task[] = [];
  private operatorNote = '';
  private triageRuns = 0;

  /* Envelope monitor state. It reads position + corridor and NOTHING that
     guidance owns, and guidance cannot clear it — only the monitor's own
     hysteresis does (ADR D22). */
  private envelopeState: EnvelopeState = 'in_envelope';
  private envelopeHold = false;
  private envelopeSince = now();
  private envelopeEscalated = false;
  /** The altitude check arms once the vehicle first reaches its cleared band. */
  private envelopeArmed = false;
  private gust: { startedAt: number; bearingRad: number } | null = null;

  /* Second vehicle: a peer the hub relays, per ADR D26. It has its own
     battery, sortie clock and cleared corridor; there is no vehicle-to-vehicle
     link and no automatic reallocation. */
  private peer = {
    lat: 0,
    lon: 0,
    relAlt: 0,
    heading: 90,
    theta: 0,
    battery: 91,
    armed: false,
    manualActive: false,
    mode: 'LOITER' as Mode,
    sortieStartedAt: null as number | null,
    plan: null as MissionPlan | null,
    flying: false,
    trail: [] as Array<{ lat: number; lon: number }>,
  };
  private selectedVehicle: string = DEFAULT_VEHICLE_ID;
  private fleetRowCbs: Array<(rows: FleetRow[]) => void> = [];
  private handoffDone = false;
  /** Monotonic counter that keeps every re-plan a distinct proposal. */
  private replans = 0;

  private _tel: ReturnType<typeof setInterval> | null = null;
  private _trk: ReturnType<typeof setInterval> | null = null;
  private _amb: ReturnType<typeof setInterval> | null = null;
  private _env: ReturnType<typeof setInterval> | null = null;

  /* ---- DataSource: lifecycle ------------------------------------------- */
  connect(config: ConnectionConfig): Promise<void> {
    this.config = config;
    this.start();
    this.connState = 'connected';
    this._emit('conn', this.connState);
    return Promise.resolve();
  }

  disconnect(): void {
    this.stop();
    this.connState = 'disconnected';
    this._emit('conn', this.connState);
  }

  /** Phase 3 drives the fault scenarios through this stable mock API. */
  setSimulationToggles(next: Partial<SimulationToggles>): void {
    if (next.simulateCharging && !this.simulationToggles.simulateCharging && !this.s.armed) {
      this.s.battery = Math.min(this.s.battery, 68);
    }
    if (next.simulateHostileDrone === false) this.hostileOverride = false;
    Object.assign(this.simulationToggles, next);
    this.lastAuxEmit = 0;
    this.log('warning', `Simulation rails updated: ${Object.entries(next).filter(([, on]) => on).map(([name]) => name).join(', ') || 'nominal'}`);
  }

  getSimulationToggles(): Readonly<SimulationToggles> {
    return this.simulationToggles;
  }

  /* high-frequency stick input — bypasses the ack path on purpose */
  setManualInput(v: ManualInput): void {
    Object.assign(this.manual, v);
  }

  /* ---- subscription API (DataSource-shaped) ---------------------------- */
  onTelemetry(cb: (t: Telemetry) => void): Unsubscribe {
    this.cbs.tel.push(cb);
    return () => this._off('tel', cb);
  }
  onTracking(cb: (t: TrackingStatus) => void): Unsubscribe {
    this.cbs.trk.push(cb);
    return () => this._off('trk', cb);
  }
  onStatusText(cb: (s: StatusText) => void): Unsubscribe {
    this.cbs.txt.push(cb);
    return () => this._off('txt', cb);
  }
  onAck(cb: (a: CommandAck) => void): Unsubscribe {
    this.cbs.ack.push(cb);
    return () => this._off('ack', cb);
  }
  onConnectionChange(cb: (s: ConnectionState) => void): Unsubscribe {
    this.cbs.conn.push(cb);
    cb(this.connState);
    return () => this._off('conn', cb);
  }
  /* mission channels (MissionDataSource) */
  onAnomaly(cb: (m: AnomalyMessage) => void): Unsubscribe {
    this.cbs.anom.push(cb);
    return () => this._off('anom', cb);
  }
  onMissionPlan(cb: (m: MissionPlanMessage) => void): Unsubscribe {
    this.cbs.plan.push(cb);
    return () => this._off('plan', cb);
  }
  onVerification(cb: (m: VerificationMessage) => void): Unsubscribe {
    this.cbs.verf.push(cb);
    return () => this._off('verf', cb);
  }
  onIncidentReport(cb: (m: IncidentReportMessage) => void): Unsubscribe {
    this.cbs.rept.push(cb);
    return () => this._off('rept', cb);
  }
  onObservation(cb: (m: ObservationMessage) => void): Unsubscribe {
    this.cbs.obs.push(cb);
    return () => this._off('obs', cb);
  }
  onCapabilities(cb: (m: CapabilitiesMessage) => void): Unsubscribe {
    this.cbs.caps.push(cb);
    cb(this.capabilitiesMessage());
    return () => this._off('caps', cb);
  }
  onReadiness(cb: (m: ReadinessMessage) => void): Unsubscribe {
    this.cbs.ready.push(cb);
    cb(this.readinessMessage());
    return () => this._off('ready', cb);
  }
  onHealthEvent(cb: (m: HealthEventMessage) => void): Unsubscribe {
    this.cbs.health.push(cb);
    return () => this._off('health', cb);
  }
  onRfEvent(cb: (m: RfEventMessage) => void): Unsubscribe {
    this.cbs.rf.push(cb);
    return () => this._off('rf', cb);
  }
  onSpectrum(cb: (m: SpectrumMessage) => void): Unsubscribe {
    this.cbs.spectrum.push(cb);
    return () => this._off('spectrum', cb);
  }
  onFleet(cb: (m: FleetMessage) => void): Unsubscribe {
    this.cbs.fleet.push(cb);
    return () => this._off('fleet', cb);
  }
  onTask(cb: (m: TaskMessage) => void): Unsubscribe {
    this.cbs.task.push(cb);
    // Tasks already raised this session are replayed so a late subscriber
    // (a panel mounted after the scenario beat) still sees them.
    this._scnTasks.forEach((task) => cb(this.taskMessage(task)));
    return () => this._off('task', cb);
  }
  onEnvelope(cb: (m: EnvelopeMessage) => void): Unsubscribe {
    this.cbs.envl.push(cb);
    return () => this._off('envl', cb);
  }
  onMode(cb: (m: ModeMessage) => void): Unsubscribe {
    this.cbs.mode.push(cb);
    cb(this.modeMessage()); // attendance is sticky state, like connection state
    return () => this._off('mode', cb);
  }
  onEscalation(cb: (m: EscalationMessage) => void): Unsubscribe {
    this.cbs.escl.push(cb);
    return () => this._off('escl', cb);
  }
  getVideoUrl(): string {
    return '';
  }

  private _off<K extends keyof Callbacks>(k: K, cb: unknown): void {
    const list = this.cbs[k] as Array<unknown>;
    this.cbs[k] = list.filter((f) => f !== cb) as Callbacks[K];
  }

  private _emit(k: 'tel', msg: Telemetry): void;
  private _emit(k: 'trk', msg: TrackingStatus): void;
  private _emit(k: 'txt', msg: StatusText): void;
  private _emit(k: 'ack', msg: CommandAck): void;
  private _emit(k: 'conn', msg: ConnectionState): void;
  private _emit(k: 'anom', msg: AnomalyMessage): void;
  private _emit(k: 'plan', msg: MissionPlanMessage): void;
  private _emit(k: 'verf', msg: VerificationMessage): void;
  private _emit(k: 'rept', msg: IncidentReportMessage): void;
  private _emit(k: 'obs', msg: ObservationMessage): void;
  private _emit(k: 'caps', msg: CapabilitiesMessage): void;
  private _emit(k: 'ready', msg: ReadinessMessage): void;
  private _emit(k: 'health', msg: HealthEventMessage): void;
  private _emit(k: 'rf', msg: RfEventMessage): void;
  private _emit(k: 'spectrum', msg: SpectrumMessage): void;
  private _emit(k: 'fleet', msg: FleetMessage): void;
  private _emit(k: 'task', msg: TaskMessage): void;
  private _emit(k: 'envl', msg: EnvelopeMessage): void;
  private _emit(k: 'mode', msg: ModeMessage): void;
  private _emit(k: 'escl', msg: EscalationMessage): void;
  private _emit(k: keyof Callbacks, msg: unknown): void {
    const list = this.cbs[k] as Array<(m: unknown) => void>;
    list.forEach((f) => f(msg));
  }

  private log(severity: Severity, text: string): void {
    this._emit('txt', {
      type: 'statusText', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, severity, text,
    });
  }

  private sensorHealth(): ObservationMessage['sensors'] {
    return {
      rgb: this.simulationToggles.simulateCameraFail ? 'failed' : 'ok',
      thermal: this.simulationToggles.simulateThermalFail ? 'failed' : 'ok',
      lidar: this.simulationToggles.simulateLidarFail ? 'failed' : 'ok',
    };
  }

  private batteryState(): Telemetry['battery'] {
    const t = this.simulationToggles;
    const charging = t.simulateCharging && !this.s.armed && this.s.battery < 99.5;
    const fault = t.simulateBatteryFault ? 'cell imbalance latched' : undefined;
    return {
      soc_pct: this.s.battery,
      voltage_v: this.s.voltage,
      current_a: charging ? -7.2 : this.s.current,
      cell_delta_v: t.simulateBatteryFault ? 0.18 : 0.018,
      temp_c: t.simulateBatteryFault ? 67 : 31,
      remaining_s: Math.max(0, Math.round((this.s.battery / 100) * 1500)),
      charge_state: fault ? 'fault' : charging ? 'charging' : this.s.armed ? 'discharging' : 'charged',
      ...(fault ? { fault } : {}),
      voltage: this.s.voltage,
      current: charging ? -7.2 : this.s.current,
      remaining: this.s.battery,
    };
  }

  private readinessMessage(): ReadinessMessage {
    const battery = this.batteryState();
    const sensors = this.sensorHealth();
    const reasons: string[] = [];
    if (battery.charge_state !== 'charged') reasons.push(`pack is ${battery.charge_state}`);
    if (battery.soc_pct < 80) reasons.push(`SoC ${battery.soc_pct.toFixed(0)}% is below 80% dispatch minimum`);
    if (battery.fault) reasons.push(battery.fault);
    if (this.simulationToggles.simulateNight && sensors.thermal !== 'ok') reasons.push('night mission requires healthy thermal');
    if (sensors.lidar !== 'ok') reasons.push('LiDAR unavailable: clutter routes require clear-band correction');
    if (this.simulationToggles.simulateGpsLoss) reasons.push('GPS denied: new missions refused');
    if (this.simulationToggles.simulateHostileDrone && !this.hostileOverride) reasons.push('hostile drone conflicts with site airspace');
    const eta = battery.charge_state === 'charging' ? Math.ceil(Math.max(0, 100 - battery.soc_pct) / 0.8) : 0;
    return {
      type: 'readiness', ts: now(), vehicleId: DEFAULT_VEHICLE_ID,
      ready: reasons.length === 0, reasons, eta_ready_s: eta,
    };
  }

  private capabilitiesMessage(): CapabilitiesMessage {
    return {
      type: 'capabilities', ts: now(), vehicleId: DEFAULT_VEHICLE_ID,
      profiles: [
        { profile: 'follow', min_standoff_m: 3, max_standoff_m: 15, max_speed_mps: 2, max_altitude_m: 45 },
        { profile: 'inspect', min_standoff_m: 4, max_standoff_m: 15, max_speed_mps: 4, max_altitude_m: 60 },
        { profile: 'survey', min_standoff_m: 5, max_standoff_m: 15, max_speed_mps: 6, max_altitude_m: 80 },
      ],
      sensors: ['rgb', 'thermal', 'lidar'], night_capable: true,
      max_sortie_s: 480, dispatch_min_soc_pct: 80,
    };
  }

  private currentRfEvents(): RfEventMessage[] {
    const t = this.simulationToggles;
    const events: RfEventMessage[] = [];
    if (t.simulateRfInterference) events.push({
      type: 'rfEvent', ts: now(), vehicleId: DEFAULT_VEHICLE_ID,
      source: 'sdr', kind: 'gnss_interference', band: 'L1', power_delta_db: 8.4,
      confidence: 0.94,
    });
    if (t.simulateHostileDrone) {
      const hostile = this.site?.staging[1] ?? this.site?.staging[0];
      const pilot = this.site?.staging[0] ?? this.site?.home;
      events.push({
        type: 'rfEvent', ts: now(), vehicleId: DEFAULT_VEHICLE_ID,
        source: 'rf_drone', kind: 'hostile_drone', band: '2.4 GHz',
        ...(hostile ? { lat: hostile.lat, lon: hostile.lon } : {}),
        ...(pilot ? { pilot_lat: pilot.lat, pilot_lon: pilot.lon } : {}),
        confidence: 0.91,
      });
    }
    return events;
  }

  /**
   * The runtime context BOTH the deterministic planner and the verifier judge
   * a plan with. It carries the fleet, the attendance mode and `now`, so the
   * real verifier produces its own `attended` and `deconfliction` checks
   * instead of having scripted stand-ins folded in over the top (FM-181), and
   * so RF reports age out of the airspace picture (FM-51).
   */
  private verifierContext(anomaly: Anomaly): VerificationContext {
    const peer = this.peerFleetVehicle();
    return {
      telemetry: {
        battery: this.batteryState(), navSource: this.simulationToggles.simulateGpsLoss ? 'optflow' : 'gps',
        position: { lat: this.s.lat, lon: this.s.lon, relAlt: this.s.relAlt },
      },
      battery: this.batteryState(),
      navSource: this.simulationToggles.simulateGpsLoss ? 'optflow' : 'gps',
      currentPosition: { lat: this.s.lat, lon: this.s.lon }, currentAltitudeM: this.s.relAlt,
      readiness: this.readinessMessage(),
      windMps: SCRIPTED_WIND_MPS, windSource: 'measured', anomaly,
      rfEvents: this.currentRfEvents(),
      sdrState: this.simulationToggles.simulateRfInterference ? 'degraded' : 'nominal',
      sensors: this.sensorHealth(), isNight: this.simulationToggles.simulateNight,
      maxSortieS: 480, dispatchMinSocPct: 80,
      mode: this.attendance,
      vehicleId: DEFAULT_VEHICLE_ID,
      fleet: [peer],
      fleetTs: now(),
      now: now(),
    };
  }

  private failureStatus(): { state: Telemetry['failsafeState']; reason: string } {
    const t = this.simulationToggles;
    if (this.s.phase === 'rtl' || this.s.phase === 'landing') {
      return {
        state: 'rtl',
        reason: t.simulateHostileDrone
          ? 'returning to launch; RTL supersedes hostile-drone hold'
          : 'return to launch active',
      };
    }
    if (t.simulateBatteryFault) return { state: this.s.armed ? 'rtl' : 'refuse', reason: 'battery pack fault' };
    if (t.simulateSortieExpiry) return { state: 'rtl', reason: 'sortie return deadline reached' };
    if (t.simulateGpsLoss && t.simulateRfInterference) return { state: 'escalate', reason: 'probable GNSS interference' };
    if (t.simulateHostileDrone && !this.hostileOverride) return {
      state: this.s.armed ? 'hold' : 'refuse', reason: 'hostile drone detected inside geofence',
    };
    if (t.simulateGpsLoss) return {
      state: this.s.armed ? 'hold' : 'refuse', reason: 'GPS denied; navigation source switched to optflow',
    };
    if (t.simulateLinkLoss) return { state: 'hold', reason: 'vehicle datalink lost' };
    if (t.simulateNight && t.simulateThermalFail && !this.s.armed) return { state: 'refuse', reason: 'thermal sensor required at night' };
    return { state: 'none', reason: '' };
  }

  private emitAuxiliary(telemetry: Telemetry): void {
    if (now() - this.lastAuxEmit < 1000) return;
    this.lastAuxEmit = now();
    const readiness = this.readinessMessage();
    const readinessSignature = JSON.stringify([readiness.ready, readiness.reasons, Math.ceil(readiness.eta_ready_s / 5)]);
    if (readinessSignature !== this.lastReadinessSignature || !this.s.armed) {
      this.lastReadinessSignature = readinessSignature;
      this._emit('ready', readiness);
    }
    const degradedSpectrum = this.simulationToggles.simulateRfInterference;
    this._emit('spectrum', {
      type: 'spectrum', ts: now(), vehicleId: DEFAULT_VEHICLE_ID,
      state: degradedSpectrum ? 'degraded' : 'nominal',
      bands: [
        { name: 'GNSS L1', floor_db: degradedSpectrum ? -82 : -101, p95_db: degradedSpectrum ? -74 : -95, peak_mhz: 1575.42, occ_bw_mhz: degradedSpectrum ? 1.8 : 0.2 },
        { name: 'ISM 2.4', floor_db: -94, p95_db: -83, peak_mhz: 2442, occ_bw_mhz: 18 },
      ],
    });
    this.currentRfEvents().forEach((event) => this._emit('rf', event));
    const sensors = this.sensorHealth();
    const failure = this.failureStatus();
    const health: HealthEventMessage[] = [
      { type: 'healthEvent', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, component: 'link', state: this.simulationToggles.simulateLinkLoss ? 'lost' : 'nominal', detail: this.simulationToggles.simulateLinkLoss ? 'heartbeat timeout; holding' : 'telemetry heartbeat nominal' },
      { type: 'healthEvent', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, component: 'planner', state: 'nominal', detail: 'planner heartbeat nominal' },
      { type: 'healthEvent', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, component: 'gps', state: this.simulationToggles.simulateGpsLoss ? 'denied' : 'nominal', detail: this.simulationToggles.simulateGpsLoss ? 'source switched to optflow' : '3D fix healthy' },
      { type: 'healthEvent', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, component: 'battery', state: this.simulationToggles.simulateBatteryFault ? 'fault' : telemetry.battery.charge_state, detail: this.simulationToggles.simulateBatteryFault ? 'cell imbalance and over-temperature' : `${telemetry.battery.soc_pct.toFixed(0)}% SoC` },
      { type: 'healthEvent', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, component: 'camera', state: sensors.rgb, detail: sensors.rgb === 'ok' ? 'RGB frames arriving' : 'RGB observation unavailable' },
      { type: 'healthEvent', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, component: 'thermal', state: sensors.thermal, detail: sensors.thermal === 'ok' ? 'thermal frames arriving' : 'thermal observation unavailable' },
      { type: 'healthEvent', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, component: 'lidar', state: sensors.lidar, detail: sensors.lidar === 'ok' ? 'geometry and proximity nominal' : 'avoidance degraded; clear-band altitude required' },
      { type: 'healthEvent', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, component: 'sdr', state: degradedSpectrum ? 'degraded' : 'nominal', detail: degradedSpectrum ? 'L1 floor rise exceeds threshold' : 'scripted receiver nominal' },
    ];
    const healthSignature = JSON.stringify(health.map((event) => [event.component, event.state, event.detail, failure.state]));
    if (healthSignature !== this.lastHealthSignature) {
      this.lastHealthSignature = healthSignature;
      health.forEach((event) => this._emit('health', event));
    }
    const primary: FleetVehicle = {
      vehicleId: DEFAULT_VEHICLE_ID,
      battery: telemetry.battery,
      controlSource: telemetry.controlSource,
      failsafe: failure,
      readiness: { ready: readiness.ready, reasons: readiness.reasons, eta_ready_s: readiness.eta_ready_s },
      position: {
        lat: telemetry.position.lat,
        lon: telemetry.position.lon,
        relAlt: telemetry.position.relAlt,
      },
      ...(this.mission?.plan.corridor ? { plannedCorridor: this.mission.plan.corridor } : {}),
      sortie: telemetry.sortie === null ? null : {
        elapsed_s: telemetry.sortie.elapsed_s,
        must_rtl_by: now() +
          Math.max(0, telemetry.sortie.must_rtl_by_s - telemetry.sortie.elapsed_s) * 1000,
      },
    };
    this._emit('fleet', {
      type: 'fleet', ts: now(), vehicleId: this.selectedVehicle,
      vehicles: [primary, this.peerFleetVehicle()],
    });
    this.publishFleetRows();
  }

  /* ---- second vehicle (ADR D26: two vehicles, star topology) ------------ */

  /** Where the peer sits when it is not flying: its own staging pad. */
  private peerAnchor(): { lat: number; lon: number } {
    const site = this.site;
    const pad = site?.staging[1] ?? site?.staging[0];
    return pad
      ? { lat: pad.lat, lon: pad.lon }
      : { lat: this.homeLat() + 0.0004, lon: this.homeLon() + 0.0004 };
  }

  /**
   * The peer's own cleared corridor, from the SAME deterministic planner the
   * primary vehicle's plans come from (FM-181) — the corridor the verifier's
   * `deconfliction` check separates against must be one the planner could
   * actually have produced.
   *
   * The peer's context is deliberately peer-free: a corridor is what a vehicle
   * was cleared for, and deriving it from a context that already contains the
   * peer would make each vehicle's corridor depend on the other's.
   */
  private ensurePeerPlan(): MissionPlan | null {
    if (this.peer.plan) return this.peer.plan;
    const site = this.site;
    if (!site) return null;
    const anchor = this.peerAnchor();
    const cue: Anomaly = {
      id: `peer-${site.staging[1]?.id ?? 'stage'}`,
      lat: anchor.lat, lon: anchor.lon,
      type: 'patrol', confidence: 0.5, thumbnail: '', source: 'drone_survey',
      observedAt: now(), ttl_s: SCRIPTED_CUE_TTL_S,
    };
    const task: Task = {
      taskId: `task-${cue.id}`, anomalyId: cue.id, lookFor: 'unknown',
      question: `What is at the ${cue.source} cue ${cue.id}?`,
      urgency: 'next_sortie', priority: 0.5,
      rationale: 'Peer patrol pass; the corridor this vehicle is cleared for.',
      source: 'scripted', assignedTo: PEER_VEHICLE_ID,
    };
    // Built inline rather than from `verifierContext()`: that helper embeds the
    // peer's own fleet row, which would recurse straight back into this method.
    const context: VerificationContext = {
      navSource: 'gps',
      battery: this.peerBatteryState(),
      readiness: { ready: true, reasons: [] },
      currentPosition: { lat: this.peer.lat, lon: this.peer.lon },
      currentAltitudeM: this.peer.relAlt,
      windMps: SCRIPTED_WIND_MPS, windSource: 'measured',
      anomaly: cue, rfEvents: [], sdrState: 'nominal',
      sensors: { rgb: 'ok', thermal: 'ok', lidar: 'ok' }, isNight: false,
      maxSortieS: 480, dispatchMinSocPct: 80,
      mode: 'attended', vehicleId: PEER_VEHICLE_ID, fleet: [], now: now(),
    };
    const outcome = planMission({ task, anomaly: cue, site, context });
    if (outcome.infeasible) return null;
    this.peer.plan = withCorridorAndTrace(outcome.plan, site);
    return this.peer.plan;
  }

  private peerBatteryState(): Telemetry['battery'] {
    return {
      soc_pct: this.peer.battery,
      voltage_v: 14.0 + (this.peer.battery / 100) * 2.8,
      current_a: this.peer.armed ? 16 : 0.4,
      cell_delta_v: 0.02,
      temp_c: 29,
      remaining_s: Math.max(0, Math.round((this.peer.battery / 100) * 1500)),
      charge_state: this.peer.armed ? 'discharging' : 'charged',
      voltage: 14.0 + (this.peer.battery / 100) * 2.8,
      current: this.peer.armed ? 16 : 0.4,
      remaining: this.peer.battery,
    };
  }

  private peerFleetVehicle(): FleetVehicle {
    const ready = this.peer.battery >= 80 && !this.peer.armed;
    const corridor = this.peer.flying ? this.ensurePeerPlan()?.corridor : undefined;
    const elapsed = this.peer.sortieStartedAt === null
      ? 0 : Math.max(0, (now() - this.peer.sortieStartedAt) / 1000);
    return {
      vehicleId: PEER_VEHICLE_ID,
      battery: this.peerBatteryState(),
      controlSource: this.peer.manualActive ? 'manual' : this.peer.flying ? 'planner' : 'auto',
      failsafe: { state: 'none', reason: '' },
      readiness: {
        ready,
        reasons: ready ? [] : this.peer.armed
          ? ['on a sortie']
          : [`SoC ${this.peer.battery.toFixed(0)}% is below 80% dispatch minimum`],
        eta_ready_s: 0,
      },
      position: { lat: this.peer.lat, lon: this.peer.lon, relAlt: this.peer.relAlt },
      ...(corridor ? { plannedCorridor: corridor } : {}),
      sortie: this.peer.sortieStartedAt === null ? null : {
        elapsed_s: elapsed,
        must_rtl_by: this.peer.sortieStartedAt + 420_000,
      },
    };
  }

  private fleetRows(): FleetRow[] {
    const row = (v: FleetVehicle, mode: Mode): FleetRow => ({
      vehicleId: v.vehicleId,
      status: v.controlSource === 'manual' ? 'manual_control'
        : v.controlSource === 'planner' ? 'on_mission'
        : v.failsafe.state === 'rtl' ? 'returning' : 'idle',
      batteryPct: v.battery.soc_pct,
      altM: v.position.relAlt,
      mode,
    });
    const primary: FleetVehicle = {
      vehicleId: DEFAULT_VEHICLE_ID,
      battery: this.batteryState(),
      controlSource: this.manual.active ? 'manual' : this.plannerActive ? 'planner'
        : this.track.state === 'locked' ? 'tracking' : 'auto',
      failsafe: this.failureStatus(),
      readiness: { ready: true, reasons: [], eta_ready_s: 0 },
      position: { lat: this.s.lat, lon: this.s.lon, relAlt: this.s.relAlt },
      sortie: null,
    };
    return [row(primary, this.s.mode), row(this.peerFleetVehicle(), this.peer.mode)];
  }

  private publishFleetRows(): void {
    if (this.fleetRowCbs.length === 0) return;
    const rows = this.fleetRows();
    this.fleetRowCbs.forEach((cb) => cb(rows));
  }

  /* ---- fleet selection (FleetCapable — beyond the frozen contract) ------ */

  onFleetRows(cb: (rows: FleetRow[]) => void): () => void {
    this.fleetRowCbs.push(cb);
    cb(this.fleetRows());
    return () => { this.fleetRowCbs = this.fleetRowCbs.filter((f) => f !== cb); };
  }

  /** Follow another vehicle: telemetry AND the command target switch. */
  setVehicle(id: string): void {
    if (this.selectedVehicle === id) return;
    this.selectedVehicle = id;
    this.log('info', `Ground station now following ${id}`);
    this._emit('tel', id === PEER_VEHICLE_ID ? this.peerTelemetry() : this.primaryTelemetry());
  }

  getVehicle(): string {
    return this.selectedVehicle;
  }

  /** Peer kinematics: parked on its pad, or orbiting its own observation
   *  point after a handoff. Deterministic, so the demo replays identically. */
  private stepPeer(dt: number): void {
    const anchor = this.peerAnchor();
    if (!this.peer.flying) {
      this.peer.lat = anchor.lat;
      this.peer.lon = anchor.lon;
      this.peer.relAlt = 0;
      this.peer.mode = this.peer.armed ? 'GUIDED' : 'LOITER';
      return;
    }
    // Altitude and radius come from the peer's OWN cleared corridor, so the
    // monitor sees it comfortably inside its envelope rather than riding the
    // tolerance edge on numbers picked here.
    const corridor = this.ensurePeerPlan()?.corridor;
    const targetAlt = corridor
      ? (corridor.alt_band_m.min + corridor.alt_band_m.max) / 2
      : 35;
    this.peer.mode = this.peer.manualActive ? 'STABILIZE' : 'GUIDED';
    this.peer.relAlt = lerp(this.peer.relAlt, targetAlt, 0.04);
    if (this.peer.manualActive) {
      this.peer.battery = clamp(this.peer.battery - 0.006 * dt * 10, 0, 100);
      return;
    }
    const radius = corridor?.orbits[0]?.radius_m ?? 30;
    const cosLat = Math.cos((this.homeLat() * Math.PI) / 180);
    this.peer.theta += (PROFILE_SPEED_MPS.inspect * MISSION_TIME_SCALE * dt) / radius;
    const e = radius * Math.cos(this.peer.theta);
    const n = radius * Math.sin(this.peer.theta);
    this.peer.lat = anchor.lat + n / M_PER_DEG_LAT;
    this.peer.lon = anchor.lon + e / (M_PER_DEG_LAT * cosLat);
    this.peer.heading = ((Math.atan2(-e, -n) * 180) / Math.PI + 360) % 360;
    this.peer.battery = clamp(this.peer.battery - 0.008 * dt * 10, 0, 100);
    const last = this.peer.trail[this.peer.trail.length - 1];
    if (!last || Math.abs(last.lat - this.peer.lat) > 1e-5 || Math.abs(last.lon - this.peer.lon) > 1e-5) {
      this.peer.trail = [...this.peer.trail.slice(-120), { lat: this.peer.lat, lon: this.peer.lon }];
    }
  }

  /** Telemetry frame for the peer, used when the operator follows it. */
  private peerTelemetry(): Telemetry {
    const dLat = (this.peer.lat - this.homeLat()) * M_PER_DEG_LAT;
    const dLon = (this.peer.lon - this.homeLon()) * M_PER_DEG_LAT *
      Math.cos((this.homeLat() * Math.PI) / 180);
    const elapsed = this.peer.sortieStartedAt === null
      ? 0 : Math.max(0, (now() - this.peer.sortieStartedAt) / 1000);
    return {
      type: 'telemetry',
      ts: now(),
      vehicleId: PEER_VEHICLE_ID,
      armed: this.peer.armed,
      mode: this.peer.mode,
      controlSource: this.peer.manualActive ? 'manual' : this.peer.flying ? 'planner' : 'auto',
      navSource: 'gps',
      gpsHealth: { fix: 3, sats: 15, hdop: 0.8 },
      failsafeState: 'none',
      failsafeReason: '',
      attitude: { roll: 0, pitch: this.peer.flying ? -3 : 0, yaw: this.peer.heading },
      position: { lat: this.peer.lat, lon: this.peer.lon, relAlt: this.peer.relAlt, absAlt: this.peer.relAlt + 32 },
      velocity: {
        groundspeed: this.peer.flying && !this.peer.manualActive ? PROFILE_SPEED_MPS.inspect : 0,
        verticalSpeed: 0,
      },
      heading: this.peer.heading,
      battery: this.peerBatteryState(),
      gps: { fixType: 3, satellites: 15, hdop: 0.8 },
      sortie: this.peer.sortieStartedAt === null
        ? null : { elapsed_s: elapsed, cap_s: 480, must_rtl_by_s: 420 },
      home: { lat: this.homeLat(), lon: this.homeLon(), distance: Math.hypot(dLat, dLon) },
      link: { rssi: -52, latencyMs: 44 },
      gimbal: { pitchDeg: this.gimbalPitchDeg },
    };
  }

  /* ---- Phase 1 rails: tasking, envelope, attendance, escalation --------- */

  private taskMessage(task: Task): TaskMessage {
    return { type: 'task', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, task };
  }

  private modeMessage(): ModeMessage {
    return {
      type: 'mode',
      ts: now(),
      vehicleId: DEFAULT_VEHICLE_ID,
      mode: this.attendance,
      since: this.attendanceSince,
      // Unattended mode is entered deliberately by a signed command, never by
      // losing the operator; `operatorPresent` is the independent liveness
      // signal the operator-absent beat drives.
      operatorPresent: this.operatorPresent,
    };
  }

  private setAttendance(mode: AttendanceMode): void {
    if (this.attendance === mode) return;
    this.attendance = mode;
    this.attendanceSince = now();
    this._emit('mode', this.modeMessage());
  }

  /** The scripted triage tasks raised for the flagged anomaly. A task names
   *  WHAT to look for and WHY — never a coordinate (beyond `anomalyId`), a
   *  tool or an altitude, so the planner remains the only producer of
   *  geometry. This is exactly the surface an LLM would be allowed to emit. */
  private scriptedTasksFor(anomaly: Anomaly): Task[] {
    // Task ids are stable across triage runs: a re-run UPDATES the same three
    // tasks (so the operator's ordering survives) rather than piling up a
    // second copy of the queue.
    const note = this.operatorNote.trim();
    const noted = (text: string): string =>
      note ? `${text} Operator note carried into this run: "${note}".` : text;
    const spec: Array<{ id: string; lookFor: TaskLookFor; question: string; urgency: Task['urgency']; priority: number; why: string }> = [
      {
        id: 'primary',
        lookFor: anomaly.type === 'change' ? 'vehicle' : 'unknown',
        question: 'Is there a vehicle at the flagged change, and is the fence intact?',
        urgency: anomaly.confidence >= 0.8 ? 'immediate' : 'next_sortie',
        priority: clamp(anomaly.confidence, 0, 1),
        why: `Change detection flagged ${anomaly.id} at ${(anomaly.confidence * 100).toFixed(0)}% confidence.`,
      },
      {
        id: 'fence',
        lookFor: 'fence_gap',
        question: 'Is the perimeter fence continuous either side of the flagged change?',
        urgency: 'next_sortie',
        priority: clamp(anomaly.confidence * 0.75, 0, 1),
        why: 'A change adjacent to the perimeter is worth a continuity pass even if the first look is clean.',
      },
      {
        id: 'structure',
        lookFor: 'structure',
        question: 'Has anything been built or placed at the flagged location since the baseline?',
        urgency: 'defer',
        priority: clamp(anomaly.confidence * 0.5, 0, 1),
        why: 'Baseline comparison is cheap to answer on the same sortie and closes the cue.',
      },
    ];
    return spec.map((entry) => ({
      taskId: `task-${anomaly.id}-${entry.id}`,
      anomalyId: anomaly.id,
      lookFor: entry.lookFor,
      question: entry.question,
      urgency: entry.urgency,
      priority: entry.priority,
      rationale: noted(entry.why),
      source: 'scripted',
      assignedTo: DEFAULT_VEHICLE_ID,
    }));
  }

  private emitTasks(tasks: Task[]): void {
    this._scnTasks = [...this._scnTasks.filter((t) => !tasks.some((n) => n.taskId === t.taskId)), ...tasks];
    this._scnTask = tasks[0] ?? this._scnTask;
    tasks.forEach((task) => this._emit('task', this.taskMessage(task)));
  }

  /* ---- envelope monitor -------------------------------------------------
   * Reads position, altitude and the CLEARED CORRIDOR, and nothing that
   * guidance or the planner owns. Nothing in this class can switch it off:
   * the mission stepper asks it (`envelopeHold`) rather than the other way
   * round, and only the monitor's own hysteresis clears a breach. */

  /**
   * The constraints the monitor weighs. The corridor and its altitude band
   * apply only to a vehicle flying a CLEARED PLAN — a manual or tracking
   * flight is not inside a corridor and must not be reported as breaching one.
   * The geofence always applies.
   */
  private envelopeCandidates(
    pos: { lat: number; lon: number },
    relAlt: number,
    corridor?: Corridor,
    altitudeArmed = true,
  ): Array<{ constraint: EnvelopeConstraint; marginM: number; toleranceM: number }> {
    const out: Array<{ constraint: EnvelopeConstraint; marginM: number; toleranceM: number }> = [];
    if (corridor) {
      const m = corridorMargin(pos, corridor);
      if (m.element !== 'none') {
        out.push({ constraint: 'corridor', marginM: m.marginM, toleranceM: m.toleranceM });
      }
      // The altitude check ARMS on first entry into the band: a vehicle still
      // climbing to its cleared band has not left it.
      if (altitudeArmed) {
        out.push({
          constraint: 'altitude',
          marginM: Math.min(relAlt - corridor.alt_band_m.min, corridor.alt_band_m.max - relAlt),
          toleranceM: 5,
        });
      }
    }
    const site = this.site;
    if (site) {
      const inside = pointInPolygon(pos, site.perimeter);
      const d = distancePointToPolygonMeters(pos, site.perimeter);
      out.push({ constraint: 'geofence', marginM: inside ? d : -d, toleranceM: 10 });
    }
    return out;
  }

  /** 5 Hz envelope report while airborne, for both vehicles. */
  private stepEnvelope(): void {
    if (!this._started) return;
    if (this.peer.flying && this.peer.relAlt > 0.5) {
      const corridor = this.ensurePeerPlan()?.corridor;
      const peerArmed = !!corridor &&
        this.peer.relAlt >= corridor.alt_band_m.min && this.peer.relAlt <= corridor.alt_band_m.max;
      const peerCandidates = this.envelopeCandidates(
        { lat: this.peer.lat, lon: this.peer.lon }, this.peer.relAlt, corridor, peerArmed,
      );
      const peerBinding = peerCandidates.reduce<{ constraint: EnvelopeConstraint; marginM: number; toleranceM: number } | null>(
        (best, c) => (best === null || c.marginM < best.marginM ? c : best), null,
      );
      if (peerBinding) {
        this._emit('envl', {
          type: 'envelope', ts: now(), vehicleId: PEER_VEHICLE_ID,
          state: peerBinding.marginM >= 0 ? 'in_envelope' : 'warning',
          constraint: peerBinding.constraint,
          margin_m: Math.round(peerBinding.marginM * 10) / 10,
          action: peerBinding.marginM >= 0 ? 'none' : 'slow',
        });
      }
    }

    if (this.s.relAlt <= 0.5) {
      if (this.envelopeState !== 'in_envelope') {
        this.envelopeState = 'in_envelope';
        this.envelopeHold = false;
      }
      return;
    }

    const corridor = this.mission?.plan.corridor;
    if (corridor && !this.envelopeArmed &&
        this.s.relAlt >= corridor.alt_band_m.min && this.s.relAlt <= corridor.alt_band_m.max) {
      this.envelopeArmed = true;
    }
    const candidates = this.envelopeCandidates(
      { lat: this.s.lat, lon: this.s.lon }, this.s.relAlt, corridor, this.envelopeArmed,
    );
    const binding = candidates.reduce<{ constraint: EnvelopeConstraint; marginM: number; toleranceM: number } | null>(
      (best, c) => (best === null || c.marginM < best.marginM ? c : best), null,
    );
    if (!binding) return;

    // Hysteresis: a condition clears only once the measurement is back inside
    // the tolerance BY A MARGIN, so a vehicle riding the edge cannot flap.
    const clearAt = binding.toleranceM * 0.2;
    let state: EnvelopeState;
    if (binding.marginM < -binding.toleranceM) state = 'breach';
    else if (binding.marginM < 0) state = 'warning';
    else if (this.envelopeState !== 'in_envelope' && binding.marginM < clearAt) state = 'warning';
    else state = 'in_envelope';

    const action: EnvelopeAction = state === 'breach'
      ? (binding.constraint === 'geofence' || binding.constraint === 'nfz' ? 'rtl' : 'hold')
      : state === 'warning' ? 'slow' : 'none';

    if (state !== this.envelopeState) {
      this.envelopeState = state;
      this.envelopeSince = now();
      this.log(state === 'breach' ? 'critical' : state === 'warning' ? 'warning' : 'info',
        state === 'in_envelope'
          ? `Envelope recovered — inside the ${binding.constraint} tolerance`
          : `Envelope ${state.toUpperCase()} on ${binding.constraint}: ` +
            `${binding.marginM.toFixed(1)} m of margin → ${action}`);
    }
    this.envelopeHold = state === 'breach' && action === 'hold';

    // A breach that persists escalates (ADR D22) — once per breach.
    if (state === 'breach' && !this.envelopeEscalated && now() - this.envelopeSince > 5000) {
      this.envelopeEscalated = true;
      this.raiseEscalation(
        this.mission?.plan.requestId ?? 'no-mission',
        'envelope_breach_persisted',
        {
          constraint: binding.constraint,
          margin_m: Math.round(binding.marginM * 10) / 10,
          heldForS: Math.round((now() - this.envelopeSince) / 1000),
        },
      );
    }
    if (state === 'in_envelope') this.envelopeEscalated = false;

    this._emit('envl', {
      type: 'envelope',
      ts: now(),
      vehicleId: DEFAULT_VEHICLE_ID,
      state,
      constraint: binding.constraint,
      margin_m: Math.round(binding.marginM * 10) / 10,
      action,
    });
  }

  /** Monitor-commanded back-off after a hold: creep back to the nearest point
   *  of the cleared corridor. Not a plan and not a guidance setpoint. */
  private stepEnvelopeBackoff(dt: number): boolean {
    if (!this.envelopeHold || this.gust) return false;
    const corridor = this.mission?.plan.corridor;
    if (!corridor) return false;
    const target = nearestCorridorPoint({ lat: this.s.lat, lon: this.s.lon }, corridor);
    if (!target) return false;
    this.moveToward(target.lat, target.lon, 2.5 * MISSION_TIME_SCALE * dt);
    this.s.groundspeed = 2.5;
    this.s.vspeed = 0;
    return true;
  }

  /** Escalation raised on the scripted channel: appended to the local outbox
   *  and the audit trail. It never contacts anyone outside the site. */
  private raiseEscalation(
    missionId: string,
    reason: string,
    payload: Record<string, unknown> = {},
  ): void {
    const escalation: EscalationMessage = {
      type: 'escalation',
      ts: now(),
      vehicleId: DEFAULT_VEHICLE_ID,
      missionId,
      channel: 'console',
      payload: {
        reason,
        attendance: this.attendance,
        operatorPresent: this.operatorPresent,
        ...payload,
      },
      deliveredAt: now(),
    };
    this._emit('escl', escalation);
    this.log('critical', `Escalation raised for ${missionId}: ${reason.replace(/_/g, ' ')}`);
  }

  /* ---- mission scenario (anomaly → plans → verifications) --------------- */

  /** Home point: from the loaded site when available. */
  private homeLat(): number { return this.site?.home.lat ?? HOME.lat; }
  private homeLon(): number { return this.site?.home.lon ?? HOME.lon; }

  /** First sight of the site model: remember it and respawn the idle vehicle
   *  at the SITE home so all mission geometry coheres. */
  private adoptSite(site: SiteModel): void {
    if (this.site) return;
    this.site = site;
    if (this.s.phase === 'idle' && !this.s.armed) {
      this.s.lat = site.home.lat;
      this.s.lon = site.home.lon;
    }
    this.startCueRails();
  }

  /* ---- cue rails (eis-cues CueBus) -------------------------------------- *
   * Every rail behind ONE bus, onto the two wire messages the UI already
   * speaks (FM-180). The bus adds no message type: `anomaly` reaches the map
   * and the cue list exactly as the scripted scenario's own cue does, and
   * `healthEvent` drives the rail badges.
   *
   * `sentinel2` is deliberately NOT wired here: the scripted mission scenario
   * IS the optical rail's replay, re-anchored to the loaded site, and wiring
   * the fixture as well would raise the same cue twice at two coordinates. */
  private cueBus: CueBus | null = null;
  private cueRailHealth = new Map<RailId, RailHealth>();

  private startCueRails(): void {
    if (this.cueBus) return;
    const bus = createRendererCueBus({
      vehicleId: DEFAULT_VEHICLE_ID,
      site: getRawSite(),
      rails: ['sar', 'sdr', 'rf_drone', 'cctv', 'fence_sensor', 'drone_survey'],
    });
    this.cueBus = bus;
    bus.onAnomaly((m) => {
      this._emit('anom', m);
      this.log('warning',
        `${RAIL_LABEL[m.anomaly.source as RailId] ?? m.anomaly.source} cue ${m.anomaly.id} ` +
        `(${m.anomaly.type}, conf ${(m.anomaly.confidence * 100).toFixed(0)}%)`);
    });
    bus.onHealth((m) => {
      this._emit('health', m);
      this.refreshRailHealth();
    });
    bus.onRejection((reason, m) => {
      this.log(reason === 'budget' ? 'warning' : 'info',
        `Cue ${m.anomaly.id} from ${m.anomaly.source} refused by the bus: ${reason}`);
    });
    void bus.start().then(() => this.refreshRailHealth());
  }

  private refreshRailHealth(): void {
    for (const health of this.cueBus?.health() ?? []) this.cueRailHealth.set(health.rail, health);
  }

  /** Per-rail badges: what each cue rail is doing right now. */
  railHealth(): RailHealth[] {
    this.refreshRailHealth();
    return [...this.cueRailHealth.values()];
  }

  private scheduleScenario(): void {
    if (this._scnDone || this._scnTimer) return;
    if (this._scnStep >= SCENARIO_DELAYS_MS.length) { this._scnDone = true; return; }
    this._scnTimer = setTimeout(() => {
      this._scnTimer = null;
      void this.runScenarioStep();
    }, SCENARIO_DELAYS_MS[this._scnStep]);
  }

  private async runScenarioStep(): Promise<void> {
    try {
      this.adoptSite(await getSiteModel());
      const site = this.site;
      if (!site) throw new Error('site model unavailable');
      const step = this._scnStep;

      if (step === 0) {
        const anomaly = this.deriveAnomaly(site);
        this._scnAnomaly = anomaly;
        this._emit('anom', {
          type: 'anomaly', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, anomaly,
        });
        this.log('warning',
          `Satellite change detection flagged ${anomaly.id} (${anomaly.type}, ` +
          `conf ${(anomaly.confidence * 100).toFixed(0)}%)`);
        // The triage tasks follow the cue on the same beat: the operator sees
        // WHAT is being asked before any plan proposes HOW to answer it.
        const tasks = this.scriptedTasksFor(anomaly);
        this.emitTasks(tasks);
        this.log('info', `Triage raised ${tasks.length} task(s); top: ${tasks[0].question}`);
      } else if (step === 1) {
        if (this._scnAnomaly && site.nfz.length > 0) {
          this._scnFailing = this.dressPlan(this.planner.failingPlan(site, this._scnAnomaly), site);
          this._emit('plan', {
            type: 'missionPlan', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, plan: this._scnFailing,
          });
          this.log('info', `Planner proposed mission ${this._scnFailing.requestId}`);
        }
      } else if (step === 2) {
        if (this._scnFailing) {
          const v = this.dressVerification(
            verifyMission(this._scnFailing, site, this.verifierContext(this._scnAnomaly ?? this.deriveAnomaly(site))),
          );
          this._emit('verf', {
            type: 'verification', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, verification: v,
          });
          this.log(v.verdict === 'rejected' ? 'error' : 'warning',
            `MissionVerifier: ${this._scnFailing.requestId} → ${v.verdict.toUpperCase()}`);
        }
      } else if (step === 3) {
        if (this._scnAnomaly) {
          const proposal = await this.proposePlan(
            site, this._scnAnomaly, this._scnTasks[0] ?? this.scriptedTasksFor(this._scnAnomaly)[0]);
          if (proposal) {
            this._scnPassing = proposal.plan;
            this._scnPassingVerification = proposal.verification;
            this._emit('plan', {
              type: 'missionPlan', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, plan: proposal.plan,
            });
            this.log('info', `Planner proposed mission ${proposal.plan.requestId}`);
          }
        }
      } else if (step === 4) {
        if (this._scnPassing && this._scnPassingVerification) {
          const v = this._scnPassingVerification;
          this._emit('verf', {
            type: 'verification', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, verification: v,
          });
          this.log('info',
            `MissionVerifier: ${this._scnPassing.requestId} → ${v.verdict.toUpperCase()} — awaiting operator approval`);
        }
      }
      this._scnStep = step + 1;
    } catch (err) {
      this.log('error', `Mission scenario error: ${(err as Error).message}`);
      this._scnDone = true;
      return;
    }
    if (this._started) this.scheduleScenario();
  }

  /** The baked eis-satellite anomaly, re-anchored to the loaded site when the
   *  baked data is stale (its tiles were generated from an older site file). */
  private deriveAnomaly(site: SiteModel): Anomaly {
    const baked = (bakedAnomalies as Anomaly[])[0];
    const coherent =
      baked &&
      pointInPolygon({ lat: baked.lat, lon: baked.lon }, site.perimeter) &&
      site.staging.some((sp) => haversineMeters(sp, baked) < 100);
    // Cue freshness: the baked tiles carry no observation time, so the mock
    // stamps the cue as observed now with an explicit TTL rather than leaving
    // consumers to guess whether a stale cue is still dispatchable.
    const freshness = { observedAt: now(), ttl_s: SCRIPTED_CUE_TTL_S };
    if (coherent) return { ...baked, source: baked.source ?? 'sentinel2', ...freshness };
    const anchor = site.staging[0] ??
      { lat: (site.home.lat + site.perimeter[0].lat) / 2, lon: (site.home.lon + site.perimeter[0].lon) / 2 };
    return {
      id: baked?.id ?? 'sat-change-1',
      lat: anchor.lat,
      lon: anchor.lon,
      type: baked?.type ?? 'change',
      confidence: baked?.confidence ?? 0.9,
      thumbnail: baked?.thumbnail ?? '',
      source: baked?.source ?? 'sentinel2',
      ...freshness,
    };
  }

  /* ---- scripted demo rails --------------------------------------------- *
   * Everything below drives the OFFLINE demo. Plans always come from the
   * deterministic planner in ground/planner and verdicts always come from the
   * real MissionVerifier; these methods only decide WHEN a beat happens and
   * under WHAT conditions, never what geometry is flown. */

  /**
   * The plan the operator is shown, from the DETERMINISTIC planner and the
   * REAL verifier (FM-181).
   *
   * Inside the Electron shell the host's `planner:propose` runs exactly this
   * pipeline in the main process, so it is preferred; in the browser dev
   * server the same `planMission` + `verifyMission` run in-process. Either way
   * `ScriptedPlanner` is not involved: its only remaining job is the
   * deliberately-invalid plan the verifier must refuse (DEMO_RUNBOOK R1).
   *
   * Returns null when the rule table refuses the task — an infeasible task has
   * no plan to show, and inventing one to display would be the whole point of
   * having a deterministic planner thrown away.
   */
  private async proposePlan(site: SiteModel, anomaly: Anomaly, task: Task, requestId?: string):
  Promise<{ plan: MissionPlan; verification: Verification } | null> {
    const context = this.verifierContext(anomaly);
    const bridge = window.eis?.plannerPropose;
    if (bridge) {
      const result = await bridge({
        vehicleId: DEFAULT_VEHICLE_ID, anomaly,
        capabilities: this.capabilitiesMessage(), context,
      });
      if (result.escalationReason) this.log('error', result.escalationReason);
      if (!result.plan || !result.verification) {
        this.log('error',
          `Planner refused the task: ${result.infeasibleReason ?? 'no plan was produced'}`);
        return null;
      }
      const plan = requestId ? { ...result.plan, requestId } : result.plan;
      return {
        plan: this.dressPlan(plan, site),
        verification: this.dressVerification({ ...result.verification, requestId: plan.requestId }),
      };
    }
    const outcome = planMission({ task, anomaly, site, context, ...(requestId ? { requestId } : {}) });
    if (outcome.infeasible) {
      this.log('error', `Planner refused the task: ${outcome.reason}`);
      return null;
    }
    const plan = this.dressPlan(outcome.plan, site);
    return { plan, verification: this.dressVerification(verifyMission(plan, site, context)) };
  }

  /** Attach the corridor + rule trace, for a plan that does not carry its own.
   *  The deterministic planner emits both, so this is a no-op for its output
   *  and only dresses the scripted bad-plan demo rail. Geometry is untouched. */
  private dressPlan(plan: MissionPlan, site: SiteModel): MissionPlan {
    return withCorridorAndTrace(plan, site, this._scnTasks[0] ?? null);
  }

  /**
   * The verifier now produces `attended` and `deconfliction` itself, from the
   * fleet and attendance mode in `verifierContext` (FM-181), so its verdict is
   * passed through unchanged. The one thing it cannot know is whether a HUMAN
   * is at the console: attendance mode is the vehicle's, operator presence is
   * the ground station's, and an attended mission whose operator has walked
   * away has an approval that has expired. That single rule is overlaid here,
   * and it can only ever make a verdict stricter.
   */
  private dressVerification(v: Verification): Verification {
    if (this.attendance !== 'attended' || this.operatorPresent) return v;
    const checks = v.checks.map((check) => check.name === 'attended'
      ? {
          name: 'attended', ok: false,
          reason: 'operator is not present and the mission is attended — approval has expired',
        }
      : check);
    return { ...v, checks, verdict: 'rejected', correctedPlan: undefined, holdUntil: undefined };
  }

  /** Re-run triage. The operator's note is carried into the task rationale —
   *  it never becomes geometry, a tool or an altitude. */
  runTriage(note: string): void {
    this.operatorNote = note;
    const anomaly = this._scnAnomaly;
    if (!anomaly) {
      this.log('warning', 'Triage has nothing to run on — no cue has been raised yet');
      return;
    }
    this.triageRuns += 1;
    const tasks = this.scriptedTasksFor(anomaly);
    this.emitTasks(tasks);
    this.log('info',
      `Triage re-run ${this.triageRuns} for ${anomaly.id}` +
      (note.trim() ? ` with operator note: "${note.trim()}"` : ''));
  }

  /**
   * The operator dragged the cue somewhere else on the map. The provider
   * RE-PLANS from the moved cue through the deterministic planner and the
   * real verifier; the UI never edits a plan. Dropping the cue inside the
   * switchyard no-fly zone is exactly the case the verifier must refuse.
   */
  moveAnomaly(anomalyId: string, lat: number, lon: number): void {
    const site = this.site;
    if (!site) return;
    if (!this._scnAnomaly || this._scnAnomaly.id !== anomalyId) return;
    const moved: Anomaly = { ...this._scnAnomaly, lat, lon, observedAt: now() };
    this._scnAnomaly = moved;
    this._emit('anom', { type: 'anomaly', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, anomaly: moved });
    const zone = site.nfz.find((z) => pointInPolygon(moved, z.polygon));
    this.log('warning',
      `Operator moved cue ${moved.id}${zone ? ` into no-fly zone "${zone.name}"` : ''} — re-planning`);

    this.replans += 1;
    const task = this._scnTasks[0] ?? this.scriptedTasksFor(moved)[0];
    // requestId is ground-side correlation ONLY (ADR D7): suffixing it keeps
    // each re-plan a distinct proposal in the verifier panel's history.
    const requestId = `plan-${task.taskId}-replan-${this.replans}`;
    void this.proposePlan(site, moved, task, requestId).then((proposal) => {
      if (!proposal) {
        this.raiseEscalation(requestId, 'plan_refused_after_operator_move', { anomalyId: moved.id });
        return;
      }
      const { plan, verification } = proposal;
      this._emit('plan', { type: 'missionPlan', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, plan });
      this._emit('verf', {
        type: 'verification', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, verification,
      });
      this.log(verification.verdict === 'rejected' ? 'error' : 'info',
        `MissionVerifier: ${plan.requestId} → ${verification.verdict.toUpperCase()}` +
        (verification.verdict === 'rejected'
          ? ` (${verification.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')})`
          : ''));
      if (verification.verdict === 'rejected') {
        this.raiseEscalation(plan.requestId, 'plan_refused_after_operator_move', {
          anomalyId: moved.id,
          failedChecks: verification.checks.filter((c) => !c.ok).map((c) => c.name),
        });
      }
    });
  }

  /** One scripted beat. Each is a real condition, never a doctored readout. */
  runScenario(name: DemoScenario): void {
    switch (name) {
      case 'gust': {
        if (!this.plannerActive || !this.mission?.plan.corridor) {
          this.log('warning', 'Gust needs a mission executing inside a cleared corridor');
          return;
        }
        this.gust = {
          startedAt: now(),
          bearingRad: ((this.s.heading + 90) * Math.PI) / 180,
        };
        this.log('warning',
          `Scripted gust: ${GUST_DRIFT_MPS.toFixed(1)} m/s of lateral disturbance for ` +
          `${(GUST_DURATION_MS / 1000).toFixed(0)} s`);
        return;
      }
      case 'operatorAbsent': {
        this.operatorPresent = false;
        this.operatorReturnsAt = now() + OPERATOR_ABSENT_MS;
        this._emit('mode', this.modeMessage());
        this.log('critical',
          `Operator presence lost — attended approvals expire until the operator reconnects ` +
          `(${(OPERATOR_ABSENT_MS / 1000).toFixed(0)} s)`);
        this.raiseEscalation(
          this.mission?.plan.requestId ?? this._scnPassing?.requestId ?? 'no-mission',
          'operator_absent',
          { expiresApprovals: true },
        );
        if (this.plannerActive && this.s.armed) {
          this.envelopeHold = false;
          this.s.mode = 'LOITER';
          this.log('warning', 'Mission holding — an attended mission may not run unattended');
        }
        return;
      }
      case 'unattendedInEnvelope':
        this.unattendedDispatch(true);
        return;
      case 'unattendedOutOfEnvelope':
        this.unattendedDispatch(false);
        return;
      case 'handoff': {
        if (this.sortieStartedAt === null) {
          this.log('warning', 'Handoff needs a vehicle on a sortie');
          return;
        }
        this.setSimulationToggles({ simulateSortieExpiry: true });
        this.log('warning', 'Sortie clock forced to the must-RTL deadline');
        return;
      }
    }
  }

  scenarioHint(name: DemoScenario): string {
    switch (name) {
      case 'gust':
        return this.plannerActive && this.mission?.plan.corridor
          ? 'Drift the vehicle off its corridor'
          : 'Approve and execute a plan first';
      case 'operatorAbsent':
        return this.operatorPresent
          ? 'Expire approvals and escalate'
          : 'Operator already away';
      case 'unattendedInEnvelope':
        return this.attendance === 'unattended'
          ? 'Auto-dispatch inside UNATTENDED_ENVELOPE'
          : 'Enter unattended mode first';
      case 'unattendedOutOfEnvelope':
        return this.attendance === 'unattended'
          ? 'Refuse and escalate'
          : 'Enter unattended mode first';
      case 'handoff':
        return this.sortieStartedAt === null
          ? 'Needs a vehicle on a sortie'
          : this.handoffDone ? 'Already handed off' : 'Hand the task to eis-2 at must_rtl_by';
    }
  }

  /**
   * Unattended tasking. In unattended mode a task inside UNATTENDED_ENVELOPE
   * is dispatched without an operator gate; a task outside it is REFUSED and
   * the refusal escalates — an unattended request the system declined is
   * precisely what a human needs to see (ADR D23).
   */
  private unattendedDispatch(inEnvelope: boolean): void {
    const site = this.site;
    const anomaly = this._scnAnomaly;
    if (!site || !anomaly) {
      this.log('warning', 'Unattended tasking needs a cue and a loaded site model');
      return;
    }
    if (this.attendance !== 'unattended') {
      this.log('error',
        'Unattended dispatch refused — unattended mode is entered by a signed operator command only');
      return;
    }
    // The out-of-envelope beat is a REAL condition, not a doctored verdict:
    // RF interference makes GNSS integrity unverifiable, which the envelope
    // refuses outright.
    if (!inEnvelope && !this.simulationToggles.simulateRfInterference) {
      this.setSimulationToggles({ simulateRfInterference: true });
    }

    this.replans += 1;
    const task: Task = {
      taskId: `task-unattended-${this.replans}`,
      anomalyId: anomaly.id,
      lookFor: 'vehicle',
      question: 'Is the flagged change still present, and is anything moving near it?',
      urgency: 'immediate',
      priority: 0.88,
      rationale: `Unattended cue check for ${anomaly.id}; no operator gate is available.`,
      source: 'scripted',
      assignedTo: DEFAULT_VEHICLE_ID,
    };
    this.emitTasks([task]);

    const requestId = `plan-${task.taskId}`;
    void this.proposePlan(site, anomaly, task, requestId).then((proposal) => {
      if (!proposal) {
        // The rule table refused before a plan existed — an unattended refusal
        // is exactly what a human needs to see, so it still escalates.
        this.raiseEscalation(requestId, 'unattended_dispatch_refused', { taskId: task.taskId });
        return;
      }
      const { plan, verification } = proposal;
      this._emit('plan', { type: 'missionPlan', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, plan });
      this._emit('verf', {
        type: 'verification', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, verification,
      });

      if (verification.verdict === 'rejected') {
        const attended = verification.checks.find((c) => c.name === 'attended');
        this.log('error', `Unattended dispatch REFUSED — ${attended?.reason ?? 'outside the envelope'}`);
        this.raiseEscalation(plan.requestId, 'unattended_dispatch_refused', {
          taskId: task.taskId,
          failedChecks: verification.checks.filter((c) => !c.ok).map((c) => c.name),
        });
        return;
      }
      if (verification.holdUntil && verification.holdUntil > now()) {
        this.log('warning',
          `Unattended dispatch held until ${new Date(verification.holdUntil).toLocaleTimeString()} — deconfliction`);
        return;
      }
      this.log('warning', `Unattended auto-dispatch of ${plan.requestId} (no operator gate)`);
      void this.sendCommand({
        type: 'command', vehicleId: DEFAULT_VEHICLE_ID, command: 'executePlan',
        params: { plan: verification.correctedPlan ?? plan },
      });
    });
  }

  /** Lateral disturbance while a gust blows. Pure kinematics — it does not
   *  touch the plan, and the monitor sees it the same way it would see wind. */
  private applyGust(dt: number): void {
    const g = this.gust;
    if (!g) return;
    if (now() - g.startedAt > GUST_DURATION_MS) {
      this.gust = null;
      this.log('info', 'Gust subsided — monitor backing the vehicle off to the corridor');
      return;
    }
    // Wind blows from a fixed compass direction, not relative to the airframe:
    // on a leg that pushes the vehicle sideways, on an orbit it pushes the
    // whole ring off centre. Either way the monitor sees a real excursion.
    const cosLat = Math.cos((this.homeLat() * Math.PI) / 180);
    const step = GUST_DRIFT_MPS * MISSION_TIME_SCALE * dt;
    this.s.lat += (Math.cos(g.bearingRad) * step) / M_PER_DEG_LAT;
    this.s.lon += (Math.sin(g.bearingRad) * step) / (M_PER_DEG_LAT * cosLat);
  }

  /**
   * At `must_rtl_by` the sortie ends. Task handoff between vehicles is an
   * explicit, audited action, never an emergent one (ADR D26): the task is
   * re-issued to the peer and the primary returns to launch.
   */
  private maybeHandoff(telemetry: Telemetry): void {
    if (this.handoffDone || !telemetry.sortie) return;
    if (telemetry.sortie.elapsed_s < telemetry.sortie.must_rtl_by_s) return;
    const task = this._scnTasks[0];
    if (!task) return;
    this.handoffDone = true;
    const missionId = this.mission?.plan.requestId ?? task.taskId;
    this.peer.flying = true;
    this.peer.armed = true;
    this.peer.sortieStartedAt = now();
    this.ensurePeerPlan();
    this.emitTasks([{
      ...task,
      assignedTo: PEER_VEHICLE_ID,
      rationale: `${task.rationale} Handed off from ${DEFAULT_VEHICLE_ID} at the must-RTL deadline.`,
    }]);
    this.log('critical',
      `must_rtl_by reached on ${missionId} — task ${task.taskId} handed to ${PEER_VEHICLE_ID}; ` +
      `${DEFAULT_VEHICLE_ID} returning to launch`);
    if (this.s.armed && this.s.phase !== 'rtl' && this.s.phase !== 'landing') {
      this.s.phase = 'rtl';
      this.s.mode = 'RTL';
      this.plannerActive = false;
      this.mission = null;
      this.envelopeHold = false;
      this.gust = null;
    }
    this.publishFleetRows();
  }

  /**
   * Commands addressed to the peer. Each vehicle keeps its own state; there is
   * no vehicle-to-vehicle path, so this is the hub relaying to the peer. What
   * the mock does not model is refused with a reason, never silently ignored —
   * except manual, which must always be available (manual preempts everything).
   */
  private peerCommand(cmd: Command): Promise<CommandAck> {
    let ok = true;
    let message = 'OK';
    switch (cmd.command) {
      case 'arm':
        this.peer.armed = true;
        this.peer.sortieStartedAt ??= now();
        this.log('info', `${PEER_VEHICLE_ID} ARMED`);
        break;
      case 'disarm':
      case 'emergencyStop':
        this.peer.armed = false;
        this.peer.flying = false;
        this.peer.manualActive = false;
        this.peer.sortieStartedAt = null;
        this.peer.relAlt = 0;
        this.log(cmd.command === 'emergencyStop' ? 'critical' : 'warning',
          `${PEER_VEHICLE_ID} ${cmd.command === 'emergencyStop' ? 'EMERGENCY STOP' : 'DISARMED'}`);
        break;
      case 'land':
      case 'rtl':
        this.peer.flying = false;
        this.peer.manualActive = false;
        this.peer.relAlt = 0;
        this.log('info', `${PEER_VEHICLE_ID} returning to its pad`);
        break;
      case 'takeoff':
        if (!this.peer.armed) { ok = false; message = 'Not armed'; break; }
        this.peer.flying = true;
        this.ensurePeerPlan();
        this.log('info', `${PEER_VEHICLE_ID} on station`);
        break;
      case 'engageManual':
        if (!this.peer.armed) { ok = false; message = 'Not armed'; break; }
        // Manual preempts everything, on either vehicle.
        this.peer.manualActive = true;
        this.log('warning', `MANUAL CONTROL engaged on ${PEER_VEHICLE_ID}`);
        break;
      case 'disengageManual':
        this.peer.manualActive = false;
        this.log('info', `Manual released on ${PEER_VEHICLE_ID} — position hold`);
        break;
      case 'setGimbal':
        if (cmd.params?.pitchDeg == null) { ok = false; message = 'setGimbal requires params.pitchDeg'; break; }
        this.gimbalPitchDeg = clamp(cmd.params.pitchDeg, GIMBAL_PITCH_MIN_DEG, GIMBAL_PITCH_MAX_DEG);
        break;
      case 'enterUnattended':
      case 'exitUnattended':
        // Attendance is a ground-station-wide state in this mock.
        return this.sendCommand({ ...cmd, vehicleId: DEFAULT_VEHICLE_ID });
      default:
        ok = false;
        message = `${cmd.command} is not modelled on the peer vehicle`;
    }
    const ack: CommandAck = {
      type: 'ack', ts: now(), vehicleId: cmd.vehicleId, command: cmd.command, success: ok, message,
    };
    setTimeout(() => this._emit('ack', ack), 60);
    this.publishFleetRows();
    return Promise.resolve(ack);
  }

  /* ---- command handling ------------------------------------------------ */
  sendCommand(cmd: Command): Promise<CommandAck> {
    if (cmd.vehicleId === PEER_VEHICLE_ID) return this.peerCommand(cmd);
    const p = cmd.params || {};
    let ok = true;
    let message = 'OK';
    switch (cmd.command) {
      case 'arm':
        if (!this.readinessMessage().ready) {
          ok = false;
          message = this.readinessMessage().reasons.join('; ');
          this.log('error', `Arm refused — ${message}`);
          break;
        }
        this.s.armed = true;
        this.sortieStartedAt ??= now();
        this.log('info', 'Vehicle ARMED');
        break;
      case 'disarm':
      case 'emergencyStop':
        this.s.armed = false;
        this.sortieStartedAt = null;
        this.s.phase = 'idle';
        this.s.mode = 'LOITER';
        this.s.targetAlt = 0;
        this.manual.active = false;
        this.plannerActive = false;
        this.mission = null;
        this.obs = null;
        this.gust = null;
        this.envelopeHold = false;
        this.envelopeState = 'in_envelope';
        this.envelopeArmed = false;
        this.manual.throttle = this.manual.yaw = this.manual.pitch = this.manual.roll = 0;
        if (this.track.state !== 'idle') {
          this.track.state = 'idle';
          this.track.lockedTargetId = null;
          this.track.estimatedDistance = null;
        }
        this.log(
          cmd.command === 'emergencyStop' ? 'critical' : 'warning',
          cmd.command === 'emergencyStop'
            ? 'EMERGENCY STOP — motors disarmed'
            : 'Vehicle DISARMED',
        );
        break;
      case 'takeoff':
        if (!this.s.armed) {
          ok = false;
          message = 'Not armed';
          break;
        }
        this.s.phase = 'takeoff';
        this.s.mode = 'GUIDED';
        this.s.targetAlt = p.altitude || 4;
        this.log('info', `Takeoff to ${this.s.targetAlt} m`);
        break;
      case 'land':
        this.s.phase = 'landing';
        this.s.mode = 'LAND';
        this.plannerActive = false;
        this.mission = null;
        this.obs = null;
        this.log('info', 'Landing');
        break;
      case 'rtl':
        this.s.phase = 'rtl';
        this.s.mode = 'RTL';
        this.plannerActive = false;
        this.mission = null;
        this.obs = null;
        this.log('info', 'Return to launch');
        break;
      case 'setMode':
        if (p.mode) this.s.mode = p.mode;
        this.log('info', `Mode → ${p.mode}`);
        break;
      case 'engageTracking':
        this.plannerActive = false; // exactly one controlSource
        this.mission = null;
        this.obs = null;
        this.track.state = 'searching';
        this.log('info', 'Tracking engaged — searching');
        break;
      case 'disengageTracking':
        this.track.state = 'idle';
        this.track.lockedTargetId = null;
        this.track.estimatedDistance = null;
        this.log('warning', 'Tracking disengaged');
        break;
      case 'selectTarget':
        this.track.lockedTargetId = p.targetId ?? null;
        if (this.track.state === 'idle') this.track.state = 'searching';
        this.log('info', `Target #${p.targetId} selected`);
        break;
      case 'setStandoff':
        if (p.meters != null) this.track.standoff = p.meters;
        break;
      case 'setMaxSpeed':
        if (p.mps != null) this.track.maxSpeed = p.mps;
        break;
      case 'engageManual':
        if (!this.s.armed) {
          ok = false;
          message = 'Not armed';
          break;
        }
        this.manual.active = true;
        this.plannerActive = false; // manual takeover releases the planner
        this.mission = null;
        this.obs = null;
        this.s.mode = 'STABILIZE';
        if (this.s.phase === 'idle') this.s.phase = 'flying';
        if (this.track.state !== 'idle') {
          this.track.state = 'idle';
          this.track.lockedTargetId = null;
          this.track.estimatedDistance = null;
          this.log('warning', 'Tracking released for manual control');
        }
        this.log('warning', 'MANUAL CONTROL engaged');
        break;
      case 'disengageManual':
        this.manual.active = false;
        this.manual.throttle = this.manual.yaw = this.manual.pitch = this.manual.roll = 0;
        if (this.s.armed) this.s.mode = 'LOITER';
        this.log('info', 'Manual released — position hold');
        break;
      case 'executePlan': {
        const plan = p.plan;
        if (!plan || plan.tools.length === 0) {
          ok = false;
          message = 'executePlan requires params.plan (the full verified plan)';
          break;
        }
        const readiness = this.readinessMessage();
        if (!readiness.ready) {
          ok = false;
          message = readiness.reasons.join('; ');
          this.log('error', `Mission refused — ${message}`);
          break;
        }
        // Attendance gate: an attended mission may not dispatch while the
        // operator is away — the approval that authorised it has expired.
        if (this.attendance === 'attended' && !this.operatorPresent) {
          ok = false;
          message = 'operator approval expired — the operator is not present';
          this.log('error', `Mission refused — ${message}`);
          this.raiseEscalation(plan.requestId, 'dispatch_refused_operator_absent', {
            anomalyId: plan.anomalyId,
          });
          break;
        }
        // exactly one controlSource: release manual + tracking
        this.manual.active = false;
        this.manual.throttle = this.manual.yaw = this.manual.pitch = this.manual.roll = 0;
        if (this.track.state !== 'idle') {
          this.track.state = 'idle';
          this.track.lockedTargetId = null;
          this.track.estimatedDistance = null;
          this.log('warning', 'Tracking released for planner');
        }
        if (!this.s.armed) {
          // Mock-only convenience so the approve→fly demo is one click; the
          // real companion refuses executePlan while disarmed.
          this.s.armed = true;
          this.sortieStartedAt = now();
          this.log('info', 'Auto-armed for planned mission (mock)');
        }
        this.plannerActive = true;
        this.s.mode = 'GUIDED';
        this.s.phase = 'flying';
        this.mission = { plan, toolIndex: 0, orbit: null, holdLeftS: null, observed: false };
        this.envelopeArmed = false;
        this.envelopeState = 'in_envelope';
        this.envelopeHold = false;
        this.envelopeEscalated = false;
        this.log('info',
          `Executing plan ${plan.requestId} — ${plan.tools.length} step(s), profile ${plan.profile}`);
        break;
      }
      case 'abortPlan':
        if (this.plannerActive) {
          this.plannerActive = false;
          this.mission = null;
          this.obs = null;
          this.gust = null;
          this.envelopeHold = false;
          this.envelopeState = 'in_envelope';
          this.envelopeArmed = false;
          if (this.s.armed) this.s.mode = 'LOITER';
          this.log('warning', 'Plan aborted — position hold');
        }
        break;
      case 'continueMission':
        // Operator-only release from a hostile-drone hold. Phase 3 supplies
        // the held-state transition; the baseline mock acknowledges the gate.
        this.hostileOverride = true;
        if (this.plannerActive && this.mission && this.s.armed) this.s.mode = 'GUIDED';
        this.lastAuxEmit = 0;
        this.log('warning', 'Operator approved mission continuation after hostile-drone hold');
        break;
      case 'testFault': {
        if (!p.fault || p.enabled === undefined) {
          ok = false;
          message = 'testFault requires fault and enabled';
          break;
        }
        const keyByFault: Partial<Record<TestFaultName, keyof SimulationToggles>> = {
          gps_loss: 'simulateGpsLoss', rf_interference: 'simulateRfInterference',
          hostile_drone: 'simulateHostileDrone', link_loss: 'simulateLinkLoss',
          camera: 'simulateCameraFail', thermal: 'simulateThermalFail', lidar: 'simulateLidarFail',
          battery_fault: 'simulateBatteryFault', sortie_expiry: 'simulateSortieExpiry', charge: 'simulateCharging',
        };
        const key = keyByFault[p.fault];
        if (!key) {
          ok = false;
          message = `${p.fault} is not modeled by the renderer mock`;
          break;
        }
        this.setSimulationToggles({ [key]: p.enabled } as Partial<SimulationToggles>);
        message = `${p.fault} ${p.enabled ? 'enabled' : 'cleared'}`;
        break;
      }
      case 'setGimbal': {
        if (p.pitchDeg == null) {
          ok = false;
          message = 'setGimbal requires params.pitchDeg';
          break;
        }
        const wanted = p.pitchDeg;
        this.gimbalPitchDeg = clamp(wanted, GIMBAL_PITCH_MIN_DEG, GIMBAL_PITCH_MAX_DEG);
        if (this.gimbalPitchDeg !== wanted) {
          message = `Clamped to ${this.gimbalPitchDeg}° ` +
            `(${GIMBAL_PITCH_MIN_DEG}..${GIMBAL_PITCH_MAX_DEG})`;
        }
        this.log('info', `Gimbal pitch → ${this.gimbalPitchDeg.toFixed(0)}°`);
        break;
      }
      case 'enterUnattended':
        if (!p.operatorId) {
          ok = false;
          message = 'enterUnattended requires params.operatorId';
          break;
        }
        this.setAttendance('unattended');
        this.log('warning', `Unattended mode entered by ${p.operatorId}`);
        break;
      case 'exitUnattended':
        if (!p.operatorId) {
          ok = false;
          message = 'exitUnattended requires params.operatorId';
          break;
        }
        // Exiting unattended mode IS the operator connecting.
        this.operatorPresent = true;
        this.operatorReturnsAt = null;
        this.setAttendance('attended');
        this._emit('mode', this.modeMessage());
        this.log('info', `Attended mode restored by ${p.operatorId}`);
        break;
      default:
        ok = false;
        message = 'Unknown command';
    }
    const ack: CommandAck = {
      type: 'ack', ts: now(), vehicleId: cmd.vehicleId, command: cmd.command, success: ok, message,
    };
    setTimeout(() => this._emit('ack', ack), 60);
    return Promise.resolve(ack);
  }

  /* ---- simulation loop ------------------------------------------------- */
  private start(): void {
    if (this._started) return;
    this._started = true;
    this.log('info', 'EKF healthy');
    this.log('info', 'GPS fix acquired — 16 sats');
    this._tel = setInterval(() => this.stepTelemetry(), 100); // 10 Hz
    this._trk = setInterval(() => this.stepTracking(), 120);
    this._amb = setInterval(() => this.ambientLog(), 7000);
    this._env = setInterval(() => this.stepEnvelope(), ENVELOPE_PERIOD_MS); // 5 Hz
    this._emit('mode', this.modeMessage());
    // Kick the site load early so the map has geometry before the anomaly.
    void getSiteModel().then((site) => this.adoptSite(site)).catch(() => undefined);
    this.scheduleScenario();
  }

  private stop(): void {
    if (this._tel) clearInterval(this._tel);
    if (this._trk) clearInterval(this._trk);
    if (this._amb) clearInterval(this._amb);
    if (this._env) clearInterval(this._env);
    this._tel = this._trk = this._amb = this._env = null;
    if (this._scnTimer) clearTimeout(this._scnTimer);
    this._scnTimer = null; // scenario PROGRESS survives reconnects
    // Stop the rails, then take one last health snapshot so the badges show
    // `stopped` rather than freezing on the last healthy reading.
    const bus = this.cueBus;
    this.cueBus = null;
    if (bus) {
      void bus.stop().then(() => {
        for (const health of bus.health()) this.cueRailHealth.set(health.rail, health);
        bus.dispose();
      });
    }
    this._started = false;
  }

  /* ---- planned-mission kinematics -------------------------------------- */

  /** Move the vehicle `stepM` meters toward (lat, lon); returns remaining
   *  distance BEFORE the move, meters. Also points the heading at the target. */
  private moveToward(lat: number, lon: number, stepM: number): number {
    const s = this.s;
    const cosLat = Math.cos((this.homeLat() * Math.PI) / 180);
    const dN = (lat - s.lat) * M_PER_DEG_LAT;
    const dE = (lon - s.lon) * M_PER_DEG_LAT * cosLat;
    const dist = Math.hypot(dN, dE);
    if (dist < 1e-6) return 0;
    const f = Math.min(1, stepM / dist);
    s.lat += (dN * f) / M_PER_DEG_LAT;
    s.lon += (dE * f) / (M_PER_DEG_LAT * cosLat);
    s.heading = ((Math.atan2(dE, dN) * 180) / Math.PI + 360) % 360;
    return dist;
  }

  private stepMission(dt: number): void {
    const m = this.mission;
    const s = this.s;
    if (!m) return;
    const plan = m.plan;
    const tool = plan.tools[m.toolIndex];
    if (!tool) {
      // Plan exhausted without an rtl step: hold position, release the planner.
      this.plannerActive = false;
      this.mission = null;
      if (s.armed) s.mode = 'LOITER';
      this.log('info', `Plan ${plan.requestId} complete — holding position`);
      return;
    }
    const profile = tool.tool === 'goto_gps' && tool.profile ? tool.profile : plan.profile;
    const speed = PROFILE_SPEED_MPS[profile];
    const stepM = speed * MISSION_TIME_SCALE * dt;
    const climbStep = 2.0 * MISSION_TIME_SCALE * dt; // 2 m/s climb, scaled

    // gentle mission attitude
    s.roll = lerp(s.roll, Math.sin(this.t * 0.8) * 4, 0.2);
    s.pitch = lerp(s.pitch, -3, 0.1);
    s.groundspeed = speed; // report the true profile speed (time is compressed)
    s.vspeed = 0;

    switch (tool.tool) {
      case 'goto_gps': {
        const dist = this.moveToward(tool.lat, tool.lon, stepM);
        const dAlt = tool.alt - s.relAlt;
        s.relAlt += clamp(dAlt, -climbStep, climbStep);
        s.vspeed = clamp(dAlt, -2, 2);
        if (dist <= Math.max(2, stepM) && Math.abs(dAlt) < 1) {
          m.toolIndex += 1;
          this.log('info', `Waypoint reached (tool ${m.toolIndex - 1}) — ${tool.alt} m AGL`);
        }
        break;
      }
      case 'orbit_point': {
        const r = Math.max(5, tool.radius);
        const cosLat = Math.cos((this.homeLat() * Math.PI) / 180);
        if (!m.orbit) {
          const dN = (s.lat - tool.lat) * M_PER_DEG_LAT;
          const dE = (s.lon - tool.lon) * M_PER_DEG_LAT * cosLat;
          m.orbit = { theta: Math.atan2(dN, dE), laps: 0 };
          this.log('info', `Orbiting observation point at ${r} m radius`);
        }
        const omega = (speed * MISSION_TIME_SCALE * dt) / r; // rad per tick
        m.orbit.theta += omega;
        m.orbit.laps += omega / (2 * Math.PI);
        // Advance along the ring from where the vehicle ACTUALLY is, and pull
        // the radius back toward r with LIMITED authority. Snapping onto the
        // ideal ring point each tick would give the airframe infinite lateral
        // authority and no disturbance could ever move it off its corridor.
        const dNow = Math.hypot(
          (s.lat - tool.lat) * M_PER_DEG_LAT,
          (s.lon - tool.lon) * M_PER_DEG_LAT * cosLat,
        ) || r;
        const maxRadialCorrection = stepM * 0.35;
        const nextR = dNow + clamp(r - dNow, -maxRadialCorrection, maxRadialCorrection);
        const e = nextR * Math.cos(m.orbit.theta);
        const n = nextR * Math.sin(m.orbit.theta);
        s.lat = tool.lat + n / M_PER_DEG_LAT;
        s.lon = tool.lon + e / (M_PER_DEG_LAT * cosLat);
        // face the orbit centre
        s.heading = ((Math.atan2(-e, -n) * 180) / Math.PI + 360) % 360;
        if (!m.observed && m.orbit.laps >= 0.35) this.beginObservation(m, tool.lat, tool.lon, r);
        if (m.orbit.laps >= 1.15) {
          m.toolIndex += 1;
          m.orbit = null;
        }
        break;
      }
      case 'hold': {
        if (m.holdLeftS === null) m.holdLeftS = tool.durationS ?? 10;
        m.holdLeftS -= dt * MISSION_TIME_SCALE;
        s.groundspeed = 0;
        if (m.holdLeftS <= 0) {
          m.toolIndex += 1;
          m.holdLeftS = null;
        }
        break;
      }
      case 'rtl': {
        // Hand off to the standard rtl → landing phase machine; the planner
        // stays the active controlSource until touchdown.
        this.mission = null;
        s.phase = 'rtl';
        s.mode = 'RTL';
        this.log('info', 'Mission observation complete — returning to launch');
        break;
      }
    }
  }

  /** Fire the synthetic vision observation at the orbited staging point and
   *  (shortly after) the incident report from the REAL report writer. */
  private beginObservation(m: MissionExec, lat: number, lon: number, radiusM: number): void {
    m.observed = true;
    const site = this.site;
    const anomaly = this._scnAnomaly ?? {
      id: m.plan.anomalyId,
      lat, lon,
      type: 'change',
      confidence: 0.8,
      thumbnail: '',
      source: 'drone_survey',
    };
    // Ground truth comes from the SITE staging data, never hardcoded.
    let staging: SiteStagingPoint | null = null;
    if (site) {
      for (const sp of site.staging) {
        const d = haversineMeters(sp, { lat, lon });
        if (d < 80 && (!staging || d < haversineMeters(staging, { lat, lon }))) staging = sp;
      }
    }
    const sensors = this.sensorHealth();
    const frames = staging ? {
      ...(sensors.rgb === 'ok' ? { rgb: staging.image } : {}),
      ...(sensors.thermal === 'ok' ? { thermal: staging.thermalImage } : {}),
    } : undefined;
    const geometry: ObservationMessage['geometry'] = sensors.lidar === 'ok' && staging
      ? staging.truth === 'breach'
        ? { fence_gaps: [{ lat: staging.lat, lon: staging.lon, width_m: 2.4 }], new_structures: [] }
        : staging.truth === 'structure'
          ? { fence_gaps: [], new_structures: [{ lat: staging.lat, lon: staging.lon, footprint_m2: 28, height_m: 3.4 }] }
          : { fence_gaps: [], new_structures: [] }
      : { fence_gaps: [], new_structures: [] };
    const reviewable = !!frames?.rgb && !!frames?.thermal && sensors.lidar !== 'failed';
    const detected = staging ? staging.truth !== 'false_alarm' : true;
    const confidence = reviewable ? (detected ? 0.92 : 0.91) : 0.2;
    const observation: ObservationSummary = {
      detected,
      observationAvailable: reviewable,
      confidence,
      stagingTruth: staging?.truth,
      classification: reviewable ? (detected ? 'confirmed' : 'false_alarm') : 'inconclusive',
      modalities: [
        ...(frames?.rgb ? ['rgb' as const] : []),
        ...(frames?.thermal ? ['thermal' as const] : []),
        ...(sensors.lidar === 'ok' ? ['lidar' as const] : []),
      ],
      frames,
      geometry: {
        fenceGaps: geometry.fence_gaps.map((gap) => ({ lat: gap.lat, lon: gap.lon, widthM: gap.width_m })),
        newStructures: geometry.new_structures.map((structure) => ({
          lat: structure.lat, lon: structure.lon,
          footprintM2: structure.footprint_m2, heightM: structure.height_m,
        })),
      },
    };

    const observationMessage: ObservationMessage = {
      type: 'observation', ts: now(), vehicleId: DEFAULT_VEHICLE_ID,
      missionId: m.plan.requestId,
      ...(staging ? { stagingId: staging.id } : {}),
      scene: staging?.id ?? anomaly.id,
      sensors,
      frames,
      geometry,
      tracks: detected && reviewable ? [{
        id: 901,
        class: staging?.truth === 'structure' ? 'new_structure' : 'vehicle',
        bearing_deg: 0,
        range_m: radiusM,
        conf: confidence,
        modality: 'fused',
        thermal_delta_c: 12.6,
      }] : [],
    };
    this._emit('obs', observationMessage);

    this.obs = {
      until: now() + 4500,
      detected: observation.detected,
      confidence: observation.confidence,
      distanceM: radiusM,
    };
    this.log(observation.detected ? 'warning' : 'info',
      observation.detected
        ? `Observation: target detected at flagged location (conf ${(observation.confidence * 100).toFixed(0)}%)`
        : 'Observation: nothing detected at flagged location');

    const plan = m.plan;
    setTimeout(() => {
      void (async () => {
      const report = window.eis?.plannerReport
        ? await window.eis.plannerReport({ vehicleId: DEFAULT_VEHICLE_ID, anomaly, plan, observation })
        : writeIncidentReport(anomaly, plan, observation);
      this._emit('rept', {
        type: 'incidentReport', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, report,
      });
      this.log(report.verdict === 'escalate' ? 'critical' : 'info',
        `Incident report ${report.missionId}: ${report.verdict.toUpperCase()}`);
      if (report.verdict === 'escalate') {
        // An 'escalate' verdict is the only thing that raises an escalation;
        // it is a notification of the report, never a new instruction.
        const escalation: EscalationMessage = {
          type: 'escalation',
          ts: now(),
          vehicleId: DEFAULT_VEHICLE_ID,
          missionId: report.missionId,
          channel: 'console',
          payload: {
            anomalyId: anomaly.id,
            taskId: this._scnTask?.taskId ?? null,
            verdict: report.verdict,
            attendance: this.attendance,
          },
          deliveredAt: now(),
        };
        this._emit('escl', escalation);
        this.log('critical',
          `Escalation raised for ${report.missionId} on channel ${escalation.channel}`);
      }
      })().catch((err: unknown) => this.log('error', `Incident report failed: ${(err as Error).message}`));
    }, 3000);
  }

  private stepTelemetry(): void {
    const s = this.s;
    this.t += 0.1;
    // altitude toward target
    if (s.phase === 'takeoff') {
      s.relAlt = lerp(s.relAlt, s.targetAlt, 0.06);
      if (Math.abs(s.relAlt - s.targetAlt) < 0.15) {
        s.relAlt = s.targetAlt;
        s.phase = 'flying';
        this.log('info', 'Reached target altitude');
      }
    } else if (s.phase === 'rtl') {
      s.lat = lerp(s.lat, this.homeLat(), 0.02);
      s.lon = lerp(s.lon, this.homeLon(), 0.02);
      if (Math.abs(s.lat - this.homeLat()) < 1e-5 && Math.abs(s.lon - this.homeLon()) < 1e-5) {
        s.phase = 'landing';
        s.mode = 'LAND';
      }
    } else if (s.phase === 'landing') {
      s.relAlt = lerp(s.relAlt, 0, 0.05);
      if (s.relAlt < 0.12) {
        s.relAlt = 0;
        s.armed = false;
        this.sortieStartedAt = null;
        s.phase = 'idle';
        s.mode = 'LOITER';
        if (this.plannerActive) {
          this.plannerActive = false;
          this.mission = null;
          this.log('info', 'Mission complete — landed & disarmed');
        } else {
          this.log('info', 'Landed & disarmed');
        }
      }
    }
    const flying = s.relAlt > 0.5;
    const man = this.manual;
    if (man.active && s.armed) {
      // direct stick → vehicle response
      s.roll = lerp(s.roll, man.roll * 30, 0.25);
      s.pitch = lerp(s.pitch, -man.pitch * 20, 0.25);
      s.heading = (s.heading + man.yaw * 2.6 + 360) % 360;
      s.vspeed = man.throttle * 2.2;
      s.relAlt = clamp(s.relAlt + s.vspeed * 0.1, 0, 80);
      // translate over ground: pitch = forward, roll = lateral
      const fwd = -man.pitch;
      const lat = man.roll;
      s.groundspeed = Math.min(this.track.maxSpeed * 1.6, Math.hypot(fwd, lat) * 6);
      const hd = (s.heading * Math.PI) / 180;
      const step = 1.0e-5;
      s.lat += (Math.cos(hd) * fwd - Math.sin(hd) * lat) * step;
      s.lon +=
        ((Math.sin(hd) * fwd + Math.cos(hd) * lat) * step) /
        Math.cos((this.homeLat() * Math.PI) / 180);
    } else if (this.failureStatus().state === 'hold' && s.armed) {
      s.mode = 'LOITER';
      s.groundspeed = 0;
      s.vspeed = 0;
      s.roll = lerp(s.roll, 0, 0.2);
      s.pitch = lerp(s.pitch, 0, 0.2);
    } else if (
      this.plannerActive && this.mission && s.armed && s.phase === 'flying' &&
      this.failureStatus().state !== 'hold'
    ) {
      // planned-mission kinematics (goto / orbit / hold / rtl)
      s.mode = 'GUIDED';
      // An ATTENDED mission may not keep flying with nobody on the loop: the
      // approval that authorised it has lapsed, so the vehicle holds until the
      // operator reconnects. The envelope monitor holds for its own reasons.
      const attendanceHold = this.attendance === 'attended' && !this.operatorPresent;
      if (this.envelopeHold || attendanceHold) {
        // Plan progress stops. Once a disturbance has passed, the monitor backs
        // the vehicle off to its corridor (ADR D22: hold, then back off).
        s.groundspeed = 0;
        s.vspeed = 0;
        s.mode = 'LOITER';
        if (this.envelopeHold) this.stepEnvelopeBackoff(0.1);
      } else {
        this.stepMission(0.1);
      }
      this.applyGust(0.1);
    } else {
      // gentle attitude motion when flying (autonomous)
      s.roll = flying
        ? Math.sin(this.t * 0.6) * 7 + (this.track.state === 'locked' ? Math.sin(this.t * 1.7) * 3 : 0)
        : lerp(s.roll, 0, 0.1);
      s.pitch = flying ? Math.cos(this.t * 0.5) * 4 : lerp(s.pitch, 0, 0.1);
      s.heading = (s.heading + (flying ? 0.25 + (this.track.state === 'locked' ? 0.5 : 0) : 0)) % 360;
      s.groundspeed = flying
        ? clamp(
            1.2 + Math.sin(this.t * 0.4) * 0.8 + (this.track.state === 'locked' ? 1.2 : 0),
            0,
            this.track.maxSpeed,
          )
        : lerp(s.groundspeed, 0, 0.2);
      s.vspeed =
        s.phase === 'takeoff'
          ? 1.4
          : s.phase === 'landing'
            ? -0.8
            : flying
              ? Math.sin(this.t * 0.9) * 0.3
              : 0;
      // drift position while flying (not during a planned mission)
      if (flying && s.phase === 'flying') {
        s.lat += Math.cos((s.heading * Math.PI) / 180) * 1.2e-6;
        s.lon += Math.sin((s.heading * Math.PI) / 180) * 1.2e-6;
      }
    }
    // Battery charge/drain follows the mock fault controls. Charging is
    // available only while disarmed; ETA uses the same compressed demo rate.
    const draw = s.armed ? (flying ? 18 + s.groundspeed * 1.5 : 6) : 0.4;
    s.current = lerp(s.current, draw, 0.1);
    if (this.simulationToggles.simulateCharging && !s.armed) {
      s.battery = clamp(s.battery + 0.08, 0, 100);
    } else {
      s.battery = clamp(s.battery - (s.armed ? 0.0065 + s.groundspeed * 0.0008 : 0), 0, 100);
    }
    s.voltage = lerp(s.voltage, 14.0 + (s.battery / 100) * 2.8, 0.05);
    // link jitter
    s.rssi = Math.round(clamp(-48 + Math.sin(this.t * 0.3) * 6 - (flying ? 4 : 0), -95, -40));
    s.latency = Math.round(clamp(38 + Math.sin(this.t * 0.7) * 12 + (flying ? 8 : 0), 20, 120));

    // battery warnings
    const b = Math.round(s.battery);
    if (b === 30 && !this._warn30) {
      this._warn30 = true;
      this.log('warning', 'Battery 30% — consider RTL');
    }
    if (b === 15 && !this._warn15) {
      this._warn15 = true;
      this.log('critical', 'Battery 15% — failsafe imminent');
    }

    const failure = this.failureStatus();
    if (failure.state === 'rtl' && s.armed && s.phase !== 'rtl' && s.phase !== 'landing') {
      s.phase = 'rtl';
      s.mode = 'RTL';
      this.plannerActive = false;
      this.mission = null;
      this.log('critical', `Automatic RTL — ${failure.reason}`);
    }
    this.stepPeer(0.1);
    if (this.operatorReturnsAt !== null && now() >= this.operatorReturnsAt) {
      this.operatorReturnsAt = null;
      this.operatorPresent = true;
      this.log('info', 'Operator reconnected');
      // The safe direction is always toward supervision: reconnecting the
      // operator reverts unattended mode automatically (ADR D23).
      if (this.attendance === 'unattended') {
        this.setAttendance('attended');
        this.log('warning', 'Unattended mode auto-reverted on operator connect');
      } else {
        this._emit('mode', this.modeMessage());
      }
    }

    const telemetry = this.primaryTelemetry();
    this.maybeHandoff(telemetry);
    this._emit('tel', this.selectedVehicle === PEER_VEHICLE_ID ? this.peerTelemetry() : telemetry);
    this.emitAuxiliary(telemetry);
  }

  /** The primary vehicle's telemetry frame. Always computed (the fleet view
   *  and the sortie deadline depend on it) even while the operator follows
   *  the peer. */
  private primaryTelemetry(): Telemetry {
    const s = this.s;
    const failure = this.failureStatus();
    const dLat = (s.lat - this.homeLat()) * M_PER_DEG_LAT;
    const dLon = (s.lon - this.homeLon()) * M_PER_DEG_LAT * Math.cos((this.homeLat() * Math.PI) / 180);
    const sortieElapsed = this.sortieStartedAt === null ? 0 : Math.max(0, (now() - this.sortieStartedAt) / 1000);
    const forcedSortieElapsed = this.simulationToggles.simulateSortieExpiry ? 425 + sortieElapsed : sortieElapsed;
    return {
      type: 'telemetry',
      ts: now(),
      vehicleId: DEFAULT_VEHICLE_ID,
      armed: s.armed,
      mode: s.mode,
      controlSource: this.manual.active
        ? 'manual'
        : this.plannerActive
          ? 'planner'
          : this.track.state === 'locked'
            ? 'tracking'
            : 'auto',
      navSource: this.simulationToggles.simulateGpsLoss ? 'optflow' : 'gps',
      gpsHealth: this.simulationToggles.simulateGpsLoss
        ? { fix: 0, sats: 0, hdop: 99 }
        : { fix: s.fix, sats: s.sats, hdop: s.hdop },
      failsafeState: failure.state,
      failsafeReason: failure.reason,
      attitude: { roll: s.roll, pitch: s.pitch, yaw: s.heading },
      position: { lat: s.lat, lon: s.lon, relAlt: s.relAlt, absAlt: s.relAlt + 32 },
      velocity: { groundspeed: s.groundspeed, verticalSpeed: s.vspeed },
      heading: s.heading,
      battery: this.batteryState(),
      gps: this.simulationToggles.simulateGpsLoss
        ? { fixType: 0, satellites: 0, hdop: 99 }
        : { fixType: s.fix, satellites: s.sats, hdop: s.hdop },
      sortie: this.sortieStartedAt === null ? null : {
        elapsed_s: forcedSortieElapsed,
        cap_s: 480,
        must_rtl_by_s: 420,
      },
      home: { lat: this.homeLat(), lon: this.homeLon(), distance: Math.hypot(dLat, dLon) },
      link: this.simulationToggles.simulateLinkLoss
        ? { rssi: -120, latencyMs: 9999 }
        : { rssi: s.rssi, latencyMs: s.latency },
      gimbal: { pitchDeg: this.gimbalPitchDeg },
    };
  }

  private stepTracking(): void {
    const tr = this.track;

    // Mission observation window: the "vision pass" at the staging point
    // overrides the ambient people sim with the synthetic locked target.
    if (this.obs) {
      if (now() > this.obs.until) {
        this.obs = null;
      } else {
        const o = this.obs;
        const target: DetectedTarget = {
          id: 901,
          bbox: [0.44, 0.4, 0.15, 0.22],
          confidence: o.confidence,
          isLocked: o.detected,
        };
        this._emit('trk', {
          type: 'tracking',
          ts: now(),
          vehicleId: DEFAULT_VEHICLE_ID,
          state: o.detected ? 'locked' : 'searching',
          targets: o.detected ? [target] : [],
          lockedTargetId: o.detected ? 901 : null,
          standoffDistance: tr.standoff,
          estimatedDistance: o.detected ? o.distanceM : null,
          maxSpeed: tr.maxSpeed,
        });
        return;
      }
    }

    // move people
    this.people.forEach((p) => {
      p.x += p.vx;
      if (p.x < 0.12 || p.x > 0.88) p.vx *= -1;
      p.y = 0.56 + Math.sin(this.t * 0.5 + p.id) * 0.03;
      p.conf = clamp(0.78 + Math.sin(this.t * 1.3 + p.id) * 0.18, 0.5, 0.99);
    });

    // state machine
    if (tr.state === 'searching') {
      if (!this._searchT) this._searchT = this.t;
      if (this.t - this._searchT > 1.4) {
        tr.state = 'locked';
        if (tr.lockedTargetId == null) tr.lockedTargetId = this.people[0].id;
        tr.estimatedDistance = 9.5;
        this._searchT = 0;
        this.log('info', `Target lock acquired — #${tr.lockedTargetId}`);
      }
    } else if (tr.state === 'locked') {
      tr.estimatedDistance =
        lerp(tr.estimatedDistance ?? tr.standoff, tr.standoff, 0.04) + Math.sin(this.t * 1.1) * 0.06;
      // occasional lost
      this._lostTimer += 0.12;
      if (this._lostTimer > 22 && Math.random() < 0.01) {
        tr.state = 'lost';
        this._lostTimer = 0;
        this.log('warning', 'Tracking lock lost — re-acquiring');
      }
    } else if (tr.state === 'lost') {
      if (!this._lostStart) this._lostStart = this.t;
      if (this.t - this._lostStart > 1.8) {
        tr.state = 'locked';
        this._lostStart = 0;
        this.log('info', 'Target re-acquired');
      }
    }

    tr.targets = this.people.map((p) => ({
      id: p.id,
      bbox: [p.x - p.w / 2, p.y - p.h / 2, p.w, p.h],
      confidence: p.conf,
      isLocked: tr.state === 'locked' && p.id === tr.lockedTargetId,
    }));

    this._emit('trk', {
      type: 'tracking',
      ts: now(),
      vehicleId: DEFAULT_VEHICLE_ID,
      state: tr.state,
      targets: tr.targets,
      lockedTargetId: tr.lockedTargetId,
      standoffDistance: tr.standoff,
      estimatedDistance: tr.state === 'locked' ? tr.estimatedDistance : null,
      maxSpeed: tr.maxSpeed,
    });
  }

  private ambientLog(): void {
    const msgs: Array<[Severity, string]> = [
      ['info', 'GCS heartbeat OK'],
      ['info', `Satellites: ${this.s.sats} · HDOP ${this.s.hdop.toFixed(1)}`],
      ['info', 'EKF variance nominal'],
      ['info', `Link RSSI ${Math.round(this.s.rssi)} dBm`],
    ];
    const m = msgs[Math.floor(Math.random() * msgs.length)];
    this.log(m[0], m[1]);
  }
}
