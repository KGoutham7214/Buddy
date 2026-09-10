const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  desktopCapturer,
  Menu,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { createDb } = require("./db.cjs");
const { checkWhisper } = require("./transcribe.cjs");
const { checkOllama } = require("./ollama.cjs");
const reminders = require("./reminders.cjs");
const speakers = require("./speakers.cjs");
const qdrant = require("./qdrant.cjs");
const voiceService = require("./voiceService.cjs");
const meetingPipeline = require("./meetingPipeline.cjs");

const ICON_SIZE = 52;
const PANEL_WIDTH = 400;
const PANEL_HEIGHT = 580;
const PANEL_MIN_W = 300;
const PANEL_MIN_H = 380;
/** Icon + manga speech bubble chrome */
const BUBBLE_WIDTH = 320;
const BUBBLE_HEIGHT = 200;
const COLOR_SWATCH = 20;
const COLOR_GAP = 5;
const COLOR_PAD = 8;
const DEV_URL = process.env.VITE_DEV_SERVER_URL || "";
const RECORDING_BG = "#c45c5c";
const ICON_THEMES = [
  { id: "sand", label: "Sand", idle: "#c4a574" },
  { id: "ocean", label: "Ocean", idle: "#5d8aa8" },
  { id: "sage", label: "Sage", idle: "#7d9b78" },
  { id: "rose", label: "Rose", idle: "#c47a8a" },
];

/** @type {BrowserWindow | null} */
let win = null;
/** @type {ReturnType<typeof createDb> | null} */
let db = null;
/** @type {"icon" | "panel"} */
let mode = "icon";
/** @type {{ x: number, y: number } | null} */
let dragOffset = null;
/** @type {{ width: number, height: number } | null} */
let dragSize = null;
/** Coalesce rapid drag IPC so Windows doesn't leave icon ghosts */
let dragMoveTimer = null;
let dragMovePending = null;
/** Remembered icon anchor — panel expand must not overwrite this */
let iconPos = { x: null, y: null };
/** Remembered panel position */
let panelPos = { x: null, y: null };
/** Remembered panel size — kept across icon/panel toggles like iconPos */
let panelSize = { width: PANEL_WIDTH, height: PANEL_HEIGHT };
/** Skip persist while we programmatically resize/move between modes */
let suppressPersist = false;
/** Icon turns red while a meeting is being recorded/processed */
let isRecording = false;
/** Manga reminder bubble attached to the floating icon */
let bubbleActive = false;
/** Horizontal color swatches next to the floating icon */
let colorPickerActive = false;
/** In-flight icon↔panel morph */
let modeAnimTimer = null;

function iconThemeId() {
  const id = db?.getConfig()?.iconColor;
  return ICON_THEMES.some((theme) => theme.id === id) ? id : "sand";
}

function iconIdleBg() {
  return (
    ICON_THEMES.find((theme) => theme.id === iconThemeId())?.idle || "#c4a574"
  );
}

function iconWindowBg() {
  if (bubbleActive) return "#f4efe6";
  if (colorPickerActive) return "#1a1c20";
  if (isRecording) return RECORDING_BG;
  return iconIdleBg();
}

function applyIconWindowBg() {
  if (!win || win.isDestroyed() || mode !== "icon") return;
  win.setBackgroundColor(iconWindowBg());
}

function setIconColor(id) {
  const theme = ICON_THEMES.find((item) => item.id === id) || ICON_THEMES[0];
  db?.setConfig({ iconColor: theme.id });
  applyIconWindowBg();
  win?.webContents.send("icon:color", theme.id);
  return theme.id;
}

