/* ============================================================================
 * Renderer test setup.
 *
 * RUNNING THESE: `npm test` in ground/ui, which runs
 * `node ../planner/node_modules/vitest/vitest.mjs run`.
 *
 * Vitest is borrowed from `ground/planner` rather than added to this package's
 * dependencies on purpose. `ground/ui`'s CI job runs `npm ci`, which fails on a
 * `package.json` its `package-lock.json` does not match, and regenerating the
 * lock needs the registry — which the offline-first bootstrap must not. The
 * planner is installed by `scripts/setup-ground.*` before anything runs here,
 * so the binary is always present by the time this matters; if it is not, node
 * says exactly which path is missing.
 *
 * The suites here exercise the RENDERER's own logic — the mission store, the
 * data providers, the App helpers — in a Node process. Those modules reach for
 * two browser globals and nothing else:
 *
 *   window.eis  — the Electron bridge, absent in the browser dev server too,
 *                 so every call site already guards it with `?.`
 *   fetch       — the site provider's dev-server route, which falls back to
 *                 the bundled site stub when it fails
 *
 * A bare `window` object is enough for both. No DOM is stubbed: a test that
 * needs one is testing a component, and components are not covered here.
 * ========================================================================== */
const globals = globalThis as Record<string, unknown>;

if (globals.window === undefined) {
  globals.window = { location: { search: '', pathname: '/', origin: 'http://localhost' } };
}
