/* ============================================================================
 * Literal token values for <canvas> / SVG drawing, where CSS custom properties
 * (var(--…)) can't be used directly (e.g. ctx.fillStyle). These mirror the CSS
 * variables in index.css — keep them in sync. Everywhere else, prefer the CSS
 * variables (var(--…)) or Tailwind utilities.
 * ========================================================================== */

export const C = {
  gray0: '#06070a', gray1: '#0b0d11', gray2: '#111419', gray3: '#171b22',
  gray4: '#1e232b', gray5: '#272d37', gray6: '#333a45', gray7: '#475160',
  gray8: '#6b7686', gray9: '#98a3b3', gray10: '#c4ccd6', gray11: '#e6eaf0',
  gray12: '#f6f8fb',

  blueBright: '#5aa0ff', blue: '#2f81f7', blueDeep: '#1f6fe0',
  greenBright: '#4ee08a', green: '#25c46d', greenDeep: '#16a058',
  amberBright: '#ffc24b', amber: '#f5a623', amberDeep: '#d4860a',
  redBright: '#ff6b66', red: '#f04438', redDeep: '#d92d20',
} as const;

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
  droneFill: '#ffc24b', droneStroke: '#0b0d11',
  home: '#e6eaf0', target: '#f04438',
} as const;
