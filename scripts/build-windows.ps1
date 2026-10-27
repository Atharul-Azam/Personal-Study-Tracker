<#
  Builds Study Tracker for Windows (installer + portable .exe) and smoke-tests the result.
  Run from the project folder:   powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
  Requires: Node.js 22.13 or newer (https://nodejs.org) and an internet connection for the FIRST build
  (to download Electron and the packager). The finished app itself never needs the internet.
#>
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

Step 'Checking Node.js'
$nodeVersion = (node --version) -replace '^v', ''
if ([version]($nodeVersion.Split('-')[0]) -lt [version]'22.13.0') { throw "Node.js 22.13 or newer is required (found $nodeVersion)." }
Write-Host "Node $nodeVersion"

Step 'Installing dependencies'
npm install
if ($LASTEXITCODE -ne 0) { throw 'npm install failed' }

Step 'Running automated tests'
npm test
if ($LASTEXITCODE -ne 0) { throw 'Unit tests failed - not building.' }

Step 'Building the Windows app (installer + portable)'
npm run dist:win
if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed' }

Step 'Smoke-testing the packaged app'
$exe = Join-Path (Get-Location) 'dist\win-unpacked\Study Tracker.exe'
if (-not (Test-Path $exe)) { throw "Expected build output not found: $exe" }
$out = Join-Path (Get-Location) 'dist\smoke-packaged.json'
if (Test-Path $out) { Remove-Item $out }
# The path is wrapped in literal quotes: Start-Process does not quote arguments, so a folder name with a space would be split in two.
$p = Start-Process -FilePath $exe -ArgumentList '--smoke-test', "`"--smoke-out=$out`"" -PassThru -Wait
if ($p.ExitCode -ne 0 -or -not (Test-Path $out)) { throw "Smoke test FAILED (exit code $($p.ExitCode)). See $out" }
Get-Content $out
Write-Host "`nSmoke test passed." -ForegroundColor Green

Step 'Done'
Get-ChildItem dist -Filter *.exe | ForEach-Object { Write-Host ("  dist\" + $_.Name + "  (" + [math]::Round($_.Length / 1MB, 1) + " MB)") }
