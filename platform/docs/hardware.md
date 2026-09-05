# Drone Safety Platform — Hardware Bill of Materials

> **Philippines buyer notes:**
> - All prices are **ESTIMATES TO VERIFY** in Philippine Peso (PHP) or USD at prevailing rates.
>   Exchange rates and local availability shift constantly; treat every figure as a rough guide.
> - Many items can be sourced locally at Shopee PH, Lazada PH, or specialist stores in Raon
>   (Quiapo, Manila) and Greenhills. Larger or more specialised parts (Jetson, LIDAR, high-end
>   FC) typically require importation from AliExpress, Amazon, or direct from manufacturer; budget
>   for shipping and potential customs duties (~12% VAT + variable import duty on electronics).
> - Prefer sellers with local stock and return policies when available.

---

## 1. Quick Summary

| Config | Approx. Total (USD, est.) | Notes |
|--------|--------------------------|-------|
| **Minimum viable** | ~$630 – $680 | Jetson + basic frame, budget everything else |
| **Recommended** | ~$720 – $800 | Adds a few reliability upgrades; still lowest-cost |
| **Nice-to-haves** | +$100 – $200 | SiK telemetry radio, external WiFi AP, better camera |

The **NVIDIA Jetson Orin Nano 8 GB dev kit** dominates at roughly $500 USD. Everything else
is commodity hardware chosen purely for lowest cost while remaining ArduPilot-compatible.

---

## 2. Full Bill of Materials

### 2.1 Frame

| Category | Recommended Part | Qty | Est. Unit Price | Notes |
|----------|-----------------|-----|-----------------|-------|
| Frame | **HMF Totem Q380 / Eachine Tyro99 / generic 5" quad frame** | 1 | $12–$20 USD | 5" is the sweet spot: rigid enough for the Jetson, light enough for 4S LiPo flight time. The Tyro99 350 mm kit is widely available on Shopee PH. Any carbon-fibre 5"–7" H-frame works; verify motor-mount spacing matches your motors (usually M3). |
| Frame | **Jumper T-Pro or Eachine E300 450mm alt.** | — | — | If you want longer flight time and don't mind the larger frame, a 450 mm class (like the F450) carries the Jetson more comfortably with a 4S 3000 mAh pack. PHP 600–1,200 est. on Shopee. |

**Minimum viable choice:** Any carbon or nylon 5"–7" quadcopter frame with 30×30 mm or
20×20 mm FC stack mounting pattern, ~$12–20 USD / PHP 700–1,200. Avoid frames without
a battery tray or with very little internal volume (you need room for the Jetson).

---

### 2.2 Motors (×4)

