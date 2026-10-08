const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { Readable, Transform } = require("stream");

const RUNTIME_URL =
  "https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.2.0/nemo-speech-0.2.0-windows-x86_64-cpu.zip";
const RUNTIME_SHA256 =
  "82c80451086e86194aba9af19f800da77cd66d1c28d993d0efceffd6cdb49bb8";
const GGUF_URL =
  "https://huggingface.co/nvidia/Nemotron-3-Diarization/resolve/main/Nemotron-3-Diarization.q8_0.gguf";
const GGUF_SHA256 =
  "08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1";
const GGUF_NAME = "Nemotron-3-Diarization.q8_0.gguf";

let cacheDir = "";
let activeChild = null;

function init(dir) {
  cacheDir = dir || "";
  if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });
}

function runtimeZipPath() {
  return path.join(cacheDir, "nemo-speech-0.2.0-windows-x86_64-cpu.zip");
}

function runtimeDir() {
  return path.join(cacheDir, "nemo-speech");
}

function ggufPath() {
  return path.join(cacheDir, GGUF_NAME);
}

function findExe(dir) {
  if (!fs.existsSync(dir)) return "";
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/^nemo-speech(\.exe)?$/i.test(entry.name)) return full;
    }
  }
  return "";
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function downloadTo(url, dest, expectedSha, onProgress) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "Buddy" },
  });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status}) ${url}`);
  }
  const total = Number(res.headers.get("content-length") || 0);
  let received = 0;
  const hasher = crypto.createHash("sha256");
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length;
      hasher.update(chunk);
      if (onProgress && total > 0) {
        onProgress(Math.min(0.99, received / total));
      }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp));
  const digest = hasher.digest("hex");
  if (expectedSha && digest.toLowerCase() !== expectedSha.toLowerCase()) {
    fs.unlinkSync(tmp);
    throw new Error(
      `SHA-256 mismatch for ${path.basename(dest)} (got ${digest})`
    );
  }
  fs.renameSync(tmp, dest);
  if (onProgress) onProgress(1);
  return digest;
}

function extractZip(zipPath, dest) {
  fs.mkdirSync(dest, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn("tar", ["-xf", zipPath, "-C", dest], {
      windowsHide: true,
    });
    let err = "";
    child.stderr.on("data", (d) => {
      err += d.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `tar exited ${code}`));
    });
  });
}

function check() {
  const exe = findExe(runtimeDir());
  const model = ggufPath();
  const ready = Boolean(exe) && fs.existsSync(model);
  if (!ready) {
    return {
      ok: false,
      ready: false,
      error: "Nemotron diarization is not downloaded.",
    };
  }
  return { ok: true, ready: true, exe, model };
}

async function ensureDownloaded(onProgress) {
  if (!cacheDir) {
    return { ok: false, error: "Diarization cache is not initialized" };
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  let lastReport = "";
  const report = (label, frac) => {
    const message = `${label} ${Math.round(frac * 100)}%`;
    if (message === lastReport) return;
    lastReport = message;
    if (onProgress) onProgress(message);
  };

  const zip = runtimeZipPath();
  if (!findExe(runtimeDir())) {
    if (!fs.existsSync(zip)) {
      report("Downloading diarizer", 0);
      await downloadTo(RUNTIME_URL, zip, RUNTIME_SHA256, (frac) =>
        report("Downloading diarizer", frac * 0.2)
      );
    } else {
      const digest = await sha256File(zip);
      if (digest.toLowerCase() !== RUNTIME_SHA256) {
        fs.unlinkSync(zip);
        await downloadTo(RUNTIME_URL, zip, RUNTIME_SHA256, (frac) =>
          report("Downloading diarizer", frac * 0.2)
        );
      }
    }
    report("Unpacking diarizer", 0.2);
    await extractZip(zip, runtimeDir());
  }

  const model = ggufPath();
  if (!fs.existsSync(model)) {
    report("Downloading Nemotron model", 0.25);
    await downloadTo(GGUF_URL, model, GGUF_SHA256, (frac) =>
      report("Downloading Nemotron model", 0.25 + frac * 0.75)
    );
  } else {
    const digest = await sha256File(model);
    if (digest.toLowerCase() !== GGUF_SHA256) {
      fs.unlinkSync(model);
      await downloadTo(GGUF_URL, model, GGUF_SHA256, (frac) =>
        report("Downloading Nemotron model", 0.25 + frac * 0.75)
      );
    }
  }

  const status = check();
  if (!status.ok) {
    return { ok: false, error: status.error || "Diarizer install incomplete" };
  }
  return { ok: true, exe: status.exe, model: status.model };
}

function toWav16k(inputPath, wavPath) {
  const py = [
    "from faster_whisper.audio import decode_audio",
    "import wave, numpy as np, sys",
    "src, dst = sys.argv[1], sys.argv[2]",
    "wav = decode_audio(src, sampling_rate=16000)",
    "pcm = (np.clip(wav, -1.0, 1.0) * 32767.0).astype(np.int16)",
    "f = wave.open(dst, 'wb')",
    "f.setnchannels(1); f.setsampwidth(2); f.setframerate(16000)",
    "f.writeframes(pcm.tobytes()); f.close()",
  ].join("; ");
  return new Promise((resolve, reject) => {
    const child = spawn("python", ["-c", py, inputPath, wavPath], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    let err = "";
    child.stderr.on("data", (d) => {
      err += d.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && fs.existsSync(wavPath)) resolve(wavPath);
      else reject(new Error(err.trim() || `WAV convert failed (${code})`));
    });
  });
}

function parseTurns(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  const turns = [];
  const push = (start, end, speaker) => {
    const s = Number(start);
    const e = Number(end);
    const id = String(speaker ?? "").trim();
    if (!id || !Number.isFinite(s) || !Number.isFinite(e) || e <= s) return;
    turns.push({ start: s, end: e, speaker: id });
  };

  if (text.startsWith("{") || text.startsWith("[")) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const list = Array.isArray(json)
      ? json
      : json?.segments ||
        json?.turns ||
        json?.result?.segments ||
        json?.diarization ||
        [];
    if (Array.isArray(list)) {
      for (const item of list) {
        const start = item.start ?? item.start_time ?? item.begin;
        const end =
          item.end ??
          item.end_time ??
          (item.start != null && item.duration != null
            ? Number(item.start) + Number(item.duration)
            : undefined);
        push(start, end, item.speaker ?? item.label ?? item.spk ?? item.id);
      }
    }
    if (turns.length) return turns;
  }

  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] !== "SPEAKER" || parts.length < 8) continue;
    const start = Number(parts[3]);
    const dur = Number(parts[4]);
    push(start, start + dur, parts[7]);
  }
  return turns;
}

function runCli(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, {
      windowsHide: true,
      env: {
        ...process.env,
        NEMO_SPEECH_MODEL_DIR: cacheDir,
      },
    });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      activeChild = null;
      resolve({ ok: false, error: err.message || "Failed to start nemo-speech" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      activeChild = null;
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

async function diarizeFile(audioPath) {
  const status = check();
  if (!status.ok) return status;
  const wavPath = path.join(
    cacheDir,
    `diarize-${Date.now()}.wav`
  );
  const rttmPath = `${wavPath}.rttm`;
  try {
    await toWav16k(audioPath, wavPath);
    const args = [
      "diarize",
      wavPath,
      "--model",
      status.model,
      "--device",
      "cpu",
      "--preset",
      "v3-offline",
      "--format",
      "rttm",
      "--output",
      rttmPath,
    ];
    const ran = await runCli(status.exe, args, 20 * 60 * 1000);
    let raw = "";
    if (fs.existsSync(rttmPath)) raw = fs.readFileSync(rttmPath, "utf8");
    if (!raw.trim()) raw = ran.stdout || "";
    const turns = parseTurns(raw);
    if (!ran.ok && turns.length === 0) {
      return {
        ok: false,
        error: (ran.stderr || ran.error || "Diarization failed").trim().slice(0, 500),
      };
    }
    if (turns.length === 0) {
      return { ok: false, error: "Diarizer returned no speaker turns" };
    }
    return { ok: true, turns, preset: "v3-offline" };
  } catch (err) {
    return { ok: false, error: err.message || "Diarization failed" };
  } finally {
    for (const file of [wavPath, rttmPath]) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {
        // ignore
      }
    }
  }
}

function stop() {
  if (!activeChild) return;
  try {
    activeChild.kill();
  } catch {
    // ignore
  }
  activeChild = null;
}

module.exports = {
  init,
  check,
  ensureDownloaded,
  diarizeFile,
  parseTurns,
  stop,
};
