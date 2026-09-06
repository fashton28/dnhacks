"""Per-Drone ArduCopter SITL parameter files generated from the Site."""
from __future__ import annotations

import json
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent / "site" / "site.json"


def write_params(out: Path, sysid: int, fence_alt_max: float, fence_radius: float) -> Path:
    lines = [
        f"SYSID_THISMAV {sysid}",
        "ARMING_CHECK 1",
        "FENCE_ENABLE 1",
        "FENCE_TYPE 5",            # altitude max + polygon (the Bridge uploads the Site geofence at connect)
        f"FENCE_ALT_MAX {fence_alt_max}",
        f"FENCE_RADIUS {fence_radius}",
        "FENCE_ACTION 1",          # RTL on breach
        "FENCE_MARGIN 2",
        "RTL_ALT 2500",            # cm
        "WPNAV_SPEED 800",         # cm/s cruise: snappy Manual Control, still a small multirotor
        "WPNAV_SPEED_UP 350",
        "WPNAV_ACCEL 400",         # cm/s^2: full speed in about two seconds
        "WPNAV_SPEED_DN 250",
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
