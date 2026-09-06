/**
 * Virtual transmitter: two on-screen sticks and a button row, laid out like a Mode 2 radio, driven by mouse or touch.
 *
 *   left stick   X: yaw (turn the nose)        Y: throttle (climb / descend)
 *   right stick  X: roll (slide sideways)      Y: pitch (forward / back)
 *
 * The sticks are velocity commands and spring back to centre when released, like a GPS-mode multirotor. Deflection is
 * shaped with the same deadzone and expo as a gamepad (rc.ts), and `poll()` returns the same `Sticks`, so the caller
 * treats a physical controller, the virtual radio and the keyboard identically. `reflect()` moves the knobs to show
 * input that came from elsewhere (keyboard, gamepad), so the radio always shows what the aircraft is being told.
 */
import { RC_DEFAULT, type RcTuning, type Sticks, shape } from "./rc";

export interface VrcHooks { take(): void; release(): void; home(): void; camera(): void }

interface Stick { pad: HTMLElement; knob: HTMLElement; x: number; y: number; pointer: number | null; radius: number }

export class VirtualRc {
  readonly el: HTMLElement;
  private left: Stick;
  private right: Stick;
  private phaseEl: HTMLElement;
  private takeBtn: HTMLButtonElement;
  private buttons = { take: false, release: false, home: false, camera: false };
  private tuning: RcTuning;

  constructor(host: HTMLElement, hooks: VrcHooks, tuning: RcTuning = RC_DEFAULT) {
    this.tuning = tuning;
    host.innerHTML = `
      <div class="vrc">
        <div class="vrc-stick" data-side="left" title="Left stick: left and right turn the nose, up and down climb and descend">
          <div class="vrc-ring"></div><div class="vrc-cross"></div><div class="vrc-knob"></div>
          <span class="vrc-lbl vrc-lbl-top">CLIMB</span><span class="vrc-lbl vrc-lbl-bottom">DESCEND</span>
          <span class="vrc-lbl vrc-lbl-left">YAW L</span><span class="vrc-lbl vrc-lbl-right">YAW R</span>
        </div>
        <div class="vrc-mid">
          <div class="vrc-title">TRANSMITTER <span class="vrc-mode">MODE 2</span></div>
          <button class="vrc-btn vrc-take" data-act="take" title="Take Manual Control of the selected Drone (or just move a stick)">TAKE CONTROL</button>
          <div class="vrc-row">
            <button class="vrc-btn" data-act="release" title="Hand control back to the Hub (H)">RELEASE</button>
            <button class="vrc-btn" data-act="home" title="Return to the pad (R)">HOME</button>
            <button class="vrc-btn" data-act="camera" title="Cycle RGB, thermal, LiDAR (V)">CAM</button>
          </div>
          <div class="vrc-phase"></div>
        </div>
        <div class="vrc-stick" data-side="right" title="Right stick: up and down fly forward and back along the nose, left and right slide sideways">
          <div class="vrc-ring"></div><div class="vrc-cross"></div><div class="vrc-knob"></div>
          <span class="vrc-lbl vrc-lbl-top">FORWARD</span><span class="vrc-lbl vrc-lbl-bottom">BACK</span>
          <span class="vrc-lbl vrc-lbl-left">SLIDE L</span><span class="vrc-lbl vrc-lbl-right">SLIDE R</span>
        </div>
      </div>`;
    this.el = host.firstElementChild as HTMLElement;
    this.left = this.bind(this.el.querySelector<HTMLElement>('[data-side="left"]')!);
    this.right = this.bind(this.el.querySelector<HTMLElement>('[data-side="right"]')!);
    this.phaseEl = this.el.querySelector<HTMLElement>(".vrc-phase")!;
    this.takeBtn = this.el.querySelector<HTMLButtonElement>(".vrc-take")!;
    for (const b of this.el.querySelectorAll<HTMLButtonElement>(".vrc-btn")) {
      b.addEventListener("click", () => { const act = b.dataset.act as keyof VrcHooks; this.buttons[act] = true; hooks[act](); });
    }
    this.render(this.left); this.render(this.right);
  }

  private bind(pad: HTMLElement): Stick {
    const s: Stick = { pad, knob: pad.querySelector<HTMLElement>(".vrc-knob")!, x: 0, y: 0, pointer: null, radius: 1 };
    const move = (e: PointerEvent) => {
      const r = pad.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      s.radius = r.width / 2 - 14;  // knob stays inside the ring
      let dx = (e.clientX - cx) / s.radius, dy = (e.clientY - cy) / s.radius;
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      s.x = dx; s.y = dy;
      this.render(s);
    };
    pad.addEventListener("pointerdown", (e) => { s.pointer = e.pointerId; pad.setPointerCapture(e.pointerId); pad.classList.add("active"); move(e); e.preventDefault(); });
    pad.addEventListener("pointermove", (e) => { if (s.pointer === e.pointerId) move(e); });
    const up = (e: PointerEvent) => {
      if (s.pointer !== e.pointerId) return;
      s.pointer = null; pad.classList.remove("active");
      this.springBack(s);
    };
    pad.addEventListener("pointerup", up); pad.addEventListener("pointercancel", up);
    return s;
  }

  private springBack(s: Stick): void {
    const x0 = s.x, y0 = s.y, t0 = performance.now(), dur = 140;
    const step = (t: number) => {
      if (s.pointer !== null) return;  // grabbed again
      const u = Math.min(1, (t - t0) / dur), k = 1 - (1 - u) * (1 - u);
      s.x = x0 * (1 - k); s.y = y0 * (1 - k); this.render(s);
      if (u < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  private render(s: Stick): void {
    const r = s.pad.clientWidth / 2 - 14;
    s.knob.style.transform = `translate(${(s.x * r).toFixed(1)}px, ${(s.y * r).toFixed(1)}px)`;
    s.pad.classList.toggle("deflected", Math.hypot(s.x, s.y) > this.tuning.deadzone);
  }

  /** Current sticks, shaped like a gamepad's. Buttons report once per click. */
  poll(): Sticks {
    const sh = (v: number) => shape(v, this.tuning);
    const out: Sticks = {
      yaw: sh(this.left.x), throttle: -sh(this.left.y), roll: sh(this.right.x), pitch: -sh(this.right.y),
      active: false, id: "virtual", buttons: { ...this.buttons },
    };
    out.active = this.left.pointer !== null || this.right.pointer !== null || Math.abs(out.yaw) + Math.abs(out.throttle) + Math.abs(out.roll) + Math.abs(out.pitch) > 0;
    this.buttons = { take: false, release: false, home: false, camera: false };
    return out;
  }

  /** Show input that came from the keyboard or a gamepad on the knobs (only sticks nobody is holding). */
  reflect(s: Sticks): void {
    if (this.left.pointer === null) { this.left.x = s.yaw; this.left.y = -s.throttle; this.render(this.left); }
    if (this.right.pointer === null) { this.right.x = s.roll; this.right.y = -s.pitch; this.render(this.right); }
  }

  /** "arming", "taking off", "live", or "" when not in Manual Control. */
  setPhase(phase: string, inControl: boolean): void {
    this.el.classList.toggle("in-control", inControl);
    this.takeBtn.textContent = inControl ? "IN CONTROL" : "TAKE CONTROL";
    this.phaseEl.textContent = !inControl ? "move a stick or press Take Control" : phase === "live" ? "sticks live" : `${phase}: autopilot holds the sticks until airborne`;
    this.phaseEl.className = `vrc-phase ${inControl ? (phase === "live" ? "live" : "waiting") : ""}`;
  }
}
