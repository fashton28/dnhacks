# ============================================================================
# Drone Safety Platform -- top-level Makefile
# ----------------------------------------------------------------------------
# Delegates to the scripts/ directory, npm, and pytest. All targets are
# idempotent: safe to re-run at any time.
#
# Quickstart:
#   make setup    # first-time: install deps + build (Python venv + Node)
#   make sim      # start SITL + companion in the background
#   make e2e      # run full acceptance tests (starts/stops SITL + companion)
#   make lint     # ruff + eslint
#   make test     # pytest + npm typecheck
#
# Targets:
#   setup            -- set up all environments (calls setup-sim.sh)
#   setup-ground     -- Windows ground station only (delegates to PowerShell)
#   setup-ground-linux -- Linux ground station (Node deps + UI build)
#   setup-sim        -- Python venv + ArduPilot SITL (Linux/WSL2/macOS)
#   setup-jetson     -- Jetson Docker image + systemd (run on the Jetson)
#   sim              -- launch SITL + companion (foreground, Ctrl-C to stop)
#   e2e              -- full acceptance demo (SITL + companion + tests)
#   build-ground     -- build the shared UI + typecheck the Windows shell
#   build-ground-linux -- build the shared UI + typecheck the Linux shell
#   build-companion  -- (no-op for pure-Python; validates package install)
#   lint             -- ruff + pyflakes on companion; eslint on ground/ui
#   test             -- pytest companion/tests + npm typecheck on ground/ui
#   clean            -- remove build artefacts (dist, __pycache__, .venv cache)
# ============================================================================

SHELL := /bin/bash
.DEFAULT_GOAL := help

# Paths
REPO_ROOT := $(shell pwd)
COMPANION_DIR := $(REPO_ROOT)/companion
PLANNER_DIR   := $(REPO_ROOT)/ground/planner
UI_DIR        := $(REPO_ROOT)/ground/ui
APP_WIN_DIR   := $(REPO_ROOT)/ground/app/windows
APP_LINUX_DIR := $(REPO_ROOT)/ground/app/linux
VENV_PYTHON   := $(COMPANION_DIR)/.venv/bin/python
VENV_PIP      := $(COMPANION_DIR)/.venv/bin/pip

