/* ============================================================================
 * Kit primitives: prop → markup contracts.
 *
 * No DOM is installed here (see test/setup.ts), so components are rendered
 * with react-dom/server. What is pinned is the shape consumers and the
 * stylesheet depend on: the `.eis-*` class each element carries, the
 * data-attributes that select its variant, the ARIA roles/states, and which
 * children appear for which props. Colours and sizes live in index.css and
 * are covered by the stylesheet contract test.
 * ========================================================================== */
import { createElement as h, Fragment } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Badge, Button, GaugeReadout, HoldButton, IconButton, Modal, Panel, Slider, StatusPill, Tabs, Toast, Toggle,
  buttonSize, buttonVariant, sliderPercent, trendGlyph,
} from '@/components';

const render = (el: ReactElement): string => renderToStaticMarkup(el);
const count = (html: string, needle: string): number => html.split(needle).length - 1;

/* ------------------------------------------------------------------------- */
describe('Button', () => {
  it('defaults to a secondary, medium, inline, enabled button of type=button', () => {
    const html = render(h(Button, null, 'Arm'));
    expect(html).toMatch(/^<button [^>]*type="button"/);
    expect(html).toContain('class="eis-btn"');
    expect(html).toContain('data-variant="secondary"');
    expect(html).toContain('data-size="md"');
    expect(html).not.toContain('data-block');
    expect(html).not.toContain('disabled');
    expect(html).toContain('<span>Arm</span>');
  });

  it('exposes variant, size and block as data-attributes', () => {
    const html = render(h(Button, { variant: 'danger-soft', size: 'lg', block: true }, 'RTL'));
    expect(html).toContain('data-variant="danger-soft"');
    expect(html).toContain('data-size="lg"');
    expect(html).toContain('data-block="true"');
  });

  it('pending: inert, aria-busy, spinner in the icon slot, trailing icon hidden', () => {
    const html = render(h(Button, {
      pending: true,
      icon: h('i', { className: 'lead' }),
      iconRight: h('i', { className: 'trail' }),
    }, 'Dispatch'));
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('class="eis-spin"');
    expect(html).not.toContain('class="lead"');
    expect(html).not.toContain('class="trail"');
  });

  it('renders leading and trailing icons around the label when not pending', () => {
    const html = render(h(Button, { icon: h('i', { className: 'lead' }), iconRight: h('i', { className: 'trail' }) }, 'Go'));
    expect(html.indexOf('class="lead"')).toBeLessThan(html.indexOf('<span>Go</span>'));
    expect(html.indexOf('<span>Go</span>')).toBeLessThan(html.indexOf('class="trail"'));
  });

  it('omits the label span entirely when there are no children', () => {
    const html = render(h(Button, { icon: h('i', { className: 'lead' }) }));
    expect(html).not.toContain('<span></span>');
  });

  it('passes native attributes through and merges className', () => {
    const html = render(h(Button, { title: 'Zoom in', className: 'extra', 'data-testid': 'zoom' } as never, 'Z'));
    expect(html).toContain('title="Zoom in"');
    expect(html).toContain('class="eis-btn extra"');
    expect(html).toContain('data-testid="zoom"');
  });

  it('inline style survives (consumers nudge alignment with it)', () => {
    const html = render(h(Button, { style: { marginLeft: 'auto' } }, 'X'));
    expect(html).toContain('style="margin-left:auto"');
  });

  it('coerces unknown variants and sizes to the defaults', () => {
    expect(buttonVariant('bogus')).toBe('secondary');
    expect(buttonVariant(undefined)).toBe('secondary');
    expect(buttonVariant('primary')).toBe('primary');
    expect(buttonSize('xl')).toBe('md');
    expect(buttonSize('sm')).toBe('sm');
  });
});

/* ------------------------------------------------------------------------- */
describe('IconButton', () => {
  it('uses title as the accessible name and exposes size/variant', () => {
    const html = render(h(IconButton, { icon: h('i'), title: 'Zoom in', size: 'sm', variant: 'solid' }));
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).toContain('title="Zoom in"');
    expect(html).toContain('class="eis-iconbtn"');
    expect(html).toContain('data-size="sm"');
    expect(html).toContain('data-variant="solid"');
    expect(html).toContain('type="button"');
    expect(html).not.toContain('data-active');
  });

  it('active is both a data-attribute and aria-pressed', () => {
    const html = render(h(IconButton, { icon: h('i'), active: true }));
    expect(html).toContain('data-active="true"');
    expect(html).toContain('aria-pressed="true"');
  });

  it('disabled reaches the element', () => {
    expect(render(h(IconButton, { icon: h('i'), disabled: true }))).toContain('disabled=""');
  });
});

