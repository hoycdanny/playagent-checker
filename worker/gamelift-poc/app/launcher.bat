@echo off
rem GameLift Streams entry point: run the PowerShell test script and wait (script exit = stream session ends).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher.ps1"
