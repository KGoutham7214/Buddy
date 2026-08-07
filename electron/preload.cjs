const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("buddy", {
  getState: () => ipcRenderer.invoke("app:getState"),
  setMode: (mode) => ipcRenderer.invoke("app:setMode", mode),

  dragStart: (payload) => ipcRenderer.send("window:drag-start", payload),
  dragMove: (payload) => ipcRenderer.send("window:drag-move", payload),
  dragEnd: () => ipcRenderer.send("window:drag-end"),

  listNotes: () => ipcRenderer.invoke("notes:list"),
  createNote: (payload) => ipcRenderer.invoke("notes:create", payload),
  updateNote: (id, payload) => ipcRenderer.invoke("notes:update", id, payload),
  deleteNote: (id) => ipcRenderer.invoke("notes:delete", id),

  listTasks: () => ipcRenderer.invoke("tasks:list"),
  createTask: (payload) => ipcRenderer.invoke("tasks:create", payload),
  updateTask: (id, payload) => ipcRenderer.invoke("tasks:update", id, payload),
  deleteTask: (id) => ipcRenderer.invoke("tasks:delete", id),

  onModeChange: (callback) => {
    const handler = (_event, mode) => callback(mode);
    ipcRenderer.on("app:mode", handler);
    return () => ipcRenderer.removeListener("app:mode", handler);
  },
});