/* ------------------------------------------------------------------------- */
describe('Tabs', () => {
  const items = [
    { id: 'flight', label: 'Flight ops' },
    { id: 'mission', label: 'Mission', icon: h('i', { className: 'ico' }) },
  ];

  it('is a tablist of tab buttons with exactly one selected', () => {
    const html = render(h(Tabs, { items, value: 'mission', size: 'sm' }));
    expect(html).toMatch(/^<div role="tablist" class="eis-tabs" data-size="sm"/);
    expect(count(html, 'role="tab"')).toBe(2);
    expect(count(html, 'aria-selected="true"')).toBe(1);
    expect(count(html, 'aria-selected="false"')).toBe(1);
    expect(html).toContain('class="ico"');
    expect(html).toContain('Flight ops');
  });

  it('every tab is a real button so a surrounding form never submits', () => {
    const html = render(h(Tabs, { items, value: 'flight' }));
    expect(count(html, 'type="button"')).toBe(2);
  });

  it('renders an empty tablist when given no items', () => {
    expect(render(h(Tabs, { value: 'x' }))).toBe('<div role="tablist" class="eis-tabs" data-size="md"></div>');
  });
});

/* ------------------------------------------------------------------------- */
describe('Toggle', () => {
  it('without a label it is a bare switch carrying the style', () => {
    const html = render(h(Toggle, { checked: true, style: { margin: 4 } }));
    expect(html).toMatch(/^<button type="button" role="switch" class="eis-switch" aria-checked="true"/);
    expect(html).toContain('style="margin:4px"');
    expect(html).toContain('class="eis-switch-knob"');
    expect(html).not.toContain('<label');
  });

  it('with a label it is wrapped in a <label> that takes the style and the text', () => {
    const html = render(h(Toggle, { label: 'Diff', size: 'sm', style: { flexDirection: 'row-reverse' } }));
    expect(html).toMatch(/^<label class="eis-switch-row" style="flex-direction:row-reverse">/);
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('data-size="sm"');
    expect(html).toContain('<span class="eis-switch-text">Diff</span>');
  });

  it('disabled marks both the switch and its row', () => {
    const html = render(h(Toggle, { label: 'SITL', disabled: true }));
    expect(html).toContain('data-disabled="true"');
    expect(html).toContain('disabled=""');
  });
});

/* ------------------------------------------------------------------------- */
describe('Badge', () => {
  it('neutral sans by default', () => {
    expect(render(h(Badge, null, '12'))).toBe('<span class="eis-badge" data-tone="neutral">12</span>');
  });
  it('tone and mono are data-attributes', () => {
    const html = render(h(Badge, { tone: 'caution', mono: true }, 'OFFLINE'));
    expect(html).toContain('data-tone="caution"');
    expect(html).toContain('data-mono="true"');
  });
});

/* ------------------------------------------------------------------------- */
describe('StatusPill', () => {
  it('neutral, medium, dotted by default', () => {
    const html = render(h(StatusPill, null, 'Disarmed'));
    expect(html).toContain('class="eis-pill"');
    expect(html).toContain('data-status="neutral"');
    expect(html).toContain('data-size="md"');
    expect(html).toContain('class="eis-pill-dot"');
    expect(html).not.toContain('data-pulse');
    expect(html).not.toContain('data-solid');
    expect(html).toContain('Disarmed');
  });

  it('pulse and solid are data-attributes on the dot / pill', () => {
    const html = render(h(StatusPill, { status: 'danger', solid: true, pulse: true, size: 'sm' }, 'Armed'));
    expect(html).toContain('data-status="danger"');
    expect(html).toContain('data-solid="true"');
    expect(html).toContain('data-pulse="true"');
    expect(html).toContain('data-size="sm"');
  });

  it('dot=false or an explicit icon suppresses the dot', () => {
    expect(render(h(StatusPill, { dot: false }, 'x'))).not.toContain('eis-pill-dot');
    const iconed = render(h(StatusPill, { icon: h('i', { className: 'ico' }) }, 'x'));
    expect(iconed).not.toContain('eis-pill-dot');
    expect(iconed).toContain('class="ico"');
  });
});

