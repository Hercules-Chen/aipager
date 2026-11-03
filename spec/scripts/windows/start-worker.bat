@echo off
rem Claude Relay worker launcher (ASCII only, CRLF). Chain: .bat -> .ps1 -> node
setlocal
pushd "%~dp0"
echo [start-worker] script dir = %CD%
echo [start-worker] calling start-worker.ps1 ...
powershell -NoProfile -ExecutionPolicy Bypass -File ".\start-worker.ps1" %*
set RC=%ERRORLEVEL%
echo [start-worker] exit code = %RC%
popd
endlocal & exit /b %RC%