function normalizeUserName(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

function currentUserName() {
  return normalizeUserName(db?.getConfig()?.userName || "");
}

function setUserName(value) {
  const userName = normalizeUserName(value);
  db?.setConfig({ userName });
  return userName;
}

function clampBounds(width, height, x, y) {
  const display = screen.getDisplayNearestPoint({ x, y });
  const work = display.workArea;
  let nextX = x;
  let nextY = y;
  let nextW = width;
  let nextH = height;

  if (nextW > work.width) nextW = work.width;
  if (nextH > work.height) nextH = work.height;

  if (nextX + nextW > work.x + work.width) {
    nextX = work.x + work.width - nextW;
  }
  if (nextY + nextH > work.y + work.height) {
    nextY = work.y + work.height - nextH;
  }
  if (nextX < work.x) nextX = work.x;
  if (nextY < work.y) nextY = work.y;
  return { x: nextX, y: nextY, width: nextW, height: nextH };
}

function normalizePanelSize(width, height) {
  const w =
    typeof width === "number" && width >= PANEL_MIN_W ? width : PANEL_WIDTH;
  const h =
    typeof height === "number" && height >= PANEL_MIN_H ? height : PANEL_HEIGHT;
  return { width: Math.round(w), height: Math.round(h) };
}

function panelSizeFromConfig() {
  const config = db?.getConfig() || {};
  return normalizePanelSize(config.panelWidth, config.panelHeight);
}

/** Windows rejects min>max; always unlock max before raising min (and the reverse). */
function applyPanelChrome() {
  if (!win) return;
  win.setResizable(true);
  win.setMaximumSize(10000, 10000);
  win.setMinimumSize(PANEL_MIN_W, PANEL_MIN_H);
}

function unlockForMorph() {
  if (!win) return;
  win.setResizable(true);
  win.setMaximumSize(10000, 10000);
  win.setMinimumSize(ICON_SIZE, ICON_SIZE);
}

function easeOutCubic(t) {
  return 1 - (1 - t) ** 3;
}

function stopModeAnimation() {
  if (modeAnimTimer) {
    clearInterval(modeAnimTimer);
    modeAnimTimer = null;
  }
}

function animateBounds(from, to, durationMs, onDone) {
  stopModeAnimation();
  if (!win) {
    onDone?.();
    return;
  }
  const start = Date.now();
  const tick = () => {
    if (!win) {
      stopModeAnimation();
      onDone?.();
      return;
    }
    const t = Math.min(1, (Date.now() - start) / durationMs);
    const e = easeOutCubic(t);
    win.setBounds(
      {
        x: Math.round(from.x + (to.x - from.x) * e),
        y: Math.round(from.y + (to.y - from.y) * e),
        width: Math.round(from.width + (to.width - from.width) * e),
        height: Math.round(from.height + (to.height - from.height) * e),
      },
      false
    );
    if (t >= 1) {
      stopModeAnimation();
      win.setBounds(to, false);
      onDone?.();
    }
  };
  tick();
  modeAnimTimer = setInterval(tick, 16);
}

function iconChrome() {
  if (bubbleActive) return { width: BUBBLE_WIDTH, height: BUBBLE_HEIGHT };
  if (colorPickerActive) {
    const tray =
      COLOR_PAD * 2 +
      ICON_THEMES.length * COLOR_SWATCH +
      (ICON_THEMES.length - 1) * COLOR_GAP +
      6 +
      ICON_SIZE;
    return { width: tray, height: ICON_SIZE };
  }
  return { width: ICON_SIZE, height: ICON_SIZE };
}

function iconPosFromWindow(x, y) {
  const chrome = iconChrome();
  return {
    x: x + (chrome.width - ICON_SIZE),
    y: y + (chrome.height - ICON_SIZE),
  };
}

function applyIconChrome() {
  if (!win) return;
  win.setResizable(true);
  win.setMaximumSize(10000, 10000);
  const { width, height } = iconChrome();
  win.setMinimumSize(width, height);
  win.setMaximumSize(width, height);
  win.setResizable(false);
}

function iconLayoutBounds() {
  const { width, height } = iconChrome();
  const fallback = defaultIconPos();
  const ix = typeof iconPos.x === "number" ? iconPos.x : fallback.x;
  const iy = typeof iconPos.y === "number" ? iconPos.y : fallback.y;
  const x = ix - (width - ICON_SIZE);
  const y = iy - (height - ICON_SIZE);
  return ensureOnScreen(width, height, x, y);
}

function layoutIconWindow() {
  if (!win || win.isDestroyed() || mode !== "icon") return;
  applyIconChrome();
  win.setBackgroundColor(iconWindowBg());
  win.setBounds(iconLayoutBounds(), false);
}

function setColorPickerActive(active) {
  if (!win || mode !== "icon") {
    colorPickerActive = false;
    return false;
  }
  if (active && bubbleActive) return false;
  colorPickerActive = Boolean(active);
  suppressPersist = true;
  try {
    layoutIconWindow();
    win.webContents.send("icon:color-picker", colorPickerActive);
  } finally {
    setTimeout(() => {
      suppressPersist = false;
    }, 200);
  }
  return colorPickerActive;
}

function setBubbleActive(active) {
  if (!win || mode !== "icon") {
    bubbleActive = false;
    return false;
  }
  bubbleActive = Boolean(active);
  if (bubbleActive) colorPickerActive = false;
  suppressPersist = true;
  try {
    layoutIconWindow();
    if (bubbleActive) {
      win.webContents.send("icon:color-picker", false);
    }
  } finally {
    setTimeout(() => {
      suppressPersist = false;
    }, 200);
  }
  return bubbleActive;
}

function rememberPanelSize(width, height) {
  // Ignore icon-sized glitches from constraint/resize races
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    width < PANEL_MIN_W ||
    height < PANEL_MIN_H
  ) {
    return false;
  }
  panelSize = { width: Math.round(width), height: Math.round(height) };
  return true;
}

