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
let preferredModel = "campplus";
let liveEmbeddingBuf = [];
const LIVE_AVG_N = 3;
const CLUSTER_SIM = 0.52;
const ONNX_BACKENDS = new Set(["campplus", "eres2net"]);

function init(dir) {
  cacheDir = dir || "";
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function normalizeModelId(value) {
  const key = String(value || "campplus").trim().toLowerCase();
  return ONNX_BACKENDS.has(key) ? key : "campplus";
}

function setPreferredModel(value) {
  preferredModel = normalizeModelId(value);
  return preferredModel;
}

function thresholds(backend) {
  if (backend === "campplus" || backend === "eres2net") {
    const key =
      backend === "eres2net" ? "eres2netEnrolled" : "campplusEnrolled";
    const enrolledOverride =
      tuning && typeof tuning[key] === "number"
        ? clampNumber(tuning[key], 0.2, 0.42)
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
    ONNX_BACKENDS.has(backend) && ranked.length <= 1
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
  liveEmbeddingBuf = [];
  return { ok: true };
}

async function check() {
  try {
    const msg = await request(
      { cmd: "status", model: preferredModel },
      8000
    );
    if (msg.ok && msg.backend) {
      return {
        ok: true,
        backend: msg.backend,
        models: Array.isArray(msg.models) ? msg.models : ["campplus", "eres2net"],
      };
    }
    return {
      ok: false,
      error:
        msg.error ||
        "Voice ID needs onnxruntime + kaldi-native-fbank. Run: pip install onnxruntime kaldi-native-fbank",
      models: Array.isArray(msg.models) ? msg.models : ["campplus", "eres2net"],
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message || "Python not found. Install Python 3.10+ and add it to PATH.",
    };
  }
}

async function setModel(modelId) {
  preferredModel = normalizeModelId(modelId);
  const msg = await request(
    { cmd: "set_model", model: preferredModel },
    120000
  );
  if (!msg.ok) {
    return {
      ok: false,
      error: msg.error || "Could not load speaker model",
      backend: preferredModel,
    };
  }
  return { ok: true, backend: msg.backend || preferredModel, model: preferredModel };
}

async function embedPcm(pcmBytes, sampleRate = 16000, enroll = false) {
  const pcm_b64 = Buffer.from(pcmBytes).toString("base64");
  const msg = await request(
    {
      cmd: "embed",
      pcm_b64,
      sample_rate: sampleRate || 16000,
      enroll: Boolean(enroll),
      model: preferredModel,
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

async function hitsForEmbedding(embedding, backend, channel) {
  const local = await qdrant.scoreByCosine(embedding, {
    backend,
    channel,
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

async function matchVoice(
  embedding,
  backend,
  clusterUnknowns = true,
  unknowns = sessionUnknowns,
  channel = ""
) {
  const searched = await hitsForEmbedding(embedding, backend, channel);
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

function averageEmbeddings(list) {
  const vecs = (list || []).filter((v) => Array.isArray(v) && v.length > 0);
  if (vecs.length === 0) return null;
  if (vecs.length === 1) return vecs[0].slice();
  const dim = vecs[0].length;
  const out = new Array(dim).fill(0);
  for (const vec of vecs) {
    for (let i = 0; i < dim; i++) out[i] += vec[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= vecs.length;
  const norm = Math.sqrt(out.reduce((sum, v) => sum + v * v, 0)) || 1;
  return out.map((v) => v / norm);
}

async function identifyPcm(
  pcmBytes,
  sampleRate = 16000,
  clusterUnknowns = true,
  channel = "mic"
) {
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
  for (const embedding of embeddings) {
    liveEmbeddingBuf.push(embedding);
  }
  if (liveEmbeddingBuf.length > LIVE_AVG_N * 3) {
    liveEmbeddingBuf = liveEmbeddingBuf.slice(-LIVE_AVG_N * 2);
  }
  const averaged = averageEmbeddings(liveEmbeddingBuf.slice(-LIVE_AVG_N));
  const matched = await matchVoice(
    averaged || embeddings[0],
    embedded.backend,
    clusterUnknowns,
    sessionUnknowns,
    channel
  );
  if (!matched.ok) return matched;
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
      averaged: LIVE_AVG_N,
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

function clusterWindows(windows, threshold = CLUSTER_SIM) {
  const clusters = [];
  for (const win of windows || []) {
    if (!Array.isArray(win?.embedding) || win.embedding.length === 0) continue;
    let best = null;
    let bestScore = -1;
    for (const cluster of clusters) {
      const score = cosine(win.embedding, cluster.centroid);
      if (score > bestScore) {
        bestScore = score;
        best = cluster;
      }
    }
    if (best && bestScore >= threshold) {
      best.members.push(win);
      best.centroid = averageEmbeddings(
        best.members.map((m) => m.embedding)
      );
    } else {
      clusters.push({
        members: [win],
        centroid: win.embedding.slice(),
        label: null,
      });
    }
  }
  return clusters;
}

function labelFromClusters(segment, clusters) {
  const start = Number(segment?.start) || 0;
  const end = Number(segment?.end) || start;
  let best = null;
  let bestOverlap = 0;
  for (const cluster of clusters || []) {
    if (!cluster.label) continue;
    let overlap = 0;
    for (const win of cluster.members) {
      overlap += Math.max(
        0,
        Math.min(end, Number(win.end) || 0) -
          Math.max(start, Number(win.start) || 0)
      );
    }
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = cluster.label;
    }
  }
  const dur = Math.max(0.01, end - start);
  return bestOverlap / dur >= 0.25 ? best : null;
}

async function labelSegments(audioPath, segments, liveTurns = [], onProgress) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return { ok: false, error: "No segments" };
  }
  const labels = segments.map((seg) => labelFromLiveTurns(seg, liveTurns));
  const needsEmbed = labels.some((label) => !label);
  if (!needsEmbed) {
    return {
      ok: true,
      transcript: formatLabeledTranscript(segments, labels),
      backend: preferredModel,
    };
  }

  onProgress?.("Clustering speakers…");
  const msg = await request(
    {
      cmd: "embed_meeting",
      audio: audioPath,
      model: preferredModel,
    },
    300000
  );
  let backend = msg.backend || preferredModel;
  const windows = Array.isArray(msg.windows) ? msg.windows : [];

  if (!msg.ok || windows.length === 0) {
    // Fallback: per-segment embedding (legacy path)
    const segMsg = await request(
      { cmd: "embed_segments", audio: audioPath, segments, model: preferredModel },
      180000
    );
    if (!segMsg.ok || !Array.isArray(segMsg.embeddings)) {
      if (labels.some(Boolean)) {
        return {
          ok: true,
          transcript: formatLabeledTranscript(segments, labels),
          backend: "",
        };
      }
      return { ok: false, error: segMsg.error || msg.error || "Speaker labeling failed" };
    }
    backend = segMsg.backend || backend;
    const unknowns = [];
    let prev = null;
    for (let i = 0; i < segments.length; i++) {
      if (labels[i]) {
        prev = labels[i];
        continue;
      }
      const embedding = segMsg.embeddings[i];
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

  const clusters = clusterWindows(windows);
  onProgress?.("Naming speakers…");
  const unknowns = [];
  let anon = 0;
  for (const cluster of clusters) {
    const matched = await matchVoice(
      cluster.centroid,
      backend,
      false,
      unknowns
    );
    if (matched.ok && matched.kind === "enrolled" && matched.label) {
      cluster.label = matched.label;
    } else {
      anon += 1;
      cluster.label = `Speaker ${anon}`;
    }
  }

  let prev = null;
  for (let i = 0; i < segments.length; i++) {
    if (labels[i]) {
      prev = labels[i];
      continue;
    }
    const fromCluster = labelFromClusters(segments[i], clusters);
    labels[i] = fromCluster || prev;
    if (labels[i]) prev = labels[i];
  }

  return {
    ok: true,
    transcript: formatLabeledTranscript(segments, labels),
    backend,
    clusters: clusters.length,
  };
}

function overlapSeconds(a0, a1, b0, b1) {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

function assignWordSpeaker(word, turns) {
  const start = Number(word?.start) || 0;
  const end = Number(word?.end) || start;
  let best = null;
  let bestOverlap = 0;
  for (const turn of turns || []) {
    const span = overlapSeconds(
      start,
      end,
      Number(turn.start) || 0,
      Number(turn.end) || 0
    );
    if (span > bestOverlap) {
      bestOverlap = span;
      best = String(turn.speaker || "");
    }
  }
  return best || null;
}

function appendToken(prev, token) {
  const raw = String(token || "");
  if (!prev) return raw.trim();
  if (raw.startsWith(" ")) return `${prev}${raw}`;
  return `${prev} ${raw.trim()}`;
}

function wordsFromSegments(segments) {
  const words = [];
  for (const seg of segments || []) {
    if (Array.isArray(seg.words) && seg.words.length > 0) {
      for (const word of seg.words) words.push(word);
      continue;
    }
    const text = String(seg?.text || "").trim();
    if (!text) continue;
    words.push({
      text,
      start: Number(seg.start) || 0,
      end: Number(seg.end) || Number(seg.start) || 0,
    });
  }
  return words;
}

function utterancesFromWords(words, turns) {
  const utterances = [];
  for (const word of words) {
    const speaker = assignWordSpeaker(word, turns);
    const last = utterances[utterances.length - 1];
    if (last && last.speaker === speaker) {
      last.text = appendToken(last.text, word.text);
      last.end = Number(word.end) || last.end;
    } else {
      utterances.push({
        speaker,
        text: appendToken("", word.text),
        start: Number(word.start) || 0,
        end: Number(word.end) || 0,
      });
    }
  }
  return utterances.filter((u) => u.text);
}

function mergeSpeakerTurns(turns) {
  const bySpeaker = new Map();
  for (const turn of turns || []) {
    const id = String(turn.speaker || "");
    if (!id) continue;
    const list = bySpeaker.get(id) || [];
    list.push([Number(turn.start) || 0, Number(turn.end) || 0]);
    bySpeaker.set(id, list);
  }
  return bySpeaker;
}

function subtractIntervals(parts, cuts) {
  let current = parts;
  for (const cut of cuts) {
    const next = [];
    for (const [a, b] of current) {
      if (cut[1] <= a || cut[0] >= b) {
        next.push([a, b]);
        continue;
      }
      if (cut[0] > a) next.push([a, cut[0]]);
      if (cut[1] < b) next.push([cut[1], b]);
    }
    current = next;
  }
  return current.filter(([a, b]) => b - a >= 0.3);
}

function exclusiveRegions(turns) {
  const grouped = mergeSpeakerTurns(turns);
  const speakers = [...grouped.keys()];
  const regions = [];
  for (const id of speakers) {
    const mine = grouped.get(id) || [];
    const others = [];
    for (const other of speakers) {
      if (other === id) continue;
      others.push(...(grouped.get(other) || []));
    }
    const kept = subtractIntervals(mine, others);
    regions.push({
      id,
      regions: kept.map(([start, end]) => ({ start, end })),
    });
  }
  return regions;
}

async function embedRegions(audioPath, speakersIn) {
  const msg = await request(
    {
      cmd: "embed_regions",
      audio: audioPath,
      model: preferredModel,
      speakers: speakersIn,
    },
    300000
  );
  if (!msg.ok) return msg;
  return {
    ok: true,
    backend: msg.backend || preferredModel,
    speakers: Array.isArray(msg.speakers) ? msg.speakers : [],
  };
}

async function exclusiveNameMap(centroids, backend) {
  const { enrolled, margin } = thresholds(backend);
  const scored = [];
  for (const item of centroids) {
    if (!Array.isArray(item.embedding) || !item.embedding.length) continue;
    const searched = await hitsForEmbedding(item.embedding, backend);
    if (!searched.ok) continue;
    const ranked = summarizeByName(searched.hits || []);
    for (const row of ranked) {
      scored.push({
        speaker: item.id,
        name: row.label,
        score: row.score,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const usedNames = new Set();
  const usedSpeakers = new Set();
  const named = new Map();
  for (const row of scored) {
    if (usedSpeakers.has(row.speaker) || usedNames.has(row.name)) continue;
    const runner = scored.find(
      (other) =>
        other.speaker === row.speaker &&
        other.name !== row.name &&
        !usedNames.has(other.name)
    );
    const clear =
      row.score >= enrolled &&
      (!runner || row.score - (runner.score || 0) >= margin);
    if (!clear) continue;
    named.set(row.speaker, row.name);
    usedNames.add(row.name);
    usedSpeakers.add(row.speaker);
  }
  return named;
}

async function labelFromDiarization(audioPath, segments, turns) {
  const words = wordsFromSegments(segments);
  const utterances = utterancesFromWords(words, turns);
  if (utterances.length === 0) {
    return { ok: false, error: "No words to align" };
  }
  const regions = exclusiveRegions(turns);
  const embedded = await embedRegions(audioPath, regions);
  const nameBySpeaker = new Map();
  if (embedded.ok) {
    const named = await exclusiveNameMap(
      embedded.speakers || [],
      embedded.backend || preferredModel
    );
    for (const [id, label] of named) nameBySpeaker.set(id, label);
  }
  const order = [];
  for (const turn of turns || []) {
    const id = String(turn.speaker || "");
    if (id && !order.includes(id)) order.push(id);
  }
  let anon = 0;
  const fallback = new Map();
  for (const id of order) {
    if (nameBySpeaker.has(id)) continue;
    anon += 1;
    fallback.set(id, `Speaker ${anon}`);
  }
  const lines = [];
  for (const utt of utterances) {
    const label =
      nameBySpeaker.get(utt.speaker) ||
      fallback.get(utt.speaker) ||
      "Speaker 1";
    const last = lines[lines.length - 1];
    if (last && last.label === label) last.text += ` ${utt.text.trim()}`;
    else lines.push({ label, text: utt.text.trim() });
  }
  return {
    ok: true,
    transcript: lines.map((line) => `[${line.label}] ${line.text}`).join("\n"),
    speakers: order.length,
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
  setPreferredModel,
  setModel,
  resetSession,
  embedPcm,
  identifyPcm,
  matchVoice,
  labelSegments,
  labelFromDiarization,
  selfTest,
};
