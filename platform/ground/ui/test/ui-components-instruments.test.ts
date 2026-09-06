/* ============================================================================
 * Instruments: the pure classification / geometry helpers each dial is built
 * on, and the markup contract of the dials themselves (react-dom/server).
 * ========================================================================== */
import { createElement as h, Fragment } from 'react';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AttitudeIndicator, BatteryGauge, Compass, SignalGauge,
  BATTERY_CAUTION_PCT, BATTERY_CRITICAL_PCT, RSSI_CEILING_DBM, RSSI_FLOOR_DBM,
  batteryFillPercent, batteryStatus, compassTicks, formatHeading, ladderPath, normalizeHeading,
  pitchLadder, pitchScale, polar, radialTicks, signalLevel, signalReadout, signedDegrees,
} from '@/instruments';

const render = (el: ReactElement): string => renderToStaticMarkup(el);
const count = (html: string, needle: string): number => html.split(needle).length - 1;

/* ------------------------------------------------------------------------- */
describe('battery classification', () => {
  it('pins the thresholds the status bar and telemetry panel assume', () => {
    expect(BATTERY_CAUTION_PCT).toBe(30);
    expect(BATTERY_CRITICAL_PCT).toBe(15);
  });

  it.each([
    [100, 'nominal'], [31, 'nominal'], [30.1, 'nominal'],
    [30, 'caution'], [16, 'caution'], [15.5, 'caution'],
    [15, 'critical'], [1, 'critical'], [0, 'critical'], [-5, 'critical'],
  ])('%s % → %s', (pct, status) => {
    expect(batteryStatus(pct)).toBe(status);
  });

  it('fill keeps a 2 % sliver and never overflows the cell', () => {
    expect(batteryFillPercent(0)).toBe(2);
    expect(batteryFillPercent(1.5)).toBe(2);
    expect(batteryFillPercent(50)).toBe(50);
    expect(batteryFillPercent(130)).toBe(100);
    expect(batteryFillPercent(Number.NaN)).toBe(2);
  });
});

describe('BatteryGauge markup', () => {
  it('critical: status attribute, level custom property, rounded readout, meter semantics', () => {
    const html = render(h(BatteryGauge, { remaining: 9.6 }));
    expect(html).toMatch(/^<div class="eis-batt" data-status="critical" style="--batt-pct:9.6%">/);
    expect(html).toContain('<span class="eis-readout">10</span>');
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="10"');
    expect(html).not.toContain('eis-batt-meta');
  });

  it('voltage, cell count and current appear under the bar when not compact', () => {
    const html = render(h(BatteryGauge, { remaining: 80, voltage: 15.83, cells: 4, current: 12.04 }));
    expect(html).toContain('data-status="nominal"');
    expect(html).toContain('15.8<i> V</i><i> · 4S</i>');
    expect(html).toContain('12.0<i> A</i>');
  });

  it('compact drops the meta line and flags the root', () => {
    const html = render(h(BatteryGauge, { remaining: 25, voltage: 15.8, compact: true }));
    expect(html).toContain('data-compact="true"');
    expect(html).toContain('data-status="caution"');
    expect(html).not.toContain('eis-batt-meta');
  });

  it('voltage alone, without cells, has no cell suffix', () => {
    const html = render(h(BatteryGauge, { remaining: 50, voltage: 12 }));
    expect(html).toContain('12.0<i> V</i>');
    expect(html).not.toContain('S</i>');
    expect(html).not.toContain(' A</i>');
  });
});