function defaultIconPos() {
  const display = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(display.x + display.width - ICON_SIZE - 24),
    y: Math.round(display.y + display.height - ICON_SIZE - 24),
  };
}

/** Keep the window on a real display (multi-monitor configs go stale after reboot). */
function ensureOnScreen(width, height, x, y) {
  const displays = screen.getAllDisplays();
  const visible = displays.some((d) => {
    const w = d.workArea;
    const overlapW = Math.min(x + width, w.x + w.width) - Math.max(x, w.x);
    const overlapH = Math.min(y + height, w.y + w.height) - Math.max(y, w.y);
    return overlapW > width * 0.25 && overlapH > height * 0.25;
  });
  if (!visible) {
    const fallback = defaultIconPos();
    return clampBounds(width, height, fallback.x, fallback.y);
  }
  return clampBounds(width, height, x, y);
}

function loadPositionsFromConfig() {
  const config = db?.getConfig() || {};
  const fallback = defaultIconPos();
  iconPos = {
    x: typeof config.iconX === "number" ? config.iconX : fallback.x,
    y: typeof config.iconY === "number" ? config.iconY : fallback.y,
  };
  panelPos = {
    x: typeof config.panelX === "number" ? config.panelX : iconPos.x,
    y: typeof config.panelY === "number" ? config.panelY : iconPos.y,
  };
  panelSize = panelSizeFromConfig();
}

function persistPanelMemory() {
  if (!db) return;
  db.setConfig({
    mode,
    iconX: iconPos.x,
    iconY: iconPos.y,
    panelX: panelPos.x,
    panelY: panelPos.y,
    panelWidth: panelSize.width,
    panelHeight: panelSize.height,
  });
}

