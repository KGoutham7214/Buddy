const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

/** Current buddy-data.json schema. Bump when the on-disk shape changes. */
const SCHEMA_VERSION = 1;

/**
 * Notes and tasks always carry id + createdAt + updatedAt (ISO strings).
 * Migrate on load so older files gain schemaVersion without a rewrite.
 */
function createDb(userDataPath) {
  const dbPath = path.join(userDataPath, "buddy-data.json");
  const configPath = path.join(userDataPath, "buddy-config.json");
  const recordingsDir = path.join(userDataPath, "recordings");

  const defaultData = () => ({
    schemaVersion: SCHEMA_VERSION,
    notes: [],
    tasks: [],
    voices: [],
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

  function migrate(data) {
    let changed = false;
    const next = data && typeof data === "object" ? data : defaultData();

    if (!Array.isArray(next.notes)) {
      next.notes = [];
      changed = true;
    }
    if (!Array.isArray(next.tasks)) {
      next.tasks = [];
      changed = true;
    }
    // Legacy local voice roster; live Voice ID uses Qdrant.
    if (!Array.isArray(next.voices)) {
      next.voices = [];
      changed = true;
    }

    const version = Number(next.schemaVersion) || 0;
    if (version < SCHEMA_VERSION) {
      next.schemaVersion = SCHEMA_VERSION;
      changed = true;
    }

    return { data: next, changed };
  }

  function load() {
    const raw = readJson(dbPath, defaultData);
    const { data, changed } = migrate(raw);
    if (changed) save(data);
    return data;
  }

  function publicVoice(voice) {
    return {
      id: voice.id,
      name: voice.name,
      backend: voice.backend || "",
      createdAt: voice.createdAt,
      updatedAt: voice.updatedAt,
    };
  }

  function save(data) {
    if (!data.schemaVersion) data.schemaVersion = SCHEMA_VERSION;
    writeJson(dbPath, data);
  }

  function now() {
    return new Date().toISOString();
  }

  function normalizeNote(note) {
    return {
      id: note.id,
      title: note.title || "Untitled",
      body: note.body || "",
      kind: note.kind === "meeting" ? "meeting" : "note",
      transcript: note.transcript || "",
      summary: note.summary || "",
      summaryError: note.summaryError || "",
      audioPath: note.audioPath || null,
      keyPoints: Array.isArray(note.keyPoints) ? note.keyPoints : [],
      decisions: Array.isArray(note.decisions) ? note.decisions : [],
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    };
  }

  return {
    recordingsDir,

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
        .notes.map(normalizeNote)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    },

    getNote(id) {
      const note = load().notes.find((n) => n.id === id);
      return note ? normalizeNote(note) : null;
    },

    createNote({
      title = "",
      body = "",
      kind = "note",
      transcript = "",
      summary = "",
      summaryError = "",
      audioPath = null,
      keyPoints = [],
      decisions = [],
    } = {}) {
      const data = load();
      const note = normalizeNote({
        id: randomUUID(),
        title: title || "Untitled",
        body: body || "",
        kind: kind === "meeting" ? "meeting" : "note",
        transcript: transcript || "",
        summary: summary || "",
        summaryError: summaryError || "",
        audioPath: audioPath || null,
        keyPoints: Array.isArray(keyPoints) ? keyPoints : [],
        decisions: Array.isArray(decisions) ? decisions : [],
        createdAt: now(),
        updatedAt: now(),
      });
      data.notes.unshift(note);
      save(data);
      return note;
    },

    updateNote(id, patch) {
      const data = load();
      const note = data.notes.find((n) => n.id === id);
      if (!note) return null;
      if (typeof patch.title === "string") note.title = patch.title;
      if (typeof patch.body === "string") note.body = patch.body;
      if (typeof patch.transcript === "string") note.transcript = patch.transcript;
      if (typeof patch.summary === "string") note.summary = patch.summary;
      if (typeof patch.summaryError === "string") note.summaryError = patch.summaryError;
      if ("audioPath" in patch) note.audioPath = patch.audioPath;
      if (Array.isArray(patch.keyPoints)) note.keyPoints = patch.keyPoints;
      if (Array.isArray(patch.decisions)) note.decisions = patch.decisions;
      if (patch.kind === "meeting" || patch.kind === "note") note.kind = patch.kind;
      note.updatedAt = now();
      save(data);
      return normalizeNote(note);
    },

    deleteNote(id) {
      const data = load();
      const note = data.notes.find((n) => n.id === id);
      data.notes = data.notes.filter((n) => n.id !== id);
      const removeIds = new Set(
        data.tasks.filter((t) => t.noteId === id).map((t) => t.id)
      );
      let grew = true;
      while (grew) {
        grew = false;
        for (const t of data.tasks) {
          if (t.parentId && removeIds.has(t.parentId) && !removeIds.has(t.id)) {
            removeIds.add(t.id);
            grew = true;
          }
        }
      }
      data.tasks = data.tasks.filter((t) => !removeIds.has(t.id));
      save(data);
      return note ? normalizeNote(note) : null;
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
        remindAt: null,
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
      if (typeof patch.done === "boolean") {
        task.done = patch.done;
        if (patch.done) task.remindAt = null;
      }
      if ("parentId" in patch) task.parentId = patch.parentId;
      if ("noteId" in patch) task.noteId = patch.noteId;
      if (typeof patch.order === "number") task.order = patch.order;
      if ("remindAt" in patch) {
        task.remindAt = patch.remindAt ? String(patch.remindAt) : null;
      }
      task.updatedAt = now();
      save(data);
      return task;
    },

    deleteTask(id) {
      const data = load();
      const toDelete = new Set([id]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const t of data.tasks) {
          if (t.parentId && toDelete.has(t.parentId) && !toDelete.has(t.id)) {
            toDelete.add(t.id);
            grew = true;
          }
        }
      }
      data.tasks = data.tasks.filter((t) => !toDelete.has(t.id));
      save(data);
      return true;
    },

    createTasksFromPlan({ noteId = null, title, subtasks = [] }) {
      // Flat action items as root tasks (nested subtasks added by the user)
      const created = (subtasks || []).map((text) =>
        this.createTask({
          title: String(text),
          parentId: null,
          noteId,
        })
      );
      return { parent: null, children: created, title };
    },

    ensureRecordingsDir() {
      fs.mkdirSync(recordingsDir, { recursive: true });
      return recordingsDir;
    },

    listVoices() {
      return load()
        .voices.map(publicVoice)
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    listVoiceEmbeddings() {
      return load().voices.filter(
        (v) => Array.isArray(v.embedding) && v.embedding.length > 0
      );
    },

    createVoice({ name, embedding, backend } = {}) {
      const data = load();
      const trimmed = String(name || "").trim() || "Voice";
      const existing = data.voices.find(
        (v) => String(v.name).toLowerCase() === trimmed.toLowerCase()
      );
      if (existing) {
        existing.embedding = Array.isArray(embedding) ? embedding : [];
        existing.backend = backend || "";
        existing.updatedAt = now();
        save(data);
        return publicVoice(existing);
      }
      const voice = {
        id: randomUUID(),
        name: trimmed,
        embedding: Array.isArray(embedding) ? embedding : [],
        backend: backend || "",
        createdAt: now(),
        updatedAt: now(),
      };
      data.voices.push(voice);
      save(data);
      return publicVoice(voice);
    },

    deleteVoice(id) {
      const data = load();
      const before = data.voices.length;
      data.voices = data.voices.filter((v) => v.id !== id);
      if (data.voices.length === before) return false;
      save(data);
      return true;
    },

    clearVoices() {
      const data = load();
      const had = Array.isArray(data.voices) ? data.voices.length : 0;
      data.voices = [];
      save(data);
      return had;
    },
  };
}

module.exports = { createDb };
