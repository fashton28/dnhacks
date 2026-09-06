/**
 * RC controller input for Manual Control: any gamepad the browser exposes (Xbox, PlayStation, 8BitDo, a real RC
 * transmitter in joystick mode) becomes a Mode 2 transmitter:
 *
 *   left stick   X: yaw (turn the nose)        Y: throttle (climb / descend)
 *   right stick  X: roll (slide sideways)      Y: pitch (forward / back)
 *   A / cross    take control                  B / circle   release control (Hub resumes)
 *   Y / triangle return home                   X / square   cycle camera mode (RGB, thermal, LiDAR)
 *
 * Sticks are normalised to [-1, 1] with a deadzone and an expo curve, the way a transmitter is set up: small inputs
 * move the aircraft gently, full deflection is fast. The caller scales them to velocities and a yaw rate.
 */

export interface Sticks {
  /** forward positive */ pitch: number;
  /** right positive */ roll: number;
  /** up positive */ throttle: number;
  /** clockwise positive */ yaw: number;
  /** any stick outside its deadzone or a button held this poll */ active: boolean;
  /** gamepad id, or null when none is connected */ id: string | null;
  buttons: { take: boolean; release: boolean; home: boolean; camera: boolean };
}

export interface RcTuning { deadzone: number; expo: number }
export const RC_DEFAULT: RcTuning = { deadzone: 0.08, expo: 0.35 };

/** Deadzone then expo: x in [-1, 1] -> [-1, 1]; expo 0 is linear, 1 is fully cubic around centre. */
export function shape(x: number, t: RcTuning = RC_DEFAULT): number {
  const a = Math.abs(x);
  if (a < t.deadzone) return 0;
  const n = Math.min(1, (a - t.deadzone) / (1 - t.deadzone));
  return Math.sign(x) * ((1 - t.expo) * n + t.expo * n * n * n);
}

const NONE: Sticks = { pitch: 0, roll: 0, throttle: 0, yaw: 0, active: false, id: null, buttons: { take: false, release: false, home: false, camera: false } };

export class RcController {
  private prevButtons = new Set<number>();
  onConnect: ((id: string) => void) | null = null;
  onDisconnect: ((id: string) => void) | null = null;
  tuning: RcTuning;
  constructor(tuning: RcTuning = RC_DEFAULT) {
    this.tuning = tuning;
    window.addEventListener("gamepadconnected", (e) => this.onConnect?.((e as GamepadEvent).gamepad.id));
    window.addEventListener("gamepaddisconnected", (e) => this.onDisconnect?.((e as GamepadEvent).gamepad.id));
  }

  /** Poll once per frame or per command tick. Buttons report a rising edge only, so a held button fires once. */
  poll(): Sticks {
    const pads = typeof navigator.getGamepads === "function" ? navigator.getGamepads() : [];
    const gp = Array.from(pads).find((p): p is Gamepad => !!p && p.connected);
    if (!gp) { this.prevButtons.clear(); return NONE; }
    const ax = (i: number) => shape(gp.axes[i] ?? 0, this.tuning);
    const pressed = new Set<number>(); gp.buttons.forEach((b, i) => { if (b.pressed) pressed.add(i); });
    const edge = (i: number) => pressed.has(i) && !this.prevButtons.has(i);
    const s: Sticks = {
      yaw: ax(0), throttle: -ax(1), roll: ax(2), pitch: -ax(3),  // browser axes point down and right; a transmitter's forward and up are negative there
      active: false, id: gp.id,
      buttons: { take: edge(0), release: edge(1), camera: edge(2), home: edge(3) },
    };
    s.active = Math.abs(s.pitch) + Math.abs(s.roll) + Math.abs(s.throttle) + Math.abs(s.yaw) > 0 || pressed.size > 0;
    this.prevButtons = pressed;
    return s;
  }
}