function applyWindowMode(nextMode) {
  if (!win) return;
  const prev = mode;
  mode = nextMode === "panel" ? "panel" : "icon";
  const bounds = win.getBounds();
  suppressPersist = true;
  stopModeAnimation();

  const finish = () => {
    persistPanelMemory();
    setTimeout(() => {
      suppressPersist = false;
    }, 80);
  };

  if (mode === "panel") {
    if (prev === "icon") {
      iconPos = iconPosFromWindow(bounds.x, bounds.y);
      bubbleActive = false;
      colorPickerActive = false;
      panelSize = panelSizeFromConfig();
    } else {
      bubbleActive = false;
      colorPickerActive = false;
    }
    const size = normalizePanelSize(panelSize.width, panelSize.height);
    panelSize = size;
    const px = typeof panelPos.x === "number" ? panelPos.x : bounds.x;
    const py = typeof panelPos.y === "number" ? panelPos.y : bounds.y;
    const next = ensureOnScreen(size.width, size.height, px, py);
    const display = screen.getDisplayNearestPoint({ x: next.x, y: next.y });
    next.width = Math.min(size.width, display.workArea.width);
    next.height = Math.min(size.height, display.workArea.height);
    panelSize = { width: next.width, height: next.height };
    panelPos = { x: next.x, y: next.y };
    unlockForMorph();
    win.setBackgroundColor("#141414");
    if (prev === "icon") {
      animateBounds(bounds, next, 260, () => {
        applyPanelChrome();
        finish();
      });
    } else {
      win.setBounds(next, false);
      applyPanelChrome();
      finish();
    }
    return;
  }

  if (prev === "panel") {
    panelPos = { x: bounds.x, y: bounds.y };
    rememberPanelSize(bounds.width, bounds.height);
  }
  bubbleActive = false;
  colorPickerActive = false;
  const onScreen = iconLayoutBounds();
  iconPos = { x: onScreen.x, y: onScreen.y };
  unlockForMorph();
  win.setBackgroundColor(iconWindowBg());
  if (prev === "panel") {
    animateBounds(bounds, onScreen, 200, () => {
      applyIconChrome();
      finish();
    });
  } else {
    applyIconChrome();
    win.setBounds(onScreen, false);
    finish();
  }
}

function persistBounds() {
  if (!win || !db || suppressPersist) return;
  const { x, y, width, height } = win.getBounds();
  if (mode === "panel") {
    panelPos = { x, y };
    rememberPanelSize(width, height);
    persistPanelMemory();
  } else {
    // When the manga bubble is open, iconPos is the icon square (bottom-right)
    if (bubbleActive) {
      iconPos = {
        x: x + (BUBBLE_WIDTH - ICON_SIZE),
        y: y + (BUBBLE_HEIGHT - ICON_SIZE),
      };
    } else {
      iconPos = { x, y };
    }
    persistPanelMemory();
  }
}

async function migrateVoicesToQdrant() {
  if (!db) return;
  const legacy = db.listVoiceEmbeddings();
  if (!legacy.length) return;
  const reachable = await qdrant.check();
  if (!reachable.ok) return;
  const moved = await qdrant.migrateVoices(legacy);
  if (moved.ok) db.clearVoices();
}

function createWindow() {
  db = createDb(app.getPath("userData"));
  voiceService.init(db);
  const config = db.getConfig();
  mode = config.mode === "panel" ? "panel" : "icon";
  loadPositionsFromConfig();
  // Migrate older configs that only stored x/y
  if (typeof config.iconX !== "number" && typeof config.x === "number") {
    iconPos = { x: config.x, y: config.y };
  }
  const panel = panelSizeFromConfig();
  const startSize =
    mode === "panel"
      ? { width: panel.width, height: panel.height }
      : { width: ICON_SIZE, height: ICON_SIZE };
  const startPos = ensureOnScreen(
    startSize.width,
    startSize.height,
    mode === "panel" ? panelPos.x : iconPos.x,
    mode === "panel" ? panelPos.y : iconPos.y
  );
  if (mode === "icon") {
    iconPos = { x: startPos.x, y: startPos.y };
  } else {
    panelPos = { x: startPos.x, y: startPos.y };
  }

  win = new BrowserWindow({
    width: startSize.width,
    height: startSize.height,
    x: startPos.x,
    y: startPos.y,
    frame: false,
    transparent: false,
    // thickFrame enables standard corner/edge resize on Windows frameless windows
    thickFrame: true,
    autoHideMenuBar: true,
    title: "Buddy",
    alwaysOnTop: true,
    resizable: mode === "panel",
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    roundedCorners: true,
    show: false,
    backgroundColor: mode === "panel" ? "#141414" : iconIdleBg(),
    paintWhenInitiallyHidden: true,
    minWidth: mode === "panel" ? PANEL_MIN_W : ICON_SIZE,
    minHeight: mode === "panel" ? PANEL_MIN_H : ICON_SIZE,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.removeMenu();
  win.setAlwaysOnTop(true, "screen-saver");

  win.webContents.session.setPermissionRequestHandler(
    (_wc, permission, callback) => {
      if (
        permission === "media" ||
        permission === "display-capture" ||
        permission === "mediaKeySystem"
      ) {
        callback(true);
        return;
      }
      callback(false);
    }
  );

  win.webContents.on("context-menu", (event) => {
    event.preventDefault();
  });

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error("Failed to load", url, code, desc);
  });

  if (DEV_URL) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  win.once("ready-to-show", () => {
    applyWindowMode(mode);
    win.show();
    win.webContents.send("app:mode", mode);
  });

  win.on("moved", () => {
    // While dragging we own position; don't persist mid-drag (size can jitter on Windows)
    if (dragOffset || suppressPersist) return;
    persistBounds();
  });
  win.on("resize", () => {
    // thickFrame often emits resize while moving — never learn size during a drag
    if (dragOffset || suppressPersist || mode !== "panel" || !win) return;
    const { width, height } = win.getBounds();
    rememberPanelSize(width, height);
  });
  win.on("resized", () => {
    if (dragOffset || suppressPersist || mode !== "panel") return;
    persistBounds();
  });
  // Stay running: Alt+F4 / system close collapses to icon instead of quitting
  win.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      applyWindowMode("icon");
      win?.webContents.send("app:mode", mode);
    }
  });
  win.on("closed", () => {
    win = null;
  });
}

