#!/usr/bin/env bash
# ============================================================================
# Drone Safety Platform -- Jetson Orin Nano commissioning
# ----------------------------------------------------------------------------
# Run THIS SCRIPT ON THE JETSON (directly, or over SSH). Idempotent: re-run it
# after any firmware or code update.
#
# STAGES
#   1  Docker must be present (JetPack 6.x / L4T 36.x ships it), and GPU
#      passthrough is probed -- a failed probe warns, it does not stop the
#      build, because the GPU is only needed at RUN time.
#   2  Build the companion image from companion/Dockerfile with the repo as
#      the build context.
#   3  Install + enable the systemd unit, restarting it when it was already
#      running so the new image is picked up.
#   4  Print the TensorRT export recipe (engines are device-specific: they are
#      built here, never committed).
#   5  Print the network/config reminders.
#
# USAGE
#   bash scripts/setup-jetson.sh
#   bash scripts/setup-jetson.sh --check   # report state, build/install nothing
#   bash scripts/setup-jetson.sh --help
#
# REMOTE USAGE (from a Windows/Linux dev machine)
#   scp -r . jetson@<jetson-ip>:~/dnhacks-platform
#   ssh jetson@<jetson-ip> "bash ~/dnhacks-platform/scripts/setup-jetson.sh"
#
# PINNED (bump here, nowhere else)
#   JetPack target : 6.0  (L4T 36.2.0, CUDA 12.2)
#   Image          : eis-companion:latest
#   Unit           : companion/systemd/eis-companion.service
#
# EXIT CODES
#   0  image built, service installed (or --check/--help)
#   1  a prerequisite is missing: Docker, the Dockerfile, or the unit file
# ============================================================================
set -euo pipefail
IFS=$'\n\t'

readonly IMAGE_NAME="eis-companion"
readonly IMAGE_TAG="latest"
readonly SERVICE_NAME="eis-companion"
readonly SERVICE_DEST="/etc/systemd/system/eis-companion.service"
readonly L4T_PROBE_IMAGE="nvcr.io/nvidia/l4t-base:36.2.0"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DOCKERFILE="$REPO_ROOT/companion/Dockerfile"
SERVICE_SRC="$REPO_ROOT/companion/systemd/eis-companion.service"
WEIGHTS_DIR="$REPO_ROOT/companion/weights"

CHECK_ONLY=0

step() { echo; echo "==> $*"; }
ok()   { echo "    [OK] $*"; }
info() { echo "    $*"; }
warn() { echo "    [WARN] $*" >&2; }
miss() { echo "    [--] $*"; }

die() {
    echo "ERROR: $*" >&2
    exit 1
}

usage() {
    cat <<EOF
Drone Safety Platform -- Jetson commissioning

  bash scripts/setup-jetson.sh [--check | --help]

    --check   report Docker / Dockerfile / unit-file state; build nothing
    --help    this text

Builds $IMAGE_NAME:$IMAGE_TAG from companion/Dockerfile (context: the repo root)
and installs companion/systemd/eis-companion.service to $SERVICE_DEST.

Exit codes: 0 done / 1 missing prerequisite
EOF
}

# ---------------------------------------------------------------------------
# Stage 1 -- Docker
# ---------------------------------------------------------------------------
docker_install_advice() {
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
}

docker_version() {
    # Portable dotted-triple extraction: `grep -oP` is GNU-only.
    docker --version 2>/dev/null \
        | sed -n 's/.*[^0-9]\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' \
        | head -n1
}

require_docker() {
    step "Checking Docker"
    if ! command -v docker >/dev/null 2>&1; then
        docker_install_advice
        exit 1
    fi
    ok "Docker $(docker_version)"
}

probe_gpu_passthrough() {
    # Needed at runtime, not at build time: warn and carry on.
    if docker run --rm --gpus all --entrypoint "" "$L4T_PROBE_IMAGE" true 2>/dev/null; then
        ok "GPU passthrough works (--gpus all)"
        return 0
    fi
    warn "GPU access test failed. If nvidia-container-toolkit is not installed:"
    warn "  sudo apt-get install -y nvidia-container-toolkit"
    warn "  sudo systemctl restart docker"
    warn "Continuing anyway -- image build will succeed; GPU only needed at runtime."
    return 0
}

# ---------------------------------------------------------------------------
# Stage 2 -- image
# ---------------------------------------------------------------------------
build_image() {
    step "Building companion Docker image ($IMAGE_NAME:$IMAGE_TAG)"
    info "Context: $REPO_ROOT"
    info "Dockerfile: companion/Dockerfile"
    info "This may take 5-15 min on first build (downloading L4T base + wheels)."
    info "Subsequent rebuilds are fast thanks to layer caching."

    [[ -f "$DOCKERFILE" ]] || die \
        "companion/Dockerfile not found at $DOCKERFILE. The companion packaging agent should have created it. Check the repo."

    docker build \
        --tag "$IMAGE_NAME:$IMAGE_TAG" \
        --file "$DOCKERFILE" \
        "$REPO_ROOT"
    ok "Image built: $IMAGE_NAME:$IMAGE_TAG"
}

