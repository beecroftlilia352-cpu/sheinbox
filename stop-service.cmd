@echo off
rem Thin wrapper: all messages live in stop-service.ps1 (Chinese output needs PowerShell + UTF-8 console)
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-service.ps1" %*
echo.
pause
