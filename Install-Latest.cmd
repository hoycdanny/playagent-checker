@echo off
setlocal
cd /d "%~dp0"
title PlayAgent Checker - Install Latest

echo ============================================================
echo  PlayAgent Checker - one-click latest installer / updater
echo ============================================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [FAILED] Node.js 22+ is required: https://nodejs.org/
  pause
  exit /b 1
)
node "%~dp0scripts\deploy-latest.mjs" %*
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
