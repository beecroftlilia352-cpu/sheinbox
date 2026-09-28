@echo off
rem Thin wrapper: firewall rule + UAC elevation handled inside allow-lan-firewall.ps1
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0allow-lan-firewall.ps1"
