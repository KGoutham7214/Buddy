import { useEffect, useMemo, useState } from "react";
import type { Note, Task, VoiceProfile } from "./vite-env";
import { nowSpeakingLabel, type MeetingRecorder } from "./useMeetingRecorder";
import TaskList from "./TaskList";
import { IconTrash } from "./icons";
import { captureMicPcm } from "./voiceCapture";
import { LOW_VOLUME_RMS } from "./pcm";

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
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [enrollName, setEnrollName] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [enrollLeft, setEnrollLeft] = useState(12);
  const [enrollPass, setEnrollPass] = useState(0);
  const [enrollHint, setEnrollHint] = useState("");
  const [enrollError, setEnrollError] = useState("");
  const [testing, setTesting] = useState(false);
  const [testLeft, setTestLeft] = useState(5);
  const [testResult, setTestResult] = useState("");
  const [voicesOpen, setVoicesOpen] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [levelRms, setLevelRms] = useState(0);

  const selected = useMemo(
    () => meetings.find((n) => n.id === selectedId) || null,
    [meetings, selectedId]
  );

  const noteTasks = useMemo(() => {
    if (!selectedId) return [];
    return tasks.filter((t) => t.noteId === selectedId);
  }, [tasks, selectedId]);

  async function refresh(preferId?: string | null) {
    const list = (await window.buddy.listNotes()).filter(
      (n) => n.kind === "meeting"
    );
    setMeetings(list);
    setTasks(await window.buddy.listTasks());
    setSelectedId((current) => {
      if (preferId && list.some((n) => n.id === preferId)) return preferId;
      if (current && list.some((n) => n.id === current)) return current;
      return list[0]?.id ?? null;
    });
  }

  useEffect(() => {
    void refresh();
    void window.buddy.checkMeetingDeps().then(setDeps);
    void window.buddy.listVoices().then(setVoices);
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
      await window.buddy.summarizeMeeting(selected.id);
      await refresh(selected.id);
    } finally {
      setSummarizing(false);
    }
  }

  async function removeMeeting() {
    if (!selected) return;
    await window.buddy.deleteNote(selected.id);
    await refresh(null);
  }

  async function addSubtask(parentId: string) {
    if (!selected) return;
    await window.buddy.createTask({
      title: "New subtask",
      parentId,
      noteId: selected.id,
    });
    setTasks(await window.buddy.listTasks());
  }

  async function toggleTask(task: Task) {
    await window.buddy.updateTask(task.id, { done: !task.done });
    setTasks(await window.buddy.listTasks());
  }

  async function renameTask(task: Task, title: string) {
    if (title.trim() === task.title) return;
    await window.buddy.updateTask(task.id, {
      title: title.trim() || task.title,
    });
    setTasks(await window.buddy.listTasks());
  }

  async function removeTask(id: string) {
    await window.buddy.deleteTask(id);
    setTasks(await window.buddy.listTasks());
  }

  async function scheduleTask(task: Task, remindAt: string | null) {
    await window.buddy.updateTask(task.id, { remindAt });
    setTasks(await window.buddy.listTasks());
  }

  async function removeVoice(id: string) {
    await window.buddy.deleteVoice(id);
    setVoices(await window.buddy.listVoices());
  }

  async function enrollVoice() {
    const name = enrollName.trim();
    if (!name || enrolling || testing) return;
    setEnrollError("");
    setEnrollHint("");
    setTestResult("");
    setEnrolling(true);
    setEnrollPass(0);
    setEnrollLeft(4);
    try {
      const PASS_COUNT = 3;
      const PASS_SECONDS = 4;
      const captures: Uint8Array[] = [];
      const rmsScores: number[] = [];
      for (let pass = 1; pass <= PASS_COUNT; pass++) {
        setEnrollPass(pass);
        setEnrollLeft(PASS_SECONDS);
        setLevelRms(0);
        setEnrollHint(
          `Pass ${pass}/${PASS_COUNT}: say anything — words do not matter`
        );
        const captured = await captureMicPcm(
          PASS_SECONDS,
          setEnrollLeft,
          setLevelRms
        );
        rmsScores.push(captured.rms);
        if (!captured.voiced) {
          setEnrollError(
            `Pass ${pass} heard no speech on ${captured.deviceLabel} (rms ${captured.rms.toFixed(3)}). Keep the headset mic and speak a bit more.`
          );
          return;
        }
        captures.push(captured.pcm);
      }
      const totalLen = captures.reduce((sum, part) => sum + part.length, 0);
      const merged = new Uint8Array(totalLen);
      let offset = 0;
      for (const part of captures) {
        merged.set(part, offset);
        offset += part.length;
      }
      if (rmsScores.length < PASS_COUNT) {
        setEnrollError("Couldn't capture enough clean speech. Try again.");
        return;
      }
      const result = await window.buddy.enrollVoice({
        name,
        pcm: merged,
        sampleRate: 16000,
      });
      if (!result.ok) {
        setEnrollError(result.error || "Could not save this voice");
        return;
      }
      const avgRms =
        rmsScores.reduce((a, b) => a + b, 0) / rmsScores.length;
      const quietNote = avgRms < LOW_VOLUME_RMS ? ", low volume" : "";
      setEnrollHint(
        `Saved ${name} (${PASS_COUNT} clean passes, avg rms ${avgRms.toFixed(3)}${quietNote})`
      );
      setEnrollName("");
      setVoices(await window.buddy.listVoices());
    } catch (err) {
      setEnrollError(
        err instanceof Error ? err.message : "Microphone unavailable"
      );
    } finally {
      setEnrollPass(0);
      setEnrolling(false);
      setLevelRms(0);
    }
  }

  async function testVoice() {
    if (enrolling || testing || phase !== "idle") return;
    setEnrollError("");
    setTestResult("");
    setTesting(true);
    setTestLeft(5);
    setLevelRms(0);
    try {
      await window.buddy.resetSpeakerSession();
      const captured = await captureMicPcm(5, setTestLeft, setLevelRms);
      if (!captured.voiced) {
        setTestResult(
          `Didn't hear speech on ${captured.deviceLabel} (rms ${captured.rms.toFixed(3)}). Speak a bit more, or check the headset mic.`
        );
        return;
      }
      const result = await window.buddy.identifySpeaker({
        pcm: captured.pcm,
        sampleRate: 16000,
      });
      if (!result.ok) {
        setTestResult(result.error || "Could not identify this voice");
        return;
      }
      const score =
        typeof result.confidence === "number"
          ? `score ${result.confidence.toFixed(2)}`
          : "";
      const closest = result.diagnostics?.topLabel
        ? ` vs ${result.diagnostics.topLabel}`
        : "";
      const floor =
        typeof result.diagnostics?.floor === "number"
          ? `, floor ${result.diagnostics.floor.toFixed(2)}`
          : "";
      const quiet =
        captured.rms < LOW_VOLUME_RMS ? " · low volume" : "";
      const mic = ` · ${captured.deviceLabel} · rms ${captured.rms.toFixed(3)}${quiet}`;
      const relaxed = result.diagnostics?.relaxedSingle
        ? ", relaxed single-speaker match"
        : "";
      setTestResult(
        result.speech === false || result.kind === "silence"
          ? `Didn't hear speech on ${captured.deviceLabel}.`
          : result.kind === "enrolled" && result.label
            ? `Heard: ${result.label} (${score}${floor}${relaxed})${mic}`
            : `Unknown (${score}${closest}${floor}) — re-enroll on this same mic${mic}`
      );
    } catch (err) {
      setTestResult(
        err instanceof Error ? err.message : "Microphone unavailable"
      );
    } finally {
      setTesting(false);
      setLevelRms(0);
    }
  }

  const voicesExpanded =
    voicesOpen || enrolling || testing || Boolean(enrollError);

  const transcript = selected?.transcript || selected?.body || "";
  const decisions = selected?.decisions || [];
  const keyPoints = selected?.keyPoints || [];
  const summaryParagraphs = (selected?.summary || "")
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((p) => p.trim())
    .filter(Boolean);

  return (
    <div className="content">
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
        </div>
      ) : null}

      <div className="voices-block">
        <button
          type="button"
          className="voices-toggle"
          onClick={() => setVoicesOpen((open) => !open)}
        >
          <span className="meet-section-label">Voices</span>
          <span className="voices-toggle-meta">
            {voices.length === 0
              ? "None enrolled"
              : voices.map((v) => v.name).join(", ")}
            {voicesExpanded ? " · Hide" : " · Show"}
          </span>
        </button>
        {voicesExpanded ? (
          <>
            {voices.length === 0 ? (
              <p className="voices-hint">
                Buddy compares the sound of the voice, not the words. Say
                anything — enroll and test on the same mic (headset if
                earphones are connected). Prints are stored in local Qdrant.
              </p>
            ) : (
              <ul className="voice-list">
                {voices.map((voice) => (
                  <li key={voice.id} className="voice-row">
                    <span className="voice-name">{voice.name}</span>
                    <button
                      className="btn btn-ghost voice-delete"
                      onClick={() => void removeVoice(voice.id)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {deps?.speakers?.backend &&
            voices.some(
              (v) => v.backend && v.backend !== deps.speakers?.backend
            ) ? (
              <p className="voices-hint">
                Re-enroll these names — they were saved with an older matcher.
              </p>
            ) : null}
            <div className="voice-enroll">
              <input
                className="voice-name-input"
                value={enrollName}
                onChange={(e) => setEnrollName(e.target.value)}
                placeholder="Name"
                disabled={enrolling || testing}
                maxLength={40}
              />
              <button
                className="btn btn-ghost"
                onClick={() => void enrollVoice()}
                disabled={
                  enrolling ||
                  testing ||
                  !enrollName.trim() ||
                  Boolean(deps && deps.speakers && !deps.speakers.ok) ||
                  Boolean(deps && deps.qdrant && !deps.qdrant.ok)
                }
              >
                {enrolling
                  ? `Pass ${Math.max(enrollPass, 1)}/3… ${enrollLeft}s`
                  : "Enroll voice"}
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => void testVoice()}
                disabled={
                  enrolling ||
                  testing ||
                  phase !== "idle" ||
                  Boolean(deps && deps.speakers && !deps.speakers.ok) ||
                  Boolean(deps && deps.qdrant && !deps.qdrant.ok)
                }
              >
                {testing ? `Listening… ${testLeft}s` : "Test voice"}
              </button>
            </div>
            {enrolling || testing ? (
              <div className="voice-meter" aria-hidden>
                <span className="voice-meter-label">
                  {levelRms >= 0.015 ? "Speech" : "Too quiet"}
                </span>
                <span className="voice-meter-track">
                  <span
                    className={`voice-meter-fill ${
                      levelRms >= 0.015 ? "ok" : ""
                    }`}
                    style={{
                      width: `${Math.min(100, Math.round((levelRms / 0.08) * 100))}%`,
                    }}
                  />
                </span>
              </div>
            ) : null}
            {testResult ? <div className="voices-test">{testResult}</div> : null}
            {enrollHint ? <div className="voices-test">{enrollHint}</div> : null}
            {enrollError ? (
              <div className="voices-error">{enrollError}</div>
            ) : null}
            {deps?.speakers && !deps.speakers.ok ? (
              <p className="voices-hint">{deps.speakers.error}</p>
            ) : null}
            {deps?.qdrant && !deps.qdrant.ok ? (
              <p className="voices-hint">{deps.qdrant.error}</p>
            ) : null}
          </>
        ) : null}
      </div>

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
