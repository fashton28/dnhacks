/**
 * Rotor sound for the Drone view, synthesised with the Web Audio API so no asset is needed.
 *
 * Four slightly detuned rotor tones (a saw through a low-pass filter for the motor hum plus a blade-pass buzz), a band
 * of wind noise, and one master gain. `update()` maps the aircraft's state to a load figure: silent when disarmed on
 * the pad, an idle spin when armed, climbing with altitude, speed and climb rate. Browsers only start audio after a
 * user gesture, so `arm()` resumes the context on the first pointer or key event.
 */
export interface DroneSoundState { armed: boolean; alt: number; speed: number; climb: number }

export class DroneSound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private rotorGain: GainNode | null = null;
  private noiseGain: GainNode | null = null;
  private oscs: OscillatorNode[] = [];
  private filter: BiquadFilterNode | null = null;
  private noiseFilter: BiquadFilterNode | null = null;
  private muted = false;
  private load = 0;
  private gesture: (() => void) | null = null;

  start(): void {
    if (this.ctx) return;
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx(); this.ctx = ctx;
    const master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination); this.master = master;
    // rotors: four saws a few cents apart, through a low-pass that opens with load
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 600; filter.Q.value = 0.7; this.filter = filter;
    const rotorGain = ctx.createGain(); rotorGain.gain.value = 0.55; filter.connect(rotorGain); rotorGain.connect(master); this.rotorGain = rotorGain;
    for (const detune of [-9, -3, 4, 11]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 110; o.detune.value = detune;
      const g = ctx.createGain(); g.gain.value = 0.22; o.connect(g); g.connect(filter); o.start(); this.oscs.push(o);
    }
    // blade-pass buzz: a triangle two octaves up, quieter
    const buzz = ctx.createOscillator(); buzz.type = 'triangle'; buzz.frequency.value = 440;
    const bg = ctx.createGain(); bg.gain.value = 0.08; buzz.connect(bg); bg.connect(filter); buzz.start(); this.oscs.push(buzz);
    // wind and prop wash: looped white noise through a band-pass
    const seconds = 2, buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const data = buf.getChannelData(0); for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
    const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 900; nf.Q.value = 0.5; this.noiseFilter = nf;
    const ng = ctx.createGain(); ng.gain.value = 0; noise.connect(nf); nf.connect(ng); ng.connect(master); noise.start(); this.noiseGain = ng;
    this.arm();
  }

  /** Browsers gate audio behind a gesture: resume on the first pointer or key event, then forget the listener. */
  private arm(): void {
    const resume = () => { void this.ctx?.resume(); };
    if (this.ctx?.state === 'running') return;
    this.gesture = resume;
    window.addEventListener('pointerdown', resume, { once: true });
    window.addEventListener('keydown', resume, { once: true });
  }

  setMuted(m: boolean): void { this.muted = m; this.apply(); }
  isMuted(): boolean { return this.muted; }
  /** True once the browser has let audio through. */
  get running(): boolean { return this.ctx?.state === 'running'; }

  update(s: DroneSoundState): void {
    // load: 0 disarmed, ~0.3 armed on the pad, up to 1 at full climb and speed
    const target = !s.armed ? 0 : Math.max(0.28, Math.min(1, 0.42 + (s.alt > 0.3 ? 0.12 : 0) + 0.06 * Math.max(0, s.climb) + 0.035 * s.speed));
    this.load = target;
    this.apply();
  }

  private apply(): void {
    const ctx = this.ctx; if (!ctx || !this.master || !this.filter || !this.noiseGain || !this.noiseFilter) return;
    const t = ctx.currentTime, k = 0.25, load = this.load;
    const vol = this.muted ? 0 : (load === 0 ? 0 : 0.045 + 0.13 * load);
    this.master.gain.setTargetAtTime(vol, t, load === 0 ? 0.6 : k);
    const f0 = 92 + 96 * load;                                 // motor tone rises with load
    this.oscs.forEach((o, i) => o.frequency.setTargetAtTime(i === 4 ? f0 * 4 : f0, t, k));
    this.filter.frequency.setTargetAtTime(420 + 1400 * load, t, k);
    this.noiseGain.gain.setTargetAtTime(0.18 * load * load, t, k);
    this.noiseFilter.frequency.setTargetAtTime(700 + 900 * load, t, k);
  }

  stop(): void {
    const ctx = this.ctx; if (!ctx) return;
    if (this.gesture) { window.removeEventListener('pointerdown', this.gesture); window.removeEventListener('keydown', this.gesture); this.gesture = null; }
    this.master?.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
    const done = () => { this.oscs.forEach((o) => { try { o.stop(); } catch { /* already stopped */ } }); void ctx.close(); };
    setTimeout(done, 300);
    this.ctx = null; this.master = null; this.oscs = [];
  }
}
