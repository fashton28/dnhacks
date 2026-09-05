/* ============================================================================
 * Eye in the Sky — MockDataProvider
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
  CommandAck,
  Command,
  ConnectionConfig,
  ConnectionState,
  DetectedTarget,
  IncidentReportMessage,
  ManualInput,
  MissionPlan,
  MissionPlanMessage,
  Mode,
  StatusText,
  SimulationToggles,
  Telemetry,
  TrackingState,
  TrackingStatus,
  Unsubscribe,
  VerificationMessage,
} from '@/contract';
import { PROFILE_SPEED_MPS } from '@/contract';
import { DEFAULT_VEHICLE_ID } from '@/contract';
import type { MissionDataSource } from './types';

import { getSiteModel } from '@/site';
import type { SiteModel, SiteStagingPoint } from '@/site';
import { ScriptedPlanner } from '@planner/scripted';
import { verifyMission } from '@planner/verifier';
import { writeIncidentReport } from '@planner/report';
import type { ObservationSummary } from '@planner/report';
import { haversineMeters, pointInPolygon } from '@planner/site';
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
}

export class MockDataProvider implements MissionDataSource {
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
  private planner = new ScriptedPlanner();

  private _searchT = 0;
  private _lostStart = 0;
  private _warn30 = false;
  private _warn15 = false;

  private _tel: ReturnType<typeof setInterval> | null = null;
  private _trk: ReturnType<typeof setInterval> | null = null;
  private _amb: ReturnType<typeof setInterval> | null = null;

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
    Object.assign(this.simulationToggles, next);
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
  private _emit(k: keyof Callbacks, msg: unknown): void {
    const list = this.cbs[k] as Array<(m: unknown) => void>;
    list.forEach((f) => f(msg));
  }

  private log(severity: Severity, text: string): void {
    this._emit('txt', {
      type: 'statusText', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, severity, text,
    });
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
      } else if (step === 1) {
        if (this._scnAnomaly && site.nfz.length > 0) {
          this._scnFailing = this.planner.failingPlan(site, this._scnAnomaly);
          this._emit('plan', {
            type: 'missionPlan', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, plan: this._scnFailing,
          });
          this.log('info', `Planner proposed mission ${this._scnFailing.requestId}`);
        }
      } else if (step === 2) {
        if (this._scnFailing) {
          const v = verifyMission(this._scnFailing, site, { battery: { remaining: this.s.battery } });
          this._emit('verf', {
            type: 'verification', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, verification: v,
          });
          this.log(v.verdict === 'rejected' ? 'error' : 'warning',
            `MissionVerifier: ${this._scnFailing.requestId} → ${v.verdict.toUpperCase()}`);
        }
      } else if (step === 3) {
        if (this._scnAnomaly) {
          this._scnPassing = this.planner.passingPlan(site, this._scnAnomaly);
          this._emit('plan', {
            type: 'missionPlan', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, plan: this._scnPassing,
          });
          this.log('info', `Planner proposed mission ${this._scnPassing.requestId}`);
        }
      } else if (step === 4) {
        if (this._scnPassing) {
          const v = verifyMission(this._scnPassing, site, { battery: { remaining: this.s.battery } });
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
    if (coherent) return { ...baked, source: baked.source ?? 'sentinel2' };
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
    };
  }

  /* ---- command handling ------------------------------------------------ */
  sendCommand(cmd: Command): Promise<CommandAck> {
    const p = cmd.params || {};
    let ok = true;
    let message = 'OK';
    switch (cmd.command) {
      case 'arm':
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
        this.log('info',
          `Executing plan ${plan.requestId} — ${plan.tools.length} step(s), profile ${plan.profile}`);
        break;
      }
      case 'abortPlan':
        if (this.plannerActive) {
          this.plannerActive = false;
          this.mission = null;
          this.obs = null;
          if (this.s.armed) this.s.mode = 'LOITER';
          this.log('warning', 'Plan aborted — position hold');
        }
        break;
      case 'continueMission':
        // Operator-only release from a hostile-drone hold. Phase 3 supplies
        // the held-state transition; the baseline mock acknowledges the gate.
        this.log('warning', 'Operator approved mission continuation');
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
    // Kick the site load early so the map has geometry before the anomaly.
    void getSiteModel().then((site) => this.adoptSite(site)).catch(() => undefined);
    this.scheduleScenario();
  }

  private stop(): void {
    if (this._tel) clearInterval(this._tel);
    if (this._trk) clearInterval(this._trk);
    if (this._amb) clearInterval(this._amb);
    this._tel = this._trk = this._amb = null;
    if (this._scnTimer) clearTimeout(this._scnTimer);
    this._scnTimer = null; // scenario PROGRESS survives reconnects
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
        const e = r * Math.cos(m.orbit.theta);
        const n = r * Math.sin(m.orbit.theta);
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
    const observation: ObservationSummary = staging
      ? staging.truth === 'false_alarm'
        ? { detected: false, confidence: 0.12, stagingTruth: staging.truth }
        : { detected: true, confidence: 0.92, stagingTruth: staging.truth }
      : { detected: true, confidence: anomaly.confidence };

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
      const report = writeIncidentReport(anomaly, plan, observation);
      this._emit('rept', {
        type: 'incidentReport', ts: now(), vehicleId: DEFAULT_VEHICLE_ID, report,
      });
      this.log(report.verdict === 'escalate' ? 'critical' : 'info',
        `Incident report ${report.missionId}: ${report.verdict.toUpperCase()}`);
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
    } else if (this.plannerActive && this.mission && s.armed && s.phase === 'flying') {
      // planned-mission kinematics (goto / orbit / hold / rtl)
      this.stepMission(0.1);
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
    // battery drain
    const draw = s.armed ? (flying ? 18 + s.groundspeed * 1.5 : 6) : 0.4;
    s.current = lerp(s.current, draw, 0.1);
    s.battery = clamp(s.battery - (s.armed ? 0.0065 + s.groundspeed * 0.0008 : 0), 0, 100);
    s.voltage = lerp(s.voltage, 14.0 + (s.battery / 100) * 2.8, 0.05);
    // link jitter
    s.rssi = Math.round(clamp(-48 + Math.sin(this.t * 0.3) * 6 - (flying ? 4 : 0), -95, -40));
    s.latency = Math.round(clamp(38 + Math.sin(this.t * 0.7) * 12 + (flying ? 8 : 0), 20, 120));

    // distance to home (haversine-ish, small scale)
    const dLat = (s.lat - this.homeLat()) * M_PER_DEG_LAT;
    const dLon = (s.lon - this.homeLon()) * M_PER_DEG_LAT * Math.cos((this.homeLat() * Math.PI) / 180);
    const homeDist = Math.sqrt(dLat * dLat + dLon * dLon);

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

    this._emit('tel', {
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
      navSource: 'gps',
      gpsHealth: { fix: s.fix, sats: s.sats, hdop: s.hdop },
      failsafeState: 'none',
      failsafeReason: '',
      attitude: { roll: s.roll, pitch: s.pitch, yaw: s.heading },
      position: { lat: s.lat, lon: s.lon, relAlt: s.relAlt, absAlt: s.relAlt + 32 },
      velocity: { groundspeed: s.groundspeed, verticalSpeed: s.vspeed },
      heading: s.heading,
      battery: {
        soc_pct: s.battery,
        voltage_v: s.voltage,
        current_a: s.current,
        cell_delta_v: 0.018,
        temp_c: 31,
        remaining_s: Math.max(0, Math.round((s.battery / 100) * 1500)),
        charge_state: s.armed ? 'discharging' : 'charged',
        voltage: s.voltage,
        current: s.current,
        remaining: s.battery,
      },
      gps: { fixType: s.fix, satellites: s.sats, hdop: s.hdop },
      sortie: this.sortieStartedAt === null ? null : {
        elapsed_s: Math.max(0, (now() - this.sortieStartedAt) / 1000),
        cap_s: 480,
        must_rtl_by_s: 420,
      },
      home: { lat: this.homeLat(), lon: this.homeLon(), distance: homeDist },
      link: { rssi: s.rssi, latencyMs: s.latency },
    });
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
