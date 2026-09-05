"""Diagnostic: boot one ArduCopter SITL at the Site, watch GPS fix, EKF flags, prearm text, and try to arm + take off once ready."""
import os, subprocess, sys, time
from pathlib import Path

from pymavlink import mavutil

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from sim.ardupilot.params import home_for, write_params  # noqa: E402

AP = Path(os.environ.get("ARDUPILOT", Path.home() / "development/ardupilot"))
speedup = float(sys.argv[1]) if len(sys.argv) > 1 else 5.0
rd = ROOT / "scratch/sitl/diag"; rd.mkdir(parents=True, exist_ok=True)
params = write_params(rd / "argus.parm", 1, 60, 240)
lat, lon, alt, yaw = home_for("drone-1")
cmd = [str(AP / "build/sitl/bin/arducopter"), "--model", "quad", f"--speedup={speedup}", "-I0", f"--home={lat},{lon},{alt},{yaw}",
       f"--defaults={AP / 'Tools/autotest/default_params/copter.parm'},{params}", "-w"]
p = subprocess.Popen(cmd, cwd=rd, stdout=open(rd / "sitl.log", "w"), stderr=subprocess.STDOUT)
time.sleep(2)
m = mavutil.mavlink_connection("tcp:127.0.0.1:5760")
m.wait_heartbeat(timeout=60)
t0 = time.time()
print(f"heartbeat after {time.time()-t0:.1f}s sys={m.target_system}")
for mid, hz in ((24, 2), (193, 2), (33, 2), (0, 1)):
    m.mav.command_long_send(m.target_system, m.target_component, mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL, 0, mid, int(1e6 / hz), 0, 0, 0, 0, 0)
fix = ekf = None; armed = False; last_arm = 0; boot_ms = 0; tookoff = False; alt_rel = 0.0
mode_set = False
try:
    while time.time() - t0 < 150:
        msg = m.recv_match(blocking=True, timeout=1)
        if msg is None:
            continue
        t = msg.get_type()
        if t == "GPS_RAW_INT": fix = msg.fix_type
        elif t == "EKF_STATUS_REPORT": ekf = msg.flags
        elif t == "SYSTEM_TIME": boot_ms = msg.time_boot_ms
        elif t == "GLOBAL_POSITION_INT": alt_rel = msg.relative_alt / 1000
        elif t == "STATUSTEXT": print(f"  [{time.time()-t0:5.1f}s boot {boot_ms/1000:6.1f}s] AP: {msg.text}")
        elif t == "HEARTBEAT" and msg.get_srcComponent() == 1:
            armed = bool(msg.base_mode & 128)
            mode = mavutil.mode_string_v10(msg)
            mode_set = mode == "GUIDED"
        if int(time.time() - t0) % 5 == 0 and msg.get_type() == "HEARTBEAT" and msg.get_srcComponent() == 1:
            print(f"  [{time.time()-t0:5.1f}s boot {boot_ms/1000:6.1f}s] fix={fix} ekf=0x{(ekf or 0):03x} pos_abs={(bool((ekf or 0) & 16))} armed={armed} mode={mode} alt={alt_rel:.1f}")
        ready = fix is not None and fix >= 3 and ekf is not None and (ekf & 16)
        if ready and not mode_set and time.time() - last_arm > 1:
            last_arm = time.time()
            print(f"  [{time.time()-t0:5.1f}s] -> GUIDED")
            m.mav.set_mode_send(m.target_system, 1, m.mode_mapping()["GUIDED"])
            continue
        if ready and mode_set and not armed and time.time() - last_arm > 3:
            last_arm = time.time()
            print(f"  [{time.time()-t0:5.1f}s] -> arm")
            m.mav.command_long_send(m.target_system, m.target_component, mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM, 0, 1, 0, 0, 0, 0, 0, 0)
        if armed and mode_set and not tookoff:
            tookoff = True
            print(f"  [{time.time()-t0:5.1f}s] -> takeoff 10 m")
            m.mav.command_long_send(m.target_system, m.target_component, mavutil.mavlink.MAV_CMD_NAV_TAKEOFF, 0, 0, 0, 0, 0, 0, 0, 10)
        if tookoff and alt_rel > 9:
            print(f"  [{time.time()-t0:5.1f}s] reached {alt_rel:.1f} m: SUCCESS"); break
finally:
    p.terminate()
