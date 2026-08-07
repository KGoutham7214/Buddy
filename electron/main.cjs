const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
} = require("electron");
const path = require("path");
const { createDb } = require("./db.cjs");

const ICON_SIZE = 52;
const PANEL_WIDTH = 400;
const PANEL_HEIGHT = 580;
const PANEL_MIN_W = 320;
const PANEL_MIN_H = 420;
const DEV_URL = process.env.VITE_DEV_SERVER_URL || "";

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
/** Remembered icon anchor — panel expand must not overwrite this */
let iconPos = { x: null, y: null };
/** Remembered panel position */
let panelPos = { x: null, y: null };
/** Skip persist while we programmatically resize/move between modes */
let suppressPersist = false;

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

function panelSizeFromConfig() {
  const config = db?.getConfig() || {};
  const width =
    typeof config.panelWidth === "number" && config.panelWidth >= PANEL_MIN_W
      ? config.panelWidth
      : PANEL_WIDTH;
  const height =
    typeof config.panelHeight === "number" && config.panelHeight >= PANEL_MIN_H
      ? config.panelHeight
      : PANEL_HEIGHT;
  return { width, height };
}

function defaultIconPos() {
  const display = screen.getPrimaryDisplay().workArea;
  return {
    x: Math.round(display.x + display.width - ICON_SIZE - 24),
    y: Math.round(display.y + display.height - ICON_SIZE - 24),
  };
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
}

function applyWindowMode(nextMode) {
  if (!win) return;
  const prev = mode;
  mode = nextMode === "panel" ? "panel" : "icon";
  const bounds = win.getBounds();
  suppressPersist = true;

  try {
    if (mode === "panel") {
      // Always snapshot icon place before growing into the panel
      if (prev === "icon") {
        iconPos = { x: bounds.x, y: bounds.y };
      }
      const { width, height } = panelSizeFromConfig();
      const px = typeof panelPos.x === "number" ? panelPos.x : bounds.x;
      const py = typeof panelPos.y === "number" ? panelPos.y : bounds.y;
      win.setMinimumSize(PANEL_MIN_W, PANEL_MIN_H);
      win.setMaximumSize(10000, 10000);
      win.setResizable(true);
      win.setBackgroundColor("#141414");
      win.setBounds(clampBounds(width, height, px, py), false);
    } else {
      if (prev === "panel") {
        panelPos = { x: bounds.x, y: bounds.y };
      }
      const fallback = defaultIconPos();
      const ix = typeof iconPos.x === "number" ? iconPos.x : fallback.x;
      const iy = typeof iconPos.y === "number" ? iconPos.y : fallback.y;
      iconPos = { x: ix, y: iy };
      win.setResizable(false);
      win.setMinimumSize(ICON_SIZE, ICON_SIZE);
      win.setMaximumSize(ICON_SIZE, ICON_SIZE);
      win.setBackgroundColor("#c4a574");
      win.setBounds(clampBounds(ICON_SIZE, ICON_SIZE, ix, iy), false);
    }
  } finally {
    // Defer so Electron 'moved'/'resized' from setBounds settle first
    setTimeout(() => {
      suppressPersist = false;
    }, 50);
  }
}

function persistBounds() {
  if (!win || !db || suppressPersist) return;
  const { x, y, width, height } = win.getBounds();
  if (mode === "panel") {
    panelPos = { x, y };
    db.setConfig({
      mode,
      panelX: x,
      panelY: y,
      panelWidth: width,
      panelHeight: height,
      iconX: iconPos.x,
      iconY: iconPos.y,
    });
  } else {
    iconPos = { x, y };
    db.setConfig({
      mode,
      iconX: x,
      iconY: y,
      panelX: panelPos.x,
      panelY: panelPos.y,
    });
  }
}

function createWindow() {
  db = createDb(app.getPath("userData"));
  const config = db.getConfig();
  mode = config.mode === "panel" ? "panel" : "icon";
  loadPositionsFromConfig();
  // Migrate older configs that only stored x/y
  if (typeof config.iconX !== "number" && typeof config.x === "number") {
    iconPos = { x: config.x, y: config.y };
  }
  const panel = panelSizeFromConfig();
  const startX = mode === "panel" ? panelPos.x : iconPos.x;
  const startY = mode === "panel" ? panelPos.y : iconPos.y;

  win = new BrowserWindow({
    width: mode === "panel" ? panel.width : ICON_SIZE,
    height: mode === "panel" ? panel.height : ICON_SIZE,
    x: startX,
    y: startY,
    frame: false,
    transparent: false,
    // thickFrame enables standard corner/edge resize on Windows frameless windows
    thickFrame: true,
    autoHideMenuBar: true,
    title: "",
    alwaysOnTop: true,
    resizable: mode === "panel",
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    roundedCorners: true,
    show: false,
    backgroundColor: mode === "panel" ? "#141414" : "#c4a574",
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
    if (!dragOffset) persistBounds();
  });
  win.on("resized", () => {
    if (mode === "panel") persistBounds();
  });
  // Stay running: Alt+F4 / system close collapses to icon instead of quitting
  win.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      applyWindowMode("icon");
      persistBounds();
      win?.webContents.send("app:mode", mode);
    }
  });
  win.on("closed", () => {
    win = null;
  });
}

function enableAutoStart() {
  const appPath = path.resolve(path.join(__dirname, ".."));
  if (app.isPackaged) {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: false,
    });
  } else {
    // Dev / preview: start Electron with this project on login
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: false,
      path: process.execPath,
      args: [appPath],
    });
  }
}

function registerIpc() {
  ipcMain.handle("app:getState", () => ({
    mode,
    userDataPath: app.getPath("userData"),
  }));

  ipcMain.handle("app:setMode", (_event, nextMode) => {
    applyWindowMode(nextMode === "panel" ? "panel" : "icon");
    // Persist after mode switch settles (iconX kept when opening panel)
    setTimeout(() => persistBounds(), 60);
    win?.webContents.send("app:mode", mode);
    return mode;
  });

  ipcMain.on("window:drag-start", (_event, { screenX, screenY }) => {
    if (!win) return;
    const bounds = win.getBounds();
    dragOffset = { x: screenX - bounds.x, y: screenY - bounds.y };
    // Keep whatever size the user has (including after resize); only move x/y
    dragSize = { width: bounds.width, height: bounds.height };
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
    win.setBounds(
      {
        x: clamped.x,
        y: clamped.y,
        width: dragSize.width,
        height: dragSize.height,
      },
      false
    );
  });

  ipcMain.on("window:drag-end", () => {
    dragOffset = null;
    dragSize = null;
    persistBounds();
  });

  ipcMain.handle("notes:list", () => db.listNotes());
  ipcMain.handle("notes:create", (_e, payload) => db.createNote(payload || {}));
  ipcMain.handle("notes:update", (_e, id, payload) =>
    db.updateNote(id, payload || {})
  );
  ipcMain.handle("notes:delete", (_e, id) => db.deleteNote(id));

  ipcMain.handle("tasks:list", () => db.listTasks());
  ipcMain.handle("tasks:create", (_e, payload) => db.createTask(payload || {}));
  ipcMain.handle("tasks:update", (_e, id, payload) =>
    db.updateTask(id, payload || {})
  );
  ipcMain.handle("tasks:delete", (_e, id) => db.deleteTask(id));
}

app.isQuitting = false;

app.whenReady().then(() => {
  enableAutoStart();
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Stay resident even if no windows are open
app.on("window-all-closed", () => {});

app.on("before-quit", () => {
  app.isQuitting = true;
  persistBounds();
});
