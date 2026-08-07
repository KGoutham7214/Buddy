@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed or not in PATH.
  echo Install it from https://nodejs.org/ then try again.
  pause
  exit /b 1
)
if not exist "node_modules\" (
  echo First-time setup: installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)
call npm run preview
