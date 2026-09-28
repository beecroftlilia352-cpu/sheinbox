@echo off
rem Import the daily Chrome profile's login state (cookies) into the tool's own browser profile.
rem Add -Yes to skip the confirmation prompt (used for automated/agent runs).
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0import-chrome-login.ps1" %*
