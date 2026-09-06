# ============================================================================
# Static + unit tests for the PowerShell scripts (no Pester, no network).
# ----------------------------------------------------------------------------
# Two things are pinned here:
#
#  1. FM-142: both scripts must PARSE under Windows PowerShell 5.1, the default
#     shell on a stock Windows box. A parse error happens before any
#     `#Requires` is honoured, so the gate would not run at all. The tokeniser
#     is used rather than a text scan, because `&&` legitimately appears inside
#     the bash command strings handed to `wsl -- bash -lc`.
#
#  2. The two pure helpers in run-sim-e2e.ps1 that decide WHERE things run and
#     WHAT gets probed: the Windows->WSL path mapping and the ws:// split. They
#     are lifted out of the file by AST so importing them cannot start SITL.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\test\scripts-powershell.test.ps1
# Exit:   0 all assertions passed, 1 otherwise
# ============================================================================
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir  = $PSScriptRoot
if (-not $ScriptDir) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$ScriptsDir = Split-Path -Parent $ScriptDir

$Passed = 0
$Failed = 0

function Test-Ok {
    param([string]$What)
    $script:Passed++
    Write-Host "  ok   $What"
}

function Test-Flunk {
    param([string]$What, [string]$Detail)
    $script:Failed++
    Write-Host "  FAIL $What" -ForegroundColor Red
    Write-Host "     $Detail" -ForegroundColor Red
}

function Assert-Equal {
    param([string]$What, $Expected, $Actual)
    if ($Expected -eq $Actual) { Test-Ok $What }
    else { Test-Flunk $What ("want [{0}], got [{1}]" -f $Expected, $Actual) }
}

# ---------------------------------------------------------------------------
# 1. Parse cleanly, and carry no 7-only operator tokens.
# ---------------------------------------------------------------------------
$SevenOnlyTokens = @('QuestionQuestion', 'QuestionQuestionEquals', 'QuestionDot',
                     'QuestionLBracket', 'AndAnd', 'OrOr')

function Test-ParsesUnderFiveOne {
    param([string]$Path)

    $name   = Split-Path -Leaf $Path
    $errors = $null
    $tokens = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile(
        $Path, [ref]$tokens, [ref]$errors)

    if ($errors -and $errors.Count -gt 0) {
        Test-Flunk "$name parses" ($errors[0].ToString())
        return
    }
    Test-Ok "$name parses"

    $offenders = @()
    foreach ($token in $tokens) {
        if ($SevenOnlyTokens -contains $token.Kind.ToString()) {
            $offenders += ("{0} at line {1}" -f $token.Kind, $token.Extent.StartLineNumber)
        }
    }
    if ($offenders.Count -gt 0) {
        Test-Flunk "$name is free of 7-only operators" ($offenders -join ', ')
    } else {
        Test-Ok "$name is free of 7-only operators"
    }
}

Write-Host "PowerShell scripts"
Test-ParsesUnderFiveOne (Join-Path $ScriptsDir "run-sim-e2e.ps1")
Test-ParsesUnderFiveOne (Join-Path $ScriptsDir "setup-ground.ps1")

# ---------------------------------------------------------------------------
# 2. Lift the pure helpers out by AST and exercise them.
# ---------------------------------------------------------------------------
# Returns the source text of the named functions. The caller dot-sources it, so
# the definitions land in the caller's scope rather than in this helper's.
function Get-FunctionSource {
    param([string]$Path, [string[]]$Names)

    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        $Path, [ref]$null, [ref]$null)
    $found = $ast.FindAll(
        { param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] },
        $true)
    $chunks = @()
    foreach ($fn in $found) {
        if ($Names -contains $fn.Name) { $chunks += $fn.Extent.Text }
    }
    if ($chunks.Count -ne $Names.Count) {
        throw ("expected {0} function(s) in {1}, lifted {2}" -f $Names.Count, $Path, $chunks.Count)
    }
    return ($chunks -join "`n")
}

# Split-WsUrl closes over this constant in its own file.
$DefaultWsPort = 8765
. ([scriptblock]::Create(
    (Get-FunctionSource -Path (Join-Path $ScriptsDir "run-sim-e2e.ps1") `
                        -Names @("ConvertTo-WslPath", "Split-WsUrl"))))

Assert-Equal "C: repo maps under /mnt/c" `
    "/mnt/c/Users/dev/repo/platform" `
    (ConvertTo-WslPath -WindowsPath "C:\Users\dev\repo\platform")

Assert-Equal "the drive letter is lower-cased" `
    "/mnt/d/work/platform" `
    (ConvertTo-WslPath -WindowsPath "D:\work\platform")

Assert-Equal "path casing below the drive is preserved" `
    "/mnt/c/Users/User/Documents/EyeInTheSky" `
    (ConvertTo-WslPath -WindowsPath "C:\Users\User\Documents\EyeInTheSky")

$parsed = Split-WsUrl -Url "ws://127.0.0.1:8765"
Assert-Equal "default url host" "127.0.0.1" $parsed.TargetHost
Assert-Equal "default url port" 8765        $parsed.Port

$parsed = Split-WsUrl -Url "ws://jetson.local:9100/control"
Assert-Equal "explicit host" "jetson.local" $parsed.TargetHost
Assert-Equal "explicit port" 9100           $parsed.Port

$parsed = Split-WsUrl -Url "ws://192.168.1.42"
Assert-Equal "portless url keeps the control-port default" 8765 $parsed.Port
Assert-Equal "portless url host" "192.168.1.42" $parsed.TargetHost

$parsed = Split-WsUrl -Url "wss://drone:8765/ws"
Assert-Equal "wss is accepted too" "drone" $parsed.TargetHost
Assert-Equal "wss port" 8765 $parsed.Port

# ---------------------------------------------------------------------------
Write-Host ""
Write-Host ("{0} passed, {1} failed" -f $Passed, $Failed)
if ($Failed -gt 0) { exit 1 }
exit 0