# ---------------------------------------------------------------------------
# Stage 3 -- systemd unit
# ---------------------------------------------------------------------------
install_service() {
    step "Installing systemd service ($SERVICE_NAME)"

    [[ -f "$SERVICE_SRC" ]] || die \
        "systemd service file not found at $SERVICE_SRC. The companion packaging agent should have created it. Check the repo."

    # Note whether it is running BEFORE enabling, so the restart below is
    # "redeploy the image into a live service", not "start it for the first
    # time on a box the operator has not configured yet".
    local was_active=0
    if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
        was_active=1
    fi

    sudo cp "$SERVICE_SRC" "$SERVICE_DEST"
    sudo systemctl daemon-reload
    sudo systemctl enable "$SERVICE_NAME"
    ok "Service installed and enabled: $SERVICE_DEST"

    info "The service will start on next boot. To start now:"
    info "  sudo systemctl start $SERVICE_NAME"
    info "  sudo journalctl -fu $SERVICE_NAME   # follow logs"

    if (( was_active == 1 )); then
        step "Restarting $SERVICE_NAME (new image deployed)"
        sudo systemctl restart "$SERVICE_NAME"
        ok "Service restarted"
    fi
}

# ---------------------------------------------------------------------------
# Stages 4 + 5 -- what the operator still has to do by hand
# ---------------------------------------------------------------------------
print_tensorrt_recipe() {
    cat <<EOF

============================================================
 TensorRT model export (REQUIRED once per Jetson)
============================================================

  The person-detector runs as a TensorRT engine for maximum speed.
  The export must be done ON THIS JETSON (engines are device-specific).

  Run this once after the image is built:

    # Download pretrained YOLOv11n weights (if not already in companion/weights/):
    mkdir -p $WEIGHTS_DIR
    cd $WEIGHTS_DIR
    wget -nc https://github.com/ultralytics/assets/releases/download/v8.3.0/yolo11n.pt

    # Export to TensorRT inside the container:
    docker run --rm --gpus all \\
        -v $WEIGHTS_DIR:/app/weights \\
        $IMAGE_NAME:$IMAGE_TAG \\
        python -m eis_companion.vision.export_tensorrt \\
            --model /app/weights/yolo11n.pt \\
            --out /app/weights

  This produces companion/weights/yolo11n.engine (gitignored -- engines are
  device-specific and must not be committed to the repo).

  After export, update companion/config/default.yaml:
    engine_path: /app/weights/yolo11n.engine
EOF
}

print_config_reminder() {
    cat <<EOF

============================================================
 Configuration reminder
============================================================

  1. Edit companion/config/default.yaml (or use .env) to set:
       mav_url: /dev/ttyTHS1   # FC UART
       camera_source: csi       # or v4l2 for USB camera
       ws_port: 8765
       rtsp_port: 8554

  2. Set the Jetson static IP (see docs/network.md).
     Default: 192.168.1.42

  3. On the Windows ground station, update .env:
       EIS_HOST=192.168.1.42
       EIS_SITL=false

  4. Start the service:
       sudo systemctl start $SERVICE_NAME
       sudo journalctl -fu $SERVICE_NAME

  See docs/runbook.md for the full commissioning checklist.
EOF
}

# ---------------------------------------------------------------------------
# --check: report, change nothing, touch no sudo.
# ---------------------------------------------------------------------------
report_state() {
    step "Jetson report (--check: nothing will be built or installed)"

    if command -v docker >/dev/null 2>&1; then
        ok "docker: $(docker_version)"
    else
        miss "docker not on PATH"
    fi

    [[ -f "$DOCKERFILE" ]]   && ok "Dockerfile: $DOCKERFILE"     || miss "Dockerfile missing: $DOCKERFILE"
    [[ -f "$SERVICE_SRC" ]]  && ok "unit file: $SERVICE_SRC"     || miss "unit file missing: $SERVICE_SRC"
    [[ -f "$SERVICE_DEST" ]] && ok "installed unit: $SERVICE_DEST" || miss "not installed yet: $SERVICE_DEST"
    [[ -d "$WEIGHTS_DIR" ]]  && ok "weights dir: $WEIGHTS_DIR"   || miss "weights dir absent: $WEIGHTS_DIR"

    if command -v docker >/dev/null 2>&1 && \
       docker image inspect "$IMAGE_NAME:$IMAGE_TAG" >/dev/null 2>&1; then
        ok "image present: $IMAGE_NAME:$IMAGE_TAG"
    else
        miss "image not built: $IMAGE_NAME:$IMAGE_TAG"
    fi
    echo
}

main() {
    case "${1:-}" in
        -h|--help) usage; return 0 ;;
        --check)   CHECK_ONLY=1 ;;
        "")        ;;
        *)         usage >&2; echo "unknown option: $1" >&2; return 1 ;;
    esac

    if (( CHECK_ONLY == 1 )); then
        report_state
        return 0
    fi

    require_docker
    probe_gpu_passthrough
    build_image
    install_service
    print_tensorrt_recipe
    print_config_reminder
}

main "$@"
