@echo off
rem Daily entry: start service in background (no console) and open the page
chcp 65001 >nul
cd /d "%~dp0"
set "PY=%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\pythonw.exe"
if not exist "%PY%" set "PY=pythonw"
start "" "%PY%" "%~dp0server.py"
powershell -NoProfile -Command "Start-Sleep -Milliseconds 1500" >nul
start "" http://127.0.0.1:8901/
