---
name: eye-in-the-sky-design
description: Use this skill to generate well-branded interfaces and assets for Eye in the Sky, the dark mission-control ground station for an autonomous person-following drone — for production or throwaway prototypes/mocks/decks. Contains design guidelines, color/type/spacing tokens, fonts, logo assets, reusable React components, flight instruments, and a full interactive GCS UI kit.
user-invocable: true
---

Read the `readme.md` file within this skill, and explore the other available files.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets
out and create static HTML files for the user to view. If working on production code,
you can copy assets and read the rules here to become an expert in designing with this
brand.

If the user invokes this skill without any other guidance, ask them what they want to
build or design, ask some questions, and act as an expert designer who outputs HTML
artifacts _or_ production code, depending on the need.

## What's here
- `readme.md` — the full design guide: content fundamentals, visual foundations,
  iconography, and a manifest. **Start here.**
- `styles.css` + `tokens/` — link `styles.css` for all CSS custom properties and
  webfonts (Geist + JetBrains Mono).
- `assets/` — `logo-mark.svg`, `logo-wordmark.svg`.
- `components/` — React primitives (`.jsx` + `.d.ts` + `.prompt.md`): Button,
  IconButton, StatusPill, Badge, Panel, GaugeReadout, HoldButton, Slider, Toggle,
  Tabs, Modal, Toast, and instruments (AttitudeIndicator, Compass, BatteryGauge,
  SignalGauge). Read each `.prompt.md` for usage.
- `ui_kits/ground-control/` — the full interactive mission-control screen with a
  mock data layer (`mock.js`) that mirrors the product's `DataSource` contract.
- `guidelines/*.card.html` — foundation specimen cards.
- `slides/*.slide.html` — branded 1280×720 sample slides.

## Working rules (the short version)
- **Dark, dense, glanceable.** Charcoal surfaces, 1px hairline borders, rationed colour.
- **Mono tabular numerals for every live number** so digits don't jitter.
- **Status semantics are fixed:** green = nominal, amber = caution, red = danger
  (reserve red for genuine danger), grey = inactive, blue = accent/active.
- **Safety first:** Arm gates behind a checklist; Takeoff & Engage need hold-to-confirm;
  Disarm & Disengage are always one instant tap.
- **Lucide icons**, 2px stroke, `currentColor`. No emoji.

## In production code
Link `styles.css`, load the generated `_ds_bundle.js`, and read components from
`window.EyeInTheSkyDesignSystem_c7577a`. For a React/TS app, follow the PRD's
`DataSource` seam — keep all I/O behind it and swap mock → live in one line.
