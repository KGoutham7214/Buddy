const { spawn } = require("child_process");
const path = require("path");
const qdrant = require("./qdrant.cjs");
const { cosine } = require("./cosine.cjs");

function pythonEnv() {
  return {
    ...process.env,
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
  };
}

let cacheDir = "";
let proc = null;
let stdoutBuf = "";
let nextId = 1;
const pending = new Map();
let sessionUnknowns = [];
let requestChain = Promise.resolve();
let tuning = {};

function init(dir) {
  cacheDir = dir || "";
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function thresholds(backend) {
  if (backend === "campplus") {
    const enrolledOverride =
      tuning && typeof tuning.campplusEnrolled === "number"
        ? clampNumber(tuning.campplusEnrolled, 0.2, 0.42)
        : null;
    return {
      enrolled: enrolledOverride ?? 0.34,
      unknown: 0.5,
      margin: 0.04,
    };
  }
  if (backend === "resemblyzer") {
    return { enrolled: 0.72, unknown: 0.7, margin: 0.04 };
  }
  if (backend === "basic") {
    return { enrolled: 0.88, unknown: 0.9, margin: 0.03 };
  }
  return { enrolled: 0.35, unknown: 0.4, margin: 0.05 };
}

function summarizeByName(hits) {
  const grouped = new Map();
  for (const hit of hits || []) {
    const label = String(hit?.payload?.name || "").trim();
    if (!label) continue;
    const key = label.toLowerCase();
    const score = Number(hit.score) || 0;
    const kind = String(hit?.payload?.kind || "");
    const prev = grouped.get(key) || {
      key,
      label,
      centroid: -1,
      clipMax: -1,
      sum: 0,
      count: 0,
    };
    if (kind === "centroid") {
      prev.centroid = Math.max(prev.centroid, score);
    } else {
      prev.clipMax = Math.max(prev.clipMax, score);
    }
    prev.sum += score;
    prev.count += 1;
    grouped.set(key, prev);
  }
  return [...grouped.values()]
    .map((g) => {
      // Prefer the averaged voice print so phrase/content does not dominate.
      const score =
        g.centroid >= 0
          ? g.centroid * 0.85 + Math.max(0, g.clipMax) * 0.15
          : g.clipMax;
      return {
        key: g.key,
        label: g.label,
        max: Math.max(g.centroid, g.clipMax),
        avg: g.count > 0 ? g.sum / g.count : score,
        count: g.count,
        score,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function matchFromSearch(embedding, hits, unknowns, backend, clusterUnknowns) {
  const { enrolled, unknown, margin } = thresholds(backend);
  const ranked = summarizeByName(hits);
  const best = ranked[0] || null;
  const second = ranked[1] || null;
  const otherScore = second ? second.score : -1;
  // One enrolled voice: keep floor soft — live windows rarely hit a tight print.
  const adaptiveFloor =
    backend === "campplus" && ranked.length <= 1
      ? Math.min(enrolled, 0.34)
      : enrolled;
  const clear =
    best &&
    best.label &&
    best.score >= adaptiveFloor &&
    (otherScore < 0 || best.score - otherScore >= margin);
  if (clear) {
    return {
      label: best.label,
      kind: "enrolled",
      confidence: best.score,
      diagnostics: {
        topLabel: best.label,
        topScore: best.score,
        secondScore: otherScore,
        floor: adaptiveFloor,
        margin,
      },
      unknowns,
    };
  }

  const singleSpeakerNearMatch =
    best &&
    best.label &&
    ranked.length === 1 &&
    best.score >= Math.max(0.28, adaptiveFloor - 0.04);
  if (singleSpeakerNearMatch) {
    return {
      label: best.label,
      kind: "enrolled",
      confidence: best.score,
      diagnostics: {
        topLabel: best.label,
        topScore: best.score,
        secondScore: otherScore,
        floor: adaptiveFloor,
        margin,
        relaxedSingle: true,
      },
      unknowns,
    };
  }

  if (!clusterUnknowns) {
    return {
      label: null,
      kind: "unknown",
      confidence: best && best.score > 0 ? best.score : 0,
      diagnostics: {
        topLabel: best ? best.label : null,
        topScore: best ? best.score : -1,
        secondScore: otherScore,
        floor: adaptiveFloor,
        margin,
      },
      unknowns,
    };
  }

  let bestU = { score: -1, cluster: null };
  for (const cluster of unknowns) {
    if (!cluster.embedding || cluster.embedding.length !== embedding.length) {
      continue;
    }
    const score = cosine(embedding, cluster.embedding);
    if (score > bestU.score) bestU = { score, cluster };
  }
  if (bestU.cluster && bestU.score >= unknown) {
    bestU.cluster.embedding = bestU.cluster.embedding.map(
      (v, i) => v * 0.7 + embedding[i] * 0.3
    );
    return {
      label: bestU.cluster.label,
      kind: "unknown",
      confidence: bestU.score,
      diagnostics: {
        topLabel: best ? best.label : null,
        topScore: best ? best.score : -1,
        secondScore: otherScore,
        floor: adaptiveFloor,
        margin,
      },
      unknowns,
    };
  }

  const label = `Speaker ${unknowns.length + 1}`;
  unknowns.push({ label, embedding: embedding.slice() });
  return {
    label,
    kind: "unknown",
    confidence: 0,
    diagnostics: {
      topLabel: best ? best.label : null,
      topScore: best ? best.score : -1,
      secondScore: otherScore,
      floor: adaptiveFloor,
      margin,
    },
    unknowns,
  };
}

function setTuning(nextTuning) {
  tuning = nextTuning && typeof nextTuning === "object" ? { ...nextTuning } : {};
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
  child.on("error", () => failAll("Failed to start Python speaker process"));
  child.on("exit", () => failAll("Speaker process exited"));
}

function ensureProcess() {
  if (proc && !proc.killed) return proc;
  const script = path.join(__dirname, "..", "scripts", "speaker_id.py");
  const args = ["-u", script];
  if (cacheDir) args.push("--cache-dir", cacheDir);
  const child = spawn("python", args, {
    windowsHide: true,
    env: pythonEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  attachProcess(child);
  child.stderr.on("data", () => {
    // Drain stderr so ONNX/numpy logs cannot fill the pipe and deadlock Python.
  });
  return child;
}

function request(payload, timeoutMs) {
  const run = () =>
    new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ ok: false, error: "Speaker timed out" });
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
        resolve({ ok: false, error: err.message || "Speaker write failed" });
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
  sessionUnknowns = [];
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

function resetSession() {
  sessionUnknowns = [];
  return { ok: true };
}

async function check() {
  try {
    const msg = await request({ cmd: "status" }, 8000);
    if (msg.ok && msg.backend) {
      return { ok: true, backend: msg.backend };
    }
    return {
      ok: false,
      error: msg.error || "Voice ID needs CampPlus. Run: pip install onnxruntime kaldi-native-fbank",
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message || "Python not found. Install Python 3.10+ and add it to PATH.",
    };
  }
}

async function embedPcm(pcmBytes, sampleRate = 16000, enroll = false) {
  const pcm_b64 = Buffer.from(pcmBytes).toString("base64");
  const msg = await request(
    {
      cmd: "embed",
      pcm_b64,
      sample_rate: sampleRate || 16000,
      enroll: Boolean(enroll),
    },
    120000
  );
  if (enroll) {
    const embeddings = Array.isArray(msg.embeddings)
      ? msg.embeddings.filter((vec) => Array.isArray(vec) && vec.length > 0)
      : [];
    if (!msg.ok || embeddings.length < 1) {
      return {
        ok: false,
        error:
          msg.error || "Didn't hear enough speech — try again closer to the mic.",
      };
    }
    return {
      ok: true,
      embeddings,
      embedding: embeddings[embeddings.length - 1],
      backend: msg.backend,
    };
  }
  if (msg.ok && msg.speech === false) {
    return { ok: true, speech: false, embedding: null, embeddings: [], backend: msg.backend };
  }
  const embeddings = Array.isArray(msg.embeddings)
    ? msg.embeddings.filter((vec) => Array.isArray(vec) && vec.length > 0)
    : [];
  const embedding = embeddings[0] || (Array.isArray(msg.embedding) ? msg.embedding : null);
  if (!msg.ok || !embedding) {
    return { ok: false, error: msg.error || "Embed failed" };
  }
  return {
    ok: true,
    speech: true,
    embedding,
    embeddings: embeddings.length > 0 ? embeddings : [embedding],
    backend: msg.backend,
  };
}

async function hitsForEmbedding(embedding, backend) {
  const local = await qdrant.scoreByCosine(embedding, {
    backend,
    limit: 16,
  });
  if (local.ok && (local.hits || []).length > 0) return local;
  const searched = await qdrant.search(embedding, { backend, limit: 8 });
  if (!searched.ok) return searched;
  let hits = searched.hits || [];
  if (hits.length === 0 && backend) {
    const unfiltered = await qdrant.search(embedding, { limit: 8 });
    if (unfiltered.ok) hits = unfiltered.hits || [];
    return { ok: true, hits };
  }
  return searched;
}

async function matchVoice(embedding, backend, clusterUnknowns = true, unknowns = sessionUnknowns) {
  const searched = await hitsForEmbedding(embedding, backend);
  if (!searched.ok) return searched;
  return {
    ok: true,
    ...matchFromSearch(
      embedding,
      searched.hits || [],
      unknowns,
      backend,
      clusterUnknowns
    ),
  };
}

async function identifyPcm(pcmBytes, sampleRate = 16000, clusterUnknowns = true) {
  const embedded = await embedPcm(pcmBytes, sampleRate, false);
  if (!embedded.ok) return embedded;
  if (embedded.speech === false) {
    return {
      ok: true,
      speech: false,
      label: null,
      kind: "silence",
      confidence: 0,
      backend: embedded.backend,
    };
  }
  const embeddings =
    Array.isArray(embedded.embeddings) && embedded.embeddings.length > 0
      ? embedded.embeddings
      : [embedded.embedding];
  let best = null;
  for (const embedding of embeddings) {
    const matched = await matchVoice(
      embedding,
      embedded.backend,
      clusterUnknowns,
      sessionUnknowns
    );
    if (!matched.ok) return matched;
    if (
      !best ||
      (matched.kind === "enrolled" && best.kind !== "enrolled") ||
      (matched.kind === best.kind && (matched.confidence || 0) > (best.confidence || 0))
    ) {
      best = matched;
    }
    if (matched.kind === "enrolled" && (matched.confidence || 0) >= 0.55) {
      break;
    }
  }
  const matched = best || {
    label: null,
    kind: "unknown",
    confidence: 0,
    diagnostics: {},
    unknowns: sessionUnknowns,
  };
  sessionUnknowns = matched.unknowns || sessionUnknowns;
  return {
    ok: true,
    speech: true,
    label: matched.label,
    kind: matched.kind,
    confidence: matched.confidence,
    diagnostics: {
      ...(matched.diagnostics || {}),
      windows: embeddings.length,
    },
    backend: embedded.backend,
  };
}

function formatLabeledTranscript(segments, labels) {
  const lines = [];
  let prev = null;
  for (let i = 0; i < segments.length; i++) {
    const text = String(segments[i]?.text || "").trim();
    if (!text) continue;
    const label = labels[i] || prev || "Speaker 1";
    prev = label;
    const last = lines[lines.length - 1];
    if (last && last.label === label) {
      last.text += ` ${text}`;
    } else {
      lines.push({ label, text });
    }
  }
  return lines.map((line) => `[${line.label}] ${line.text}`).join("\n");
}

function labelFromLiveTurns(segment, turns) {
  const start = Number(segment?.start) || 0;
  const end = Number(segment?.end) || start;
  let best = null;
  let bestOverlap = 0;
  for (const turn of turns || []) {
    if (
      (turn.kind !== "enrolled" && turn.kind !== "unknown") ||
      !turn.label
    ) {
      continue;
    }
    const overlap = Math.min(end, Number(turn.end) || 0) - Math.max(start, Number(turn.start) || 0);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = turn.label;
    }
  }
  const dur = Math.max(0.01, end - start);
  return bestOverlap / dur >= 0.4 ? best : null;
}

async function labelSegments(audioPath, segments, liveTurns = []) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { ok: false, error: "No segments" };
  }
  const labels = segments.map((seg) => labelFromLiveTurns(seg, liveTurns));
  const needsEmbed = labels.some((label) => !label);
  let embeddings = [];
  let backend = "";
  if (needsEmbed) {
    const msg = await request(
      { cmd: "embed_segments", audio: audioPath, segments },
      180000
    );
    if (!msg.ok || !Array.isArray(msg.embeddings)) {
      if (labels.some(Boolean)) {
        return {
          ok: true,
          transcript: formatLabeledTranscript(segments, labels),
          backend: "",
        };
      }
      return { ok: false, error: msg.error || "Speaker labeling failed" };
    }
    embeddings = msg.embeddings;
    backend = msg.backend;
  }
  const unknowns = [];
  let prev = null;
  for (let i = 0; i < segments.length; i++) {
    if (labels[i]) {
      prev = labels[i];
      continue;
    }
    const embedding = embeddings[i];
    if (!Array.isArray(embedding)) {
      labels[i] = prev;
      continue;
    }
    const matched = await matchVoice(embedding, backend, true, unknowns);
    if (matched.ok) {
      labels[i] = matched.label;
      prev = matched.label;
    } else {
      labels[i] = prev;
    }
  }
  return {
    ok: true,
    transcript: formatLabeledTranscript(segments, labels),
    backend,
  };
}

async function selfTest() {
  return request({ cmd: "self_test" }, 30000);
}

module.exports = {
  init,
  stop,
  check,
  setTuning,
  resetSession,
  embedPcm,
  identifyPcm,
  matchVoice,
  labelSegments,
  selfTest,
};
