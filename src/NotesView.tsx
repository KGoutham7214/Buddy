import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import type { Note, Task } from "./vite-env";
import { IconCheck, IconPlus, IconTrash } from "./icons";

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

  const selected = useMemo(
    () => notes.find((n) => n.id === selectedId) || null,
    [notes, selectedId]
  );

  const noteTasks = useMemo(() => {
    if (!selectedId) return [];
    const linked = tasks.filter((t) => t.noteId === selectedId);
    const roots = linked
      .filter((t) => !t.parentId)
      .sort((a, b) => a.order - b.order);
    return roots.map((root) => ({
      root,
      children: linked
        .filter((t) => t.parentId === root.id)
        .sort((a, b) => a.order - b.order),
    }));
  }, [tasks, selectedId]);

  async function refreshNotes(preferId?: string | null) {
    const list = await window.buddy.listNotes();
    setNotes(list);
    setSelectedId((current) => {
      if (preferId && list.some((n) => n.id === preferId)) return preferId;
      if (current && list.some((n) => n.id === current)) return current;
      return list[0]?.id ?? null;
    });
  }

  async function refreshTasks() {
    setTasks(await window.buddy.listTasks());
  }

  useEffect(() => {
    void refreshNotes();
    void refreshTasks();
  }, []);

  async function createNote() {
    const note = await window.buddy.createNote({ title: "Untitled", body: "" });
    await refreshNotes(note.id);
  }

  async function saveTitle(title: string) {
    if (!selected) return;
    const updated = await window.buddy.updateNote(selected.id, { title });
    if (updated) {
      setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
    }
  }

  async function saveBody(body: string) {
    if (!selected) return;
    const updated = await window.buddy.updateNote(selected.id, { body });
    if (updated) {
      setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
    }
  }

  async function removeNote() {
    if (!selected) return;
    await window.buddy.deleteNote(selected.id);
    setTaskDraft("");
    await refreshNotes(null);
    await refreshTasks();
  }

  async function addTask(e: FormEvent) {
    e.preventDefault();
    if (!selected) return;
    const title = taskDraft.trim();
    if (!title) return;
    await window.buddy.createTask({
      title,
      noteId: selected.id,
      parentId: null,
    });
    setTaskDraft("");
    await refreshTasks();
  }

  async function addSubtask(parentId: string) {
    if (!selected) return;
    await window.buddy.createTask({
      title: "New subtask",
      parentId,
      noteId: selected.id,
    });
    await refreshTasks();
  }

  async function toggleTask(task: Task) {
    await window.buddy.updateTask(task.id, { done: !task.done });
    await refreshTasks();
  }

  async function renameTask(task: Task, title: string) {
    if (title.trim() === task.title) return;
    await window.buddy.updateTask(task.id, {
      title: title.trim() || task.title,
    });
    await refreshTasks();
  }

  async function removeTask(id: string) {
    await window.buddy.deleteTask(id);
    await refreshTasks();
  }

  return (
    <div className="content">
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

                <div className="task-list embedded">
                  {noteTasks.length === 0 ? (
                    <div className="empty-hint tight">
                      No tasks in this note yet
                    </div>
                  ) : (
                    noteTasks.map(({ root, children }) => (
                      <div key={root.id}>
                        <NoteTaskRow
                          task={root}
                          onToggle={() => void toggleTask(root)}
                          onRename={(title) => void renameTask(root, title)}
                          onAddChild={() => void addSubtask(root.id)}
                          onDelete={() => void removeTask(root.id)}
                        />
                        {children.map((child) => (
                          <NoteTaskRow
                            key={child.id}
                            task={child}
                            child
                            onToggle={() => void toggleTask(child)}
                            onRename={(title) => void renameTask(child, title)}
                            onDelete={() => void removeTask(child.id)}
                          />
                        ))}
                      </div>
                    ))
                  )}
                </div>
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

function NoteTaskRow({
  task,
  child,
  onToggle,
  onRename,
  onAddChild,
  onDelete,
}: {
  task: Task;
  child?: boolean;
  onToggle: () => void;
  onRename: (title: string) => void;
  onAddChild?: () => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(task.title);

  useEffect(() => {
    setTitle(task.title);
  }, [task.title]);

  return (
    <div
      className={`task-row ${child ? "child" : ""} ${task.done ? "done" : ""}`}
    >
      <button
        className={`checkbox ${task.done ? "checked" : ""}`}
        onClick={onToggle}
        aria-label={task.done ? "Mark incomplete" : "Mark complete"}
      >
        <IconCheck />
      </button>
      <input
        className="task-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => onRename(title)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <div className="task-actions">
        {onAddChild ? (
          <button
            className="tiny-btn"
            title="Add subtask"
            onClick={onAddChild}
          >
            <IconPlus />
          </button>
        ) : null}
        <button className="tiny-btn danger" title="Delete" onClick={onDelete}>
          <IconTrash />
        </button>
      </div>
    </div>
  );
}
