# Simulation setup (macOS, Apple Silicon)

Every teammate runs the full simulation locally: ArduCopter SITL for flight, the Three.js Console for the environment.
About twenty minutes, most of it the ArduPilot build.

## 1. Tools

```bash
brew install uv
# Node 20+ with pnpm (nvm or brew install node pnpm)
```

## 2. Project

```bash
cd dnhacks
uv sync                      # Python 3.12 + all deps, including pymavlink and playwright
uv run playwright install chromium   # headless renderer (optional, for smoke tests)
cd console && pnpm install && pnpm build && cd ..
```

## 3. ArduPilot Copter SITL (native arm64)

```bash
cd ~/development
git clone --recurse-submodules --shallow-submodules --depth 1 https://github.com/ArduPilot/ardupilot.git
cd ardupilot
~/development/dnhacks/.venv/bin/python ./waf configure --board sitl
~/development/dnhacks/.venv/bin/python ./waf copter -j10
file build/sitl/bin/arducopter      # expect: Mach-O 64-bit executable arm64
```

The build takes two to five minutes.
It needs only Xcode command line tools; the `install-prereqs-mac.sh` script is not required for SITL.
If the checkout lives elsewhere, export `ARDUPILOT=/path/to/ardupilot`.

Check that it boots, gets an EKF position, arms and takes off (about 60 s wall at speedup 5):

```bash
uv run python scripts/sitl_diag.py 5
```

Fallback if the native build fails on a machine: run SITL in Docker with an arm64 image such as `Sitin/ardupilot-sitl-docker` and point the Bridge at its MAVLink TCP port.

## 4. Run everything

Terminal 1, the Hub (serves the Console at http://127.0.0.1:8000/console/):

```bash
make hub
```

Terminal 2, three ArduCopter SITLs with Bridges:

```bash
make sim FLEET=3
```

Or in one terminal: `make sim-all`.
Without ArduPilot, `make fake-fleet` gives protocol-identical fake Drones.

Console development with hot reload: `make console` (Vite on port 5173, talking to the Hub on 8000).

## 5. Smoke test

```bash
make smoke
```

Starts a Hub, one SITL and Bridge at speedup 5, flies the square fixture and asserts the Drone came home.
Add a headless Renderer for evidence frames: `uv run python scripts/headless_renderer.py --hub http://127.0.0.1:8011` in another terminal, then `--expect-frames`.

## Two front ends

Both are served by the Hub and driven by the same live feed.

- **Ground-control dashboard** (default): http://localhost:8000/ (also `/gcs/`).
  The team's React GCS from `platform/ground/ui`, connected through `HubDataProvider`: Fleet cards, Operations (Baseline, Detect change, Dispatch, Return home, Scenarios, Manual Control), MJPEG Drone video, situational map, instruments, Mission tab (Detections, MissionSpec, Safety Validator, Incident Report), event log, embedded World view.
  Build it with `cd platform/ground/ui && npm ci && npx vite build`; the Hub serves `platform/ground/ui/dist`.
- **ARGUS Console**: http://localhost:8000/console/.
  The Three.js World view, satellite Overview, Drone view with RGB/thermal/LiDAR, and the Renderer role that produces every camera frame.
  Keep one Console tab open (or run `scripts/headless_renderer.py`): without a Renderer there is no Drone video and no evidence frames.
  `?embed=1` shows only the World view (used by the dashboard's World view tab).

Hub endpoints added for the dashboard: `GET /drones/{id}/mjpeg` (multipart JPEG stream of the Drone view), `GET /overheads` (captured overhead images), `GET /autonomy`, `POST /detections/{id}/dispatch`, and `GET/POST /drones/{id}/camera` (vision mode rgb/thermal/lidar and field of view 20 to 110 degrees; the Renderer draws that Drone accordingly and the live feed publishes `camera` events).
Camera gimbal pitch is a Drone command: `POST /drones/{id}/command {type: look_at, pitch_deg}` from -30 (up) to 90 (straight down).

## How the simulation is wired

- `sim/site/gen_site.py` is the one source of Site numbers.
  It writes `site.json` (scene layout for the Renderer) and `site.geojson` (geofence, fences, no-fly zone, pads) together, and copies both into `console/public/`.
  Edit the generator, not the outputs.
- Each Drone is an ArduCopter SITL process (`-I<n>`, MAVLink on `tcp:127.0.0.1:5760 + 10n`) with parameters generated from the Site: system id, onboard fence altitude and radius, battery, RTL altitude.
- Each Bridge (`sim/bridge`) speaks MAVLink to its SITL and the controller protocol to the Hub.
  It waits for GPS fix and EKF position before switching to GUIDED, arming and taking off; ArduCopter refuses those earlier.
- The Renderer is the Console itself, connected to the Hub a second time under the `renderer` role.
  It draws Drone cameras and overhead images on request.
  `scripts/headless_renderer.py` runs the same page in headless Chromium.
- ArduCopter's EKF needs roughly 40 s of simulated time after boot before it will arm.
  Start the sim before you need to fly.
- At connect, each Bridge uploads the Site geofence from `site.geojson` as an ArduPilot polygon inclusion fence (`FENCE_TYPE 5`: altitude max plus polygon).
  A GUIDED destination outside it is refused by the autopilot itself, independent of the Hub's Safety Validator.
  The autopilot's last status text is carried in `DroneState.message` so the Console can show the refusal.
- `make smoke` starts a Hub, one SITL and Bridge at speedup 5 and a headless Renderer, flies the square fixture, and asserts the Drone came home with one evidence frame per waypoint.
