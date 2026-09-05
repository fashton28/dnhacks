/* ============================================================================
   Drone Safety Platform — UI-kit mock data layer
   A self-contained, lifelike mock that mirrors the PRD's DataSource contract
   (Section 4). Drives the whole demo with no backend: telemetry @ ~10Hz,
   tracking with bboxes that match the canvas scene, status-text log, and a
   command state machine. Exposes window.EISMock (a singleton).
   ============================================================================ */
(function () {
  const HOME = { lat: 37.7699, lon: -122.4666 }; // generic park
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const now = () => Date.now();

  class Mock {
    constructor() {
      this.cbs = { tel: [], trk: [], txt: [], ack: [], conn: [] };
      this.connState = 'connected';
      this.config = { host: 'sitl', controlPort: 8765, videoUrl: '', sitl: true };

      this.t = 0;
      this.s = {
        armed: false,
        mode: 'LOITER',
        relAlt: 0,
        targetAlt: 0,
        roll: 0, pitch: 0, yaw: 0,
        heading: 215,
        lat: HOME.lat, lon: HOME.lon,
        groundspeed: 0, vspeed: 0,
        battery: 96, voltage: 16.6, current: 0.4,
        sats: 16, fix: 3, hdop: 0.7,
        rssi: -48, latency: 38,
        phase: 'idle',         // idle | takeoff | flying | rtl | landing
      };

      this.track = {
        state: 'idle',
        standoff: 4,
        maxSpeed: 3,
        estimatedDistance: null,
        lockedTargetId: null,
        targets: [],
      };
      // two "people" moving in the frame (normalised centre + size)
      this.people = [
        { id: 1, x: 0.40, y: 0.58, w: 0.10, h: 0.30, vx: 0.0011, conf: 0.0 },
        { id: 2, x: 0.66, y: 0.55, w: 0.09, h: 0.27, vx: -0.0008, conf: 0.0 },
      ];
      this._lostTimer = 0;
      this._started = false;

      // manual (game-controller) piloting
      this.manual = { active: false, throttle: 0, yaw: 0, pitch: 0, roll: 0 };
    }

    /* high-frequency stick input — bypasses the ack path on purpose */
    setManualInput(v) { Object.assign(this.manual, v); }

    /* ---- subscription API (DataSource-shaped) ---------------------------- */
    onTelemetry(cb) { this.cbs.tel.push(cb); return () => this._off('tel', cb); }
    onTracking(cb) { this.cbs.trk.push(cb); return () => this._off('trk', cb); }
    onStatusText(cb) { this.cbs.txt.push(cb); return () => this._off('txt', cb); }
    onAck(cb) { this.cbs.ack.push(cb); return () => this._off('ack', cb); }
    onConnectionChange(cb) { this.cbs.conn.push(cb); cb(this.connState); return () => this._off('conn', cb); }
    getVideoUrl() { return ''; }
    _off(k, cb) { this.cbs[k] = this.cbs[k].filter(f => f !== cb); }
    _emit(k, msg) { this.cbs[k].forEach(f => f(msg)); }

    log(severity, text) { this._emit('txt', { type: 'statusText', ts: now(), severity, text }); }

    /* ---- command handling ------------------------------------------------ */
    sendCommand(cmd) {
      const p = cmd.params || {};
      let ok = true, message = 'OK';
      switch (cmd.command) {
        case 'arm':
          this.s.armed = true; this.log('info', 'Vehicle ARMED'); break;
        case 'disarm':
        case 'emergencyStop':
          this.s.armed = false; this.s.phase = 'idle'; this.s.mode = 'LOITER';
          this.s.targetAlt = 0;
          this.manual.active = false; this.manual.throttle = this.manual.yaw = this.manual.pitch = this.manual.roll = 0;
          if (this.track.state !== 'idle') { this.track.state = 'idle'; this.track.lockedTargetId = null; this.track.estimatedDistance = null; }
          this.log(cmd.command === 'emergencyStop' ? 'critical' : 'warning', cmd.command === 'emergencyStop' ? 'EMERGENCY STOP — motors disarmed' : 'Vehicle DISARMED');
          break;
        case 'takeoff':
          if (!this.s.armed) { ok = false; message = 'Not armed'; break; }
          this.s.phase = 'takeoff'; this.s.mode = 'GUIDED';
          this.s.targetAlt = p.altitude || 4;
          this.log('info', `Takeoff to ${this.s.targetAlt} m`); break;
        case 'land':
          this.s.phase = 'landing'; this.s.mode = 'LAND';
          this.log('info', 'Landing'); break;
        case 'rtl':
          this.s.phase = 'rtl'; this.s.mode = 'RTL';
          this.log('info', 'Return to launch'); break;
        case 'setMode':
          this.s.mode = p.mode; this.log('info', `Mode → ${p.mode}`); break;
        case 'engageTracking':
          this.track.state = 'searching';
          this.log('info', 'Tracking engaged — searching'); break;
        case 'disengageTracking':
          this.track.state = 'idle'; this.track.lockedTargetId = null; this.track.estimatedDistance = null;
          this.log('warning', 'Tracking disengaged'); break;
        case 'selectTarget':
          this.track.lockedTargetId = p.targetId;
          if (this.track.state === 'idle') this.track.state = 'searching';
          this.log('info', `Target #${p.targetId} selected`); break;
        case 'setStandoff':
          this.track.standoff = p.meters; break;
        case 'setMaxSpeed':
          this.track.maxSpeed = p.mps; break;
        case 'engageManual':
          if (!this.s.armed) { ok = false; message = 'Not armed'; break; }
          this.manual.active = true; this.s.mode = 'STABILIZE';
          if (this.s.phase === 'idle') this.s.phase = 'flying';
          if (this.track.state !== 'idle') { this.track.state = 'idle'; this.track.lockedTargetId = null; this.track.estimatedDistance = null; this.log('warning', 'Tracking released for manual control'); }
          this.log('warning', 'MANUAL CONTROL engaged'); break;
        case 'disengageManual':
          this.manual.active = false; this.manual.throttle = this.manual.yaw = this.manual.pitch = this.manual.roll = 0;
          if (this.s.armed) this.s.mode = 'LOITER';
          this.log('info', 'Manual released — position hold'); break;
        default: ok = false; message = 'Unknown command';
      }
      const ack = { type: 'ack', ts: now(), command: cmd.command, success: ok, message };
      setTimeout(() => this._emit('ack', ack), 60);
      return Promise.resolve(ack);
    }

    /* ---- simulation loop ------------------------------------------------- */
    start() {
      if (this._started) return; this._started = true;
      this.log('info', 'EKF healthy');
      this.log('info', 'GPS fix acquired — 16 sats');
      this._tel = setInterval(() => this.stepTelemetry(), 100);   // 10 Hz
      this._trk = setInterval(() => this.stepTracking(), 120);
      this._amb = setInterval(() => this.ambientLog(), 7000);
    }
    stop() { clearInterval(this._tel); clearInterval(this._trk); clearInterval(this._amb); this._started = false; }

    stepTelemetry() {
      const s = this.s; this.t += 0.1;
      // altitude toward target
      if (s.phase === 'takeoff') {
        s.relAlt = lerp(s.relAlt, s.targetAlt, 0.06);
        if (Math.abs(s.relAlt - s.targetAlt) < 0.15) { s.relAlt = s.targetAlt; s.phase = 'flying'; this.log('info', 'Reached target altitude'); }
      } else if (s.phase === 'rtl') {
        s.lat = lerp(s.lat, HOME.lat, 0.02); s.lon = lerp(s.lon, HOME.lon, 0.02);
        if (Math.abs(s.lat - HOME.lat) < 1e-5) { s.phase = 'landing'; s.mode = 'LAND'; }
      } else if (s.phase === 'landing') {
        s.relAlt = lerp(s.relAlt, 0, 0.05);
        if (s.relAlt < 0.12) { s.relAlt = 0; s.armed = false; s.phase = 'idle'; s.mode = 'LOITER'; this.log('info', 'Landed & disarmed'); }
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
        const fwd = -man.pitch, lat = man.roll;
        s.groundspeed = Math.min(this.track.maxSpeed * 1.6, Math.hypot(fwd, lat) * 6);
        const hd = s.heading * Math.PI / 180;
        const step = 1.0e-5;
        s.lat += (Math.cos(hd) * fwd - Math.sin(hd) * lat) * step;
        s.lon += (Math.sin(hd) * fwd + Math.cos(hd) * lat) * step / Math.cos(HOME.lat * Math.PI / 180);
      } else {
        // gentle attitude motion when flying (autonomous)
        s.roll = flying ? Math.sin(this.t * 0.6) * 7 + (this.track.state === 'locked' ? Math.sin(this.t * 1.7) * 3 : 0) : lerp(s.roll, 0, 0.1);
        s.pitch = flying ? Math.cos(this.t * 0.5) * 4 : lerp(s.pitch, 0, 0.1);
        s.heading = (s.heading + (flying ? 0.25 + (this.track.state === 'locked' ? 0.5 : 0) : 0)) % 360;
        s.groundspeed = flying ? clamp(1.2 + Math.sin(this.t * 0.4) * 0.8 + (this.track.state === 'locked' ? 1.2 : 0), 0, this.track.maxSpeed) : lerp(s.groundspeed, 0, 0.2);
        s.vspeed = s.phase === 'takeoff' ? 1.4 : s.phase === 'landing' ? -0.8 : flying ? Math.sin(this.t * 0.9) * 0.3 : 0;
        // drift position while flying
        if (flying && s.phase === 'flying') {
          s.lat += Math.cos(s.heading * Math.PI / 180) * 1.2e-6;
          s.lon += Math.sin(s.heading * Math.PI / 180) * 1.2e-6;
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
      const dLon = (s.lon - HOME.lon) * 111320 * Math.cos(HOME.lat * Math.PI / 180);
      const homeDist = Math.sqrt(dLat * dLat + dLon * dLon);

      // battery warnings
      const b = Math.round(s.battery);
      if (b === 30 && !this._warn30) { this._warn30 = true; this.log('warning', 'Battery 30% — consider RTL'); }
      if (b === 15 && !this._warn15) { this._warn15 = true; this.log('critical', 'Battery 15% — failsafe imminent'); }

      this._emit('tel', {
        type: 'telemetry', ts: now(),
        armed: s.armed, mode: s.mode,
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

    stepTracking() {
      const tr = this.track;
      // move people
      this.people.forEach(p => {
        p.x += p.vx; if (p.x < 0.12 || p.x > 0.88) p.vx *= -1;
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
        tr.estimatedDistance = lerp(tr.estimatedDistance ?? tr.standoff, tr.standoff, 0.04) + Math.sin(this.t * 1.1) * 0.06;
        // occasional lost
        this._lostTimer += 0.12;
        if (this._lostTimer > 22 && Math.random() < 0.01) {
          tr.state = 'lost'; this._lostTimer = 0;
          this.log('warning', 'Tracking lock lost — re-acquiring');
        }
      } else if (tr.state === 'lost') {
        if (!this._lostStart) this._lostStart = this.t;
        if (this.t - this._lostStart > 1.8) { tr.state = 'locked'; this._lostStart = 0; this.log('info', 'Target re-acquired'); }
      }

      tr.targets = this.people.map(p => ({
        id: p.id,
        bbox: [p.x - p.w / 2, p.y - p.h / 2, p.w, p.h],
        confidence: p.conf,
        isLocked: tr.state === 'locked' && p.id === tr.lockedTargetId,
      }));

      this._emit('trk', {
        type: 'tracking', ts: now(),
        state: tr.state, targets: tr.targets,
        lockedTargetId: tr.lockedTargetId,
        standoffDistance: tr.standoff,
        estimatedDistance: tr.state === 'locked' ? tr.estimatedDistance : null,
        maxSpeed: tr.maxSpeed,
      });
    }

    ambientLog() {
      const msgs = [
        ['info', 'GCS heartbeat OK'],
        ['info', `Satellites: ${this.s.sats} · HDOP ${this.s.hdop.toFixed(1)}`],
        ['info', 'EKF variance nominal'],
        ['info', `Link RSSI ${Math.round(this.s.rssi)} dBm`],
      ];
      const m = msgs[Math.floor(Math.random() * msgs.length)];
      this.log(m[0], m[1]);
    }
  }

  window.EISMock = new Mock();
})();
