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

function pickModel(models) {
  const preferred = [
    "llama3.2",
    "llama3.2:latest",
    "llama3.1",
    "llama3.1:latest",
    "llama3",
    "mistral",
    "phi3",
    "qwen2.5",
  ];
  for (const name of preferred) {
    const hit = models.find(
      (m) => m === name || m.startsWith(`${name.split(":")[0]}:`)
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
  const invented =
    /\b(the team|this meeting|participants|discussed the|agenda|project status|quarterly|stakeholders)\b/i;
  const t = cleanText(transcript).toLowerCase();
  if (invented.test(s) && t.length < 120) return true;
  return false;
}

function clipTranscript(text, max = 8000) {
  const t = String(text || "").trim();
  if (t.length <= max) return t;
  const head = Math.floor(max * 0.55);
  const tail = max - head - 5;
  return `${t.slice(0, head)}\n…\n${t.slice(-tail)}`;
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
        num_predict: 700,
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
- Use speaker labels when attributing decisions and tasks. Do not invent other people.
- Do not set relevant to false just because the talk is informal, short, incomplete, or hard to hear
- decisions/keyPoints/tasks must be empty arrays when nothing real exists
- no markdown fences, no commentary outside JSON

Transcript:
${transcript}`;
}

function simplePrompt(transcript) {
  return `Summarize this conversation. Return ONLY JSON:
{"title":"max 8 words","summary":"2-5 sentences of what people said","decisions":[],"keyPoints":[],"tasks":[]}
Use only facts from the transcript. Use empty arrays when nothing is clear. Do not invent people or projects.

Transcript:
${transcript}`;
}

async function summarizeMeeting(transcript) {
  if (!isUsableTranscript(transcript)) {
    return { ok: false, irrelevant: true, error: irrelevantError() };
  }

  const status = await checkOllama();
  if (!status.ok) return { ok: false, error: status.error };

  const model = pickModel(status.models);
  if (!model) {
    return {
      ok: false,
      error: "No Ollama models found. Run: ollama pull llama3.2",
    };
  }

  const clipped = clipTranscript(transcript, 8000);
  const attempts = [
    { prompt: fullPrompt(clipped), formatJson: true, timeoutMs: 150000 },
    { prompt: simplePrompt(clipped), formatJson: false, timeoutMs: 150000 },
  ];

  let lastError = "Could not parse model response as JSON";
  for (const attempt of attempts) {
    const generated = await ollamaGenerate(model, attempt.prompt, attempt);
    if (!generated.ok) {
      lastError = generated.error;
      continue;
    }
    const parsed = parseJsonObject(generated.text);
    const notes = notesFromParsed(parsed, clipped);
    if (notes && notes.skipped) {
      lastError = "Ollama skipped this clip. Click Generate summary to try again.";
      continue;
    }
    if (!notes) {
      lastError = "Could not parse model response as JSON";
      continue;
    }
    return { ok: true, model, ...notes };
  }

  return {
    ok: false,
    skipSummary: true,
    error: lastError,
  };
}

module.exports = { checkOllama, summarizeMeeting, isUsableTranscript };
