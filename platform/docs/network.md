# Drone Safety Platform — Network Setup

> Cross-references: [hardware.md](hardware.md) for WiFi hardware, [assembly.md](assembly.md)
> for physical connections, [flashing.md](flashing.md) for Jetson setup,
> [runbook.md](runbook.md) for commissioning, [operator-manual.md](operator-manual.md)
> for the Settings panel in the ground app.

---

## 1. Architecture Overview

```
                ┌─────────────────────────────────┐
                │     Jetson Orin Nano (drone)     │
                │  IP: 192.168.4.1 (AP mode)       │
                │  or  192.168.1.42 (router mode)  │
                │                                  │
                │  companion WebSocket :8765  ──────┼──→ Control + Telemetry
                │  mediamtx RTSP       :8554  ──────┼──→ Video stream
                │  mediamtx WebRTC/WHEP:8889  ──────┼──→ WebRTC video (alt)
                └──────────┬──────────────────────┘
                           │ WiFi 2.4/5 GHz
                ┌──────────┴──────────────────────┐
                │     Windows Ground PC             │
                │  Ground Control Center (Electron) │
                │  WebSocket client → :8765         │
                │  RTSP/WebRTC → :8554 / :8889      │
                └──────────────────────────────────┘
```

There are two network topology options. Choose one:

| Option | Best For |
|--------|---------|
| **A: Jetson as WiFi AP** | No router needed; direct connection; simplest for field use |
| **B: Shared LAN (dedicated router)** | More reliable; both devices on a local router |

---

## 2. Option A — Jetson as WiFi Access Point (Recommended for Field Use)

The Jetson creates its own WiFi network. The ground PC connects to it directly.

### 2.1 Configure WiFi AP on the Jetson

```bash
# On the Jetson (via HDMI+keyboard or SSH over Ethernet during setup)

# Install NetworkManager (if not already present)
sudo apt-get install -y network-manager

# List available WiFi interfaces
nmcli device status
# Look for wlan0 or wlp* (the internal Intel 8265 or USB dongle)

# Create a WiFi hotspot named "dnhacks-platform"
sudo nmcli con add type wifi ifname wlan0 con-name "dnhacks-platform-AP" \
    ssid "dnhacks-platform" \
    mode ap \
    ipv4.method shared \
    ipv4.addresses 192.168.4.1/24 \
    wifi-sec.key-mgmt wpa-psk \
    wifi-sec.psk "dronepassword123"

# Activate it
sudo nmcli con up "dnhacks-platform-AP"

# Make it auto-start on boot
sudo nmcli con modify "dnhacks-platform-AP" connection.autoconnect yes
```

**Important:** Use a strong WPA2 passphrase. Replace `"dronepassword123"` with a secure password.

After this:
- Jetson WiFi IP: **192.168.4.1**
- Ground PC (connected to "dnhacks-platform" network): auto-assigned **192.168.4.2–254** by DHCP

### 2.2 Set Static IP on Jetson (AP Mode)

Already set above (`ipv4.addresses 192.168.4.1/24`). The Jetson's IP is fixed at **192.168.4.1**.

### 2.3 Connect Ground PC to Jetson AP

1. On the Windows PC, open **WiFi** in the system tray.
2. Select network **"dnhacks-platform"** and enter the passphrase.
3. Verify connectivity: open Command Prompt → `ping 192.168.4.1`.

---

## 3. Option B — Both on a Dedicated WiFi Router (More Reliable)

Use a small travel router (GL.iNet MT300N-V2 or similar, see [hardware.md](hardware.md)).

### 3.1 Router Setup

1. Power the travel router from USB (5 V, connect to Jetson USB-A output or a USB BEC).
2. Configure the router with a static LAN subnet, e.g., **192.168.1.0/24**.
3. Set a reserved DHCP mapping for the Jetson's MAC address → **192.168.1.42**.
4. Connect both the Jetson and the ground PC to the router's WiFi SSID.

