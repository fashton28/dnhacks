# Drone Safety Platform — Design System

A dark, high-density **mission-control design system** for *Drone Safety Platform*, the
desktop ground-control center (GCS) for an autonomous person-following drone. It
gives design agents the tokens, components, instruments, and full-screen UI kit
needed to build new GCS surfaces, marketing, and decks on-brand.

> **What this product is.** A Windows desktop control center for a quadcopter
> (ArduPilot + NVIDIA Jetson companion vision) that detects a person and flies
> toward them, **holding at a safe standoff distance** — a follow-me system that
> maintains distance and never contacts the person. The operator arms, takes off,
> engages tracking, and monitors live video + telemetry, with instant stop always
> one tap away.

## Sources
- **`uploads/claude-design-prd.md`** — the authoritative product brief (the
  "Ground Control Center UI" PRD). Sections 4–8 define the data contract, screens,
  component states, and the safety UX rules this system encodes.
- No codebase, Figma, or brand assets were provided. The visual language here is
  **designed from the PRD's Section 5 direction** ("dark, glanceable, professional
  GCS — cleaner and more modern than QGroundControl / Mission Planner"), with
  choices confirmed by the user (see *Visual foundations*).

---

## Content fundamentals

The product's voice is that of an **instrument, not a marketer**. Copy is terse,
literal, and operational — written for a pilot scanning at a glance under load.

- **Tone:** factual, calm, imperative. Labels are nouns or verbs, never sentences.
  Buttons say what they do: `Arm`, `Takeoff`, `Engage Tracking`, `Disarm`.
- **Casing:** `UPPERCASE` micro-labels for every field/panel header (`REL ALT`,
  `STANDOFF`, `GPS · 3D`) at 10–11px with `0.06em` tracking. Sentence case for
  body and helper text. Mode names stay in their protocol form (`GUIDED`, `RTL`).
- **Person:** addresses the operator implicitly — no "you", no "we". Status reads
  as machine state: "Target lock acquired", "Battery 30% — consider RTL",
  "EMERGENCY STOP — motors disarmed".
- **Numbers carry the message.** Values are always mono + tabular with explicit
  units (`6.4 m`, `3.2 m/s`, `14.2 V`, `−1.2 m/s`). Precision is fixed per field
  so digits never reflow.
- **Severity language:** `INFO` (neutral), `WARN` (caution), `ERR`/`CRIT`
  (danger). Critical events are phrased as alarms, not notes.
- **No emoji, ever.** Status is communicated by colour + dot + label, never glyphs.
- **Examples:**
  - Log line — `14:02:51  WARN  Tracking lock lost — re-acquiring`
  - Confirm — *"The vehicle will arm-climb to the set altitude in GUIDED mode."*
  - Banner — *"Autonomous tracking active · standoff 4.0 m · max 3.0 m/s"*

---

## Visual foundations

**Overall vibe:** a near-black charcoal cockpit. Surfaces read by subtle elevation
and 1px hairline borders, not heavy shadow. Colour is *rationed* — most of the UI
is neutral grey, and saturated colour means something every time it appears.

- **Colour.** Cool charcoal neutral ramp (`--gray-0 #06070a` → `--gray-12 #f6f8fb`).
  Single **blue accent** (`#2f81f7`) for active/focus/primary actions. Status
  semantics are reserved and consistent everywhere: **green** `#25c46d` = nominal/
  safe, **amber** `#f5a623` = caution, **red** `#f04438` = danger/critical, **grey**
  = inactive. Red is used *only* for genuine danger (disarm/kill, critical battery,
  link loss, active-tracking warning). Each status has a tint (`rgba …0.14`) for
  fills and a line colour for borders.
- **Type.** **Geist** for all UI/labels (neo-grotesque, neutral). **JetBrains Mono**
  for *every* live number — tabular figures (`tnum`,`zero`) so readouts don't jitter
  as digits change. Display sizes use tight tracking (`-0.01em`); micro-labels use
  loose uppercase tracking (`0.06em`).
- **Spacing.** 4px base grid; dense control-surface rhythm. Fixed shell dims:
  46px status bar, 264px left panel, 300px right panel.
- **Backgrounds.** Flat charcoal fills. Optional faint 48–64px **grid texture**
  on hero/section/title surfaces (≤3% white lines), often masked to a corner.
  No gradients in the UI chrome except radial accent *glows* behind the logo on
  marketing/title surfaces, and the procedural sky/ground in the video scene.
