/* ============================================================================
 * Stylesheet contract.
 *
 * index.css is the single source of truth for the look; three things depend
 * on it from outside and are pinned here:
 *   1. theme/tokens.ts (`C`) must carry the same literal values as the CSS
 *      custom properties it mirrors — canvas drawing reads the JS copy;
 *   2. every `.eis-*` class a kit component emits must have a rule, and every
 *      keyframe / class name referenced from the panels must still exist;
 *   3. the semantic aliases and the hard sizes the layout is built on.
 * ========================================================================== */
import { readFileSync } from 'node:fs';
import { createElement as h, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { C, GRAY_RAMP, HUE, MAP, VIDEO, cssVariableFor } from '@/theme/tokens';
import type { TokenKey } from '@/theme/tokens';
import {
  Badge, Button, GaugeReadout, HoldButton, IconButton, Modal, Panel, Slider, StatusPill, Tabs, Toast, Toggle,
} from '@/components';
import { AttitudeIndicator, BatteryGauge, Compass, SignalGauge } from '@/instruments';

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

/** Value of a custom property declared anywhere in the stylesheet (first declaration wins). */
function cssToken(name: string): string | undefined {
  const m = new RegExp(`${name.replace(/[-]/g, '\\-')}:\\s*([^;]+);`).exec(css);
  return m?.[1].trim();
}

/* ------------------------------------------------------------------------- */
describe('theme/tokens mirrors index.css', () => {
  it('names the custom property for each key', () => {
    expect(cssVariableFor('gray0')).toBe('--gray-0');
    expect(cssVariableFor('gray12')).toBe('--gray-12');
    expect(cssVariableFor('blue')).toBe('--blue');
    expect(cssVariableFor('blueBright')).toBe('--blue-bright');
    expect(cssVariableFor('amberDeep')).toBe('--amber-deep');
  });

  it.each(Object.keys(C) as TokenKey[])('C.%s equals its CSS custom property', (key) => {
    expect(cssToken(cssVariableFor(key))).toBe(C[key]);
  });

  it('the ramp and hue families are what C is assembled from', () => {
    expect(GRAY_RAMP).toHaveLength(13);
    expect(C.gray0).toBe(GRAY_RAMP[0]);
    expect(C.gray12).toBe(GRAY_RAMP[12]);
    expect(C.red).toBe(HUE.red.base);
    expect(C.greenDeep).toBe(HUE.green.deep);
  });

  it('canvas palettes keep the literal values the mock scene and map are drawn with', () => {
    expect(VIDEO).toEqual({
      skyTop: '#0e1c28', skyBottom: '#26323a',
      groundTop: '#2a3a30', groundBottom: '#161f1a',
      letterbox: '#0a1016',
      bodyLocked: '#3a4654', body: '#34404c', head: '#414f5e',
    });
    expect(MAP).toEqual({
      base: '#1c2a1e',
      fieldTones: ['#243425', '#2c3a26', '#33402a', '#3b3a28', '#2a3530'],
      river: '#1c3344',
      droneFill: '#ffc24b', droneStroke: '#0b0d11',
      home: '#e6eaf0', target: '#f04438',
    });
  });
});

/* ------------------------------------------------------------------------- */
describe('index.css keeps what the rest of the UI references', () => {
  it.each([
    'eis-ping', 'eis-ping2', 'eis-trackpulse', 'eis-batpulse', 'eis-spin', 'eis-toast', 'eis-fade', 'eis-rise',
  ])('defines @keyframes %s', (name) => {
    expect(css).toMatch(new RegExp(`@keyframes\\s+${name}\\s*\\{`));
  });

  it.each(['.eis-readout', '.eis-label', '.argus-grid', '.argus-hint', '.leaflet-container', '.leaflet-control-attribution'])(
    'has a rule for %s', (selector) => { expect(css).toContain(selector); },
  );

  it('keeps the semantic aliases the panels and argus.css read', () => {
    for (const name of [
      '--bg-app', '--bg-sunken', '--surface-panel', '--surface-raised', '--surface-input', '--surface-hover', '--surface-overlay', '--scrim',
      '--border-subtle', '--border-default', '--border-strong', '--border-input',
      '--text-primary', '--text-secondary', '--text-tertiary', '--text-disabled', '--text-on-accent',
      '--accent', '--accent-hover', '--accent-active', '--accent-text', '--accent-subtle', '--accent-border', '--focus-ring',
      '--nominal', '--caution', '--danger', '--critical', '--inactive', '--info',
      '--nominal-fg', '--caution-fg', '--danger-fg', '--nominal-bg', '--caution-bg', '--danger-bg', '--info-bg',
      '--font-sans', '--font-mono', '--ring', '--needle-ease', '--ease-out', '--dur-fast', '--dur-base', '--dur-slow',
      '--glow-accent', '--glow-caution', '--glow-critical', '--shadow-raised', '--shadow-popover', '--shadow-modal',
    ]) {
      expect(cssToken(name), name).toBeDefined();
    }
  });

  it('keeps the layout constants App.tsx sizes its grid with', () => {
    expect(cssToken('--statusbar-h')).toBe('46px');
    expect(cssToken('--leftpanel-w')).toBe('264px');
    expect(cssToken('--rightpanel-w')).toBe('300px');
    expect(cssToken('--console-h')).toBe('180px');
    expect(cssToken('--control-h')).toBe('32px');
    expect(cssToken('--control-h-xl')).toBe('52px');
    expect(cssToken('--radius-md')).toBe('7px');
  });

  it('keeps the ARGUS laptop breakpoint intact', () => {
    expect(css).toContain('@media (max-width: 1320px), (max-height: 760px)');
    expect(css).toMatch(/\.argus-grid \{ grid-template-columns: 222px 1fr 236px !important; gap: 6px !important; padding: 6px !important; \}/);
    expect(css).toMatch(/\.argus-hint \{ display: none; \}/);
  });
});

/* ------------------------------------------------------------------------- */
describe('every class the kit emits has a rule', () => {
  const html = renderToStaticMarkup(h(Fragment, null,
    h(Badge, { mono: true }, 'b'),
    h(Button, { pending: true }, 'b'),
    h(GaugeReadout, { label: 'l', value: 1, unit: 'm', trend: 'up' }),
    h(HoldButton, { icon: h('i') }, 'h'),
    h(IconButton, { icon: h('i') }),
    h(Modal, { title: 'm', subtitle: 's', icon: h('i'), onClose: () => undefined, footer: 'f' }, 'x'),
    h(Panel, { title: 'p', icon: h('i'), status: 's', actions: 'a' }, 'p'),
    h(Slider, { label: 'l', value: 1, unit: 'u', ticks: ['a'] }),
    h(StatusPill, { pulse: true }, 's'),
    h(Tabs, { value: 't', items: [{ id: 't', label: 't' }] }),
    h(Toast, { title: 't', message: 'm', icon: h('i'), onDismiss: () => undefined }),
    h(Toggle, { label: 'l' }),
    h(AttitudeIndicator, null),
    h(Compass, null),
    h(BatteryGauge, { voltage: 1, current: 1, cells: 4 }),
    h(SignalGauge, null),
  ));
  const classes = new Set<string>();
  for (const m of html.matchAll(/class="([^"]+)"/g)) for (const c of m[1].split(/\s+/)) if (c.startsWith('eis-')) classes.add(c);

  it('found the kit classes in the rendered markup', () => {
    expect(classes.size).toBeGreaterThan(30);
  });

  it.each([...classes].sort())('%s is styled', (cls) => {
    expect(css).toMatch(new RegExp(`\\.${cls}(?![\\w-])`));
  });
});
