const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

function createDb(userDataPath) {
  const dbPath = path.join(userDataPath, "buddy-data.json");
  const configPath = path.join(userDataPath, "buddy-config.json");

  const defaultData = () => ({
    notes: [],
    tasks: [],
  });

  function readJson(filePath, fallback) {
    try {
      if (!fs.existsSync(filePath)) return fallback();
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return fallback();
    }
  }

  function writeJson(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  }

  function load() {
    return readJson(dbPath, defaultData);
  }

  function save(data) {
    writeJson(dbPath, data);
  }

  function now() {
    return new Date().toISOString();
  }

  return {
    getConfig() {
      return readJson(configPath, () => ({ x: null, y: null, mode: "icon" }));
    },

    setConfig(partial) {
      const current = this.getConfig();
      const next = { ...current, ...partial };
      writeJson(configPath, next);
      return next;
    },

    listNotes() {
      return load()
        .notes.slice()
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },

    getNote(id) {
      return load().notes.find((n) => n.id === id) || null;
    },

    createNote({ title = "", body = "" } = {}) {
      const data = load();
      const note = {
        id: randomUUID(),
        title: title || "Untitled",
        body: body || "",
        createdAt: now(),
        updatedAt: now(),
      };
      data.notes.unshift(note);
      save(data);
      return note;
    },

    updateNote(id, { title, body }) {
      const data = load();
      const note = data.notes.find((n) => n.id === id);
      if (!note) return null;
      if (typeof title === "string") note.title = title;
      if (typeof body === "string") note.body = body;
      note.updatedAt = now();
      save(data);
      return note;
    },

    deleteNote(id) {
      const data = load();
      data.notes = data.notes.filter((n) => n.id !== id);
      const removeIds = new Set(
        data.tasks.filter((t) => t.noteId === id).map((t) => t.id)
      );
      // also drop children of removed parents
      for (const t of data.tasks) {
        if (t.parentId && removeIds.has(t.parentId)) removeIds.add(t.id);
      }
      data.tasks = data.tasks.filter((t) => !removeIds.has(t.id));
      save(data);
      return true;
    },

    listTasks() {
      return load()
        .tasks.slice()
        .sort((a, b) => a.order - b.order);
    },

    createTask({ title, parentId = null, noteId = null, done = false } = {}) {
      const data = load();
      const siblings = data.tasks.filter((t) => t.parentId === parentId);
      const order =
        siblings.length === 0
          ? 0
          : Math.max(...siblings.map((t) => t.order)) + 1;
      const task = {
        id: randomUUID(),
        title: title || "New task",
        done: Boolean(done),
        parentId,
        noteId,
        order,
        createdAt: now(),
        updatedAt: now(),
      };
      data.tasks.push(task);
      save(data);
      return task;
    },

    updateTask(id, patch) {
      const data = load();
      const task = data.tasks.find((t) => t.id === id);
      if (!task) return null;
      if (typeof patch.title === "string") task.title = patch.title;
      if (typeof patch.done === "boolean") task.done = patch.done;
      if ("parentId" in patch) task.parentId = patch.parentId;
      if ("noteId" in patch) task.noteId = patch.noteId;
      if (typeof patch.order === "number") task.order = patch.order;
      task.updatedAt = now();
      save(data);
      return task;
    },

    deleteTask(id) {
      const data = load();
      const toDelete = new Set([id]);
      for (const t of data.tasks) {
        if (t.parentId && toDelete.has(t.parentId)) toDelete.add(t.id);
      }
      data.tasks = data.tasks.filter((t) => !toDelete.has(t.id));
      save(data);
      return true;
    },
  };
}

module.exports = { createDb };
