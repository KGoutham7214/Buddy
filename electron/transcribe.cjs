const { spawn } = require("child_process");
const path = require("path");

// Production-grade only — tiny/base variants transcribe too poorly for meetings.
const WHISPER_MODEL_LIST = [
  "distil-small.en",
  "small",
  "small.en",
  "distil-medium.en",
  "medium",
  "medium.en",
];
const WHISPER_MODELS = new Set(WHISPER_MODEL_LIST);
const DEFAULT_MODEL = "distil-small.en";
const DEFAULT_BEAM = 1;

let proc = null;
let stdoutBuf = "";
let nextId = 1;
const pending = new Map();
let requestChain = Promise.resolve();

function pythonEnv() {
  return {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
}

function normalizeWhisperModel(model) {
  const value = String(model || DEFAULT_MODEL).trim().toLowerCase();
  return WHISPER_MODELS.has(value) ? value : DEFAULT_MODEL;
}

function normalizeBeamSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_BEAM;
  return Math.max(1, Math.min(5, Math.round(n)));
}

function attachProcess(child) {
  proc = child;
  stdoutBuf = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString("utf8");
    let idx = stdoutBuf.indexOf("\n");
    while (idx >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line) {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          msg = null;
        }
        if (msg && pending.has(msg.id)) {
          const wait = pending.get(msg.id);
          pending.delete(msg.id);
          wait(msg);
        }
      }
      idx = stdoutBuf.indexOf("\n");
    }
  });
  const failAll = (error) => {
    proc = null;
    for (const [, wait] of pending) {
      wait({ ok: false, error });
    }
    pending.clear();
  };
  child.on("error", () => failAll("Failed to start Python whisper process"));
  child.on("exit", () => failAll("Whisper process exited"));
}

function ensureProcess() {
  if (proc && !proc.killed) return proc;
  const script = path.join(__dirname, "..", "scripts", "transcribe.py");
  const child = spawn("python", ["-u", script, "--sidecar"], {
    windowsHide: true,
    env: pythonEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  attachProcess(child);
  child.stderr.on("data", () => {
    // Drain stderr so CT2 / download logs cannot fill the pipe and deadlock.
  });
  return child;
}

function request(payload, timeoutMs) {
  const run = () =>
    new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: "Whisper timed out" });
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      try {
        const line = `${JSON.stringify({ id, ...payload })}\n`;
        ensureProcess().stdin.write(line);
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        resolve({ ok: false, error: err.message || "Whisper write failed" });
      }
    });
  const queued = requestChain.then(run, run);
  requestChain = queued.then(
    () => undefined,
    () => undefined
  );
  return queued;
}

function stop() {
  if (!proc) return;
  try {
    proc.stdin.end();
  } catch {
    // ignore
  }
  try {
    proc.kill();
  } catch {
    // ignore
  }
  proc = null;
}

async function checkWhisper() {
  try {
    const msg = await request({ cmd: "status" }, 15000);
    if (msg.ok && msg.ready) {
      return {
        ok: true,
        warm: Boolean(msg.warm),
        model: msg.model || null,
        device: msg.device || null,
        models: Array.isArray(msg.models) ? msg.models : WHISPER_MODEL_LIST,
      };
    }
    return {
      ok: false,
      error:
        msg.error ||
        "faster-whisper not installed. Run: pip install faster-whisper",
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message || "Python not found. Install Python 3.10+ and add it to PATH.",
    };
  }
}

async function warmWhisper(model = DEFAULT_MODEL) {
  const whisperModel = normalizeWhisperModel(model);
  const msg = await request({ cmd: "warm", model: whisperModel }, 300000);
  if (!msg.ok) {
    return { ok: false, error: msg.error || "Whisper warm failed", model: whisperModel };
  }
  return {
    ok: true,
    model: msg.model || whisperModel,
    device: msg.device,
    computeType: msg.computeType,
  };
}

async function transcribeAudio(
  audioPath,
  {
    model = DEFAULT_MODEL,
    language = "en",
    initialPrompt = "",
    beamSize = DEFAULT_BEAM,
    vadFilter = true,
  } = {}
) {
  const whisperModel = normalizeWhisperModel(model);
  const beam = normalizeBeamSize(beamSize);
  const msg = await request(
    {
      cmd: "transcribe",
      audio: audioPath,
      model: whisperModel,
      language: language || "en",
      initial_prompt: initialPrompt || "",
      beam_size: beam,
      vad_filter: vadFilter !== false,
    },
    900000
  );
  if (!msg.ok) {
    return {
      ok: false,
      error: msg.error || "Transcription failed",
      model: whisperModel,
    };
  }
  const text = String(msg.text || "").trim();
  const segments = Array.isArray(msg.segments) ? msg.segments : [];
  if (!text) {
    return { ok: false, error: "Empty transcript", model: whisperModel };
  }
  return {
    ok: true,
    text,
    segments,
    model: msg.model || whisperModel,
    device: msg.device,
    computeType: msg.computeType,
    beamSize: msg.beamSize || beam,
  };
}

module.exports = {
  checkWhisper,
  warmWhisper,
  transcribeAudio,
  stop,
  normalizeWhisperModel,
  normalizeBeamSize,
  WHISPER_MODELS,
  WHISPER_MODEL_LIST,
  DEFAULT_MODEL,
  DEFAULT_BEAM,
};
