@echo off
rem EchoLingo launcher: double-click to start the server and open the browser.
setlocal
cd /d "%~dp0"
set "URL=http://localhost:5173"

rem Already running? Just open the browser.
netstat -ano | findstr /r /c:":5173 .*LISTENING" >nul
if not errorlevel 1 (
    start "" "%URL%"
    exit /b 0
)

rem Open the browser as soon as the server responds (waits up to 90 seconds).
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 90;$i++){try{Invoke-WebRequest $env:URL -UseBasicParsing -TimeoutSec 2 | Out-Null; Start-Process $env:URL; break}catch{Start-Sleep 1}}"

echo Starting EchoLingo... Keep this window open while using it. Close it to stop.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\start.ps1"
if errorlevel 1 pause
