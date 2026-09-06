# Provisional Bill of Materials

Hardware path for taking the DNHacks stack from SITL to physical flight. Three
tiers, each independently useful; each later tier reuses the earlier one.
Prices are indicative USD (not live-quoted — verify at order time, expect ±20%);
availability assumed from mainstream vendors (Holybro, Matek, SpeedyBee,
RadioMaster, iFlight, Digi-Key/Mouser for sundries).

The software stack ports unchanged: everything below runs ArduPilot (ArduCopter
≥ 4.4), speaks MAVLink to the companion over serial/UDP, and enforces the same
onboard geofence the demo uploads to SITL.

---

## Tier 0 — Hardware-in-the-loop bench (no flight)

Goal: the companion talks to a **physical autopilot** over USB; fence and
mission upload land on real hardware. Zero flight risk, no regulatory scope.
Demo-credibility per dollar is unbeatable.

| Item | Example part | Qty | Est. USD | Notes |
|---|---|---|---:|---|
| Flight controller | Matek H743-SLIM **or** SpeedyBee F405 V4 stack | 1 | 55–95 | H743 preferred (dual IMU, ArduPilot first-class target) |
| GNSS + compass | M10 module (e.g. M10Q-5883) | 1 | 25–40 | Lets readiness checks see a real GPS/compass |
| Telemetry radio pair | SiK 915/433 MHz (Holybro) | 1 | 35–50 | Optional — exercises the real telemetry link path |
| USB-C data cables, jumper leads | — | — | 15 | |
| **Tier 0 total** | | | **≈ 130–200** | |

## Tier 1 — Development airframe (field-flyable quad)

Goal: fly the actual mission profile (GUIDED goto + orbit + RTL) in an open
field. ~1.2–1.6 kg AUW class; registration + basic operator cert required in
most jurisdictions.

| Item | Example part | Qty | Est. USD | Notes |
|---|---|---|---:|---|
| Frame/motor/ESC/prop kit | Holybro X500 V2 kit | 1 | 260–300 | Proven ArduPilot platform; 500 mm, ~1 kg payload margin |
| Flight controller | Pixhawk 6C (or reuse Tier 0 Matek) | 1 | 0–230 | Pixhawk if budget allows (connectors, redundancy); Tier 0 board works |
| GNSS | reuse Tier 0 M10, or Holybro M10 unit | 1 | 0–45 | |
| RC transmitter + receiver | RadioMaster Pocket + ELRS RX | 1 | 85 | Manual override is a hard safety requirement |
| Telemetry | reuse Tier 0 pair | 1 | 0 | |
| Companion computer | Raspberry Pi 5 8GB **or** Jetson Orin Nano | 1 | 80 / 250 | Pi runs the companion + stub vision; Jetson for real YOLO at usable FPS |
| Camera | Pi Cam v3 / USB UVC cam | 1 | 30–70 | |
| Batteries | 4S 5000 mAh LiPo | 2 | 90 | ~15–20 min endurance each |
| Charger | 4S-capable balance charger (e.g. ToolkitRC M6) | 1 | 60 | |
| Power | 5V/5A BEC for companion, XT60 leads, PDB spares | — | 35 | |
| Sundries | props (spares), straps, standoffs, foam, tape | — | 40 | |
| Regulatory | registration + operator certificate | — | 10–200 | Jurisdiction-dependent |
| **Tier 1 total** | | | **≈ 700 (Pi, reused Tier 0) – 1,400 (Pixhawk + Jetson)** | |

## Tier 2 — Deployment concept (per-unit, rough)

Goal: what a real Meridian-class site unit would carry. Not a purchase list yet —
ranges for the pitch's "hardware path" slide.

| Item | Class | Est. USD | Notes |
|---|---|---:|---|
| Airframe | 7–13" long-endurance quad or VTOL | 800–3,000 | 30–60 min endurance |
| RTK GNSS | u-blox F9P rover (+ base) | 300–600 | Sub-meter staging-point arrival |
| Thermal camera | FLIR Lepton 3.5 → Boson | 250–3,000 | Activates the thermal fusion path with real data |
| Optical zoom gimbal | SIYI A8 / ZR10 class | 200–1,500 | |
| LTE/long-range link | LTE modem or Doodle/Microhard | 150–1,500 | |
| Companion | Jetson Orin NX class | 400–700 | |
| Dock ("drone-in-a-box") | commercial dock | 8,000+ | Deferred; manual battery swap until then |
| **Tier 2 unit (no dock)** | | **≈ 2,500–10,000** | |

---

## Recommended order of purchase

1. **Tier 0 now** (~$150): the HIL bench slots straight into the existing demo —
   fence upload onto a physical board is a stage moment and a real test asset.
2. **Tier 1 after the event** if the project continues: one field day validates
   the full GUIDED mission loop on hardware.
3. **Tier 2** only against a real deployment conversation.

## Open questions (to resolve before ordering Tier 1)

- Jurisdiction and flying site → drives registration path and weight ceiling.
- Pi vs Jetson → decided by whether live YOLO (vs stub/thermal-first) is a
  near-term goal.
- Reuse of the person-following camera pipeline vs the new multimodal stack on
  real sensors.
