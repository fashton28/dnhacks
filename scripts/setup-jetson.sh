#!/usr/bin/env bash
# ============================================================================
# Eye in the Sky -- Jetson Orin Nano Setup
# ----------------------------------------------------------------------------
# Run THIS SCRIPT on the Jetson itself (or over SSH).
# Idempotent: safe to re-run after firmware/code updates.
#
# What it does
#   1. Checks Docker is installed (requires JetPack 6.x / L4T 36.x).
#   2. Builds the companion Docker image from companion/Dockerfile.
#   3. Installs + enables the companion systemd service.
#   4. Prints the TensorRT export step (must be run once on-device).
#
# Pinned versions (update these when bumping):
#   JetPack target : 6.0  (L4T 36.2.0, CUDA 12.2)
#   Image name     : eis-companion:latest
#   Service file   : companion/systemd/eis-companion.service
#
# Usage (on the Jetson):
#   bash scripts/setup-jetson.sh
#
# Remote usage (from Windows/Linux dev machine):
#   scp -r . jetson@<jetson-ip>:~/eyeinthesky
#   ssh jetson@<jetson-ip> "bash ~/eyeinthesky/scripts/setup-jetson.sh"
# ============================================================================
set -euo pipefail
IFS=$'\n\t'

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

IMAGE_NAME="eis-companion"
IMAGE_TAG="latest"
SERVICE_NAME="eis-companion"
SERVICE_SRC="$REPO_ROOT/companion/systemd/eis-companion.service"
SERVICE_DEST="/etc/systemd/system/eis-companion.service"

step() { echo; echo "==> $*"; }
ok()   { echo "    [OK] $*"; }
info() { echo "    $*"; }
warn() { echo "    [WARN] $*" >&2; }

# ---------------------------------------------------------------------------
# 1. Docker check
# ---------------------------------------------------------------------------
step "Checking Docker"

if ! command -v docker &>/dev/null; then
    cat >&2 <<'EOF'
ERROR: Docker not found.

On Jetson with JetPack 6.x, install Docker via:
    sudo apt-get update
    sudo apt-get install -y docker.io nvidia-container-toolkit
    sudo systemctl enable --now docker
    sudo usermod -aG docker $USER
    # Log out and back in, or:  newgrp docker

The official JetPack SDK Manager also installs Docker.
EOF
    exit 1
fi

DOCKER_VERSION="$(docker --version | grep -oP '\d+\.\d+\.\d+')"
ok "Docker $DOCKER_VERSION"

# Check nvidia-container-toolkit (needed for GPU access inside the container)
if ! docker run --rm --gpus all --entrypoint "" nvcr.io/nvidia/l4t-base:36.2.0 true 2>/dev/null; then
    warn "GPU access test failed. If nvidia-container-toolkit is not installed:"
    warn "  sudo apt-get install -y nvidia-container-toolkit"
    warn "  sudo systemctl restart docker"
    warn "Continuing anyway -- image build will succeed; GPU only needed at runtime."
fi

# ---------------------------------------------------------------------------
# 2. Build companion Docker image
# ---------------------------------------------------------------------------
step "Building companion Docker image ($IMAGE_NAME:$IMAGE_TAG)"
info "Context: $REPO_ROOT"
info "Dockerfile: companion/Dockerfile"
info "This may take 5-15 min on first build (downloading L4T base + wheels)."
info "Subsequent rebuilds are fast thanks to layer caching."

DOCKERFILE="$REPO_ROOT/companion/Dockerfile"
if [[ ! -f "$DOCKERFILE" ]]; then
    cat >&2 <<EOF
ERROR: companion/Dockerfile not found at $DOCKERFILE.
The companion packaging agent should have created it. Check the repo.
EOF
    exit 1
fi

docker build \
    --tag "$IMAGE_NAME:$IMAGE_TAG" \
    --file "$DOCKERFILE" \
    "$REPO_ROOT"

ok "Image built: $IMAGE_NAME:$IMAGE_TAG"

# ---------------------------------------------------------------------------
# 3. Install + enable systemd service
# ---------------------------------------------------------------------------
step "Installing systemd service ($SERVICE_NAME)"

if [[ ! -f "$SERVICE_SRC" ]]; then
    cat >&2 <<EOF
ERROR: systemd service file not found at $SERVICE_SRC.
The companion packaging agent should have created it. Check the repo.
EOF
    exit 1
fi

# Copy the service file (requires root)
sudo cp "$SERVICE_SRC" "$SERVICE_DEST"
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"

ok "Service installed and enabled: $SERVICE_DEST"
info "The service will start on next boot. To start now:"
info "  sudo systemctl start $SERVICE_NAME"
info "  sudo journalctl -fu $SERVICE_NAME   # follow logs"

# Check if service is currently running; if so, restart to pick up new image
if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
    step "Restarting $SERVICE_NAME (new image deployed)"
    sudo systemctl restart "$SERVICE_NAME"
    ok "Service restarted"
fi

# ---------------------------------------------------------------------------
# 4. TensorRT engine export
# ---------------------------------------------------------------------------
echo
echo "============================================================"
echo " TensorRT model export (REQUIRED once per Jetson)"
echo "============================================================"
echo
echo "  The person-detector runs as a TensorRT engine for maximum speed."
echo "  The export must be done ON THIS JETSON (engines are device-specific)."
echo
echo "  Run this once after the image is built:"
echo
echo "    # Download pretrained YOLOv11n weights (if not already in companion/weights/):"
echo "    mkdir -p $REPO_ROOT/companion/weights"
echo "    cd $REPO_ROOT/companion/weights"
echo "    wget -nc https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n.pt"
echo
echo "    # Export to TensorRT inside the container:"
echo "    docker run --rm --gpus all \\"
echo "        -v $REPO_ROOT/companion/weights:/app/weights \\"
echo "        $IMAGE_NAME:$IMAGE_TAG \\"
echo "        python -m eis_companion.vision.export_trt \\"
echo "            --model /app/weights/yolo11n.pt \\"
echo "            --output /app/weights/yolo11n.engine"
echo
echo "  This produces companion/weights/yolo11n.engine (committed to .gitignore --"
echo "  engines are device-specific and must not be committed to the repo)."
echo
echo "  After export, update companion/config/default.yaml:"
echo "    engine_path: /app/weights/yolo11n.engine"
echo

# ---------------------------------------------------------------------------
# 5. Network / config reminder
# ---------------------------------------------------------------------------
echo "============================================================"
echo " Configuration reminder"
echo "============================================================"
echo
echo "  1. Edit companion/config/default.yaml (or use .env) to set:"
echo "       mav_url: /dev/ttyTHS1   # FC UART"
echo "       camera_source: csi       # or v4l2 for USB camera"
echo "       ws_port: 8765"
echo "       rtsp_port: 8554"
echo
echo "  2. Set the Jetson static IP (see docs/network.md)."
echo "     Default: 192.168.1.42"
echo
echo "  3. On the Windows ground station, update .env:"
echo "       EIS_HOST=192.168.1.42"
echo "       EIS_SITL=false"
echo
echo "  4. Start the service:"
echo "       sudo systemctl start $SERVICE_NAME"
echo "       sudo journalctl -fu $SERVICE_NAME"
echo
echo "  See docs/runbook.md for the full commissioning checklist."
echo
