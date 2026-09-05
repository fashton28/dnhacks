# Drone Safety Platform — Firmware Flashing & Software Deployment

> Cross-references: [hardware.md](hardware.md) for parts, [assembly.md](assembly.md) for wiring,
> [network.md](network.md) for WiFi, [runbook.md](runbook.md) for commissioning.

---

## Part 1: ArduCopter — Flight Controller Firmware

### 1.1 Required Tools

- Windows PC with [Mission Planner](https://ardupilot.org/planner/docs/mission-planner-installation.html) installed (free, Windows only)
- USB-A to Micro-USB cable (for SpeedyBee F405 V3 — check your FC's USB connector type)
- Latest stable ArduCopter firmware (downloaded via Mission Planner)

### 1.2 Flash ArduCopter via Mission Planner

1. Open Mission Planner. Do **not** connect the FC yet.
2. Go to **SETUP → Install Firmware**.
3. Select the **Quad** vehicle type (copter).
4. Mission Planner will show the latest stable ArduCopter build. At the time of writing,
   ArduCopter 4.5.x is stable. Click the Quad icon to download and flash.
5. When prompted, connect the FC via USB. Mission Planner will detect the COM port.
6. The flash process takes ~30–90 seconds. The FC will reboot when done.
7. Reconnect via USB (typically 115200 baud, COM port auto-detected).

**Verify:** The Initial Setup → Mandatory Hardware wizard will guide you through the next steps.

### 1.3 Mandatory Hardware Setup (Mission Planner wizard)

Run through these screens in Mission Planner before setting any parameters manually:

1. **Frame Type:** Select "X" (standard quadcopter X config). Click **Next**.
2. **Accelerometer Calibration:** Follow the 6-position calibration. Set the drone on a flat
   surface, then tilt it to each shown orientation and click **Click When Done** each time.
3. **Compass Calibration:** Click **Start** — rotate the drone in all axes (think of stirring
   a ball in 3D). Wait for progress bars to fill. Click **Done/Reboot**.
4. **Radio Calibration:** Turn on your RC transmitter, connect receiver, and move all sticks
   to extremes as instructed. Click **Calibrate Radio**.
5. **ESC Calibration:** If using DSHOT, skip this (no PWM calibration needed).
   If using PWM: follow Mission Planner's ESC calibration procedure.

### 1.4 ArduCopter Parameter Table

After completing the wizard, set these parameters precisely. Copy-paste them one by one
in Mission Planner's **CONFIG → Full Parameter List** search box, or use the Parameter
Compare / load function with the file at `companion/config/ardupilot_params.param`.

> **Safety note:** these parameters implement the safety architecture defined in the PRD.
> Do not skip or change default values without understanding the consequences.

#### 1.4.1 General Flight Mode & Arming

| Parameter | Value | Notes |
|-----------|-------|-------|
| `ARMING_CHECK` | `1` | Enable all arming checks |
| `ARMING_REQUIRE` | `1` | Require RC arming switch |
| `FS_EKF_ACTION` | `1` | EKF failsafe → Land |
| `FS_EKF_THRESH` | `0.8` | EKF variance threshold |
| `FLTMODE1` | `5` | LOITER (flight mode switch pos 1) |
| `FLTMODE2` | `4` | GUIDED (switch pos 2) — companion uses this |
| `FLTMODE3` | `0` | STABILIZE (emergency fallback) |
| `FLTMODE4` | `11` | RTL |
| `FLTMODE5` | `9` | LAND |
| `FLTMODE6` | `4` | GUIDED |
| `FLTMODE_CH` | `5` | RC channel for flight mode switching |

#### 1.4.2 Companion Serial Port (Jetson UART link)

These configure UART3 on the SpeedyBee F405 V3 as the MAVLink2 connection to the Jetson.
**Adjust `SERIAL3` to match whichever UART you physically wired to the Jetson — see
[assembly.md](assembly.md) section 9.**

| Parameter | Value | Notes |
|-----------|-------|-------|
| `SERIAL3_PROTOCOL` | `2` | MAVLink2 |
| `SERIAL3_BAUD` | `115` | 115200 baud (recommended for companion) |
| `SERIAL3_OPTIONS` | `0` | No special options |

If you are also using an optional SiK telemetry radio on UART4:

| Parameter | Value | Notes |
|-----------|-------|-------|
| `SERIAL4_PROTOCOL` | `2` | MAVLink2 |
| `SERIAL4_BAUD` | `57` | 57600 baud (SiK default) |

#### 1.4.3 RC Override (Pilot Always Wins)

This is a **critical safety requirement** from PRD §11. The RC override ensures a human
pilot can always retake control regardless of what the companion is commanding.

| Parameter | Value | Notes |
|-----------|-------|-------|
| `SYSID_MYGCS` | `255` | Ground station system ID |
| `RC_OVERRIDE_TIME` | `3` | RC override lasts 3 s after last input (seconds) |
| `FS_GCS_ENABLE` | `1` | GCS heartbeat failsafe enabled |
| `FS_GCS_TIMEOUT` | `5` | Trigger after 5 s without GCS heartbeat |
| `FS_GCS_ACTION` | `1` | RTL on GCS loss (see failsafe section below) |

**How override works:** When the pilot moves an RC stick, ArduPilot gives the RC higher
priority. The companion's GUIDED setpoints are ignored while RC override is active. The
companion detects this and stops sending setpoints. The `RC_OVERRIDE_TIME` parameter sets
how long RC override stays active after the last stick input.

#### 1.4.4 Battery Failsafe

Match these to the companion's Defaults and the UI's FailsafeConfig defaults (batteryWarnPct=30,
batteryFailsafePct=15 from `shared/shared.py` and `ground/ui/src/store/settings.ts`):

| Parameter | Value | Notes |
|-----------|-------|-------|
| `BATT_MONITOR` | `4` | Enable voltage + current monitoring via power module |
| `BATT_VOLT_PIN` | `13` | ADC pin for voltage (FC-specific; verify for SpeedyBee) |
| `BATT_CURR_PIN` | `12` | ADC pin for current |
| `BATT_VOLT_MULT` | `10.1` | Calibration multiplier (set in Mission Planner calibration) |
| `BATT_AMP_PERVLT` | `17.0` | Current sensor scaling (calibrate with known load) |
| `BATT_CAPACITY` | `2800` | Battery capacity in mAh (match your pack) |
| `BATT_LOW_VOLT` | `14.0` | Warn threshold ~3.5V/cell (4S = 14.0V) |
| `BATT_CRT_VOLT` | `13.2` | Critical threshold ~3.3V/cell |
| `BATT_LOW_MAH` | `400` | Warn when < 400 mAh remaining |
| `BATT_CRT_MAH` | `150` | Critical when < 150 mAh remaining |
| `BATT_FS_LOW_ACT` | `2` | Low battery → RTL |
| `BATT_FS_CRT_ACT` | `1` | Critical battery → Land immediately |

> Calibrate `BATT_VOLT_MULT` and `BATT_AMP_PERVLT` by measuring real battery voltage with
> a multimeter and comparing to Mission Planner's reported value.

#### 1.4.5 Geofence (FENCE_*)

Match to companion's `DEFAULTS.geofence_radius = 60 m` and `DEFAULTS.max_altitude = 30 m`:

| Parameter | Value | Notes |
|-----------|-------|-------|
| `FENCE_ENABLE` | `1` | Enable geofence |
| `FENCE_TYPE` | `7` | Circle + altitude min + altitude max (bitmask: 1+2+4=7) |
| `FENCE_RADIUS` | `60` | 60 m radius (matches companion geofence_radius) |
| `FENCE_ALT_MAX` | `30` | 30 m max altitude (matches companion max_altitude) |
| `FENCE_ALT_MIN` | `0` | Minimum altitude (0 = ground) |
| `FENCE_MARGIN` | `2` | Brake 2 m before fence boundary |
| `FENCE_ACTION` | `1` | RTL when fence is breached |
| `FENCE_RET_RALLY` | `0` | Return to home (not rally points) |

#### 1.4.6 GCS Heartbeat / Link-Loss Failsafe

| Parameter | Value | Notes |
|-----------|-------|-------|
| `FS_GCS_ENABLE` | `1` | Enable GCS heartbeat failsafe |
| `FS_GCS_TIMEOUT` | `5` | 5 seconds without heartbeat triggers failsafe |
| `FS_GCS_ACTION` | `2` | RTL on GCS heartbeat loss (2 = RTL; use `1` for Hold) |
| `FS_THR_ENABLE` | `1` | Enable RC throttle failsafe |
| `FS_THR_VALUE` | `975` | Throttle PWM below this triggers RC loss failsafe |
| `FS_THR_ACTION` | `4` | Land on RC loss (safer than RTL if RC link is noisy) |

#### 1.4.7 RTL and Altitude Settings

| Parameter | Value | Notes |
|-----------|-------|-------|
| `RTL_ALT` | `2000` | Climb to 20 m (2000 cm) before returning home |
| `RTL_ALT_FINAL` | `0` | Land after returning |
| `RTL_LOIT_TIME` | `5000` | Loiter 5 s over home before landing |
| `RTL_SPEED` | `0` | Use WPNAV_SPEED (= auto; 0 = use WP speed) |
| `PILOT_SPEED_UP` | `150` | Max manual climb rate 150 cm/s = 1.5 m/s |
| `PILOT_SPEED_DN` | `150` | Max manual descent rate |
| `WPNAV_SPEED` | `150` | Waypoint nav speed (150 cm/s = 1.5 m/s, conservative) |

#### 1.4.8 EKF3 (Extended Kalman Filter)

| Parameter | Value | Notes |
|-----------|-------|-------|
| `EK3_ENABLE` | `1` | Enable EKF3 (default in ArduCopter 4.x) |
| `EK3_GPS_TYPE` | `0` | Use GPS position + velocity |
| `EK3_ALT_SOURCE` | `0` | Barometer for altitude (default) |
| `AHRS_EKF_TYPE` | `3` | Use EKF3 |

#### 1.4.9 Motor / ESC Configuration (DSHOT)

| Parameter | Value | Notes |
|-----------|-------|-------|
| `MOT_PWM_TYPE` | `6` | DSHOT600 (if using BLHeli_32 ESC) |
| `SERVO_BLH_MASK` | `15` | BLHeli passthrough on motors 1–4 (bitmask: 1+2+4+8=15) |
| `SERVO_BLH_AUTO` | `1` | Auto-enable BLHeli passthrough |
| `MOT_SPIN_ARM` | `0.10` | Minimal spin when armed (10%) |
| `MOT_SPIN_MIN` | `0.15` | Minimum spin for reliable lift |
| `MOT_SPIN_MAX` | `0.95` | Maximum spin (leave headroom) |
| `MOT_THST_HOVER` | `0.35` | Estimated hover throttle (calibrate in hover) |

> Set `MOT_PWM_TYPE = 0` (normal PWM) if your ESC does not support DSHOT.
> Then you MUST do ESC PWM calibration via Mission Planner.

### 1.5 Saving Parameters

In Mission Planner:
1. Click **Write Params** after entering each value (or enter all, then write).
2. **Reboot the FC** after writing all parameters (mandatory for some to take effect).
3. After reboot: do a full pre-arm check in Mission Planner's Flight Data view. All
   pre-arm warnings should clear except GPS (which needs outdoor sky view).

### 1.6 Motor Direction Test (Props-Off)

1. In Mission Planner: **SETUP → Optional Hardware → Motor Test**.
2. Test each motor one at a time at minimum throttle.
3. Verify rotation direction matches the layout in [assembly.md](assembly.md) section 4.
4. If a motor spins the wrong way: either swap any two phase wires (resoldering),
   or use BLHeliSuite to reverse direction in software (preferred).

---

## Part 2: JetPack on the Jetson Orin Nano

### 2.1 JetPack Version

Use **JetPack 6.0** (or the latest stable release for Orin Nano). JetPack includes:
- Ubuntu 22.04 base OS (L4T — Linux for Tegra)
- CUDA 12.x, cuDNN 8.x, TensorRT 8.x
- GStreamer with NVENC/NVDEC acceleration
- Pre-configured UART, CSI camera, I2C device tree

**Check the companion's Dockerfile** (`companion/Dockerfile`) for the exact pinned L4T base
image tag to ensure compatibility.

### 2.2 Initial JetPack Flash via SDK Manager

1. On a **Ubuntu host PC** (required for SDK Manager — it does not run on Windows natively;
   use WSL2 or a Ubuntu VM / dual boot):

```bash
# Install NVIDIA SDK Manager
# Download .deb from: https://developer.nvidia.com/nvidia-sdk-manager
sudo dpkg -i sdkmanager_*_amd64.deb
sdkmanager
```

2. In SDK Manager:
   - Product: Jetson
   - Hardware: Jetson Orin Nano (8GB) Developer Kit
   - Operating system: JetPack 6.0 (or latest stable)
   - Components: Jetson OS + Jetson SDK Components
3. Power the Jetson in recovery mode:
   - Connect Jetson to the Ubuntu host via USB-C.
   - Hold the Recovery button (or short recovery pin with a jumper), then press Power.
4. Click **Flash** in SDK Manager. The process takes ~15–30 minutes.
5. After flashing, the Jetson boots to Ubuntu desktop (if HDMI connected) or headless.
6. Complete initial setup (username: `jetson`, set a strong password).

**Alternative: microSD-based flash** (simpler but slower, not recommended for production):
Use Balena Etcher to flash a JetPack image directly to microSD. No Ubuntu host needed.
Download the `.img.gz` from NVIDIA developer portal for Orin Nano.

### 2.3 Enable Hardware UART (ttyTHS1)

The Jetson's `/dev/ttyTHS1` (40-pin header pins 8/10) must be enabled:

```bash
# On the Jetson:
sudo systemctl stop nvgetty
sudo systemctl disable nvgetty
sudo usermod -aG dialout $USER
# Re-login or reboot
```

Verify the port exists:
```bash
ls -la /dev/ttyTHS1
```

### 2.4 Install Docker on Jetson

The companion software runs in a Docker container:

```bash
# Docker is usually pre-installed in JetPack 6
# If not:
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Re-login

# Verify:
docker --version

# Install docker-compose
sudo apt-get install -y docker-compose-plugin
docker compose version
```

### 2.5 Deploy Companion Container

```bash
# Clone the repo or copy the companion directory to the Jetson
git clone https://github.com/<your-repo>/dnhacks-platform.git /opt/dnhacks-platform
cd /opt/dnhacks-platform

# Copy and edit the environment file
cp .env.example .env
nano .env
```

Key `.env` variables to set on the Jetson:

```bash
# .env on Jetson
SERIAL_DEVICE=/dev/ttyTHS1       # FC UART connection
SERIAL_BAUD=115200                # Must match SERIAL3_BAUD in ArduPilot
CAMERA_SOURCE=csi                 # Use CSI camera (nvarguscamerasrc)
CAMERA_WIDTH=1280
CAMERA_HEIGHT=720
CAMERA_FPS=30
CONTROL_PORT=8765                 # WebSocket port
VIDEO_PORT=8554                   # RTSP port
STANDOFF_DEFAULT=5.0              # meters
MAX_SPEED_DEFAULT=2.0             # m/s
MAX_ALTITUDE=30.0                 # m
GEOFENCE_RADIUS=60.0              # m
```

Build and start the container:

```bash
cd /opt/dnhacks-platform
docker compose -f companion/docker-compose.yml up --build -d
```

Check it is running:
```bash
docker compose -f companion/docker-compose.yml ps
docker compose -f companion/docker-compose.yml logs -f
```

### 2.6 Systemd Autostart

Install the companion as a systemd service so it starts on boot:

```bash
sudo cp scripts/dnhacks-platform-companion.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable dnhacks-platform-companion.service
sudo systemctl start dnhacks-platform-companion.service
sudo systemctl status dnhacks-platform-companion.service
```

The service file (`scripts/dnhacks-platform-companion.service`) should contain:

```ini
[Unit]
Description=Drone Safety Platform Companion
After=network.target docker.service
Requires=docker.service

[Service]
Type=simple
Restart=on-failure
RestartSec=5
WorkingDirectory=/opt/dnhacks-platform
ExecStartPre=/usr/bin/docker compose -f companion/docker-compose.yml down --remove-orphans
ExecStart=/usr/bin/docker compose -f companion/docker-compose.yml up
ExecStop=/usr/bin/docker compose -f companion/docker-compose.yml down
TimeoutStartSec=120
User=jetson
Group=docker

[Install]
WantedBy=multi-user.target
```

### 2.7 Export TensorRT Engine for Person Detection

The companion uses a YOLO-based person detector optimised as a TensorRT engine.
This export must run **on the Jetson itself** because TensorRT engines are hardware-specific.

Run the export script inside the companion container:

```bash
# Exec into the running container
docker exec -it dnhacks-platform-companion bash

# Inside the container, run the export script
cd /app
python scripts/export_trt.py --model yolov8n --imgsz 640 --batch 1

# This will:
# 1. Download YOLOv8n pretrained weights (COCO, person class)
# 2. Export to ONNX
# 3. Compile to TensorRT engine for the Orin Nano's GPU
# Output: /app/models/yolov8n_person.trt

# Expected time: 5-15 minutes on first run
# Check output file exists:
ls -lh /app/models/yolov8n_person.trt
```

The export only needs to be done once. The engine file is saved inside the container's
persistent volume and survives container restarts.

**Expected performance on Orin Nano (8 GB):**
- YOLOv8n: ~25–40 FPS at 640×640 input
- YOLOv8s: ~15–25 FPS (higher accuracy, use if FPS permits)
- Target: ≥15 FPS minimum per PRD §6.1

### 2.8 Verify Companion Is Working

```bash
# Check WebSocket is listening
ss -tlnp | grep 8765

# Check RTSP server is running
ss -tlnp | grep 8554

# Check MAVLink connection to FC
docker logs dnhacks-platform-companion 2>&1 | grep -E "MAVLink|UART|serial"

# Try connecting from ground PC (see network.md for IP setup)
# Expected: Mission Planner or ground app connects and shows telemetry
```

---

## Part 3: Ground Control Center (Windows)

### 3.1 Prerequisites

- Windows 10/11 (64-bit)
- Node.js 20+ (download from nodejs.org)
- Git for Windows

### 3.2 Build and Install

```powershell
# From the repo root
scripts\setup-ground.ps1

# This installs Node deps, builds the Electron app, and produces an installer at:
# ground/dist/Drone Safety Platform Setup-<version>.exe
```

Or manually:

```powershell
cd ground
npm install
npm run build       # TypeScript compile
npm run electron:build   # Electron-builder → dist/
```

### 3.3 Running in Development (SITL mode)

```powershell
cd ground
npm run dev         # Starts Vite dev server + Electron
```

In the UI, go to **Settings**, ensure **SITL** is toggled ON and host is `localhost`.
The default ports (8765 control, 8554 video) should auto-connect to a running SITL stack.

See [network.md](network.md) for pointing the ground station at the real drone.

---

*Next: [network.md](network.md) for WiFi setup, then [runbook.md](runbook.md) for first flight.*