# Colours
CYAN  := \033[36m
RESET := \033[0m

.PHONY: help setup setup-ground setup-ground-linux setup-sim setup-jetson sim e2e \
        build-ground build-ground-linux check-ground-artefacts build-companion \
        lint test clean

# ---------------------------------------------------------------------------
help:
	@echo ""
	@echo "  $(CYAN)Drone Safety Platform$(RESET) — top-level Makefile"
	@echo ""
	@echo "  make setup            Set up all environments"
	@echo "  make setup-ground     Windows ground station (needs PowerShell)"
	@echo "  make setup-ground-linux  Linux ground station (Node deps + UI build)"
	@echo "  make setup-sim        Python venv + ArduPilot SITL"
	@echo "  make setup-jetson     Jetson Docker image + systemd (run on Jetson)"
	@echo "  make sim              Launch SITL + companion (Ctrl-C to stop)"
	@echo "  make e2e              Full acceptance demo (SITL + tests)"
	@echo "  make build-ground     Build UI + typecheck Windows shell"
	@echo "  make build-ground-linux  Build UI + typecheck Linux shell"
	@echo "  make build-companion  Validate companion package install"
	@echo "  make lint             ruff + eslint"
	@echo "  make test             pytest + npm typecheck"
	@echo "  make clean            Remove build artefacts"
	@echo ""

# ---------------------------------------------------------------------------
setup: setup-sim
	@echo "==> setup complete. Run 'make e2e' to prove the full loop."

setup-sim:
	@echo "==> Setting up SITL environment..."
	bash $(REPO_ROOT)/scripts/setup-sim.sh

setup-ground:
	@echo "==> Setting up Windows ground station..."
	@echo "    (This target must be run from PowerShell on Windows)"
	@echo "    PowerShell: .\\scripts\\setup-ground.ps1"
	@if command -v powershell.exe &>/dev/null; then \
	    powershell.exe -ExecutionPolicy Bypass -File "$(REPO_ROOT)/scripts/setup-ground.ps1"; \
	else \
	    echo "  Skipping: powershell.exe not available in this environment."; \
	fi

setup-ground-linux:
	@echo "==> Setting up Linux ground station..."
	bash $(REPO_ROOT)/scripts/setup-ground-linux.sh

setup-jetson:
	@echo "==> Setting up Jetson (run this on the Jetson itself)..."
	bash $(REPO_ROOT)/scripts/setup-jetson.sh

# ---------------------------------------------------------------------------
sim:
	@echo "==> Starting SITL + companion (Ctrl-C to stop both)..."
	@trap 'kill %2 %1 2>/dev/null || true' SIGINT SIGTERM; \
	    bash $(REPO_ROOT)/sim/run_sitl.sh & \
	    sleep 8 && \
	    EIS_CONFIG=$(REPO_ROOT)/companion/config/sitl.yaml \
	    EIS_CAMERA_SOURCE=mock \
	    $(VENV_PYTHON) -m eis_companion; \
	    wait

# ---------------------------------------------------------------------------
e2e:
	@echo "==> Running full acceptance e2e..."
	bash $(REPO_ROOT)/scripts/run-sim-e2e.sh

# ---------------------------------------------------------------------------
# The shell loads ground/planner/dist and dist-electron/main.js at RUNTIME and
# both are gitignored, so building only ground/ui leaves a tree that starts and
# then fails (FM-83 / FM-132). Build them in the order they are loaded, then
# assert the artefacts exist.
build-ground:
	@echo "==> Building ground/planner..."
	cd $(PLANNER_DIR) && npm run build
	@echo "==> Building ground/ui..."
	cd $(UI_DIR) && npm run build
	@echo "==> Building ground/app/windows Electron main/preload..."
	cd $(APP_WIN_DIR) && npm run build:electron
	@$(MAKE) --no-print-directory check-ground-artefacts APP_DIR=$(APP_WIN_DIR)

build-ground-linux:
	@echo "==> Building ground/planner..."
	cd $(PLANNER_DIR) && npm run build
	@echo "==> Building ground/ui..."
	cd $(UI_DIR) && npm run build
	@echo "==> Building ground/app/linux Electron main/preload..."
	cd $(APP_LINUX_DIR) && npm run build:electron
	@$(MAKE) --no-print-directory check-ground-artefacts APP_DIR=$(APP_LINUX_DIR)

# Every path below is loaded at runtime by something. APP_DIR is passed in.
check-ground-artefacts:
	@echo "==> Verifying built ground artefacts..."
	@for f in "$(PLANNER_DIR)/dist/index.js" "$(UI_DIR)/dist/index.html" \
	          "$(APP_DIR)/dist-electron/main.js" "$(APP_DIR)/dist-electron/preload.js"; do \
	    if [ ! -f "$$f" ]; then echo "    [FAIL] MISSING $$f"; exit 1; fi; \
	    echo "    [OK] $$f"; \
	done

build-companion:
	@echo "==> Validating companion package (pip install -e)..."
	$(VENV_PIP) install -e "$(COMPANION_DIR)[dev]" --quiet
	$(VENV_PYTHON) -c "import eis_companion; print('eis_companion OK')"

# ---------------------------------------------------------------------------
lint:
	@echo "==> Linting companion (ruff)..."
	$(VENV_PYTHON) -m ruff check $(COMPANION_DIR)/src $(COMPANION_DIR)/tests $(REPO_ROOT)/sim
	@echo "==> Linting ground/ui (eslint)..."
	cd $(UI_DIR) && npm run lint

test:
	@echo "==> Running companion unit tests (pytest)..."
	$(VENV_PYTHON) -m pytest $(COMPANION_DIR)/tests -v
	@echo "==> ground/planner tests (build + typecheck + vitest)..."
	cd $(PLANNER_DIR) && npm test
	@echo "==> ground/satellite tests..."
	cd $(REPO_ROOT)/ground/satellite && npm test
	@echo "==> ground/cues tests..."
	cd $(REPO_ROOT)/ground/cues && npm test
	@echo "==> ground/ui typecheck + tests..."
	cd $(UI_DIR) && npm run typecheck && npm test

# ---------------------------------------------------------------------------
clean:
	@echo "==> Cleaning build artefacts..."
	rm -rf $(UI_DIR)/dist $(UI_DIR)/node_modules/.cache
	rm -rf $(APP_WIN_DIR)/dist-electron $(APP_WIN_DIR)/dist-installer
	rm -rf $(APP_LINUX_DIR)/dist-electron $(APP_LINUX_DIR)/dist-installer
	find $(COMPANION_DIR) -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
	find $(COMPANION_DIR) -name "*.egg-info"  -type d -exec rm -rf {} + 2>/dev/null || true
	find $(REPO_ROOT)/sim -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
	@echo "==> Done."
