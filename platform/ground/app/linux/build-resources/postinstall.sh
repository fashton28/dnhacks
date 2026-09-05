#!/bin/sh
# Drone Safety Platform GCS — .deb/.rpm post-install (LINUX_PRD §5).
# Installs the gamepad udev rule so Manual Control can read controllers without
# root. The rule body is embedded here so it works regardless of where the
# package payload landed. Idempotent: safe to re-run on upgrade.
set -e

RULES_FILE=/etc/udev/rules.d/99-dnhacks-platform-input.rules

cat > "$RULES_FILE" <<'EOF'
# Drone Safety Platform — game-controller access for Manual Control (managed by package)
SUBSYSTEM=="input", ATTRS{idVendor}=="045e", TAG+="uaccess"
SUBSYSTEM=="input", ATTRS{idVendor}=="054c", TAG+="uaccess"
SUBSYSTEM=="input", ATTRS{idVendor}=="2dc8", TAG+="uaccess"
SUBSYSTEM=="input", ATTRS{idVendor}=="046d", TAG+="uaccess"
KERNEL=="js[0-9]*", TAG+="uaccess"
EOF

if command -v udevadm >/dev/null 2>&1; then
  udevadm control --reload-rules || true
  udevadm trigger || true
fi

echo "Drone Safety Platform: gamepad udev rule installed. Replug your controller if it is connected."
exit 0