### 3.2 Jetson Static IP (Router Mode)

```bash
# On the Jetson: set static IP on the WiFi interface
sudo nmcli con modify "preconfigured" \
    ipv4.method manual \
    ipv4.addresses 192.168.1.42/24 \
    ipv4.gateway 192.168.1.1 \
    ipv4.dns "8.8.8.8"
sudo nmcli con up "preconfigured"
```

Verify: `ip addr show wlan0` should show `192.168.1.42`.

---

## 4. Port Reference

| Port | Protocol | Direction | Purpose |
|------|----------|-----------|---------|
| **8765** | WebSocket (TCP) | Ground → Jetson | Control commands + Telemetry/Tracking data |
| **8554** | RTSP (TCP/UDP) | Jetson → Ground | Live video stream (H.264, low latency) |
| **8889** | HTTP/WebRTC (WHEP) | Jetson → Ground | WebRTC video (alternative, lower latency) |
| 22 | SSH (TCP) | Ground → Jetson | Admin / troubleshooting (disable in production) |

### 4.1 Port Details

**WebSocket :8765** — The companion's control API. All JSON messages defined in
`ground/ui/src/contract/index.ts` flow through this port:
- Companion → Ground: `telemetry` (10 Hz), `tracking` (10 Hz), `statusText`, `ack`
- Ground → Companion: `command` (event-driven), `manualInput` (20–50 Hz, fire-and-forget)

**RTSP :8554** — Served by `mediamtx` inside the companion container. The full URL is:
```
rtsp://<jetson-ip>:8554/stream
```

**WebRTC/WHEP :8889** — Also served by mediamtx. Useful for browser or WebRTC-native clients:
```
http://<jetson-ip>:8889/stream/whep
```

The ground control center uses the RTSP URL by default (configurable in Settings).
mediamtx handles the RTSP→WebRTC bridge internally if WebRTC is chosen.

---

## 5. Firewall Configuration

### 5.1 Jetson Firewall (UFW)

```bash
# On the Jetson
sudo apt-get install -y ufw

# Allow only necessary ports
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 8765/tcp   # WebSocket control
sudo ufw allow 8554/tcp   # RTSP
sudo ufw allow 8554/udp   # RTSP RTP data
sudo ufw allow 8889/tcp   # WebRTC WHEP
sudo ufw allow 22/tcp     # SSH (for admin; remove in production)
sudo ufw enable
sudo ufw status
```

### 5.2 Windows Firewall (Ground PC)

The ground Electron app connects **outbound** to the Jetson — Windows firewall does not
block outbound by default. However, if you use a SiK telemetry radio and run Mission
Planner alongside the ground app, you may need to allow Mission Planner through the
Windows firewall:

1. Open **Windows Defender Firewall** → **Allow an app or feature through Windows
   Defender Firewall**.
2. Find **Mission Planner** (or add it manually) and allow both Private and Public networks.
3. The Drone Safety Platform Electron app should be auto-allowed when first run; if it prompts
   for firewall access, click **Allow Access**.

---

## 6. RTSP → WebRTC Bridge (mediamtx)

The companion container includes **mediamtx** (formerly rtsp-simple-server), an open-source
media server that:
1. Receives the H.264 RTSP stream from the GStreamer pipeline inside the companion.
2. Re-serves it as RTSP on port 8554.
3. Optionally transcodes / re-streams it as WebRTC (WHEP) on port 8889.

```
GStreamer pipeline (Jetson)
  → nvv4l2encoder (hardware H.264)
  → appsink / RTSP sink
      → mediamtx (port 8554)
           ├── RTSP consumers (MissionPlanner, VLC, Electron ground app)
           └── WebRTC/WHEP (port 8889) → Browser / WebRTC consumer
```

**Low-latency tuning in mediamtx config** (`companion/config/mediamtx.yml`):

