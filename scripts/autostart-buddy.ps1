# Buddy login launcher. Safe under Task Scheduler (no cmd timeout).
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Electron,
  [Parameter(Mandatory = $true)][string]$Log,
  [Parameter(Mandatory = $true)][string]$PidFile
)

$ErrorActionPreference = "Continue"
$Root = $Root.Trim()
$Electron = $Electron.Trim()
$Log = $Log.Trim()
$PidFile = $PidFile.Trim()
$DistIndex = Join-Path $Root "dist\index.html"

function Write-Log([string]$msg) {
  $line = "{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $msg
  try {
    Add-Content -LiteralPath $Log -Value $line -Encoding UTF8
  } catch {}
}

function Get-BuddyProcess {
  Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object {
    try {
      $path = $_.Path
      if (-not $path) { return $false }
      return ($path -ieq $Electron)
    } catch {
      return $false
    }
  }
}

function Test-PidIsBuddy([string]$raw) {
  $idText = ($raw | Select-Object -First 1)
  if ($idText -notmatch '^\d+$') { return $false }
  $proc = Get-Process -Id ([int]$idText) -ErrorAction SilentlyContinue
  if (-not $proc) { return $false }
  try {
    return ($proc.ProcessName -ieq "electron")
  } catch {
    return $false
  }
}

Write-Log "autostart begin"

$ready = $false
for ($i = 0; $i -lt 90; $i++) {
  if ((Test-Path -LiteralPath $Electron) -and (Test-Path -LiteralPath $DistIndex)) {
    $ready = $true
    break
  }
  Write-Log "waiting for Buddy files ($i)"
  Start-Sleep -Seconds 2
}
if (-not $ready) {
  Write-Log "gave up waiting for Buddy files"
  exit 1
}

$existing = Get-BuddyProcess
if ($existing) {
  Write-Log ("already running electron pid " + (($existing | Select-Object -First 1).Id))
  exit 0
}

if (Test-Path -LiteralPath $PidFile) {
  $old = Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue
  if (Test-PidIsBuddy $old) {
    Write-Log ("already running pid file " + $old)
    exit 0
  }
}

$started = $null
for ($attempt = 1; $attempt -le 3; $attempt++) {
  Write-Log "launching attempt $attempt"
  try {
    # Quote the project path so spaces (e.g. OneDrive folder names) stay one argument.
    $quotedRoot = '"' + $Root + '"'
    $started = Start-Process -FilePath $Electron -ArgumentList $quotedRoot -WorkingDirectory $Root -PassThru
    Write-Log ("started process id " + $started.Id)
  } catch {
    Write-Log ("Start-Process FAILED: " + $_.Exception.Message)
    Start-Sleep -Seconds 4
    continue
  }

  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    $alive = Get-BuddyProcess
    if ($alive) {
      Write-Log ("verified electron pid " + (($alive | Select-Object -First 1).Id))
      exit 0
    }
    if (Test-Path -LiteralPath $PidFile) {
      $new = Get-Content -LiteralPath $PidFile -ErrorAction SilentlyContinue
      if (Test-PidIsBuddy $new) {
        Write-Log ("verified pid file " + $new)
        exit 0
      }
    }
  }

  Write-Log "attempt $attempt did not stay running"
  Start-Sleep -Seconds 3
}

if ($started -and $started.HasExited) {
  Write-Log ("electron exit code " + $started.ExitCode)
}
Write-Log "WARNING: Buddy did not stay running"
exit 1
