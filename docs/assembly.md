# Eye in the Sky — Assembly & Wiring Guide

> **Skill level assumed:** complete beginner. Read every section before picking up a soldering iron.
> **Safety first:** never connect a LiPo battery until you have verified all wiring is correct.
> Keep a fire extinguisher nearby when charging/testing LiPo packs.
>
> Cross-references: [hardware.md](hardware.md) for parts, [flashing.md](flashing.md) for firmware,
> [network.md](network.md) for WiFi.

---

## 1. Tools Required

- Soldering iron (temperature-controlled, 350–380 °C)
- Leaded 60/40 solder
- Flux pen or rosin flux
- Multimeter
- M2 and M3 hex drivers
- Wire strippers
- Heat gun or lighter (for heat shrink)
- Helping hands / PCB holder
- Isopropyl alcohol + cotton swabs (flux cleanup)

---

## 2. Build Order Overview

```
1. Frame assembly (no electronics yet)
2. Motor installation
3. ESC installation + motor soldering
4. FC mounting (vibration-isolated)
5. Power distribution wiring
6. GPS installation + mast
7. FC-to-GPS wiring
8. RC receiver installation + wiring
9. Jetson mounting + 5V power
10. Jetson-to-FC UART wiring
11. Camera installation
12. Optional: SiK telemetry radio
13. Final pre-power checks
14. First power-on (no props)
```

---

## 3. Frame Assembly

Follow your frame's instruction manual. General steps for a 5" quadcopter:

1. Install the bottom plate. Note the orientation — most frames have a front marker
   (arrow or pointed end). This is the direction the camera will face.
2. Attach the four arms to the bottom plate with M3 screws.
3. **Do not attach the top plate yet** — you need access to the stack for all wiring.
4. Thread motor wires through the arm channels before screwing arms on.

---

## 4. Motor Installation

Each motor has three phase wires (usually red, yellow, blue or three black wires).
The rotation direction matters; it can be reversed in software later.

**ArduCopter standard motor layout (viewed from above):**

```
     FRONT
      1(CW)   2(CCW)
        \       /
         [frame]
        /       \
      3(CCW)  4(CW)
      BACK
```

- Motors 1 and 4 spin clockwise (CW). Props face down (label up).
- Motors 2 and 3 spin counter-clockwise (CCW). Props face up (label down).

> **Prop direction:** CW motors use CW props; CCW motors use CCW props. Props are
> usually labelled "5040" for 5-inch 4-pitch; the pack contains both CW and CCW variants.

Install motors with M3 screws (usually 4 per motor). Use medium-strength thread locker
(blue Loctite 243) on motor screws — vibration will loosen them otherwise.

---

## 5. ESC Installation & Motor Wiring

### 5.1 4-in-1 ESC placement

Mount the 4-in-1 ESC on the bottom plate or in the lower stack position using M3 nylon
standoffs with rubber O-ring vibration dampers. Nylon standoffs prevent shorts; the O-rings
help with vibration.

### 5.2 Solder motor wires to ESC

Each motor pad on the ESC has 3 connections (A, B, C or 1, 2, 3). Connect the three phase
wires from each motor to the corresponding ESC motor pads. The order determines spin direction:

```
Motor 1 (CW)  -- ESC M1 pads: R->A, Y->B, B->C  (adjust if motor spins wrong way)
Motor 2 (CCW) -- ESC M2 pads
Motor 3 (CCW) -- ESC M3 pads
Motor 4 (CW)  -- ESC M4 pads
```

If a motor spins the wrong direction after first power-on, swap ANY two of its three phase
wires. With BLHeli_32 you can also reverse direction in BLHeliSuite without resoldering.

### 5.3 ESC power input

The 4-in-1 ESC has XT60 or large solder pads for the main battery input. Use 12 AWG silicone
wire. **Leave the XT60 battery connector disconnected until all other wiring is verified.**

### 5.4 ESC signal to FC

