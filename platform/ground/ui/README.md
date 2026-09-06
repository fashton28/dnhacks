# Drone Safety Platform — Ground Control Center (UI)

The operator-facing Ground Control Center for the **Drone Safety Platform** autonomous
tracking drone. A React 18 + TypeScript + Vite single-page app that connects to
the companion computer (or SITL), streams live telemetry / video / tracking, and
drives the vehicle through guarded safety flows.

The UI is implemented against the real stack and the live data seam; the HTML/JSX
prototype it was originally modelled on is no longer in the repository (see
`docs/DISCREPANCY_REWRITE.md` at the repo root).

---

## Run

```bash
npm install
npm run dev        # Vite dev server (browser) — uses the mock data source by default
npm run build      # type-check + production bundle
npm run preview    # serve the production build locally
npm run typecheck  # tsc --noEmit
npm run lint       # eslint
npm test           # renderer logic tests (test/*.test.ts)
```

Open the printed `http://localhost:5173`. With the default (mock) data source the
app boots fully populated — synthetic telemetry, a moving target, a mock video
scene, and a live map — with **no backend required**.

The port is **strict**: if 5173 is taken, Vite refuses to start rather than
sliding to 5174 and leaving the Electron shell rendering whatever else answered
(FM-131). Set `EIS_UI_PORT` to move both the dev server and the shell together.

`npm test` borrows Vitest from `ground/planner` (`node
../planner/node_modules/vitest/vitest.mjs run`) rather than adding it to this
package: the CI job here runs `npm ci`, which fails on a `package.json` its lock
does not match, and regenerating the lock needs the registry. `scripts/setup-
ground.*` installs the planner before anything here runs. The suites cover the
mission store, the Hub fleet mapper, the wind context and the whole offline
mission scenario end to end; see `test/setup.ts`.

---

## Architecture

```
src/
  App.tsx              # App shell: state, subscriptions, safety flows, layout
  main.tsx             # React root; imports fonts + leaflet css + index.css
  index.css            # Design tokens (CSS custom properties) + base styles
  contract/            # AUTHORITATIVE UI <-> backend types (the seam's shape)
  store/
    settings.ts        # SettingsStore singleton + useSettings() hook
    DataSourceContext  # <DataSourceProvider> + useDataSource()
  dataSource/
    index.ts           # selects Mock vs Live  <-- the one-line swap
    MockDataProvider.ts # synthetic telemetry/tracking/video (browser-only)
    LiveDataProvider.ts # real WebSocket + video seam to the companion
  theme/tokens.ts      # JS token literals for canvas drawing (C, VIDEO, MAP)
  components/          # design-system primitives (Button, Modal, Toast, ...)
  instruments/         # gauges & indicators (attitude, compass, battery, ...)
  panels/              # StatusBar, ControlsPanel, ManualControl, Telemetry,
                       # Video, Map, LogConsole
  views/               # modals & banners (Checklist, Takeoff, Settings,
                       # Failsafe, Pid, LogBrowser, Tracking/Manual banners)
```

### Component layout (App.tsx)

```
┌───────────────────────────── StatusBar ─────────────────────────────┐
├──────────────── TrackingBanner / ManualBanner (conditional) ─────────┤
│ LEFT (264px)      │ CENTER (1fr)                  │ RIGHT (300px)     │
│ ControlsPanel     │ ┌───────── VideoPanel ──────┐ │ TelemetryPanel    │
│ ManualControl     │ │                           │ │                   │
│                   │ └───────────────────────────┘ │                   │
│                   │ ┌── MapPanel ──┬─ LogConsole ┐ │                   │
│                   │ └──────────────┴─────────────┘ │                   │
└───────────────────┴───────────────────────────────┴───────────────────┘
                                              toast stack (fixed, top-right)
```

`App.tsx` owns all shell state and behavior, faithfully ported from
`GroundControl.jsx`:

- **Subscriptions** — on mount it calls `dataSource.connect(connectionConfig)`
  and subscribes to `onTelemetry` / `onTracking` / `onStatusText` / `onAck` /
  `onConnectionChange`; on unmount it unsubscribes and `disconnect()`s. It
  reconnects automatically when the connection config changes in Settings.
- **Sampling** — a 1 Hz timer pushes `relAlt`/`battery` into rolling
  `history` (60 samples), appends to the map `trail` while airborne
  (`relAlt > 0.4`), and increments the flight timer while armed.
- **`cmd()` helper** — `(command, params) => dataSource.sendCommand({ type:
  'command', command, params })`. High-rate stick input bypasses this and goes
  through `dataSource.setManualInput(...)` (fire-and-forget, no ack).