function quotePs(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function enableAutoStart() {
  // Dual login path: delayed Scheduled Task + HKCU Run. Both call the same
  // PowerShell launcher (cmd `timeout` is broken under Task Scheduler).
  // Single-instance lock prevents two icons if both fire.
  const root = path.resolve(path.join(__dirname, ".."));
  const userData = app.getPath("userData");
  const electronExe = process.execPath;
  const srcLauncher = path.join(root, "scripts", "autostart-buddy.ps1");
  const destLauncher = path.join(userData, "autostart-buddy.ps1");
  const wrapperPath = path.join(userData, "start-buddy.ps1");
  const logPath = path.join(userData, "autostart.log");
  const pidPath = path.join(userData, "buddy.pid");

  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.copyFileSync(srcLauncher, destLauncher);
    const wrapper = [
      "$ErrorActionPreference = 'Continue'",
      `& ${quotePs(destLauncher)} -Root ${quotePs(root)} -Electron ${quotePs(electronExe)} -Log ${quotePs(logPath)} -PidFile ${quotePs(pidPath)}`,
      "exit $LASTEXITCODE",
      "",
    ].join("\r\n");
    fs.writeFileSync(wrapperPath, wrapper, "utf8");
  } catch (err) {
    console.error("Failed to write Buddy autostart launcher", err);
    return;
  }

  try {
    app.setLoginItemSettings({ openAtLogin: false });
    app.setLoginItemSettings({
      openAtLogin: false,
      path: process.execPath,
      args: [root],
    });
  } catch {
    // ignore
  }

  try {
    const { spawnSync } = require("child_process");
    const ps1Path = path.join(userData, "register-autostart.ps1");
    const safeWrapper = wrapperPath.replace(/'/g, "''");
    fs.writeFileSync(
      ps1Path,
      [
        "$ErrorActionPreference = 'Stop'",
        "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'electron.app.Electron' -ErrorAction SilentlyContinue",
        "$startupCmd = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Buddy.cmd'",
        "Remove-Item -Path $startupCmd -Force -ErrorAction SilentlyContinue",
        "Remove-Item -LiteralPath (Join-Path $env:APPDATA 'buddy\\autostart-buddy.cmd') -Force -ErrorAction SilentlyContinue",
        `$wrapper = '${safeWrapper}'`,
        `$arg = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $wrapper + '"'`,
        "Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'Buddy' -Value ('powershell.exe ' + $arg)",
        "$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg",
        "$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME",
        "$trigger.Delay = 'PT75S'",
        "try { $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::FromMinutes(15)) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) } catch { $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::FromMinutes(15)) }",
        "Register-ScheduledTask -TaskName 'BuddyAutostart' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null",
        "Write-Output 'registered BuddyAutostart'",
      ].join("\r\n"),
      "utf8"
    );

    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1Path],
      { windowsHide: true, encoding: "utf8" }
    );
    if (result.status !== 0) {
      console.error(
        "Failed to register Buddy autostart",
        result.stderr || result.stdout
      );
    }
  } catch (err) {
    console.error("Failed to enable Buddy autostart", err);
  }
}

