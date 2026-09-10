import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Note, Task } from "./domain/types";
import { buddy } from "./api/buddyClient";
import TaskList from "./TaskList";
import { IconPlus, IconTrash } from "./icons";
import { useConfirm } from "./ConfirmDialog";

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export default function NotesView() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [taskDraft, setTaskDraft] = useState("");
  const { confirm, dialog } = useConfirm();

  const selected = useMemo(
    () => notes.find((n) => n.id === selectedId) || null,
    [notes, selectedId]
  );

  const noteTasks = useMemo(() => {
    if (!selectedId) return [];
    return tasks.filter((t) => t.noteId === selectedId);
  }, [tasks, selectedId]);

  async function refreshNotes(preferId?: string | null) {
    const list = (await buddy.listNotes()).filter(
      (n) => n.kind !== "meeting"
    );
    setNotes(list);
    setSelectedId((current) => {
      if (preferId && list.some((n) => n.id === preferId)) return preferId;
      if (current && list.some((n) => n.id === current)) return current;
      return list[0]?.id ?? null;
    });
  }

  async function refreshTasks() {
    setTasks(await buddy.listTasks());
  }

  useEffect(() => {
    void refreshNotes();
    void refreshTasks();
  }, []);

  async function createNote() {
    const note = await buddy.createNote({ title: "Untitled", body: "" });
    await refreshNotes(note.id);
  }

  async function saveTitle(title: string) {
    if (!selected) return;
    const updated = await buddy.updateNote(selected.id, { title });
    if (updated) {
      setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
    }
  }

  async function saveBody(body: string) {
    if (!selected) return;
    const updated = await buddy.updateNote(selected.id, { body });
    if (updated) {
      setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
    }
  }

  async function removeNote() {
    if (!selected) return;
    const label = selected.title?.trim() || "this note";
    const ok = await confirm({
      title: "Delete note?",
      message: `“${label}” and its tasks will be removed. This cannot be undone.`,
    });
    if (!ok) return;
    await buddy.deleteNote(selected.id);
    setTaskDraft("");
    await refreshNotes(null);
    await refreshTasks();
  }

  async function addTask(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    const title = taskDraft.trim();
    if (!title) return;
    await buddy.createTask({
      title,
      noteId: selected.id,
      parentId: null,
    });
    setTaskDraft("");
    await refreshTasks();
  }

  async function addSubtask(parentId: string) {
    if (!selected) return;
    await buddy.createTask({
      title: "New subtask",
      parentId,
      noteId: selected.id,
    });
    await refreshTasks();
  }

  async function toggleTask(task: Task) {
    await buddy.updateTask(task.id, { done: !task.done });
    await refreshTasks();
  }

  async function renameTask(task: Task, title: string) {
    if (title.trim() === task.title) return;
    await buddy.updateTask(task.id, {
      title: title.trim() || task.title,
    });
    await refreshTasks();
  }

  async function removeTask(id: string) {
    const task = tasks.find((t) => t.id === id);
    const label = task?.title?.trim() || "this task";
    const ok = await confirm({
      title: "Delete task?",
      message: `“${label}” and any nested subtasks will be removed.`,
    });
    if (!ok) return;
    await buddy.deleteTask(id);
    await refreshTasks();
  }

  async function scheduleTask(task: Task, remindAt: string | null) {
    await buddy.updateTask(task.id, { remindAt });
    await refreshTasks();
  }

  return (
    <div className="content">
      {dialog}
      <div className="toolbar">
        <button className="btn btn-primary" onClick={() => void createNote()}>
          <IconPlus /> New note
        </button>
      </div>

      <div className="split">
        <div className="list">
          {notes.length === 0 ? (
            <div className="empty-hint">No notes yet</div>
          ) : (
            notes.map((note) => (
              <button
                key={note.id}
                className={`list-item ${note.id === selectedId ? "active" : ""}`}
                onClick={() => setSelectedId(note.id)}
              >
                <span className="list-title">{note.title || "Untitled"}</span>
                <span className="list-meta">{formatDate(note.updatedAt)}</span>
              </button>
            ))
          )}
        </div>

        <div className="editor">
          {!selected ? (
            <div className="editor-empty">
              Create a note, write in it, and add tasks below.
            </div>
          ) : (
            <>
              <input
                className="field-title"
                value={selected.title}
                placeholder="Title"
                onChange={(e) => {
                  const title = e.target.value;
                  setNotes((prev) =>
                    prev.map((n) =>
                      n.id === selected.id ? { ...n, title } : n
                    )
                  );
                }}
                onBlur={(e) => void saveTitle(e.target.value)}
              />
              <textarea
                className="field-body note-body"
                value={selected.body}
                placeholder="Write your note…"
                onChange={(e) => {
                  const body = e.target.value;
                  setNotes((prev) =>
                    prev.map((n) =>
                      n.id === selected.id ? { ...n, body } : n
                    )
                  );
                }}
                onBlur={(e) => void saveBody(e.target.value)}
              />

              <div className="note-tasks">
                <div className="note-tasks-header">
                  <span>Tasks</span>
                </div>

                <form
                  className="task-compose compact"
                  onSubmit={(e) => void addTask(e)}
                >
                  <input
                    className="task-input"
                    value={taskDraft}
                    onChange={(e) => setTaskDraft(e.target.value)}
                    placeholder="Add a task to this note…"
                  />
                  <button className="btn btn-primary" type="submit">
                    <IconPlus />
                  </button>
                </form>

                <TaskList
                  tasks={noteTasks}
                  emptyText="No tasks in this note yet"
                  onToggle={(task) => void toggleTask(task)}
                  onRename={(task, title) => void renameTask(task, title)}
                  onAddChild={(parentId) => void addSubtask(parentId)}
                  onDelete={(id) => void removeTask(id)}
                  onSchedule={(task, remindAt) => void scheduleTask(task, remindAt)}
                />
              </div>

              <div className="editor-footer">
                <button
                  className="btn btn-danger"
                  onClick={() => void removeNote()}
                >
                  <IconTrash /> Delete note
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
