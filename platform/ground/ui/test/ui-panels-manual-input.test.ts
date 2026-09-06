/* ManualControl: the stick mapping the vehicle receives, and the panel's
 * engage/release gating as rendered. Pure logic is tested directly; the
 * component is rendered with react-dom/server (no DOM here), which is enough
 * to pin what the operator sees for each armed/flying/active combination. */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MANUAL_DEADZONE,
  MANUAL_KEY_MAP,
  MANUAL_RELEASE_BUTTON,
  MANUAL_ZERO,
  ManualControl,
  applyDeadzone,
  formatChannel,
  isManualKey,
  manualInputFromAxes,
  manualInputFromKeys,
  padDisplayName,
  sameInput,
} from '@/panels/ManualControl';

describe('applyDeadzone', () => {
  it('centres anything inside the dead-zone and passes the rest through', () => {
    expect(applyDeadzone(0.05)).toBe(0);
    expect(applyDeadzone(-0.08)).toBe(0);
    expect(applyDeadzone(MANUAL_DEADZONE)).toBe(MANUAL_DEADZONE);
    expect(applyDeadzone(0.5)).toBe(0.5);
    expect(applyDeadzone(-0.73)).toBe(-0.73);
  });

  it('clamps to the unit range and reads a non-finite sample as centred', () => {
    expect(applyDeadzone(1.4)).toBe(1);
    expect(applyDeadzone(-9)).toBe(-1);
    expect(applyDeadzone(Number.NaN)).toBe(0);
    expect(applyDeadzone(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('manualInputFromAxes', () => {
  it('maps the standard layout: left stick yaw/throttle, right stick roll/pitch, forward is +', () => {
    expect(manualInputFromAxes([0.5, -1, -0.25, 0.75])).toEqual({ yaw: 0.5, throttle: 1, roll: -0.25, pitch: -0.75 });
  });

  it('applies the dead-zone per axis', () => {
    expect(manualInputFromAxes([0.02, 0.05, -0.03, 0.08])).toEqual(MANUAL_ZERO);
  });

  it('treats missing axes as centred', () => {
    expect(manualInputFromAxes([0.3])).toEqual({ yaw: 0.3, throttle: 0, roll: 0, pitch: 0 });
    expect(manualInputFromAxes([])).toEqual(MANUAL_ZERO);
  });
});

describe('manualInputFromKeys', () => {
  it('WASD drives throttle/yaw and the arrows drive pitch/roll', () => {
    expect(manualInputFromKeys(new Set(['KeyW', 'KeyD', 'ArrowUp', 'ArrowRight']))).toEqual({ throttle: 1, yaw: 1, pitch: 1, roll: 1 });
    expect(manualInputFromKeys(new Set(['KeyS', 'KeyA', 'ArrowDown', 'ArrowLeft']))).toEqual({ throttle: -1, yaw: -1, pitch: -1, roll: -1 });
  });

  it('cancels an opposed pair and ignores keys it does not own', () => {
    expect(manualInputFromKeys(new Set(['KeyW', 'KeyS', 'Space', 'KeyT']))).toEqual(MANUAL_ZERO);
  });

  it('claims exactly the eight stick keys — Space (disarm) is never one of them', () => {
    const claimed = Object.values(MANUAL_KEY_MAP).flat();
    expect(claimed).toHaveLength(8);
    for (const code of claimed) expect(isManualKey(code)).toBe(true);
    for (const code of ['Space', 'KeyT', 'KeyR', 'Enter', 'Escape']) expect(isManualKey(code)).toBe(false);
  });
});

describe('release button and frame comparison', () => {
  it('B / Circle is button 1 in the standard layout', () => {
    expect(MANUAL_RELEASE_BUTTON).toBe(1);
  });

  it('sameInput compares all four channels', () => {
    expect(sameInput({ throttle: 0, yaw: 0, pitch: 0, roll: 0 }, MANUAL_ZERO)).toBe(true);
    expect(sameInput({ throttle: 0, yaw: 0, pitch: 0.1, roll: 0 }, MANUAL_ZERO)).toBe(false);
  });
});

describe('display helpers', () => {
  it('strips the vendor/product suffix from a pad id and caps the length', () => {
    expect(padDisplayName('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toBe('Xbox 360 Controller');
    expect(padDisplayName('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)')).toBe('Wireless Controller');
    expect(padDisplayName('(Vendor: 0000 Product: 0000)')).toBe('Gamepad');
    expect(padDisplayName('A very long controller name that goes on and on')).toHaveLength(28);
  });

  it('formats channels signed to one decimal', () => {
    expect(formatChannel(0.5)).toBe('+0.5');
    expect(formatChannel(-1)).toBe('-1.0');
    expect(formatChannel(0)).toBe('+0.0');
    expect(formatChannel(-0)).toBe('+0.0');
  });
});

describe('ManualControl rendering', () => {
  const noop = (): void => {};
  const render = (over: Partial<React.ComponentProps<typeof ManualControl>>): string =>
    renderToStaticMarkup(
      React.createElement(ManualControl, {
        armed: false,
        flying: false,
        manualActive: false,
        onEngage: noop,
        onRelease: noop,
        onInput: noop,
        onControllerChange: noop,
        ...over,
      }),
    );

  it('gates engagement on arming first, then on being airborne', () => {
    expect(render({})).toContain('Arm first');
    expect(render({ armed: true })).toContain('Take off first');
    expect(render({ armed: true, flying: true })).toContain('Hold to take control');
  });

  it('offers the hold-to-engage control when idle and an instant release when active', () => {
    const idle = render({ armed: true, flying: true });
    expect(idle).toContain('Take manual control');
    expect(idle).not.toContain('Release to auto-hold');
    expect(idle).toContain('No pad');

    const active = render({ armed: true, flying: true, manualActive: true });
    expect(active).toContain('Release to auto-hold');
    expect(active).not.toContain('Take manual control');
    expect(active).toContain('Active');
  });

  it('tells the operator about the keyboard fallback when no pad is present', () => {
    const html = render({});
    expect(html).toContain('WASD');
    expect(html).toContain('arrows');
    for (const label of ['THR', 'YAW', 'PITCH', 'ROLL']) expect(html).toContain(label);
  });
});