/* ------------------------------------------------------------------------- */
describe('signal classification', () => {
  it('maps the RSSI window the gauge is calibrated for', () => {
    expect(RSSI_FLOOR_DBM).toBe(-100);
    expect(RSSI_CEILING_DBM).toBe(-40);
  });

  it.each([
    [-40, 1, 4, 'nominal'],
    [-30, 1, 4, 'nominal'],
    [-60, 2 / 3, 3, 'nominal'],
    [-67, 0.55, 3, 'nominal'],
    [-70, 0.5, 2, 'caution'],
    [-82, 0.3, 2, 'caution'],
    [-85, 0.25, 1, 'danger'],
    [-100, 0, 1, 'danger'],
    [-130, 0, 1, 'danger'],
  ])('%s dBm → strength %s, %s bars, %s', (rssi, strength, bars, status) => {
    const level = signalLevel(rssi);
    expect(level.strength).toBeCloseTo(strength, 6);
    expect(level.bars).toBe(bars);
    expect(level.status).toBe(status);
  });

  it('a lost link shows no bars and is danger regardless of the last RSSI', () => {
    expect(signalLevel(-40, true)).toEqual({ strength: 1, bars: 0, status: 'danger' });
  });

  it('a non-finite RSSI is treated as no signal rather than NaN bars', () => {
    expect(signalLevel(Number.NaN)).toEqual({ strength: 0, bars: 1, status: 'danger' });
  });

  it('formats the readout with optional latency', () => {
    expect(signalReadout(-62.4, 41)).toBe('-62 dBm · 41ms');
    expect(signalReadout(-62, null)).toBe('-62 dBm');
    expect(signalReadout(-62, undefined)).toBe('-62 dBm');
    expect(signalReadout(-62, 0)).toBe('-62 dBm · 0ms');
  });
});

describe('SignalGauge markup', () => {
  it('lights the classified number of bars and prints the readout', () => {
    const html = render(h(SignalGauge, { rssi: -60, latencyMs: 41 }));
    expect(html).toMatch(/^<div class="eis-sig" data-status="nominal" role="img" aria-label="Link: -60 dBm · 41ms">/);
    expect(count(html, 'class="eis-sig-bar"')).toBe(4);
    expect(count(html, 'data-on="true"')).toBe(3);
    expect(html).toContain('<span class="eis-label">Link</span>');
    expect(html).toContain('<span class="eis-sig-read">-60 dBm · 41ms</span>');
  });

  it('lost: no lit bars, LOST in place of a reading, danger colour', () => {
    const html = render(h(SignalGauge, { rssi: -50, lost: true, label: 'Telemetry' }));
    expect(html).toContain('data-status="danger"');
    expect(html).toContain('data-lost="true"');
    expect(html).not.toContain('data-on');
    expect(html).toContain('<span class="eis-sig-lost">LOST</span>');
    expect(html).toContain('aria-label="Telemetry: LOST"');
  });

  it('compact keeps only the bars', () => {
    const html = render(h(SignalGauge, { compact: true }));
    expect(html).not.toContain('eis-sig-text');
    expect(count(html, 'class="eis-sig-bar"')).toBe(4);
  });
});

/* ------------------------------------------------------------------------- */
describe('heading helpers', () => {
  it.each([[0, 0], [359, 359], [360, 0], [372, 12], [-10, 350], [-720, 0], [725.5, 5.5]])(
    'normalizeHeading(%s) = %s', (deg, expected) => { expect(normalizeHeading(deg)).toBeCloseTo(expected, 9); },
  );

  it.each([[0, '000'], [7.4, '007'], [7.5, '008'], [90, '090'], [270, '270'], [359.6, '000'], [-10, '350'], [372, '012']])(
    'formatHeading(%s) = %s', (deg, expected) => { expect(formatHeading(deg)).toBe(expected); },
  );

  it('has a placeholder for a missing heading', () => {
    expect(formatHeading(Number.NaN)).toBe('---');
    expect(formatHeading(Number.POSITIVE_INFINITY)).toBe('---');
  });

  it('builds a 5° ring with 30° majors', () => {
    const { major, minor } = compassTicks();
    expect(major).toHaveLength(12);
    expect(minor).toHaveLength(60);
    expect(major).toEqual([0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]);
    expect(minor).not.toContain(0);
    expect(minor).toContain(5);
  });
});