The ESC's signal connector (usually a 4-pin JST-SH or individual wires) connects to the FC's
motor output pads M1–M4. Wire labelling varies by FC; consult your SpeedyBee F405 V3 pinout:

```
ESC Signal ----> FC M1/M2/M3/M4 pads
ESC GND   ----> FC GND
ESC +5V   ----> (may be present, often not needed if FC is powered via USB/BEC)
```

Use DSHOT600 in ArduPilot (see [flashing.md](flashing.md) — `SERVO_BLH_MASK`).

---

## 6. Flight Controller Mounting (Vibration Isolation)

**This is critical.** The FC contains sensitive IMU and barometer sensors that are easily
disturbed by motor/prop vibration. Poor vibration isolation causes unstable flight.

### 6.1 FC orientation

Mount the FC with its **arrow (or front marker) pointing toward the nose of the frame.**
If you must rotate it (e.g., due to connector placement), note the angle — you will set
`AHRS_ORIENTATION` in ArduPilot params to compensate.

### 6.2 Anti-vibration mounting

Use the **M3 rubber-ball anti-vibration standoffs** from the BOM:

```
TOP PLATE or FRAME RAIL
    |
[M3 nylon screw]
    |
[Rubber ball / O-ring grommet]  <-- 4 of these
    |
[FC corner hole]
    |
[Rubber ball / O-ring grommet]
    |
[M3 nylon standoff]
    |
BOTTOM PLATE
```

Four mounting points at each FC corner. The FC should have ~1–2 mm of soft movement when
you press on it gently — that is normal and intended. **Do not over-tighten** the screws;
the grommet should compress slightly but not be crushed.

Do **not** use rigid metal standoffs directly for the FC. If you run out of grommets,
even a few layers of 3M foam tape between FC and frame provides acceptable damping.

---

## 7. Power Distribution & Voltage to FC

### 7.1 Power module / BEC

The power module takes the raw 4S LiPo voltage (14.8 V nominal) and:
1. Passes it through to the ESC XT60 input (main power).
2. Provides a **5 V regulated BEC** output for the FC (and optionally other 5 V devices).
3. Monitors voltage + current for ArduPilot battery failsafe.

```
LiPo XT60
    |
Power Module (e.g. Matek FCHUB-6S)
    |--- XT60 out -----> ESC main power pads
    |--- 5V/3A out ----> FC 5V input (VBAT or 5V rail)
    |--- V_sense pin --> FC ADC1 (BATT_VOLT_PIN)
    |--- I_sense pin --> FC ADC2 (BATT_CURR_PIN)
    |--- GND ---------> FC GND
```

### 7.2 ASCII power wiring diagram

```
                    +-------------------------------+
                    |       4S LiPo (14.8V)         |
                    +-------------------------------+
                            |           |
                           (+)         (-)
                            |           |
                    +-------+-----------+-------+
                    |      Power Module / BEC    |
                    |   Matek FCHUB-6S or PM02   |
                    +-------+-----------+-------+
                    |       |           |
                  XT60    5V out     GND out
                  (bat+)  (FC pwr)  (FC pwr)
                    |       |           |
              +-----+   +---+       +---+
              |         |           |
           4-in-1 ESC  FC 5V pad  FC GND pad
           (motor pwr)
              |
          Motors 1-4
```

### 7.3 Jetson power (separate BEC)

The Jetson Orin Nano dev kit draws up to 15 W (~3 A at 5 V). Use a dedicated 5 V / 5 A
step-down BEC (e.g. Pololu 5V 5A):

```
4S LiPo (14.8V)
    |
Pololu 5V/5A Buck Converter
    |
5V/GND barrel jack (5.5/2.1 mm, center positive)
    |
Jetson Orin Nano Dev Kit (DC power input)
```

**Important:** The Jetson dev kit uses a 5.5/2.1 mm barrel jack. Use the same connector
as the included AC adapter. Never power the Jetson from the FC's BEC — it is typically
only rated 1–2 A and will brownout under Jetson load.

---

## 8. GPS + Compass Installation

