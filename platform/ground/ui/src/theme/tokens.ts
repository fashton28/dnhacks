/* ============================================================================
 * Literal token values for <canvas> / SVG drawing, where CSS custom properties
 * (var(--…)) cannot be used (e.g. ctx.fillStyle).
 *
 * The palette is declared ONCE here as a neutral ramp plus four hue families,
 * and `C` is assembled from those. `cssVariableFor(key)` names the custom
 * property in index.css that carries the same value; the ui-components token
 * test reads the stylesheet and checks every entry of `C` against it, so the
 * two can no longer drift apart silently. Everywhere else, prefer the CSS
 * variables or Tailwind utilities.
 * ========================================================================== */

/** Cool-charcoal neutral ramp, index 0 = deepest. Mirrors --gray-0 … --gray-12. */
export const GRAY_RAMP = [
  '#06070a', '#0b0d11', '#111419', '#171b22', '#1e232b', '#272d37', '#333a45',
  '#475160', '#6b7686', '#98a3b3', '#c4ccd6', '#e6eaf0', '#f6f8fb',
] as const;

export interface HueFamily {
  readonly bright: string;
  readonly base: string;
  readonly deep: string;
}

/** The four saturated families the UI is allowed to use. Mirrors --<hue>-bright / --<hue> / --<hue>-deep. */
export const HUE = {
  blue:  { bright: '#5aa0ff', base: '#2f81f7', deep: '#1f6fe0' },
  green: { bright: '#4ee08a', base: '#25c46d', deep: '#16a058' },
  amber: { bright: '#ffc24b', base: '#f5a623', deep: '#d4860a' },
  red:   { bright: '#ff6b66', base: '#f04438', deep: '#d92d20' },
} as const satisfies Record<string, HueFamily>;

export const C = {
  gray0: GRAY_RAMP[0], gray1: GRAY_RAMP[1], gray2: GRAY_RAMP[2], gray3: GRAY_RAMP[3],
  gray4: GRAY_RAMP[4], gray5: GRAY_RAMP[5], gray6: GRAY_RAMP[6], gray7: GRAY_RAMP[7],
  gray8: GRAY_RAMP[8], gray9: GRAY_RAMP[9], gray10: GRAY_RAMP[10], gray11: GRAY_RAMP[11],
  gray12: GRAY_RAMP[12],

  blueBright: HUE.blue.bright,   blue: HUE.blue.base,   blueDeep: HUE.blue.deep,
  greenBright: HUE.green.bright, green: HUE.green.base, greenDeep: HUE.green.deep,
  amberBright: HUE.amber.bright, amber: HUE.amber.base, amberDeep: HUE.amber.deep,
  redBright: HUE.red.bright,     red: HUE.red.base,     redDeep: HUE.red.deep,
} as const;

export type TokenKey = keyof typeof C;

/**
 * The index.css custom property that carries the same value as `C[key]`:
 * gray7 → --gray-7, blueBright → --blue-bright, amber → --amber.
 */
export function cssVariableFor(key: TokenKey): string {
  const kebab = key.replace(/([a-z])(\d)/, '$1-$2').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  return `--${kebab}`;
}

/** Colours used by the synthetic forward-view video scene (mock). */
export const VIDEO = {
  skyTop: '#0e1c28', skyBottom: '#26323a',
  groundTop: '#2a3a30', groundBottom: '#161f1a',
  letterbox: '#0a1016',
  bodyLocked: '#3a4654', body: '#34404c', head: '#414f5e',
} as const;

/** Colours used by the offline map fallback (procedural satellite look). */
export const MAP = {
  base: '#1c2a1e',
  fieldTones: ['#243425', '#2c3a26', '#33402a', '#3b3a28', '#2a3530'],
  river: '#1c3344',
  droneFill: HUE.amber.bright, droneStroke: GRAY_RAMP[1],
  home: GRAY_RAMP[11], target: HUE.red.base,
} as const;
