@echo off
setlocal
cd /d "%~dp0"
title PlayAgent Checker - Install Latest

echo ============================================================
echo  PlayAgent Checker - one-click latest installer / updater
echo ============================================================
echo.
echo This will fetch canonical main, deploy from an isolated copy,
echo build both runner images, pin ECS to the Git SHA, and verify it.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deploy-latest.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  echo [SUCCESS] Latest PlayAgent Checker is installed and verified.
) else (
  echo [FAILED] Deployment stopped. Read the error and log path above.
)
echo.
pause
exit /b %EXIT_CODE%