- **Safety flows** — checklist → arm gating, takeoff confirm (altitude slider +
  hold), tracking engage confirm (standoff + max speed), and instant
  disarm/disengage. Disarm issues `emergencyStop`.
- **Toasts** — transient notifications for criticals, command-ack failures, and
  flow confirmations (auto-dismiss after 4.2 s).
- **Modals** — a single modal manager covers
  `checklist | takeoff | settings | failsafe | pid | logbrowser`, opened from
  the StatusBar gear/shield/sliders/logs actions and the LogConsole browser
  button.

---

## The DataSource seam (Mock ↔ Live)

The entire app consumes data **only** through a `DataSource` obtained from
`useDataSource()`. The concrete provider is chosen in exactly one place:

`src/dataSource/index.ts`

```ts
import { MockDataProvider } from './MockDataProvider';
// import { LiveDataProvider } from './LiveDataProvider';
export const dataSource: DataSource = new MockDataProvider();
// To go live, swap the line above for: new LiveDataProvider()
```

**The exact one-line swap to go live:**

```ts
export const dataSource: DataSource = new LiveDataProvider();
```

(and uncomment the `LiveDataProvider` import). No component, panel, or view
changes — they all speak the `DataSource` interface in `src/contract`.
`App.tsx` wraps the tree in `<DataSourceProvider source={dataSource}>`, so the
swap propagates everywhere through context.

`MockDataProvider.getVideoUrl()` returns `''`, and `VideoPanel` renders the mock
canvas scene; `LiveDataProvider.getVideoUrl()` returns the configured
RTSP/WebRTC/HTTP URL.

---

## Settings & failsafe

`SettingsStore` (`src/store/settings.ts`) is a singleton observable store for all
persistent settings — connection config, failsafe limits, PID gains, units, map
tiles. Components read it with `useSettings()` (re-renders on change) and write
with `settingsStore.set(...)`.

- **Connection** — `App.tsx` reads `settings.connection` for `connect()`; editing
  it in the Settings modal triggers a reconnect.
- **Geofence / units / map tiles** — `MapPanel` receives
  `geofenceRadius={settings.failsafe.geofenceRadius}`; units & tiles come from
  the same store.
- **PID gains** — the PID modal persists gains via `SettingsStore`. When
  connected, those gains are documented to map onto the companion config keys
  `guidance.gains.{yaw,altitude,forward}.{kp,ki,kd}`.

---

## Recording

`LogConsole`'s record toggle starts/stops flight recording. When running inside
the Electron shell (`window.eis?.recorder` present) frames are written to disk
via the secure bridge; otherwise an in-memory recorder is used. While recording,
every telemetry / tracking / statusText frame is appended. The recorded sessions
are browsable via the Log Browser modal.

---

## Design tokens

The look is driven entirely by design tokens — there are **no scattered hex
values**.

- **CSS custom properties** in `src/index.css` are the single source of truth
  (e.g. `--surface-panel`, `--accent`, `--leftpanel-w`, `--font-mono`).
  Components reference them in inline styles, exactly as the prototype did:
  `style={{ background: 'var(--surface-panel)' }}`.
- **Tailwind theme** (`tailwind.config.ts`) **mirrors** the same tokens, so
  utility classes (`bg-surface-panel`, `text-text-tertiary`, `font-mono`)
  resolve to the identical CSS variables — never a duplicated color.
- **JS token literals** in `src/theme/tokens.ts` (`C`, `VIDEO`, `MAP`) expose
  the same palette as plain strings for `<canvas>` drawing (video crosshair,
  instrument needles, map markers) where CSS variables can't reach.

Only `theme: 'dark'` is supported.

### Self-hosted fonts

Fonts are **self-hosted** (no network fetch) via `@fontsource-variable/*`,
imported in `main.tsx` so the Electron build works fully offline:

- **Geist Variable** — UI sans (`--font-sans`)
- **JetBrains Mono Variable** — telemetry/numeric mono (`--font-mono`)

---

## Keyboard shortcuts

| Key       | Action                                                        |
| --------- | ------------------------------------------------------------- |
| `Space`   | **Disarm** (emergency stop) — always available                |
| `T`       | **Engage tracking** — when idle and airborne (`relAlt > 0.5`)  |
| `D`       | **Disengage tracking** — when tracking is active              |
| `R`       | **Return to launch (RTL)** — when airborne (`relAlt > 0.5`)    |

Shortcuts are ignored while typing in an `<input>`.