```yaml
rtspAddress: :8554
webrtcAddress: :8889
paths:
  stream:
    source: publisher
    maxReaders: 10
    readBufferCount: 16
```

The GStreamer pipeline uses `rtspclientsink` or sends to mediamtx directly. See
`companion/config/gstreamer.yaml` for the exact pipeline configuration.

---

## 7. Pointing the Ground Station at the Drone

### 7.1 Open Settings in the Ground App

In the Drone Safety Platform ground control center:
1. Click the **Settings gear icon** (top-right of status bar).
2. The Settings modal opens.

### 7.2 Connection Configuration

Fill in these fields (example for AP mode):

| Field | Value (AP Mode) | Value (Router Mode) | Notes |
|-------|----------------|---------------------|-------|
| **Host / Jetson IP** | `192.168.4.1` | `192.168.1.42` | Enter without `http://` or port |
| **Control port** | `8765` | `8765` | Default; do not change unless you changed the companion config |
| **Video URL** | `rtsp://192.168.4.1:8554/stream` | `rtsp://192.168.1.42:8554/stream` | Full RTSP URL including stream path |
| **SITL toggle** | OFF | OFF | Must be OFF for live drone; ON for SITL testing |

After entering settings, the app automatically reconnects. The status bar should change
from "Disconnected" (red) to "Connecting" (amber pulse) then "Connected" (green).

### 7.3 SITL Mode Settings

For simulation (no hardware), set:

| Field | Value |
|-------|-------|
| **Host / Jetson IP** | `sitl` or `localhost` |
| **Control port** | `8765` |
| **Video URL** | ` ` (empty — the mock data source renders a simulated scene) |
| **SITL toggle** | **ON** |

### 7.4 Verify Connection

After changing settings:

1. **Status Bar** should show green "Connected" pill.
2. **Battery Gauge** (status bar) should show a value (not —).
3. **GPS** (status bar) should show satellite count.
4. **Mode** label should show the current FC mode (e.g., LOITER).
5. **Video panel** (centre) should show the live camera feed or, in SITL mode,
   the animated mock scene.

If it stays on "Connecting":
- Ping the Jetson IP from a command prompt.
- Check that the companion container is running (`docker ps` on Jetson).
- Check that port 8765 is listening (`ss -tlnp | grep 8765` on Jetson).
- Check Windows Firewall is not blocking the Electron app.

---

## 8. SiK Telemetry Radio Link (Optional)

If you installed a SiK 433/915 MHz radio pair (see [hardware.md](hardware.md)):

1. **Air unit** connects to the FC's UART4 (wired per [assembly.md](assembly.md)).
2. **Ground unit** connects to the Windows PC via USB → appears as a COM port.
3. Open Mission Planner → **COMM LINKS** → Add link → Serial → select the COM port
   at 57600 baud.
4. This provides a direct MAVLink fallback link that works even if WiFi is down.
5. The companion relays MAVLink over the WebSocket simultaneously — the SiK is
   an independent parallel channel.

**Configure matching baud rates:**
- SiK radio default baud: 57600 (changeable via SiK firmware tools)
- ArduPilot: `SERIAL4_BAUD = 57` (match)
- SiK radios must be in the same NetID (default 25) and on the same frequency band.

---

## 9. Network Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Can ping Jetson but WebSocket fails | Port 8765 not listening | `docker ps`, check container is running |
| WebSocket connects but no telemetry | UART not connected or wrong baud | Check FC UART wiring, `SERIAL3_BAUD` param |
| Video URL times out | mediamtx not running or wrong URL | Check `/stream` path, check `docker logs` |
| IP unreachable | Not on same network | Verify WiFi SSID, check IP assignment |
| SITL mode shows "error" | SITL stack not running on localhost | Run `make sim` first |
| High video latency | Bitrate or buffer settings | Reduce bitrate in `companion/config/gstreamer.yaml` |

---

*Next: [runbook.md](runbook.md) for commissioning and first flight.*
