# ============================================================================
# Drone Safety Platform -- Ground Station Setup (Windows)
# ----------------------------------------------------------------------------
# Idempotent bootstrap for the Windows development environment.
# Run once (and re-run any time after a clean checkout or dependency update).
#
# What it does
#   1. Verifies Node.js >= 20 is installed.
#   2. npm install  in ground/ui   (Vite + React)
#   3. npm install  in ground/app  (Electron)
#   4. Builds the UI (tsc + vite build) into ground/ui/dist
#   5. Prints next-step instructions.
#
# Usage (from repo root, or anywhere):
#   .\scripts\setup-ground.ps1
#
# Environment variables honoured:
#   EIS_SKIP_BUILD=1   -- install deps but skip the UI build (faster iterating)
# ============================================================================
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Write-Step { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK   { param([string]$msg) Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Fail { param([string]$msg) Write-Host "    [FAIL] $msg" -ForegroundColor Red; exit 1 }
function Write-Info { param([string]$msg) Write-Host "    $msg" -ForegroundColor Gray }

# ---------------------------------------------------------------------------
# 1. Node.js version check
# ---------------------------------------------------------------------------
Write-Step "Checking Node.js version (require >= 20)"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Fail "Node.js not found. Install from https://nodejs.org (LTS >= 20) then re-run."
}

$rawVersion = (node --version) -replace '^v', ''
$major = [int]($rawVersion.Split('.')[0])

if ($major -lt 20) {
    Write-Fail "Node.js $rawVersion is too old (need >= 20). Download from https://nodejs.org"
}
Write-OK "Node.js v$rawVersion"

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Fail "npm not found. It should ship with Node.js — re-install Node."
}
Write-OK "npm $(npm --version)"

# ---------------------------------------------------------------------------
# 2. npm install -- ground/ui
# ---------------------------------------------------------------------------
$UiDir = Join-Path $RepoRoot "ground\ui"
Write-Step "Installing ground/ui dependencies"

if (-not (Test-Path $UiDir)) {
    Write-Fail "ground/ui not found at $UiDir"
}

Push-Location $UiDir
try {
    npm install --prefer-offline
    Write-OK "ground/ui node_modules ready"
} finally {
    Pop-Location
}

# ---------------------------------------------------------------------------
# 3. npm install -- ground/app
# ---------------------------------------------------------------------------
$AppDir = Join-Path $RepoRoot "ground\app\windows"
Write-Step "Installing ground/app/windows dependencies"

if (-not (Test-Path $AppDir)) {
    Write-Fail "ground/app/windows not found at $AppDir"
}

Push-Location $AppDir
try {
    npm install --prefer-offline
    Write-OK "ground/app node_modules ready"
} finally {
    Pop-Location
}

# ---------------------------------------------------------------------------
# 4. Build the UI (unless skipped)
# ---------------------------------------------------------------------------
if ($env:EIS_SKIP_BUILD -eq "1") {
    Write-Info "EIS_SKIP_BUILD=1: skipping UI build."
} else {
    Write-Step "Building ground/ui (TypeScript typecheck + Vite build)"
    Push-Location $UiDir
    try {
        npm run build
        Write-OK "ground/ui built -> ground/ui/dist/"
    } finally {
        Pop-Location
    }
}

# ---------------------------------------------------------------------------
# 5. Next steps
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "============================================================" -ForegroundColor Yellow
Write-Host " Drone Safety Platform -- ground station ready!" -ForegroundColor Yellow
Write-Host "============================================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Dev mode (UI hot-reload + Electron):" -ForegroundColor White
Write-Host "    cd ground\app\windows" -ForegroundColor Cyan
Write-Host "    npm run dev" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Connect to SITL (run setup-sim.sh in WSL2 first):" -ForegroundColor White
Write-Host "    Copy .env.example -> .env and verify EIS_SITL=true" -ForegroundColor Cyan
Write-Host "    npm run dev   (in ground\app\windows)" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Build Windows installer:" -ForegroundColor White
Write-Host "    cd ground\app\windows && npm run dist" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Full acceptance e2e (WSL2):" -ForegroundColor White
Write-Host "    .\scripts\run-sim-e2e.ps1" -ForegroundColor Cyan
Write-Host ""
