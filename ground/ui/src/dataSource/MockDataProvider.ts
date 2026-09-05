/* ============================================================================
 * Eye in the Sky — MockDataProvider
 * ----------------------------------------------------------------------------
 * Faithful TypeScript port of ui_kits/ground-control/mock.js into a class that
 * implements the authoritative `DataSource` contract. A self-contained, lifelike
 * mock that drives the whole demo with no backend: telemetry @ ~10Hz, tracking
 * with bboxes that match the canvas scene, a status-text log, a command state
 * machine, and the manual (game-controller) physics block.
 * ========================================================================== */
import type {
  CommandAck,
  Command,
  ConnectionConfig,
  ConnectionState,
  DataSource,
  DetectedTarget,
  ManualInput,
  Mode,
  StatusText,
  Telemetry,
  TrackingState,
  TrackingStatus,
  Unsubscribe,
} from '@/contract';

const HOME = { lat: 37.7699, lon: -122.4666 }; // generic park
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const now = (): number => Date.now();

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

interface Callbacks {
  tel: Array<(t: Telemetry) => void>;
  trk: Array<(t: TrackingStatus) => void>;
  txt: Array<(s: StatusText) => void>;
  ack: Array<(a: CommandAck) => void>;
  conn: Array<(s: ConnectionState) => void>;
}

export class MockDataProvider implements DataSource {
  private cbs: Callbacks = {
    tel: [],
    trk: [],
    txt: [],
    ack: [],
    conn: [],
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

  // mission planner (executePlan): while active, controlSource is 'planner'.
  // Full scripted anomaly→report flow lands in Phase 3; this only tracks the flag.
  private plannerActive = false;

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
  private _emit(k: keyof Callbacks, msg: unknown): void {
    const list = this.cbs[k] as Array<(m: unknown) => void>;
    list.forEach((f) => f(msg));
  }

  private log(severity: Severity, text: string): void {
    this._emit('txt', { type: 'statusText', ts: now(), severity, text });
  }

  /* ---- command handling ------------------------------------------------ */
  sendCommand(cmd: Command): Promise<CommandAck> {
    const p = cmd.params || {};
    let ok = true;
    let message = 'OK';
    switch (cmd.command) {
      case 'arm':
        this.s.armed = true;
        this.log('info', 'Vehicle ARMED');
        break;
      case 'disarm':
      case 'emergencyStop':
        this.s.armed = false;
        this.s.phase = 'idle';
        this.s.mode = 'LOITER';
        this.s.targetAlt = 0;
        this.manual.active = false;
        this.plannerActive = false;
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
        this.log('info', 'Landing');
        break;
      case 'rtl':
        this.s.phase = 'rtl';
        this.s.mode = 'RTL';
        this.plannerActive = false;
        this.log('info', 'Return to launch');
        break;
      case 'setMode':
        if (p.mode) this.s.mode = p.mode;
        this.log('info', `Mode → ${p.mode}`);
        break;
      case 'engageTracking':
        this.plannerActive = false; // exactly one controlSource
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
        if (!this.s.armed) {
          ok = false;
          message = 'Not armed';
          break;
        }
        const plan = p.plan;
        this.plannerActive = true;
        this.s.mode = 'GUIDED';
        if (this.s.phase === 'idle') this.s.phase = 'flying';
        if (this.track.state !== 'idle') {
          this.track.state = 'idle';
          this.track.lockedTargetId = null;
          this.track.estimatedDistance = null;
          this.log('warning', 'Tracking released for planner');
        }
        this.log(
          'info',
          plan
            ? `Executing plan ${plan.requestId} — ${plan.tools.length} step(s), profile ${plan.profile}`
            : 'Executing plan',
        );
        break;
      }
      case 'abortPlan':
        if (this.plannerActive) {
          this.plannerActive = false;
          if (this.s.armed) this.s.mode = 'LOITER';
          this.log('warning', 'Plan aborted — position hold');
        }
        break;
      default:
        ok = false;
        message = 'Unknown command';
    }
    const ack: CommandAck = { type: 'ack', ts: now(), command: cmd.command, success: ok, message };
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
  }

  private stop(): void {
    if (this._tel) clearInterval(this._tel);
    if (this._trk) clearInterval(this._trk);
    if (this._amb) clearInterval(this._amb);
    this._tel = this._trk = this._amb = null;
    this._started = false;
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
      s.lat = lerp(s.lat, HOME.lat, 0.02);
      s.lon = lerp(s.lon, HOME.lon, 0.02);
      if (Math.abs(s.lat - HOME.lat) < 1e-5) {
        s.phase = 'landing';
        s.mode = 'LAND';
      }
    } else if (s.phase === 'landing') {
      s.relAlt = lerp(s.relAlt, 0, 0.05);
      if (s.relAlt < 0.12) {
        s.relAlt = 0;
        s.armed = false;
        s.phase = 'idle';
        s.mode = 'LOITER';
        this.log('info', 'Landed & disarmed');
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
        Math.cos((HOME.lat * Math.PI) / 180);
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
      // drift position while flying
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
    const dLat = (s.lat - HOME.lat) * 111320;
    const dLon = (s.lon - HOME.lon) * 111320 * Math.cos((HOME.lat * Math.PI) / 180);
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
      armed: s.armed,
      mode: s.mode,
      controlSource: this.manual.active
        ? 'manual'
        : this.plannerActive
          ? 'planner'
          : this.track.state === 'locked'
            ? 'tracking'
            : 'auto',
      attitude: { roll: s.roll, pitch: s.pitch, yaw: s.heading },
      position: { lat: s.lat, lon: s.lon, relAlt: s.relAlt, absAlt: s.relAlt + 32 },
      velocity: { groundspeed: s.groundspeed, verticalSpeed: s.vspeed },
      heading: s.heading,
      battery: { voltage: s.voltage, current: s.current, remaining: s.battery },
      gps: { fixType: s.fix, satellites: s.sats, hdop: s.hdop },
      home: { lat: HOME.lat, lon: HOME.lon, distance: homeDist },
      link: { rssi: s.rssi, latencyMs: s.latency },
    });
  }

  private stepTracking(): void {
    const tr = this.track;
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
