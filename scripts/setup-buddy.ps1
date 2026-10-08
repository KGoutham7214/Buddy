# Buddy first-time setup (Windows).
# Run once: installs dependencies, builds the UI, optionally prepares the
# Meet tab, then launches Buddy. Buddy registers itself to start at sign-in
# on its first launch, so after this script you never need to start it by hand.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-buddy.ps1
#   ... or double-click "Setup Buddy.bat" in the project root.
#
# Flags:
#   -NoMeet   skip the optional meeting-transcription setup (no prompt)
#   -NoLaunch set everything up but do not start Buddy at the end

param(
    [switch]$NoMeet,
    [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "   $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "   $msg" -ForegroundColor Yellow }

Write-Host "Buddy setup - $root"

# ---------------------------------------------------------------- Node.js
Step "Checking Node.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js is required and was not found." -ForegroundColor Red
    Write-Host "  1. Open https://nodejs.org and install the LTS version" -ForegroundColor Red
    Write-Host "  2. Keep 'Add to PATH' checked" -ForegroundColor Red
    Write-Host "  3. Open a NEW terminal and run this setup again" -ForegroundColor Red
    exit 1
}
Ok "Node $(node -v), npm $(npm -v)"

# ------------------------------------------------------------ dependencies
Step "Installing app dependencies"
if (Test-Path (Join-Path $root "node_modules\electron")) {
    Ok "node_modules already present - skipping npm install (delete the folder to force)"
} else {
    cmd /c "npm install"
    if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed." -ForegroundColor Red; exit 1 }
    Ok "npm install done"
}

# ------------------------------------------------------------------- build
Step "Building the UI"
cmd /c "npm run build"
if ($LASTEXITCODE -ne 0) { Write-Host "Build failed." -ForegroundColor Red; exit 1 }
Ok "dist/ built (the silent login launcher needs this)"

# ------------------------------------------------- optional: Meet tab deps
if (-not $NoMeet) {
    Step "Optional: meeting transcription (Meet tab)"
    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python) {
        Warn "Python not found - skipping. Notes and tasks work without it."
        Warn "To add Meet later: install Python 3.10+ (tick 'Add to PATH'), then rerun this setup."
    } else {
        $answer = Read-Host "   Python found. Install speech-to-text packages (faster-whisper, ~200 MB)? [Y/n]"
        if ($answer -eq "" -or $answer -match "^[Yy]") {
            cmd /c "python -m pip install --quiet faster-whisper onnxruntime kaldi-native-fbank"
            if ($LASTEXITCODE -eq 0) {
                Ok "Python packages installed (transcription + voice ID)"
            } else {
                Warn "pip install failed - the Meet tab will show 'Whisper missing' until you run:"
                Warn "    pip install faster-whisper onnxruntime kaldi-native-fbank"
            }
        } else {
            Warn "Skipped. Install later with: pip install faster-whisper onnxruntime kaldi-native-fbank"
        }
    }

    if (Get-Command ollama -ErrorAction SilentlyContinue) {
        Ok "Ollama found - make sure a model is pulled, e.g.: ollama pull llama3.2"
    } else {
        Warn "Ollama not found (meeting summaries). Optional: install from https://ollama.com, then: ollama pull llama3.2"
    }
}

# ------------------------------------------------------------------ launch
if ($NoLaunch) {
    Step "Done (launch skipped)"
    Write-Host "   Start Buddy with 'Start Buddy.bat' or 'npm start'."
    exit 0
}

Step "Starting Buddy"
$electron = Join-Path $root "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electron)) { Write-Host "Electron not found at $electron" -ForegroundColor Red; exit 1 }
Start-Process -FilePath $electron -ArgumentList "`"$root`"" -WorkingDirectory $root
Ok "Buddy is starting - look for the floating icon (drag it anywhere)"

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host " - Buddy registers itself to START AUTOMATICALLY at your next sign-in"
Write-Host "   (turn off in Settings -> Start at login)."
Write-Host " - Day to day you do nothing: sign in and the icon appears"
Write-Host "   (the backup task can take up to ~2 minutes)."
Write-Host " - Start it by hand anytime with 'Start Buddy.bat'."
Write-Host " - First meeting transcription downloads the Whisper model once; later runs are faster."
