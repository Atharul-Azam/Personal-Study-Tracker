@echo off
REM Double-click to build the Windows installer and portable .exe into the "dist" folder.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-windows.ps1"
if errorlevel 1 (
  echo.
  echo BUILD FAILED - see the messages above.
  pause
  exit /b 1
)
echo.
echo Build finished. Installer and portable exe are in the "dist" folder.
pause
