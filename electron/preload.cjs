const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("buddy", {
  getState: () => ipcRenderer.invoke("app:getState"),
  setMode: (mode) => ipcRenderer.invoke("app:setMode", mode),
  setIconColor: (id) => ipcRenderer.invoke("app:setIconColor", id),
  setUserName: (value) => ipcRenderer.invoke("app:setUserName", value),

  dragStart: (payload) => ipcRenderer.send("window:drag-start", payload),
  dragMove: (payload) => ipcRenderer.send("window:drag-move", payload),
  dragEnd: () => ipcRenderer.send("window:drag-end"),
  showIconMenu: (payload) => ipcRenderer.send("icon:context-menu", payload),

  listNotes: () => ipcRenderer.invoke("notes:list"),
  createNote: (payload) => ipcRenderer.invoke("notes:create", payload),
  updateNote: (id, payload) => ipcRenderer.invoke("notes:update", id, payload),
  deleteNote: (id) => ipcRenderer.invoke("notes:delete", id),

  listTasks: () => ipcRenderer.invoke("tasks:list"),
  createTask: (payload) => ipcRenderer.invoke("tasks:create", payload),
  updateTask: (id, payload) => ipcRenderer.invoke("tasks:update", id, payload),
  deleteTask: (id) => ipcRenderer.invoke("tasks:delete", id),

  getDesktopSource: () => ipcRenderer.invoke("meeting:desktopSource"),
  checkMeetingDeps: () => ipcRenderer.invoke("meeting:checkDeps"),
  getMeetSettings: () => ipcRenderer.invoke("meeting:getSettings"),
  setMeetSettings: (payload) => ipcRenderer.invoke("meeting:setSettings", payload),
  processMeeting: (payload) => ipcRenderer.invoke("meeting:process", payload),
  summarizeMeeting: (noteId) => ipcRenderer.invoke("meeting:summarize", noteId),
  setRecording: (active) => ipcRenderer.invoke("app:setRecording", active),

  listVoices: () => ipcRenderer.invoke("voices:list"),
  enrollVoice: (payload) => ipcRenderer.invoke("voices:enroll", payload),
  deleteVoice: (id) => ipcRenderer.invoke("voices:delete", id),
  resetSpeakerSession: () => ipcRenderer.invoke("voices:resetSession"),
  identifySpeaker: (payload) => ipcRenderer.invoke("voices:identify", payload),

  listPendingReminders: () => ipcRenderer.invoke("reminders:pending"),
  markReminderShown: (id) => ipcRenderer.invoke("reminders:markShown", id),
  dismissReminder: (id) => ipcRenderer.invoke("reminders:dismiss", id),
  snoozeReminder: (id, hours) =>
    ipcRenderer.invoke("reminders:snooze", id, hours),
  setReminderBubble: (active) =>
    ipcRenderer.invoke("reminders:setBubble", active),

  onModeChange: (callback) => {
    const handler = (_event, mode) => callback(mode);
    ipcRenderer.on("app:mode", handler);
    return () => ipcRenderer.removeListener("app:mode", handler);
  },

  onMeetingProgress: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on("meeting:progress", handler);
    return () => ipcRenderer.removeListener("meeting:progress", handler);
  },

  onReminderDue: (callback) => {
    const handler = () => callback();
    ipcRenderer.on("reminders:due", handler);
    return () => ipcRenderer.removeListener("reminders:due", handler);
  },

  onIconMenuAction: (callback) => {
    const handler = (_event, action) => callback(action);
    ipcRenderer.on("icon:menu-action", handler);
    return () => ipcRenderer.removeListener("icon:menu-action", handler);
  },

  onIconColor: (callback) => {
    const handler = (_event, color) => callback(color);
    ipcRenderer.on("icon:color", handler);
    return () => ipcRenderer.removeListener("icon:color", handler);
  },
});
