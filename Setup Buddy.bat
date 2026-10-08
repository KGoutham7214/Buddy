@echo off
rem One-time Buddy setup: installs everything, starts Buddy,
rem and Buddy then starts itself at every sign-in.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\setup-buddy.ps1" %*
echo.
pause
