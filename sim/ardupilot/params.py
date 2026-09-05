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
        "WPNAV_SPEED 500",         # cm/s cruise
        "WPNAV_SPEED_UP 250",
        "WPNAV_SPEED_DN 150",
        "LAND_SPEED 50",
        "BATT_CAPACITY 5000",      # mAh, Mavic-like endurance with SIM_BATT settings
        "SIM_BATT_VOLTAGE 12.6",
        "SIM_BATT_CAP_AH 5.0",
        "BATT_LOW_MAH 1000",
        "BATT_FS_LOW_ACT 2",       # RTL on low battery
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
