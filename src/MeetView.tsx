import { useEffect, useMemo, useState } from "react";
import type { Note, Task } from "./domain/types";
import { buddy } from "./api/buddyClient";
import { nowSpeakingLabel, type MeetingRecorder } from "./useMeetingRecorder";
import TaskList from "./TaskList";
import { IconTrash } from "./icons";
import { useConfirm } from "./ConfirmDialog";

type Deps = {
  whisper: { ok: boolean; error?: string };
  ollama: { ok: boolean; error?: string; models?: string[] };
  speakers?: { ok: boolean; error?: string; backend?: string };
  qdrant?: { ok: boolean; error?: string };
};

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

function formatElapsed(seconds: number) {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

type Props = {
  recorder: MeetingRecorder;
};

export default function MeetView({ recorder }: Props) {
  const {
    phase,
    elapsed,
    status,
    error,
    captureInfo,
    liveSpeaker,
    liveSpeakerState,
    startRecording,
    stopRecording,
    cancelRecording,
  } = recorder;

  const [meetings, setMeetings] = useState<Note[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deps, setDeps] = useState<Deps | null>(null);
  const [showTranscript, setShowTranscript] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const { confirm, dialog } = useConfirm();

  const selected = useMemo(
    () => meetings.find((n) => n.id === selectedId) || null,
    [meetings, selectedId]
  );

  const noteTasks = useMemo(() => {
    if (!selectedId) return [];
    return tasks.filter((t) => t.noteId === selectedId);
  }, [tasks, selectedId]);

  async function refresh(preferId?: string | null) {
    const list = (await buddy.listNotes()).filter(
      (n) => n.kind === "meeting"
    );
    setMeetings(list);
    setTasks(await buddy.listTasks());
    setSelectedId((current) => {
      if (preferId && list.some((n) => n.id === preferId)) return preferId;
      if (current && list.some((n) => n.id === current)) return current;
      return list[0]?.id ?? null;
    });
  }

  useEffect(() => {
    void refresh();
    void buddy.checkMeetingDeps().then(setDeps);
  }, []);

  useEffect(() => {
    setShowTranscript(false);
  }, [selectedId]);

  async function handleStop() {
    const noteId = await stopRecording();
    if (noteId) await refresh(noteId);
  }

  async function generateSummary() {
    if (!selected || summarizing) return;
    setSummarizing(true);
    try {
      await buddy.summarizeMeeting(selected.id);
      await refresh(selected.id);
    } finally {
      setSummarizing(false);
    }
  }

  async function removeMeeting() {
    if (!selected) return;
    const label = selected.title?.trim() || "this meeting";
    const ok = await confirm({
      title: "Delete meeting?",
      message: `“${label}” and its action items will be removed. This cannot be undone.`,
    });
    if (!ok) return;
    await buddy.deleteNote(selected.id);
    await refresh(null);
  }

  async function addSubtask(parentId: string) {
    if (!selected) return;
    await buddy.createTask({
      title: "New subtask",
      parentId,
      noteId: selected.id,
    });
    setTasks(await buddy.listTasks());
  }

  async function toggleTask(task: Task) {
    await buddy.updateTask(task.id, { done: !task.done });
    setTasks(await buddy.listTasks());
  }

  async function renameTask(task: Task, title: string) {
    if (title.trim() === task.title) return;
    await buddy.updateTask(task.id, {
      title: title.trim() || task.title,
    });
    setTasks(await buddy.listTasks());
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
    setTasks(await buddy.listTasks());
  }

  async function scheduleTask(task: Task, remindAt: string | null) {
    await buddy.updateTask(task.id, { remindAt });
    setTasks(await buddy.listTasks());
  }

  const transcript = selected?.transcript || selected?.body || "";
  const decisions = selected?.decisions || [];
  const keyPoints = selected?.keyPoints || [];
  const summaryParagraphs = (selected?.summary || "")
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <div className="content">
      {dialog}
      <div className="meet-toolbar">
        {phase === "idle" ? (
          <button
            className="btn btn-primary"
            onClick={() => void startRecording()}
            disabled={deps?.whisper && !deps.whisper.ok}
          >
            Record meeting
          </button>
        ) : null}
        {phase === "recording" ? (
          <>
            <div
              className={`now-speaking-bar ${
                liveSpeakerState === "name" ? "known" : liveSpeakerState
              }`}
            >
              <span className="rec-dot" aria-hidden />
              <div className="now-speaking-copy">
                <span className="now-speaking-kicker">Now speaking</span>
                <span className="now-speaking-name">
                  {nowSpeakingLabel(liveSpeakerState, liveSpeaker)}
                </span>
              </div>
            </div>
            <span className="rec-timer">{formatElapsed(elapsed)}</span>
            <span className="capture-info">{captureInfo}</span>
            <button className="btn btn-danger" onClick={() => void handleStop()}>
              Stop & process
            </button>
            <button className="btn btn-ghost" onClick={() => cancelRecording()}>
              Cancel
            </button>
          </>
        ) : null}
        {phase === "processing" ? (
          <span className="status-line">{status || "Processing…"}</span>
        ) : null}
      </div>

      {deps ? (
        <div className="deps-row">
          <span className={deps.whisper.ok ? "dep ok" : "dep bad"}>
            Whisper {deps.whisper.ok ? "ready" : "missing"}
          </span>
          <span className={deps.ollama.ok ? "dep ok" : "dep bad"}>
            Ollama {deps.ollama.ok ? "ready" : "missing"}
          </span>
          <span className={deps.speakers?.ok ? "dep ok" : "dep bad"}>
            Voice ID {deps.speakers?.ok ? "ready" : "missing"}
          </span>
          <span className={deps.qdrant?.ok ? "dep ok" : "dep bad"}>
            Qdrant {deps.qdrant?.ok ? "ready" : "missing"}
          </span>
          <span className="deps-hint">Models &amp; voices in Settings</span>
        </div>
      ) : null}

      {error ? <div className="meet-error">{error}</div> : null}
      {status && phase === "idle" ? (
        <div className="meet-status">{status}</div>
      ) : null}

      <div className="split">
        <div className="list">
          {meetings.length === 0 ? (
            <div className="empty-hint">
              No meetings yet.
              <br />
              Record mic + system audio, then Buddy will transcribe and summarize.
            </div>
          ) : (
            meetings.map((note) => (
              <button
                key={note.id}
                className={`list-item ${note.id === selectedId ? "active" : ""}`}
                onClick={() => setSelectedId(note.id)}
              >
                <span className="list-title">{note.title || "Meeting"}</span>
                <span className="list-meta">{formatDate(note.updatedAt)}</span>
              </button>
            ))
          )}
        </div>

        <div className="editor">
          {!selected ? (
            <div className="editor-empty">
              Start a recording to capture Zoom/Teams (system) and your mic, then
              generate notes and tasks. You can minimize — recording keeps going.
            </div>
          ) : (
            <>
              <div className="meet-scroll">
                <div className="field-title readonly">{selected.title}</div>

                {summaryParagraphs.length > 0 ? (
                  <div className="meet-card summary-card">
                    <div className="meet-section-label">Summary</div>
                    <div className="meet-summary">
                      {summaryParagraphs.map((para) => (
                        <p key={para}>{para}</p>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="meet-card muted">
                    <div className="meet-section-label">Summary</div>
                    <p className="meet-summary">
                      {summarizing
                        ? "Writing summary with Ollama…"
                        : selected.summaryError ||
                          (deps?.ollama && !deps.ollama.ok
                            ? deps.ollama.error ||
                              "Start Ollama and pull a model, then generate a summary."
                            : "No AI summary yet. Ollama is ready — generate one from this transcript.")}
                    </p>
                    <button
                      className="btn btn-primary"
                      onClick={() => void generateSummary()}
                      disabled={
                        summarizing ||
                        Boolean(deps && deps.ollama && !deps.ollama.ok)
                      }
                    >
                      {summarizing ? "Generating…" : "Generate summary"}
                    </button>
                  </div>
                )}

                {decisions.length > 0 ? (
                  <div className="meet-card">
                    <div className="meet-section-label">Decisions</div>
                    <ul className="meet-bullets decisions">
                      {decisions.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {keyPoints.length > 0 ? (
                  <div className="meet-card">
                    <div className="meet-section-label">Key points</div>
                    <ul className="meet-bullets">
                      {keyPoints.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {noteTasks.length > 0 ? (
                  <div className="meet-card tasks-card">
                    <div className="meet-section-label">Action items</div>
                    <TaskList
                      tasks={noteTasks}
                      onToggle={(task) => void toggleTask(task)}
                      onRename={(task, title) => void renameTask(task, title)}
                      onAddChild={(parentId) => void addSubtask(parentId)}
                      onDelete={(id) => void removeTask(id)}
                      onSchedule={(task, remindAt) =>
                        void scheduleTask(task, remindAt)
                      }
                    />
                  </div>
                ) : null}

                <div className="meet-card transcript-card">
                  <button
                    className="transcript-toggle"
                    onClick={() => setShowTranscript((v) => !v)}
                  >
                    <span className="meet-section-label">Transcript</span>
                    <span className="transcript-chevron">
                      {showTranscript ? "Hide" : "Show"}
                    </span>
                  </button>
                  {showTranscript ? (
                    <pre className="meet-transcript">{transcript}</pre>
                  ) : (
                    <p className="meet-transcript-preview">
                      {transcript.slice(0, 140)}
                      {transcript.length > 140 ? "…" : ""}
                    </p>
                  )}
                </div>
              </div>

              <div className="editor-footer">
                <button
                  className="btn btn-danger"
                  onClick={() => void removeMeeting()}
                >
                  <IconTrash /> Delete meeting
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
