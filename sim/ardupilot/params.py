"""Per-Drone ArduCopter SITL parameter files generated from the Site."""
from __future__ import annotations

import json
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent / "site" / "site.json"


def write_params(out: Path, sysid: int, fence_alt_max: float, fence_radius: float) -> Path:
    lines = [
        f"MAV_SYSID {sysid}",
        "ARMING_CHECK 1",
        "FENCE_ENABLE 1",
        "FENCE_TYPE 5",            # altitude max + polygon (the Bridge uploads the Site geofence at connect)
        f"FENCE_ALT_MAX {fence_alt_max}",
        f"FENCE_RADIUS {fence_radius}",
        "FENCE_ACTION 1",          # RTL on breach
        "FENCE_MARGIN 2",
        "RTL_ALT 2500",            # cm
        # Flight feel (this ArduPilot master renamed WPNAV_* to WP_* in SI units and ATC_SLEW_YAW to ATC_RATE_WPY_MAX;
        # the old names are silently ignored, which left the fleet on the 2.5 m/s^2 defaults). Guided velocity control,
        # which Manual Control uses, takes its speed and acceleration limits from these same WP_* values.
        "WP_SPD 8",                # m/s cruise: snappy Manual Control, still a small multirotor
        "WP_ACC 8",                # m/s^2: 5 m/s in about one second (jerk-limited by PSC_NE_JERK and ATC_ACC_R/P_MAX)
        "PSC_NE_JERK 20",          # m/s^3: default 5 spends most of the first second ramping the acceleration
        "ATC_ANGLE_MAX 45",        # deg: 30 caps horizontal acceleration at 5.7 m/s^2
        "WP_SPD_UP 3.5",           # m/s
        "WP_SPD_DN 2.5",           # m/s (default 1.5 capped the 2.5 m/s manual descent)
        "WP_ACC_Z 4",              # m/s^2 (default 1.0 took over two seconds to reach climb speed)
        "PSC_D_JERK 15",           # m/s^3
        "ATC_RATE_WPY_MAX 120",    # deg/s guided yaw slew (default 60 capped the 90 deg/s manual yaw)
        "ATC_ACC_Y_MAX 360",       # deg/s^2: full yaw rate in a quarter second
        "LAND_SPEED 50",
        "BATT_CAPACITY 15000",     # mAh: about 45 minutes of hover in the SITL battery model, so a demo does not run a Drone into its reserve
        "SIM_BATT_VOLTAGE 12.6",
        "SIM_BATT_CAP_AH 15.0",
        "BATT_LOW_MAH 3000",       # low battery failsafe at 20% remaining
        "BATT_FS_LOW_ACT 2",       # RTL on low battery
        "BATT_LOW_VOLT 0",         # capacity-based failsafe only, so the autopilot's failsafe matches the percent the Hub shows
        "BATT_CRT_VOLT 0",
        "BATT_FS_CRT_ACT 1",       # land when critically low
        "GPS_TYPE 1",
        "SIM_SPEEDUP 1",
        "LOG_DISARMED 0",
        "LOG_BACKEND_TYPE 0",
    ]
    out.write_text("\n".join(lines) + "\n")
    return out


def home_for(drone_id: str) -> tuple[float, float, float, float]:
    site = json.loads(SITE.read_text())
    d = next(f for f in site["fleet"] if f["drone_id"] == drone_id)
    return d["lat"], d["lon"], site["anchor"]["alt_msl"], 90.0  # yaw 90: facing east
