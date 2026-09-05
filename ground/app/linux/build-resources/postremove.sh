#!/bin/sh
# Eye in the Sky GCS — .deb/.rpm post-remove: drop the gamepad udev rule.
set -e

RULES_FILE=/etc/udev/rules.d/99-eyeinthesky-input.rules
rm -f "$RULES_FILE"

if command -v udevadm >/dev/null 2>&1; then
  udevadm control --reload-rules || true
fi
exit 0
