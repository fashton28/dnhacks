"""Sim smoke test: Hub + ArduCopter SITL + Bridge fly the square fixture and come home.

Run:  uv run python scripts/smoke_flight.py [--fleet 1] [--mode fast] [--keep]
Exit code 0 on success. Prints the mission, the final DroneState and the realtime factor.
"""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "contracts" / "fixtures" / "flight_plan_square.json"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fleet", type=int, default=1)
    ap.add_argument("--speedup", type=float, default=5.0, help="ArduPilot SITL speedup")
    ap.add_argument("--port", type=int, default=8011)
    ap.add_argument("--keep", action="store_true", help="leave everything running after the flight")
    ap.add_argument("--timeout", type=float, default=240)
    ap.add_argument("--expect-frames", action="store_true", help="require evidence frames (needs a Renderer connected)")
    ap.add_argument("--renderer", action="store_true", help="start a headless Renderer (implies --expect-frames)")
    args = ap.parse_args()

    log_dir = ROOT / "scratch"
    log_dir.mkdir(exist_ok=True)
    hub_log = open(log_dir / "smoke_hub.log", "w")
    sim_log = open(log_dir / "smoke_sim.log", "w")
    env = {**os.environ, "ARGUS_SPEED_FACTOR": str(args.speedup)}
    hub = subprocess.Popen([sys.executable, "-m", "uvicorn", "hub.server:app", "--host", "0.0.0.0", "--port", str(args.port), "--log-level", "warning"],
                           cwd=ROOT, env=env, stdout=hub_log, stderr=subprocess.STDOUT)
    sim = subprocess.Popen([sys.executable, str(ROOT / "scripts" / "launch_sim.py"), "--fleet", str(args.fleet), "--speedup", str(args.speedup), "--hub-port", str(args.port), "--wipe", "--instance-base", "10"],
                           cwd=ROOT, env=env, stdout=sim_log, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{args.port}"
    renderer = None
    if args.renderer:
        args.expect_frames = True
        time.sleep(2)
        renderer = subprocess.Popen([sys.executable, str(ROOT / "scripts" / "headless_renderer.py"), "--hub", base], cwd=ROOT, stdout=open(log_dir / "smoke_renderer.log", "w"), stderr=subprocess.STDOUT)
    t0 = time.time()
    ok = False
    try:
        with httpx.Client(base_url=base, timeout=5) as c:
            print("[smoke] waiting for the drone to register ...", flush=True)
            while time.time() - t0 < 120:
                try:
                    drones = c.get("/drones").json()
                    if any(d["drone_id"] == "drone-1" and d["status"] != "offline" and d["lat"] != 0 for d in drones):
                        break
                except Exception:  # noqa: BLE001
                    pass
                time.sleep(0.5)
            else:
                print("[smoke] FAIL: drone-1 never connected", flush=True)
                return 2
            d0 = c.get("/drones/drone-1").json()
            print(f"[smoke] drone-1 registered after {time.time()-t0:.0f}s at {d0['lat']:.6f},{d0['lon']:.6f} alt {d0['alt']:.2f} status {d0['status']}", flush=True)
            plan = json.loads(FIX.read_text())
            r = c.post("/missions/fly", json={"plan": plan, "drone_id": "drone-1"})
            print("[smoke] fly ->", r.status_code, r.json().get("phase"), flush=True)
            t1 = time.time()
            last = ""
            while time.time() - t1 < args.timeout:
                m = c.get(f"/missions/{plan['mission_id']}").json()
                d = c.get("/drones/drone-1").json()
                line = f"phase={m['phase']} wp={m['next_waypoint']}/{len(plan['waypoints'])} alt={d['alt']:.1f} bat={d['battery_pct']:.1f} status={d['status']}"
                if line != last:
                    print(f"[smoke] {time.time()-t1:6.1f}s {line}", flush=True)
                    last = line
                if m["phase"] in ("complete", "failed", "aborted") and d["status"] == "idle":
                    break
                time.sleep(0.5)
            m = c.get(f"/missions/{plan['mission_id']}").json()
            d = c.get("/drones/drone-1").json()
            from contracts.site import distance_m
            home_dist = distance_m(d["lat"], d["lon"], d0["lat"], d0["lon"])
            print(f"[smoke] mission {m['phase']} evidence={len(m['evidence'])} error={m.get('error')}", flush=True)
            print(f"[smoke] final: status={d['status']} alt={d['alt']:.2f} dist_home={home_dist:.2f}m battery={d['battery_pct']:.1f}%", flush=True)
            ok = m["phase"] == "complete" and d["status"] == "idle" and d["alt"] < 0.5 and home_dist < 2.0
            if args.expect_frames:
                ok &= len(m["evidence"]) == len(plan["waypoints"])
                for ref in m["evidence"][:1]:
                    p = ROOT / ref
                    print(f"[smoke] evidence {ref}: {'ok' if p.exists() and p.stat().st_size > 1000 else 'MISSING'}", flush=True)
                    ok &= p.exists() and p.stat().st_size > 1000
            print("[smoke]", "PASS" if ok else "FAIL", flush=True)
        if args.keep:
            print("[smoke] --keep: leaving hub and sim running; Ctrl-C to stop", flush=True)
            sim.wait()
    finally:
        if not args.keep:
            for p in (sim, renderer, hub):
                if p is not None and p.poll() is None:
                    p.send_signal(signal.SIGINT)
            for p in (p for p in (sim, renderer, hub) if p is not None):
                try:
                    p.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    p.kill()
        print("[smoke] logs: scratch/smoke_hub.log scratch/smoke_sim.log", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