### 8.1 Physical placement

1. Solder/attach the GPS mast (usually two M3 standoffs screwed together, 100–150 mm tall)
   to the rear of the top plate.
2. Hot-glue or zip-tie the GPS puck to the top of the mast, facing skyward.
3. Route the GPS cable downward through the mast, keeping it away from the ESC/motor power wires.

```
         [ GPS Puck ]   <-- Facing sky, level
              |
         [Mast ~10-15 cm tall]
              |
    [Top plate, rear center]
```

**Reason for the mast:** compass (magnetometer) inside the GPS puck is extremely sensitive to
the magnetic fields generated by motor wires carrying high current. The mast raises it above
the worst interference. Keep GPS cable away from power wires; route to the opposite side.

### 8.2 GPS wiring to FC

The BN-880 and most budget GPS units output:
- **UART** (TX/RX) — connects to a UART on the FC for GPS data (NMEA or UBX protocol)
- **I2C** (SDA/SCL) — connects to FC I2C bus for the external compass (HMC5883L or QMC5883L)
- **5V** and **GND**

```
GPS Module            FC (SpeedyBee F405 V3)
---------             ----------------------
5V      ----------->  5V pad (or BEC 5V)
GND     ----------->  GND
TX      ----------->  UART1 RX  (GPS port, usually UART1 or UART3)
RX      <-----------  UART1 TX
SDA     ----------->  I2C SDA
SCL     ----------->  I2C SCL
```

Consult your specific FC's silkscreen / manual for UART1 location. In ArduPilot:
- `GPS_TYPE = 1` (auto) or `GPS_TYPE = 5` (NMEA) or `GPS_TYPE = 17` (UBX M8N auto)
- `SERIAL3_PROTOCOL = 5` (GPS) on the UART connected to GPS
- `SERIAL3_BAUD = 38` (38400 baud) — or 115200 if using u-blox UBX protocol

---

## 9. Jetson ↔ Flight Controller UART Wiring

This is the most important wiring connection for the system. The Jetson runs the companion
software and speaks **MAVLink** to ArduPilot via a hardware UART link.

### 9.1 Voltage levels

**Critical:** The Jetson GPIO/UART operates at **3.3 V logic**. The SpeedyBee F405 and
most modern FCs also run at 3.3 V logic on their UARTs. **Do not connect 5 V logic to
the Jetson UART pins — you will damage the Jetson.**

Verify your FC's UART TX/RX voltage with its datasheet before wiring. SpeedyBee F405 V3
UARTs are 3.3 V — safe to connect directly to the Jetson.

If your FC is 5 V logic (e.g., older Pixhawk), use a **3.3V/5V level shifter** (bidirectional,
$2–4 USD on Shopee).

### 9.2 Which UART to use

**SpeedyBee F405 V3 UART allocation (recommended):**

| UART | Use |
|------|-----|
| UART1 | GPS |
| UART2 | RC (ELRS/SBUS receiver) |
| **UART3** | **Jetson companion (MAVLink)** |
| UART4 | Spare / SiK telemetry |
| UART5 | USB |

In ArduPilot you will set `SERIAL3_PROTOCOL = 2` (MAVLink2) on UART3.
See [flashing.md](flashing.md) for the exact parameter table.

### 9.3 Wiring diagram

```
Jetson Orin Nano Dev Kit         SpeedyBee F405 V3 FC
(40-pin expansion header          (UART3 pads on PCB)
 or dedicated UART pads)
-----------------------           ----------------------
Pin 8  (UART1_TXD / THS1_TX) --> UART3_RX  (T3 RX pad)
Pin 10 (UART1_RXD / THS1_RX) <-- UART3_TX  (T3 TX pad)
Pin 6  (GND)                 --> GND        (GND pad)
                    [NO 3.3V power connection needed]
```