function registerIpc() {
  ipcMain.handle("app:getState", () => ({
    mode,
    userDataPath: app.getPath("userData"),
    iconColor: iconThemeId(),
    userName: currentUserName(),
    capabilities: {
      meet: true,
      voiceId: true,
      floatingShell: true,
    },
  }));
  ipcMain.handle("app:setIconColor", (_e, id) => setIconColor(id));
  ipcMain.handle("app:setUserName", (_e, value) => setUserName(value));
  ipcMain.handle("app:setColorPicker", (_e, active) =>
    setColorPickerActive(Boolean(active))
  );

  ipcMain.handle("app:setMode", (_event, nextMode) => {
    if (nextMode === "panel") {
      bubbleActive = false;
      colorPickerActive = false;
    }
    applyWindowMode(nextMode === "panel" ? "panel" : "icon");
    // Persist after mode switch settles (iconX kept when opening panel)
    setTimeout(() => persistBounds(), 60);
    win?.webContents.send("app:mode", mode);
    return mode;
  });

  ipcMain.handle("reminders:pending", () => {
    if (!db) return [];
    return reminders.listPending(db);
  });

  ipcMain.handle("reminders:markShown", (_e, id) => {
    if (!db || !id) return null;
    return reminders.markShown(db, String(id));
  });

  ipcMain.handle("reminders:dismiss", (_e, id) => {
    if (!db || !id) return null;
    const entry = reminders.dismiss(db, String(id));
    setBubbleActive(false);
    win?.webContents.send("app:mode", mode);
    return entry;
  });

  ipcMain.handle("reminders:snooze", (_e, id, hours) => {
    if (!db || !id) return null;
    const entry = reminders.snooze(db, String(id), hours || 1);
    setBubbleActive(false);
    win?.webContents.send("app:mode", mode);
    return entry;
  });

  ipcMain.handle("reminders:setBubble", (_e, active) => {
    return setBubbleActive(Boolean(active));
  });

  ipcMain.handle("app:setRecording", (_event, active) => {
    isRecording = Boolean(active);
    if (!win) return false;
    if (mode === "icon") applyIconWindowBg();
    return true;
  });

  ipcMain.on("icon:context-menu", (_event, payload) => {
    if (!win || win.isDestroyed()) return;
    const phase = payload?.phase || "idle";
    const template = [];

    if (phase === "idle") {
      template.push({
        label: "Record meeting",
        click: () => win?.webContents.send("icon:menu-action", "record"),
      });
    }
    if (phase === "recording") {
      template.push(
        {
          label: "Stop & process",
          click: () => win?.webContents.send("icon:menu-action", "stop"),
        },
        {
          label: "Cancel recording",
          click: () => win?.webContents.send("icon:menu-action", "cancel"),
        }
      );
    }
    if (phase === "processing") {
      template.push({
        label: "Processing…",
        enabled: false,
      });
    }

    template.push(
      { type: "separator" },
      {
        label: "Theme",
        submenu: ICON_THEMES.map((theme) => ({
          label: theme.label,
          type: "radio",
          checked: theme.id === iconThemeId(),
          click: () => setIconColor(theme.id),
        })),
      },
      {
        label: "Open Buddy",
        click: () => win?.webContents.send("icon:menu-action", "open"),
      }
    );

    const menu = Menu.buildFromTemplate(template);
    const x = Number.isFinite(payload?.x) ? Math.round(payload.x) : undefined;
    const y = Number.isFinite(payload?.y) ? Math.round(payload.y) : undefined;

    // Native menus sit below "screen-saver" always-on-top on Windows.
    win.focus();
    win.setAlwaysOnTop(true, "floating");
    const restoreZ = () => {
      if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, "screen-saver");
    };
    setImmediate(() => {
      if (!win || win.isDestroyed()) return;
      menu.popup({
        window: win,
        ...(x != null && y != null ? { x, y } : {}),
        callback: restoreZ,
      });
    });
  });

  ipcMain.on("window:drag-start", (_event, { screenX, screenY }) => {
    if (!win) return;
    const bounds = win.getBounds();
    dragOffset = { x: screenX - bounds.x, y: screenY - bounds.y };
    // Freeze size for the whole gesture — Windows thickFrame otherwise grows the panel
    dragSize = { width: bounds.width, height: bounds.height };
    dragMovePending = null;
    if (dragMoveTimer) {
      clearTimeout(dragMoveTimer);
      dragMoveTimer = null;
    }
    // Block OS resize-from-move while dragging
    win.setResizable(false);
  });

  ipcMain.on("window:drag-move", (_event, { screenX, screenY }) => {
    if (!win || !dragOffset || !dragSize) return;
    const nextX = Math.round(screenX - dragOffset.x);
    const nextY = Math.round(screenY - dragOffset.y);
    const clamped = clampBounds(
      dragSize.width,
      dragSize.height,
      nextX,
      nextY
    );
    dragMovePending = {
      x: clamped.x,
      y: clamped.y,
      width: dragSize.width,
      height: dragSize.height,
    };
    if (dragMoveTimer) return;
    dragMoveTimer = setTimeout(() => {
      dragMoveTimer = null;
      if (!win || !dragMovePending || !dragSize) return;
      // Always re-assert the locked size — setPosition-only lets Windows inflate it
      win.setBounds(
        {
          x: dragMovePending.x,
          y: dragMovePending.y,
          width: dragSize.width,
          height: dragSize.height,
        },
        false
      );
      dragMovePending = null;
    }, 16);
  });

  ipcMain.on("window:drag-end", () => {
    if (dragMoveTimer) {
      clearTimeout(dragMoveTimer);
      dragMoveTimer = null;
    }
    if (win && dragSize) {
      const b = win.getBounds();
      const x = dragMovePending?.x ?? b.x;
      const y = dragMovePending?.y ?? b.y;
      win.setBounds(
        {
          x,
          y,
          width: dragSize.width,
          height: dragSize.height,
        },
        false
      );
      if (mode === "panel") {
        panelPos = { x, y };
        rememberPanelSize(dragSize.width, dragSize.height);
      } else {
        iconPos = iconPosFromWindow(x, y);
      }
    }
    dragMovePending = null;
    dragOffset = null;
    dragSize = null;
    // Restore resize only for the panel
    if (win) win.setResizable(mode === "panel");
    // Bubble layout keeps a fixed outer size
    if (mode === "icon" && (bubbleActive || colorPickerActive)) {
      applyIconChrome();
    }
    persistBounds();
  });

  ipcMain.handle("notes:list", () => db.listNotes());
  ipcMain.handle("notes:create", (_e, payload) => db.createNote(payload || {}));
  ipcMain.handle("notes:update", (_e, id, payload) =>
    db.updateNote(id, payload || {})
  );
  ipcMain.handle("notes:delete", (_e, id) => {
    const note = db.deleteNote(id);
    if (note?.audioPath) {
      try {
        const full = path.isAbsolute(note.audioPath)
          ? note.audioPath
          : path.join(app.getPath("userData"), note.audioPath);
        if (fs.existsSync(full)) fs.unlinkSync(full);
      } catch {
        /* ignore */
      }
    }
    return true;
  });

  ipcMain.handle("tasks:list", () => db.listTasks());
  ipcMain.handle("tasks:create", (_e, payload) => db.createTask(payload || {}));
  ipcMain.handle("tasks:update", (_e, id, payload) =>
    db.updateTask(id, payload || {})
  );
  ipcMain.handle("tasks:delete", (_e, id) => db.deleteTask(id));

  ipcMain.handle("meeting:desktopSource", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: 1, height: 1 },
    });
    return sources[0]?.id || null;
  });

  ipcMain.handle("meeting:checkDeps", async () => {
    const [whisper, ollama, speaker, qdrantStatus] = await Promise.all([
      checkWhisper(),
      checkOllama(),
      speakers.check(),
      qdrant.check(),
    ]);
    return { whisper, ollama, speakers: speaker, qdrant: qdrantStatus };
  });

  ipcMain.handle("meeting:getSettings", () => meetingPipeline.getMeetSettings(db));
  ipcMain.handle("meeting:setSettings", (_e, partial) =>
    meetingPipeline.setMeetSettings(db, partial || {})
  );

  ipcMain.handle("meeting:process", async (_e, payload) => {
    return meetingPipeline.processMeeting(payload, {
      db,
      onProgress: (message) => win?.webContents.send("meeting:progress", message),
    });
  });

  ipcMain.handle("meeting:summarize", async (_e, noteId) => {
    return meetingPipeline.summarizeNote(noteId, {
      db,
      onProgress: (message) => win?.webContents.send("meeting:progress", message),
    });
  });

  ipcMain.handle("voices:list", () => voiceService.listVoices());
  ipcMain.handle("voices:delete", (_e, id) => voiceService.deleteVoice(id));
  ipcMain.handle("voices:resetSession", () => voiceService.resetSession());
  ipcMain.handle("voices:enroll", (_e, payload) => voiceService.enrollVoice(payload));
  ipcMain.handle("voices:identify", (_e, payload) =>
    voiceService.identifySpeaker(payload)
  );
}

