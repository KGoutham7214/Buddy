/**
 * End-to-end persistence check for Buddy notes/tasks + config positions.
 * Uses the same db module as the Electron app.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { createDb } = require("../electron/db.cjs");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buddy-e2e-"));
console.log("Test data dir:", dir);

const db = createDb(dir);

// --- notes + tasks CRUD ---
const note = db.createNote({
  title: "E2E Note",
  body: "Persisted body",
});
assert(note.id, "note should have id");

const task = db.createTask({
  title: "Parent task",
  noteId: note.id,
});
const sub = db.createTask({
  title: "Subtask",
  noteId: note.id,
  parentId: task.id,
});

db.updateNote(note.id, { title: "E2E Note Updated" });
db.updateTask(task.id, { done: true });

// --- config / icon position ---
db.setConfig({
  mode: "icon",
  iconX: 120,
  iconY: 340,
  panelX: 200,
  panelY: 100,
  panelWidth: 400,
  panelHeight: 580,
});

// --- reopen (simulate app restart) ---
const db2 = createDb(dir);
const notes = db2.listNotes();
const tasks = db2.listTasks();
const config = db2.getConfig();

assert(notes.length === 1, `expected 1 note, got ${notes.length}`);
assert(notes[0].title === "E2E Note Updated", "note title should persist");
assert(notes[0].body === "Persisted body", "note body should persist");

assert(tasks.length === 2, `expected 2 tasks, got ${tasks.length}`);
const parent = tasks.find((t) => t.id === task.id);
const child = tasks.find((t) => t.id === sub.id);
assert(parent?.done === true, "parent done should persist");
assert(child?.parentId === task.id, "subtask parent link should persist");
assert(child?.noteId === note.id, "subtask note link should persist");

assert(config.iconX === 120, "iconX should persist");
assert(config.iconY === 340, "iconY should persist");

// --- delete note removes its tasks ---
db2.deleteNote(note.id);
assert(db2.listNotes().length === 0, "note deleted");
assert(db2.listTasks().length === 0, "tasks for note deleted");

const dataFile = path.join(dir, "buddy-data.json");
const configFile = path.join(dir, "buddy-config.json");
assert(fs.existsSync(dataFile), "buddy-data.json exists");
assert(fs.existsSync(configFile), "buddy-config.json exists");

console.log("E2E_OK");
console.log("Files:", dataFile, configFile);

// Show where the real Electron app stores data (Windows)
const appData = process.env.APPDATA;
if (appData) {
  const real = path.join(appData, "buddy");
  console.log("App userData (typical):", real);
  console.log("  notes/tasks:", path.join(real, "buddy-data.json"));
  console.log("  window/config:", path.join(real, "buddy-config.json"));
  if (fs.existsSync(path.join(real, "buddy-data.json"))) {
    const live = JSON.parse(
      fs.readFileSync(path.join(real, "buddy-data.json"), "utf8")
    );
    console.log(
      `Live store: ${live.notes?.length ?? 0} notes, ${live.tasks?.length ?? 0} tasks`
    );
  }
}

fs.rmSync(dir, { recursive: true, force: true });