> **Note on Jetson UART device:** `/dev/ttyTHS1` is the primary hardware UART on the Orin Nano
> dev kit's 40-pin header (pins 8 TX, 10 RX). This is what the companion software uses by
> default (`SERIAL_DEVICE=/dev/ttyTHS1` in the companion config). See [flashing.md](flashing.md)
> for enabling this interface in Jetson's device tree / configuration.

### 9.4 Physical connector

Use a **4-pin JST-GH** or **Dupont 2.54 mm** cable:
- Pin 1: Jetson TX → FC UART3 RX
- Pin 2: Jetson RX ← FC UART3 TX
- Pin 3: GND → GND
- (No 4th pin needed — do not connect 3.3V/5V between systems, each powers itself)

Label the cable clearly. Route it away from motor wires to avoid interference.

### 9.5 Full ASCII wiring diagram

```
JETSON ORIN NANO (40-pin header)        FC (SpeedyBee F405 V3)
================================        ======================
 [Pin 8]  THS1_TX (3.3V) ───────────────→ UART3 RX
 [Pin 10] THS1_RX (3.3V) ←───────────────  UART3 TX
 [Pin 6]  GND            ───────────────→ GND
 [Barrel] +5V (from BEC) ───────────────   [NOT connected to FC's 5V]
```

---

## 10. RC Receiver Installation & Binding

### 10.1 ELRS receiver (RadioMaster Boxer)

1. Mount the ELRS EP2 receiver on the frame with double-sided tape. Keep its antenna
   clear of carbon fibre and away from the FC stack.
2. Wire to FC UART2 (or the designated RC input UART):

```
ELRS EP2 Receiver               FC UART2
-----------------               --------
5V    ----------->              5V pad
GND   ----------->              GND
TX    ----------->              UART2 RX   (CRSF out from RX → FC RX)
RX    <-----------              UART2 TX   (CRSF in from FC → RX for config)
```

3. In ArduPilot: `SERIAL2_PROTOCOL = 23` (RCIN), `RC_PROTOCOLS = 536870912` (CRSF bit).
4. **Binding procedure:** Hold the bind button on the ELRS receiver while powering on.
   Open the RadioMaster Boxer's ExpressLRS Lua script, set matching ELRS settings, and
   execute bind. LED goes solid when bound.

### 10.2 FlySky FS-i6X + FS-iA6B (budget option)

```
FS-iA6B Receiver                FC (any SBUS or IBUS input)
----------------                ---------------------------
5V    ----------->              5V
GND   ----------->              GND
IBUS  ----------->              UART RX (set SERIAL_PROTOCOL=23 for RCIN)
 -- or --
SBUS  ----------->              FC SBUS input pin
```

For SBUS: `SERIAL_PROTOCOL = 23` on the SBUS UART. For IBUS: same plus `RSSI_TYPE = 3`.

Binding FlySky: power receiver while holding its bind button; enter bind mode on TX.

### 10.3 RC switch assignment (important for safety)

Assign a 3-position switch on your TX to **ArduPilot flight mode switching.** ArduPilot
reads RC channel 5 (default) or configurable channel for modes. Configure:
- Switch pos 0: LOITER
- Switch pos 1: GUIDED (for autonomous operation)
- Switch pos 2: STABILIZE (emergency fallback)

This lets you instantly switch to STABILIZE and retake manual stabilized control in an
emergency, which bypasses all companion guidance.

---

## 11. Camera Mounting & Field of View

### 11.1 Physical mount

1. Mount the camera tray on the **nose (front)** of the frame, forward of the props.
2. Tilt the camera **10–15° downward from horizontal** — this ensures that a person
   standing 5–10 m away (the default standoff distance) is in the centre of the frame
   when the drone is at 3–5 m altitude.
3. The camera should be as close to the drone's roll axis as possible to minimise
   image motion during yaw corrections.

```
Side view of drone nose:

  Frame top plate
       ____
      |    |
      | FC |
      |____|----
                \
                 \  10-15° tilt downward
                  [CSI Camera]
```

### 11.2 CSI ribbon cable routing

