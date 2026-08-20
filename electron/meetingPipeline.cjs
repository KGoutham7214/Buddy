const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");
const { transcribeAudio } = require("./transcribe.cjs");
const { summarizeMeeting } = require("./ollama.cjs");
const speakers = require("./speakers.cjs");

async function processMeeting(payload, { db, onProgress } = {}) {
  const { buffer, mimeType, speakerTurns } = payload || {};
  if (!buffer) {
    return { ok: false, error: "No audio received" };
  }

  const dir = db.ensureRecordingsDir();
  const id = randomUUID();
  const ext = String(mimeType || "").includes("webm") ? "webm" : "wav";
  const fileName = `${id}.${ext}`;
  const fullPath = path.join(dir, fileName);
  const relativePath = path.join("recordings", fileName);

  try {
    fs.writeFileSync(fullPath, Buffer.from(buffer));
  } catch (err) {
    return { ok: false, error: err.message || "Failed to save audio" };
  }

  onProgress?.("Transcribing with Whisper…");
  const stt = await transcribeAudio(fullPath, { model: "base" });
  if (!stt.ok) {
    return {
      ok: false,
      error: stt.error,
      audioPath: relativePath,
    };
  }

  let transcript = String(stt.text || "").trim();
  if ((stt.segments || []).length > 0) {
    onProgress?.("Identifying speakers…");
    try {
      const labeled = await speakers.labelSegments(
        fullPath,
        stt.segments,
        speakerTurns || []
      );
      if (labeled.ok && labeled.transcript) {
        transcript = labeled.transcript;
      }
    } catch {
      // Keep unlabeled Whisper text
    }
  }

  onProgress?.("Summarizing with Ollama…");
  const ai = await summarizeMeeting(transcript);

  if (!ai.ok && ai.irrelevant) {
    return {
      ok: false,
      error: ai.error || "This clip didn't have enough real speech to save.",
      audioPath: relativePath,
      irrelevant: true,
    };
  }

  const note = db.createNote({
    title:
      (ai.ok && ai.title) || `Meeting — ${new Date().toLocaleString()}`,
    body: transcript,
    kind: "meeting",
    transcript,
    summary: (ai.ok && ai.summary) || "",
    summaryError: ai.ok ? "" : ai.error || "",
    keyPoints: (ai.ok && ai.keyPoints) || [],
    decisions: (ai.ok && ai.decisions) || [],
    audioPath: relativePath,
  });

  if (ai.ok && (ai.tasks || []).length > 0) {
    db.createTasksFromPlan({
      noteId: note.id,
      title: "Action items",
      subtasks: ai.tasks,
    });
  }

  return {
    ok: true,
    noteId: note.id,
    note,
    aiError: ai.ok ? null : ai.error || null,
  };
}

async function summarizeNote(noteId, { db, onProgress } = {}) {
  const note = db.getNote(noteId);
  if (!note || note.kind !== "meeting") {
    return { ok: false, error: "Meeting not found" };
  }
  const transcript = String(note.transcript || note.body || "").trim();
  onProgress?.("Summarizing with Ollama…");
  const ai = await summarizeMeeting(transcript);
  if (!ai.ok) {
    const updated = db.updateNote(note.id, {
      summaryError: ai.error || "Summary failed",
    });
    return {
      ok: false,
      error: ai.error || "Summary failed",
      note: updated,
    };
  }
  const updated = db.updateNote(note.id, {
    title: note.title.startsWith("Meeting —") ? ai.title : note.title,
    summary: ai.summary,
    keyPoints: ai.keyPoints,
    decisions: ai.decisions,
    summaryError: "",
  });
  const existingTasks = db.listTasks().filter((t) => t.noteId === note.id);
  if (existingTasks.length === 0 && (ai.tasks || []).length > 0) {
    db.createTasksFromPlan({
      noteId: note.id,
      title: "Action items",
      subtasks: ai.tasks,
    });
  }
  return { ok: true, note: updated };
}

module.exports = {
  processMeeting,
  summarizeNote,
};
