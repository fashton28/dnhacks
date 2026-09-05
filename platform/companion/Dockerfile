# ============================================================================
# Drone Safety Platform -- COMPANION container for the NVIDIA Jetson Orin Nano.
# ----------------------------------------------------------------------------
# Base: dusty-nv's L4T PyTorch image for JetPack 6 (CUDA + cuDNN + TensorRT +
# torch/torchvision already built for the Orin's GPU). Pinned by digest-able
# tag so the build is reproducible. The Orin Nano runs JetPack 6.x (L4T r36.x);
# match this tag to your flashed JetPack (see docs/flashing.md).
#
# Why this base: torch + torchvision + TensorRT are JetPack-provided and must
# NOT come from pip (a pip wheel is the wrong, non-CUDA build). So we install
# ONLY the pure-Python deps + ultralytics WITHOUT its torch dependency, letting
# the image's system torch/TensorRT satisfy the GPU stack (PRD 6.1 / packaging).
#
# Build (on the Jetson, or via buildx for linux/arm64):
#   docker build -t eis-companion:latest companion/
# Run (host networking for MAVLink UDP + the control WS + RTSP/WebRTC):
#   docker run --rm -it --runtime nvidia --network host \
#       --device /dev/ttyTHS1 \
#       -v /path/to/weights:/app/weights \
#       -e EIS_CONFIG=config/default.yaml \
#       eis-companion:latest
# ============================================================================

# JetPack 6 / L4T r36 PyTorch base (arm64). Pin to your flashed JetPack.
ARG L4T_BASE=dustynv/l4t-pytorch:r36.2.0
FROM ${L4T_BASE}

LABEL org.opencontainers.image.title="eis-companion" \
      org.opencontainers.image.description="Drone Safety Platform Jetson companion (person-following drone)" \
      org.opencontainers.image.source="https://example.invalid/drone-safety-platform"

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    EIS_CONFIG=config/default.yaml

# --- OS deps: GStreamer (camera + RTSP publish) + mediamtx runtime ----------
# GStreamer plugins cover nvarguscamerasrc (from the L4T base), v4l2, x264, and
# rtspclientsink (rtsp plugin). mediamtx is fetched as a static arm64 binary.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3-pip \
        gstreamer1.0-tools \
        gstreamer1.0-plugins-base \
        gstreamer1.0-plugins-good \
        gstreamer1.0-plugins-bad \
        gstreamer1.0-plugins-ugly \
        gstreamer1.0-libav \
        curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# --- mediamtx (RTSP 8554 + WebRTC/WHEP 8889) static binary, pinned ----------
ARG MEDIAMTX_VERSION=1.8.2
RUN curl -fsSL \
      "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_arm64v8.tar.gz" \
      -o /tmp/mediamtx.tgz \
    && tar -xzf /tmp/mediamtx.tgz -C /usr/local/bin mediamtx \
    && rm -f /tmp/mediamtx.tgz \
    && chmod +x /usr/local/bin/mediamtx

WORKDIR /app

# --- Python deps -----------------------------------------------------------
# Install the PINNED pure-Python core first (layer-cached). We deliberately do
# NOT pip-install torch/torchvision/TensorRT -- they are JetPack-provided in the
# base image. ultralytics is installed WITHOUT deps so it cannot pull a non-CUDA
# torch over the system one.
COPY requirements.txt /app/requirements.txt
RUN python3 -m pip install --upgrade pip \
    && python3 -m pip install \
        pymavlink==2.4.41 \
        websockets==12.0 \
        numpy==1.26.4 \
        pyyaml==6.0.1 \
        python-dotenv==1.0.1 \
    && python3 -m pip install --no-deps ultralytics==8.2.0

# --- application -----------------------------------------------------------
COPY pyproject.toml /app/pyproject.toml
COPY config /app/config
COPY src /app/src
RUN python3 -m pip install --no-deps -e .

# control WS (8765), RTSP (8554), WebRTC (8889), WebRTC UDP mux (8189)
EXPOSE 8765 8554 8889 8189/udp

# Default to the safe state on startup; the orchestrator holds until commanded.
CMD ["python3", "-m", "eis_companion.app"]