1. The ribbon cable is fragile — avoid sharp bends. Use the gentle curve shown below:
2. Route the cable alongside the frame rail, secured with small zip ties or tape.
3. Leave enough slack for slight frame flex but no excess that could snag in props.
4. Connect to the **CAM0** port on the Jetson Orin Nano carrier board.

```
[Camera]----(gentle arc, no sharp bends)----[Jetson CAM0 CSI port]
```

**Connector caution:** CSI connectors have a fragile locking tab. Lift the tab gently,
slide the ribbon in, then press the tab down. Never force it.

### 11.3 Field of view reference

IMX219 has ~62.2° horizontal FOV at full resolution. At 720p (the default), the FOV
is similar. At a 5 m standoff, a person (~0.5 m wide) occupies ~5.7° of the frame width —
plenty for detection. The tilt angle ensures the horizon is visible too.

---

## 12. Optional: SiK Telemetry Radio

This gives you a direct MAVLink link from the FC to your ground PC over 433 or 915 MHz,
independent of WiFi. Useful during commissioning and as a backup link.

```
SiK Radio (air unit)            FC (UART4 or spare UART)
-------------------             ------------------------
5V    ----------->              5V
GND   ----------->              GND
TX    ----------->              UART4 RX
RX    <-----------              UART4 TX
```

In ArduPilot: `SERIAL4_PROTOCOL = 2` (MAVLink2), `SERIAL4_BAUD = 57` (57600).
The ground unit connects to your Windows PC via USB. Mission Planner will auto-detect it.

---

## 13. Final Pre-Power Checks

Work through this checklist before connecting the battery for the first time:

1. **Visual inspection:** All solder joints shiny, no bridges, no bare wire touching
   anything it shouldn't.
2. **Motor wires:** Not touching frame carbon fibre, not near prop arcs.
3. **Props:** NOT installed for first power-on.
4. **Multimeter continuity check:** Measure between + and – on the XT60 battery connector:
   should read high resistance (hundreds of ohms). A short reads ~0 ohms — do not power on.
5. **FC stack screws:** All M3 screws present, standoffs tight, FC rubber-damped.
6. **GPS mast:** Secure, antenna facing sky.
7. **Camera ribbon:** Not bent sharply, connector locked.
8. **UART cable (Jetson ↔ FC):** TX→RX orientation correct (NOT TX→TX).
9. **RC receiver:** Powered, antenna free of carbon.
10. **LiPo:** Cells balanced? Check with a LiPo cell checker. Cells should all read 3.7–4.2 V.

**First power-on without props:**
- Connect LiPo. FC should emit startup beeps; motors will beep their ESC greeting tones.
- Check LED indicators on FC; confirm no smoke or unusual heat.
- Connect FC to laptop via USB, open Mission Planner, verify telemetry data appears.

---

## 14. Complete System Wiring Summary Diagram

```
                        BATTERY (4S LiPo)
                             XT60
                              |
                    +---------+---------+
                    |                   |
              Power Module          [XT60 lead]
              (FCHUB-6S)               |
              |        |          4-in-1 ESC
           5V/3A    V+I sense    (BLHeli_32)
              |        |         |  |  |  |
              |        |        M1 M2 M3 M4
         5V BEC       FC         |  |  |  |
         (Pololu)   (SpeedyBee  Motor Motor Motor Motor
              |      F405 V3)   1    2    3    4
              |          |
         Barrel jack   UART1----GPS+Compass (BN-880)
              |         UART2----RC Receiver (ELRS EP2)
        Jetson Orin     UART3<---+
        Nano Dev Kit    UART4----SiK Radio (optional)
              |               |
           CAM0 <--ribbon--- CSI Camera (IMX219)
           M.2 NVMe SSD
           WiFi (Intel 8265 or USB dongle)
              |
          WebSocket :8765 ----------> Ground PC (Windows)
          RTSP :8554 --------------> Ground PC (Windows)
```

---

*Next step: [flashing.md](flashing.md) — Flash ArduCopter and configure all parameters.*
