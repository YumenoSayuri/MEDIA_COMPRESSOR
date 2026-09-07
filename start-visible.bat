@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
set SHOW_BROWSER=1
set ECHOWAVE_CONCURRENCY=2
start "EchoWave Local Automation (Visible)" cmd /k "npm start"
timeout /t 2 >nul
start "" http://localhost:3478
