@echo off
rem Foreground debug mode (visible console + live log). Daily use: serve.cmd or the autostart entry
chcp 65001 >nul
cd /d "%~dp0"
set "PY=%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"
netstat -ano | findstr ":8901" | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo Service already listening on port 8901. Run stop-service.cmd first.
  pause
  exit /b 0
)
"%PY%" server.py
pause