/* ------------------------------------------------------------------------- */
describe('Panel', () => {
  it('is a section with a padded, non-scrolling body and no header when nothing fills one', () => {
    const html = render(h(Panel, null, h('p', null, 'body')));
    expect(html).toMatch(/^<section class="eis-panel" data-variant="default"><div class="eis-panel-body" data-pad="true"><p>body<\/p><\/div><\/section>$/);
  });

  it('header = section > header, carrying icon, uppercase label, status and right-aligned actions in that order', () => {
    const html = render(h(Panel, {
      title: 'Event log',
      icon: h('i', { className: 'ico' }),
      status: h('b', null, '3'),
      actions: h('em', null, 'act'),
    }));
    expect(html).toMatch(/^<section [^>]*><header>/);
    const order = ['eis-panel-icon', 'eis-label', 'eis-panel-status', 'eis-panel-actions'].map((c) => html.indexOf(c));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain('<span class="eis-label">Event log</span>');
  });

  it('status or actions alone are enough for a header', () => {
    expect(render(h(Panel, { status: h('b', null, '1') }))).toContain('<header>');
    expect(render(h(Panel, { actions: h('b', null, 'a') }))).toContain('<header>');
  });

  it('pad=false, scroll, variant and bodyStyle reach the markup', () => {
    const html = render(h(Panel, { pad: false, scroll: true, variant: 'sunken', style: { height: '100%' }, bodyStyle: { position: 'relative' } }));
    expect(html).toContain('data-variant="sunken"');
    expect(html).toContain('style="height:100%"');
    expect(html).not.toContain('data-pad');
    expect(html).toContain('data-scroll="true"');
    expect(html).toContain('style="position:relative"');
  });
});

/* ------------------------------------------------------------------------- */
describe('Toast', () => {
  it('is a status region coloured by severity with title and message', () => {
    const html = render(h(Toast, { severity: 'error', title: 'Command refused', message: 'standoff below floor' }));
    expect(html).toMatch(/^<div role="status" class="eis-toast" data-severity="error">/);
    expect(html).toContain('<div class="eis-toast-title">Command refused</div>');
    expect(html).toContain('<div class="eis-toast-msg">standoff below floor</div>');
    expect(html).not.toContain('aria-label="Dismiss"');
  });

  it('info by default, dismiss button only when a handler is given, icon chip when given', () => {
    const html = render(h(Toast, { title: 't', onDismiss: () => undefined, icon: h('i', { className: 'ico' }) }));
    expect(html).toContain('data-severity="info"');
    expect(html).toContain('aria-label="Dismiss"');
    expect(html).toContain('class="eis-x"');
    expect(html).toContain('<span class="eis-toast-icon"><i class="ico"></i></span>');
    expect(html).not.toContain('eis-toast-msg');
  });
});

/* ------------------------------------------------------------------------- */
describe('Modal', () => {
  it('renders nothing while closed', () => {
    expect(render(h(Modal, { open: false, title: 'x' }, 'body'))).toBe('');
  });

  it('open: scrim > labelled dialog with tone, width, heading, subtitle, body, footer', () => {
    const html = render(h(Modal, {
      title: 'Confirm takeoff',
      subtitle: 'GUIDED climb',
      tone: 'caution',
      width: 400,
      icon: h('i', { className: 'ico' }),
      onClose: () => undefined,
      footer: h('b', null, 'foot'),
    }, h('p', null, 'body')));
    expect(html).toMatch(/^<div class="eis-scrim"><div role="dialog" aria-modal="true" aria-labelledby="([^"]+)" class="eis-dialog" data-tone="caution" style="--dialog-w:400px">/);
    const id = /aria-labelledby="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`<h2 id="${id}">Confirm takeoff</h2>`);
    expect(html).toContain('<p>GUIDED climb</p>');
    expect(html).toContain('<span class="eis-dialog-icon"><i class="ico"></i></span>');
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('<div class="eis-dialog-body"><p>body</p></div>');
    expect(html).toContain('<footer><b>foot</b></footer>');
  });

  it('defaults: open, 460 px, default tone, no close button without onClose, no footer', () => {
    const html = render(h(Modal, { title: 'Settings' }, 'b'));
    expect(html).toContain('data-tone="default"');
    expect(html).toContain('--dialog-w:460px');
    expect(html).not.toContain('aria-label="Close"');
    expect(html).not.toContain('<footer');
    expect(html).not.toContain('<p>');
  });
});