- **Imagery.** The live video is a synthetic, cool-toned forward-view scene
  (desaturated greens/teals, dark). The map is a Google-Earth-style satellite look
  (muted terrain). Both are deliberately low-chroma so overlays (amber lock, red
  target, blue geofence) pop.
- **Borders & cards.** Cards = panel surface + a single hairline border
  (`rgba(255,255,255,0.10)`) + 10px radius (`--radius-lg`); header strip separated
  by a `0.06`-white hairline. No coloured left-border accent cards.
- **Radii.** Tight and instrument-like: 3 / 5 / 7 / 10 / 14px. Pills (`999px`)
  are reserved for status chips only.
- **Shadows.** Elevation is for *floating* surfaces only — popovers and modals
  (`--shadow-popover`, `--shadow-modal`). Panels themselves cast none. **Glows**
  (`--glow-accent`, `--glow-caution`, `--glow-critical`) mark active or alarm
  states sparingly (held confirm button, armed disarm button, locked target).
- **Motion.** Subtle and functional only. Instrument needles/horizon **glide**
  (`--needle-ease`, ~120ms); UI states snap (`--dur-fast` 90ms). Live/active
  states use a slow opacity **pulse** (tracking border, recording dot, locked
  chip) — never bouncy or decorative. No infinite spinners except command-pending.
- **Hover / press.** Hover lightens the surface one ramp step (`--surface-hover`)
  or reveals a tinted background on ghost controls; primary buttons brighten to
  `--accent-hover`. Press nudges 0.5px down and deepens to the `-active` colour.
  Focus = 2px accent ring offset from the background.
- **Transparency & blur.** Reserved for elements floating *over media* — video
  HUD chips, map legend, toasts — using `rgba(8,12,16,0.7)` + `backdrop-filter:
  blur(6px)`. Chrome surfaces are fully opaque.

---

## Iconography

- **System:** [**Lucide**](https://lucide.dev) — 24×24, 2px stroke, round caps/
  joins, `currentColor`. It is the icon language of the PRD (`lucide-react`) and
  the right weight for this charcoal UI. In the live React app, import
  `lucide-react`; in the static kit/cards here, icons are drawn as inline Lucide-
  path SVGs (`<svg stroke-width="2" stroke-linecap="round">`) via a tiny `Ic`
  helper, to stay dependency-free. **Substitution flag:** none — Lucide is the
  intended set, just inlined rather than bundled.
- **Sizing:** 13–16px inside controls, 15–17px for safety actions, 20–24px for
  feature/marketing. Always inherit colour from the control's text colour so they
  pick up status semantics automatically.
- **No emoji and no decorative unicode** as icons. The only "icon-like" non-Lucide
  marks are the **status dot** (a coloured circle) and the **brand reticle**.
- **Brand mark:** `assets/logo-mark.svg` (a camera-aperture + target-reticle) and
  `assets/logo-wordmark.svg`. These are the one bespoke vector set — created for
  this system since no logo was supplied. ⚠️ *If you have official brand art,
  replace these two files.*

---

## Index / manifest

**Root**
- `styles.css` — the single entry point consumers link (an `@import` list only).
- `tokens/` — `fonts.css`, `colors.css`, `typography.css`, `spacing.css`, `effects.css`.
- `assets/` — `logo-mark.svg`, `logo-wordmark.svg`.
- `readme.md` — this guide. `SKILL.md` — Agent-Skills wrapper.

**Components** (`components/…` — React primitives, each with `.d.ts` + `.prompt.md`)
- `core/` — `Button`, `IconButton`, `StatusPill`, `Badge`, `Panel`, `GaugeReadout`,
  `HoldButton`, `Slider`, `Toggle`, `Tabs`, `Modal`, `Toast`.
- `instruments/` — `AttitudeIndicator`, `Compass`, `BatteryGauge`, `SignalGauge`.

**UI kit** (`ui_kits/ground-control/`) — the full interactive mission-control
screen on a mock data layer. See its `README.md`. Entry: `index.html`.

**Foundation cards** (`guidelines/*.card.html`) — specimen cards rendered in the
Design System tab: neutral ramp, accent, status, surfaces, type (display/body/
mono), spacing, radii, elevation, brand logo.

**Slides** (`slides/*.slide.html`) — branded 1280×720 sample slides: title,
section divider, metrics, content.

### How consumers use it
Link `styles.css` for tokens/fonts; load `_ds_bundle.js` (auto-generated) and read
components from `window.dnhacksPlatformDesignSystem_c7577a`. The UI kit's `mock.js`
mirrors the PRD `DataSource` — swap it for a live provider behind the same seam.
