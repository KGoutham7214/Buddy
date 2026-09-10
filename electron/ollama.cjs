async function checkOllama() {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags");
    if (!res.ok) return { ok: false, error: "Ollama not reachable" };
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name).filter(Boolean);
    if (models.length === 0) {
      return {
        ok: false,
        error: "No Ollama models found. Run: ollama pull llama3.2",
      };
    }
    return { ok: true, models };
  } catch {
    return {
      ok: false,
      error: "Ollama is not running. Start Ollama, then: ollama pull llama3.2",
    };
  }
}

function pickModel(models, preferredName = "") {
  const preferred = [
    preferredName,
    "llama3.2",
    "llama3.2:latest",
    "llama3.1",
    "llama3.1:latest",
    "llama3",
    "mistral",
    "phi3",
    "qwen2.5",
  ].filter(Boolean);
  for (const name of preferred) {
    const hit = models.find(
      (m) => m === name || m.startsWith(`${String(name).split(":")[0]}:`)
    );
    if (hit) return hit;
  }
  return models[0] || null;
}

function cleanText(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/[*_`#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function irrelevantError() {
  return "This clip didn't have enough real speech to save as a meeting.";
}

function isUsableTranscript(transcript) {
  const text = String(transcript || "").trim();
  if (!text) return false;

  const normalized = text
    .replace(/[\[\](){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (normalized.length < 40) return false;

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length < 8) return false;

  const junkExact = new Set([
    "thank you",
    "thanks",
    "you",
    "bye",
    "okay",
    "ok",
    "hmm",
    "uh",
    "um",
    "blank audio",
    "silence",
    "music",
    "applause",
    "subtitle",
    "subtitles by",
    "www.youtube.com",
  ]);
  if (junkExact.has(normalized)) return false;

  const junkPattern =
    /^(thank you\.?|thanks\.?|you\.?|bye\.?|okay\.?|ok\.?|\[?\s*blank[_\s-]?audio\s*\]?|\[?\s*silence\s*\]?|♪+|\[?\s*music\s*\]?)$/i;
  if (junkPattern.test(normalized)) return false;

  const letters = (normalized.match(/[a-z]/g) || []).length;
  if (letters < 24) return false;

  return true;
}

function asStringArray(value, { max = 12, minLen = 3 } = {}) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const item = cleanText(raw);
    if (item.length < minLen) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

function polishSummary(raw) {
  let text = cleanText(raw);
  if (!text) return "";

  if (/^[-•]\s/m.test(text) || text.includes(" - ")) {
    text = text
      .split(/(?:\n+|;\s+|•\s+|-\s+)/)
      .map((s) => s.trim())
      .filter(Boolean)
      .join(". ");
  }

  text = text.replace(/\s*\.\s*/g, ". ").replace(/\s+/g, " ").trim();
  if (text && !/[.!?]$/.test(text)) text += ".";
  return text;
}

function filterActionItems(items) {
  const weak = /^(follow up|discuss|talk|meeting|notes?|update|check|todo)\b/i;
  return items.filter((item) => {
    if (item.length < 8) return false;
    if (weak.test(item) && item.split(/\s+/).length < 4) return false;
    return true;
  });
}

function looksInvented(summary, transcript) {
  const s = cleanText(summary).toLowerCase();
  if (!s) return true;
  const t = cleanText(transcript).toLowerCase();
  // Only flag when the summary is long relative to a tiny transcript and
  // uses stock corporate filler that never appears in the source.
  if (t.length >= 160) return false;
  const invented =
    /\b(quarterly|stakeholders|roadmap alignment|synerg(?:y|ies)|circle back)\b/i;
  return invented.test(s) && !invented.test(t);
}

function chunkTranscript(text, chunkSize = 5500, overlap = 400) {
  const t = String(text || "").trim();
  if (t.length <= chunkSize) return [t];
  const chunks = [];
  let start = 0;
  while (start < t.length) {
    let end = Math.min(t.length, start + chunkSize);
    if (end < t.length) {
      const breakAt = t.lastIndexOf("\n", end);
      if (breakAt > start + chunkSize * 0.5) end = breakAt;
    }
    chunks.push(t.slice(start, end).trim());
    if (end >= t.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks.filter(Boolean);
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // continue
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function notesFromParsed(parsed, transcript) {
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.relevant === false || parsed.relevant === "false") {
    return { skipped: true };
  }
  const title =
    typeof parsed.title === "string" && cleanText(parsed.title)
      ? cleanText(parsed.title)
      : "";
  const summary = polishSummary(parsed.summary);
  const decisions = asStringArray(parsed.decisions, { max: 6, minLen: 6 });
  const keyPoints = asStringArray(parsed.keyPoints, { max: 7, minLen: 6 });
  const tasks = filterActionItems(
    asStringArray(parsed.tasks, { max: 8, minLen: 8 })
  );
  if (!summary || looksInvented(summary, transcript)) return null;
  return {
    title: title || "Meeting notes",
    summary,
    decisions,
    keyPoints,
    tasks,
  };
}

async function ollamaGenerate(model, prompt, { formatJson, timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = {
      model,
      prompt,
      stream: false,
      keep_alive: "10m",
      options: {
        temperature: 0.1,
        top_p: 0.9,
        num_predict: 1200,
        num_ctx: 8192,
      },
    };
    if (formatJson) body.format = "json";
    const res = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `Ollama error: ${res.status}` };
    }
    const data = await res.json();
    if (data.error) {
      return { ok: false, error: String(data.error) };
    }
    return { ok: true, text: String(data.response || "") };
  } catch (err) {
    const timedOut = err && err.name === "AbortError";
    return {
      ok: false,
      error: timedOut
        ? "Ollama timed out while writing the summary. Click Generate summary to try again."
        : err.message || "Ollama request failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

function fullPrompt(transcript) {
  return `You write notes from spoken conversations (standups, check-ins, work chats, meetings).

If the transcript is empty, silence, noise, music, or filler only, return:
{"relevant": false, "title": "", "summary": "", "decisions": [], "keyPoints": [], "tasks": []}

If people are actually talking — even briefly or casually — it IS relevant. Informal plans, "what are you working on", and short check-ins count. Speaker labels like [Name] or [Speaker 1] are part of the transcript, not noise.

Return ONLY valid JSON (no markdown):
{
  "relevant": true,
  "title": "Specific title, max 8 words",
  "summary": "1-5 sentences covering what people said. Short clips can be 1-2 sentences.",
  "decisions": ["Only clear agreements"],
  "keyPoints": ["Short factual takeaways"],
  "tasks": ["Concrete next action starting with a verb, include owner if spoken"]
}

Rules:
- NEVER invent facts, people, projects, or action items not clearly in the transcript
- When speaker labels like [Name] exist, attribute decisions, key points, and tasks to those speakers
- If a fact is unclear, omit it or write "not stated" — do not guess
- Do not set relevant to false just because the talk is informal, short, incomplete, or hard to hear
- decisions/keyPoints/tasks must be empty arrays when nothing real exists
- no markdown fences, no commentary outside JSON

Transcript:
${transcript}`;
}

function simplePrompt(transcript) {
  return `Summarize this conversation. Return ONLY JSON:
{"title":"max 8 words","summary":"2-5 sentences of what people said","decisions":[],"keyPoints":[],"tasks":[]}
Use only facts from the transcript. Use speaker labels when present. Use empty arrays when nothing is clear. Do not invent people or projects.

Transcript:
${transcript}`;
}

function chunkPrompt(transcript, index, total) {
  return `This is part ${index + 1} of ${total} of a longer meeting transcript.
Extract only facts from this part. Return ONLY JSON:
{"summary":"2-4 sentences from this part","decisions":[],"keyPoints":[],"tasks":[]}
Do not invent people or projects. Use speaker labels when present. Empty arrays when nothing is clear.

Transcript part:
${transcript}`;
}

function mergePrompt(partials) {
  return `Merge these partial meeting notes into one final JSON object.
Keep only facts supported by the partials. Prefer speaker-attributed wording when present.
Return ONLY JSON:
{"relevant": true, "title": "max 8 words", "summary": "3-6 sentences", "decisions": [], "keyPoints": [], "tasks": []}

Partials:
${partials}`;
}

async function generateNotes(model, prompt, transcript, { formatJson = true, timeoutMs = 150000 } = {}) {
  const generated = await ollamaGenerate(model, prompt, { formatJson, timeoutMs });
  if (!generated.ok) return { ok: false, error: generated.error };
  const parsed = parseJsonObject(generated.text);
  const notes = notesFromParsed(parsed, transcript);
  if (notes && notes.skipped) {
    return {
      ok: false,
      skipped: true,
      error: "Ollama skipped this clip. Click Generate summary to try again.",
    };
  }
  if (!notes) {
    return { ok: false, error: "Could not parse model response as JSON" };
  }
  return { ok: true, notes };
}

async function summarizeLongMeeting(model, transcript) {
  const chunks = chunkTranscript(transcript);
  const partials = [];
  for (let i = 0; i < chunks.length; i++) {
    const result = await generateNotes(
      model,
      chunkPrompt(chunks[i], i, chunks.length),
      chunks[i],
      { formatJson: true, timeoutMs: 150000 }
    );
    if (result.ok) {
      partials.push(
        JSON.stringify({
          summary: result.notes.summary,
          decisions: result.notes.decisions,
          keyPoints: result.notes.keyPoints,
          tasks: result.notes.tasks,
        })
      );
    }
  }
  if (partials.length === 0) {
    return { ok: false, error: "Could not summarize long transcript chunks" };
  }
  const merged = await generateNotes(
    model,
    mergePrompt(partials.join("\n")),
    transcript,
    { formatJson: true, timeoutMs: 180000 }
  );
  if (merged.ok) return { ok: true, notes: merged.notes };
  // Fallback: stitch summaries if merge JSON fails
  return {
    ok: true,
    notes: {
      title: "Meeting notes",
      summary: polishSummary(partials.map((p) => {
        try {
          return JSON.parse(p).summary;
        } catch {
          return "";
        }
      }).filter(Boolean).join(" ")),
      decisions: [],
      keyPoints: [],
      tasks: [],
    },
  };
}

async function summarizeMeeting(transcript, { model: preferredModel = null } = {}) {
  if (!isUsableTranscript(transcript)) {
    return { ok: false, irrelevant: true, error: irrelevantError() };
  }

  const status = await checkOllama();
  if (!status.ok) return { ok: false, error: status.error };

  const model = pickModel(status.models, preferredModel || "");
  if (!model) {
    return {
      ok: false,
      error: "No Ollama models found. Run: ollama pull llama3.2",
    };
  }

  const text = String(transcript || "").trim();
  if (text.length > 6000) {
    const long = await summarizeLongMeeting(model, text);
    if (long.ok) return { ok: true, model, ...long.notes };
    return { ok: false, skipSummary: true, error: long.error };
  }

  const attempts = [
    { prompt: fullPrompt(text), formatJson: true, timeoutMs: 150000 },
    { prompt: simplePrompt(text), formatJson: false, timeoutMs: 150000 },
  ];

  let lastError = "Could not parse model response as JSON";
  for (const attempt of attempts) {
    const result = await generateNotes(model, attempt.prompt, text, attempt);
    if (result.ok) return { ok: true, model, ...result.notes };
    lastError = result.error || lastError;
  }

  return {
    ok: false,
    skipSummary: true,
    error: lastError,
  };
}

module.exports = {
  checkOllama,
  summarizeMeeting,
  isUsableTranscript,
  pickModel,
};