| Category | Recommended Part | Qty | Est. Unit Price | Notes |
|----------|-----------------|-----|-----------------|-------|
| Motor | **EMAX RS2205 2300 KV** (5" frame) | 4 | $8–$12 USD each | Proven, widely available, great value. 2205 2300KV is standard for 5" 4S. Shopee PH has clones at PHP 300–500 each; genuine EMAX preferred for longevity. |
| Motor | **T-Motor F40 PRO III 2400KV** (budget alt.) | 4 | $10–$14 USD each | Slightly better efficiency. |
| Motor | **EMAX MT2213 935KV** (450mm frame alt.) | 4 | $8–$10 USD each | For a 450mm frame with 9–10" props and slower, heavier build. |

**Rule of thumb:** for a 5" freestyle-style build with the Jetson, 2205–2306 motors at
2300–2450 KV on 4S (14.8 V) give adequate thrust-to-weight ratio. You need ~4:1 minimum
thrust:weight ratio when loaded with the Jetson (~200 g) + battery (~300–400 g) + frame + misc.

---

### 2.3 ESC (4-in-1 preferred)

| Category | Recommended Part | Qty | Est. Unit Price | Notes |
|----------|-----------------|-----|-----------------|-------|
| ESC | **Racerstar Shot 35A BLHeli_32 4-in-1** | 1 | $18–$28 USD | Single 4-in-1 unit simplifies wiring enormously. BLHeli_32 supports DSHOT600 (the preferred protocol for ArduPilot). 30×30 mm stack mount. |
| ESC | **Tekko32 F4 45A 4-in-1** (alt.) | 1 | $30–$40 USD | Better MOSFETs, handles more current. Worth the extra $10 for reliability. |
| ESC | **4× individual 30A BLHeli_S ESCs** (budget alt.) | 4 | $5–$7 USD each | More wiring, harder to fit, but lower unit cost. OK if the 4-in-1 is unavailable locally. |

**Minimum viable:** Any BLHeli_S or BLHeli_32 4-in-1 ESC, 30–45 A per cell, 4S-rated (16.8 V
max), with DSHOT support. DSHOT is preferred over PWM with ArduPilot — removes calibration step.

---

### 2.4 Propellers (+ Spares)

| Category | Recommended Part | Qty | Est. Unit Price | Notes |
|----------|-----------------|-----|-----------------|-------|
| Props | **HQProp 5040 (5×4.0) 3-blade** or **Gemfan 5152** | 2 sets (8 props) | $2–$4 USD/set | Buy at least 2 sets (8 total) as spares. For 450mm frame use 9443 self-tightening props. |
| Props — spare | Same model | 2 sets | $2–$4 USD/set | Props break on every crash. Carry 4 sets total. |

---

### 2.5 Flight Controller (ArduPilot-compatible)

| Category | Recommended Part | Qty | Est. Unit Price | Notes |
|----------|-----------------|-----|-----------------|-------|
| FC | **SpeedyBee F405 Wing** (or **SpeedyBee F405 V3**) | 1 | $35–$45 USD | **Verified ArduCopter support** (listed in ArduPilot hardware database). STM32F405, barometer, dedicated UART ports, 30×30 mm stack. The SpeedyBee F405 V3 is the primary recommendation: has 5× UARTs (one needed for the companion, one for GPS, one for RC ELRS). Sold on Shopee PH and Lazada. |
| FC | **Matek H743-Wing v2** (alt., more UARTs) | 1 | $45–$60 USD | STM32H743, more UARTs, better for complex setups. Overkill for this build but excellent ArduPilot support. |
| FC | **Pixhawk 2.4.8 clone** (budget Pixhawk-class) | 1 | $25–$40 USD | Widely available in PH Shopee. ArduCopter support verified. Bulkier, but robust and has dedicated telemetry UART. Good if you already have one. |

**Recommendation:** SpeedyBee F405 V3 is the top choice — small, cheap, excellent ArduPilot
support, and has enough UARTs for GPS + Jetson companion + ELRS RX. Verify the exact product
listing against the [ArduPilot hardware page](https://ardupilot.org/copter/docs/common-autopilots.html)
before purchase.

---

### 2.6 GPS + Compass

| Category | Recommended Part | Qty | Est. Unit Price | Notes |
|----------|-----------------|-----|-----------------|-------|
| GPS/Compass | **BN-880 GPS (u-blox M8N clone) + HMC5883L compass** | 1 | $8–$15 USD | Most common budget combo. UART + I2C. Comes with a mounting stand. Adequate for this project. Available on Shopee PH PHP 400–800. |
| GPS/Compass | **Matek M8Q-5883** (better alt.) | 1 | $22–$30 USD | Genuine u-blox M8Q, better antenna, integrated compass. Worth the upgrade. |
| GPS/Compass | **SpeedyBee M10 GPS** | 1 | $25–$30 USD | Pairs well with SpeedyBee FC, u-blox M10, SAT count is excellent. |

**Placement note:** mount the GPS as high and as far from motors/power wires as possible
(top of a 10–15 cm mast) to avoid compass interference. See `assembly.md`.

---

### 2.7 Companion Computer (NVIDIA Jetson Orin Nano)

| Category | Recommended Part | Qty | Est. Unit Price | Notes |
|----------|-----------------|-----|-----------------|-------|
| Companion | **NVIDIA Jetson Orin Nano 8 GB Developer Kit** | 1 | **~$499 USD** | This is the single largest cost item. The dev kit includes the carrier board, heatsink, and power supply. The 8 GB module (vs 4 GB) is required for running YOLOv8 TensorRT + all companion software comfortably. Must be imported; not widely available locally in PH. Order from NVIDIA, Arrow Electronics, Digi-Key, or authorised distributors. Budget for shipping + import duties. |
| Storage | **NVMe SSD — WD Green SN350 240 GB M.2 2280** | 1 | $25–$35 USD | The Jetson Orin Nano dev kit has an M.2 M-key slot. NVMe SSD is strongly preferred over microSD for Docker container performance and reliability. |
| Storage | **microSD — SanDisk Extreme 64 GB (UHS-I A2)** | 1 | $10–$15 USD | Used as boot/OS medium or as a fallback. Needed for initial JetPack flash via SDK Manager. Available at SM malls, DataBlitz, or online. |

**Import note:** The Jetson Orin Nano is export-controlled under US EAR. Philippines is
generally eligible for direct purchase, but verify with your supplier. Expect 2–4 weeks
shipping time. Total landed cost in PH may be PHP 30,000–35,000 with duties.

---

### 2.8 Camera (CSI, IMX219-class)

| Category | Recommended Part | Qty | Est. Unit Price | Notes |
|----------|-----------------|-----|-----------------|-------|
| Camera | **IMX219 CSI Camera Module** (Raspberry Pi Camera v2 compatible) | 1 | $10–$20 USD | Directly compatible with the Jetson Orin Nano's CSI camera port. 8 MP, 3280×2464, but we use 1280×720 @ 60 fps for low latency. Available on Shopee PH PHP 500–1,200. |
| Camera | **IMX477 (HQ Camera Module)** (better quality alt.) | 1 | $25–$40 USD | Better low-light performance; useful for indoor/dusk tracking. Not required. |
| Camera mount | **3D-printed or aluminium tilt mount for CSI camera** | 1 | $3–$8 USD | Mount pointing slightly downward 10–15° from horizontal for better coverage of persons at standoff. Many printable designs on Thingiverse. |
| Ribbon cable | **FPC ribbon cable 200–300 mm** (CSI, 15-pin, compatible with Jetson) | 1–2 | $2–$5 USD | Included with most camera modules; buy a spare. Verify connector type matches your carrier board. |

---

### 2.9 Power System

| Category | Recommended Part | Qty | Est. Unit Price | Notes |
|----------|-----------------|-----|-----------------|-------|
| LiPo | **Tattu / CNHL 4S 2800 mAh 75C XT60** | 1 | $25–$40 USD | 4S (14.8 V nominal, 16.8 V full). 2800 mAh gives ~8–12 min flight time with Jetson load. |
| LiPo (spare) | Same model | 1 | $25–$40 USD | Always have at least 2 packs. |
| LiPo Charger | **ISDT Q6 Pro** or **HTRC T150** | 1 | $20–$35 USD | Balance charger, 4S capable, XT60 leads. Available locally at RC shops in Quiapo. |
| Power Module | **Matek FCHUB-6S / BEC module** or **Holybro PM02** | 1 | $8–$20 USD | Converts battery voltage to 5 V for FC + provides current/voltage sensing for ArduPilot's battery failsafe. Must handle 4S and your peak draw (~60 A burst). |
| 5V BEC | **Pololu 5V 5A step-down** (if not in power module) | 1 | $8–$12 USD | Dedicated regulated 5 V for Jetson (3–4 A at 5 V = 15–20 W). The Jetson dev kit uses a barrel jack at 5–12V; use its included barrel jack adapter with the BEC. |
| Wiring | **XT60 connectors (M+F pairs), 12 AWG silicone wire (red/black)** | 2 pairs | $3–$5 | High-current main power wires. |
| Wiring | **JST connectors, zip ties, heat shrink** | 1 bag | $3–$5 | Misc wiring supplies. |

**Jetson power note:** The Orin Nano dev kit accepts 5–12 V via a barrel jack at up to 4 A.
Use the included 12 V/4 A adapter on the bench; on the drone use a dedicated 5 V/5 A BEC.
Do NOT power the Jetson directly from the FC's 5 V BEC — it may be under-rated.

---

### 2.10 RC Transmitter & Receiver

| Category | Recommended Part | Qty | Est. Unit Price | Notes |
|----------|-----------------|-----|-----------------|-------|
| TX | **RadioMaster Boxer** (recommended) | 1 | $99–$129 USD | ExpressLRS (ELRS) built-in, multi-protocol, OpenTX/EdgeTX. Best value in the budget TX segment. |
| TX | **FlySky FS-i6X + FS-iA10B receiver** (budget alt.) | 1 set | $35–$50 USD | Widely available on Shopee PH PHP 2,000–3,000. Uses IBUS/SBUS protocol, both supported by ArduPilot. If buying budget, this is the go-to in PH. |
| TX | **Radiomaster Pocket ELRS** | 1 | $60–$80 USD | Smaller and cheaper than the Boxer; same ELRS 2.4 GHz tech. |
| RX | **ELRS EP2 receiver** (for Boxer/ELRS TX) | 1 | $10–$15 USD | Tiny, 1–2 g, UART CRSF output. Works natively with ArduPilot on SpeedyBee FC. |
| RX | **FlySky FS-iA6B** (for FlySky TX) | 1 | $10–$18 USD | Included with the FS-i6X combo usually. IBUS output supported by ArduPilot. |

**Protocol note:** ArduPilot supports SBUS, IBUS, ELRS (CRSF), DSM, and FHSS. ELRS is the
technically superior choice (low latency, long range, open source). The FlySky combo is the
cheapest PH-local option. Verify the protocol matches the FC UART port in ArduPilot params.

---

### 2.11 Communications

| Category | Recommended Part | Qty | Est. Unit Price | Notes |
|----------|-----------------|-----|-----------------|-------|
| WiFi | **TP-Link TL-WN725N USB WiFi** (Jetson ↔ Ground) | 1 | $7–$12 USD | The Jetson dev kit has built-in M.2 WiFi (Intel 8265) on newer boards; if yours does, skip this. The USB dongle is a cheap fallback or second interface to create a WiFi AP. Shopee PH PHP 300–500. |
| WiFi Alt. | **GL.iNet GL-MT300N-V2 travel router** (recommended) | 1 | $20–$30 USD | Acts as a dedicated WiFi LAN for drone ↔ ground. Reliable, creates its own network, no driver issues. Optional but highly recommended for clean networking. |
| Telemetry | **HM-TRP SiK 915 MHz / 433 MHz telemetry radio pair** | 1 pair | $20–$40 USD | **OPTIONAL** backup link. Gives you a MAVLink channel over 433/915 MHz that works even if WiFi fails. 915 MHz preferred in Philippines (check local spectrum regulations). Connect one to FC UART, one to ground PC USB. Very useful for commissioning but not required for normal operation. |

**Philippines frequency note:** 433 MHz is ISM band, generally permitted for short-range
low-power devices. 915 MHz may require licensing for some power levels. 2.4 GHz WiFi and
2.4 GHz RC are both permitted under NTC regulations for standard EIRP levels. Verify current
NTC rules before importing higher-power radios.

---

### 2.12 Miscellaneous / Consumables

| Category | Recommended Part | Qty | Est. Unit Price | Notes |
|----------|-----------------|-----|-----------------|-------|
| Vibration dampeners | **M3 anti-vibration standoffs** (FC stack) | 4 | $3–$5 USD | Rubber-ball type or O-ring dampeners. Reduces vibration-induced noise on IMU/barometer. |
| Standoffs | **M3 nylon/aluminium standoffs (10/20/30 mm)** | 1 bag | $3–$5 USD | For Jetson mounting, FC stack, and camera. |
| UART cable | **Dupont / JST-GH 4-pin cable 20 cm** | 2–3 | $1–$3 USD | For Jetson-to-FC UART (TX/RX/GND). |
| USB cable | **USB-A to micro-USB / USB-C** | 1 | $2–$4 USD | For FC flashing / debugging. |
| Cooling | **Jetson Orin Nano heatsink + fan** | — | Included in dev kit | The dev kit includes a heatsink+fan assembly. Add a 30 mm 5 V fan if operating in a hot Philippine climate or if the dev kit fan is insufficient. |
| Mounting | **Double-sided foam tape (3M or equivalent)** | 1 roll | $2–$4 USD | Mounting Jetson to frame, GPS mast base, etc. |
| Mounting | **Zip ties (150 mm, small bag)** | 1 bag | $1–$2 USD | |
| Velcro strap | **25 mm velcro battery strap** | 2 | $2–$4 USD | Secure the LiPo. |
| Tools | **M2/M3 hex drivers, LiPo safe bag, soldering kit** | — | $15–$30 USD | If you don't have them already. |
| Solder | **Leaded 60/40 rosin-core solder** | 1 roll | $3–$5 USD | For ESC/motor/power module joints. |

---

## 3. Estimated Totals

### 3.1 Minimum Viable Configuration

Choose the cheapest option in each category:

| Item | Qty | Unit Cost (USD est.) | Total (USD est.) |
|------|-----|---------------------|-----------------|
| Frame (generic 5" CF) | 1 | $14 | $14 |
| Motors EMAX RS2205 | 4 | $10 | $40 |
| ESC 4-in-1 BLHeli_S 35A | 1 | $20 | $20 |
| Props 5040 + 2 spare sets | 3 sets | $3 | $9 |
| FC SpeedyBee F405 V3 | 1 | $38 | $38 |
| GPS BN-880 | 1 | $12 | $12 |
| **Jetson Orin Nano 8GB Dev Kit** | 1 | **$499** | **$499** |
| NVMe SSD 240 GB | 1 | $28 | $28 |
| microSD 64 GB | 1 | $12 | $12 |
| IMX219 CSI Camera | 1 | $15 | $15 |
| Camera mount | 1 | $5 | $5 |
| LiPo 4S 2800 mAh ×2 | 2 | $30 | $60 |
| LiPo Charger | 1 | $22 | $22 |
| Power Module | 1 | $12 | $12 |
| 5V BEC | 1 | $9 | $9 |
| FlySky FS-i6X + RX | 1 set | $40 | $40 |
| USB WiFi dongle | 1 | $9 | $9 |
| Wiring / connectors | misc | — | $8 |
| Misc (standoffs, ties, tape) | misc | — | $10 |
| **Minimum Viable Total** | | | **~$662** |

### 3.2 Recommended Configuration (+~$80–120)

Same as above but:
- Upgrade to SpeedyBee M10 GPS ($28 instead of $12, +$16)
- Upgrade to Tekko32 F4 45A ESC ($38 instead of $20, +$18)
- Upgrade to RadioMaster Boxer + ELRS EP2 RX ($115 instead of $40, +$75)
- Add SiK 433 MHz telemetry pair ($30, +$30)
- Add GL.iNet travel router ($25, +$25)

**Recommended Total: ~$760–$830 USD** (varies by exchange rate and import costs).

### 3.3 Nice-to-Have Extras

| Item | Cost (USD est.) | Why |
|------|----------------|-----|
| IMX477 HQ Camera | +$30 | Better low-light |
| SiK 915 MHz telemetry (if 433 restricted) | +$40 | Separate from above |
| Extra LiPo packs (×2 more) | +$60 | More flight time |
| Proper LiPo-safe charging bag | +$10 | Fire safety |
| 3D-printed Jetson mounting tray | +$5 filament | Custom fit |

---

## 4. Sourcing Guide (Philippines)

| Source | Best For |
|--------|----------|
| **Shopee PH** | Frame, motors, props, ESC, FC (SpeedyBee), FlySky TX/RX, LiPo, charger, misc |
| **Lazada PH** | Similar to Shopee; compare prices |
| **Raon / Quiapo (Manila)** | Local electronics components, connectors, wiring supplies |
| **DataBlitz / PC Express** | microSD cards, USB accessories |
| **AliExpress** | Long shipping but cheapest source for bulk items; BN-880 GPS, camera mounts |
| **Arrow Electronics / Digi-Key** | Jetson Orin Nano (authorised distributor, ships internationally) |
| **NVIDIA Store** | Jetson Orin Nano developer kit directly |
| **Amazon US** (with forwarding) | Many items if you use a remailing service |

> **Tip:** For the Jetson, check if AMSEA (a local NVIDIA distributor) has stock, or use
> Arrow Electronics Singapore which often ships to PH with lower duty than the US.

---

*Cross-references: [assembly.md](assembly.md) for wiring, [flashing.md](flashing.md) for firmware,
[network.md](network.md) for WiFi setup, [runbook.md](runbook.md) for first-flight steps.*
