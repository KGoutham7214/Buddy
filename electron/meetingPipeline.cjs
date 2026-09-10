const path = require("path");
const fs = require("fs");
const { randomUUID } = require("crypto");
const {
  transcribeAudio,
  normalizeWhisperModel,
} = require("./transcribe.cjs");
const { summarizeMeeting } = require("./ollama.cjs");
const speakers = require("./speakers.cjs");
const qdrant = require("./qdrant.cjs");

function meetSettingsFromDb(db) {
  const config = db?.getConfig?.() || {};
  const whisperModel = normalizeWhisperModel(config.whisperModel || "small");
  const ollamaModel =
    typeof config.ollamaModel === "string" ? config.ollamaModel.trim() : "";
  return { whisperModel, ollamaModel };
}

async function buildInitialPrompt(db) {
  const parts = [];
  try {
    const listed = await qdrant.listVoices();
    if (listed.ok && Array.isArray(listed.voices) && listed.voices.length > 0) {
      const names = listed.voices
        .map((v) => String(v.name || "").trim())
        .filter(Boolean)
        .slice(0, 12);
      if (names.length) {
        parts.push(`Speakers may include: ${names.join(", ")}.`);
      }
    }
  } catch {
    // ignore
  }
  try {
    const meetings = (db.listNotes() || [])
      .filter((n) => n.kind === "meeting" && n.title)
      .slice(0, 5);
    const titles = meetings
      .map((n) => String(n.title || "").replace(/^Meeting —/, "").trim())
      .filter((t) => t.length >= 3 && t.length <= 48);
    if (titles.length) {
      parts.push(`Recent topics: ${titles.join("; ")}.`);
    }
  } catch {
    // ignore
  }
  return parts.join(" ").slice(0, 400);
}

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

  const { whisperModel, ollamaModel } = meetSettingsFromDb(db);
  const initialPrompt = await buildInitialPrompt(db);

  onProgress?.(`Transcribing with Whisper (${whisperModel})…`);
  const stt = await transcribeAudio(fullPath, {
    model: whisperModel,
    language: "en",
    initialPrompt,
  });
  if (!stt.ok) {
    return {
      ok: false,
      error: stt.error,
      audioPath: relativePath,
    };
  }

  let transcript = String(stt.text || "").trim();
  let labelWarning = "";
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
      } else if (!labeled.ok) {
        labelWarning = labeled.error || "Speaker labeling failed";
        onProgress?.(labelWarning);
      }
    } catch (err) {
      labelWarning = (err && err.message) || "Speaker labeling failed";
      onProgress?.(labelWarning);
    }
  }

  onProgress?.("Summarizing with Ollama…");
  const ai = await summarizeMeeting(transcript, { model: ollamaModel || null });

  // Always keep a note with the transcript; only skip AI fields when irrelevant/unusable.
  const skipSummary = Boolean(!ai.ok && (ai.irrelevant || ai.skipSummary));
  const aiErrorText = ai.ok ? "" : ai.error || "";
  const summaryError = [labelWarning, aiErrorText].filter(Boolean).join(" · ");

  const note = db.createNote({
    title:
      (ai.ok && ai.title) || `Meeting — ${new Date().toLocaleString()}`,
    body: transcript,
    kind: "meeting",
    transcript,
    summary: (ai.ok && ai.summary) || "",
    summaryError,
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
    aiError: summaryError || null,
    skipSummary,
  };
}

async function summarizeNote(noteId, { db, onProgress } = {}) {
  const note = db.getNote(noteId);
  if (!note || note.kind !== "meeting") {
    return { ok: false, error: "Meeting not found" };
  }
  const transcript = String(note.transcript || note.body || "").trim();
  const { ollamaModel } = meetSettingsFromDb(db);
  onProgress?.("Summarizing with Ollama…");
  const ai = await summarizeMeeting(transcript, { model: ollamaModel || null });
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

function getMeetSettings(db) {
  const settings = meetSettingsFromDb(db);
  return {
    ok: true,
    whisperModel: settings.whisperModel,
    ollamaModel: settings.ollamaModel,
    whisperModels: ["base", "small", "medium"],
  };
}

function setMeetSettings(db, partial = {}) {
  const patch = {};
  if (partial.whisperModel != null) {
    patch.whisperModel = normalizeWhisperModel(partial.whisperModel);
  }
  if (partial.ollamaModel != null) {
    const value = String(partial.ollamaModel || "").trim();
    patch.ollamaModel = value;
  }
  const next = db.setConfig(patch);
  return {
    ok: true,
    whisperModel: normalizeWhisperModel(next.whisperModel || "small"),
    ollamaModel:
      typeof next.ollamaModel === "string" ? next.ollamaModel.trim() : "",
  };
}

module.exports = {
  processMeeting,
  summarizeNote,
  getMeetSettings,
  setMeetSettings,
};
