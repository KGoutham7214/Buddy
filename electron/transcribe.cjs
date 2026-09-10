const { spawn } = require("child_process");
const path = require("path");

const WHISPER_MODELS = new Set(["base", "small", "medium"]);

function pythonEnv() {
  return {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
}

function normalizeWhisperModel(model) {
  const value = String(model || "small").trim().toLowerCase();
  return WHISPER_MODELS.has(value) ? value : "small";
}

function checkWhisper() {
  return new Promise((resolve) => {
    const child = spawn("python", ["-c", "import faster_whisper; print('ok')"], {
      windowsHide: true,
      env: pythonEnv(),
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString("utf8");
    });
    child.on("error", () => {
      resolve({
        ok: false,
        error: "Python not found. Install Python 3.10+ and add it to PATH.",
      });
    });
    child.on("close", (code) => {
      if (code === 0 && out.includes("ok")) {
        resolve({ ok: true });
      } else {
        resolve({
          ok: false,
          error: "faster-whisper not installed. Run: pip install faster-whisper",
        });
      }
    });
  });
}

function transcribeAudio(
  audioPath,
  { model = "small", language = "en", initialPrompt = "" } = {}
) {
  const script = path.join(__dirname, "..", "scripts", "transcribe.py");
  const whisperModel = normalizeWhisperModel(model);
  const args = [script, audioPath, "--model", whisperModel];
  if (language) {
    args.push("--language", String(language));
  }
  if (initialPrompt) {
    args.push("--initial-prompt", String(initialPrompt));
  }

  return new Promise((resolve) => {
    const child = spawn("python", args, {
      windowsHide: true,
      env: pythonEnv(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ ok: false, error: err.message || "Failed to start Python" });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({
          ok: false,
          error: stderr.trim() || `Transcription failed (code ${code})`,
        });
        return;
      }
      const raw = stdout.trim();
      if (!raw) {
        resolve({ ok: false, error: "Empty transcript" });
        return;
      }
      let text = raw;
      let segments = [];
      if (raw.startsWith("{")) {
        try {
          const parsed = JSON.parse(raw);
          text = String(parsed.text || "").trim();
          segments = Array.isArray(parsed.segments) ? parsed.segments : [];
        } catch {
          text = raw;
        }
      }
      if (!text) {
        resolve({ ok: false, error: "Empty transcript" });
        return;
      }
      resolve({ ok: true, text, segments, model: whisperModel });
    });
  });
}

module.exports = {
  checkWhisper,
  transcribeAudio,
  normalizeWhisperModel,
  WHISPER_MODELS,
};
