const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const MAC_LABEL = "com.buddy.app";
const WIN_RUN_NAME = "Buddy";
const WIN_TASK_NAME = "BuddyAutostart";

function appRoot() {
  return path.resolve(path.join(__dirname, ".."));
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeVbs(value) {
  return String(value).replace(/"/g, '""');
}

function writeWindowsVbs(userData, root, electronExe) {
  const vbsPath = path.join(userData, "launch-buddy.vbs");
  const logPath = path.join(userData, "autostart.log");
  const content = [
    "' Silent Buddy login launcher (no console window).",
    "Option Explicit",
    "Dim shell, fso, root, electron, distIndex, logPath",
    "Set shell = CreateObject(\"WScript.Shell\")",
    "Set fso = CreateObject(\"Scripting.FileSystemObject\")",
    `root = "${escapeVbs(root)}"`,
    `electron = "${escapeVbs(electronExe)}"`,
    `logPath = "${escapeVbs(logPath)}"`,
    "distIndex = root & \"\\dist\\index.html\"",
    "",
    "Sub WriteLog(msg)",
    "  On Error Resume Next",
    "  Dim ts",
    "  Set ts = fso.OpenTextFile(logPath, 8, True)",
    "  ts.WriteLine Now & \" \" & msg",
    "  ts.Close",
    "  On Error GoTo 0",
    "End Sub",
    "",
    "If Not fso.FileExists(electron) Then",
    "  WriteLog \"missing electron: \" & electron",
    "  WScript.Quit 1",
    "End If",
    "",
    "If Not fso.FileExists(distIndex) Then",
    "  WriteLog \"missing dist; run Buddy once to build\"",
    "  WScript.Quit 1",
    "End If",
    "",
    "shell.CurrentDirectory = root",
    "WriteLog \"launching silent\"",
    "shell.Run \"\"\"\" & electron & \"\"\" \"\"\"\" & root & \"\"\"\", 0, False",
    "",
  ].join("\r\n");
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(vbsPath, content, "utf8");
  return vbsPath;
}

function runHiddenPowerShell(scriptText, scriptPath) {
  fs.writeFileSync(scriptPath, scriptText, "utf8");
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", scriptPath],
    { windowsHide: true, encoding: "utf8" }
  );
}

function setWindowsSilentBackup(enabled, userData, root, electronExe) {
  const registerPath = path.join(userData, "register-autostart.ps1");
  if (!enabled) {
    const disable = [
      "$ErrorActionPreference = 'Continue'",
      `Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${WIN_RUN_NAME}' -ErrorAction SilentlyContinue`,
      "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'electron.app.Electron' -ErrorAction SilentlyContinue",
      "$startupCmd = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Buddy.cmd'",
      "Remove-Item -Path $startupCmd -Force -ErrorAction SilentlyContinue",
      "Remove-Item -LiteralPath (Join-Path $env:APPDATA 'buddy\\autostart-buddy.cmd') -Force -ErrorAction SilentlyContinue",
      "Remove-Item -LiteralPath (Join-Path $env:APPDATA 'buddy\\start-buddy.ps1') -Force -ErrorAction SilentlyContinue",
      `Unregister-ScheduledTask -TaskName '${WIN_TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`,
      "Write-Output 'disabled Buddy autostart'",
    ].join("\r\n");
    const result = runHiddenPowerShell(disable, registerPath);
    if (result.status !== 0) {
      console.error("Failed to disable Windows autostart", result.stderr || result.stdout);
    }
    return;
  }

  const vbsPath = writeWindowsVbs(userData, root, electronExe);
  const safeVbs = vbsPath.replace(/'/g, "''");
  const enable = [
    "$ErrorActionPreference = 'Stop'",
    "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'electron.app.Electron' -ErrorAction SilentlyContinue",
    "$startupCmd = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Buddy.cmd'",
    "Remove-Item -Path $startupCmd -Force -ErrorAction SilentlyContinue",
    "Remove-Item -LiteralPath (Join-Path $env:APPDATA 'buddy\\autostart-buddy.cmd') -Force -ErrorAction SilentlyContinue",
    "Remove-Item -LiteralPath (Join-Path $env:APPDATA 'buddy\\start-buddy.ps1') -Force -ErrorAction SilentlyContinue",
    `$vbs = '${safeVbs}'`,
    `$run = 'wscript.exe //B //Nologo "' + $vbs + '"'`,
    `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${WIN_RUN_NAME}' -Value $run`,
    "Unregister-ScheduledTask -TaskName '" + WIN_TASK_NAME + "' -Confirm:$false -ErrorAction SilentlyContinue",
    "$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('//B //Nologo \"' + $vbs + '\"')",
    "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME",
    "$trigger.Delay = 'PT75S'",
    "try { $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::FromMinutes(15)) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) } catch { $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::FromMinutes(15)) }",
    `Register-ScheduledTask -TaskName '${WIN_TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
    "Write-Output 'registered silent Buddy autostart'",
  ].join("\r\n");

  const result = runHiddenPowerShell(enable, registerPath);
  if (result.status !== 0) {
    console.error("Failed to register Windows autostart", result.stderr || result.stdout);
  }
}

function macPlistPath() {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${MAC_LABEL}.plist`);
}

function setMacLaunchAgent(enabled, userData, root, electronExe) {
  const plistPath = macPlistPath();
  const agentsDir = path.dirname(plistPath);
  const outLog = path.join(userData, "autostart.log");
  const errLog = path.join(userData, "autostart.err");

  if (!enabled) {
    try {
      spawnSync("launchctl", ["unload", plistPath], { encoding: "utf8" });
    } catch {
      // ignore
    }
    try {
      if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
    } catch {
      // ignore
    }
    return;
  }

  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(electronExe)}</string>
    <string>${escapeXml(root)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(root)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(errLog)}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, plist, "utf8");
  try {
    spawnSync("launchctl", ["unload", plistPath], { encoding: "utf8" });
  } catch {
    // ignore if not loaded
  }
  const loaded = spawnSync("launchctl", ["load", plistPath], { encoding: "utf8" });
  if (loaded.status !== 0) {
    console.error("Failed to load Buddy LaunchAgent", loaded.stderr || loaded.stdout);
  }
}

function setElectronLoginItem(app, enabled, root, electronExe) {
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      openAsHidden: true,
      path: electronExe,
      args: [root],
    });
  } catch (err) {
    console.error("setLoginItemSettings failed", err);
  }
}

function desiredOpenAtLogin(db) {
  const config = db?.getConfig?.() || {};
  if (typeof config.openAtLogin === "boolean") return config.openAtLogin;
  return true;
}

function getAutoStart(app, db) {
  const openAtLogin = desiredOpenAtLogin(db);
  return { openAtLogin };
}

function setAutoStart(app, db, enabled) {
  const on = Boolean(enabled);
  const root = appRoot();
  const userData = app.getPath("userData");
  const electronExe = process.execPath;

  try {
    db.setConfig({ openAtLogin: on });
  } catch (err) {
    console.error("Failed to persist openAtLogin", err);
  }

  setElectronLoginItem(app, on, root, electronExe);

  if (process.platform === "win32") {
    setWindowsSilentBackup(on, userData, root, electronExe);
  } else if (process.platform === "darwin") {
    setMacLaunchAgent(on, userData, root, electronExe);
  }

  return { openAtLogin: on };
}

function applyAutoStartFromConfig(app, db) {
  return setAutoStart(app, db, desiredOpenAtLogin(db));
}

module.exports = {
  getAutoStart,
  setAutoStart,
  applyAutoStartFromConfig,
};
