# ============================================================================
# Drone Safety Platform -- Ground Station Setup (Windows)
# ----------------------------------------------------------------------------
# Idempotent bootstrap for the Windows development environment.
# Run once (and re-run any time after a clean checkout or dependency update).
#
# What it does
#   1. Verifies Node.js >= 20 is installed.
#   2. npm install  in ground/planner  (deterministic planner + verifier)
#   3. npm install  in ground/ui       (Vite + React)
#   4. npm install  in ground/app      (Electron)
#   5. Builds ground/planner -> ground/planner/dist   (FM-83)
#   6. Builds the UI (tsc + vite build) into ground/ui/dist
#   7. Builds the Electron shell -> ground/app/windows/dist-electron  (FM-132)
#   8. Asserts every built artefact exists, then prints next steps.
#
# BUILD ORDER MATTERS. The Electron main process `require`s
# ground/planner/dist/index.js at runtime and package.json's `main` is
# dist-electron/main.js; both are gitignored, so a fresh clone has NEITHER
# until this script produces them. Before FM-83/FM-132 this script installed
# and built only ground/ui, so a fresh clone gave "Cannot find module
# dist-electron/main.js" at launch, or a "Planning failed" toast the moment the
# inspection button was pressed.
#
# Usage (from repo root, or anywhere):
#   .\scripts\setup-ground.ps1
#
# Environment variables honoured:
#   EIS_SKIP_BUILD=1   -- install deps but skip every build (faster iterating).
#                         The artefact assertions are skipped with it.
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
    Write-Fail "npm not found. It should ship with Node.js -- re-install Node."
}
Write-OK "npm $(npm --version)"

# ---------------------------------------------------------------------------
# 2. npm install -- ground/planner
#    The Electron main process loads ground/planner/dist at runtime; without
#    its node_modules there is nothing to build it with (FM-83).
# ---------------------------------------------------------------------------
$PlannerDir = Join-Path $RepoRoot "ground\planner"
Write-Step "Installing ground/planner dependencies"

if (-not (Test-Path $PlannerDir)) {
    Write-Fail "ground/planner not found at $PlannerDir"
}

Push-Location $PlannerDir
try {
    npm install --prefer-offline
    if ($LASTEXITCODE -ne 0) { Write-Fail "npm install failed in ground/planner" }
    Write-OK "ground/planner node_modules ready"
} finally {
    Pop-Location
}

# ---------------------------------------------------------------------------
# 3. npm install -- ground/ui
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
# 4. npm install -- ground/app
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
# 5-7. Build everything the shell loads at runtime (unless skipped)
#
# Order: planner -> ui -> electron. The shell's own TypeScript build does not
# depend on the other two, but the RUNTIME does, and building them in the order
# they are loaded makes a failure point at the thing that failed.
# ---------------------------------------------------------------------------
if ($env:EIS_SKIP_BUILD -eq "1") {
    Write-Info "EIS_SKIP_BUILD=1: skipping every build (planner, UI, Electron shell)."
    Write-Info "The ground station will NOT start until these are built."
} else {
    Write-Step "Building ground/planner (deterministic planner + verifier) -> dist/"
    Push-Location $PlannerDir
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { Write-Fail "ground/planner build failed" }
        Write-OK "ground/planner built -> ground/planner/dist/"
    } finally {
        Pop-Location
    }

    Write-Step "Building ground/ui (TypeScript typecheck + Vite build)"
    Push-Location $UiDir
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { Write-Fail "ground/ui build failed" }
        Write-OK "ground/ui built -> ground/ui/dist/"
    } finally {
        Pop-Location
    }

    Write-Step "Building the Electron shell -> ground/app/windows/dist-electron/"
    Push-Location $AppDir
    try {
        npm run build:electron
        if ($LASTEXITCODE -ne 0) { Write-Fail "ground/app/windows Electron build failed" }
        Write-OK "Electron main/preload built -> dist-electron/"
    } finally {
        Pop-Location
    }

    # ------------------------------------------------------------------------
    # Artefact assertions. Every one of these is a path something loads at
    # RUNTIME; a build that "succeeded" without producing them is a build that
    # fails at launch instead, which is what FM-83 and FM-132 both were.
    # ------------------------------------------------------------------------
    Write-Step "Verifying built artefacts"
    $required = @(
        @{ Path = (Join-Path $PlannerDir "dist\index.js");   What = "planner bundle (phase3Host require)" },
        @{ Path = (Join-Path $UiDir "dist\index.html");      What = "built UI (main.ts loadFile)" },
        @{ Path = (Join-Path $AppDir "dist-electron\main.js");    What = "Electron main (package.json main)" },
        @{ Path = (Join-Path $AppDir "dist-electron\preload.js"); What = "Electron preload (webPreferences)" }
    )
    foreach ($artefact in $required) {
        if (-not (Test-Path $artefact.Path)) {
            Write-Fail ("MISSING {0}: {1}" -f $artefact.What, $artefact.Path)
        }
        Write-OK ("{0} -> {1}" -f $artefact.What, $artefact.Path)
    }
}

# ---------------------------------------------------------------------------
# 8. Next steps
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
Write-Host "  Full acceptance e2e (WSL2, needs PowerShell 7):" -ForegroundColor White
Write-Host "    pwsh .\scripts\run-sim-e2e.ps1" -ForegroundColor Cyan
Write-Host ""
Write-Host "  After editing ground/planner or the shell's TypeScript, RE-RUN this" -ForegroundColor White
Write-Host "  script (or rebuild by hand) -- the shell loads the BUILT artefacts," -ForegroundColor White
Write-Host "  so an unbuilt edit silently runs the previous build." -ForegroundColor Gray
Write-Host ""