describe('Compass markup', () => {
  it('rotates the card against the heading and prints the padded readout', () => {
    const html = render(h(Compass, { heading: 270, size: 120 }));
    expect(html).toContain('class="eis-needle" transform="rotate(-270)"');
    expect(html).toContain('>270</text>');
    expect(html).toContain('>HDG</text>');
    expect(html).toContain('<span class="eis-label">HEADING</span>');
    expect(html).toContain('aria-label="Heading 270"');
    for (const glyph of ['N', 'E', 'S', 'W']) expect(html).toContain(`>${glyph}</text>`);
    expect(html).not.toContain('var(--accent)');
  });

  it('label=false drops the caption; a target adds the bearing marker', () => {
    const html = render(h(Compass, { heading: 0, target: 45, label: false }));
    expect(html).not.toContain('HEADING');
    expect(html).toContain('fill="var(--accent)"');
    expect(html).toContain('rotate(45)');
  });
});

/* ------------------------------------------------------------------------- */
describe('attitude helpers', () => {
  it.each([[12.4, '+12°'], [-3.6, '-4°'], [0, '+0°'], [-0.2, '+0°'], [45, '+45°'], [-180, '-180°']])(
    'signedDegrees(%s) = %s', (v, expected) => { expect(signedDegrees(v)).toBe(expected); },
  );

  it('scales pitch so 70° spans the dial', () => {
    expect(pitchScale(140)).toBe(2);
    expect(pitchScale(200)).toBeCloseTo(200 / 70);
  });

  it('ladder rungs at ±10/±20/±30, wide on 20s, no rung on the horizon, nose-up rungs above centre', () => {
    const marks = pitchLadder(2);
    expect(marks.map((m) => m.deg)).toEqual([-30, -20, -10, 10, 20, 30]);
    expect(marks.find((m) => m.deg === 20)).toEqual({ deg: 20, y: -40, width: 34 });
    expect(marks.find((m) => m.deg === -10)).toEqual({ deg: -10, y: 20, width: 20 });
    expect(ladderPath(marks.slice(0, 2))).toBe('M-10 60H10M-17 40H17');
  });

  it('polar puts 0° at twelve o’clock and turns clockwise', () => {
    expect(polar(0, 10).x).toBeCloseTo(0);
    expect(polar(0, 10).y).toBeCloseTo(-10);
    expect(polar(90, 10).x).toBeCloseTo(10);
    expect(polar(90, 10).y).toBeCloseTo(0);
    expect(polar(180, 10).y).toBeCloseTo(10);
  });

  it('radialTicks draws inward from the outer radius', () => {
    expect(radialTicks([0], 10, 4)).toBe('M0.00 -10.00L0.00 -6.00');
    expect(radialTicks([90, 180], 10, 2)).toBe('M10.00 0.00L8.00 0.00M0.00 10.00L0.00 8.00');
    expect(radialTicks([], 10, 2)).toBe('');
  });
});

describe('AttitudeIndicator markup', () => {
  it('rolls and slides the horizon group, rolls the arc, captions roll and pitch', () => {
    const html = render(h(AttitudeIndicator, { roll: 15, pitch: -7, size: 140 }));
    expect(html).toContain('transform="rotate(-15) translate(0 -14)"');
    expect(count(html, 'class="eis-needle" transform="rotate(-15)"')).toBe(1);
    expect(html).toContain('<span class="eis-label">ROLL</span><span class="eis-readout">+15°</span>');
    expect(html).toContain('<span class="eis-label">PITCH</span><span class="eis-readout">-7°</span>');
    expect(html).toContain('aria-label="Attitude roll +15° pitch -7°"');
  });

  it('label=false leaves only the dial', () => {
    expect(render(h(AttitudeIndicator, { label: false }))).not.toContain('eis-instrument-caption');
  });

  it('two dials in one tree never share a clip path or gradient id', () => {
    const html = render(h(Fragment, null, h(AttitudeIndicator, null), h(AttitudeIndicator, null)));
    const clips = [...html.matchAll(/<clipPath id="([^"]+)"/g)].map((m) => m[1]);
    expect(clips).toHaveLength(2);
    expect(clips[0]).not.toBe(clips[1]);
    for (const id of clips) expect(html).toContain(`clip-path="url(#${id})"`);
    const gradients = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(gradients).size).toBe(4);
  });
});
