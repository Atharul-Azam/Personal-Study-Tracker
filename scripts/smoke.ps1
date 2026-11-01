<#
  Runs the app in --smoke-test mode and ALWAYS shows what happened.
    powershell -File scripts\smoke.ps1 -Exe <path-to-electron-or-Study Tracker.exe> -Out <report.json> [-AppArgs '.'] [-TimeoutSec 120]
  - removes any old report, starts the app, waits (kills it if it hangs),
  - prints the JSON report if one exists (even when the run failed), and only THEN decides pass/fail.
  The report is written by the app itself from its first moment, so "report missing" means the app died
  before running any of our code (the message then says so).
#>
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Out,
  [string[]]$AppArgs = @(),
  [int]$TimeoutSec = 120
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Exe)) { throw "Smoke test: executable not found: $Exe" }
if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }

# Start-Process does not quote arguments, so the --smoke-out value is wrapped in literal quotes (paths may contain spaces).
$argList = @($AppArgs) + @('--smoke-test', "`"--smoke-out=$Out`"")
Write-Host "Starting: $Exe $($argList -join ' ')"
$p = Start-Process -FilePath $Exe -ArgumentList $argList -PassThru
$finished = $p.WaitForExit($TimeoutSec * 1000)
if (-not $finished) {
  Write-Host "::error::Smoke test did not exit within $TimeoutSec s - killing it"
  try { Stop-Process -Id $p.Id -Force } catch { }
  $exitCode = -999
} else {
  $p.WaitForExit()
  $exitCode = $p.ExitCode
}
Write-Host "Exit code: $exitCode"

if (Test-Path -LiteralPath $Out) {
  Write-Host "----- smoke report: $Out -----"
  Get-Content -LiteralPath $Out
  Write-Host '----- end of report -----'
} else {
  Write-Host "::error::No smoke report was written to $Out. The app exited or crashed before any application code ran (exit code $exitCode)."
}

if ($exitCode -ne 0) { throw "Smoke test FAILED (exit code $exitCode). See the report above." }
if (-not (Test-Path -LiteralPath $Out)) { throw "Smoke test passed its exit code but wrote no report: $Out" }
$report = Get-Content -LiteralPath $Out -Raw | ConvertFrom-Json
if (-not $report.ok) { throw 'Smoke test report says ok = false.' }
Write-Host 'Smoke test passed.' -ForegroundColor Green
