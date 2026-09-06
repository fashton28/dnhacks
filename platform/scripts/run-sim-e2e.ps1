# ============================================================================
# Drone Safety Platform -- acceptance gate (PowerShell / Windows)
# ----------------------------------------------------------------------------
# The Windows counterpart of run-sim-e2e.sh. ArduCopter SITL has no native
# Windows build, so it runs inside WSL2 (Ubuntu); the companion and the two sim
# clients run either alongside it in WSL2 (default -- same venv setup-sim.sh
# created) or natively on Windows against companion\.venv-win.
#
# WSL2 forwards localhost, so 127.0.0.1:8765 / :14550 are the same endpoints on
# both sides of the boundary and the two placements are interchangeable.
#
# PREREQUISITES
#   - WSL2 with Ubuntu installed
#   - setup-ground.ps1 already run (Node/npm ready)
#   - ArduPilot SITL set up inside WSL2 (run setup-sim.sh there first)
#   - Python 3.10+ either in WSL2 (preferred) or natively with companion\.venv-win
#
# EXIT CODES
#   0  every test passed
#   1  a test failed, or setup failed
#
# USAGE
#   .\scripts\run-sim-e2e.ps1
#   .\scripts\run-sim-e2e.ps1 -Preflight       # check the box, start nothing
#   .\scripts\run-sim-e2e.ps1 -SkipManual
#   .\scripts\run-sim-e2e.ps1 -UseNativePy -Timeout 90
#
# ENVIRONMENT (the parameters above override these)
#   EIS_E2E_WS_URL      control WebSocket URL  [ws://127.0.0.1:8765]
#   EIS_E2E_TIMEOUT     seconds to wait for the companion  [60]
#   EIS_SKIP_MANUAL     "1" to skip manual_test.py
#   EIS_USE_NATIVE_PY   "1" to force native Windows Python instead of WSL2
#
# POWERSHELL VERSION: runs under Windows PowerShell 5.1 AND PowerShell 7+.
#
#   This used to be 7-only by accident (FM-142): two null-coalescing `??`
#   operators in the param block made the file unparseable under 5.1 — which is
#   the DEFAULT `powershell.exe` on a stock Windows box — so the documented
#   acceptance gate could not run at all, and it failed with six parser errors
#   rather than anything that named the cause. `#Requires -Version 7` would not
#   have helped: a parse error happens before a requires directive is honoured.
#   The defaults below are resolved in 5.1-compatible syntax instead, so the
#   gate runs on whatever PowerShell the operator happens to have.
#
#   Keep this file free of 7-only syntax: `??`, `?.`, `?:`, `&&`/`||` chains,
#   `ConvertFrom-Json -AsHashtable`, 3-argument `Join-Path`. Verify with:
#     $e=$null; [System.Management.Automation.Language.Parser]::ParseFile(
#       "scripts\run-sim-e2e.ps1",[ref]$null,[ref]$e); $e
# ============================================================================
param(
    [string]$WsUrl = "",
    [int]   $Timeout = 0,
    [switch]$SkipManual,
    [switch]$UseNativePy,
    [switch]$Preflight
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Fixed facts.
$DefaultWsUrl        = "ws://127.0.0.1:8765"
$DefaultWsPort       = 8765
$DefaultTimeout      = 60
$SitlSettleSeconds   = 10
$PollIntervalSeconds = 2
$WslDistro           = "Ubuntu"

# Environment defaults, resolved without 7-only operators (see the header).
if (-not $WsUrl) {
    $WsUrl = if ($env:EIS_E2E_WS_URL) { $env:EIS_E2E_WS_URL } else { $DefaultWsUrl }
}
if ($Timeout -le 0) {
    $Timeout = if ($env:EIS_E2E_TIMEOUT) { [int]$env:EIS_E2E_TIMEOUT } else { $DefaultTimeout }
}
if (-not $SkipManual)  { $SkipManual  = ($env:EIS_SKIP_MANUAL   -eq "1") }
if (-not $UseNativePy) { $UseNativePy = ($env:EIS_USE_NATIVE_PY -eq "1") }

$ScriptDir = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$RepoRoot  = Split-Path -Parent $ScriptDir

$NativePython    = Join-Path $RepoRoot "companion\.venv-win\Scripts\python.exe"
$NativeConfig    = Join-Path $RepoRoot "companion\config\sitl.yaml"
$RelativeConfig  = "companion/config/sitl.yaml"

# Supervised background jobs, newest last; torn down in reverse.
$Jobs     = @()
$Results  = @()
$ExitCode = 0

function Write-Step { param([string]$m) Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-OK   { param([string]$m) Write-Host "    [OK] $m"   -ForegroundColor Green }
function Write-Fail { param([string]$m) Write-Host "    [FAIL] $m" -ForegroundColor Red }
function Write-Miss { param([string]$m) Write-Host "    [--] $m"   -ForegroundColor Yellow }
function Write-Info { param([string]$m) Write-Host "    $m"        -ForegroundColor Gray }

# ---------------------------------------------------------------------------
# C:\path\to\repo  ->  /mnt/c/path/to/repo
# ---------------------------------------------------------------------------
function ConvertTo-WslPath {
    param([string]$WindowsPath)
    $slashed = ($WindowsPath -replace '\\', '/')
    $drive   = $slashed.Substring(0, 1).ToLower()
    $rest    = $slashed.Substring(2)          # strip "C:"
    return "/mnt/" + $drive + $rest
}

# ---------------------------------------------------------------------------
# ws://host:port/path -> @{ TargetHost = ...; Port = ... }
# ---------------------------------------------------------------------------
function Split-WsUrl {
    param([string]$Url)
    $stripped = $Url -replace '^wss?://', ''
    $stripped = $stripped -replace '/.*$', ''
    $targetHost = $stripped
    $port       = $DefaultWsPort
    if ($stripped -match ':(\d+)$') {
        $port       = [int]$Matches[1]
        $targetHost = $stripped -replace ':(\d+)$', ''
    }
    return @{ TargetHost = $targetHost; Port = $port }
}

# ---------------------------------------------------------------------------
# Job bookkeeping
# ---------------------------------------------------------------------------
function Register-BackgroundJob {
    param([string]$Label, $Job)
    $script:Jobs += @{ Label = $Label; Job = $Job }
    Write-OK ("{0} started (Job ID {1})" -f $Label, $Job.Id)
}

function Assert-JobAlive {
    param([string]$Label, $Job, [string]$Hint)
    $state = (Get-Job -Id $Job.Id).State
    if ($state -eq 'Failed' -or $state -eq 'Completed') {
        throw ("{0} exited prematurely (state={1}). {2}" -f $Label, $state, $Hint)
    }
}

function Stop-BackgroundJobs {
    for ($i = $script:Jobs.Count - 1; $i -ge 0; $i--) {
        $entry = $script:Jobs[$i]
        Write-Info ("Stopping {0}..." -f $entry.Label)
        Stop-Job   $entry.Job -ErrorAction SilentlyContinue
        Remove-Job $entry.Job -Force -ErrorAction SilentlyContinue
    }
    $script:Jobs = @()
}

# ---------------------------------------------------------------------------
# Preflight -- everything checkable without starting a process
# ---------------------------------------------------------------------------
function Test-Preconditions {
    param([string]$WslPath)

    Write-Step "Preflight"
    $problems = @()

    if ($UseNativePy) {
        Write-Info "Placement: native Windows Python"
        if (Test-Path $NativePython) {
            Write-OK "python: $NativePython"
        } else {
            $problems += "Native venv not found at $NativePython. Run: python -m venv companion\.venv-win && companion\.venv-win\Scripts\pip install -e companion[dev]"
            Write-Miss "python missing: $NativePython"
        }
        if (Test-Path $NativeConfig) {
            Write-OK "config: $NativeConfig"
        } else {
            $problems += "Companion config not found at $NativeConfig"
            Write-Miss "config missing: $NativeConfig"
        }
    } else {
        Write-Info "Placement: WSL2 ($WslDistro)"
        if (Get-Command wsl -ErrorAction SilentlyContinue) {
            Write-OK "wsl.exe found"
        } else {
            $problems += "WSL2 (wsl.exe) not found. Install WSL2 with Ubuntu: wsl --install"
            Write-Miss "wsl.exe not found"
        }
        Write-Info "WSL path: $WslPath"
    }

    foreach ($relative in @("sim\run_sitl.sh", "sim\e2e_test.py", "sim\manual_test.py")) {
        $full = Join-Path $RepoRoot $relative
        if (Test-Path $full) {
            Write-OK $relative
        } else {
            $problems += "missing: $full"
            Write-Miss "missing: $full"
        }
    }

    Write-OK ("target: {0} (ready budget {1}s)" -f $WsUrl, $Timeout)

    if ($problems.Count -gt 0) {
        throw ($problems -join "; ")
    }
}

# ---------------------------------------------------------------------------
# SITL -- always WSL2: there is no native Windows ArduCopter build
# ---------------------------------------------------------------------------
function Start-Sitl {
    param([string]$WslPath)

    Write-Step "Starting ArduCopter SITL in WSL2 (background)"
    Write-Info "WSL path: $WslPath"

    $job = Start-Job -ScriptBlock {
        param($distro, $wslPath)
        wsl -d $distro -- bash -lc "cd '$wslPath' && bash sim/run_sitl.sh"
    } -ArgumentList $WslDistro, $WslPath

    Register-BackgroundJob -Label "SITL" -Job $job

    Write-Info "Waiting $SitlSettleSeconds s for SITL MAVLink to initialise..."
    Start-Sleep -Seconds $SitlSettleSeconds
    Assert-JobAlive -Label "SITL job" -Job $job -Hint "Check WSL2 and ArduPilot setup."
    Write-OK "SITL running"
    return $job
}

# ---------------------------------------------------------------------------
# Companion -- native venv or WSL2 venv. EIS_CAMERA_SOURCE=mock keeps it off
# any real camera; EIS_CONFIG selects the SITL profile.
# ---------------------------------------------------------------------------
function Start-Companion {
    param([string]$WslPath)

    Write-Step "Starting companion (SITL/mock mode)"

    if ($UseNativePy) {
        if (-not (Test-Path $NativePython)) {
            throw "Native venv not found at $NativePython. Run: python -m venv companion\.venv-win && companion\.venv-win\Scripts\pip install -e companion[dev]"
        }
        Write-Info "python: $NativePython"
        $job = Start-Job -ScriptBlock {
            param($py, $root, $cfg)
            $env:EIS_CONFIG        = $cfg
            $env:EIS_CAMERA_SOURCE = "mock"
            Set-Location $root
            & $py -m eis_companion.app
        } -ArgumentList $NativePython, $RepoRoot, $NativeConfig
    } else {
        Write-Info "python: companion/.venv inside WSL2"
        $job = Start-Job -ScriptBlock {
            param($distro, $wslPath, $cfg)
            wsl -d $distro -- bash -lc @"
cd '$wslPath'
source companion/.venv/bin/activate
EIS_CONFIG=$cfg EIS_CAMERA_SOURCE=mock python -m eis_companion.app
"@
        } -ArgumentList $WslDistro, $WslPath, $RelativeConfig
    }

    Register-BackgroundJob -Label "companion" -Job $job
    return $job
}

# ---------------------------------------------------------------------------
# Readiness: a TCP open on the control port. WSL2 forwards localhost, so the
# same probe works for both placements.
# ---------------------------------------------------------------------------
function Test-WebSocketPort {
    param([string]$TargetHost, [int]$Port)
    $tcp = New-Object System.Net.Sockets.TcpClient
    try {
        $tcp.Connect($TargetHost, $Port)
        return $true
    } catch {
        return $false
    } finally {
        $tcp.Close()
    }
}

function Wait-ForCompanion {
    param($CompanionJob)

    $endpoint = Split-WsUrl -Url $WsUrl
    Write-Step ("Waiting for companion WebSocket ({0}, up to {1}s)" -f $WsUrl, $Timeout)
    Write-Info ("probing {0}:{1}" -f $endpoint.TargetHost, $endpoint.Port)

    $waited = 0
    while ($waited -lt $Timeout) {
        if (Test-WebSocketPort -TargetHost $endpoint.TargetHost -Port $endpoint.Port) {
            Write-OK ("Companion WebSocket ready after {0}s" -f $waited)
            return
        }
        Assert-JobAlive -Label "Companion job" -Job $CompanionJob -Hint "It exited before becoming ready."
        Start-Sleep -Seconds $PollIntervalSeconds
        $waited += $PollIntervalSeconds
        Write-Info "  ...${waited}s"
    }
    throw "Companion WebSocket not ready after ${Timeout}s."
}

# ---------------------------------------------------------------------------
# The sim clients. Their CLI is the contract: --ws-url, plus EIS_WS_URL in the
# environment, which is the variable they read.
# ---------------------------------------------------------------------------
function Invoke-SimClient {
    param([string]$Name)

    Write-Step "Running sim/$Name"

    if ($UseNativePy) {
        $previous = $env:EIS_WS_URL
        $env:EIS_WS_URL = $WsUrl
        try {
            & $NativePython (Join-Path $RepoRoot ("sim\" + $Name)) --ws-url $WsUrl
        } finally {
            $env:EIS_WS_URL = $previous
        }
    } else {
        $wslPath = ConvertTo-WslPath -WindowsPath $RepoRoot
        wsl -d $WslDistro -- bash -lc "cd '$wslPath' && source companion/.venv/bin/activate && EIS_WS_URL='$WsUrl' python sim/$Name --ws-url '$WsUrl'"
    }

    if ($LASTEXITCODE -ne 0) {
        $script:Results += ("{0} FAIL (exit {1})" -f $Name, $LASTEXITCODE)
        throw ("{0} FAILED (exit {1})" -f $Name, $LASTEXITCODE)
    }
    $script:Results += ("{0} PASS" -f $Name)
    Write-OK "$Name PASSED"
}

function Show-Ledger {
    if ($script:Results.Count -eq 0) { return }
    Write-Step "Results"
    foreach ($line in $script:Results) { Write-Info $line }
}

# ---------------------------------------------------------------------------
try {
    $WslPath = ConvertTo-WslPath -WindowsPath $RepoRoot

    Test-Preconditions -WslPath $WslPath

    if ($Preflight) {
        Write-Host ""
        Write-Host "============================================================" -ForegroundColor Green
        Write-Host " PREFLIGHT OK -- nothing was started" -ForegroundColor Green
        Write-Host "============================================================" -ForegroundColor Green
        exit 0
    }

    $sitlJob = Start-Sitl -WslPath $WslPath
    $companionJob = Start-Companion -WslPath $WslPath
    Wait-ForCompanion -CompanionJob $companionJob

    Invoke-SimClient -Name "e2e_test.py"

    if ($SkipManual) {
        Write-Info "SkipManual: skipping manual_test.py"
        $Results += "manual_test.py SKIP"
    } else {
        Invoke-SimClient -Name "manual_test.py"
    }

    Show-Ledger
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host " ALL E2E TESTS PASSED" -ForegroundColor Green
    Write-Host "============================================================" -ForegroundColor Green

} catch {
    Write-Host ""
    Write-Fail "$_"
    Show-Ledger
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host " E2E TESTS FAILED" -ForegroundColor Red
    Write-Host "============================================================" -ForegroundColor Red
    $ExitCode = 1
} finally {
    Stop-BackgroundJobs
}

exit $ExitCode
