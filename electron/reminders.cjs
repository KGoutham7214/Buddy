/**
 * Reminder persistence + pending evaluation (main process).
 * Catalog ids stay in sync with src/reminderCatalog.ts
 */

function localDayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const CATALOG = [{ id: "daily-todo", frequency: "daily" }];

function getReminderState(db) {
  const config = db.getConfig() || {};
  return config.reminderState && typeof config.reminderState === "object"
    ? config.reminderState
    : {};
}

function setReminderEntry(db, id, patch) {
  const state = { ...getReminderState(db) };
  state[id] = { ...(state[id] || {}), ...patch };
  db.setConfig({ reminderState: state });
  return state[id];
}

function isCatalogPending(def, entry, dayKey) {
  if (entry?.snoozeUntil) {
    const until = Date.parse(entry.snoozeUntil);
    if (!Number.isNaN(until) && until > Date.now()) return false;
  }
  if (def.frequency === "always") return true;
  if (def.frequency === "once") return !entry?.dismissedAt;
  if (def.frequency === "daily") {
    return entry?.dismissedDay !== dayKey;
  }
  return false;
}

function listDueTasks(db) {
  const now = Date.now();
  return db
    .listTasks()
    .filter((t) => {
      if (t.done) return false;
      if (!t.remindAt) return false;
      const at = Date.parse(t.remindAt);
      return !Number.isNaN(at) && at <= now;
    })
    .map((t) => ({
      id: `task:${t.id}`,
      kind: "task",
      frequency: "once",
      taskId: t.id,
      title: t.title || "Task",
      dayKey: localDayKey(),
    }));
}

function listPending(db) {
  const dayKey = localDayKey();
  const state = getReminderState(db);
  const tasks = listDueTasks(db);
  const catalog = CATALOG.filter((def) =>
    isCatalogPending(def, state[def.id], dayKey)
  ).map((def) => ({
    id: def.id,
    kind: "catalog",
    frequency: def.frequency,
    dayKey,
  }));
  return [...tasks, ...catalog];
}

function markShown(db, id) {
  const dayKey = localDayKey();
  return setReminderEntry(db, id, {
    shownDay: dayKey,
    shownAt: new Date().toISOString(),
  });
}

function dismiss(db, id) {
  const dayKey = localDayKey();
  if (String(id).startsWith("task:")) {
    const taskId = String(id).slice(5);
    db.updateTask(taskId, { remindAt: null });
  }
  return setReminderEntry(db, id, {
    dismissedDay: dayKey,
    dismissedAt: new Date().toISOString(),
    snoozeUntil: null,
  });
}

function snooze(db, id, hours = 1) {
  const until = new Date(Date.now() + Math.max(0.1, Number(hours) || 1) * 60 * 60 * 1000);
  if (String(id).startsWith("task:")) {
    const taskId = String(id).slice(5);
    db.updateTask(taskId, { remindAt: until.toISOString() });
  }
  return setReminderEntry(db, id, {
    snoozeUntil: until.toISOString(),
  });
}

function setTaskReminder(db, taskId, remindAt) {
  return db.updateTask(taskId, { remindAt: remindAt || null });
}

module.exports = {
  listPending,
  markShown,
  dismiss,
  snooze,
  setTaskReminder,
  localDayKey,
};
