@echo off
rem Thin wrapper: messages live in the .ps1 (Chinese output needs PowerShell + UTF-8 console)
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-browser.ps1" %*
echo.
pause
