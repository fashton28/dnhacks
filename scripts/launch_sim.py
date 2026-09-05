"""Launch the simulation: N ArduCopter SITL instances at the Site pads, one Bridge each, optionally the Hub.

Run:  uv run python scripts/launch_sim.py --fleet 3 [--hub-port 8000] [--with-hub] [--speedup 1]
Stop with Ctrl-C; everything is torn down together.
Requires an ArduPilot checkout with a built SITL (ARDUPILOT env var or ~/development/ardupilot).
"""
from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ARDUPILOT = Path(os.environ.get("ARDUPILOT", Path.home() / "development" / "ardupilot"))
RUN_DIR = ROOT / "scratch" / "sitl"


def sitl_binary() -> Path:
    for p in (ARDUPILOT / "build" / "sitl" / "bin" / "arducopter", ARDUPILOT / "build" / "sitl-arm64" / "bin" / "arducopter"):
        if p.exists():
            return p
    sys.exit(f"[launch] ArduCopter SITL binary not found under {ARDUPILOT}/build. Build it: cd {ARDUPILOT} && ./waf configure --board sitl && ./waf copter")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fleet", type=int, default=int(os.environ.get("FLEET", "3")))
    ap.add_argument("--hub-port", type=int, default=8000)
    ap.add_argument("--with-hub", action="store_true")
    ap.add_argument("--speedup", type=float, default=1.0)
    ap.add_argument("--wipe", action="store_true", help="wipe SITL eeprom so params start from defaults")
    ap.add_argument("--instance-base", type=int, default=0, help="first SITL instance number (ports 5760 + 10*instance)")
    args = ap.parse_args()

    sys.path.insert(0, str(ROOT))
    from sim.ardupilot.params import home_for, write_params

    subprocess.run([sys.executable, str(ROOT / "sim" / "site" / "gen_site.py"), "--fleet", str(args.fleet)], cwd=ROOT, check=True)
    binary = sitl_binary()
    procs: list[subprocess.Popen] = []
    hub_ws = f"ws://127.0.0.1:{args.hub_port}/ws/controller"

    def shutdown(*_):
        print("\n[launch] shutting down", flush=True)
        for p in reversed(procs):
            if p.poll() is None:
                p.terminate()
        deadline = time.time() + 8
        for p in procs:
            try:
                p.wait(timeout=max(0.1, deadline - time.time()))
            except subprocess.TimeoutExpired:
                p.kill()
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    if args.with_hub:
        procs.append(subprocess.Popen([sys.executable, "-m", "uvicorn", "hub.server:app", "--host", "0.0.0.0", "--port", str(args.hub_port), "--log-level", "warning"], cwd=ROOT))
        print(f"[launch] hub on http://127.0.0.1:{args.hub_port}", flush=True)

    import json
    site = json.loads((ROOT / "sim" / "site" / "site.json").read_text())
    fence_radius = site["limits"]["geofence_half"] * 1.5  # circle around each pad that covers the square (polygon comes later)
    for i in range(1, args.fleet + 1):
        drone_id = f"drone-{i}"
        inst = args.instance_base + i - 1
        rd = RUN_DIR / (drone_id if args.instance_base == 0 else f"{drone_id}-i{inst}")
        rd.mkdir(parents=True, exist_ok=True)
        params = write_params(rd / "argus.parm", sysid=i, fence_alt_max=site["limits"]["alt_ceiling_m"], fence_radius=fence_radius)
        lat, lon, alt, yaw = home_for(drone_id)
        cmd = [str(binary), "--model", "quad", f"--speedup={args.speedup}", f"-I{inst}", f"--home={lat},{lon},{alt},{yaw}",
               f"--defaults={ARDUPILOT / 'Tools/autotest/default_params/copter.parm'},{params}", f"--sysid={i}"]
        if args.wipe:
            cmd.append("-w")
        log = open(rd / "sitl.log", "w")
        procs.append(subprocess.Popen(cmd, cwd=rd, stdout=log, stderr=subprocess.STDOUT))
        print(f"[launch] {drone_id}: SITL instance {inst} at {lat:.6f},{lon:.6f} (tcp:127.0.0.1:{5760 + 10 * inst})", flush=True)

    time.sleep(2.0)
    for i in range(1, args.fleet + 1):
        drone_id = f"drone-{i}"
        port = 5760 + 10 * (args.instance_base + i - 1)
        procs.append(subprocess.Popen([sys.executable, "-m", "sim.bridge", "--id", drone_id, "--mavlink", f"tcp:127.0.0.1:{port}", "--hub", hub_ws], cwd=ROOT))
    print(f"[launch] {args.fleet} bridges started -> {hub_ws}", flush=True)

    while True:
        time.sleep(1)
        for p in procs:
            if p.poll() is not None and p.args[0] == str(binary):
                print("[launch] a SITL instance exited", flush=True)
                shutdown()


if __name__ == "__main__":
    main()