/* ------------------------------------------------------------------------- */
describe('Slider', () => {
  it('positions the fill through --slider-pct and colours it through --slider-accent', () => {
    const html = render(h(Slider, { label: 'Max speed', value: 4, min: 0, max: 8, step: 0.5, unit: 'm/s', accent: 'var(--green)', ticks: ['0.5', '8'] }));
    expect(html).toContain('--slider-pct:50%');
    expect(html).toContain('--slider-accent:var(--green)');
    expect(html).toContain('<span class="eis-readout">4</span>');
    expect(html).toContain('<span class="eis-slider-unit">m/s</span>');
    expect(html).toContain('<div class="eis-slider-ticks"><span>0.5</span><span>8</span></div>');
    expect(html).toContain('type="range"');
    expect(html).toContain('min="0"');
    expect(html).toContain('max="8"');
    expect(html).toContain('step="0.5"');
    expect(html).toContain('value="4"');
  });

  it('wires the label to the native input by id', () => {
    const html = render(h(Slider, { label: 'Standoff', value: 5 }));
    const forId = /<label for="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`id="${forId}"`);
  });

  it('disabled flags the root and the input; no label → no <label>', () => {
    const html = render(h(Slider, { value: 1, disabled: true }));
    expect(html).toContain('data-disabled="true"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('<label');
    expect(html).not.toContain('eis-slider-ticks');
  });

  it('sliderPercent clamps and never yields NaN', () => {
    expect(sliderPercent(5, 0, 10)).toBe(50);
    expect(sliderPercent(-3, 0, 10)).toBe(0);
    expect(sliderPercent(14, 0, 10)).toBe(100);
    expect(sliderPercent(2, 2, 2)).toBe(0);
    expect(sliderPercent(Number.NaN, 0, 10)).toBe(0);
    expect(sliderPercent(-30, -30, 90)).toBe(0);
    expect(sliderPercent(0, -30, 90)).toBe(25);
  });
});

/* ------------------------------------------------------------------------- */
describe('GaugeReadout', () => {
  it('label, tabular value and unit with status/size/align attributes', () => {
    const html = render(h(GaugeReadout, { label: 'Rel Alt', value: '12.5', unit: 'm', status: 'caution', size: 'lg', align: 'right' }));
    expect(html).toMatch(/^<div class="eis-gauge" data-status="caution" data-size="lg" data-align="right">/);
    expect(html).toContain('<span class="eis-label">Rel Alt</span>');
    expect(html).toContain('<span class="eis-readout">12.5</span>');
    expect(html).toContain('<span class="eis-gauge-unit">m</span>');
    expect(html).not.toContain('eis-gauge-trend');
  });

  it('trend carets', () => {
    expect(render(h(GaugeReadout, { label: 'V/S', value: '1.2', trend: 'up' }))).toContain('aria-label="rising">▲</span>');
    expect(render(h(GaugeReadout, { label: 'V/S', value: '1.2', trend: 'down' }))).toContain('aria-label="falling">▼</span>');
    expect(trendGlyph(null)).toBe('');
    expect(trendGlyph(undefined)).toBe('');
  });

  it('empty unit renders no unit span', () => {
    expect(render(h(GaugeReadout, { label: 'To Target', value: '—', unit: '' }))).not.toContain('eis-gauge-unit');
  });
});

/* ------------------------------------------------------------------------- */
describe('HoldButton (initial markup)', () => {
  it('idle: primary block button, zero fill, hint visible', () => {
    const html = render(h(HoldButton, { icon: h('i', { className: 'ico' }) }, 'Engage Tracking'));
    expect(html).toMatch(/^<button type="button" class="eis-hold" data-variant="primary" data-block="true" style="--hold-pct:0%">/);
    expect(html).not.toContain('data-holding');
    expect(html).not.toContain('disabled');
    expect(html).toContain('<span class="eis-hold-fill" aria-hidden="true"></span>');
    expect(html).toContain('class="ico"');
    expect(html).toContain('<span>Engage Tracking</span>');
    expect(html).toContain('<span class="eis-hold-hint">Hold to confirm</span>');
  });

  it('variant, custom hint, disabled, inline block=false and caller style', () => {
    const html = render(h(HoldButton, { variant: 'caution', hint: 'Take off first', disabled: true, block: false, style: { flex: 1 } }, 'Takeoff'));
    expect(html).toContain('data-variant="caution"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('data-block');
    expect(html).toContain('style="flex:1;--hold-pct:0%"');
    expect(html).toContain('Take off first');
  });
});

/* ------------------------------------------------------------------------- */
describe('barrel', () => {
  it('re-exports every primitive the panels import', () => {
    const html = render(h(Fragment, null,
      h(Badge, null, 'b'), h(Button, null, 'b'), h(GaugeReadout, { label: 'l', value: 1 }), h(HoldButton, null, 'h'),
      h(IconButton, { icon: h('i') }), h(Modal, { title: 'm' }, 'x'), h(Panel, null, 'p'), h(Slider, { value: 1 }),
      h(StatusPill, null, 's'), h(Tabs, { value: 't' }), h(Toast, { title: 't' }), h(Toggle, null),
    ));
    for (const cls of ['eis-badge', 'eis-btn', 'eis-gauge', 'eis-hold', 'eis-iconbtn', 'eis-dialog', 'eis-panel', 'eis-slider', 'eis-pill', 'eis-tabs', 'eis-toast', 'eis-switch']) {
      expect(html).toContain(`class="${cls}"`);
    }
  });
});