app.isQuitting = false;

// Prevent stacked icons from Run + Startup + Task all launching Buddy
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // Write pid ASAP so the login launcher can verify before whenReady finishes
  try {
    const earlyPid = path.join(app.getPath("userData"), "buddy.pid");
    fs.mkdirSync(path.dirname(earlyPid), { recursive: true });
    fs.writeFileSync(earlyPid, String(process.pid), "utf8");
  } catch {
    // ignore
  }

  app.on("second-instance", () => {
    if (!win) {
      if (app.isReady()) createWindow();
      return;
    }
    if (mode === "icon") {
      const chrome = iconChrome();
      const onScreen = ensureOnScreen(
        chrome.width,
        chrome.height,
        iconPos.x ?? win.getBounds().x,
        iconPos.y ?? win.getBounds().y
      );
      win.setBounds(onScreen, false);
    }
    if (!win.isVisible()) win.show();
    win.setAlwaysOnTop(true, "screen-saver");
    win.focus();
  });
}

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;

  try {
    app.setAppUserModelId("com.onelern.buddy");
  } catch {
    // ignore
  }

  try {
    const pidPath = path.join(app.getPath("userData"), "buddy.pid");
    fs.writeFileSync(pidPath, String(process.pid), "utf8");
  } catch {
    // ignore
  }

  speakers.init(path.join(app.getPath("userData"), "speaker-models"));
  registerIpc();
  createWindow();
  void migrateVoicesToQdrant();
  setInterval(() => {
    if (!db || !win) return;
    const due = reminders.listPending(db).filter((r) => r.kind === "task");
    if (due.length > 0) {
      win.webContents.send("reminders:due");
    }
  }, 20000);
  // Register login task after UI is up so a permission hiccup can't block launch
  setTimeout(() => {
    try {
      enableAutoStart();
    } catch (err) {
      console.error("enableAutoStart failed", err);
    }
  }, 1500);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Stay resident even if no windows are open
app.on("window-all-closed", () => {});

app.on("before-quit", () => {
  app.isQuitting = true;
  persistBounds();
  speakers.stop();
  try {
    const pidPath = path.join(app.getPath("userData"), "buddy.pid");
    if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath);
  } catch {
    // ignore
  }
});
