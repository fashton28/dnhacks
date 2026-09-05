# ============================================================================
# Eye in the Sky -- Acceptance Demo (PowerShell / Windows)
# ----------------------------------------------------------------------------
# Windows counterpart to run-sim-e2e.sh. Runs SITL inside WSL2 (Ubuntu), and
# the companion + e2e tests either also in WSL2 or in a native Python venv.
#
# Prerequisites:
#   - WSL2 with Ubuntu installed and configured
#   - setup-ground.ps1 already run (Node/npm ready)
#   - ArduPilot SITL set up inside WSL2 (run setup-sim.sh in WSL2 first)
#   - Python 3.10+ available either:
#       * in WSL2 (preferred — same venv created by setup-sim.sh), OR
#       * natively on Windows (with companion/.venv-win)
#
# Exit codes:
#   0  all tests passed
#   1  one or more tests failed or setup failed
#
# Usage:
#   .\scripts\run-sim-e2e.ps1
#   # Or via make equivalent:
#   make e2e   (runs this script on Windows)
#
# Environment variables honoured:
#   EIS_E2E_WS_URL      WebSocket URL  [ws://127.0.0.1:8765]
#   EIS_E2E_TIMEOUT     Seconds to wait for companion  [60]
#   EIS_SKIP_MANUAL     "1" to skip manual_test.py
#   EIS_USE_NATIVE_PY   "1" to force native Windows Python instead of WSL2
# ============================================================================
param(
    [string]$WsUrl      = $env:EIS_E2E_WS_URL    ?? "ws://127.0.0.1:8765",
    [int]   $Timeout    = [int]($env:EIS_E2E_TIMEOUT ?? "60"),
    [switch]$SkipManual = ($env:EIS_SKIP_MANUAL -eq "1"),
    [switch]$UseNativePy = ($env:EIS_USE_NATIVE_PY -eq "1")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot  = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$WslPath   = "/mnt/" + ($RepoRoot -replace '\\', '/').ToLower().Replace('c:/', 'c/')

$SitlJob      = $null
$CompanionJob = $null
$ExitCode     = 0

function Write-Step { param([string]$m) Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-OK   { param([string]$m) Write-Host "    [OK] $m" -ForegroundColor Green }
function Write-Fail { param([string]$m) Write-Host "    [FAIL] $m" -ForegroundColor Red }
function Write-Info { param([string]$m) Write-Host "    $m" -ForegroundColor Gray }

function Stop-Jobs {
    if ($null -ne $CompanionJob) {
        Write-Info "Stopping companion..."
        Stop-Job  $CompanionJob -ErrorAction SilentlyContinue
        Remove-Job $CompanionJob -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $SitlJob) {
        Write-Info "Stopping SITL (WSL2)..."
        Stop-Job  $SitlJob -ErrorAction SilentlyContinue
        Remove-Job $SitlJob -Force -ErrorAction SilentlyContinue
    }
}

try {
    # -----------------------------------------------------------------------
    # 1. Check WSL2
    # -----------------------------------------------------------------------
    Write-Step "Checking WSL2"
    if (-not (Get-Command wsl -ErrorAction SilentlyContinue)) {
        throw "WSL2 (wsl.exe) not found. Install WSL2 with Ubuntu: wsl --install"
    }
    Write-OK "wsl.exe found"

    # -----------------------------------------------------------------------
    # 2. Start SITL in WSL2 (background PowerShell job)
    # -----------------------------------------------------------------------
    Write-Step "Starting ArduCopter SITL in WSL2 (background)"
    Write-Info "WSL path: $WslPath"

    $SitlJob = Start-Job -ScriptBlock {
        param($wslPath)
        wsl -d Ubuntu -- bash -lc "cd '$wslPath' && bash sim/run_sitl.sh"
    } -ArgumentList $WslPath

    Write-OK "SITL job started (Job ID $($SitlJob.Id))"
    Write-Info "Waiting 10 s for SITL MAVLink to initialise..."
    Start-Sleep -Seconds 10

    $jobState = (Get-Job -Id $SitlJob.Id).State
    if ($jobState -eq 'Failed' -or $jobState -eq 'Completed') {
        throw "SITL job exited prematurely (state=$jobState). Check WSL2 and ArduPilot setup."
    }
    Write-OK "SITL running"

    # -----------------------------------------------------------------------
    # 3. Start companion in WSL2 (or native Python)
    # -----------------------------------------------------------------------
    Write-Step "Starting companion (SITL/mock mode)"

    if ($UseNativePy) {
        # Native Windows Python fallback
        $VenvPy = Join-Path $RepoRoot "companion\.venv-win\Scripts\python.exe"
        if (-not (Test-Path $VenvPy)) {
            throw "Native venv not found at $VenvPy. Run: python -m venv companion\.venv-win && companion\.venv-win\Scripts\pip install -e companion[dev]"
        }
        $CompanionJob = Start-Job -ScriptBlock {
            param($py, $root, $cfg)
            $env:EIS_CONFIG        = $cfg
            $env:EIS_CAMERA_SOURCE = "mock"
            Set-Location $root
            & $py -m eis_companion
        } -ArgumentList $VenvPy, $RepoRoot, (Join-Path $RepoRoot "companion\config\sitl.yaml")
    } else {
        $CompanionJob = Start-Job -ScriptBlock {
            param($wslPath)
            wsl -d Ubuntu -- bash -lc @"
cd '$wslPath'
source companion/.venv/bin/activate
EIS_CONFIG=companion/config/sitl.yaml EIS_CAMERA_SOURCE=mock python -m eis_companion
"@
        } -ArgumentList $WslPath
    }

    Write-OK "Companion job started (Job ID $($CompanionJob.Id))"

    # -----------------------------------------------------------------------
    # 4. Wait for WebSocket readiness
    # -----------------------------------------------------------------------
    Write-Step "Waiting for companion WebSocket ($WsUrl, up to ${Timeout}s)"

    $Waited = 0
    $Ready  = $false

    while ($Waited -lt $Timeout) {
        try {
            $tcp = New-Object System.Net.Sockets.TcpClient
            $host_part = $WsUrl -replace '^ws://', '' -replace '/.*$', ''
            $port_part = 8765
            if ($host_part -match ':(\d+)$') {
                $port_part = [int]$Matches[1]
                $host_part = $host_part -replace ':(\d+)$', ''
            }
            $tcp.Connect($host_part, $port_part)
            $tcp.Close()
            $Ready = $true
            break
        } catch {
            # not ready yet
        }

        $jobState = (Get-Job -Id $CompanionJob.Id).State
        if ($jobState -eq 'Failed' -or $jobState -eq 'Completed') {
            throw "Companion job exited before becoming ready."
        }
        Start-Sleep -Seconds 2
        $Waited += 2
        Write-Info "  ...${Waited}s"
    }

    if (-not $Ready) {
        throw "Companion WebSocket not ready after ${Timeout}s."
    }
    Write-OK "Companion WebSocket ready"

    # -----------------------------------------------------------------------
    # 5. Run e2e_test.py
    # -----------------------------------------------------------------------
    Write-Step "Running sim/e2e_test.py"

    if ($UseNativePy) {
        $VenvPy = Join-Path $RepoRoot "companion\.venv-win\Scripts\python.exe"
        $e2eResult = & $VenvPy "$RepoRoot\sim\e2e_test.py" --ws-url $WsUrl
        if ($LASTEXITCODE -ne 0) { throw "e2e_test.py FAILED (exit $LASTEXITCODE)" }
    } else {
        wsl -d Ubuntu -- bash -lc "cd '$WslPath' && source companion/.venv/bin/activate && python sim/e2e_test.py --ws-url '$WsUrl'"
        if ($LASTEXITCODE -ne 0) { throw "e2e_test.py FAILED (exit $LASTEXITCODE)" }
    }
    Write-OK "e2e_test.py PASSED"

    # -----------------------------------------------------------------------
    # 6. Run manual_test.py
    # -----------------------------------------------------------------------
    if ($SkipManual) {
        Write-Info "SkipManual: skipping manual_test.py"
    } else {
        Write-Step "Running sim/manual_test.py"

        if ($UseNativePy) {
            $VenvPy = Join-Path $RepoRoot "companion\.venv-win\Scripts\python.exe"
            & $VenvPy "$RepoRoot\sim\manual_test.py" --ws-url $WsUrl
            if ($LASTEXITCODE -ne 0) { throw "manual_test.py FAILED (exit $LASTEXITCODE)" }
        } else {
            wsl -d Ubuntu -- bash -lc "cd '$WslPath' && source companion/.venv/bin/activate && python sim/manual_test.py --ws-url '$WsUrl'"
            if ($LASTEXITCODE -ne 0) { throw "manual_test.py FAILED (exit $LASTEXITCODE)" }
        }
        Write-OK "manual_test.py PASSED"
    }

    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host " ALL E2E TESTS PASSED" -ForegroundColor Green
    Write-Host "============================================================" -ForegroundColor Green

} catch {
    Write-Host ""
    Write-Fail "$_"
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host " E2E TESTS FAILED" -ForegroundColor Red
    Write-Host "============================================================" -ForegroundColor Red
    $ExitCode = 1
} finally {
    Stop-Jobs
}

exit $ExitCode
