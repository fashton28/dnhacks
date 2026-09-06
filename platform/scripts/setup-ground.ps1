# ============================================================================
# Drone Safety Platform -- Windows ground-station bootstrap
# ----------------------------------------------------------------------------
# Idempotent: run it on a fresh clone, and again after any dependency bump or
# TypeScript edit.
#
# THE PIPELINE IS A TABLE, NOT A SCRIPT. Three workspaces are declared once, in
# the order the Electron shell loads them at RUNTIME, each with the npm script
# that produces its artefacts and the artefacts themselves:
#
#     ground\planner          npm run build           dist\index.js
#     ground\ui               npm run build           dist\index.html
#     ground\app\windows      npm run build:electron  dist-electron\main.js
#                                                     dist-electron\preload.js
#
# Everything below walks that table: install every workspace, build every
# workspace, then assert every artefact exists.
#
# WHY THE ORDER AND THE ASSERTIONS MATTER (FM-83, FM-132)
# `ground\planner\dist` and `dist-electron\` are gitignored, package.json's
# `main` is `dist-electron\main.js`, and the main process `require`s
# `ground\planner\dist\index.js` on the first plan -- so a fresh clone has
# NEITHER. Installing and building only ground\ui produced a tree that started
# and then failed: "Cannot find module dist-electron/main.js" at launch, or a
# "Planning failed" toast the moment the inspection button was pressed. A build
# that "succeeds" without emitting its artefacts is that same failure deferred,
# so the artefacts are asserted rather than assumed.
#
# USAGE
#   .\scripts\setup-ground.ps1
#   .\scripts\setup-ground.ps1 -Preflight   # report state, install nothing
#
# ENVIRONMENT
#   EIS_SKIP_BUILD=1   install dependencies but skip every build (the artefact
#                      assertions are skipped with it)
#
# EXIT CODES
#   0  dependencies installed and (unless skipped) every artefact present
#   1  Node/npm missing or too old, a workspace missing, or a build failed
#
# POWERSHELL VERSION: Windows PowerShell 5.1 AND PowerShell 7+.
#   `powershell.exe` 5.1 is the default on a stock Windows box, so this file
#   stays clear of 7-only syntax: `??`, `?.`, `?:`, `&&`/`||` chains,
#   `ConvertFrom-Json -AsHashtable`, 3-argument `Join-Path`. Verify with:
#     $e=$null; [System.Management.Automation.Language.Parser]::ParseFile(
#       "scripts\setup-ground.ps1",[ref]$null,[ref]$e); $e
# ============================================================================
param(
    [switch]$Preflight
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$NodeMinMajor = 20

$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$RepoRoot = Split-Path -Parent $ScriptDir

function Write-Step { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK   { param([string]$msg) Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Miss { param([string]$msg) Write-Host "    [--] $msg" -ForegroundColor Yellow }
function Write-Info { param([string]$msg) Write-Host "    $msg" -ForegroundColor Gray }
function Write-Fail { param([string]$msg) Write-Host "    [FAIL] $msg" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------------------
# The table. `Artefacts` pairs each built path with what loads it, so a missing
# file is reported as the thing that will break, not as a path.
# ---------------------------------------------------------------------------
function Get-Workspaces {
    return @(
        @{
            Name      = "ground/planner"
            Path      = Join-Path $RepoRoot "ground\planner"
            Script    = "build"
            Artefacts = @(
                @{ Rel = "dist\index.js"; What = "planner bundle (phase3Host require)" }
            )
        },
        @{
            Name      = "ground/ui"
            Path      = Join-Path $RepoRoot "ground\ui"
            Script    = "build"
            Artefacts = @(
                @{ Rel = "dist\index.html"; What = "built UI (main.ts loadFile)" }
            )
        },
        @{
            Name      = "ground/app/windows"
            Path      = Join-Path $RepoRoot "ground\app\windows"
            Script    = "build:electron"
            Artefacts = @(
                @{ Rel = "dist-electron\main.js";    What = "Electron main (package.json main)" },
                @{ Rel = "dist-electron\preload.js"; What = "Electron preload (webPreferences)" }
            )
        }
    )
}

function Get-NodeMajor {
    $raw = (node --version)
    if (-not $raw) { return 0 }
    $trimmed = ([string]$raw) -replace '^v', ''
    return [int]($trimmed.Split('.')[0])
}

# Resolve npm ONCE, preferring npm.cmd. `npm` on PATH resolves to npm.ps1 on a
# stock Node install, and that shim inherits this script's
# `Set-StrictMode -Version Latest` -- under which its own
# `if ($MyInvocation.Statement)` throws PropertyNotFoundStrict and every npm
# call fails before npm has run. npm.cmd is an external process and is immune.
function Resolve-NpmExe {
    $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $cmd = Get-Command npm -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return ""
}

$NpmExe = Resolve-NpmExe

function Get-NpmVersion {
    if (-not $NpmExe) { return "" }
    return (& $NpmExe --version)
}

# ---------------------------------------------------------------------------
# 1. Toolchain
# ---------------------------------------------------------------------------
function Assert-Toolchain {
    Write-Step "Checking Node.js version (require >= $NodeMinMajor)"

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Fail "Node.js not found. Install from https://nodejs.org (LTS >= $NodeMinMajor) then re-run."
    }
    $major = Get-NodeMajor
    if ($major -lt $NodeMinMajor) {
        Write-Fail "Node.js $(node --version) is too old (need >= $NodeMinMajor). Download from https://nodejs.org"
    }
    Write-OK "Node.js $(node --version)"

    if (-not $NpmExe) {
        Write-Fail "npm not found. It should ship with Node.js -- re-install Node."
    }
    Write-OK ("npm {0}" -f (Get-NpmVersion))
}

# ---------------------------------------------------------------------------
# npm in one workspace. Push/Pop in a finally so a throw cannot leave the
# caller's location somewhere else.
# ---------------------------------------------------------------------------
function Invoke-Npm {
    param(
        [hashtable]$Workspace,
        [string[]]$Arguments,
        [string]$What
    )

    if (-not (Test-Path $Workspace.Path)) {
        Write-Fail ("{0} not found at {1}" -f $Workspace.Name, $Workspace.Path)
    }

    if (-not $NpmExe) {
        Write-Fail "npm not found. It should ship with Node.js -- re-install Node."
    }

    Push-Location $Workspace.Path
    try {
        & $NpmExe @Arguments
        if ($LASTEXITCODE -ne 0) {
            Write-Fail ("{0} failed in {1} (npm {2})" -f $What, $Workspace.Name, ($Arguments -join ' '))
        }
    } finally {
        Pop-Location
    }
}

# ---------------------------------------------------------------------------
# 2-4. Dependencies
# ---------------------------------------------------------------------------
function Install-Workspaces {
    foreach ($ws in Get-Workspaces) {
        Write-Step ("Installing {0} dependencies" -f $ws.Name)
        Invoke-Npm -Workspace $ws -Arguments @("install", "--prefer-offline") -What "npm install"
        Write-OK ("{0} node_modules ready" -f $ws.Name)
    }
}

# ---------------------------------------------------------------------------
# 5-7. Builds, in load order, so a failure names the thing that failed
# ---------------------------------------------------------------------------
function Build-Workspaces {
    foreach ($ws in Get-Workspaces) {
        Write-Step ("Building {0} (npm run {1})" -f $ws.Name, $ws.Script)
        Invoke-Npm -Workspace $ws -Arguments @("run", $ws.Script) -What "build"
        Write-OK ("{0} built" -f $ws.Name)
    }
}

# ---------------------------------------------------------------------------
# 8. Artefact assertions -- every path here is loaded at RUNTIME
# ---------------------------------------------------------------------------
function Assert-Artefacts {
    Write-Step "Verifying built artefacts"
    foreach ($ws in Get-Workspaces) {
        foreach ($artefact in $ws.Artefacts) {
            $full = Join-Path $ws.Path $artefact.Rel
            if (-not (Test-Path $full)) {
                Write-Fail ("MISSING {0}: {1}" -f $artefact.What, $full)
            }
            Write-OK ("{0} -> {1}" -f $artefact.What, $full)
        }
    }
}

# ---------------------------------------------------------------------------
# -Preflight: report, install nothing, build nothing.
# ---------------------------------------------------------------------------
function Show-State {
    Write-Step "Ground-station report (-Preflight: nothing will be installed or built)"

    if (Get-Command node -ErrorAction SilentlyContinue) {
        if ((Get-NodeMajor) -ge $NodeMinMajor) {
            Write-OK "Node.js $(node --version)"
        } else {
            Write-Miss "Node.js $(node --version) is older than $NodeMinMajor"
        }
    } else {
        Write-Miss "node not on PATH"
    }

    if ($NpmExe) {
        Write-OK ("npm {0} ({1})" -f (Get-NpmVersion), $NpmExe)
    } else {
        Write-Miss "npm not on PATH"
    }

    foreach ($ws in Get-Workspaces) {
        if (Test-Path $ws.Path) {
            Write-OK ("workspace {0}" -f $ws.Name)
        } else {
            Write-Miss ("workspace missing: {0}" -f $ws.Path)
            continue
        }
        if (Test-Path (Join-Path $ws.Path "node_modules")) {
            Write-OK "  node_modules present"
        } else {
            Write-Miss "  node_modules absent"
        }
        foreach ($artefact in $ws.Artefacts) {
            if (Test-Path (Join-Path $ws.Path $artefact.Rel)) {
                Write-OK ("  {0}" -f $artefact.Rel)
            } else {
                Write-Miss ("  {0} (not built)" -f $artefact.Rel)
            }
        }
    }
    Write-Host ""
}

function Show-NextSteps {
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
    Write-Host "    cd ground\app\windows; npm run dist" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Full acceptance e2e (WSL2 for SITL; Windows PowerShell 5.1 is fine):" -ForegroundColor White
    Write-Host "    .\scripts\run-sim-e2e.ps1" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  After editing ground/planner or the shell's TypeScript, RE-RUN this" -ForegroundColor White
    Write-Host "  script (or rebuild by hand) -- the shell loads the BUILT artefacts," -ForegroundColor White
    Write-Host "  so an unbuilt edit silently runs the previous build." -ForegroundColor Gray
    Write-Host ""
}

# ---------------------------------------------------------------------------
if ($Preflight) {
    Show-State
    exit 0
}

Assert-Toolchain
Install-Workspaces

if ($env:EIS_SKIP_BUILD -eq "1") {
    Write-Info "EIS_SKIP_BUILD=1: skipping every build (planner, UI, Electron shell)."
    Write-Info "The ground station will NOT start until these are built."
} else {
    Build-Workspaces
    Assert-Artefacts
}

Show-NextSteps
